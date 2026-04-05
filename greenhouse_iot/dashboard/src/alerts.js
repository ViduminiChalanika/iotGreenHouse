/** @param {Record<string, unknown>|null|undefined} latest */
export function buildAlerts(latest) {
  const alerts = [];
  if (!latest || Object.keys(latest).length === 0) {
    return alerts;
  }
  const t = latest.t != null ? Number(latest.t) : null;
  const h = latest.h != null ? Number(latest.h) : null;
  const soil = latest.soilPct != null ? Number(latest.soilPct) : null;

  if (soil != null && soil < 40) {
    alerts.push({
      type: "crit",
      text: `Soil moisture critical: ${soil.toFixed(0)}% — below 40% threshold. Irrigate Zone A now.`,
    });
  }
  if (h != null && h > 80) {
    alerts.push({
      type: "warn",
      text: `Humidity elevated: ${h.toFixed(0)}% — fungal disease risk. Increase airflow.`,
    });
  }
  if (t != null) {
    if (t < 18 || t > 35) {
      alerts.push({
        type: "warn",
        text: `Temperature out of range: ${t.toFixed(1)}°C (safe band 18–30°C).`,
      });
    } else {
      alerts.push({
        type: "ok",
        text: `Temperature normal: ${t.toFixed(1)}°C within safe 18–30°C range.`,
      });
    }
  }
  return alerts;
}

/** @param {ReturnType<typeof buildAlerts>} alerts */
export function updateSummaryPill(alerts) {
  const pill = document.getElementById("pillSummary");
  if (!pill) return;
  const crit = alerts.filter((a) => a.type === "crit").length;
  const warn = alerts.filter((a) => a.type === "warn").length;
  if (crit === 0 && warn === 0) {
    pill.textContent = "All clear";
    pill.className = "pill";
  } else {
    pill.textContent = `${crit ? crit + " critical" : ""}${crit && warn ? " · " : ""}${warn ? warn + " warning" : ""}`;
    pill.className = "pill pill--warn";
  }
}
