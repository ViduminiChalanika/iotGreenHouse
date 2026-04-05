import Chart from "chart.js/auto";
import {
  barWidth,
  filterLast24h,
  filterLast48h,
  formatTime,
  luxFromLdr,
  normTemp,
  rowTsMs,
} from "./shared.js";

let sensorTrendChart = null;

/** @typedef {{ label: string; value: string }} ThresholdRow */
/** @type {Record<string, { pageTitle: string; chartTitle: string; chartHours: 24 | 48; color: string; unit: string; gaugeMin: number; gaugeMax: number; gaugeSublabel: string; thresholds: ThresholdRow[]; sensorModel: string; icon: string }>} */
export const SENSOR_PAGES = {
  temperature: {
    pageTitle: "Temperature Monitoring",
    chartTitle: "TEMPERATURE OVER 24 HOURS (°C)",
    chartHours: 24,
    color: "#22c55e",
    unit: "°C",
    gaugeMin: 0,
    gaugeMax: 40,
    gaugeSublabel: "18–30 °C optimal band",
    icon: "🌡️",
    sensorModel: "DHT11",
    thresholds: [
      { label: "Optimal low", value: "18 °C" },
      { label: "Optimal high", value: "30 °C" },
      { label: "Critical high", value: "35 °C" },
      { label: "Sensor", value: "DHT11" },
    ],
  },
  humidity: {
    pageTitle: "Humidity Monitoring",
    chartTitle: "HUMIDITY OVER 24 HOURS (%)",
    chartHours: 24,
    color: "#3b82f6",
    unit: "%",
    gaugeMin: 0,
    gaugeMax: 100,
    gaugeSublabel: "50–75 % comfortable",
    icon: "💧",
    sensorModel: "DHT11",
    thresholds: [
      { label: "Optimal low", value: "50 %" },
      { label: "Optimal high", value: "75 %" },
      { label: "Fungal risk above", value: "80 %" },
      { label: "Sensor", value: "DHT11" },
    ],
  },
  soil: {
    pageTitle: "Soil Moisture Monitoring",
    chartTitle: "SOIL MOISTURE OVER 48 HOURS (%)",
    chartHours: 48,
    color: "#d97706",
    unit: "%",
    gaugeMin: 0,
    gaugeMax: 100,
    gaugeSublabel: "40–70 % optimal",
    icon: "🪴",
    sensorModel: "Capacitive probe",
    thresholds: [
      { label: "Optimal low", value: "40 %" },
      { label: "Optimal high", value: "70 %" },
      { label: "Irrigate below", value: "40 %" },
      { label: "Sensor", value: "Capacitive v1" },
    ],
  },
  light: {
    pageTitle: "Light Level Monitoring",
    chartTitle: "LIGHT LEVEL OVER 24 HOURS (LUX)",
    chartHours: 24,
    color: "#eab308",
    unit: " lux",
    gaugeMin: 0,
    gaugeMax: 1000,
    gaugeSublabel: "400–1000 lux optimal (mapped from LDR)",
    icon: "☀️",
    sensorModel: "LDR (scaled to lux)",
    thresholds: [
      { label: "Optimal low", value: "400 lux" },
      { label: "Optimal high", value: "1000 lux" },
      { label: "Supplemental if below", value: "~300 lux" },
      { label: "Sensor", value: "LDR on ESP32" },
    ],
  },
};

/**
 * @param {Record<string, unknown>[]} rows sorted not required
 * @param {(r: Record<string, unknown>) => number|null} valFn
 */
