import Chart from "chart.js/auto";
import { buildAlerts, updateSummaryPill } from "./alerts.js";
import { fetchReadingsJson } from "./readings-fetch.js";
import { barWidth, filterLast24h, formatTime, luxFromLdr, normTemp, timeAgo } from "./shared.js";

const API_KEY = import.meta.env.VITE_API_KEY;
const VITE_DEVICE_ID = import.meta.env.VITE_DEVICE_ID;
const CACHE_KEY = "greensense_readings_v1";

/** Match src/main.cpp FAN_ON_TEMP_C / FAN_OFF_TEMP_C for auto-mode display when telemetry lags. */
const FAN_ON_TEMP_C = 27;
const FAN_OFF_TEMP_C = 25;

/** Match src/main.cpp: PUMP_PULSE=1 PUMP_REST=2 */
const PUMP_PHASE_PULSE = 1;
const PUMP_PHASE_REST = 2;

/** @param {Record<string, unknown>|null|undefined} row */
function getPumpPhase(row) {
  if (row == null || row.pumpPhase == null) return null;
  const n = Number(row.pumpPhase);
  return Number.isNaN(n) ? null : n;
}

const layout = document.getElementById("app");
const navToggle = document.getElementById("navToggle");
const navBackdrop = document.getElementById("navBackdrop");
const apiError = document.getElementById("apiError");

let trendChart = null;
/** @type {Record<string, unknown>[]} */
let lastRows = [];
let controlSync = false;

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!Array.isArray(o.rows) || o.rows.length === 0) return null;
    return { rows: o.rows, savedAt: o.savedAt || 0 };
  } catch {
    return null;
  }
}

function saveCache(rows) {
  try {
    const trimmed = rows.slice(0, 500);
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ rows: trimmed, savedAt: Date.now() })
    );
  } catch (e) {
    console.warn("greensense cache save failed", e);
  }
}

