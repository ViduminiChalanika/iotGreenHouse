/**
 * @param {{ apiKey: string; deviceId?: string | null }} opts
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function fetchReadingsJson({ apiKey, deviceId }) {
  const q = new URLSearchParams({ limit: "500" });
  if (deviceId) q.set("deviceId", deviceId);
  const res = await fetch(`/api/readings?${q}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err.slice(0, 120)}`);
  }
  return res.json();
}