function todayMaxMin(rows, valFn) {
  const now = new Date();
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const d1 = d0 + 24 * 60 * 60 * 1000;
  const vals = [];
  for (const r of rows) {
    const ms = rowTsMs(r.ts);
    if (ms == null || ms < d0 || ms >= d1) continue;
    const v = valFn(r);
    if (v != null && !Number.isNaN(v)) vals.push(v);
  }
  if (vals.length === 0) return { max: null, min: null };
  return { max: Math.max(...vals), min: Math.min(...vals) };
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {(r: Record<string, unknown>) => number|null} valFn
 */
function yesterdayAverage(rows, valFn) {
  const now = new Date();
  const y0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const y1 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const vals = [];
  for (const r of rows) {
    const ms = rowTsMs(r.ts);
    if (ms == null || ms < y0 || ms >= y1) continue;
    const v = valFn(r);
    if (v != null && !Number.isNaN(v)) vals.push(v);
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * @param {number|null|undefined} v
 * @param {string} sensorId
 */
function formatSensorValue(v, sensorId) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  if (sensorId === "temperature") return `${n.toFixed(1)}°C`;
  if (sensorId === "humidity" || sensorId === "soil") return `${Math.round(n)}%`;
  if (sensorId === "light") return `${Math.round(n)} lux`;
  return String(n);
}

/**
 * @param {string} sensorId
 * @param {Record<string, unknown>|null|undefined} latest
 */
function valueFromLatest(sensorId, latest) {
  if (!latest) return null;
  if (sensorId === "temperature") return latest.t != null ? Number(latest.t) : null;
  if (sensorId === "humidity") return latest.h != null ? Number(latest.h) : null;
  if (sensorId === "soil") return latest.soilPct != null ? Number(latest.soilPct) : null;
  if (sensorId === "light") return luxFromLdr(latest.ldrPct != null ? Number(latest.ldrPct) : null);
  return null;
}

/**
 * @param {string} sensorId
 */
function valueSeries(sensorId) {
  const fn =
    sensorId === "temperature"
      ? (r) => (r.t != null ? Number(r.t) : null)
      : sensorId === "humidity"
        ? (r) => (r.h != null ? Number(r.h) : null)
        : sensorId === "soil"
          ? (r) => (r.soilPct != null ? Number(r.soilPct) : null)
          : (r) => luxFromLdr(r.ldrPct != null ? Number(r.ldrPct) : null);
  return { fn, yLabel: sensorId === "light" ? "Lux" : sensorId === "temperature" ? "°C" : "%" };
}

/**
 * @param {string} sensorId
 * @param {number|null|undefined} v
 */
function pctForSensorBar(sensorId, v) {
  if (v == null || Number.isNaN(Number(v))) return 0;
  const n = Number(v);
  if (sensorId === "temperature") return barWidth(normTemp(n) ?? 0);
  if (sensorId === "light") return Math.min(100, (n / 1000) * 100);
  return barWidth(n);
}

export function destroySensorChart() {
  if (sensorTrendChart) {
    sensorTrendChart.destroy();
    sensorTrendChart = null;
  }
}

/**
 * @param {string} sensorId
 * @param {Record<string, unknown>[]} rows
 */
function buildSensorChart(sensorId, rows) {
  const canvas = document.getElementById("sensorTrendChart");
  if (!canvas) return;
  const meta = SENSOR_PAGES[sensorId];
  const { fn } = valueSeries(sensorId);
  const windowRows = meta.chartHours === 48 ? filterLast48h(rows) : filterLast24h(rows);
  const sorted = [...windowRows].sort((a, b) => Number(a.ts) - Number(b.ts));
  const labels = sorted.map((r) => formatTime(r.ts));
  const data = sorted.map((r) => {
    const v = fn(r);
    return v != null && !Number.isNaN(v) ? v : null;
  });

  destroySensorChart();
  if (sorted.length === 0) {
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  let yMin = Infinity;
  let yMax = -Infinity;
  for (const v of data) {
    if (v != null) {
      yMin = Math.min(yMin, v);
      yMax = Math.max(yMax, v);
    }
  }
  if (!Number.isFinite(yMin)) yMin = 0;
  if (!Number.isFinite(yMax)) yMax = 1;
  const pad = (yMax - yMin) * 0.12 || 1;
  const yAxisMin = Math.max(0, yMin - pad);
  const yAxisMax = yMax + pad;

  sensorTrendChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: meta.pageTitle,
          data,
          borderColor: meta.color,
          backgroundColor: meta.color + "18",
          fill: true,
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
          suggestedMin: Math.max(0, yAxisMin - pad * 0.5),
          suggestedMax: yAxisMax + pad,
          title: { display: true, text: valueSeries(sensorId).yLabel },
          grid: { color: "rgba(0,0,0,0.06)" },
        },
        x: {
          grid: { display: false },
          ticks: { maxRotation: 45, minRotation: 0, autoSkip: true, maxTicksLimit: 14 },
        },
      },
    },
  });
}

/**
 * @param {number} value
 * @param {number} minV
 * @param {number} maxV
 */
function setGaugeNeedle(value, minV, maxV) {
  const needle = document.getElementById("sdGaugeNeedle");
  if (!needle) return;
  const t = Math.max(0, Math.min(1, (value - minV) / (maxV - minV || 1)));
  const theta = Math.PI * (1 - t);
  const r = 75;
  const x2 = 100 + r * Math.cos(theta);
  const y2 = 100 - r * Math.sin(theta);
  needle.setAttribute("x2", String(x2));
  needle.setAttribute("y2", String(y2));
}

/**
 * @param {string} sensorId
 * @param {Record<string, unknown>|null|undefined} latest
 * @param {Record<string, unknown>[]} rows
 */
