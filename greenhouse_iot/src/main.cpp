#include <Arduino.h>
#include <DHT.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <time.h>

#include "secrets.h"

#define SERIAL_INTERVAL_MS 2000UL
#define HTTP_POST_INTERVAL_MS 60000UL
#define CONTROL_POLL_MS 1000UL

#define DHT_PIN 22
#define DHT_TYPE DHT11

#define SOIL_PIN 36
// Raw ADC at max (~4095) = dry; wet probe — tune SOIL_RAW_WET to your sensor
#define SOIL_RAW_DRY 4095
#define SOIL_RAW_WET 1200

#define LDR_PIN 34
#define LDR_RAW_DARK 400
#define LDR_RAW_BRIGHT 3800

#if (RELAY_ACTIVE_LOW == 1)
#define RELAY_ON LOW
#define RELAY_OFF HIGH
#else
#define RELAY_ON HIGH
#define RELAY_OFF LOW
#endif

// Fan ON when temp >= high, OFF when <= low (hysteresis). 28°C was below old 30°C ON threshold.
#define FAN_ON_TEMP_C 27.0f
#define FAN_OFF_TEMP_C 25.0f

/** Grow lights: ON when ambient LDR % below low, OFF above high (hysteresis). */
#define LIGHT_GROW_ON_PCT 30.0f
#define LIGHT_GROW_OFF_PCT 45.0f

#define SOIL_PUMP_ON_PCT 38.0f
#define SOIL_PUMP_RECOVER_PCT 52.0f
#define PUMP_PULSE_MS 5000UL
#define PUMP_REST_MS 45000UL

DHT dht(DHT_PIN, DHT_TYPE);

float gHum = NAN;
float gTemp = NAN;
int gSoilRaw = 0;
float gSoilPct = 0.0f;
int gLdrRaw = 0;
float gLightPct = 0.0f;
bool gDhtOk = false;

bool gFanOn = false;
bool gPumpOn = false;
bool gLightOn = false;
unsigned long gFanOnStartMs = 0;
unsigned long gPumpOnStartMs = 0;
unsigned long gLightOnStartMs = 0;
uint64_t gFanActivatedAtMs = 0;
uint64_t gPumpActivatedAtMs = 0;
uint64_t gLightActivatedAtMs = 0;
unsigned long gFanTotalOnMs = 0;
unsigned long gPumpTotalOnMs = 0;
unsigned long gLightTotalOnMs = 0;

bool gAutoFan = true;
bool gAutoPump = true;
bool gAutoLight = false;  // default manual like user-driven fan/pump; enable Automate for LDR logic
bool gFanManual = false;
bool gPumpManual = false;
bool gLightManual = false;
int8_t gFanOverride = -1;
int8_t gPumpOverride = -1;
int8_t gLightOverride = -1;

enum { PUMP_IDLE = 0, PUMP_PULSE = 1, PUMP_REST = 2 };
static uint8_t gPumpPhase = PUMP_IDLE;
static unsigned long gPumpPhaseStartMs = 0;

static unsigned long lastSerialMs = 0;
static unsigned long lastHttpMs = 0;
static unsigned long lastWifiAttemptMs = 0;
static unsigned long lastAutomationTickMs = 0;
static unsigned long lastControlPollMs = 0;
static char gControlUrl[192];
static int8_t gPrevFanOverride = -99;
static int8_t gPrevPumpOverride = -99;
static int8_t gPrevLightOverride = -99;
static bool gPrevAutoFan = true;
static bool gPrevAutoPump = true;
static bool gPrevAutoLight = false;
static bool gPrevFanManualForCtrl = false;
static bool gPrevPumpManualForCtrl = false;
static bool gPrevLightManualForCtrl = false;
static bool gPrevCtrlManualInit = false;
bool ntpDone = false;

static int readAdcAverage(uint8_t pin, uint8_t samples = 32) {
  uint32_t sum = 0;
  for (uint8_t i = 0; i < samples; i++) {
    sum += analogRead(pin);
    delayMicroseconds(200);
  }
  return (int)(sum / samples);
}

