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
  // Guided destinations count too: `facebook_profile` is posted by the editor FROM
  // the local vertical file, so deleting it earlier would strand that step (PR #11270
  // review, achado 1). Only `linkedin_page_repost` is exempt: it reposts the
  // LinkedIn profile video and never needs the local file.
  return listShortDestinations(cfg)
    .filter(d => d.id !== "linkedin_page_repost")
    .every(d => entries.some(e => e.destination === d.id && (e.status === "published" || e.status === "scheduled")));
}

type CleanupInput = {
  dir: string; edition: string; kind: "horizontal" | "vertical";
  /** Config or a lazy loader, so a config read error is also contained (achado 3). */
  config?: ShortsConfig | (() => ShortsConfig); keepVideo?: boolean; log: (line: string) => void;
};

/**
 * Never throws (PR #11270 review, achado 3): it runs after a post already went out,
 * so a failure here (unreadable registry, bad config) must not change the caller's
 * exit code nor lose its JSON result. Any error becomes an `[aviso]` line and the
 * files stay on disk (fail-safe).
 */
export function cleanupPublishedVideo(input: CleanupInput): void {
  if (input.keepVideo) return;
  let paths: string[];
  try {
    paths = cleanupCandidates(input);
  } catch (e) {
    input.log(`[aviso] limpeza do vídeo ${input.kind} ignorada (arquivos mantidos): ${(e as Error).message}`);
    return;
  }
  for (const path of paths) {
    try {
      if (!existsSync(path) || !lstatSync(path).isFile()) continue;
      unlinkSync(path);
      input.log(`[ok] apagado ${path}`);
    } catch (e) { input.log(`[aviso] não foi possível apagar ${path}: ${(e as Error).message}`); }
  }
}

function cleanupCandidates(input: CleanupInput): string[] {
  const { dir, edition } = input;
  if (!/^\d{6}$/.test(edition)) throw new Error("edição inválida para limpeza");
  const stem = `diaria-comentada-${edition}`;
  const paths: string[] = [];
  if (input.kind === "horizontal") {
    const path = join(dir, "_internal", "05-youtube-published.json");
    if (!existsSync(path)) return paths;
    const rec = JSON.parse(readFileSync(path, "utf8"));
    if (rec.aammdd === edition && rec.videoId && !rec.status &&
        ["uploaded", "processed"].includes(rec.rereadStatus?.uploadStatus)) paths.push(join(dir, `${stem}.mp4`));
  } else {
    if (!input.config) throw new Error("config ausente para limpeza do vertical");
    const config = typeof input.config === "function" ? input.config() : input.config;
    const entries = readShortsRegistry(dir, edition).entries;
    const ig = entries.find(e => e.destination === "instagram");
    if (shortsVideoTerminal(dir, edition, config)) paths.push(join(dir, `${stem}-short.mp4`));
    if (ig?.status === "published" || ig?.status === "scheduled") paths.push(join(dir, `${stem}-short-instagram.mp4`));
    if (ig?.status === "published") {
      const chrome = join(dir, "_internal", `${stem}-short-instagram-chrome.mp4`);
      paths.push(chrome, `${chrome}.json`);
    }
  }
  return paths;
}
