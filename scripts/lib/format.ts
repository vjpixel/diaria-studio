/**
 * Shared formatting helpers used by stage-status rendering and edition reports.
 */

export function fmtTimeBrt(iso: string | undefined): string {
  if (!iso) return "-";
  const ms = Date.parse(iso);
  if (isNaN(ms)) return "-";
  const brt = new Date(ms - 3 * 3600 * 1000);
  const hh = String(brt.getUTCHours()).padStart(2, "0");
  const mm = String(brt.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function fmtDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return "-";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

export { escHtml as escapeHtml } from "./html-escape.ts"; // #1990 follow-up: canonical impl
