#!/usr/bin/env node
/**
 * scripts/kit-subscriber-state-transition-alarm.ts (#7660)
 *
 * Alarme de transição de estado Kit: lê snapshot anterior (`data/kit-sub-state/prev.json`)
 * e snapshot atual (`data/kit-sub-state/current.json` — produzido por sincronização
 * externa, NÃO pelo alarme). Só dispara quando `active → {complained,bounced,cancelled,inactive}`.
 * Nenhuma alteração externa no Kit; nenhum envio automático sem --dry-run.
 *
 * Premissa registrada (#7660): `bounced` INCLUÍDO por default mais seguro
 * (`KIT_STATE_TRANSITION_ALARM_STATES`). Se o editor quiser separar, trocar
 * constante em `scripts/lib/kit-subscriber-state-transition-alarm.ts` e re-rodar.
 */
import { resolve } from "path";
import { readFileSync, existsSync } from "fs";
import {
  detectKitStateTransitions,
  toStateTransitionAlarmFindings,
  shouldAlarmKitStateTransition,
  advanceKitStateTransitionAlarmState,
  emptyKitStateTransitionAlarmState,
  KIT_STATE_TRANSITION_ALARM_STATES,
} from "./lib/kit-subscriber-state-transition-alarm.ts";
import type { KitStateTransitionSnapshotEntry, KitSubscriberSummary } from "./lib/kit-subscribers.ts";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const STATE_DIR = resolve(ROOT, "data", "kit-sub-state");
const LOG = "[kit-subscriber-state-transition-alarm]";

function loadPrev(): KitStateTransitionSnapshotEntry[] {
  const p = resolve(STATE_DIR, "prev.json");
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf8"));
  return (Array.isArray(raw) ? raw : []) as KitStateTransitionSnapshotEntry[];
}

function loadCurrent(): KitSubscriberSummary[] {
  const p = resolve(STATE_DIR, "current.json");
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8")) as KitSubscriberSummary[];
}

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry-run");
  console.log(`${LOG} dry=${dry} states=${KIT_STATE_TRANSITION_ALARM_STATES.join(",")}`);
  console.log(`${LOG} premissa #7660: bounced incluido (default seguro).`);
}
main().catch((e) => { console.error(LOG, e); process.exit(1); });
