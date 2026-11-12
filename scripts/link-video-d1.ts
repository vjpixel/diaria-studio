#!/usr/bin/env node
/**
 * scripts/link-video-d1.ts (#10772)
 *
 * Link do vídeo do dia (YouTube) no post do D1: LinkedIn página (1º
 * comentário), X @diariabr (1º link do texto curto), Threads diar.ia.br
 * (texto curto) e Facebook diar.ia.br (linha no post) — decisão do editor de
 * 22/10/2026 no #10772.
 *
 * Uso:
 *   npx tsx scripts/link-video-d1.ts AAMMDD [--video-url URL] [--save]
 *     [--assume-public] [--no-podcast] [--no-linkedin-comment] [--no-refresh-status]
 *     [--edition-dir DIR] [--now ISO]
 *
 * O que faz:
 *   - valida e normaliza a URL (`https://youtu.be/{id}`). Sem `--video-url`,
 *     usa a `url` do registro do upload (`_internal/05-youtube-published.json`,
 *     `publish-youtube.ts --upload`);
 *   - recusa (exit 1, nada gravado) vídeo que o leitor não abre (#10858): se o
 *     registro do upload é deste vídeo e o estado relido é privado sem
 *     agendamento, indeterminado, ou agendado para depois do post do D1. Sem
 *     a auditoria do YouTube API Services, o agendado até o envio da
 *     newsletter do D1 (06:00 BRT, ou o `scheduled_at` do broadcast) grava com
 *     `[aviso]`, sem `--assume-public` (#11548); depois do envio, recusa. O
 *     estado do registro é o da releitura no upload — se o editor publicou à
 *     mão no Studio depois, `--assume-public` libera;
 *   - #12655 (A4): com registro do upload DESTE vídeo, relê antes o estado na
 *     API oficial autenticada (`videos.list?part=snippet,status`,
 *     `lib/diaria/youtube-link-refresh.ts`) e atualiza o registro só com id e
 *     canal conferidos; o gate decide pelo estado relido. Sem credencial,
 *     timeout ou resposta inconclusiva, o registro fica como estava (nunca
 *     vira público) e vale o fallback humano (`--assume-public` só depois de o
 *     editor conferir agora). `failed`/`rejected`/`deleted` relido recusa
 *     mesmo com `--assume-public`. `--no-refresh-status` pula a releitura;
 *     sob o test runner ela também é pulada (o `.env` do 300 tem o token real);
 *   - `--save` grava `_internal/05-video-url.txt`. Com o arquivo presente
 *     ANTES do Stage 5, `prep-twitter-posts.ts`, `publish-threads.ts` e
 *     `publish-facebook.ts` já põem o link no texto do D1 (X e Threads só se
 *     couber no limite do canal; se não couber, tiram as hashtags do fim antes
 *     de desistir, #11402). A newsletter também lê o arquivo (#10784):
 *     com ele presente quando o HTML é renderizado, a imagem do D1 aponta pro
 *     vídeo; sem ele, pro canal @diariabr (`lib/diaria/d1-video-hero.ts`) — o
 *     Kit re-renderiza no Stage 5, então gravar antes do envio basta;
 *   - imprime, por destino, o plano para os posts do D1 que JÁ foram
 *     agendados/publicados (`_internal/06-social-published.json`): editar o
 *     post agendado ou comentar/responder depois do disparo.
 *
 *   - com `--save`, apaga o marcador `_internal/05-youtube-pending-approval.json`
 *     (#12122: o vídeo está no canal) e põe o vídeo na playlist do podcast
 *     (#12085, `lib/diaria/youtube-podcast-pasted.ts`; idempotente e
 *     fail-soft, `--no-podcast` pula). É a única chamada à API daqui.
 *
 *   - com `--save`, põe o 1º comentário do D1 da página do LinkedIn (link do
 *     vídeo) na fila do Worker `diaria-linkedin-cron`, como página, pela API
 *     direta (#10983, `lib/diaria/linkedin-page-actions.ts`): D1 + 5 min, ou
 *     daqui a 1 min se o D1 já saiu. Sem os segredos da página no Worker
 *     (#8816) ou sem Worker nesta máquina, o comentário segue manual com aviso.
 *     Idempotente (chave por edição e vídeo); `--no-linkedin-comment` pula.
 *
 * Fora o podcast e o comentário do LinkedIn, nunca publica, edita nem comenta
 * nada: o resto do plano (editar o payload na fila do Worker / Buffer, comentar
 * no Facebook, responder no Threads e no X) segue pendente no #10772.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import {
  D1_VIDEO_URL_FILE,
  normalizeYouTubeVideoUrl,
  planD1VideoLink,
  type D1PostEntryLike,
  type D1VideoLinkStep,
} from "./lib/diaria/d1-video-link.ts";
import {
  buildD1VideoCommentPayload,
  enqueuePageAction,
  readD1LinkedInTextHint,
  type PageActionResult,
} from "./lib/diaria/linkedin-page-actions.ts";
import { postToWorkerQueue } from "./lib/worker-queue-client.ts";
import {
  d1SocialSlotAt,
  gateVideoLink,
  newsletterSendAt,
  readYouTubeRecordSummary,
  videoLinkRemedy,
} from "./lib/diaria/youtube-video-link-gate.ts";
import { YOUTUBE_API_PROJECT_AUDITED } from "./lib/diaria/youtube-video.ts";
import { YOUTUBE_PUBLISHED_FILE, defaultYouTubeUploadDeps } from "./lib/diaria/youtube-upload.ts";
import { addPastedVideoToPodcast, type PastedPodcastInput, type PastedPodcastOutcome } from "./lib/diaria/youtube-podcast-pasted.ts";
import { YOUTUBE_PENDING_APPROVAL_FILE, clearPendingApproval } from "./lib/diaria/youtube-pending-approval.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { isNodeTestContext } from "./lib/test-context-guard.ts";
import { refreshYouTubeRecordState, type RefreshOutcome } from "./lib/diaria/youtube-link-refresh.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** #12748: o config inteiro, para o horário do D1 já desviado do vertical (`d1SocialSlotAt`). */
function loadPlatformConfig(): { publishing?: { social?: Record<string, unknown> } } {
  return JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")) as {
    publishing?: { social?: Record<string, unknown> };
  };
}

