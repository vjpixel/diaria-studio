/**
 * scripts/check-regen-home.ts (#9974)
 *
 * Watchdog da home das 06:00 BRT — entrypoint da task
 * `Diaria-Regen-Home-Watchdog` (diária 06:20 BRT no `300`). Lógica em
 * `scripts/lib/regen-home-watchdog.ts`; aqui só o wiring real (fetch, `gh`,
 * relógio, run-log, alarme).
 *
 * Uso:
 *   npx tsx scripts/check-regen-home.ts            # checa, dispara se faltar, alarma no prazo
 *   npx tsx scripts/check-regen-home.ts --dry-run  # só lê sitemap/home/runs; não dispara nem alarma
 *
 * Sai com exit 0 em `ok`/`sem-edicao`/`cannot-verify` (rede fora não é falso
 * alarme); exit 1 em `atrasada` (depois de alarmar), pra unit sair `failed`.
 */

import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
import { logEvent } from "./lib/run-log.ts";
import {
  REGEN_HOME_WATCHDOG_USER_AGENT,
  REGEN_HOME_WORKFLOW,
  HOME_URL,
  runRegenHomeWatchdog,
  type GhResult,
  type WatchdogDeps,
  type WatchdogOutcome,
} from "./lib/regen-home-watchdog.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[regen-home-watchdog]";

function realGh(args: string[]): Promise<GhResult> {
  return new Promise((res) => {
    execFile("gh", args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // `err.code` é o exit code numérico; string (ex: "ENOENT", gh ausente) → 1.
      const rawCode = (err as { code?: unknown } | null)?.code;
      const code = !err ? 0 : typeof rawCode === "number" ? rawCode : 1;
      res({ code, stdout: String(stdout), stderr: String(stderr || (err ? err.message : "")) });
    });
  });
}

async function realFetchText(url: string): Promise<string> {
  // Cache-buster: a leitura tem que ver o que o Worker serve AGORA, não uma
  // cópia de borda de antes do deploy (o apex preserva query string).
  const u = `${url}${url.includes("?") ? "&" : "?"}_watchdog=${Date.now()}`;
  const res = await fetch(u, {
    headers: { "user-agent": REGEN_HOME_WATCHDOG_USER_AGENT, "cache-control": "no-cache" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

/** gh que NÃO dispara nada: `workflow run` vira no-op logado. */
export function dryRunGh(gh: WatchdogDeps["gh"], log: (m: string) => void): WatchdogDeps["gh"] {
  return async (args) => {
    if (args[0] === "workflow" && args[1] === "run") {
      log(`--dry-run: NÃO disparei gh ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    return gh(args);
  };
}

function buildAlarm(outcome: Extract<WatchdogOutcome, { status: "atrasada" }>): { subject: string; body: string } {
  return {
    subject: `[diar.ia.br] home sem a edição de ${outcome.todayBrt} depois das 07:00 BRT`,
    body: [
      "Achado automático do watchdog `Diaria-Regen-Home-Watchdog`",
      "(`scripts/check-regen-home.ts`, #9974).",
      "",
      `Edição esperada na home: /p/${outcome.slug}`,
      `Home verificada: ${HOME_URL}`,
      `Disparo de ${REGEN_HOME_WORKFLOW} por este watchdog: ${outcome.dispatched ? "sim" : "não"}`,
      `Detalhe: ${outcome.detail}`,
      "",
      "O cron do `regen-home.yml` (schedule do GitHub Actions) costuma chegar",
      "horas atrasado. Conferir `gh run list --workflow regen-home.yml` e, se",
      "não houver run em andamento, disparar `gh workflow run regen-home.yml`.",
      "Se o run passou e a home continua sem a edição, olhar o job `deploy`.",
    ].join("\n"),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  loadProjectEnv();

  const log = (m: string) => console.log(`${LOG_PREFIX} ${m}`);
  const outcome = await runRegenHomeWatchdog({
    fetchText: realFetchText,
    gh: dryRun ? dryRunGh(realGh, log) : realGh,
    now: () => new Date(),
    // Em dry-run não espera: uma leitura só basta pra diagnóstico.
    sleep: dryRun ? async () => {} : (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  });

  const detail = "detail" in outcome ? ` — ${outcome.detail}` : "";
  log(`${outcome.status} (${outcome.todayBrt})${detail}`);
  if (dryRun) return;

  logEvent(
    {
      edition: null,
      stage: null,
      agent: "check-regen-home",
      level: outcome.status === "atrasada" ? "error" : outcome.status === "cannot-verify" ? "warn" : "info",
      message: `regen-home-watchdog: ${outcome.status}${detail}`,
      details: outcome,
    },
    ROOT,
  );

  if (outcome.status === "atrasada") {
    const { subject, body } = buildAlarm(outcome);
    // Fingerprint pelo DIA: cada dia atrasado é um achado próprio.
    const res = await notifyEditor(
      { check: "check-regen-home", fingerprint: outcome.todayBrt, severity: "acao", subject, body },
      { cwd: ROOT, emailTo: toOverride },
    );
    if (res.issue?.action === "failed") throw new Error(`ensureAlarmIssue falhou: ${res.issue.error}`);
    log(`alarme registrado (issue #${res.issue?.issueNumber ?? "?"}).`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`${LOG_PREFIX} erro fatal:`, error);
    process.exitCode = 1;
  });
}
