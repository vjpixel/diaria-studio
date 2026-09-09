#!/usr/bin/env npx tsx
/**
 * scripts/kit-subscriber-state-transition-alarm.ts (#7660)
 *
 * Alarme de transição de estado no Kit: dispara quando um assinante sai de
 * `active` para `complained`/`bounced`/`cancelled`/`inactive`. Compara o
 * snapshot anterior (`data/kit-sub-state/prev.json`) com o atual
 * (`current.json`), abre uma issue por assinante que transicionou, e roda o
 * snapshot atual por cima do anterior pra próxima execução.
 *
 * **Não toca o Kit.** Nenhuma chamada de escrita, nenhum envio: o alarme só
 * LÊ os dois snapshots do disco e abre issue. A recuperação (re-registro via
 * DOI para `complained`/`bounced`, reativação manual para `cancelled`/
 * `inactive`) é ação do editor, e o corpo da issue diz isso.
 *
 * Quem produz `current.json` é a sincronização de assinantes do Kit, não este
 * script — por isso `current.json` AUSENTE é erro duro (exit 1), nunca
 * no-op: um alarme que "roda ok" sem dado é pior que um alarme que não roda,
 * porque a task agendada fica verde enquanto ninguém está de olho. Já
 * `prev.json` ausente é legítimo (1ª execução): não há transição a detectar
 * contra o vazio, então grava a linha de base e sai.
 *
 * Uso:
 *   npx tsx scripts/kit-subscriber-state-transition-alarm.ts --dry-run
 *   npx tsx scripts/kit-subscriber-state-transition-alarm.ts
 *
 * Premissa registrada (#7660): `bounced` INCLUÍDO por default mais seguro
 * (`KIT_STATE_TRANSITION_ALARM_STATES`). Se o editor quiser separar, trocar
 * a constante em `scripts/lib/kit-subscriber-state-transition-alarm.ts`.
 *
 * @see scripts/lib/kit-subscriber-state-transition-alarm.ts (lógica pura)
 * @see scripts/lib/alarm-issues.ts (abertura/fechamento das issues)
 */
import { resolve, join } from "node:path";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { isMainModule } from "./lib/cli-args.ts";
import {
  detectKitStateTransitions,
  toStateTransitionAlarmFindings,
  shouldAlarmKitStateTransition,
  advanceKitStateTransitionAlarmState,
  emptyKitStateTransitionAlarmState,
  KIT_STATE_TRANSITION_ALARM_STATES,
  KIT_STATE_TRANSITION_FROM_STATE,
  type KitStateTransitionAlarmState,
  type KitStateTransitionSnapshotEntry,
} from "./lib/kit-subscriber-state-transition-alarm.ts";
import {
  applyAlarmReconciliation,
  planAlarmReconciliation,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  saveState,
} from "./lib/alarm-issues.ts";
import type { KitSubscriberSummary } from "./lib/kit-subscribers.ts";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const STATE_DIR = resolve(ROOT, "data", "kit-sub-state");
const PREV_PATH = join(STATE_DIR, "prev.json");
const CURRENT_PATH = join(STATE_DIR, "current.json");
const LATCH_PATH = join(STATE_DIR, ".transition-latch.json");
const ISSUES_STATE_PATH = join(STATE_DIR, ".alarm-issues.json");
const LOG = "[kit-subscriber-state-transition-alarm]";

/** `family: "evento"` nas findings — a issue não fecha sozinha, então este
 *  valor nunca chega a ser usado pra fechar nada. Existe porque
 *  `planAlarmReconciliation`/`applyAlarmReconciliation` o exigem. */
const CLOSE_AFTER_RUNS = 2;

function loadPrev(): KitStateTransitionSnapshotEntry[] {
  if (!existsSync(PREV_PATH)) return [];
  const raw: unknown = JSON.parse(readFileSync(PREV_PATH, "utf8"));
  return (Array.isArray(raw) ? raw : []) as KitStateTransitionSnapshotEntry[];
}

/** `null` = arquivo ausente, que é ERRO (ver docstring do módulo) — distinto
 *  de `[]`, que é "sincronizou e a base está vazia", estado válido. */
function loadCurrent(): KitSubscriberSummary[] | null {
  if (!existsSync(CURRENT_PATH)) return null;
  const raw: unknown = JSON.parse(readFileSync(CURRENT_PATH, "utf8"));
  return (Array.isArray(raw) ? raw : []) as KitSubscriberSummary[];
}