/** @param {"live"|"cached"|"hidden"} mode */
function setDataSourceBanner(mode, savedAtMs) {
  const el = document.getElementById("dataSourceNote");
  if (!el) return;
  if (mode === "hidden") {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (mode === "live") {
    el.className = "data-source data-source--live";
    el.textContent =
      "Live data from MongoDB via API. Historical points remain available when the ESP32 is offline — newest row is the latest stored sample.";
  } else {
    el.className = "data-source data-source--cache";
    const when = savedAtMs ? new Date(savedAtMs).toLocaleString() : "unknown";
    el.textContent = `API unavailable — showing last browser cache (${when}). Start rest_api and refresh, or fix network.`;
  }
}

function setSidebarFooter(mode) {
  const el = document.getElementById("sidebarSensorLine");
  if (!el) return;
  el.textContent =
    mode === "live"
      ? "3 sensors online · Zone A"
      : "Last known data · device or API may be offline";
}

/** @param {unknown} sec */
function formatDurationSec(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return "—";
  const n = Number(sec);
  if (n < 0) return "—";
  // Avoid showing "0s" for the first sub-second of a run (telemetry uses float seconds).
  if (n > 0 && n < 1) return "<1s";
  const s = Math.floor(n);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

/** @param {unknown} ms */
function formatDateTimeMs(ms) {
  if (ms == null || ms === "" || Number(ms) === 0) return "—";
  const n = Number(ms);
  const d = new Date(n > 1e12 ? n : n * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/** @param {Record<string, unknown>[]|null|undefined} rows */
function resolveDeviceId(rows) {
  return VITE_DEVICE_ID || rows?.[0]?.deviceId || null;
}

/** @param {string} deviceId */
async function fetchControl(deviceId) {
  try {
    const res = await fetch(`/api/control/${encodeURIComponent(deviceId)}`, {
      headers: { "x-api-key": API_KEY },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn("fetchControl failed", e);
    return null;
  }
}

/** @param {string} deviceId @param {Record<string, unknown>} patch */
async function putControl(deviceId, patch) {
  const res = await fetch(`/api/control/${encodeURIComponent(deviceId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t.slice(0, 200));
  }
  return res.json();
}

/** Explicit on/off — works with auto (sets override) or manual mode. */
/** @param {string} deviceId @param {{ fan?: boolean, pump?: boolean, light?: boolean }} cmd */
async function postCommand(deviceId, cmd) {
  const res = await fetch(`/api/control/${encodeURIComponent(deviceId)}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t.slice(0, 200));
  }
  return res.json();
}

/** @param {Record<string, unknown>|null|undefined} control @param {Record<string, unknown>|null|undefined} latest */
function updateControlCheckboxes(control, latest) {
  const chkF = document.getElementById("chkAutoFan");
  const chkP = document.getElementById("chkAutoPump");
  const chkL = document.getElementById("chkAutoLight");
  if (!chkF || !chkP || !chkL) return;

  const autoFan = control?.autoFan ?? latest?.autoFan;
  const autoPump = control?.autoPump ?? latest?.autoPump;
  const autoLight = control?.autoLight ?? latest?.autoLight;

  controlSync = true;
  if (typeof autoFan === "boolean") chkF.checked = autoFan;
  if (typeof autoPump === "boolean") chkP.checked = autoPump;
  if (typeof autoLight === "boolean") chkL.checked = autoLight;
  controlSync = false;
}

function renderAlerts(alerts) {
  const list = document.getElementById("alertsList");
  const badge = document.getElementById("navAlertBadge");
  const crit = alerts.filter((a) => a.type === "crit").length;
  const warn = alerts.filter((a) => a.type === "warn").length;
  badge.textContent = String(crit + warn);
  badge.style.display = crit + warn > 0 ? "inline-flex" : "none";

  updateSummaryPill(alerts);

  if (alerts.length === 0) {
    list.innerHTML = `<div class="alert alert--info"><span class="alert-icon">ℹ️</span><div>No alerts — waiting for sensor data.</div></div>`;
    return;
  }

  list.innerHTML = alerts
    .map((a) => {
      const cls =
        a.type === "crit" ? "alert--crit" : a.type === "warn" ? "alert--warn" : a.type === "ok" ? "alert--ok" : "alert--info";
      const icon = a.type === "crit" ? "⛔" : a.type === "warn" ? "⚠️" : a.type === "ok" ? "✓" : "ℹ️";
      return `<div class="alert ${cls}"><span class="alert-icon">${icon}</span><div>${a.text}</div></div>`;
    })
    .join("");
}

/** Mongo/JSON sometimes yields 0/1; keep actuator ON/OFF unambiguous. */
function coerceBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "true" || v === "1";
  return false;
}

/**
 * Telemetry rows lag the server control doc after a click. Prefer control for
 * displayed ON/OFF so the UI matches the command immediately.
 * @param {Record<string, unknown>|null|undefined} latest
 * @param {Record<string, unknown>|null|undefined} control
 */
function blendLatestWithControl(latest, control) {
  if (!latest) return null;
  const merged = { ...latest };
  if (!control) return merged;

  if ("fanOn" in merged && merged.fanOn != null && typeof merged.fanOn !== "boolean") {
    merged.fanOn = coerceBool(merged.fanOn);
  }
  if ("pumpOn" in merged && merged.pumpOn != null && typeof merged.pumpOn !== "boolean") {
    merged.pumpOn = coerceBool(merged.pumpOn);
  }
  if ("lightOn" in merged && merged.lightOn != null && typeof merged.lightOn !== "boolean") {
    merged.lightOn = coerceBool(merged.lightOn);
  }

  const autoFan = control.autoFan === true;
  const autoPump = control.autoPump === true;
  const autoLight = control.autoLight === true;

  if (!autoFan && typeof control.fanManual === "boolean") {
    merged.fanOn = control.fanManual;
  } else if (!autoFan && typeof merged.fanOn !== "boolean" && typeof control.fanManual === "boolean") {
    merged.fanOn = control.fanManual;
  } else if (
    autoFan &&
    control.fanOverride !== true &&
    control.fanOverride !== false &&
    merged.t != null &&
    !Number.isNaN(Number(merged.t))
  ) {
    merged.fanOn = inferAutoFanOnFromTemp(merged.t, merged.fanOn);
  } else if (autoFan && (control.fanOverride === true || control.fanOverride === false)) {
    merged.fanOn = control.fanOverride;
  }

  if (!autoPump && typeof control.pumpManual === "boolean") {
    merged.pumpOn = control.pumpManual;
  } else if (!autoPump && typeof merged.pumpOn !== "boolean" && typeof control.pumpManual === "boolean") {
    merged.pumpOn = control.pumpManual;
  } else if (autoPump && (control.pumpOverride === true || control.pumpOverride === false)) {
    merged.pumpOn = control.pumpOverride;
  }
  // autoPump + no override: merged.pumpOn stays on ESP telemetry (truth when POST is current).

  if (!autoLight && typeof control.lightManual === "boolean") {
    merged.lightOn = control.lightManual;
  } else if (!autoLight && typeof merged.lightOn !== "boolean" && typeof control.lightManual === "boolean") {
    merged.lightOn = control.lightManual;
  } else if (autoLight && (control.lightOverride === true || control.lightOverride === false)) {
    merged.lightOn = control.lightOverride;
  }
  // autoLight + no override: merged.lightOn stays on ESP telemetry (same pattern as pump).

  return merged;
}

/** @param {Record<string, unknown>|null|undefined} latest @param {Record<string, unknown>|null|undefined} control */
function updateActuators(latest, control) {
  const el = (id) => document.getElementById(id);
  if (!el("valFan") || !el("valPump") || !el("valLightAct")) return;

  /** Raw telemetry (for ESP-reported fault detection). */
  const raw = latest;
  const disp = blendLatestWithControl(latest, control) || latest;

  const clear = () => {
    el("valFan").textContent = "—";
    el("statusFan").innerHTML =
      '<span class="dot dot--muted"></span><span>Waiting for data</span>';
    el("fanActivated").textContent = "—";
    el("fanCurrentOn").textContent = "—";
    el("fanTotalOn").textContent = "—";
    el("valPump").textContent = "—";
    el("statusPump").innerHTML =
      '<span class="dot dot--muted"></span><span>Waiting for data</span>';
    el("pumpActivated").textContent = "—";
    el("pumpCurrentOn").textContent = "—";
    el("pumpTotalOn").textContent = "—";
    el("valLightAct").textContent = "—";
    el("statusLightAct").innerHTML =
      '<span class="dot dot--muted"></span><span>Waiting for data</span>';
    el("lightActivated").textContent = "—";
    el("lightCurrentOn").textContent = "—";
    el("lightTotalOn").textContent = "—";
  };

  if (!latest) {
    clear();
    return;
  }

  const fanKnown = typeof disp.fanOn === "boolean";
  const phase = getPumpPhase(raw);
  const pumpKnown = typeof disp.pumpOn === "boolean" || phase != null;

  const autoFan = control?.autoFan ?? latest.autoFan;
  const autoPump = control?.autoPump ?? latest.autoPump;
  const fanOv = control?.fanOverride;
  const pumpOv = control?.pumpOverride;
  const lightOv = control?.lightOverride;
  const pumpOvActive = pumpOv === true || pumpOv === false;
  const pumpAutoNoOv = autoPump === true && !pumpOvActive;
  const autoLight = control?.autoLight ?? latest.autoLight;

  if (!fanKnown) {
    el("valFan").textContent = "—";
    el("statusFan").innerHTML =
      '<span class="dot dot--muted"></span><span>Not in telemetry yet — reflash ESP32</span>';
    el("fanActivated").textContent = "—";
    el("fanCurrentOn").textContent = "—";
    el("fanTotalOn").textContent = "—";
  } else {
    const on = disp.fanOn === true;
    el("valFan").textContent = on ? "ON" : "Off";
    el("valFan").style.color = on ? "#16a34a" : "";
    let modeLine = "";
    if (autoFan === false) modeLine = " · Manual mode";
    else if (autoFan === true && (fanOv === true || fanOv === false))
      modeLine = ` · Override: ${fanOv ? "ON" : "OFF"}`;
    else if (autoFan === true) modeLine = " · Auto";

    el("statusFan").innerHTML = on
      ? `<span class="dot dot--ok"></span><span class="status-ok">Running${modeLine}</span>`
      : `<span class="dot dot--muted"></span><span>Idle${modeLine}</span>`;
    el("fanActivated").textContent = formatDateTimeMs(raw.fanActivatedAt);
    el("fanCurrentOn").textContent = formatDurationSec(raw.fanCurrentOnSec);
    el("fanTotalOn").textContent = formatDurationSec(raw.fanTotalOnSec);
  }

  if (!pumpKnown) {
    el("valPump").textContent = "—";
    el("statusPump").innerHTML =
      '<span class="dot dot--muted"></span><span>Not in telemetry yet — reflash ESP32</span>';
    el("pumpActivated").textContent = "—";
    el("pumpCurrentOn").textContent = "—";
    el("pumpTotalOn").textContent = "—";
  } else {
    const on = disp.pumpOn === true;
    const cmdM = control?.pumpManual ?? raw.pumpManual;
    const hasCmd = typeof cmdM === "boolean";
    const mismatch =
      autoPump === false &&
      typeof raw.pumpManual === "boolean" &&
      raw.pumpManual === true &&
      raw.pumpOn === false;

    if (mismatch) {
      el("valPump").textContent = "Fault";
      el("valPump").style.color = "#b45309";
      el("statusPump").innerHTML =
        '<span class="dot dot--warn"></span><span class="status-warn">Command is ON but ESP reports relay OFF — reflash firmware or check IN2 → PUMP_PIN in secrets.h</span>';
    } else {
      /** Auto + no override: last Mongo row often has pumpOn=false (OFF edge wins) even during a cycle; trust pumpPhase when present. */
      let showOn = on;
      let showRest = false;
      if (pumpAutoNoOv && phase != null) {
        if (phase === PUMP_PHASE_PULSE) showOn = true;
        else if (phase === PUMP_PHASE_REST) {
          showOn = false;
          showRest = true;
        }
      }

      if (showRest) {
        el("valPump").textContent = "Rest";
        el("valPump").style.color = "#64748b";
      } else {
        el("valPump").textContent = showOn ? "ON" : "Off";
        el("valPump").style.color = showOn ? "#2563eb" : "";
      }
      let modeLine = "";
      if (autoPump === false) {
        modeLine = hasCmd ? ` · Manual · server cmd ${cmdM ? "ON" : "off"}` : " · Manual mode";
      } else if (autoPump === true && pumpOvActive)
        modeLine = ` · Override: ${pumpOv ? "ON" : "OFF"}`;
      else if (autoPump === true) modeLine = " · Auto";

      if (showOn) {
        el("statusPump").innerHTML = `<span class="dot dot--ok"></span><span class="status-ok">Running${modeLine}</span>`;
      } else if (showRest) {
        el("statusPump").innerHTML = `<span class="dot dot--warn"></span><span class="status-warn">Resting (between pulses)${modeLine}</span>`;
      } else {
        el("statusPump").innerHTML = `<span class="dot dot--muted"></span><span>Idle${modeLine}</span>`;
      }
    }
    el("pumpActivated").textContent = formatDateTimeMs(raw.pumpActivatedAt);
    el("pumpCurrentOn").textContent = formatDurationSec(raw.pumpCurrentOnSec);
    el("pumpTotalOn").textContent = formatDurationSec(raw.pumpTotalOnSec);
  }

  const lightKnown = typeof disp.lightOn === "boolean";
  if (!lightKnown) {
    el("valLightAct").textContent = "—";
    el("statusLightAct").innerHTML =
      '<span class="dot dot--muted"></span><span>Not in telemetry yet — reflash ESP32</span>';
    el("lightActivated").textContent = "—";
    el("lightCurrentOn").textContent = "—";
    el("lightTotalOn").textContent = "—";
  } else {
    const lon = disp.lightOn === true;
    const cmdLm = control?.lightManual ?? raw.lightManual;
    const hasCmdL = typeof cmdLm === "boolean";
    el("valLightAct").textContent = lon ? "ON" : "Off";
    el("valLightAct").style.color = lon ? "#ca8a04" : "";
    let lightMode = "";
    if (autoLight === false) {
      lightMode = hasCmdL ? ` · Manual · server cmd ${cmdLm ? "ON" : "off"}` : " · Manual mode";
    } else if (autoLight === true && (lightOv === true || lightOv === false))
      lightMode = ` · Override: ${lightOv ? "ON" : "OFF"}`;
    else if (autoLight === true) lightMode = " · Auto";

    el("statusLightAct").innerHTML = lon
      ? `<span class="dot dot--ok"></span><span class="status-ok">On${lightMode}</span>`
      : `<span class="dot dot--muted"></span><span>Off${lightMode}</span>`;
    el("lightActivated").textContent = formatDateTimeMs(raw.lightActivatedAt);
    el("lightCurrentOn").textContent = formatDurationSec(raw.lightCurrentOnSec);
    el("lightTotalOn").textContent = formatDurationSec(raw.lightTotalOnSec);
  }
}

/** @param {Record<string, unknown>|null|undefined} latest @param {Record<string, unknown>|null|undefined} control */
function updateCards(latest, control) {
  const el = (id) => document.getElementById(id);

  if (!latest) {
    el("valTemp").textContent = "—";
    el("valHum").textContent = "—";
    el("valSoil").textContent = "—";
    el("valLight").textContent = "—";
    updateActuators(null, null);
    return;
  }

  const t = latest.t != null ? Number(latest.t) : null;
  const h = latest.h != null ? Number(latest.h) : null;
  const soil = latest.soilPct != null ? Number(latest.soilPct) : null;
  const lux = luxFromLdr(latest.ldrPct != null ? Number(latest.ldrPct) : null);

  el("valTemp").textContent = t != null && !Number.isNaN(t) ? `${t.toFixed(1)}°C` : "—";
  el("valHum").textContent = h != null && !Number.isNaN(h) ? `${h.toFixed(0)}%` : "—";
  el("valSoil").textContent = soil != null && !Number.isNaN(soil) ? `${soil.toFixed(0)}%` : "—";
  el("valLight").textContent = lux != null ? `${lux} lux` : "—";

  const blended = blendLatestWithControl(latest, control) ?? latest;

  const stT = el("statusTemp");
  const stH = el("statusHum");
  const stS = el("statusSoil");
  const stL = el("statusLight");

  if (t != null) {
    const fanOn = blended.fanOn === true;
    let cls = "status-ok";
    let label = "Normal range";
    let dot = "dot--ok";
    if (t < 18 || t > 30) {
      cls = "status-warn";
      label = t < 18 ? "Low" : "High";
      dot = "dot--warn";
    } else if (fanOn) {
      label = "Warm — fan cooling";
      dot = "dot--ok";
    }
    stT.innerHTML = `<span class="dot ${dot}"></span><span class="${cls}">${label}</span>`;
    el("barTemp").style.width = `${barWidth(normTemp(t))}%`;
  }

  if (h != null) {
    let cls = "status-ok";
    let label = "Comfortable";
    let dot = "dot--ok";
    if (h > 80) {
      cls = "status-warn";
      label = "High — fungal risk";
      dot = "dot--warn";
    } else if (h < 35) {
      cls = "status-warn";
      label = "Low";
      dot = "dot--warn";
    }
    stH.innerHTML = `<span class="dot ${dot}"></span><span class="${cls}">${label}</span>`;
    el("barHum").style.width = `${barWidth(h)}%`;
  }

  if (soil != null) {
    let cls = "status-ok";
    let label = "Adequate";
    let dot = "dot--ok";
    if (soil < 40) {
      cls = "status-bad";
      label = "Critical — irrigate now";
      dot = "dot--bad";
    } else if (soil < 55) {
      cls = "status-warn";
      label = "Getting dry";
      dot = "dot--warn";
    }
    stS.innerHTML = `<span class="dot ${dot}"></span><span class="${cls}">${label}</span>`;
    el("barSoil").style.width = `${barWidth(soil)}%`;
  }

  if (latest.ldrPct != null) {
    const lp = Number(latest.ldrPct);
    let cls = "status-ok";
    let label = "Optimal";
    let dot = "dot--ok";
    if (lp < 25) {
      cls = "status-warn";
      label = "Low light";
      dot = "dot--warn";
    }
    stL.innerHTML = `<span class="dot ${dot}"></span><span class="${cls}">${label}</span>`;
    el("barLight").style.width = `${barWidth(lp)}%`;
  }

  updateActuators(latest, control);
}

function buildChart(rows) {
  const canvas = document.getElementById("trendChart");
  const legend = document.getElementById("chartLegend");
  const sorted = [...rows].sort((a, b) => Number(a.ts) - Number(b.ts));
  const labels = sorted.map((r) => formatTime(r.ts));

  const dataT = sorted.map((r) => normTemp(r.t != null ? Number(r.t) : null));
  const dataH = sorted.map((r) => (r.h != null ? barWidth(Number(r.h)) : null));
  const dataS = sorted.map((r) => (r.soilPct != null ? barWidth(Number(r.soilPct)) : null));
  const dataL = sorted.map((r) => (r.ldrPct != null ? barWidth(Number(r.ldrPct)) : null));

  const colors = {
    t: "#22c55e",
    h: "#3b82f6",
    s: "#d97706",
    l: "#eab308",
  };

  legend.innerHTML = `
    <span><i style="background:${colors.t}"></i> Temperature</span>
    <span><i style="background:${colors.h}"></i> Humidity</span>
    <span><i style="background:${colors.s}"></i> Soil moisture</span>
    <span><i style="background:${colors.l}"></i> Light</span>
  `;

  if (trendChart) {
    trendChart.destroy();
    trendChart = null;
  }

  if (sorted.length === 0) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  trendChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Temperature (norm)",
          data: dataT,
          borderColor: colors.t,
          backgroundColor: "rgba(34, 197, 94, 0.08)",
          fill: true,
          tension: 0.35,
          spanGaps: true,
          pointRadius: 2,
        },
        {
          label: "Humidity %",
          data: dataH,
          borderColor: colors.h,
          tension: 0.35,
          spanGaps: true,
          pointRadius: 2,
        },
        {
          label: "Soil %",
          data: dataS,
          borderColor: colors.s,
          tension: 0.35,
          spanGaps: true,
          pointRadius: 2,
        },
        {
          label: "Light %",
          data: dataL,
          borderColor: colors.l,
          tension: 0.35,
          spanGaps: true,
          pointRadius: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items[0]?.label || "",
          },
        },
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          title: { display: true, text: "Normalised %" },
          grid: { color: "rgba(0,0,0,0.06)" },
        },
        x: {
          grid: { display: false },
          ticks: { maxRotation: 45, minRotation: 0, autoSkip: true, maxTicksLimit: 12 },
        },
      },
    },
  });
}

