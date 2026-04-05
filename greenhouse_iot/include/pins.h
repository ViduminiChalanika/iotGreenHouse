#pragma once

/**
 * Green House V2.0 (EasyEDA) — ESP32 DevKit wiring
 *
 * DHT22 DATA: GPIO23 (schematic S1). Do NOT use GPIO6–11 on ESP32-WROOM — they are
 *   flash pins; using GPIO11 causes erratic behavior and TG1WDT resets with DHTesp.
 * Soil U6:  A0 -> GPIO36 (VP), D0 -> GPIO21, sensor VCC 5V
 * LDR U1:   divider junction -> GPIO34
 * Relays:   GPIO19 -> TB4, GPIO5 -> TB1, GPIO4 -> TB2 (12V light)
 */

#define DHT_PIN 23

#define SOIL_ANALOG_PIN 36   // VP — ADC1
#define SOIL_DIGITAL_PIN 21  // soil module D0
#define LDR_PIN 34           // ADC1

#define FAN_PIN 5            // TB1 (middle relay, 5V terminal)
#define PUMP_PIN 19          // TB4 (bottom relay, 5V terminal)
#define LED_PIN 4            // TB2 (top relay, 12V terminal) — use with 12V supply only