function loadLatch(): KitStateTransitionAlarmState {
  if (!existsSync(LATCH_PATH)) return emptyKitStateTransitionAlarmState();
  try {
    return JSON.parse(readFileSync(LATCH_PATH, "utf8")) as KitStateTransitionAlarmState;
  } catch {
    // Latch corrompido re-alarma (pior caso: 1 issue duplicada, que o
    // fingerprint de `alarm-issues` ainda deduplica) em vez de silenciar.
    return emptyKitStateTransitionAlarmState();
  }
}

/** Snapshot da rodada vira o `prev` da próxima — sem isso a MESMA transição
 *  seria redetectada para sempre, e o latch seria a única coisa segurando o
 *  alarme (ele re-arma quando o assinante volta a `active`, então não é
 *  garantia suficiente). */
function persistSnapshot(current: readonly KitSubscriberSummary[]): void {
  mkdirSync(STATE_DIR, { recursive: true });
  // `KitStateTransitionSnapshotEntry` guarda só `{id, state}` de propósito:
  // é o mínimo que `detectKitStateTransitions` precisa do lado ANTERIOR, e
  // e-mail/`apoio_nivel` vêm do snapshot ATUAL na hora de montar a issue.
  // Persistir o resto seria manter uma cópia de dado de assinante em disco
  // sem ninguém ler.
  const entries: KitStateTransitionSnapshotEntry[] = current.map((s) => ({ id: s.id, state: s.state }));
  writeFileSync(PREV_PATH, JSON.stringify(entries, null, 2), "utf8");
}

export function run(argv: readonly string[], now: Date = new Date()): number {
  const dry = argv.includes("--dry-run");
  console.log(
    `${LOG} dry=${dry} from=${KIT_STATE_TRANSITION_FROM_STATE} ` +
      `to=${KIT_STATE_TRANSITION_ALARM_STATES.join(",")}`,
  );

  const current = loadCurrent();
  if (current === null) {
    console.error(
      `${LOG} ERRO: ${CURRENT_PATH} não existe. Este alarme COMPARA snapshots — ` +
        `quem produz o atual é a sincronização de assinantes do Kit, não este script. ` +
        `Sem ele não há o que comparar, e sair 0 deixaria a task agendada verde sem ter checado nada (#7660).`,
    );
    return 1;
  }

  const prev = loadPrev();
  if (prev.length === 0) {
    console.log(`${LOG} sem snapshot anterior — gravando linha de base (${current.length} assinantes) e saindo.`);
    if (!dry) persistSnapshot(current);
    return 0;
  }

  const transitions = detectKitStateTransitions(prev, current, now);
  const latch = loadLatch();
  const novas = transitions.filter((t) => !latch.alertedSubscriberIds.includes(t.id));

  console.log(
    `${LOG} ${transitions.length} transição(ões) detectada(s), ${novas.length} ainda não alertada(s).`,
  );
  if (transitions.length > 0 && !shouldAlarmKitStateTransition(latch, transitions)) {
    console.log(`${LOG} todas já alertadas em execução anterior (latch) — sem reabrir issue.`);
  }

  const findings = toStateTransitionAlarmFindings(novas);
  const issuesState = loadAlarmIssuesState(ISSUES_STATE_PATH);

  if (dry) {
    const acoes = planAlarmReconciliation(findings, issuesState, CLOSE_AFTER_RUNS);
    console.log(`${LOG} --dry-run: ${acoes.length} ação(ões) — ${acoes.map((a) => a.kind).join(", ") || "nenhuma"}`);
    for (const t of novas) console.log(`${LOG} --dry-run: ${t.address} (id ${t.id}) ${t.fromState} → ${t.toState}`);
    return 0;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, issuesState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState, ISSUES_STATE_PATH);
  for (const o of findingOutcomes) {
    console.log(`${LOG} issue ${o.action}${o.issueNumber ? ` #${o.issueNumber}` : ""}${o.url ? ` ${o.url}` : ""}`);
  }

  // Latch e snapshot avançam DEPOIS das issues: se a abertura lançar, a
  // próxima execução redetecta e tenta de novo, em vez de perder a transição.
  const activeIds = current.filter((s) => s.state === KIT_STATE_TRANSITION_FROM_STATE).map((s) => s.id);
  saveState(advanceKitStateTransitionAlarmState(latch, transitions, activeIds, now), LATCH_PATH);
  persistSnapshot(current);
  return 0;
}

if (isMainModule(import.meta.url)) {
  // `process.exitCode`, nunca `process.exit()` — mesma disciplina dos outros
  // alarmes deste diretório.
  process.exitCode = run(process.argv.slice(2));
}