function syncDataSourceNoteForView() {
  const el = document.getElementById("dataSourceNote");
  if (!el) return;
  if (el.classList.contains("data-source--live") || el.classList.contains("data-source--cache")) {
    el.hidden = false;
  }
}

function refreshDataViews() {
  const fc = filterLast24h(lastRows);
  buildChart(fc.length ? fc : lastRows);
}

function wireSensorNavigation() {
  const go = (id) => {
    window.location.href = `sensor.html?sensor=${encodeURIComponent(id)}`;
  };
  document.getElementById("card-temp")?.addEventListener("click", () => go("temperature"));
  document.getElementById("card-hum")?.addEventListener("click", () => go("humidity"));
  document.getElementById("card-soil")?.addEventListener("click", () => go("soil"));
  document.getElementById("card-light")?.addEventListener("click", () => go("light"));
  ["card-temp", "card-hum", "card-soil", "card-light"].forEach((id) => {
    const c = document.getElementById(id);
    c?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        c.click();
      }
    });
  });

  document.getElementById("navAlertsLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("alerts")?.scrollIntoView({ behavior: "smooth" });
  });
}

async function fetchReadings() {
  if (!API_KEY || API_KEY === "change-this-to-match-rest_api-env") {
    apiError.hidden = false;
    apiError.textContent =
      "Set VITE_API_KEY in dashboard/.env (same as rest_api API_KEY), then restart: npm run dev";
    return null;
  }

  try {
    return await fetchReadingsJson({
      apiKey: API_KEY,
      deviceId: VITE_DEVICE_ID || undefined,
    });
  } catch (e) {
    console.warn("fetch /api/readings failed", e);
    apiError.hidden = false;
    apiError.textContent =
      e instanceof Error ? e.message : "Network error — cannot reach API. Using cache if available.";
    return null;
  }
}

