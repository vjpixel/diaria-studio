/** Local-only cleanup (#11240). OneDrive deletion moves files to its recycle bin;
 * quota is not necessarily released immediately. Never follows paths from ledgers.
 */
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { listShortDestinations, type ShortsConfig } from "./short-video.ts";
import { readShortsRegistry } from "./shorts-published-store.ts";

export function shortsVideoTerminal(dir: string, edition: string, cfg: ShortsConfig): boolean {
  const entries = readShortsRegistry(dir, edition).entries;
  // Disabled destinations are skipped. Missing credentials, --only and delegation
  // are NOT proof that a destination has finished (especially the LinkedIn timer).
  return listShortDestinations(cfg)
    .filter(d => d.mode === "api" || d.id === "youtube_shorts" || d.id === "x")
    .every(d => entries.some(e => e.destination === d.id && (e.status === "published" || e.status === "scheduled")));
}

export function cleanupPublishedVideo(input: {
  dir: string; edition: string; kind: "horizontal" | "vertical";
  config?: ShortsConfig; keepVideo?: boolean; log: (line: string) => void;
}): void {
  if (input.keepVideo) return;
  const { dir, edition, log } = input;
  if (!/^\d{6}$/.test(edition)) throw new Error("edição inválida para limpeza");
  const stem = `diaria-comentada-${edition}`;
  const paths: string[] = [];
  if (input.kind === "horizontal") {
    const path = join(dir, "_internal", "05-youtube-published.json");
    if (!existsSync(path)) return;
    const rec = JSON.parse(readFileSync(path, "utf8"));
    if (rec.aammdd === edition && rec.videoId && !rec.status &&
        ["uploaded", "processed"].includes(rec.rereadStatus?.uploadStatus)) paths.push(join(dir, `${stem}.mp4`));
  } else {
    if (!input.config) throw new Error("config ausente para limpeza do vertical");
    const entries = readShortsRegistry(dir, edition).entries;
    const ig = entries.find(e => e.destination === "instagram");
    if (shortsVideoTerminal(dir, edition, input.config)) paths.push(join(dir, `${stem}-short.mp4`));
    if (ig?.status === "published" || ig?.status === "scheduled") paths.push(join(dir, `${stem}-short-instagram.mp4`));
    if (ig?.status === "published") {
      const chrome = join(dir, "_internal", `${stem}-short-instagram-chrome.mp4`);
      paths.push(chrome, `${chrome}.json`);
    }
  }
  for (const path of paths) {
    try {
      if (!existsSync(path) || !lstatSync(path).isFile()) continue;
      unlinkSync(path);
      log(`[ok] apagado ${path}`);
    } catch (e) { log(`[aviso] não foi possível apagar ${path}: ${(e as Error).message}`); }
  }
}
