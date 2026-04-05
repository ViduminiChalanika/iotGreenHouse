/** @param {unknown} ts */
export function formatTime(ts) {
  if (ts == null) return "";
  const n = typeof ts === "string" ? Number(ts) : ts;
  const d = new Date(n > 1e12 ? n : n * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** @param {unknown} ts */
export function timeAgo(ts) {
  const n = typeof ts === "number" ? ts : Number(ts);
  const ms = n > 1e12 ? n : n * 1000;
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function luxFromLdr(ldrPct) {
  if (ldrPct == null || Number.isNaN(Number(ldrPct))) return null;
  return Math.round((Number(ldrPct) / 100) * 850);
}

export function normTemp(t) {
  if (t == null || Number.isNaN(Number(t))) return null;
  const v = Number(t);
  return Math.max(0, Math.min(100, ((v - 15) / 20) * 100));
}

/** @param {number|null} pct */
export function barWidth(pct) {
  if (pct == null || Number.isNaN(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

/** @param {unknown} ts */
export function rowTsMs(ts) {
  if (ts == null) return null;
  const n = typeof ts === "string" ? Number(ts) : Number(ts);
  if (Number.isNaN(n)) return null;
  return n > 1e12 ? n : n * 1000;
}

/** @param {Record<string, unknown>[]} rows */
export function filterLast24h(rows) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  return rows.filter((r) => {
    const ms = rowTsMs(r.ts);
    if (ms == null) return false;
    return now - ms <= day;
  });
}

/** @param {Record<string, unknown>[]} rows */
export function filterLast48h(rows) {
  const now = Date.now();
  const win = 48 * 60 * 60 * 1000;
  return rows.filter((r) => {
    const ms = rowTsMs(r.ts);
    if (ms == null) return false;
    return now - ms <= win;
  });
}