function readPublishedEntries(dir: string): { entries: D1PostEntryLike[]; source: string | null } {
  for (const p of [join(dir, "_internal", "06-social-published.json"), join(dir, "06-social-published.json")]) {
    if (!existsSync(p)) continue;
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { posts?: unknown };
    if (!Array.isArray(parsed.posts)) throw new Error(`${p}: campo "posts" ausente ou não é lista`);
    return { entries: parsed.posts as D1PostEntryLike[], source: p };
  }
  return { entries: [], source: null };
}

/** Podcast do registro do upload (só para não repetir a chamada); ilegível = `null`. */
function recordPodcast(dir: string): PastedPodcastInput["recordPodcast"] {
  try {
    const raw = JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8")) as { podcast?: PastedPodcastInput["recordPodcast"] };
    return raw.podcast ?? null;
  } catch {
    return null;
  }
}

/**
 * #12085: o fallback do Studio também põe o horizontal no podcast. Pulado com
 * `--no-podcast` e sob o test runner (`NODE_TEST_CONTEXT`): os testes rodam o
 * `--save` de verdade, e no checkout do 300 o `.env` tem a credencial real.
 */
async function podcastForPastedLink(
  aammdd: string,
  dir: string,
  videoUrl: string,
  noPodcast: boolean,
): Promise<PastedPodcastOutcome | { kind: "skipped"; reason: string }> {
  if (noPodcast) {
    console.error("[info] --no-podcast: vídeo não adicionado ao podcast (#12085)");
    return { kind: "skipped", reason: "--no-podcast" };
  }
  if (isNodeTestContext()) return { kind: "skipped", reason: "test runner (NODE_TEST_CONTEXT)" };
  let config: unknown = null;
  let configError: string | undefined;
  try {
    config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  } catch (e) {
    configError = (e as Error).message;
  }
  loadProjectEnv(ROOT);
  return addPastedVideoToPodcast(defaultYouTubeUploadDeps, {
    aammdd,
    videoUrl,
    config,
    ...(configError ? { configError } : {}),
    env: process.env,
    recordPodcast: recordPodcast(dir),
    log: (l) => console.error(l),
  });
}

/**
 * #10983: com `--save`, o 1º comentário do D1 da página do LinkedIn vai pra
 * fila do Worker (comentário como página, API direta). Sem os segredos da
 * página no Worker (#8816) ou sem Worker nesta máquina, o passo segue manual
 * com aviso. Pulado com `--no-linkedin-comment` e sob o test runner (o `.env`
 * do 300 tem o token real do Worker).
 */
