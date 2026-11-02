/**
 * scripts/lib/diaria/corte-owner-watch.ts (#11911)
 *
 * Vigia dos destinos do CORTE AVULSO (`publish-shorts.ts --corte`,
 * `data/cortes/{slug}/`) que a API não agenda (`linkedin_profile`,
 * `threads_profile`, `instagram`) quando nenhum timer é dono deles.
 *
 * Com `publishing.shorts.corte_via_timer: false` (o default), quem publica
 * esses destinos é a re-execução que a skill agenda à mão (#11550). Ela não
 * alerta em falha e pode simplesmente não cobrir um destino: em 02/11/2026 o
 * corte "Você ainda trata a IA como máquina?" saiu em 6 de 7 canais, o Reels
 * nunca saiu e ninguém foi avisado. Os timers da edição (Instagram, LinkedIn e
 * Threads pessoais) rodavam no 300 de hora em hora e só registravam "dia sem
 * edição". Agora cada um deles, em toda execução, passa por aqui com o próprio
 * destino: corte com o destino ainda sem registro 3 h depois do horário (até
 * 48 h) vira alarme ao editor, uma vez por corte e destino.
 *
 * Com `corte_via_timer: true` o dono é o `Diaria-Shorts-Cortes`, que já alarma
 * `late` sozinho: aqui não alarma (seriam dois avisos do mesmo atraso). Esse
 * timer só publica (e só alarma `late`) o corte com o "pode publicar" do
 * editor gravado no `corte.json` (#11912); esta vigia ainda não olha o
 * marcador e alarma também o corte que só passou pelo dry-run.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { resolveEditionScheduledAt } from "../edition-scheduled-at.ts";
import { notifyEditor, type NotifyEditorDeps } from "../editor-notify.ts";
import { MAX_FIRE_LATENESS_MS } from "../linkedin-personal.ts";
import { publishConfirmSuffix } from "./publish-confirm.ts";
import { CORTE_SPEC_FILE, CORTE_TIMER_DESTINATIONS, CORTE_TIMER_TASK, corteBaseCommand, parseCorteSpec, type CorteSpec } from "./short-corte.ts";
import { loadShortsConfig, parseShortsPublishedFile } from "./short-video.ts";
import { readShortsRegistryRaws } from "./shorts-published-store.ts";
import { alarmDelivery, emailPending, nextAlarmState, parseAlarmState } from "./shorts-timer-alarm-state.ts";

/** Depois disto o corte não é mais olhado (mesmo horizonte do timer do corte). */
export const CORTE_WATCH_HORIZON_MS = 48 * 3_600_000;

/** Estado do alarme, por destino (cada timer grava só o próprio arquivo: sem corrida entre eles). */
export function corteWatchAlarmStateFile(destination: string): string {
  return `_internal/.shorts-corte-owner-alarm.${destination.replace(/[^a-z0-9_-]/gi, "_")}.json`;
}

/** Destinos do corte que a API não agenda e que o config liga. */
export function corteUnscheduledDestinations(config: unknown): string[] {
  const cfg = loadShortsConfig(config);
  const enabled: Record<string, boolean> = { linkedin_profile: cfg.linkedinProfile, threads_profile: cfg.threadsProfile, instagram: cfg.instagram };
  return CORTE_TIMER_DESTINATIONS.filter((d) => enabled[d] === true);
}

export interface CorteWatchInput {
  dir: string;
  spec: CorteSpec;
  /** Todos os arquivos do registro do corte (`readShortsRegistryRaws`). */
  registryRaws: ReadonlyArray<{ path: string; raw: string }>;
}

export interface CorteWatchFinding {
  dir: string;
  spec: CorteSpec;
  destination: string;
  reason: string;
}

/**
 * Puro: os cortes com `destination` sem registro e sem dono, passadas 3 h do
 * horário (até 48 h). Registro ilegível lança: nunca vira "faltando" (o
 * comando do alarme duplicaria o post) nem "registrado".
 */
export function findCortesWithoutOwner(input: { config: unknown; destination: string; cortes: readonly CorteWatchInput[]; now: Date }): CorteWatchFinding[] {
  const cfg = loadShortsConfig(input.config);
  if (cfg.corteViaTimer) return [];
  if (!corteUnscheduledDestinations(input.config).includes(input.destination)) return [];
  const out: CorteWatchFinding[] = [];
  for (const c of input.cortes) {
    const deltaMs = input.now.getTime() - Date.parse(resolveEditionScheduledAt(c.spec.date, c.spec.hhmm));
    if (!(deltaMs > MAX_FIRE_LATENESS_MS) || deltaMs > CORTE_WATCH_HORIZON_MS) continue;
    const done = c.registryRaws.some(({ path, raw }) => parseShortsPublishedFile(raw, c.spec.date, path).entries.some((e) => e.destination === input.destination));
    if (done) continue;
    out.push({
      dir: c.dir,
      spec: c.spec,
      destination: input.destination,
      reason:
        `${c.spec.hhmm} BRT de ${c.spec.date} passou há ${Math.round(deltaMs / 60_000)} min e ${input.destination} não está no registro do corte. ` +
        `Com publishing.shorts.corte_via_timer = false nenhum timer é dono deste destino: a re-execução agendada pela skill não cobriu, ou falhou sem avisar`,
    });
  }
  return out;
}

