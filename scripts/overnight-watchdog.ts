#!/usr/bin/env npx tsx
/**
 * overnight-watchdog.ts (#2688)
 *
 * Watchdog EXTERNO para rodadas overnight. Detecta stall por tempo,
 * independente do coordenador (event-driven — não cobre silêncio total).
 *
 * Detecta rodada ativa:
 *   data/overnight/{AAMMDD}/plan.json existe E report.md ausente.
 *
 * Mede "última atividade" como max(mtime plan.json, último evento run-log
 * com agent:"overnight" para a edição desta rodada).
 *
 * Stall = "última atividade" > STALL_THRESHOLD_MIN (default 60) min atrás.
 *
 * Ação em caso de stall:
 *   (a) Append em stall_events no plan.json (com dedup por janela de 30 min)
 *   (b) Emite evento no run-log via scripts/log-event.ts
 *   (c) Renderiza halt banner via scripts/render-halt-banner.ts
 *   (d) Alert Telegram (opcional): se TELEGRAM_BOT_TOKEN + TELEGRAM_WATCHDOG_CHAT_ID
 *       estiverem definidos, envia mensagem diretamente via Bot API.
 *
 * Flags:
 *   --dry-run          Apenas diagnóstico; sem writes nem alertas.
 *   --threshold <min>  Override do limiar (default: 60 ou OVERNIGHT_WATCHDOG_STALL_MIN).
 *
 * GUARD DE PUBLICAÇÃO: este script é só observabilidade/alerta.
 * NUNCA toca Beehiiv/LinkedIn/Facebook/Brevo, PRs, nem merge.
 *
 * Deve ser agendado externamente (Windows Task Scheduler, cron) para rodar
 * a cada 10–15 min. Ver docs/overnight-watchdog-setup.md.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveRunLogPath } from "./lib/run-log.ts";
import { mtimeMs } from "./lib/mtime.ts";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";

// ---------------------------------------------------------------------------
// Pure / injectable helpers (exported for tests — #633)
// ---------------------------------------------------------------------------

export interface StallEvent {
  at: string;
  reason: string;
  resumed_at: string | null;
}

export interface PlanJson {
  started_at: string;
  stall_events: StallEvent[];
  [key: string]: unknown;
}

/**
 * Pure: detecta se houve stall dado os timestamps.
 * Injetar `nowMs` para testes determinísticos (sem depender de Date.now()).
 */
export function detectStall(
  lastActivityMs: number,
  nowMs: number,
  thresholdMin: number = 60,
): boolean {
  return nowMs - lastActivityMs >= thresholdMin * 60_000;
}

/**
 * Pure: dado mtime do plan.json e o último timestamp do run-log, retorna
 * a fonte-de-verdade canônica de "última atividade" (max de ambos).
 * null = fonte indisponível; trata como 0 (mais antigo possível).
 */
export function computeLastActivity(
  planMtimeMs: number | null,
  runLogLastTs: number | null,
): { ts: number; source: string } {
  const planMs = planMtimeMs ?? 0;
  const logMs = runLogLastTs ?? 0;

  if (planMs === 0 && logMs === 0) {
    return { ts: 0, source: "nenhuma" };
  }
  if (planMs >= logMs) {
    return { ts: planMs, source: "plan.json mtime" };
  }
  return { ts: logMs, source: "run-log" };
}

/**
 * Pure: verifica se já existe uma entrada de stall não-resolvida recente
 * (dentro da janela de dedup) para evitar spam de entradas repetidas.
 */