/**
 * After PUT /api/control, Mongo has fanOverride cleared but GET may still race before ESP sync.
 * Merge server fields into the latest telemetry row so auto-fan ON/OFF does not flicker (same idea as pump + manual cmd).
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>} ctrl
 */
function patchLatestRowFromControl(row, ctrl) {
  if (!row || !ctrl || typeof ctrl !== "object") return;
  if (typeof ctrl.autoFan === "boolean") row.autoFan = ctrl.autoFan;
  if (typeof ctrl.autoPump === "boolean") row.autoPump = ctrl.autoPump;
  if (typeof ctrl.autoLight === "boolean") row.autoLight = ctrl.autoLight;
  if (ctrl.fanOverride === null || ctrl.fanOverride === undefined) {
    row.fanOverride = null;
  } else if (typeof ctrl.fanOverride === "boolean") {
    row.fanOverride = ctrl.fanOverride;
  }
  if (ctrl.pumpOverride === null || ctrl.pumpOverride === undefined) {
    row.pumpOverride = null;
  } else if (typeof ctrl.pumpOverride === "boolean") {
    row.pumpOverride = ctrl.pumpOverride;
  }
  if (ctrl.lightOverride === null || ctrl.lightOverride === undefined) {
    row.lightOverride = null;
  } else if (typeof ctrl.lightOverride === "boolean") {
    row.lightOverride = ctrl.lightOverride;
  }
  if (typeof ctrl.fanManual === "boolean") row.fanManual = ctrl.fanManual;
  if (typeof ctrl.pumpManual === "boolean") row.pumpManual = ctrl.pumpManual;
  if (typeof ctrl.lightManual === "boolean") row.lightManual = ctrl.lightManual;
}