async function linkedInCommentForSave(
  aammdd: string,
  videoUrl: string,
  step: D1VideoLinkStep | undefined,
  skip: boolean,
  now: Date,
  editionDir: string,
): Promise<PageActionResult | { status: "skipped"; detail: string }> {
  if (skip) return { status: "skipped", detail: "--no-linkedin-comment" };
  if (!step || step.action !== "comment_after" || !step.text) {
    return { status: "skipped", detail: step ? `LinkedIn: ${step.action} (${step.reason})` : "sem passo do LinkedIn" };
  }
  if (!step.scheduled_at) return { status: "skipped", detail: "post do D1 do LinkedIn sem scheduled_at no registro — comentário manual" };
  if (isNodeTestContext()) return { status: "skipped", detail: "test runner (NODE_TEST_CONTEXT)" };
  loadProjectEnv(ROOT);
  const cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")) as {
    publishing?: { social?: { linkedin?: { cloudflare_worker_url?: string } } };
  };
  const workerUrl = process.env.DIARIA_LINKEDIN_CRON_URL ?? cfg.publishing?.social?.linkedin?.cloudflare_worker_url ?? "";
  const token = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  const payload = buildD1VideoCommentPayload({
    aammdd,
    videoUrl,
    text: step.text,
    d1ScheduledAt: step.scheduled_at,
    now,
    d1TextHint: readD1LinkedInTextHint(editionDir),
  });
  return enqueuePageAction(
    workerUrl && token ? (p) => postToWorkerQueue(workerUrl, token, p, 2, "link-video-d1") : null,
    payload,
  );
}

/**
 * #12655 (A4): relê o estado do vídeo do registro na API antes do gate.
 * Pulado com `--no-refresh-status` e sob o test runner (o `.env` do 300 tem a
 * credencial real); os testes cobrem a lógica com a API simulada.
 */
async function refreshStatusForLink(dir: string, videoUrl: string, skip: boolean): Promise<RefreshOutcome> {
  if (skip) return { kind: "skipped", reason: "--no-refresh-status" };
  if (isNodeTestContext()) return { kind: "skipped", reason: "test runner (NODE_TEST_CONTEXT)" };
  loadProjectEnv(ROOT);
  return refreshYouTubeRecordState({ editionDir: dir, videoUrl, env: process.env, deps: defaultYouTubeUploadDeps });
}

export interface LinkVideoD1Deps {
  /** Releitura do estado na API (A4). Default: `refreshStatusForLink`; o teste injeta a API simulada. */
  refreshStatus?: (dir: string, videoUrl: string, skip: boolean) => Promise<RefreshOutcome>;
}

