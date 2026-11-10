#!/usr/bin/env node
/**
 * scripts/stage5-youtube.ts (#10659, só leitura desde #12588)
 *
 * §5b-youtube do Stage 5: registra se o D1 sai com o link do vídeo do dia e,
 * sem ele, PARA antes do dispatch social. Grava SEMPRE
 * `_internal/05-youtube-step.json` + `run-log` (a invariante `youtube-step-ran`
 * confere o registro).
 *
 * Desde o #12588 (decisão do editor, 10/11/2026) este passo **nunca busca
 * nem sobe vídeo**. Quem sobe o horizontal é só o `/diaria-publica-video`
 * (Parte A, com o "pode publicar" do #11741), e desde o #12591 a mesma
 * sessão segue dali para a Etapa 5. O 2º caminho de upload que vivia aqui
 * (upload automático a partir do Drive, `--upload-from-final`, o hold do
 * marcador de confirmação pendente) foi a origem do #11297, do #12122 (a
 * 261104 subiu o horizontal antes do "pode publicar", com a capa
 * intermediária) e do #12287.
 *
 * A ordem montagem → vídeo → Etapa 5 é obrigatória (o link do YouTube entra
 * na edição). A decisão é a MESMA do pré-requisito do Passo 0b
 * (`assessVideoBeforePublish`, fonte única): este passo é a 2ª barreira,
 * mecânica, para o caso de o Passo 0b ter sido pulado (retomada direto no
 * playbook, passo esquecido).
 *
 * Uso: npx tsx scripts/stage5-youtube.ts AAMMDD --edition-dir DIR
 *
 * Exit 0 = pode seguir; exit 3 = sem o link (o playbook para antes do 5c-3);
 * exit 2 = uso inválido (inclui as flags do upload antigo).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { youtubeUploadEnabled, type PublishConsent } from "./lib/publish-consent.ts";
import { logEvent } from "./lib/run-log.ts";
import { D1_VIDEO_URL_FILE } from "./lib/diaria/d1-video-link.ts";
import { readD1VideoUrl } from "./lib/diaria/d1-video-link-file.ts";
import { assessVideoBeforePublish, PUBLISH_CONSENT_FILE, type VideoBeforePublishStatus } from "./lib/diaria/video-before-publish.ts";
import { describePendingApproval, readPendingApproval } from "./lib/diaria/youtube-pending-approval.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const YOUTUBE_STEP_FILE = "_internal/05-youtube-step.json";
export const EXIT_BLOCKED = 3;

/** Flags do passo antigo (upload), recusadas desde o #12588. */
export const REMOVED_FLAGS = ["upload-from-final", "ignore-pending-approval"] as const;

/**
 * Desfecho do registro. Registros de antes do #12588 em disco têm outros
 * valores (`uploaded`, `awaiting-link`, `awaiting-approval`, `fetch-error`,
 * `no-video`...); o único leitor (`checkYouTubeStepRan`) só confere a
 * existência do arquivo, então não há quem quebre.
 */
export type YouTubeStepOutcome =
  /** `05-video-url.txt` com link válido: o D1 sai com o vídeo. */
  | "already-published"
  /** `_internal/no-video.json` (#11125): edição sem vídeo, decisão do editor. */
  | "no-video-marked"
  /** `--skip youtube`/`none` sem link gravado: o D1 sai sem o vídeo. */
  | "consent-off"
  /** `05-video-url.txt` presente mas sem link do YouTube. */
  | "needs-editor"
  /** Nem link nem marcador nem `--skip youtube`. */
  | "missing-link";

export interface YouTubeStepRecord {
  aammdd: string;
  at: string;
  outcome: YouTubeStepOutcome;
  /** Só em `already-published`. */
  video_url?: string | null;
  /** O D1 sai com o link (= `already-published`). */
  d1_link: boolean;
  /** `true` = o passo saiu 3 e a Etapa 5 parou antes do dispatch social. */
  blocking: boolean;
  detail?: string;
}

const OUTCOME_BY_STATUS: Record<VideoBeforePublishStatus, YouTubeStepOutcome> = {
  "link-ready": "already-published",
  "no-video-marked": "no-video-marked",
  "skipped-by-consent": "consent-off",
  "invalid-link": "needs-editor",
  "video-without-link": "missing-link",
  "no-video": "missing-link",
};

const LEVEL_BY_OUTCOME: Record<YouTubeStepOutcome, "info" | "warn"> = {
  "already-published": "info",
  "no-video-marked": "info",
  "consent-off": "info",
  "needs-editor": "warn",
  "missing-link": "warn",
};