function buildSensorDecisions(sensorId, latest, rows) {
  const out = [];
  const t = latest?.t != null ? Number(latest.t) : null;
  const h = latest?.h != null ? Number(latest.h) : null;
  const soil = latest?.soilPct != null ? Number(latest.soilPct) : null;
  const lux = latest?.ldrPct != null ? luxFromLdr(Number(latest.ldrPct)) : null;

  if (sensorId === "temperature" && t != null) {
    if (t >= 18 && t <= 30) {
      out.push({
        type: "ok",
        icon: "✓",
        text: "No action needed. Temperature is within the optimal 18–30 °C band. Continue monitoring the trend.",
      });
    }
    if (t > 30) {
      out.push({
        type: "warn",
        icon: "⚠️",
        text: "Ventilation trigger — warm zone. If temperature stays above 30 °C, increase airflow or shade.",
      });
    }
    if (t < 18) {
      out.push({
        type: "warn",
        icon: "⚠️",
        text: "Below optimal — consider heating or closing vents if cold persists overnight.",
      });
    }
  }

  if (sensorId === "humidity" && h != null) {
    if (h > 80) {
      out.push({
        type: "crit",
        icon: "⛔",
        text: `Fungal disease risk — act now. ${h.toFixed(0)}% exceeds the 80% safe threshold. Increase airflow.`,
      });
    } else if (h > 75) {
      out.push({
        type: "warn",
        icon: "⚠️",
        text: "Humidity elevated — run circulation fans and monitor for condensation.",
      });
    } else {
      out.push({
        type: "ok",
        icon: "✓",
        text: "Humidity in a reasonable range for most greenhouse crops.",
      });
    }
  }

  if (sensorId === "soil" && soil != null) {
    if (soil < 40) {
      out.push({
        type: "crit",
        icon: "⛔",
        text: `Irrigate Zone A immediately. ${soil.toFixed(0)}% is below the critical 40% threshold.`,
      });
    } else if (soil < 55) {
      out.push({
        type: "warn",
        icon: "⚠️",
        text: "Soil is drying — schedule irrigation before it drops below 40%.",
      });
    } else {
      out.push({
        type: "ok",
        icon: "✓",
        text: "Soil moisture is adequate for most plants.",
      });
    }
    const sorted = [...rows].sort((a, b) => Number(a.ts) - Number(b.ts));
    if (sorted.length >= 2) {
      const { fn } = valueSeries("soil");
      const v0 = fn(sorted[sorted.length - 2]);
      const v1 = fn(sorted[sorted.length - 1]);
      if (v0 != null && v1 != null && v1 < v0) {
        const rate = v0 - v1;
        out.push({
          type: "warn",
          icon: "📉",
          text: `Moisture is trending down (~${rate.toFixed(1)}% between recent samples). Re-check after watering.`,
        });
      }
    }
  }

  if (sensorId === "light" && lux != null) {
    if (lux >= 400 && lux <= 1000) {
      out.push({
        type: "ok",
        icon: "✓",
        text: `Light level looks good — ${lux} lux is in a healthy range for growth (mapped from LDR).`,
      });
    } else if (lux < 300) {
      out.push({
        type: "warn",
        icon: "⚠️",
        text: "Low light — consider supplemental grow lighting during short winter days.",
      });
    } else {
      out.push({
        type: "ok",
        icon: "✓",
        text: "Natural light is strong; watch leaf temperature and shading if needed.",
      });
    }
  }

  if (out.length === 0) {
    out.push({ type: "info", icon: "ℹ️", text: "Waiting for sensor data for this channel." });
  }
  return out;
}

/**
 * @param {string} sensorId
 * @param {Record<string, unknown>[]} rows
 * @param {Record<string, unknown>|null} latest
 */
