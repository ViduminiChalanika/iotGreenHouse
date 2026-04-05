import { buildAlerts, updateSummaryPill } from "./alerts.js";
import { fetchReadingsJson } from "./readings-fetch.js";
import { destroySensorChart, renderSensorPage, SENSOR_PAGES } from "./sensor-detail.js";
import { formatTime, timeAgo } from "./shared.js";

const API_KEY = import.meta.env.VITE_API_KEY;
const VITE_DEVICE_ID = import.meta.env.VITE_DEVICE_ID;
const CACHE_KEY = "greensense_readings_v1";

const VALID_SENSORS = new Set(["temperature", "humidity", "soil", "light"]);

const layout = document.getElementById("app");
const navToggle = document.getElementById("navToggle");
const navBackdrop = document.getElementById("navBackdrop");
const apiError = document.getElementById("apiError");

/** @type {Record<string, unknown>[]} */
let lastRows = [];

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

function getSensorIdFromUrl() {
  const raw = new URLSearchParams(location.search).get("sensor");
  return raw && VALID_SENSORS.has(raw) ? raw : null;
}

function highlightNav(sensorId) {
  document.querySelectorAll(".sidebar .nav-link").forEach((a) => a.classList.remove("active"));
  document.querySelector(".nav-link--dash")?.classList.remove("active");
  document.querySelector(`.nav-link--sensor[data-sensor="${sensorId}"]`)?.classList.add("active");
}

function setSidebarFooter(mode) {
  const el = document.getElementById("sidebarSensorLine");
  if (!el) return;
  el.textContent =
    mode === "live"
      ? "3 sensors online · Zone A"
      : "Last known data · device or API may be offline";
}

/**
 * @param {string} sensorId
 * @param {boolean} live
 * @param {number} [cachedSavedAt]
 */
function applySensorView(sensorId, live, cachedSavedAt) {
  const meta = SENSOR_PAGES[sensorId];
  if (!meta) return;

  const title = document.getElementById("pageTitle");
  if (title) title.textContent = meta.pageTitle;
  document.title = `${meta.pageTitle} — GreenSense`;

  highlightNav(sensorId);

  const latest = lastRows[0] || null;
  renderSensorPage(sensorId, lastRows, latest);

  const alerts = buildAlerts(latest);
  updateSummaryPill(alerts);

  const badge = document.getElementById("navAlertBadge");
  if (badge) {
    const crit = alerts.filter((a) => a.type === "crit").length;
    const warn = alerts.filter((a) => a.type === "warn").length;
    badge.textContent = String(crit + warn);
    badge.style.display = crit + warn > 0 ? "inline-flex" : "none";
  }

  const pill = document.getElementById("pillUpdated");
  if (pill) {
    if (latest?.ts) {
      const base = `Sample ${timeAgo(latest.ts)} · ${formatTime(latest.ts)}`;
      pill.textContent = live ? `Live · ${base}` : `Cached view · ${base}`;
    } else {
      pill.textContent = "No samples yet";
    }
    if (cachedSavedAt && !live) {
      pill.textContent += ` · cache saved ${new Date(cachedSavedAt).toLocaleTimeString()}`;
    }
  }

  const note = document.getElementById("dataSourceNote");
  if (note) note.hidden = true;

  setSidebarFooter(live ? "live" : "cache");
}

async function refresh(sensorId) {
  if (!API_KEY || API_KEY === "change-this-to-match-rest_api-env") {
    apiError.hidden = false;
    apiError.textContent =
      "Set VITE_API_KEY in dashboard/.env (same as rest_api API_KEY), then restart: npm run dev";
    const c = loadCache();
    if (c) {
      lastRows = c.rows;
      applySensorView(sensorId, false, c.savedAt);
    }
    return;
  }

  try {
    const rows = await fetchReadingsJson({
      apiKey: API_KEY,
      deviceId: VITE_DEVICE_ID || undefined,
    });
    if (rows !== null && rows.length > 0) {
      try {
        const trimmed = rows.slice(0, 500);
        localStorage.setItem(CACHE_KEY, JSON.stringify({ rows: trimmed, savedAt: Date.now() }));
      } catch (e) {
        console.warn("greensense cache save failed", e);
      }
      apiError.hidden = true;
      lastRows = rows;
      applySensorView(sensorId, true);
      return;
    }
  } catch (e) {
    console.warn("fetch /api/readings failed", e);
    apiError.hidden = false;
    apiError.textContent =
      e instanceof Error ? e.message : "Network error — cannot reach API. Using cache if available.";
  }

  const c = loadCache();
  if (c && c.rows.length > 0) {
    apiError.hidden = false;
    apiError.textContent = "API unavailable — showing last browser cache.";
    lastRows = c.rows;
    applySensorView(sensorId, false, c.savedAt);
    return;
  }

  lastRows = [];
  applySensorView(sensorId, false);
}

function init() {
  const sensorId = getSensorIdFromUrl();
  if (!sensorId) {
    window.location.replace("index.html");
    return;
  }

  navToggle?.addEventListener("click", () => layout.classList.toggle("nav-open"));
  navBackdrop?.addEventListener("click", () => layout.classList.remove("nav-open"));
  document.querySelectorAll(".sidebar .nav-link").forEach((a) => {
    a.addEventListener("click", () => {
      if (window.innerWidth <= 900) layout.classList.remove("nav-open");
    });
  });

  refresh(sensorId);
  setInterval(() => refresh(sensorId), 30000);
}

init();

window.addEventListener("beforeunload", () => {
  destroySensorChart();
});
