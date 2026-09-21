/**
 * scripts/lib/subscriber-state-snapshot.ts (#8552)
 *
 * O Kit não preserva o estado de CRIAÇÃO de um assinante — a linha em
 * `subscription` (`scripts/lib/diaria-subscribers-db.ts`) é sobrescrita a
 * cada reingestão (`ON CONFLICT DO UPDATE`), então nada no store responde
 * "esta pessoa nasceu `active` ou nasceu `inactive` e confirmou depois?".
 * Sem esse dado, `doi-confirmacao-dia` (`scripts/lib/metrics/registry.ts`)
 * nunca sai de `indeterminado` — e o escopo 1 da #8543 ("quem virou `active`
 * desde a última rodada") também não tem como ser resolvido sem alguma
 * memória do estado ANTERIOR.
 *
 * O caminho provável descrito na issue (#8552): um SNAPSHOT DIÁRIO de
 * `(id, state, created_at)` de todos os assinantes do Kit. Comparar dois
 * snapshots consecutivos deriva as transições de estado sem depender de o
 * Kit expor histórico algum — o histórico passa a existir aqui, gravado
 * localmente, dia a dia. `created_at` é imutável no Kit, então é seguro
 * gravar em qualquer snapshot e ler de qualquer um.
 *
 * ## Formato: 1 diretório por data, mesmo padrão de
 * `beehiiv-backup-snapshots.ts` (`data/beehiiv-backup/{YYYY-MM-DD}/`)
 *
 * `data/subscriber-state-snapshots/kit/{YYYY-MM-DD}/subscribers.jsonl` — um
 * dump COMPLETO do roster naquele dia, 1 linha JSON por assinante. Não é um
 * único arquivo que cresce por append (isso obrigaria reler o arquivo
 * inteiro pra saber "o que mudou desde ontem" e cresceria sem limite ao
 * longo dos anos) — é 1 arquivo NOVO por dia, imutável depois de escrito,
 * que é o sentido prático de "append-only" aqui: dias novos se ACRESCENTAM
 * como arquivos novos, nenhum dia existente é reescrito.
 *
 * ## Leitura aqui, escrita no CLI — mesmo padrão de `beehiiv-backup-snapshots.ts`
 *
 * Este módulo faz LEITURA de disco (`readSubscriberStateSnapshotFile`,
 * mesmo padrão fail-soft de `readSnapshotSubscribers`), mas nunca ESCRITA —
 * quem grava o snapshot de verdade (e faz a chamada de rede ao Kit) é
 * `scripts/subscriber-state-snapshot.ts` (o CLI). As funções de comparação/
 * derivação de cohort abaixo são puras (`@pure`), operando só sobre
 * snapshots já carregados em memória.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { REATIVAR_CONFIRMOU_VIA_FIELD_NAME } from "./shared/reativar-confirmou-via.ts";
import { KIT_ORIGEM_CADASTRO_FIELD_NAME } from "./shared/kit-signup-origin.ts";

/** Nome de diretório de snapshot: `YYYY-MM-DD` — mesmo regex de
 *  `beehiiv-backup-snapshots.ts`. */
const SNAPSHOT_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Subconjunto mínimo do Kit subscriber que este domínio precisa: os 3
 *  campos obrigatórios da issue #8552 (`(id, state, created_at)`, que NÃO
 *  dependem de custom field e portanto escapam da armadilha de `fields`
 *  defasado do endpoint de LISTA, ver `listAllKitSubscribers`) mais 2
 *  opcionais lidos de `fields` (`confirmou_via`, `origem`), usados só pelo
 *  relatório de confirmação — esses SIM sofrem o lag de `fields` e por isso
 *  o relatório lê o valor mais recente entre snapshots. Nunca `attribution`. */