export function renderSensorPage(sensorId, rows, latest) {
  const meta = SENSOR_PAGES[sensorId];
  if (!meta) return;

  const titleEl = document.getElementById("sensorChartTitle");
  if (titleEl) titleEl.textContent = meta.chartTitle;

  const cur = valueFromLatest(sensorId, latest);
  const { fn } = valueSeries(sensorId);
  const tm = todayMaxMin(rows, (r) => fn(r));

  const el = (id) => document.getElementById(id);

  el("sdKpi1Label").textContent = "Current";
  el("sdKpi1Icon").textContent = meta.icon;
  el("sdKpi1Value").textContent = formatSensorValue(cur, sensorId);
  el("sdKpi1Bar").style.width = `${pctForSensorBar(sensorId, cur)}%`;

  if (sensorId === "soil") {
    el("sdKpi2Label").textContent = "Yesterday avg";
    el("sdKpi2Icon").textContent = "📅";
    const yAvg = yesterdayAverage(rows, (r) => fn(r));
    el("sdKpi2Value").textContent = yAvg != null ? `${Math.round(yAvg)}%` : "—";
    el("sdKpi2Status").innerHTML =
      yAvg != null && yAvg >= 40
        ? `<span class="dot dot--ok"></span><span class="status-ok">Was in range</span>`
        : `<span class="dot dot--muted"></span><span>No baseline</span>`;
    el("sdKpi2Bar").style.width = `${pctForSensorBar(sensorId, yAvg)}%`;

    el("sdKpi3Label").textContent = "Irrigation";
    el("sdKpi3Icon").textContent = "💧";
    const soil = cur;
    let urgency = "Not needed";
    let badge = "";
    let badgeCls = "";
    if (soil != null) {
      if (soil < 40) {
        urgency = "Immediately";
        badge = "Urgent";
        badgeCls = "sensor-kpi-badge sensor-kpi-badge--urgent";
      } else if (soil < 55) {
        urgency = "Soon";
        badge = "Warning";
        badgeCls = "sensor-kpi-badge";
      } else {
        urgency = "OK";
      }
    }
    el("sdKpi3Value").textContent = urgency;
    el("sdKpi3Status").innerHTML =
      soil != null && soil < 40
        ? `<span class="dot dot--bad"></span><span class="status-bad">Critical — irrigate</span>`
        : soil != null && soil < 55
          ? `<span class="dot dot--warn"></span><span class="status-warn">Getting dry</span>`
          : `<span class="dot dot--ok"></span><span class="status-ok">Adequate</span>`;
    const barW = el("sdKpi3Bar");
    if (barW) barW.style.width = soil != null ? `${pctForSensorBar(sensorId, soil)}%` : "0%";
    const b = el("sdKpi3Badge");
    if (b) {
      if (badge) {
        b.hidden = false;
        b.className = badgeCls;
        b.textContent = badge;
      } else {
        b.hidden = true;
      }
    }
  } else {
    el("sdKpi2Label").textContent = "Today max";
    el("sdKpi2Icon").textContent = "📈";
    el("sdKpi2Value").textContent = formatSensorValue(tm.max, sensorId);
    el("sdKpi2Status").innerHTML =
      tm.max != null
        ? `<span class="dot dot--ok"></span><span>Peak so far</span>`
        : `<span class="dot dot--muted"></span><span>—</span>`;
    el("sdKpi2Bar").style.width = `${pctForSensorBar(sensorId, tm.max)}%`;

    el("sdKpi3Label").textContent = "Today min";
    el("sdKpi3Icon").textContent = "📉";
    el("sdKpi3Value").textContent = formatSensorValue(tm.min, sensorId);
    el("sdKpi3Status").innerHTML =
      tm.min != null
        ? `<span class="dot dot--ok"></span><span>Low so far</span>`
        : `<span class="dot dot--muted"></span><span>—</span>`;
    el("sdKpi3Bar").style.width = `${pctForSensorBar(sensorId, tm.min)}%`;
    const b = el("sdKpi3Badge");
    if (b) b.hidden = true;
  }

  el("sdGaugeTitle").textContent =
    sensorId === "temperature"
      ? "Temperature"
      : sensorId === "humidity"
        ? "Humidity"
        : sensorId === "soil"
          ? "Soil moisture"
          : "Light level";
  el("sdGaugeIcon").textContent = "◎";
  if (cur != null) {
    setGaugeNeedle(cur, meta.gaugeMin, meta.gaugeMax);
    el("sdGaugeReadout").textContent = formatSensorValue(cur, sensorId);
  } else {
    el("sdGaugeReadout").textContent = "—";
  }
  el("sdGaugeSublabel").textContent = meta.gaugeSublabel;

  const th = el("sdThresholdList");
  if (th) {
    th.innerHTML = meta.thresholds
      .map((row) => `<div><dt>${row.label}</dt><dd>${row.value}</dd></div>`)
      .join("");
  }

  const dec = el("sdDecisionList");
  if (dec) {
    dec.innerHTML = buildSensorDecisions(sensorId, latest, rows)
      .map(
        (d) =>
          `<div class="alert alert--${d.type === "crit" ? "crit" : d.type === "warn" ? "warn" : d.type === "ok" ? "ok" : "info"}"><span class="alert-icon">${d.icon}</span><div>${d.text}</div></div>`
      )
      .join("");
  }

  buildSensorChart(sensorId, rows);
}
