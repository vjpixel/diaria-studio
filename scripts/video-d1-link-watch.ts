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

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { todayAammdd } from "./lib/continuo-plan-rotation.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadResolvedFacebookPages, DEFAULT_FACEBOOK_PAGE_SLUG } from "./lib/facebook-pages.ts";
import { logEvent } from "./lib/run-log.ts";
import { missingYouTubeCredentials } from "./lib/diaria/youtube-upload.ts";
import { readEditionVideoMeta } from "./lib/edition-video-meta.ts"; // #12080
import { siteVideoRepublishDecision } from "./lib/site-page-video-republish.ts"; // #12080
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

/** Comando que republica a página da edição (mesmo do §5b-site da Etapa 5). */
export function sitePageRepublishArgs(editionDir: string): string[] {
  return [
    "scripts/publish-edition-site-page.ts",
    "--edition-dir",
    editionDir,
    "--slug-from-d1",
    "--sitemap",
    "workers/site/public/sitemap.xml",
    "--no-wait-merge",
    // #12284: a task roda como unit systemd `Type=oneshot`; o waiter destacado
    // do publisher morreria com o cgroup no fim da task. Sem ele, quem espera
    // o merge é esta task, em foreground (`sitePageMergeWaiterArgs`).
    "--no-merge-waiter",
  ];
}

/** #12284: o waiter do publisher (`--merge-pr`), rodado em foreground pela task. */
export function sitePageMergeWaiterArgs(editionDir: string, prNumber: number): string[] {
  return ["scripts/publish-edition-site-page.ts", "--merge-pr", String(prNumber), "--edition-dir", editionDir];
}

export interface SitePageMergeOutcome {
  prNumber: number;
  merged: boolean;
  exitCode?: number | null;
}

export interface SitePageRepublishOutcome {
  ran: boolean;
  ok: boolean;
  reason: string;
  exitCode?: number | null;
  /** #12284: espera do merge do PR da página, quando o publisher não mergeou. */
  merge?: SitePageMergeOutcome;
}

/**
 * #12284: PR da página que o publisher abriu e não mergeou (CI pendente), lido
 * do state que ele acabou de gravar. `null` = nada a esperar (já mergeado, sem
 * PR, state ausente/ilegível).
 */
export function pendingSitePagePr(state: unknown): number | null {
  if (!state || typeof state !== "object") return null;
  const s = state as Record<string, unknown>;
  if (s.published !== true || s.merged === true) return null;
  const pr = s.prNumber;
  return typeof pr === "number" && Number.isInteger(pr) && pr > 0 ? pr : null;
}

/**
 * #12080: republica `diar.ia.br/p/{slug}` quando a página publicada não
 * embute o vídeo que acabou de ganhar URL. `spawn` injetável para teste.
 *
 * #12284: com o PR aberto e não mergeado, espera o merge AQUI, em foreground
 * (`--merge-pr`, até 35 min) — o waiter destacado não sobrevive ao fim do unit
 * oneshot. O waiter grava o desfecho no state e alerta o editor se não
 * mergear (#9616); a task só reflete o resultado no run-log.
 */
export function republishSitePageIfVideoMissing(
  editionDir: string,
  log: (m: string) => void,
  spawn: (args: string[]) => { status: number | null; error?: Error } = (args) =>
    spawnSync(process.execPath, ["--import", "tsx", ...args], { cwd: ROOT, stdio: "inherit" }),
): SitePageRepublishOutcome {
  const statePath = join(editionDir, "_internal", "site-page-published.json");
  let state: unknown = null;
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch (e) {
      const reason = `state da página ilegível (${(e as Error).message})`;
      log(`site: ${reason} — mantida`);
      return { ran: false, ok: false, reason };
    }
  }
  const videoUrl = readEditionVideoMeta(editionDir)?.videoUrl ?? null;
  const decision = siteVideoRepublishDecision(state, videoUrl);
  if (!decision.republish) {
    log(`site: ${decision.reason} — mantida`);
    return { ran: false, ok: true, reason: decision.reason };
  }
  log(`site: ${decision.reason} — republicando a página`);
  const res = spawn(sitePageRepublishArgs(editionDir));
  const ok = !res.error && res.status === 0;
  if (!ok) {
    log(`site: republicação falhou (${res.error?.message ?? `exit ${res.status}`})`);
    return { ran: true, ok, reason: decision.reason, exitCode: res.status };
  }

  let after: unknown = null;
  try {
    after = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (e) {
    log(`site: state da página ilegível depois da republicação (${(e as Error).message}) — merge não conferido`);
    return { ran: true, ok: false, reason: decision.reason, exitCode: res.status };
  }
  const prNumber = pendingSitePagePr(after);
  if (prNumber === null) return { ran: true, ok, reason: decision.reason, exitCode: res.status };

  log(`site: PR #${prNumber} da página ainda não mergeado — esperando o merge em foreground (#12284)`);
  const w = spawn(sitePageMergeWaiterArgs(editionDir, prNumber));
  const merged = !w.error && w.status === 0;
  if (!merged) log(`site: PR #${prNumber} não mergeou (${w.error?.message ?? `exit ${w.status}`}) — o waiter avisa o editor (#9616)`);
  return {
    ran: true,
    ok: merged,
    reason: decision.reason,
    exitCode: res.status,
    merge: { prNumber, merged, exitCode: w.status },
  };
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

  // #12080 (item 3): o vídeo ganhou URL depois de a página da edição sair →
  // republica a página (player no lugar do link do canal). Fail-soft: falha
  // aqui avisa e segue, nunca muda o desfecho da task.
  if (outcome.status === "aplicado") {
    const dir = values["edition-dir"] ? resolve(values["edition-dir"]) : resolve(ROOT, editionDirFor(aammdd));
    const site = republishSitePageIfVideoMissing(dir, log);
    logEvent(
      {
        edition: aammdd,
        stage: null,
        agent: "video-d1-link-watch",
        level: site.ok ? "info" : "warn",
        message: `video-d1-link-watch: página do site ${
          !site.ran ? "mantida" : site.ok ? "republicada" : site.merge ? `republicada, PR #${site.merge.prNumber} não mergeado` : "republicação falhou"
        }`,
        details: site,
      },
      ROOT,
    );
  }

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