export interface SubscriberStateRecord {
  id: number;
  state: string;
  /** ISO 8601 — imutável no Kit, seguro ler de qualquer snapshot. */
  created_at: string;
  /** #8552 (relatório de confirmação) — custom field `confirmou_via`
   *  (`REATIVAR_CONFIRMOU_VIA_FIELD_NAME`, #8438), OPCIONAL: ausente em
   *  snapshots antigos e em quem nunca clicou no botão da reativação. O
   *  field é escrito UMA vez, no instante da confirmação — o lag de
   *  `fields` no endpoint de lista só atrasa o aparecimento. */
  confirmou_via?: string;
  /** #8552 — custom field `origem_cadastro` (canal de entrada), OPCIONAL,
   *  mesma disciplina de `confirmou_via`. */
  origem?: string;
  /** #8552 (a) — `true` quando o id estava vinculado ao form DOI
   *  (`KIT_DOI_FORM_ID`, `GET /v4/forms/{id}/subscribers?status=all`) NO
   *  MOMENTO deste snapshot. Ausente = snapshot antigo / sem form configurado
   *  (cobertura desconhecida, NÃO "não vinculado"). */
  doi_form?: boolean;
}

/** Marca `doi_form: true` nos records cujo id está em `formIds`. Puro. */
export function markDoiFormMembership(
  records: readonly SubscriberStateRecord[],
  formIds: ReadonlySet<number>,
): SubscriberStateRecord[] {
  return records.map((r) => (formIds.has(r.id) ? { ...r, doi_form: true } : r));
}

/** Mapeia um subscriber do Kit pro record do snapshot (#8552). `fields`
 *  ausente/vazio ou campos vazios → só os 3 obrigatórios. Puro. */
export function toSubscriberStateRecord(s: {
  id: number;
  state: string;
  created_at: string;
  fields?: Record<string, string>;
}): SubscriberStateRecord {
  const rec: SubscriberStateRecord = { id: s.id, state: s.state, created_at: s.created_at };
  const via = s.fields?.[REATIVAR_CONFIRMOU_VIA_FIELD_NAME];
  const origem = s.fields?.[KIT_ORIGEM_CADASTRO_FIELD_NAME];
  if (via) rec.confirmou_via = via;
  if (origem) rec.origem = origem;
  return rec;
}

export interface SnapshotFieldCoverage {
  total: number;
  /** Subscribers com `fields` presente na resposta da lista. */
  comFields: number;
  comOrigem: number;
  comConfirmouVia: number;
}

/** Cobertura dos campos opcionais no roster — pra logar e detectar `fields`
 *  ausente em todos (resposta da lista sem custom fields). Puro. */
export function summarizeFieldCoverage(
  subs: readonly { fields?: Record<string, string> }[],
  records: readonly SubscriberStateRecord[],
): SnapshotFieldCoverage {
  return {
    total: records.length,
    comFields: subs.filter((s) => s.fields !== undefined).length,
    comOrigem: records.filter((r) => r.origem).length,
    comConfirmouVia: records.filter((r) => r.confirmou_via).length,
  };
}

export function snapshotRootDefault(dataRoot: string): string {
  return join(dataRoot, "subscriber-state-snapshots", "kit");
}

export function snapshotDirPath(root: string, date: string): string {
  return join(root, date);
}

export function snapshotJsonlPath(root: string, date: string): string {
  return join(root, date, "subscribers.jsonl");
}

/** Lista as datas de snapshot disponíveis sob `root`, ordem ASCENDENTE
 *  (mais antigo primeiro). `root` ausente retorna `[]` — mesmo fail-soft de
 *  `listSnapshotDates` em `beehiiv-backup-snapshots.ts`. */
