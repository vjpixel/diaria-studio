#!/usr/bin/env node
/**
 * scripts/ads-kill-switch-alarm.ts (#5239)
 *
 * Kill switch por custo das campanhas de anúncio pagas do teste de 3
 * canais (#5524) — detecta degradação RELATIVA de custo por leitor (contra
 * a própria história do braço, ou contra os outros braços da mesma
 * rodada; ver `scripts/lib/ads-kill-switch.ts` pro desenho completo, é o
 * comentário do editor de 21/08/2026 na issue que manda). Lógica pura em
 * `scripts/lib/ads-kill-switch.ts` — este arquivo é só I/O: ler
 * `run-state.json`/`clicks-2608.csv` (reusa `parseClicksCsv`, mesmo
 * arquivo reconciliado manualmente pelo editor pro `Diaria-Ads-Test-Watch`,
 * §8.3), enviar e-mail, registrar o evento de pausa (tentada ou pulada) num
 * log auditável.
 *
 * **NÃO é uma task agendada.** Deliberadamente NÃO wired em
 * `Diaria-Ads-Test-Watch` (`scripts/ads-test-watch.ts`) nem registrado em
 * `scripts/lib/scheduled-tasks.ts` — a issue #5239 separa "escrever o
 * código" (agora, seguro por construção) de "RODAR"/"decidir a pausa"
 * (bloqueado pelo marcador `<!-- aguardando-ate: 2026-09-08 -->` até os 3
 * canais terem tempo de assentar). Armar isto pra rodar automaticamente é
 * decisão FUTURA do editor — até lá, invocação é manual
 * (`--dry-run` primeiro, sempre).
 *
 * **NUNCA chama nenhuma API paga (Meta/Google/Microsoft/LinkedIn Ads) ao
 * vivo** — o único executor de pausa exportado por `ads-kill-switch.ts`
 * (`notWiredPauseExecutor`) nunca faz nenhuma chamada de rede, mesmo com
 * `--execute-pause` + kill switch ligado (ver docstring daquele módulo).
 *
 * Uso:
 *   npx tsx scripts/ads-kill-switch-alarm.ts --dry-run
 *     # avalia + imprime o que faria, não envia e-mail nem grava nada
 *   npx tsx scripts/ads-kill-switch-alarm.ts
 *     # avalia + envia alarme (se houver achado) — NUNCA tenta pausa sem
 *     # as duas travas: `npx tsx scripts/lib/ads-kill-switch-enabled.ts --set enabled`
 *     # E a flag abaixo na MESMA invocação
 *   npx tsx scripts/ads-kill-switch-alarm.ts --execute-pause
 *     # só tenta pausa se o toggle acima também estiver ligado; o executor
 *     # default segue nunca tocando API real de qualquer forma
 *   npx tsx scripts/ads-kill-switch-alarm.ts --as-of-date 2026-09-10 --to email@x
 *
 * Guard: se o junction `data/` (OneDrive) não estiver montado, aborta
 * graciosamente (exit 0) — mesmo padrão de `ads-test-watch.ts`.
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { sendGmailMessage, type GmailSendResult } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { detectExecMode } from "./lib/exec-mode.ts";
import { addDays } from "./lib/ads-test-schedule.ts";
import { assertValidRunState, type AdsTestRunState } from "./lib/ads-test-run-state.ts";
import { parseClicksCsv } from "./lib/ads-test-watch.ts";
import { DEFAULT_RUN_STATE_PATH, DEFAULT_CLICKS_CSV_PATH } from "./ads-test-watch.ts";
import {
  buildArmCostSamplesFromRows,
  evaluateKillSwitchRound,
  buildKillSwitchAlarmEmail,
  recordAttemptedPauseEvent,
  recordSkippedPauseEvent,
  notWiredPauseExecutor,
  DEFAULT_KILL_SWITCH_GUARDRAILS,
  type KillSwitchGuardrails,
  type PauseExecutor,
  type PauseEvent,
} from "./lib/ads-kill-switch.ts";
import { isAdsKillSwitchEnabled } from "./lib/ads-kill-switch-enabled.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
export const DEFAULT_PAUSE_EVENTS_LOG_PATH = resolve(ROOT, "data/aquisicao/kill-switch/pause-events.jsonl");
const LOG_PREFIX = "[ads-kill-switch-alarm]";

export interface AdsKillSwitchAlarmDeps {
  runStatePath: string;
  clicksCsvPath: string;
  pauseEventsLogPath: string;
  guardrails: KillSwitchGuardrails;
  now: () => Date;
  /** Toggle persistido (`scripts/lib/ads-kill-switch-enabled.ts`) — 1ª das
   *  2 travas obrigatórias antes de qualquer tentativa de pausa. */
  isKillSwitchEnabled: () => boolean;
  pauseExecutor: PauseExecutor;
  sendEmail: (to: string, subject: string, body: string) => Promise<GmailSendResult>;
  appendPauseEvent: (event: PauseEvent, path: string) => void;
  /** Injetável só pra teste — em produção sempre `detectExecMode`. */
  execMode: () => "local" | "cloud";
}

function realAppendPauseEvent(event: PauseEvent, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
}

