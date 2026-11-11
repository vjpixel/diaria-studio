/**
 * scripts/lib/diaria/edition-video-evidence.ts (#12541)
 *
 * A edição tem evidência POSITIVA de que haveria vídeo? Regra única que a
 * task do vídeo relacionado do Short (`planShortRelated`/`decideShortRelatedPlan`,
 * #10811, no Neo) e o alarme `Diaria-Short-Related-Missed-Alarm` (#11353, no
 * `300`) compartilham, para os dois guards não divergirem de novo.
 *
 * Antes do #12541 a task só pulava a edição com o marcador manual
 * `_internal/no-video.json`; sem ele, a ausência de vídeo virava `wait` e
 * depois um alerta. Na 261109 (09/11) o editor recebeu "Horizontal e Short
 * não encontrados no canal" sobre uma edição que não tinha vídeo nenhum.
 *
 * Conta como evidência (qualquer uma basta):
 *   - Short registrado em `_internal/06-shorts-published*.json` com o destino
 *     `youtube_shorts`;
 *   - `_internal/05-youtube-step.json` com `outcome` `uploaded` (registro de
 *     antes do #12588) ou `already-published`;
 *   - `_internal/05-youtube-published.json` (registro do upload do horizontal);
 *   - `_internal/05-video-url.txt` com link do YouTube (o link do D1).
 *
 * Arquivo ILEGÍVEL conta como evidência: não dá para afirmar que não há
 * vídeo, e o guard erra para o lado de olhar (alertar) em vez de calar.
 * Sem nenhuma evidência a edição é "sem vídeo publicado", com ou sem o
 * marcador manual.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readD1VideoUrl } from "./d1-video-link-file.ts";
import { isNoVideoEdition } from "./d1-no-video.ts";
import type { ShortsPublishedFile } from "./short-video.ts";
import { readShortsRegistry } from "./shorts-published-store.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./youtube-upload.ts";

/** Destino do registro do vertical que conta como "Short publicado no YouTube". */
export const YOUTUBE_SHORTS_DESTINATION = "youtube_shorts";

/** Registro do §5b-youtube do Stage 5 (`scripts/stage5-youtube.ts`). */
export const YOUTUBE_STEP_FILE = "_internal/05-youtube-step.json";

/** Desfechos do `05-youtube-step.json` que provam vídeo da edição. */
export const VIDEO_STEP_OUTCOMES: ReadonlySet<string> = new Set(["uploaded", "already-published"]);

/** Leitura de um arquivo da edição: ausente, lido, ou ilegível (com o erro). */
export type FileRead<T> = { kind: "absent" } | { kind: "ok"; value: T } | { kind: "unreadable"; error: string };

export interface EditionVideoEvidenceInput {
  /** `_internal/no-video.json` presente (decisão manual do editor). */
  noVideo: boolean;
  shortsRegistry: FileRead<ShortsPublishedFile>;
  /** `05-youtube-step.json`: só o `outcome` importa. Default: ausente. */
  youtubeStep?: FileRead<{ outcome?: unknown }>;
  /** `05-youtube-published.json` existe. Default: `false`. */
  horizontalUploadRecord?: boolean;
  /** `05-video-url.txt` com link do YouTube válido. Default: `false`. */
  d1VideoUrl?: boolean;
}

export type EditionVideoEvidenceSource =
  | "shorts-registry"
  | "shorts-registry-unreadable"
  | "youtube-step"
  | "youtube-step-unreadable"
  | "horizontal-upload-record"
  | "d1-video-url";

export interface EditionVideoEvidence {
  hasEvidence: boolean;
  /** O que provou o vídeo (vazio quando não há evidência). */
  sources: EditionVideoEvidenceSource[];
  reason: string;
}

/** Pure: a edição tem evidência positiva de vídeo? */
export function assessEditionVideoEvidence(input: EditionVideoEvidenceInput): EditionVideoEvidence {
  if (input.noVideo) {
    return { hasEvidence: false, sources: [], reason: "edição marcada sem vídeo (_internal/no-video.json)" };
  }
  const sources: EditionVideoEvidenceSource[] = [];
  const reg = input.shortsRegistry;
  if (reg.kind === "unreadable") sources.push("shorts-registry-unreadable");
  else if (reg.kind === "ok" && reg.value.entries.some((e) => e.destination === YOUTUBE_SHORTS_DESTINATION)) {
    sources.push("shorts-registry");
  }
  const step = input.youtubeStep ?? { kind: "absent" };
  if (step.kind === "unreadable") sources.push("youtube-step-unreadable");
  else if (step.kind === "ok" && typeof step.value.outcome === "string" && VIDEO_STEP_OUTCOMES.has(step.value.outcome)) {
    sources.push("youtube-step");
  }
  if (input.horizontalUploadRecord) sources.push("horizontal-upload-record");
  if (input.d1VideoUrl) sources.push("d1-video-url");

  if (!sources.length) {
    return {
      hasEvidence: false,
      sources,
      reason:
        "edição sem vídeo publicado: sem Short youtube_shorts em 06-shorts-published.json, sem 05-youtube-step.json com uploaded/already-published, sem 05-youtube-published.json e sem link em 05-video-url.txt",
    };
  }
  return { hasEvidence: true, sources, reason: `evidência de vídeo: ${sources.join(", ")}` };
}

// ─── Leitura de disco ────────────────────────────────────────────────────────

/** Registro do vertical; sem entradas = ausente. */
export function readShortsRegistryFile(dir: string, aammdd: string): FileRead<ShortsPublishedFile> {
  try {
    const reg = readShortsRegistry(dir, aammdd);
    return reg.entries.length ? { kind: "ok", value: reg } : { kind: "absent" };
  } catch (e) {
    return { kind: "unreadable", error: (e as Error).message };
  }
}

export function readYouTubeStepFile(dir: string): FileRead<{ outcome?: unknown }> {
  const path = join(dir, YOUTUBE_STEP_FILE);
  if (!existsSync(path)) return { kind: "absent" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return { kind: "unreadable", error: `${path}: não é um objeto` };
    return { kind: "ok", value: parsed as { outcome?: unknown } };
  } catch (e) {
    return { kind: "unreadable", error: (e as Error).message };
  }
}

/** Monta a entrada do helper a partir da pasta da edição (só leitura). */
export function readEditionVideoEvidenceInput(dir: string, aammdd: string): EditionVideoEvidenceInput {
  let d1VideoUrl = false;
  try {
    d1VideoUrl = Boolean(readD1VideoUrl(dir).url);
  } catch {
    // Ilegível não prova vídeo por si só; as outras fontes decidem.
  }
  return {
    noVideo: isNoVideoEdition(dir),
    shortsRegistry: readShortsRegistryFile(dir, aammdd),
    youtubeStep: readYouTubeStepFile(dir),
    horizontalUploadRecord: existsSync(join(dir, YOUTUBE_PUBLISHED_FILE)),
    d1VideoUrl,
  };
}