export function listSubscriberStateSnapshotDates(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SNAPSHOT_DIR_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Serializa 1 record como 1 linha JSONL (com o `\n` final). @pure */
export function serializeSubscriberStateRecord(record: SubscriberStateRecord): string {
  return JSON.stringify(record) + "\n";
}

/** Serializa uma lista inteira de records — 1 chamada de write por
 *  snapshot, não 1 por linha. @pure */
export function serializeSubscriberStateRecords(records: readonly SubscriberStateRecord[]): string {
  return records.map(serializeSubscriberStateRecord).join("");
}

/** Parseia o conteúdo bruto de `subscribers.jsonl` — linhas vazias ou
 *  corrompidas são ignoradas, nunca lançam (mesmo padrão de
 *  `parseSubscribersJsonl`, `beehiiv-backup-snapshots.ts`). @pure */
export function parseSubscriberStateJsonl(content: string): SubscriberStateRecord[] {
  const out: SubscriberStateRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<SubscriberStateRecord>;
      if (
        typeof parsed.id === "number" &&
        typeof parsed.state === "string" &&
        typeof parsed.created_at === "string"
      ) {
        const rec: SubscriberStateRecord = { id: parsed.id, state: parsed.state, created_at: parsed.created_at };
        if (typeof parsed.confirmou_via === "string" && parsed.confirmou_via) rec.confirmou_via = parsed.confirmou_via;
        if (typeof parsed.origem === "string" && parsed.origem) rec.origem = parsed.origem;
        if (parsed.doi_form === true) rec.doi_form = true;
        out.push(rec);
      }
    } catch {
      continue; // linha corrompida — skip, resto do arquivo sobrevive
    }
  }
  return out;
}

/**
 * Lê e parsifica `subscribers.jsonl` de um snapshot. Arquivo/diretório
 * ausente retorna `[]` — mesmo fail-soft de `readSnapshotSubscribers`
 * (`beehiiv-backup-snapshots.ts`). Única função de LEITURA de disco deste
 * módulo — mantida aqui (e não no CLI) porque `check-metrics-health.ts`
 * (e qualquer outro leitor read-only) precisa dela sem reimplementar o
 * parse, e ela não é I/O de ESCRITA (a linha que separa este módulo do CLI,
 * ver docstring do topo).
 */
export function readSubscriberStateSnapshotFile(root: string, date: string): SubscriberStateRecord[] {
  const path = snapshotJsonlPath(root, date);
  if (!existsSync(path)) return [];
  return parseSubscriberStateJsonl(readFileSync(path, "utf8"));
}

/**
 * Carrega TODOS os snapshots sob `root` (ou só as `dates` pedidas, quando
 * informadas) num `Map<data, records>` pronto pra `buildDoiConfirmationCohort`.
 */