function defaultDeps(argv: string[]): AdsKillSwitchAlarmDeps {
  return {
    runStatePath: getArg(argv, "run-state-path") || DEFAULT_RUN_STATE_PATH,
    clicksCsvPath: getArg(argv, "clicks-csv-path") || DEFAULT_CLICKS_CSV_PATH,
    pauseEventsLogPath: getArg(argv, "pause-events-log-path") || DEFAULT_PAUSE_EVENTS_LOG_PATH,
    guardrails: DEFAULT_KILL_SWITCH_GUARDRAILS,
    now: () => new Date(),
    isKillSwitchEnabled: () => isAdsKillSwitchEnabled(ROOT),
    pauseExecutor: notWiredPauseExecutor,
    sendEmail: sendGmailMessage,
    appendPauseEvent: realAppendPauseEvent,
    execMode: () => detectExecMode({ projectRoot: ROOT }),
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  depsOverride: Partial<AdsKillSwitchAlarmDeps> = {},
): Promise<void> {
  loadProjectEnv(ROOT);

  const isDryRun = hasFlag(argv, "dry-run");
  // 2ª das 2 travas obrigatórias (junto com o toggle persistido acima) —
  // por invocação, nunca implícita. Ver "Kill switch do próprio kill
  // switch" na docstring de scripts/lib/ads-kill-switch-enabled.ts.
  const executePauseFlag = hasFlag(argv, "execute-pause");
  const toOverride = getArg(argv, "to");
  const deps: AdsKillSwitchAlarmDeps = { ...defaultDeps(argv), ...depsOverride };

  if (deps.execMode() === "cloud") {
    console.log(`${LOG_PREFIX} data/ ausente (modo cloud) — abortando graciosamente, nada a fazer.`);
    return;
  }

  if (!existsSync(deps.runStatePath)) {
    console.log(`${LOG_PREFIX} run-state.json ausente — teste de 3 canais ainda não acendeu, nada a avaliar.`);
    return;
  }
  let runState: AdsTestRunState;
  try {
    const raw = JSON.parse(readFileSync(deps.runStatePath, "utf8"));
    assertValidRunState(raw);
    runState = raw;
  } catch (e) {
    console.error(`${LOG_PREFIX} run-state.json corrompido/ilegível: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(deps.clicksCsvPath)) {
    console.log(`${LOG_PREFIX} clicks-2608.csv ausente — nada a avaliar ainda.`);
    return;
  }
  const csvContent = readFileSync(deps.clicksCsvPath, "utf8");
  if (!csvContent.trim()) {
    console.log(`${LOG_PREFIX} clicks-2608.csv vazio — nada a avaliar ainda.`);
    return;
  }

  let rows: ReturnType<typeof parseClicksCsv>["rows"];
  try {
    const parsed = parseClicksCsv(csvContent);
    rows = parsed.rows;
    for (const err of parsed.errors) console.error(`${LOG_PREFIX} clicks-2608.csv linha ${err.line}: ${err.reason}`);
  } catch (e) {
    console.error(`${LOG_PREFIX} falha ao ler/parsear clicks-2608.csv: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const now = deps.now();
  const nowDateStr = now.toISOString().slice(0, 10);
  // Mesma convenção de `checkClicksCoverage` (ads-test-watch.ts) — audita
  // ONTEM por default, nunca hoje: a linha de hoje ainda não fechou.
  // Override via --as-of-date pra reprocessar/testar uma data específica.
  const asOfDate = getStringArg(argv, "as-of-date") ?? addDays(nowDateStr, -1);

  const history = buildArmCostSamplesFromRows(rows);
  const evaluations = evaluateKillSwitchRound(history, runState.bracos, asOfDate, runState.d0, deps.guardrails);
  console.log(
    `${LOG_PREFIX} ${asOfDate} avaliações=${JSON.stringify(
      evaluations.map((e) => ({ braco: e.braco, evaluated: e.evaluated, skipReason: e.skipReason, triggered: e.triggered })),
    )}`,
  );

  const triggered = evaluations.filter((e) => e.triggered);
  if (triggered.length === 0) {
    console.log(`${LOG_PREFIX} nenhuma degradação detectada em ${asOfDate}.`);
    return;
  }

  const pauseExecutionEnabled = deps.isKillSwitchEnabled();
  const willAttemptPause = pauseExecutionEnabled && executePauseFlag;
  const nowIso = now.toISOString();

  for (const ev of triggered) {
    if (isDryRun) {
      console.log(
        `${LOG_PREFIX} --dry-run: braço "${ev.braco}" — ${
          willAttemptPause
            ? "pausa SERIA tentada (kill switch ligado + --execute-pause); o executor nunca chama API real"
            : `pausa NÃO seria tentada (kill switch ${pauseExecutionEnabled ? "ligado, mas --execute-pause ausente" : "desligado (default)"})`
        }`,
      );
      continue;
    }
    let event: PauseEvent;
    if (willAttemptPause) {
      const result = await deps.pauseExecutor(ev.braco, ev);
      event = recordAttemptedPauseEvent(ev, nowIso, result);
      console.log(`${LOG_PREFIX} pausa TENTADA pro braço "${ev.braco}": ok=${result.ok} — ${result.detail}`);
    } else {
      event = recordSkippedPauseEvent(ev, nowIso);
      console.log(
        `${LOG_PREFIX} pausa NÃO tentada pro braço "${ev.braco}" (kill switch ${pauseExecutionEnabled ? "ligado, mas --execute-pause ausente" : "desligado (default)"}).`,
      );
    }
    deps.appendPauseEvent(event, deps.pauseEventsLogPath);
  }

  // Alarme por e-mail SEMPRE que houver achado — independente de pausa ter
  // sido tentada, pulada, ou bem/mal sucedida (checklist da issue #5239).
  const { subject, body } = buildKillSwitchAlarmEmail(evaluations, pauseExecutionEnabled);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    return;
  }
  await deps.sendEmail(to, subject, body);
  console.log(`${LOG_PREFIX} e-mail enviado pra ${to}: "${subject}"`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
