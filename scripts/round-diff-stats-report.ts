#!/usr/bin/env npx tsx
/**
 * scripts/round-diff-stats-report.ts (#7113)
 *
 * Lê a série `round_diff_stats` persistida em `data/run-log.jsonl` (por
 * `measure-round-diff-stats.ts`), agrega nas janelas 7d/30d/90d e imprime a
 * tabela markdown pronta pra colar no relatório de fim de rodada — mesma
 * proeminência que a seção de issues fechadas (#7113 escopo item 3), mesmo
 * padrão de `check-overnight-token-instrumentation.ts` (output colado
 * verbatim na seção do relatório).
 *
 * `--check-alarm`: também avalia a razão da janela de 7 dias contra o
 * limiar (`ROUND_DIFF_RATIO_ALARM_THRESHOLD`, hoje 10:1) e, se cruzado,
 * reconcilia uma issue de alarme via `scripts/lib/alarm-issues.ts` — o
 * MESMO mecanismo genérico usado pelos demais alarmes da camada
 * (`home-meta-check.ts` e afins), não um banner solto (#7113 escopo item
 * 4). `--dry-run` planeja e imprime sem chamar `gh`.
 *
 * Fail-soft (#738): `data/run-log.jsonl` ausente (sessão nova, clone
 * fresco, ainda nenhuma rodada mediu) não é erro — imprime "sem dados
 * suficientes" e sai 0. Dado do repo local (não depende de rede/API
 * externa), então uma leitura malformada é tratada como "0 eventos", nunca
 * como falha bloqueante.
 *
 * Uso:
 *   npx tsx scripts/round-diff-stats-report.ts
 *   npx tsx scripts/round-diff-stats-report.ts --check-alarm
 *   npx tsx scripts/round-diff-stats-report.ts --check-alarm --dry-run
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveRunLogPath } from "./lib/run-log.ts";
import {
  computeAllRoundDiffStatsWindows,
  evaluateRoundDiffAlarm,
  formatRoundDiffStatsReport,
  parseRoundDiffStatsEvents,
  ROUND_DIFF_RATIO_ALARM_THRESHOLD,
  type RoundDiffStatsRecord,
} from "./lib/round-diff-stats.ts";
import {
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  planAlarmReconciliation,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";
import { formatRatio } from "./lib/diff-line-stats.ts";

const LOG_PREFIX = "[round-diff-stats-report]";
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const ALARM_STATE_PATH = resolve(ROOT, "data", ".round-diff-stats-alarm-issues.json");
const ALARM_CHECK = "round-diff-ratio";
const ALARM_FINGERPRINT = "round-diff-ratio-7d-threshold";
/** Mesmo default usado pelos outros alarmes de "estado" do repo — 2
 * execuções limpas seguidas antes de fechar a issue sozinho. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/** Lê e parseia `data/run-log.jsonl` — fail-soft: arquivo ausente ou
 * ilegível vira lista vazia, nunca lança. */
export function readRoundDiffStatsRecords(rootDir: string = ROOT): RoundDiffStatsRecord[] {
  const logPath = resolveRunLogPath(rootDir);
  if (!existsSync(logPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const entries: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return parseRoundDiffStatsEvents(entries);
}

function loadAlarmState(statePath: string = ALARM_STATE_PATH): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch {
    return emptyAlarmIssuesState();
  }
}

function saveAlarmState(state: AlarmIssuesState, statePath: string = ALARM_STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

export function buildRoundDiffRatioFinding(ratio: number | null, added: number, netPerDay: number): AlarmFinding {
  const ratioLabel = formatRatio(ratio, added);
  return {
    check: ALARM_CHECK,
    fingerprint: ALARM_FINGERPRINT,
    title: `razão adição:remoção da janela de 7 dias cruzou o limiar (${ratioLabel})`,
    body:
      `A razão adição:remoção medida na janela dos últimos 7 dias (\`round_diff_stats\`, ` +
      `\`data/run-log.jsonl\`) é **${ratioLabel}** — igual ou acima do limiar de ` +
      `${ROUND_DIFF_RATIO_ALARM_THRESHOLD}:1 (líquido ~${Math.round(netPerDay).toLocaleString("pt-BR")} linhas/dia).\n\n` +
      `Fora de escopo desta issue (#7113): recusar PR, impor cota de remoção, bloquear rodada. ` +
      `Rodar \`npx tsx scripts/round-diff-stats-report.ts\` pra ver a série completa (7d/30d/90d) ` +
      `antes de decidir qualquer ação.`,
    family: "estado",
    labels: ["enhancement"],
    priority: "P2",
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const checkAlarm = hasFlag(argv, "check-alarm");
  const dryRun = hasFlag(argv, "dry-run");

  const records = readRoundDiffStatsRecords();
  if (records.length === 0) {
    console.log(`${LOG_PREFIX} sem dados suficientes — nenhum evento round_diff_stats em data/run-log.jsonl ainda.`);
    return;
  }

  const windows = computeAllRoundDiffStatsWindows(records);
  console.log(formatRoundDiffStatsReport(windows));

  if (!checkAlarm) return;

  const window7d = windows.find((w) => w.windowDays === 7)!;
  const evaluation = evaluateRoundDiffAlarm(window7d);
  if (!evaluation.alarming) {
    console.log(`${LOG_PREFIX} razão de 7d dentro do limiar (${ROUND_DIFF_RATIO_ALARM_THRESHOLD}:1) — sem alarme.`);
    return;
  }

  const finding = buildRoundDiffRatioFinding(window7d.ratio, window7d.added, window7d.netPerDay);
  console.warn(`${LOG_PREFIX} ALARME: razão de 7d cruzou o limiar (${formatRatio(window7d.ratio, window7d.added)}).`);

  const state = loadAlarmState();
  if (dryRun) {
    const actions = planAlarmReconciliation([finding], state, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(`${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas (${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`);
    return;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation([finding], state, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmState(nextState);
  for (const o of findingOutcomes) {
    if (o.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada: ${o.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${o.issueNumber} (${o.action}): ${o.url}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro inesperado: ${(e as Error).message}`);
    process.exit(1);
  });
}