/** Puro: assunto e corpo do alarme. */
export function buildCorteWatchAlarm(f: CorteWatchFinding, checkTask: string): { subject: string; body: string } {
  const base = corteBaseCommand(f.spec.slug);
  const body = [
    `Achado automático da task \`${checkTask}\` (vigia dos cortes avulsos, \`scripts/lib/diaria/corte-owner-watch.ts\`, #11911).`,
    "",
    `Corte: "${f.spec.title}" (${f.spec.slug}), ${f.spec.hhmm} BRT de ${f.spec.date}. Destino: ${f.destination}.`,
    `Motivo: ${f.reason}.`,
    "",
    "Confira a conta antes de qualquer coisa (o post pode ter saído à mão sem registro).",
    `- Se o vídeo do corte está lá: registre com \`${base} --mark ${f.destination}=URL\`.`,
    `- Se não está e o post ainda deve sair: \`${base} --only ${f.destination} --publish --now ${publishConfirmSuffix(f.spec.date)}\` (no 300).`,
    `- Para os próximos cortes terem dono com alarme: armar a \`${CORTE_TIMER_TASK}\` no 300 e ligar \`publishing.shorts.corte_via_timer\`.`,
  ].join("\n");
  return { subject: `[diar.ia.br] Corte "${f.spec.slug}" não saiu no ${f.destination} e nenhum timer é dono`, body };
}

/** Lê as pastas de `cortesDir` com `corte.json`. Pasta sem `corte.json` não é corte; `corte.json` ilegível lança. */
export function readCortes(cortesDir: string): CorteWatchInput[] {
  if (!existsSync(cortesDir)) return [];
  return readdirSync(cortesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(cortesDir, d.name, CORTE_SPEC_FILE)))
    .map((d) => join(cortesDir, d.name))
    .sort()
    .map((dir) => {
      const specPath = join(dir, CORTE_SPEC_FILE);
      return { dir, spec: parseCorteSpec(readFileSync(specPath, "utf8"), specPath), registryRaws: readShortsRegistryRaws(dir) };
    });
}

export interface CorteWatchDeps {
  config: unknown;
  now: Date;
  /** `data/cortes` do repo. */
  cortesDir: string;
  notify: NotifyEditorDeps;
  /** Nome da task que roda a vigia (vai no corpo do alarme). */
  checkTask: string;
  log?: (line: string) => void;
}

/**
 * Vigia um destino: alarma cada corte sem dono, uma vez por corte e destino.
 * `true` = nada a avisar ou tudo entregue; `false` = algum alarme não saiu ou a
 * leitura falhou (o exit do timer reflete, e a próxima execução tenta de novo).
 * Nunca lança: a vigia não pode derrubar a publicação do timer da edição.
 */
export async function watchCortesWithoutOwner(destination: string, dryRun: boolean, deps: CorteWatchDeps): Promise<boolean> {
  const log = deps.log ?? ((l: string) => console.log(l));
  let findings: CorteWatchFinding[];
  try {
    findings = findCortesWithoutOwner({ config: deps.config, destination, cortes: readCortes(deps.cortesDir), now: deps.now });
  } catch (e) {
    log(`[corte-owner-watch] ${destination}: leitura dos cortes falhou — ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  let ok = true;
  for (const f of findings) {
    log(`[corte-owner-watch] ${f.spec.slug} ${destination}: ${f.reason}`);
    if (dryRun) continue;
    const statePath = join(f.dir, corteWatchAlarmStateFile(destination));
    const id = `${destination}:no-owner`;
    try {
      const stateRaw = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
      const state = parseAlarmState(stateRaw);
      if (state.alarmed.includes(id) && !state.emailPending.includes(id)) continue;
      const { subject, body } = buildCorteWatchAlarm(f, deps.checkTask);
      const res = await notifyEditor(
        { check: "shorts-corte-owner-watch", fingerprint: `${f.spec.slug}:${id}`, severity: "urgente", family: "evento", subject, body, forceEmail: emailPending(stateRaw, id) },
        deps.notify,
      );
      const delivery = alarmDelivery(res);
      const next = nextAlarmState(stateRaw, f.spec.date, id, delivery);
      if (next !== null) {
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileAtomic(statePath, next);
      }
      if (delivery.kind !== "delivered") {
        log(`[corte-owner-watch] ${f.spec.slug} ${destination}: alarme NÃO entregue — ${delivery.error}`);
        ok = false;
      }
    } catch (e) {
      log(`[corte-owner-watch] ${f.spec.slug} ${destination}: alarme falhou — ${e instanceof Error ? e.message : String(e)}`);
      ok = false;
    }
  }
  return ok;
}