static uint64_t unixMsNow() {
  time_t t = time(nullptr);
  if (t < 1700000000) return 0;
  return (uint64_t)t * 1000ULL;
}

static void syncNtp() {
  if (ntpDone) return;
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  for (int i = 0; i < 40; i++) {
    time_t now = time(nullptr);
    if (now > 1700000000) {
      ntpDone = true;
      Serial.println("NTP time synced");
      return;
    }
    delay(250);
  }
  Serial.println("NTP: using millis fallback for ts if needed");
}

static void setupControlUrl() {
  gControlUrl[0] = '\0';
  const char* s = TELEMETRY_URL;
  const char* end = strstr(s, "/api/telemetry");
  if (!end) {
    Serial.println("CONTROL: TELEMETRY_URL must contain /api/telemetry");
    return;
  }
  int n = (int)(end - s);
  snprintf(gControlUrl, sizeof(gControlUrl), "%.*s/api/control/%s", n, s, DEVICE_ID);
}

static void readSoilOnly() {
  gSoilRaw = analogRead(SOIL_PIN);
  gSoilPct = 100.0f * (float)(SOIL_RAW_DRY - gSoilRaw) / (float)(SOIL_RAW_DRY - SOIL_RAW_WET);
  if (gSoilPct < 0.0f) gSoilPct = 0.0f;
  if (gSoilPct > 100.0f) gSoilPct = 100.0f;
}

static void readLdrOnly() {
  gLdrRaw = readAdcAverage(LDR_PIN);
  gLightPct = 100.0f * (float)(gLdrRaw - LDR_RAW_DARK) / (float)(LDR_RAW_BRIGHT - LDR_RAW_DARK);
  if (gLightPct < 0.0f) gLightPct = 0.0f;
  if (gLightPct > 100.0f) gLightPct = 100.0f;
}

static void readSensorsToGlobals() {
  gHum = dht.readHumidity();
  gTemp = dht.readTemperature();
  gDhtOk = !isnan(gHum) && !isnan(gTemp);

  readSoilOnly();
  readLdrOnly();
}

static void tickOnCounters(unsigned long dt) {
  if (gFanOn) gFanTotalOnMs += dt;
  if (gPumpOn) gPumpTotalOnMs += dt;
  if (gLightOn) gLightTotalOnMs += dt;
}

static void setFanRelay(bool wantOn, unsigned long m) {
  if (wantOn) {
    if (!gFanOn) {
      gFanOn = true;
      gFanOnStartMs = m;
      gFanActivatedAtMs = unixMsNow();
    }
    digitalWrite(FAN_PIN, RELAY_ON);
  } else {
    if (gFanOn) gFanOn = false;
    digitalWrite(FAN_PIN, RELAY_OFF);
  }
}

/* Pump relay only: HIGH = ON, LOW = OFF (same as your pins.h output test). Fan still uses RELAY_ON/OFF. */
static void setPumpRelay(bool wantOn, unsigned long m) {
  const bool wasOn = gPumpOn;
  if (wantOn) {
    if (!gPumpOn) {
      gPumpOn = true;
      gPumpOnStartMs = m;
      gPumpActivatedAtMs = unixMsNow();
    }
    digitalWrite(PUMP_PIN, HIGH);
  } else {
    if (gPumpOn) gPumpOn = false;
    digitalWrite(PUMP_PIN, LOW);
  }
  if (wasOn != gPumpOn) {
    Serial.printf(
        "Pump relay edge: %s | pin GPIO %d level=%d (pump: HIGH=ON LOW=OFF)\n",
        gPumpOn ? "ON" : "OFF", (int)PUMP_PIN, (int)digitalRead(PUMP_PIN));
  }
}