/** Auto fan with no override: infer ON/OFF from last sample temp (same hysteresis idea as firmware). */
function inferAutoFanOnFromTemp(t, prevFanOn) {
  if (t == null || Number.isNaN(Number(t))) return typeof prevFanOn === "boolean" ? prevFanOn : false;
  const temp = Number(t);
  if (temp >= FAN_ON_TEMP_C) return true;
  if (temp <= FAN_OFF_TEMP_C) return false;
  return !!prevFanOn;
}

function applyRows(rows, opts) {
  const { live, cachedSavedAt, control } = opts;
  lastRows = rows;
  const latest = rows[0] || null;

  updateControlCheckboxes(control, latest);
  updateCards(latest, control);
  renderAlerts(buildAlerts(latest));
  refreshDataViews();
  syncDataSourceNoteForView();

  const pill = document.getElementById("pillUpdated");
  if (latest?.ts) {
    const base = `Sample ${timeAgo(latest.ts)} · ${formatTime(latest.ts)}`;
    pill.textContent = live ? `Live · ${base}` : `Cached view · ${base}`;
  } else {
    pill.textContent = "No samples yet";
  }

  if (cachedSavedAt && !live) {
    pill.textContent += ` · cache saved ${new Date(cachedSavedAt).toLocaleTimeString()}`;
  }

  setSidebarFooter(live ? "live" : "cache");
}