export function isDeduped(
  stallEvents: StallEvent[],
  dedupWindowMs: number,
  nowMs: number,
): boolean {
  if (!stallEvents || stallEvents.length === 0) return false;
  const last = stallEvents[stallEvents.length - 1];
  // Se o último stall já foi retomado, não é duplicata
  if (last.resumed_at) return false;
  const lastStallMs = new Date(last.at).getTime();
  return nowMs - lastStallMs < dedupWindowMs;
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

/**
 * Varre data/overnight/ e retorna a rodada ativa mais recente:
 * diretório com plan.json mas sem report.md.
 */
export function findActiveRun(rootDir: string): {
  aammdd: string;
  planPath: string;
  reportPath: string;
} | null {
  const overnightDir = join(rootDir, "data", "overnight");
  if (!existsSync(overnightDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(overnightDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{6}$/.test(d.name))
      .map((d) => d.name)
      .sort(); // lexicographic = cronológico para YYMMDD
  } catch {
    return null;
  }

  // Mais recente primeiro
  for (let i = entries.length - 1; i >= 0; i--) {
    const aammdd = entries[i];
    const dir = join(overnightDir, aammdd);
    const planPath = join(dir, "plan.json");
    const reportPath = join(dir, "report.md");

    if (existsSync(planPath) && !existsSync(reportPath)) {
      return { aammdd, planPath, reportPath };
    }
  }
  return null;
}

/**
 * Extrai o timestamp mais recente do run-log para a edição/agente overnight.
 */
export function getLastRunLogActivity(
  rootDir: string,
  aammdd: string,
): number | null {
  const logPath = resolveRunLogPath(rootDir);
  if (!existsSync(logPath)) return null;

  let content: string;
  try {
    content = readFileSync(logPath, "utf-8");
  } catch {
    return null;
  }

  let lastTs: number | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as {
        agent?: string;
        edition?: string;
        timestamp?: string;
      };
      if (
        event.agent === "overnight" &&
        event.edition === aammdd &&
        event.timestamp
      ) {
        const ts = new Date(event.timestamp).getTime();
        if (!isNaN(ts) && (lastTs === null || ts > lastTs)) {
          lastTs = ts;
        }
      }
    } catch {
      // linha malformada — ignorar
    }
  }
  return lastTs;
}

// ---------------------------------------------------------------------------
// Alert channels
// ---------------------------------------------------------------------------

async function sendTelegramAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_WATCHDOG_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      process.stderr.write(
        `[watchdog] Telegram alert falhou ${resp.status}: ${body.slice(0, 200)}\n`,
      );
    }
  } catch (e) {
    process.stderr.write(`[watchdog] Telegram alert erro: ${String(e)}\n`);
  }
}