/** Grow lights relay: same polarity as fan (RELAY_ON / RELAY_OFF from RELAY_ACTIVE_LOW in secrets.h). */
static void setLightRelay(bool wantOn, unsigned long m) {
  const bool wasOn = gLightOn;
  if (wantOn) {
    if (!gLightOn) {
      gLightOn = true;
      gLightOnStartMs = m;
      gLightActivatedAtMs = unixMsNow();
    }
    digitalWrite(LED_PIN, RELAY_ON);
  } else {
    if (gLightOn) gLightOn = false;
    digitalWrite(LED_PIN, RELAY_OFF);
  }
  if (wasOn != gLightOn) {
    Serial.printf(
        "Light relay edge: %s | pin GPIO %d level=%d (same as FAN_PIN polarity)\n",
        gLightOn ? "ON" : "OFF", (int)LED_PIN, (int)digitalRead(LED_PIN));
  }
}

#if PUMP_STARTUP_TEST
/** Temporary: pulse pump relay at boot so you can hear the click and see the channel LED (set PUMP_STARTUP_TEST 0 when done). */
static void runPumpStartupRelayTest() {
  const int kCycles = 3;
  const unsigned long kOnMs = 2500;
  const unsigned long kOffMs = 1500;

  Serial.println();
  Serial.println("======== PUMP RELAY STARTUP TEST ========");
  Serial.printf("GPIO %d | pump uses HIGH=ON LOW=OFF (same as pins.h test)\n", (int)PUMP_PIN);
  for (int i = 1; i <= kCycles; i++) {
    Serial.printf("--- %d/%d: ON %lu ms (listen/look for relay LED) ---\n", i, kCycles, kOnMs);
    digitalWrite(PUMP_PIN, HIGH);
    Serial.printf("    digitalRead=%d (expect %d)\n", (int)digitalRead(PUMP_PIN), (int)HIGH);
    delay(kOnMs);
    Serial.printf("--- %d/%d: OFF %lu ms ---\n", i, kCycles, kOffMs);
    digitalWrite(PUMP_PIN, LOW);
    Serial.printf("    digitalRead=%d (expect %d)\n", (int)digitalRead(PUMP_PIN), (int)LOW);
    delay(kOffMs);
  }
  Serial.println("======== TEST END — set PUMP_STARTUP_TEST to 0 in secrets.h then reflash ========");
  Serial.println("If digitalRead matched above but you heard NO click and NO channel LED:");
  Serial.println("  The ESP pin is fine — the relay module is NOT getting that signal on IN2.");
  Serial.println("  Fix wiring: pump IN must go to GPIO PUMP_PIN (see pins.h / secrets.h).");
  Serial.println("  Check relay VCC + GND. Compare with fan: if IN1 works, swap IN1/IN2 wires to test channel.");
  Serial.println();
}
#endif

static void updateFanFromTemperature(unsigned long m) {
  if (!gDhtOk) {
    setFanRelay(false, m);
    return;
  }
  if (gTemp >= FAN_ON_TEMP_C) {
    setFanRelay(true, m);
  } else if (gTemp <= FAN_OFF_TEMP_C) {
    setFanRelay(false, m);
  }
}

static void updateLightFromLdr(unsigned long m) {
  if (gLightPct < LIGHT_GROW_ON_PCT) {
    setLightRelay(true, m);
  } else if (gLightPct > LIGHT_GROW_OFF_PCT) {
    setLightRelay(false, m);
  }
}

static void updatePumpFsm(unsigned long m) {
  switch (gPumpPhase) {
    case PUMP_IDLE:
      if (gSoilPct < SOIL_PUMP_ON_PCT) {
        gPumpPhase = PUMP_PULSE;
        gPumpPhaseStartMs = m;
        setPumpRelay(true, m);
      }
      break;
    case PUMP_PULSE:
      if (m - gPumpPhaseStartMs >= PUMP_PULSE_MS) {
        setPumpRelay(false, m);
        gPumpPhase = PUMP_REST;
        gPumpPhaseStartMs = m;
      }
      break;
    case PUMP_REST:
      if (m - gPumpPhaseStartMs >= PUMP_REST_MS) {
        if (gSoilPct >= SOIL_PUMP_RECOVER_PCT) {
          gPumpPhase = PUMP_IDLE;
        } else if (gSoilPct < SOIL_PUMP_ON_PCT) {
          gPumpPhase = PUMP_PULSE;
          gPumpPhaseStartMs = m;
          setPumpRelay(true, m);
        } else {
          gPumpPhase = PUMP_IDLE;
        }
      }
      break;
    default:
      gPumpPhase = PUMP_IDLE;
      break;
  }
}