async function refresh() {
  if (!API_KEY || API_KEY === "change-this-to-match-rest_api-env") {
    const c = loadCache();
    if (c) {
      apiError.hidden = false;
      apiError.textContent =
        "Fix VITE_API_KEY — showing cached data only until configured.";
      setDataSourceBanner("cached", c.savedAt);
      applyRows(c.rows, { live: false, cachedSavedAt: c.savedAt });
    }
    return;
  }

  const rows = await fetchReadings();

  if (rows !== null && rows.length > 0) {
    saveCache(rows);
    apiError.hidden = true;
    setDataSourceBanner("live");
    const deviceId = resolveDeviceId(rows);
    const ctrl = deviceId ? await fetchControl(deviceId) : null;
    applyRows(rows, { live: true, cachedSavedAt: null, control: ctrl });
    return;
  }

  const c = loadCache();
  if (c && c.rows.length > 0) {
    if (rows !== null && rows.length === 0) {
      apiError.hidden = false;
      apiError.textContent =
        "MongoDB has no rows yet — showing last cached session.";
    } else {
      apiError.hidden = true;
    }
    setDataSourceBanner("cached", c.savedAt);
    const deviceId = resolveDeviceId(c.rows);
    const ctrl = deviceId ? await fetchControl(deviceId) : null;
    applyRows(c.rows, { live: false, cachedSavedAt: c.savedAt, control: ctrl });
    return;
  }

  if (rows !== null && rows.length === 0) {
    lastRows = [];
    updateCards(null, null);
    renderAlerts([]);
    refreshDataViews();
    document.getElementById("pillUpdated").textContent = "No samples in database";
    setDataSourceBanner("hidden");
    setSidebarFooter("cache");
    return;
  }

  lastRows = [];
  updateCards(null, null);
  renderAlerts([]);
  refreshDataViews();
  document.getElementById("pillUpdated").textContent = "—";
  setDataSourceBanner("hidden");
  setSidebarFooter("cache");
}

