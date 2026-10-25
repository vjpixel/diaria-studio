/**
 * scripts/lib/retro-semanal-staleness-alarm.ts (#11069)
 *
 * Lógica PURA do alarme de staleness da retrospectiva semanal
 * (`/diaria-retro-semanal`, os dois carrosséis `highlights` de sábado e
 * `clicked` de domingo). Achado ao vivo na semana 261024: a skill só rodou
 * no sábado 24/10 às 23:12 BRT, o slot de sábado do carrossel `highlights`
 * foi perdido e nada avisou ("Esqueci de rodar antes"). Irmão direto do
 * `Diaria-LinkedIn-Weekly-Staleness-Alarm` (#5111,
 * `linkedin-weekly-staleness-alarm.ts`), mesmo molde: sensor + issue via
 * `alarm-issues.ts` + `notifyEditorForOutcomes`.
 *
 * **Estratégia:** dado `now`, resolve o sábado-âncora da semana
 * (`mostRecentSaturday` — o próprio dia quando roda no sábado) e procura
 * evidência de que o carrossel `highlights` desse sábado foi agendado:
 *
 *   1. **Store local** `data/weekly/{AAMMDD}/06-weekly-published.json`
 *      (escrito por `publish-weekly-social.ts --schedule`): alguma entrada
 *      `destaque: "weekly-highlights"` com status `scheduled`/`published`/
 *      `draft`. Entrada só `failed`/`skipped`/`deleted` não conta — a rodada
 *      existiu mas nada ficou agendado, o slot está igualmente perdido.
 *   2. **Fila do Worker** (`GET /list` do `diaria-linkedin-cron`), só quando
 *      o store local não tem evidência: algum item `destaque:
 *      "weekly-highlights"` com `scheduled_at` caindo nesse sábado (BRT).
 *      Existe porque `data/` replica por OneDrive — a skill pode ter rodado
 *      na máquina do editor e o store ainda não ter chegado na máquina que
 *      roda o alarme (`context/overnight-dispatch-rules.md` item 23:
 *      ausência de arquivo replicado não é prova de não-execução). O Worker
 *      é a fonte autoritativa do que está de fato na fila.
 *
 * Worker indisponível (sem credencial, rede, HTTP != 2xx) não vira `ok` —
 * o veredito segue o store local e o achado registra que o Worker não foi
 * consultado. Falso alarme aqui é barato (issue fecha sozinha); silêncio
 * sobre um slot perdido é exatamente o que a #11069 pede pra fechar.
 *
 * Só `highlights` decide o veredito: é o carrossel que publica no próprio
 * sábado, o slot em risco quando a task roda de manhã. O estado do
 * `clicked` (domingo) aparece no corpo como informação.
 */

import type { AlarmIssueResult } from "./alarm-issues.ts";

/** Modos do carrossel semanal — `destaque` gravado é `weekly-{modo}`. */
export type RetroSemanalMode = "highlights" | "clicked";

export const RETRO_SEMANAL_TIMEZONE = "America/Sao_Paulo";

/** Status de entrada do store que provam agendamento (ou publicação). */
const EVIDENCE_STATUSES = new Set(["scheduled", "published", "draft"]);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Pure: sábado-âncora da semana a partir de `now` (componentes de
 * calendário LOCAL, mesma convenção de `mostRecentContentMonday` do irmão).
 * Sábado → o próprio dia; domingo → ontem; segunda a sexta → o sábado
 * anterior (task atrasada por `Persistent=true` nunca aponta pra um sábado
 * futuro).
 */
export function mostRecentSaturday(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysSinceSaturday = (d.getDay() + 1) % 7; // sábado=6 → 0, domingo=0 → 1
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysSinceSaturday);
}