static void updateAutomation() {
  unsigned long m = millis();
  if (lastAutomationTickMs == 0) lastAutomationTickMs = m;
  unsigned long dt = m - lastAutomationTickMs;
  if (dt > 30000UL) dt = 1000UL;
  lastAutomationTickMs = m;
  tickOnCounters(dt);

  readSoilOnly();
  readLdrOnly();

  if (!gAutoFan) {
    setFanRelay(gFanManual, m);
  } else if (gFanOverride >= 0) {
    setFanRelay(gFanOverride == 1, m);
  } else {
    updateFanFromTemperature(m);
  }

  if (!gAutoPump) {
    gPumpPhase = PUMP_IDLE;
    setPumpRelay(gPumpManual, m);
  } else if (gPumpOverride >= 0) {
    gPumpPhase = PUMP_IDLE;
    setPumpRelay(gPumpOverride == 1, m);
  } else {
    updatePumpFsm(m);
  }

  if (!gAutoLight) {
    setLightRelay(gLightManual, m);
  } else if (gLightOverride >= 0) {
    setLightRelay(gLightOverride == 1, m);
  } else {
    updateLightFromLdr(m);
  }
}

static void httpFetchControl() {
  if (gControlUrl[0] == '\0' || WiFi.status() != WL_CONNECTED) return;

  JsonDocument doc;
  HTTPClient http;
  http.setTimeout(15000);
  // Clients must live until getString()/end() — not inside if/else blocks (was EmptyInput len=0).
  WiFiClientSecure tlsClient;
  WiFiClient plainClient;
  int code = -1;
  if (strncmp(gControlUrl, "https://", 8) == 0) {
    tlsClient.setInsecure();
    http.begin(tlsClient, gControlUrl);
    http.addHeader("x-api-key", API_KEY);
    http.addHeader("Accept", "application/json");
    http.addHeader("Accept-Encoding", "identity");
    code = http.GET();
  } else {
    http.begin(plainClient, gControlUrl);
    http.addHeader("x-api-key", API_KEY);
    http.addHeader("Accept", "application/json");
    http.addHeader("Accept-Encoding", "identity");
    code = http.GET();
  }

  if (code != 200) {
    Serial.printf("CONTROL GET -> %d\n", code);
    http.end();
    return;
  }

  String body = http.getString();
  http.end();

  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    Serial.printf("CONTROL: JSON parse failed: %s (len=%u)\n", err.c_str(), (unsigned)body.length());
    if (body.length() > 0) {
      Serial.print("CONTROL body: ");
      const size_t cap = body.length() > 220 ? 220 : body.length();
      for (size_t i = 0; i < cap; i++) Serial.print(body.charAt((unsigned)i));
      Serial.println();
    }
    return;
  }

  // Accept bool or 0/1 from JSON (MongoDB / Express sometimes vary)
  if (!doc["autoFan"].isNull()) gAutoFan = doc["autoFan"].as<bool>();
  if (!doc["autoPump"].isNull()) gAutoPump = doc["autoPump"].as<bool>();
  if (!doc["autoLight"].isNull()) gAutoLight = doc["autoLight"].as<bool>();
  if (!doc["fanManual"].isNull()) gFanManual = doc["fanManual"].as<bool>();
  if (!doc["pumpManual"].isNull()) gPumpManual = doc["pumpManual"].as<bool>();
  if (!doc["lightManual"].isNull()) gLightManual = doc["lightManual"].as<bool>();

  if (doc["fanOverride"].isNull()) {
    gFanOverride = -1;
  } else {
    gFanOverride = doc["fanOverride"].as<bool>() ? 1 : 0;
  }

  if (doc["pumpOverride"].isNull()) {
    gPumpOverride = -1;
  } else {
    gPumpOverride = doc["pumpOverride"].as<bool>() ? 1 : 0;
  }

  if (doc["lightOverride"].isNull()) {
    gLightOverride = -1;
  } else {
    gLightOverride = doc["lightOverride"].as<bool>() ? 1 : 0;
  }

  if (!gPrevCtrlManualInit) {
    gPrevCtrlManualInit = true;
    gPrevFanManualForCtrl = gFanManual;
    gPrevPumpManualForCtrl = gPumpManual;
    gPrevLightManualForCtrl = gLightManual;
  }
  if (gPrevFanOverride != gFanOverride || gPrevPumpOverride != gPumpOverride || gPrevLightOverride != gLightOverride ||
      gPrevAutoFan != gAutoFan || gPrevAutoPump != gAutoPump || gPrevAutoLight != gAutoLight ||
      gFanManual != gPrevFanManualForCtrl || gPumpManual != gPrevPumpManualForCtrl ||
      gLightManual != gPrevLightManualForCtrl) {
    Serial.printf(
        "CTRL applied: autoFan=%d autoPump=%d autoLight=%d fanMan=%d pumpMan=%d lightMan=%d ovF=%d ovP=%d ovL=%d\n",
        gAutoFan ? 1 : 0, gAutoPump ? 1 : 0, gAutoLight ? 1 : 0, gFanManual ? 1 : 0, gPumpManual ? 1 : 0,
        gLightManual ? 1 : 0, (int)gFanOverride, (int)gPumpOverride, (int)gLightOverride);
    gPrevFanOverride = gFanOverride;
    gPrevPumpOverride = gPumpOverride;
    gPrevLightOverride = gLightOverride;
    gPrevAutoFan = gAutoFan;
    gPrevAutoPump = gAutoPump;
    gPrevAutoLight = gAutoLight;
    gPrevFanManualForCtrl = gFanManual;
    gPrevPumpManualForCtrl = gPumpManual;
    gPrevLightManualForCtrl = gLightManual;
  }
}