async function runControlAction(action) {
  const id = resolveDeviceId(lastRows);
  if (!id) {
    apiError.hidden = false;
    apiError.textContent =
      "Set VITE_DEVICE_ID in dashboard/.env (must match DEVICE_ID in secrets.h), or wait until a reading includes deviceId.";
    return;
  }
  const busy = [
    document.getElementById("chkAutoFan"),
    document.getElementById("chkAutoPump"),
    document.getElementById("chkAutoLight"),
    document.getElementById("btnFanOn"),
    document.getElementById("btnFanOff"),
    document.getElementById("btnPumpOn"),
    document.getElementById("btnPumpOff"),
    document.getElementById("btnLightOn"),
    document.getElementById("btnLightOff"),
  ];
  busy.forEach((el) => {
    if (el) el.disabled = true;
  });
  try {
    const ctrl = await action(id);
    if (ctrl && typeof ctrl === "object" && lastRows.length > 0) {
      apiError.hidden = true;
      setDataSourceBanner("live");
      const rowsCopy = lastRows.map((r) => ({ ...r }));
      patchLatestRowFromControl(rowsCopy[0], ctrl);
      applyRows(rowsCopy, { live: true, cachedSavedAt: null, control: ctrl });
    }
    await refresh();
  } catch (e) {
    apiError.hidden = false;
    apiError.textContent = String(e?.message || e);
    await refresh();
  } finally {
    busy.forEach((el) => {
      if (el) el.disabled = false;
    });
  }
}

