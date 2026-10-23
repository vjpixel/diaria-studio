#!/usr/bin/env node
/**
 * scripts/video-d1-link-watch.ts (#10941, item 1)
 *
 * Entrypoint da task `Diaria-Video-D1-Link-Watch` (diária 06:05 BRT no `300`,
 * relê até 10:00). Lógica em `scripts/lib/diaria/video-d1-link-watch.ts`;
 * aqui só o wiring real (env, fetch, relógio, run-log, alarme).
 *
 * Uso:
 *   npx tsx scripts/video-d1-link-watch.ts                      # edição de hoje (BRT)
 *   npx tsx scripts/video-d1-link-watch.ts --edition 261023
 *   npx tsx scripts/video-d1-link-watch.ts --dry-run            # 1 leitura; não grava nem chama a Graph API
 *   npx tsx scripts/video-d1-link-watch.ts --deadline 10:00 --interval-min 5
 *   npx tsx scripts/video-d1-link-watch.ts --edition-dir DIR    # testes / edição fora do lugar
 *
 * Só LÊ o estado do vídeo no YouTube (`videos.list`) — nunca muda o escopo do
 * token nem chama `videos.update` (403 com o token de upload, decisão do
 * editor no briefing 261023 da #10941).
 *
 * Exit: 0 em `aplicado`/`sem-edicao`/`sem-video`/`nao-publicado` (este último
 * avisa o editor por `notifyEditor`); 1 em `credenciais-ausentes`/`conflito`
 * ou erro fatal, pra unit sair `failed`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { todayAammdd } from "./lib/continuo-plan-rotation.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadResolvedFacebookPages, DEFAULT_FACEBOOK_PAGE_SLUG } from "./lib/facebook-pages.ts";
import { logEvent } from "./lib/run-log.ts";
import { missingYouTubeCredentials } from "./lib/diaria/youtube-upload.ts";
import {
  VIDEO_D1_WATCH_DEADLINE_BRT,
  VIDEO_D1_WATCH_INTERVAL_MS,
  deadlineForEdition,
  runVideoD1LinkWatch,
  type FacebookTarget,
  type VideoD1WatchOutcome,
} from "./lib/diaria/video-d1-link-watch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[video-d1-link-watch]";

function resolveFacebookTarget(env: Record<string, string | undefined>, log: (m: string) => void): FacebookTarget | null {
  try {
    const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as unknown;
    const { pages, apiVersion } = loadResolvedFacebookPages(ROOT, config, env);
    const page = pages.find((p) => p.slug === DEFAULT_FACEBOOK_PAGE_SLUG);
    if (!page || page.missing.length > 0) {
      log(`facebook: sem credencial da página diar.ia.br (${page?.missing.join(", ") ?? "página ausente do config"}) — fica manual`);
      return null;
    }
    return { pageId: page.pageId, token: page.token, apiVersion };
  } catch (e) {
    log(`facebook: config inválido (${(e as Error).message}) — fica manual`);
    return null;
  }
}

/** Pure: corpo do aviso ao editor quando o vídeo não ficou público no prazo. */
export function buildNotPublishedAlarm(
  aammdd: string,
  outcome: Extract<VideoD1WatchOutcome, { status: "nao-publicado" }>,
): { subject: string; body: string } {
  return {
    subject: `[diar.ia.br] vídeo do D1 de ${aammdd} não ficou público até ${VIDEO_D1_WATCH_DEADLINE_BRT}`,
    body: [
      "Achado automático da task `Diaria-Video-D1-Link-Watch`",
      "(`scripts/video-d1-link-watch.ts`, #10941).",
      "",
      `Vídeo: ${outcome.videoUrl}`,
      `Último estado relido: ${outcome.lastState} (${outcome.attempts} leituras)`,
      "",
      "Sem a auditoria do YouTube API Services o upload pela API pode ficar",
      "privado. Publique no YouTube Studio e rode",
      `\`npx tsx scripts/video-d1-link-watch.ts --edition ${aammdd}\` — ele relê,`,
      "grava o link e aplica o plano nos posts do D1.",
    ].join("\n"),
  };
}

async function main(): Promise<void> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has("dry-run");
  loadProjectEnv(ROOT);
  const env = process.env;
  const log = (m: string) => console.log(`${LOG_PREFIX} ${m}`);

  const aammdd = values["edition"] ?? todayAammdd();
  if (!/^\d{6}$/.test(aammdd)) throw new Error(`--edition inválido: ${JSON.stringify(aammdd)}`);
  const deadline = deadlineForEdition(aammdd, values["deadline"] ?? VIDEO_D1_WATCH_DEADLINE_BRT);
  if (!deadline) throw new Error(`--deadline inválido: ${JSON.stringify(values["deadline"])}`);
  const intervalMin = values["interval-min"] ? Number(values["interval-min"]) : VIDEO_D1_WATCH_INTERVAL_MS / 60000;
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) throw new Error(`--interval-min inválido: ${values["interval-min"]}`);

  const missing = missingYouTubeCredentials(env);
  const outcome = await runVideoD1LinkWatch(
    {
      fetch: (url, init) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }),
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
    },
    {
      aammdd,
      editionDir: values["edition-dir"] ? resolve(values["edition-dir"]) : resolve(ROOT, editionDirFor(aammdd)),
      // Em dry-run uma leitura só: o prazo é agora.
      deadline: dryRun ? new Date() : deadline,
      intervalMs: intervalMin * 60000,
      youtubeCreds:
        missing.length > 0
          ? null
          : {
              clientId: (env.GOOGLE_CLIENT_ID ?? "").trim(),
              clientSecret: (env.GOOGLE_CLIENT_SECRET ?? "").trim(),
              refreshToken: (env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
              channelId: (env.YOUTUBE_CHANNEL_ID ?? "").trim(),
            },
      missingYoutubeCreds: missing,
      facebook: resolveFacebookTarget(env, log),
      dryRun,
    },
  );

  log(`${outcome.status} (${aammdd})${"detail" in outcome ? ` — ${outcome.detail}` : ""}`);
  if (outcome.status === "aplicado") {
    for (const p of outcome.pending) log(`PENDENTE ${p.destination} (${p.action}, ${p.status}): ${p.text ?? ""} — ${p.detail}`);
  }
  if (dryRun) return;

  const failed = outcome.status === "credenciais-ausentes" || outcome.status === "conflito";
  logEvent(
    {
      edition: aammdd,
      stage: null,
      agent: "video-d1-link-watch",
      level: failed ? "error" : outcome.status === "nao-publicado" ? "warn" : "info",
      message: `video-d1-link-watch: ${outcome.status}`,
      details: outcome,
    },
    ROOT,
  );

  if (outcome.status === "nao-publicado") {
    const { subject, body } = buildNotPublishedAlarm(aammdd, outcome);
    const res = await notifyEditor(
      { check: "video-d1-link-watch", fingerprint: aammdd, severity: "acao", subject, body },
      { cwd: ROOT },
    );
    if (res.issue?.action === "failed") throw new Error(`ensureAlarmIssue falhou: ${res.issue.error}`);
  }
  if (failed) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`${LOG_PREFIX} erro fatal:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
