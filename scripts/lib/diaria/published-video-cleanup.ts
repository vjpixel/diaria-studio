/** Local-only cleanup (#11240). OneDrive deletion moves files to its recycle bin;
 * quota is not necessarily released immediately. Never follows paths from ledgers.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listShortDestinations, shortInstagramVideoFileName, type ShortsConfig } from "./short-video.ts";
import { readShortsRegistry } from "./shorts-published-store.ts";

/**
 * Destinos que o último `publish-shorts --publish` pulou por falta de
 * credencial/token (#11240, decisão do editor 27/10/2026: pulo por credencial é
 * TERMINAL e libera apagar o vertical). Arquivo à parte do registro de
 * publicação de propósito: o pulo não pode virar `skip_done` numa rodada futura
 * que já tenha o token, só destravar a limpeza. O nome não começa com
 * `06-shorts-published`, então `readShortsRegistry` não o lê.
 */
export const SHORTS_CREDENTIAL_SKIPS_FILE = "_internal/06-shorts-credential-skips.json";

/** Lê os pulos por credencial. Ausente, ilegível ou de outra edição = vazio (fail-safe: o arquivo fica). */
export function readCredentialSkips(dir: string, edition: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, SHORTS_CREDENTIAL_SKIPS_FILE), "utf8"));
    if (raw?.aammdd !== edition || !Array.isArray(raw.entries)) return new Set();
    return new Set(raw.entries.map((e: { destination?: unknown }) => e?.destination).filter((d: unknown): d is string => typeof d === "string"));
  } catch {
    return new Set();
  }
}

/**
 * Atualiza os pulos por credencial com o resultado de UMA rodada: só os
 * destinos que essa rodada planejou mudam (um `--only` não apaga o pulo de quem
 * ficou de fora). Destino planejado que não pulou por credencial sai da lista.
 */
export function recordCredentialSkips(
  dir: string,
  edition: string,
  planned: readonly string[],
  skipped: ReadonlyArray<{ destination: string; detail: string }>,
  now: string,
): void {
  const path = join(dir, SHORTS_CREDENTIAL_SKIPS_FILE);
  const plannedSet = new Set(planned);
  let prev: Array<{ destination: string; detail: string; at: string }> = [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw?.aammdd === edition && Array.isArray(raw.entries)) prev = raw.entries;
  } catch { /* ausente ou ilegível: recomeça */ }
  const entries = [
    ...prev.filter(e => typeof e?.destination === "string" && !plannedSet.has(e.destination)),
    ...skipped.map(s => ({ destination: s.destination, detail: s.detail, at: now })),
  ];
  if (!entries.length && !existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ aammdd: edition, entries }, null, 2) + "\n");
  renameSync(tmp, path);
}

export function shortsVideoTerminal(dir: string, edition: string, cfg: ShortsConfig): boolean {
  const entries = readShortsRegistry(dir, edition).entries;
  const credentialSkips = readCredentialSkips(dir, edition);
  // Disabled destinations are skipped. A destination the last --publish skipped for
  // missing credentials/token is terminal too (#11240, editor decision 27/10/2026).
  // --only and delegation are NOT proof that a destination has finished (especially
  // the LinkedIn timer, which reads the local file at its own time).
  // Guided destinations count too: `facebook_profile` is posted by the editor FROM
  // the local vertical file, so deleting it earlier would strand that step (PR #11270
  // review, achado 1). Only `linkedin_page_repost` is exempt: it reposts the
  // LinkedIn profile video and never needs the local file.
  return listShortDestinations(cfg)
    .filter(d => d.id !== "linkedin_page_repost")
    .every(d => credentialSkips.has(d.id) ||
      entries.some(e => e.destination === d.id && (e.status === "published" || e.status === "scheduled")));
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
    if (ig?.status === "published" || ig?.status === "scheduled") paths.push(join(dir, shortInstagramVideoFileName(edition)));
    if (ig?.status === "published") {
      const chrome = join(dir, "_internal", `${stem}-short-instagram-chrome.mp4`);
      paths.push(chrome, `${chrome}.json`);
    }
  }
  return paths;
}