function wireActuatorControls() {
  const chkF = document.getElementById("chkAutoFan");
  const chkP = document.getElementById("chkAutoPump");
  const chkL = document.getElementById("chkAutoLight");
  const btnFanOn = document.getElementById("btnFanOn");
  const btnFanOff = document.getElementById("btnFanOff");
  const btnPumpOn = document.getElementById("btnPumpOn");
  const btnPumpOff = document.getElementById("btnPumpOff");
  const btnLightOn = document.getElementById("btnLightOn");
  const btnLightOff = document.getElementById("btnLightOff");
  if (!chkF || !chkP || !chkL || !btnFanOn || !btnFanOff || !btnPumpOn || !btnPumpOff || !btnLightOn || !btnLightOff)
    return;

  chkF.addEventListener("change", async () => {
    if (controlSync) return;
    const on = chkF.checked;
    await runControlAction((id) => putControl(id, { autoFan: on }));
  });

  chkP.addEventListener("change", async () => {
    if (controlSync) return;
    const on = chkP.checked;
    await runControlAction((id) => putControl(id, { autoPump: on }));
  });

  chkL.addEventListener("change", async () => {
    if (controlSync) return;
    const on = chkL.checked;
    await runControlAction((id) => putControl(id, { autoLight: on }));
  });

  btnFanOn.addEventListener("click", async () => {
    await runControlAction((id) => postCommand(id, { fan: true }));
  });
  btnFanOff.addEventListener("click", async () => {
    await runControlAction((id) => postCommand(id, { fan: false }));
  });
  btnPumpOn.addEventListener("click", async () => {
    await runControlAction((id) => postCommand(id, { pump: true }));
  });
  btnPumpOff.addEventListener("click", async () => {
    await runControlAction((id) => postCommand(id, { pump: false }));
  });
  btnLightOn.addEventListener("click", async () => {
    await runControlAction((id) => postCommand(id, { light: true }));
  });
  btnLightOff.addEventListener("click", async () => {
    await runControlAction((id) => postCommand(id, { light: false }));
  });
}

navToggle?.addEventListener("click", () => layout.classList.toggle("nav-open"));
navBackdrop?.addEventListener("click", () => layout.classList.remove("nav-open"));
document.querySelectorAll(".sidebar .nav-link").forEach((a) => {
  a.addEventListener("click", () => {
    if (window.innerWidth <= 900) layout.classList.remove("nav-open");
  });
});

wireSensorNavigation();
wireActuatorControls();
refresh();
setInterval(refresh, 30000);