/** Puro: consentimento a partir do arquivo (ausente/ilegível → auto, como a chave ausente). */
export function consentAllowsYouTube(raw: string | null): { enabled: boolean; note?: string } {
  if (raw === null) return { enabled: true, note: "05-publish-consent.json ausente — tratado como auto" };
  try {
    return { enabled: youtubeUploadEnabled(JSON.parse(raw) as PublishConsent) };
  } catch (e) {
    return { enabled: true, note: `05-publish-consent.json ilegível (${(e as Error).message}) — tratado como auto` };
  }
}

/**
 * #11222/#11297: o link do D1 vem de `_internal/05-video-url.txt`, lido pelo
 * mesmo parse dos publishers do D1 (`parseD1VideoUrlFile`). Arquivo presente
 * com conteúdo que não é link do YouTube devolve `invalid`.
 */
export type PastedVideoUrl = { url: string } | { invalid: string } | null;

export function pastedVideoUrl(dir: string): PastedVideoUrl {
  const read = readD1VideoUrl(dir);
  if (read.url) return { url: read.url };
  if (read.warning) return { invalid: read.warning };
  return null;
}

/** O desfecho a partir da pasta (decisão de `assessVideoBeforePublish`). Nunca busca nem sobe. */
export function decideYouTubeStep(dir: string, aammdd: string, now: Date = new Date()): Omit<YouTubeStepRecord, "aammdd" | "at"> {
  const gate = assessVideoBeforePublish(dir, aammdd);
  const outcome = OUTCOME_BY_STATUS[gate.status];
  let detail = gate.warning ?? `link em ${D1_VIDEO_URL_FILE}`;
  if (outcome === "missing-link") {
    const pending = readPendingApproval(dir, aammdd);
    if (pending.kind !== "none") detail += ` Plano do horizontal à espera do "pode publicar": ${describePendingApproval(pending, aammdd, now)}`;
  }
  return {
    outcome,
    ...(gate.videoUrl ? { video_url: gate.videoUrl } : {}),
    d1_link: outcome === "already-published",
    blocking: gate.blocking,
    detail,
  };
}

/** Puro: nível do run-log. Sem o link (ou com link inválido) é `warn`. */
export function youtubeStepLevel(rec: Pick<YouTubeStepRecord, "outcome">): "info" | "warn" {
  return LEVEL_BY_OUTCOME[rec.outcome] ?? "warn";
}

async function main(): Promise<number> {
  const { values, positional, flags } = parseArgs(process.argv.slice(2));
  for (const f of REMOVED_FLAGS) {
    // `parseArgs` põe `--flag valor` em `values`, então conferir os dois.
    if (flags.has(f) || f in values) {
      console.error(
        `stage5-youtube: --${f} foi removida (#12588): a Etapa 5 não sobe mais vídeo. ` +
          `O horizontal sobe pelo /diaria-publica-video (Parte A, com o "pode publicar").`,
      );
      return 2;
    }
  }
  const aammdd = values["edition"] ?? positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error("uso: stage5-youtube.ts AAMMDD --edition-dir DIR");
    return 2;
  }
  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  const consentPath = join(dir, PUBLISH_CONSENT_FILE);
  const consent = consentAllowsYouTube(existsSync(consentPath) ? readFileSync(consentPath, "utf8") : null);
  if (consent.note) console.error(`[premissa] ${consent.note}`);

  const full: YouTubeStepRecord = { aammdd, at: new Date().toISOString(), ...decideYouTubeStep(dir, aammdd) };
  if (full.blocking) console.error(`[halt] YouTube: ${full.detail}`);
  else if (youtubeStepLevel(full) === "warn") console.error(`[aviso] YouTube: ${full.detail}`);
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileAtomic(join(dir, YOUTUBE_STEP_FILE), JSON.stringify(full, null, 2) + "\n");
  } catch (e) {
    console.error(`[aviso] ${YOUTUBE_STEP_FILE} não gravado: ${(e as Error).message}`);
  }
  logEvent(
    {
      edition: aammdd,
      stage: 5,
      agent: "orchestrator",
      level: youtubeStepLevel(full),
      message: `youtube: ${full.outcome}, link no D1 ${full.d1_link ? "sim" : "não"}${full.blocking ? ", BLOQUEADO" : ""}`,
      details: full,
    },
    ROOT,
  );
  console.log(JSON.stringify(full, null, 2));
  return full.blocking ? EXIT_BLOCKED : 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("stage5-youtube:", e instanceof Error ? e.message : e) });
}
