export function youtubeId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    let id = null;
    if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
    if (["youtube.com","www.youtube.com","m.youtube.com"].includes(host)) {
      id = url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1];
    }
    return /^[\w-]{11}$/.test(id || "") ? id : null;
  } catch { return null; }
}
export function countdownLabel(value, now = Date.now()) {
  const ms = new Date(value).getTime() - now;
  if (!Number.isFinite(ms)) return "Дата не задана";
  if (ms <= 0) return "Событие наступило 🎉";
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 86400)} дн. ${String(Math.floor(seconds / 3600) % 24).padStart(2,"0")}:${String(Math.floor(seconds / 60) % 60).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`;
}