static void printSerialLine() {
  if (!gDhtOk) {
    Serial.println("DHT read failed (check wiring, pull-up, pin)");
  } else {
    Serial.printf("Humidity: %.1f %% | Temperature: %.1f °C\n", gHum, gTemp);
  }
  Serial.printf("Soil: raw %4d | ~moisture %.0f %%\n", gSoilRaw, gSoilPct);
  uint32_t ldrMv = (uint32_t)gLdrRaw * 3300UL / 4095UL;
  Serial.printf("Light: raw %4d (~%u mV) | ~intensity %.0f %%\n", gLdrRaw, (unsigned)ldrMv,
                gLightPct);
  Serial.printf(
      "Fan: %s | Pump: %s | Light: %s | phase %u (0=id 1=pulse 2=rest) | autoF=%d autoP=%d autoL=%d ovF=%d ovP=%d ovL=%d",
      gFanOn ? "ON" : "OFF", gPumpOn ? "ON" : "OFF", gLightOn ? "ON" : "OFF", (unsigned)gPumpPhase, gAutoFan ? 1 : 0,
      gAutoPump ? 1 : 0, gAutoLight ? 1 : 0, (int)gFanOverride, (int)gPumpOverride, (int)gLightOverride);
  {
    const int plvl = (int)digitalRead(PUMP_PIN);
    Serial.printf(" | pumpGPIO %d lvl=%d (HIGH=ON LOW=OFF)", (int)PUMP_PIN, plvl);
    if (gPumpOn && plvl != HIGH) {
      Serial.print(" [ERR: gPumpOn but pin not HIGH]");
    }
    if (!gAutoPump) {
      Serial.printf(" wantMan=%d", gPumpManual ? 1 : 0);
    }
    Serial.printf(" | lightGPIO %d lvl=%d", (int)LED_PIN, (int)digitalRead(LED_PIN));
    if (gLightOn && (int)digitalRead(LED_PIN) != (int)RELAY_ON) {
      Serial.print(" [ERR: gLightOn but pin not RELAY_ON]");
    }
    if (!gAutoLight) {
      Serial.printf(" wantMan=%d", gLightManual ? 1 : 0);
    }
  }
  if (gPumpPhase == PUMP_REST) {
    unsigned long elapsed = millis() - gPumpPhaseStartMs;
    unsigned long left = elapsed < PUMP_REST_MS ? (PUMP_REST_MS - elapsed) / 1000UL : 0;
    Serial.printf(" | pump next pulse in ~%lus", left);
  }
  Serial.println();
}