function renderHaltBanner(
  rootDir: string,
  aammdd: string,
  elapsedMin: number,
  thresholdMin: number,
): void {
  const haltScript = resolve(rootDir, "scripts", "render-halt-banner.ts");
  if (!existsSync(haltScript)) {
    process.stdout.write(
      `\n=== OVERNIGHT WATCHDOG: STALL DETECTADO ===\n` +
        `Rodada ${aammdd} sem atividade há ${elapsedMin} min (limiar: ${thresholdMin} min).\n` +
        `Verifique a sessão overnight e responda 'retry' pra retomar ou 'abort' pra encerrar.\n` +
        `=========================================\n`,
    );
    return;
  }

  try {
    const out = execFileSync(
      "npx",
      [
        "tsx",
        haltScript,
        "--stage",
        `overnight — rodada ${aammdd}`,
        "--reason",
        `stall detectado pelo watchdog externo: ${elapsedMin} min sem atividade (limiar ${thresholdMin} min)`,
        "--action",
        `verifique a sessão overnight no terminal; responda 'retry' pra retomar ou 'abort' pra encerrar`,
      ],
      { cwd: rootDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    process.stdout.write(out);
  } catch (e: unknown) {
    // Se render-halt-banner falhou, mostra fallback inline
    const err = e as { stdout?: string };
    process.stdout.write(
      err.stdout ??
        `[watchdog] STALL: rodada ${aammdd}, ${elapsedMin} min sem atividade.\n`,
    );
  }
}

function emitRunLogEvent(
  rootDir: string,
  aammdd: string,
  elapsedMin: number,
  lastSource: string,
): void {
  const logScript = resolve(rootDir, "scripts", "log-event.ts");
  if (!existsSync(logScript)) return;

  try {
    execFileSync(
      "npx",
      [
        "tsx",
        logScript,
        "--edition",
        aammdd,
        "--agent",
        "overnight",
        "--level",
        "warn",
        "--message",
        "stall_detected",
        "--details",
        JSON.stringify({
          reason: "unknown",
          source: "overnight-watchdog",
          elapsed_min: elapsedMin,
          last_activity_source: lastSource,
        }),
      ],
      { cwd: rootDir, stdio: "pipe" },
    );
  } catch {
    process.stderr.write("[watchdog] Aviso: falha ao emitir evento no run-log.\n");
  }
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  dryRun: boolean;
  thresholdMin: number;
} {
  const { flags, values } = parseCliArgs(argv);
  const dryRun = flags.has("dry-run");
  let thresholdMin = parseInt(process.env.OVERNIGHT_WATCHDOG_STALL_MIN ?? "60", 10);
  if (isNaN(thresholdMin) || thresholdMin < 1) thresholdMin = 60;

  if (values.threshold) {
    const v = parseInt(values.threshold, 10);
    if (!isNaN(v) && v > 0) thresholdMin = v;
  }

  return { dryRun, thresholdMin };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export type WatchdogDiagnosisAction = "skip_unknown_activity" | "dry_run" | "no_stall" | "stall";

export interface WatchdogDiagnosis {
  action: WatchdogDiagnosisAction;
  lines: string[];
  /**
   * #2781: `elapsedMin` era recomputado de forma duplicada aqui dentro E em
   * `main()` (mesma fórmula, 2 lugares) — risco de re-divergir se um dos dois
   * mudar sem o outro (o mesmo padrão que motivou a extração original de
   * `diagnoseWatchdogActivity`, ver docstring acima). Agora `main()` reusa
   * este valor em vez de recalcular.
   */
  elapsedMin: number;
}

/**
 * #2715 item 5: decisão pura de diagnóstico, extraída de `main()` pra ser
 * testável sem depender de filesystem/subprocess.
 *
 * A ordem dos guards importa: `lastActivityMs === 0` (mtime indisponível —
 * ex: race de write/stat no Windows) tem que ser checado ANTES do ramo
 * `dryRun`, não depois. Antes do fix, o caminho `--dry-run` em `main()`
 * retornava cedo demais (era o PRIMEIRO branch) sem nunca passar pelo guard
 * de `lastActivityMs === 0` — então `detectStall(0, nowMs, ...)` calculava
 * "inatividade" a partir de epoch 1970 e SEMPRE reportava "STALL detectado"
 * com elapsed absurdo, mesmo numa rodada recém-iniciada sem timestamp ainda
 * disponível. O caminho normal (não-dry-run) já pulava esse falso positivo —
 * dry-run precisa do MESMO guard (não uma cópia divergente que pode
 * re-regredir), daí a extração para uma única função compartilhada.
 */
export function diagnoseWatchdogActivity(params: {
  aammdd: string;
  dryRun: boolean;
  lastActivityMs: number;
  lastSource: string;
  nowMs: number;
  thresholdMin: number;
}): WatchdogDiagnosis {
  const { aammdd, dryRun, lastActivityMs, lastSource, nowMs, thresholdMin } = params;
  const elapsedMin = Math.round((nowMs - lastActivityMs) / 60_000);

  if (lastActivityMs === 0) {
    const prefix = dryRun ? "[watchdog] DRY-RUN — " : "[watchdog] ";
    const suffix = dryRun ? " (sem writes/alertas de qualquer forma em dry-run)" : "";
    return {
      action: "skip_unknown_activity",
      lines: [`${prefix}Rodada ativa ${aammdd} mas sem timestamp de atividade. Skipping${suffix}.`],
      elapsedMin,
    };
  }

  const isStall = detectStall(lastActivityMs, nowMs, thresholdMin);

  if (dryRun) {
    return {
      action: "dry_run",
      lines: [
        `[watchdog] DRY-RUN — rodada ativa: ${aammdd}`,
        `[watchdog] Última atividade: ${new Date(lastActivityMs).toISOString()} (fonte: ${lastSource})`,
        `[watchdog] Inatividade: ${elapsedMin} min (limiar: ${thresholdMin} min)`,
        `[watchdog] → ${isStall ? "STALL detectado" : "sem stall"} (dry-run, sem writes/alertas)`,
      ],
      elapsedMin,
    };
  }

  if (!isStall) {
    return {
      action: "no_stall",
      lines: [`[watchdog] Rodada ${aammdd} ativa, sem stall (${elapsedMin}/${thresholdMin} min).`],
      elapsedMin,
    };
  }

  return { action: "stall", lines: [], elapsedMin };
}

async function main(): Promise<void> {
  loadProjectEnv();

  const ROOT = resolve(process.cwd());
  const { dryRun, thresholdMin } = parseArgs(process.argv.slice(2));

  const active = findActiveRun(ROOT);

  if (!active) {
    console.log("[watchdog] Nenhuma rodada overnight ativa detectada.");
    return;
  }

  const { aammdd, planPath } = active;
  const nowMs = Date.now();
  const thresholdMs = thresholdMin * 60_000;

  const planMtime = mtimeMs(planPath);
  const logLastTs = getLastRunLogActivity(ROOT, aammdd);
  const { ts: lastActivityMs, source: lastSource } = computeLastActivity(
    planMtime,
    logLastTs,
  );

  const diagnosis = diagnoseWatchdogActivity({
    aammdd,
    dryRun,
    lastActivityMs,
    lastSource,
    nowMs,
    thresholdMin,
  });

  for (const line of diagnosis.lines) console.log(line);

  if (diagnosis.action !== "stall") return;

  // #2781: `elapsedMin` usado no bloco STALL abaixo (emitRunLogEvent,
  // renderHaltBanner, alerta Telegram) vem de `diagnosis.elapsedMin` — não é
  // recomputado aqui. Antes essa mesma fórmula existia duplicada em
  // `diagnoseWatchdogActivity` E em `main()`, com risco de os 2 valores
  // divergirem se um fosse alterado sem o outro.
  const { elapsedMin } = diagnosis;

  // --- STALL DETECTADO ---

  let plan: PlanJson;
  try {
    plan = JSON.parse(readFileSync(planPath, "utf-8")) as PlanJson;
  } catch {
    process.stderr.write(`[watchdog] Erro ao ler plan.json: ${planPath}\n`);
    return;
  }

  // Dedup: janela = metade do threshold (nunca menos de 15 min)
  const dedupWindowMs = Math.max(Math.floor(thresholdMs / 2), 15 * 60_000);
  if (isDeduped(plan.stall_events ?? [], dedupWindowMs, nowMs)) {
    console.log(
      `[watchdog] Stall já registrado recentemente (dedup ${
        dedupWindowMs / 60_000
      } min). Skipping.`,
    );
    return;
  }

  const stallEvent: StallEvent = {
    at: new Date(nowMs).toISOString(),
    reason: "unknown",
    resumed_at: null,
  };

  // (a) Append stall_events no plan.json
  plan.stall_events = [...(plan.stall_events ?? []), stallEvent];
  try {
    writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n", "utf-8");
  } catch {
    process.stderr.write(`[watchdog] Erro ao gravar stall_event em plan.json.\n`);
  }

  // (b) Emite evento no run-log
  emitRunLogEvent(ROOT, aammdd, elapsedMin, lastSource);

  // (c) Renderiza halt banner
  renderHaltBanner(ROOT, aammdd, elapsedMin, thresholdMin);

  // (d) Telegram (opcional — reusa TELEGRAM_BOT_TOKEN do .env.example)
  await sendTelegramAlert(
    [
      `*[Diar.ia overnight] STALL detectado*`,
      `Rodada \`${aammdd}\` sem atividade há *${elapsedMin} min* (limiar: ${thresholdMin} min).`,
      `Fonte: ${lastSource}.`,
      `Verifique a sessão overnight e responda 'retry' pra retomar ou 'abort' pra encerrar.`,
    ].join("\n"),
  );

  console.log(
    `[watchdog] Stall registrado: rodada ${aammdd} — ${elapsedMin} min sem atividade.`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`[watchdog] Erro fatal: ${String(e)}\n`);
  process.exit(1);
});