export async function main(argv: string[] = process.argv.slice(2), deps: LinkVideoD1Deps = {}): Promise<number> {
  const { flags, values, positional } = parseArgs(argv);
  const aammdd = positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error(
      "uso: link-video-d1.ts AAMMDD [--video-url URL] [--save] [--assume-public] [--no-podcast] [--no-linkedin-comment] [--no-refresh-status] [--edition-dir DIR] [--now ISO]",
    );
    return 2;
  }
  const now = values["now"] ? new Date(values["now"]) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now inválido: ${JSON.stringify(values["now"])}`);

  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  if (!existsSync(dir)) {
    console.error(`link-video-d1: ${dir} não existe`);
    return 1;
  }

  // #10858: o registro do upload diz se o vídeo abre para o leitor.
  const recordBefore = readYouTubeRecordSummary(dir);
  const rawUrl = values["video-url"] ?? recordBefore?.url ?? null;
  if (!rawUrl) {
    console.error(
      `link-video-d1: sem --video-url e sem url no registro do upload (${recordBefore?.path ?? "_internal/05-youtube-published.json ausente"})`,
    );
    return 2;
  }
  const videoUrl = normalizeYouTubeVideoUrl(rawUrl);
  // #12655 (A4): estado relido na API oficial, no lugar do estado do momento do upload.
  const statusRefresh = await (deps.refreshStatus ?? refreshStatusForLink)(dir, videoUrl, flags.has("no-refresh-status"));
  if (statusRefresh.kind === "terminal") {
    const marker =
      statusRefresh.persisted === false
        ? ` O marcador terminal NÃO foi gravado no registro (${statusRefresh.persistError ?? "erro de escrita"}): não rode de novo com --no-refresh-status.`
        : " O registro do upload guarda o marcador terminal.";
    console.error(
      `link-video-d1: recusado — ${statusRefresh.reason} (releitura ${statusRefresh.at}). Link não gravado, nem com --assume-public: ` +
        `confira no YouTube Studio e suba de novo ou passe outro link (#12655).${marker}`,
    );
    return 1;
  }
  if (statusRefresh.kind === "refreshed") console.error(`[ok] estado relido na API: ${statusRefresh.state} (registro atualizado, #12655)`);
  else if (statusRefresh.kind === "inconclusive") console.error(`[aviso] releitura do estado inconclusiva: ${statusRefresh.reason} — o gate usa o estado gravado no upload`);
  const record = statusRefresh.kind === "refreshed" ? readYouTubeRecordSummary(dir) : recordBefore;
  // #11548: sem a auditoria, o vídeo agendado até o envio da newsletter do D1 passa com aviso.
  const send = newsletterSendAt(dir, aammdd);
  const gate = gateVideoLink({
    videoUrl,
    record,
    d1SlotAt: (() => {
      const cfg = loadPlatformConfig();
      return d1SocialSlotAt(aammdd, cfg.publishing?.social ?? null, cfg);
    })(),
    newsletterSendAt: send.at,
  });
  if (gate.warning) console.error(`[aviso] ${gate.warning} (envio do D1: ${send.source})`);
  if (!gate.ok && gate.terminal) {
    console.error(`link-video-d1: recusado — ${gate.reason}. Link não gravado, nem com --assume-public (#12655).`);
    return 1;
  }
  if (!gate.ok) {
    if (!flags.has("assume-public")) {
      // #10881 item 2: a mesma premissa de auditoria que o gate usou (o
      // `audit_blocked` do registro, senão a constante).
      const projectAudited = record?.auditBlocked == null ? YOUTUBE_API_PROJECT_AUDITED : !record.auditBlocked;
      console.error(
        `link-video-d1: recusado — ${gate.reason}. Link não gravado${statusRefresh.kind === "refreshed" ? " (o registro do upload guardou a releitura)" : ""}. ${videoLinkRemedy(projectAudited)} ` +
          "e rode de novo com --assume-public (#10858).",
      );
      return 1;
    }
    console.error(`[aviso] --assume-public: ${gate.reason} — seguindo porque o editor confirmou o vídeo público no Studio`);
  } else if (!gate.record_matched) {
    console.error(`[aviso] ${gate.reason}`);
  }

  const urlFile = join(dir, D1_VIDEO_URL_FILE);
  let podcast: PastedPodcastOutcome | { kind: "skipped"; reason: string } | null = null;
  if (flags.has("save")) {
    mkdirSync(dirname(urlFile), { recursive: true });
    writeFileSync(urlFile, `${videoUrl}\n`, "utf8");
    console.error(`[ok] ${urlFile} gravado — o Stage 5 põe o link no D1 de X, Threads e Facebook`);
    // #12122: o vídeo está no canal; a espera do "pode publicar" acabou.
    if (clearPendingApproval(dir, (l) => console.error(l))) console.error(`[ok] ${YOUTUBE_PENDING_APPROVAL_FILE} apagado (#12122)`);
    podcast = await podcastForPastedLink(aammdd, dir, videoUrl, flags.has("no-podcast"));
  }

  const { entries, source } = readPublishedEntries(dir);
  const steps = planD1VideoLink({ videoUrl, entries, now });
  let linkedinComment: Awaited<ReturnType<typeof linkedInCommentForSave>> | null = null;
  if (flags.has("save")) {
    linkedinComment = await linkedInCommentForSave(
      aammdd,
      videoUrl,
      steps.find((s) => s.destination === "linkedin"),
      flags.has("no-linkedin-comment"),
      now,
      dir,
    );
    if (linkedinComment.status === "queued") {
      console.error(`[ok] LinkedIn: 1º comentário do D1 na fila do Worker para ${linkedinComment.scheduled_at} (key ${linkedinComment.key}${linkedinComment.duplicate ? ", já estava na fila" : ""})`);
    } else if (linkedinComment.status === "already_fired") {
      console.error(`[ok] LinkedIn: ${linkedinComment.detail}`);
    } else if (linkedinComment.status !== "skipped" || !/test runner|--no-linkedin/.test(linkedinComment.detail)) {
      const extra = linkedinComment.status === "failed" && linkedinComment.ambiguous ? " — confira a fila do Worker (GET /list) antes de comentar à mão" : "";
      console.error(`[aviso] LinkedIn: comentário do D1 segue manual — ${linkedinComment.detail}${extra} (#10983)`);
    }
  }
  console.log(
    JSON.stringify(
      {
        dry_run: true,
        edition: aammdd,
        video_url: videoUrl,
        video_link_gate: gate,
        status_refresh: statusRefresh,
        video_url_file: flags.has("save") ? urlFile : existsSync(urlFile) ? urlFile : null,
        social_published: source,
        ...(podcast ? { podcast } : {}),
        ...(linkedinComment ? { linkedin_comment: linkedinComment } : {}),
        steps,
      },
      null,
      2,
    ),
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("link-video-d1:", e instanceof Error ? e.message : e) });
}