static bool httpPostTelemetry() {
  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  if (gDhtOk) {
    doc["t"] = gTemp;
    doc["h"] = gHum;
  }
  doc["soilRaw"] = gSoilRaw;
  doc["soilPct"] = gSoilPct;
  doc["ldrRaw"] = gLdrRaw;
  doc["ldrPct"] = gLightPct;

  doc["fanOn"] = gFanOn;
  doc["pumpOn"] = gPumpOn;
  doc["lightOn"] = gLightOn;
  doc["pumpPhase"] = gPumpPhase;  // 0=idle 1=pulse 2=rest — lets dashboard show auto cycles (pumpOn alone is often stale)
  doc["autoFan"] = gAutoFan;
  doc["autoPump"] = gAutoPump;
  doc["autoLight"] = gAutoLight;
  doc["fanManual"] = gFanManual;
  doc["pumpManual"] = gPumpManual;
  doc["lightManual"] = gLightManual;
  doc["fanActivatedAt"] = gFanActivatedAtMs;
  doc["pumpActivatedAt"] = gPumpActivatedAtMs;
  doc["lightActivatedAt"] = gLightActivatedAtMs;
  doc["fanCurrentOnSec"] =
      gFanOn ? (double)(millis() - gFanOnStartMs) / 1000.0 : 0.0;
  doc["pumpCurrentOnSec"] =
      gPumpOn ? (double)(millis() - gPumpOnStartMs) / 1000.0 : 0.0;
  doc["lightCurrentOnSec"] =
      gLightOn ? (double)(millis() - gLightOnStartMs) / 1000.0 : 0.0;
  doc["fanTotalOnSec"] = (double)gFanTotalOnMs / 1000.0;
  doc["pumpTotalOnSec"] = (double)gPumpTotalOnMs / 1000.0;
  doc["lightTotalOnSec"] = (double)gLightTotalOnMs / 1000.0;

  time_t now = time(nullptr);
  if (now > 1700000000) {
    doc["ts"] = (uint64_t)now * 1000ULL;
  } else {
    doc["ts"] = millis();
  }

  char buf[1536];
  if (serializeJson(doc, buf, sizeof(buf)) == 0) {
    Serial.println("HTTP: JSON serialize failed");
    return false;
  }

  HTTPClient http;
  http.setTimeout(20000);
  WiFiClientSecure tlsClient;
  WiFiClient plainClient;
  int code = -1;
  if (strncmp(TELEMETRY_URL, "https://", 8) == 0) {
    tlsClient.setInsecure();
    http.begin(tlsClient, TELEMETRY_URL);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-api-key", API_KEY);
    code = http.POST(buf);
  } else {
    http.begin(plainClient, TELEMETRY_URL);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-api-key", API_KEY);
    code = http.POST(buf);
  }

  if (code > 0) {
    Serial.printf("HTTP POST -> %d\n", code);
    if (code >= 200 && code < 300) {
      Serial.println("Cloud: saved OK (next POST in 60 s)");
    }
    if (code == 401) Serial.println("Check API_KEY matches rest_api .env");
  } else {
    Serial.printf("HTTP POST failed: %s\n", http.errorToString(code).c_str());
  }
  http.end();
  if (code >= 200 && code < 300) {
    httpFetchControl();
  }
  return code >= 200 && code < 300;
}