export function loadAllSubscriberStateSnapshots(
  root: string,
  dates?: readonly string[],
): Map<string, SubscriberStateRecord[]> {
  const wanted = dates ?? listSubscriberStateSnapshotDates(root);
  const out = new Map<string, SubscriberStateRecord[]>();
  for (const date of wanted) {
    out.set(date, readSubscriberStateSnapshotFile(root, date));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparação de 2 snapshots — o mecanismo que destrava #8543 escopo 1 e a
// cohort de confirmação DOI abaixo.
// ---------------------------------------------------------------------------

export interface SubscriberStateTransition {
  id: number;
  /** `null` quando o id não existia no snapshot anterior (assinante novo). */
  from: string | null;
  to: string;
  created_at: string;
}

/**
 * Compara dois snapshots consecutivos e devolve toda transição de estado
 * (inclusive "apareceu pela 1ª vez", `from: null`). Assinante presente em
 * `prev` e ausente em `curr` NÃO gera transição — o Kit não expõe DELETE de
 * subscriber (ver `unsubscribeKitSubscriber`), então "sumiu da lista" é
 * ambiguidade de paginação/filtro, não um estado real; ignorado de
 * propósito em vez de fabricar uma transição. @pure
 */
export function diffSubscriberStateSnapshots(
  prev: readonly SubscriberStateRecord[],
  curr: readonly SubscriberStateRecord[],
): SubscriberStateTransition[] {
  const prevById = new Map(prev.map((r) => [r.id, r]));
  const transitions: SubscriberStateTransition[] = [];
  for (const r of curr) {
    const p = prevById.get(r.id);
    if (!p || p.state !== r.state) {
      transitions.push({ id: r.id, from: p?.state ?? null, to: r.state, created_at: r.created_at });
    }
  }
  return transitions;
}

/**
 * Filtra as transições que viraram `active` desde o snapshot anterior — o
 * insumo direto do escopo 1 da #8543 ("quem virou `active` desde a última
 * rodada"). `from !== "active"` também cobre `from: null` (assinante novo já
 * nascendo `active`). @pure
 */
export function newlyActiveSince(transitions: readonly SubscriberStateTransition[]): SubscriberStateTransition[] {
  return transitions.filter((t) => t.to === "active" && t.from !== "active");
}

// ---------------------------------------------------------------------------
// Cohort de confirmação DOI — o insumo de `doi-confirmacao-dia`
// ---------------------------------------------------------------------------

/** Mesma fórmula de `brtDayKey` (`scripts/lib/metrics/acquisition-store-deps.ts`)
 *  — reimplementada aqui, não importada, pela mesma razão documentada lá:
 *  evitar acoplar este domínio a `metrics/` só por uma conversão de fuso de
 *  3 linhas. */
function brtDayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Soma horas a uma data-chave `AAAA-MM-DD`, devolvendo a data-chave (BRT)
 *  do instante resultante — usado pra achar o snapshot mais antigo que já
 *  cobre a maturação de N horas depois do dia da safra. @pure */
function addHoursToDateKey(dateKey: string, hours: number): string {
  const base = new Date(`${dateKey}T00:00:00-03:00`); // meia-noite BRT do dia da safra
  const shifted = new Date(base.getTime() + hours * 60 * 60 * 1000);
  return shifted.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Lê `{date}/doi-form-status.json` (ausente/corrompido = sem entrada). */
export function readDoiFormStatus(root: string, date: string): { ok: boolean } | null {
  try {
    const p = join(dirname(snapshotJsonlPath(root, date)), "doi-form-status.json");
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { ok?: unknown };
    return typeof parsed.ok === "boolean" ? { ok: parsed.ok } : null;
  } catch {
    return null;
  }
}

export function loadDoiFormStatuses(root: string, dates: readonly string[]): Map<string, { ok: boolean }> {
  const out = new Map<string, { ok: boolean }>();
  for (const d of dates) {
    const st = readDoiFormStatus(root, d);
    if (st) out.set(d, st);
  }
  return out;
}

export interface DoiConfirmationCohortMember {
  id: number;
  /** `true` quando o snapshot de maturação encontrou este id com
   *  `state === "active"`; `false` quando o id segue não-active (ou não
   *  reapareceu no snapshot de maturação, mesmo padrão fail-soft de
   *  "ausência não é confirmação"). */
  confirmed: boolean;
}

export interface DoiConfirmationCohortResult {
  /** Vazio quando a safra não pôde ser resolvida — ver `motivoIndeterminado`. */
  cohort: DoiConfirmationCohortMember[];
  /** Presente sempre que `cohort` está vazio — motivo elegível pra virar o
   *  `motivo` de um `MetricResult.qualidade === 'indeterminado'`. */
  motivoIndeterminado?: string;
  /** `true` quando a safra foi montada SEM o filtro do form DOI (snapshot do
   *  dia sem `doi_form`) — inclui órfãos, a taxa é um PISO. */
  semFiltroDoi?: boolean;
}

/**
 * Reconstrói a safra de confirmação DOI do dia `cohortDate` a partir de
 * snapshots já carregados (`snapshotsByDate`, chave = data `AAAA-MM-DD`).
 *
 * Definição operacional (mesma da issue #7176/`doiConfirmacaoDiaDef`):
 * safra = assinantes cujo `created_at` cai em `cohortDate` E que estavam
 * `inactive` NO SNAPSHOT DESSE DIA (o único jeito de saber "nasceu inactive"
 * — o estado de criação não sobrevive fora do snapshot do próprio dia, essa
 * é a lacuna que este mecanismo existe pra fechar). Confirmado = o mesmo id
 * aparece `active` num snapshot tirado ≥ `maturationHours` depois.
 *
 * **Cruzamento com o form DOI (#8552 a):** o snapshot do dia pode carregar
 * `doi_form: true` (participação em `KIT_DOI_FORM_ID`, gravada pelo CLI).
 * Havendo esse dado no snapshot do dia D, a safra é só quem estava vinculado
 * ao form; sem ele (snapshots anteriores a esta fatia, ou `kit.doiFormId`
 * ausente), cai no comportamento antigo — "todo `inactive` criado no dia".
 *
 * @pure — todos os snapshots já vêm carregados; nenhuma leitura de disco.
 */
export function buildDoiConfirmationCohort(
  snapshotsByDate: ReadonlyMap<string, readonly SubscriberStateRecord[]>,
  cohortDate: string,
  maturationHours = 48,
  doiStatusByDate?: ReadonlyMap<string, { ok: boolean }>,
): DoiConfirmationCohortResult {
  const dates = [...snapshotsByDate.keys()].sort();
  if (dates.length < 2) {
    return {
      cohort: [],
      motivoIndeterminado: `menos de 2 snapshots diários disponíveis (${dates.length}) — sem histórico suficiente pra reconstruir a safra`,
    };
  }
  const dayRecords = snapshotsByDate.get(cohortDate);
  if (!dayRecords) {
    return {
      cohort: [],
      motivoIndeterminado: `sem snapshot do próprio dia ${cohortDate} — o estado de criação (inactive) só é observável no snapshot tirado naquele dia`,
    };
  }
  const bornInactive = dayRecords.filter((r) => r.state === "inactive" && brtDayKey(r.created_at) === cohortDate);
  // #8552 (a): quando o snapshot do dia trouxe a participação no form DOI
  // (qualquer record com `doi_form`), a safra é só quem estava vinculado ao
  // form — quem nunca foi vinculado (órfão, `kit-doi-orphan-guard`) nunca
  // recebeu o e-mail e não teve chance de confirmar; ele é perda de ativação
  // por defeito, medida à parte, não desinteresse. Sem cobertura (snapshot
  // antigo ou form não configurado), mantém "todo inactive criado no dia".
  // `doi-form-status.json` (gravado pelo CLI diário) distingue "leitura do
  // form falhou" (ok:false -> sem filtro, piso) de "form lido ok mas ninguém
  // do dia vinculado" (ok:true -> filtra; safra vazia, motivo próprio). Sem
  // status (snapshot antigo), cai na heurística por `doi_form` presente.
  const status = doiStatusByDate?.get(cohortDate);
  const formCoverage = status ? status.ok : dayRecords.some((r) => r.doi_form === true);
  const cohortIds = (formCoverage ? bornInactive.filter((r) => r.doi_form === true) : bornInactive).map((r) => r.id);
  if (cohortIds.length === 0) {
    return {
      cohort: [],
      motivoIndeterminado: `nenhum assinante inactive criado em ${cohortDate}${formCoverage ? " e vinculado ao form DOI" : ""} no snapshot desse dia`,
    };
  }
  const maturationDateKey = addHoursToDateKey(cohortDate, maturationHours);
  const maturedSnapshotDate = dates.find((d) => d >= maturationDateKey);
  if (!maturedSnapshotDate) {
    return {
      cohort: [],
      motivoIndeterminado: `safra de ${cohortDate} ainda não maturou (precisa de snapshot >= ${maturationDateKey}; mais recente disponível é ${dates[dates.length - 1]})`,
    };
  }
  const maturedRecords = snapshotsByDate.get(maturedSnapshotDate)!;
  const maturedById = new Map(maturedRecords.map((r) => [r.id, r]));
  const cohort: DoiConfirmationCohortMember[] = cohortIds.map((id) => ({
    id,
    confirmed: maturedById.get(id)?.state === "active",
  }));
  return { cohort, ...(formCoverage ? {} : { semFiltroDoi: true }) };
}