/** Pure: `Date` → `AAMMDD` (convenção de `data/weekly/{AAMMDD}/`). */
export function toAAMMDD(d: Date): string {
  return `${String(d.getFullYear()).slice(-2)}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** Pure: `AAMMDD` → `YYYY-MM-DD`. */
export function aammddToIsoDate(aammdd: string): string {
  if (!/^\d{6}$/.test(aammdd)) throw new Error(`AAMMDD inválido: ${aammdd}`);
  return `20${aammdd.slice(0, 2)}-${aammdd.slice(2, 4)}-${aammdd.slice(4, 6)}`;
}

/** Pure: data de calendário (YYYY-MM-DD) de um instante no fuso BRT. `null` se inválido. */
export function brtDateOf(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  // en-CA formata como YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: RETRO_SEMANAL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
}

interface StoreEntryLike {
  destaque?: unknown;
  status?: unknown;
}

/** Pure: o store local (`06-weekly-published.json` já parseado) tem evidência do modo? */
export function storeHasModeEvidence(published: unknown, mode: RetroSemanalMode): boolean {
  const posts = (published as { posts?: unknown } | null | undefined)?.posts;
  if (!Array.isArray(posts)) return false;
  const destaque = `weekly-${mode}`;
  return posts.some((p: StoreEntryLike) => {
    if (!p || typeof p !== "object") return false;
    return p.destaque === destaque && typeof p.status === "string" && EVIDENCE_STATUSES.has(p.status);
  });
}

interface WorkerItemLike {
  destaque?: unknown;
  scheduled_at?: unknown;
}

/**
 * Pure: algum item da fila do Worker é o carrossel `{mode}` agendado pro dia
 * `targetIsoDate` (YYYY-MM-DD, BRT)? `highlights` publica no próprio sábado;
 * `clicked`, no domingo — o caller passa a data certa de cada um.
 */
export function workerHasModeEvidence(
  items: readonly unknown[],
  mode: RetroSemanalMode,
  targetIsoDate: string,
): boolean {
  const destaque = `weekly-${mode}`;
  return items.some((raw) => {
    const it = raw as WorkerItemLike | null;
    if (!it || typeof it !== "object") return false;
    if (it.destaque !== destaque || typeof it.scheduled_at !== "string") return false;
    return brtDateOf(it.scheduled_at) === targetIsoDate;
  });
}

/** Pure: `YYYY-MM-DD` + N dias (aritmética de calendário, sem fuso). */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export type RetroSemanalEvidenceSource = "store" | "worker" | "none";

/**
 * Resultado da consulta ao Worker feita pelo caller: `null` = não consultado
 * (store local já bastou), `{ok: true, items}` = consultado, `{ok: false,
 * error}` = tentou e falhou (credencial ausente, rede, HTTP).
 */
export type RetroSemanalWorkerLookup =
  | null
  | { ok: true; items: readonly unknown[] }
  | { ok: false; error: string };

export type RetroSemanalStalenessVerdict = "ok" | "alarm-missing";

export interface RetroSemanalStalenessEvaluation {
  verdict: RetroSemanalStalenessVerdict;
  /** Sábado-âncora, `AAMMDD`. */
  saturday: string;
  /** De onde veio a evidência do `highlights` (`none` quando alarma). */
  highlightsSource: RetroSemanalEvidenceSource;
  /** Evidência do `clicked` (domingo) — informativo, não decide o veredito. */
  clickedSource: RetroSemanalEvidenceSource;
  /** Erro da consulta ao Worker, quando ela foi tentada e falhou. */
  workerError: string | null;
  /** `true` quando a fila do Worker foi de fato lida. */
  workerConsulted: boolean;
}

/**
 * Pure: combina store local + fila do Worker no veredito. `store` é o
 * `06-weekly-published.json` parseado (ou `null` se ausente/ilegível).
 */
export function evaluateRetroSemanalStalenessAlarm(
  saturday: string,
  store: unknown,
  worker: RetroSemanalWorkerLookup,
): RetroSemanalStalenessEvaluation {
  const satIso = aammddToIsoDate(saturday);
  const sunIso = addDaysIso(satIso, 1);
  const workerItems = worker && worker.ok ? worker.items : null;

  const sourceFor = (mode: RetroSemanalMode, dayIso: string): RetroSemanalEvidenceSource => {
    if (storeHasModeEvidence(store, mode)) return "store";
    if (workerItems && workerHasModeEvidence(workerItems, mode, dayIso)) return "worker";
    return "none";
  };

  const highlightsSource = sourceFor("highlights", satIso);
  return {
    verdict: highlightsSource === "none" ? "alarm-missing" : "ok",
    saturday,
    highlightsSource,
    clickedSource: sourceFor("clicked", sunIso),
    workerError: worker && !worker.ok ? worker.error : null,
    workerConsulted: workerItems !== null,
  };
}

/** Pure: precisa consultar o Worker? Só quando o store local não prova o `highlights`. */
export function needsWorkerLookup(store: unknown): boolean {
  return !storeHasModeEvidence(store, "highlights");
}

// ---------------------------------------------------------------------------
// Texto (issue + e-mail)
// ---------------------------------------------------------------------------

function describeSource(src: RetroSemanalEvidenceSource): string {
  if (src === "store") return "agendado (store local)";
  if (src === "worker") return "agendado (fila do Worker)";
  return "sem agendamento encontrado";
}

/** Pure: linhas de diagnóstico comuns ao corpo da issue e do e-mail. */
export function describeRetroSemanalEvaluation(e: RetroSemanalStalenessEvaluation): string[] {
  const workerLine = e.workerConsulted
    ? "Fila do Worker (`GET /list`): consultada."
    : e.workerError
      ? `Fila do Worker: NÃO consultada (${e.workerError}) — o veredito usou só o store local, que pode estar atrasado pela replicação do OneDrive.`
      : "Fila do Worker: não consultada (store local já bastou).";
  return [
    `- highlights (sábado ${aammddToIsoDate(e.saturday)}): ${describeSource(e.highlightsSource)}`,
    `- clicked (domingo ${addDaysIso(aammddToIsoDate(e.saturday), 1)}): ${describeSource(e.clickedSource)}`,
    `- ${workerLine}`,
  ];
}

export function buildRetroSemanalStalenessAlarmEmail(
  evaluation: RetroSemanalStalenessEvaluation,
  /** `{issueNumber, url, action, error}` de `applyAlarmReconciliation` (#5339). */
  issueRef?: AlarmIssueResult,
): { subject: string; body: string } {
  const { saturday } = evaluation;
  const issueLine = issueRef
    ? issueRef.action === "failed"
      ? `\n\nIssue: falha ao criar/reusar (${issueRef.error})`
      : `\n\nIssue: #${issueRef.issueNumber} (${issueRef.url})`
    : "";
  return {
    subject: `⚠️ Retro semanal: carrossel de sábado ${saturday} não foi agendado`,
    body:
      `A retrospectiva semanal (/diaria-retro-semanal) deveria ter agendado o carrossel "highlights" ` +
      `pra hoje, sábado ${aammddToIsoDate(saturday)}, e nada foi encontrado em ` +
      `data/weekly/${saturday}/06-weekly-published.json nem na fila do Worker.\n\n` +
      describeRetroSemanalEvaluation(evaluation).join("\n") +
      `\n\nRode agora: /diaria-retro-semanal ${saturday} (default --mode both). Se o horário do slot ` +
      `de sábado já tiver passado, o --check-slot da skill avisa antes de agendar.` +
      issueLine,
  };
}