void setup() {
  pinMode(FAN_PIN, OUTPUT);
  pinMode(PUMP_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(FAN_PIN, RELAY_OFF);
  digitalWrite(PUMP_PIN, LOW);
  digitalWrite(LED_PIN, RELAY_OFF);

  Serial.begin(115200);
  delay(800);
  Serial.println();
  Serial.println("Greenhouse IoT — automation + HTTP → MongoDB");
  Serial.printf(
      "Fan: ON>=%.1f C OFF<=%.1f C | Pump: pulse %lu ms rest %lu ms | Lights: ON<=%.0f%% OFF>=%.0f%% LDR\n",
      FAN_ON_TEMP_C, FAN_OFF_TEMP_C, (unsigned long)PUMP_PULSE_MS, (unsigned long)PUMP_REST_MS,
      LIGHT_GROW_ON_PCT, LIGHT_GROW_OFF_PCT);

  setupControlUrl();
  if (gControlUrl[0]) Serial.printf("Control poll: %s\n", gControlUrl);
  Serial.printf(
      "Relay polarity: %s — if Serial shows ON but relay never clicks, set RELAY_ACTIVE_LOW to %d in "
      "secrets.h and reflash\n",
      (RELAY_ACTIVE_LOW == 1) ? "active-LOW (ON = GPIO LOW)" : "active-HIGH (ON = GPIO HIGH)",
      (RELAY_ACTIVE_LOW == 1) ? 0 : 1);

#if PUMP_STARTUP_TEST
  runPumpStartupRelayTest();
#endif

  analogSetAttenuation(ADC_11db);
  analogSetPinAttenuation(SOIL_PIN, ADC_11db);
  analogSetPinAttenuation(LDR_PIN, ADC_11db);
  dht.begin();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 25000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi OK ");
    Serial.println(WiFi.localIP());
    syncNtp();
    httpFetchControl();
    lastControlPollMs = millis();
  } else {
    Serial.println("WiFi failed — will retry in loop");
  }
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWifiAttemptMs >= 10000) {
      lastWifiAttemptMs = millis();
      Serial.println("WiFi reconnecting...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  } else {
    if (!ntpDone) syncNtp();
  }

  unsigned long now = millis();

  if (WiFi.status() == WL_CONNECTED && gControlUrl[0] != '\0' &&
      (now - lastControlPollMs >= CONTROL_POLL_MS)) {
    lastControlPollMs = now;
    httpFetchControl();
  }

  // Apply relays after control fetch, before Serial/telemetry so GPIO and gPumpOn match.
  updateAutomation();

  if (now - lastSerialMs >= SERIAL_INTERVAL_MS) {
    lastSerialMs = now;
    readSensorsToGlobals();
    printSerialLine();
  }

  // Push telemetry when fan/pump state changes (auto fan temp, overrides, manual — not only 60s timer).
  static bool actuatorTelPrimed = false;
  static bool lastFanOnTel = false;
  static bool lastPumpOnTel = false;
  static bool lastPumpManTel = false;
  static bool lastLightOnTel = false;
  static bool lastLightManTel = false;
  if (!actuatorTelPrimed) {
    actuatorTelPrimed = true;
    lastFanOnTel = gFanOn;
    lastPumpOnTel = gPumpOn;
    lastPumpManTel = gPumpManual;
    lastLightOnTel = gLightOn;
    lastLightManTel = gLightManual;
  } else if (gFanOn != lastFanOnTel || gPumpOn != lastPumpOnTel || gPumpManual != lastPumpManTel ||
             gLightOn != lastLightOnTel || gLightManual != lastLightManTel) {
    lastFanOnTel = gFanOn;
    lastPumpOnTel = gPumpOn;
    lastPumpManTel = gPumpManual;
    lastLightOnTel = gLightOn;
    lastLightManTel = gLightManual;
    if (WiFi.status() == WL_CONNECTED) {
      readSensorsToGlobals();
      if (httpPostTelemetry()) {
        lastHttpMs = now;
      }
    }
  }

  if (WiFi.status() == WL_CONNECTED && (now - lastHttpMs >= HTTP_POST_INTERVAL_MS)) {
    lastHttpMs = now;
    readSensorsToGlobals();
    httpPostTelemetry();
  }

  delay(5);
}
