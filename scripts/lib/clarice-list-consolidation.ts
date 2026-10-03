/**
 * clarice-list-consolidation.ts (#9532) — lógica PURA + orquestração com
 * cliente injetável de `scripts/clarice-consolidate-lists.ts`.
 *
 * Contexto: a conta Brevo da Clarice tem teto de 300 listas (`POST
 * /contacts/lists` → 405 "list creation limit"), o que quebra
 * `diaria-clarice-novos`/`diaria-clarice-envio`. Decisão do editor (caminho 1
 * da #9532): consolidar as listas de campanhas enviadas antigas numa lista de
 * HISTÓRICO única (`clarice_list_history.list_id`), que o guard por contato
 * (#7406/#3682) passa a ler como "já comprometido"
 * (`fetchQueuedAndCommittedCampaignListIds`), e SÓ ENTÃO apagar as originais.
 *
 * Peças:
 *   1. `planListConsolidation` — pura, decide quais listas são candidatas.
 *   2. `checkApplyPreconditions` — pura, tudo que o `--apply` exige antes de
 *      tocar a Brevo.
 *   3. `applyListConsolidation` — por lista candidata, na ordem: contagem
 *      fresca + membros (sem truncamento) → snapshot local (gravado e relido
 *      por CONTEÚDO) → add à lista de histórico (confirmado) → re-checagem de
 *      campanhas não-terminais (por lote) → DELETE. Qualquer falha antes do
 *      DELETE pula a lista sem apagá-la.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeExpectedEnvioCycle } from "./clarice-envio-cycle.ts";
import { datePartsInTz, BRT_TIMEZONE } from "./next-edition-date.ts";

/** Teto de listas da conta Brevo da Clarice (medido ao vivo, #9532). */
export const BREVO_LIST_CAP = 300;

/** Lote máximo do `POST /contacts/lists/{id}/contacts/add` síncrono da Brevo. */
export const ADD_BATCH_SIZE = 150;

/** Quantos membros recém-adicionados conferir por GET de contato, por lista. */
export const SPOT_CHECK_SAMPLE = 3;

/**
 * A cada quantas listas re-buscar as campanhas não-terminais antes de apagar.
 * Cada re-checagem custa ~5 GETs em `/emailCampaigns` (100 req/HORA/conta) —
 * 25 mantém uma rodada completa (~230 listas) em ~45 GETs.
 */
export const RECHECK_EVERY = 25;

/**
 * Status de campanha que significam "já disparada, nunca mais muda de
 * audiência". `archive` = campanha enviada e arquivada. Qualquer outro status
 * — inclusive desconhecido — é tratado como NÃO-terminal (conservador: as
 * listas dela ficam protegidas).
 */
export const SENT_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["sent", "archive"]);

/**
 * ALLOWLIST de nomes de lista de campanha Clarice (medidos no dry-run real de
 * 03/10/2026). Só lista cujo NOME casa algum padrão pode ser apagada; o resto
 * vira `unmatched-name` e nunca é tocado — uma lista criada à mão (supressão,
 * teste, import) não tem como ser reconhecida por regra de campanha.
 */
export const CAMPAIGN_LIST_NAME_PATTERNS: readonly RegExp[] = [
  /^T\d+-W\d+\b/, // T1-W1 (top 50) — ondas da migração
  /^Clarice Novos \d{2}\/\d{2}\b/, // Clarice Novos 19/09 (novos-260919) …
  /\(novos-\d{6}(-\d+)?\)/,
  /^Clarice (News )?\d{4}-\d{2} /, // Clarice 2608-09 d3-qui03-C …, Clarice News 2606-07 A …
  /^\d{4}-\d{2} cold\b/, // 2606-07 cold d1
  /^cold \d{4}-\d{2} /,
  /^Clarice [A-Z][a-z]{2}\/\d{4} /, // Clarice Jun/2026 d03-C (sex)
  /^Diar\.ia Mensal \d{4} /,
  /^Clarice .*ramp[- ]warm/i, // ramp-warm envio N, 1º envio seguro, edição atual
  /^Clarice assinantes novos [a-z]{3}-\d{4}\b/,
  /^Clarice Score -?\d+/,
  /^Clarice Orfaos /,
];

export function isCampaignListName(name: string): boolean {
  return CAMPAIGN_LIST_NAME_PATTERNS.some((re) => re.test(name));
}

export interface ConsolidationList {
  id: number;
  name: string;
  totalSubscribers?: number;
  uniqueSubscribers?: number;
}

export interface ConsolidationCampaign {
  id: number;
  name?: string;
  status?: string;
  sentDate?: string | null;
  recipients?: { lists?: number[]; exclusionLists?: number[] } | null;
}

export type ListVerdict =
  | "candidate"
  | "history" // a própria lista de histórico
  | "protected" // list_id do platform.config.json ou --protect
  | "unmatched-name" // nome fora da allowlist de listas de campanha
  | "no-campaign" // nenhuma campanha referencia — fora do escopo, só contada
  | "exclusion-only" // só aparece como exclusionList de campanhas enviadas — membros NÃO receberam
  | "non-terminal-ref" // referenciada (alvo ou exclusão) por campanha não-terminal
  | "recent-sent" // campanha enviada há menos de min_age_days
  | "open-cycle" // ciclo mensal da lista (ou mês de envio) ainda não fechado
  | "sent-without-date"; // campanha terminal sem sentDate parseável — não dá pra provar a idade

export interface CandidateList {
  listId: number;
  name: string;
  campaignIds: number[];
  sentDates: string[];
  /** `uniqueSubscribers ?? totalSubscribers` da listagem (estimativa pro plano). */
  subscribers: number;
  /** sentDate mais recente entre as campanhas que a referenciam (ISO). */
  lastSentAt: string;
}

export interface ConsolidationPlan {
  generated_at: string;
  history_list_id: number | null;
  min_age_days: number;
  cutoff: string;
  current_cycle: string;
  total_lists: number;
  list_cap: number;
  candidates: CandidateList[];
  verdict_counts: Record<ListVerdict, number>;
  per_list: { listId: number; name: string; verdict: ListVerdict }[];
  /** Listas que passariam em tudo, menos na allowlist de nome — revisar à mão. */
  unmatched_names: { listId: number; name: string }[];
  candidate_contacts_estimate: number;
  lists_after: number;
  free_after: number;
}

export interface PlanInput {
  lists: ConsolidationList[];
  campaigns: ConsolidationCampaign[];
  historyListId: number | null;
  protectedListIds: ReadonlySet<number>;
  minAgeDays: number;
  now: Date;
}

interface ListRefs {
  sentTargets: ConsolidationCampaign[];
  sentExclusions: ConsolidationCampaign[];
  nonTerminal: number;
}

function emptyVerdictCounts(): Record<ListVerdict, number> {
  return {
    candidate: 0,
    history: 0,
    protected: 0,
    "unmatched-name": 0,
    "no-campaign": 0,
    "exclusion-only": 0,
    "non-terminal-ref": 0,
    "recent-sent": 0,
    "open-cycle": 0,
    "sent-without-date": 0,
  };
}

export function isSentTerminal(status: string | undefined): boolean {
  return status !== undefined && SENT_TERMINAL_STATUSES.has(status);
}

const CYCLE_IN_NAME_RE = /(?:^|[^\d])(\d{4}-\d{2})(?![\d])/;

/** Ciclo `{conteúdo}-{envio}` citado no nome da lista (ex: "2608-09"), ou null. */
export function cycleFromListName(name: string): string | null {
  return CYCLE_IN_NAME_RE.exec(name)?.[1] ?? null;
}

function yymmBrt(d: Date): string {
  const { year, month } = datePartsInTz(d, BRT_TIMEZONE);
  return `${String(year % 100).padStart(2, "0")}${String(month).padStart(2, "0")}`;
}

/**
 * Pura. O ciclo da lista já fechou? `summarizeCycleSends` (clarice-wave-plan.ts)
 * atribui campanha a ciclo pelo nome da lista — apagar lista de ciclo em
 * curso subconta envios e reusa número de onda (#3682).
 *   - nome com ciclo `YYMM-MM` → fechado se < ciclo esperado hoje
 *     (`computeExpectedEnvioCycle`; strings `YYMM-MM` ordenam cronologicamente);
 *   - sem ciclo no nome (novos, T1-W, Jun/2026…) → fechado se TODO sentDate
 *     cai num mês (BRT) anterior ao mês corrente.
 */
export function isListCycleClosed(name: string, sentDates: string[], now: Date): boolean {
  const cycle = cycleFromListName(name);
  if (cycle !== null) return cycle < computeExpectedEnvioCycle(now);
  const current = yymmBrt(now);
  return sentDates.every((s) => {
    const ms = Date.parse(s);
    return Number.isFinite(ms) && yymmBrt(new Date(ms)) < current;
  });
}

/**
 * Pura. Uma lista é CANDIDATA a apagar só quando, ao mesmo tempo:
 *   - não é a lista de histórico nem uma lista protegida;
 *   - é ALVO (`recipients.lists`) de pelo menos 1 campanha terminal — lista
 *     que só aparece como exclusão não entra: seus membros não receberam, e
 *     jogá-los no histórico os barraria de um 1º envio indevidamente;
 *   - nenhuma campanha não-terminal (queued/draft/in_process/suspended/
 *     in_review/desconhecido) a referencia, nem como alvo nem como exclusão;
 *   - TODA campanha terminal que a referencia tem `sentDate` parseável
 *     anterior a `now - minAgeDays`, e o ciclo da lista já fechou;
 *   - o NOME casa a allowlist de listas de campanha.
 * Lista sem campanha nenhuma não é apagada (fora do escopo) — só contada.
 */
export function planListConsolidation(input: PlanInput): ConsolidationPlan {
  const { lists, campaigns, historyListId, protectedListIds, minAgeDays, now } = input;
  const cutoffMs = now.getTime() - minAgeDays * 86_400_000;

  const refs = new Map<number, ListRefs>();
  const refOf = (id: number): ListRefs => {
    let r = refs.get(id);
    if (!r) {
      r = { sentTargets: [], sentExclusions: [], nonTerminal: 0 };
      refs.set(id, r);
    }
    return r;
  };
  for (const c of campaigns) {
    const terminal = isSentTerminal(c.status);
    for (const id of c.recipients?.lists ?? []) {
      if (terminal) refOf(id).sentTargets.push(c);
      else refOf(id).nonTerminal++;
    }
    for (const id of c.recipients?.exclusionLists ?? []) {
      if (terminal) refOf(id).sentExclusions.push(c);
      else refOf(id).nonTerminal++;
    }
  }

  const verdictCounts = emptyVerdictCounts();
  const perList: ConsolidationPlan["per_list"] = [];
  const candidates: CandidateList[] = [];
  const unmatched: ConsolidationPlan["unmatched_names"] = [];

  for (const l of lists) {
    const r = refs.get(l.id);
    let verdict: ListVerdict;
    let lastSentMs = -Infinity;
    const allSentDates: string[] = [];
    if (historyListId !== null && l.id === historyListId) verdict = "history";
    else if (protectedListIds.has(l.id)) verdict = "protected";
    else if (!r) verdict = "no-campaign";
    else if (r.nonTerminal > 0) verdict = "non-terminal-ref";
    else if (r.sentTargets.length === 0) verdict = "exclusion-only";
    else {
      verdict = "candidate";
      for (const c of [...r.sentTargets, ...r.sentExclusions]) {
        const ms = c.sentDate ? Date.parse(c.sentDate) : NaN;
        if (!Number.isFinite(ms)) {
          verdict = "sent-without-date";
          break;
        }
        allSentDates.push(c.sentDate as string);
        if (ms > lastSentMs) lastSentMs = ms;
      }
      if (verdict === "candidate" && lastSentMs >= cutoffMs) verdict = "recent-sent";
      if (verdict === "candidate" && !isListCycleClosed(l.name, allSentDates, now)) verdict = "open-cycle";
      if (verdict === "candidate" && !isCampaignListName(l.name)) {
        verdict = "unmatched-name";
        unmatched.push({ listId: l.id, name: l.name });
      }
    }
    verdictCounts[verdict]++;
    perList.push({ listId: l.id, name: l.name, verdict });
    if (verdict === "candidate" && r) {
      const targets = r.sentTargets;
      candidates.push({
        listId: l.id,
        name: l.name,
        campaignIds: [...new Set(targets.map((c) => c.id))].sort((a, b) => a - b),
        sentDates: [...new Set(targets.map((c) => c.sentDate as string))].sort(),
        subscribers: l.uniqueSubscribers ?? l.totalSubscribers ?? 0,
        lastSentAt: new Date(lastSentMs).toISOString(),
      });
    }
  }

  // Mais antigas primeiro — `--limit N` apaga as N de envio mais distante.
  candidates.sort((a, b) => a.lastSentAt.localeCompare(b.lastSentAt) || a.listId - b.listId);

  const listsAfter = lists.length - candidates.length;
  return {
    generated_at: now.toISOString(),
    history_list_id: historyListId,
    min_age_days: minAgeDays,
    cutoff: new Date(cutoffMs).toISOString(),
    current_cycle: computeExpectedEnvioCycle(now),
    total_lists: lists.length,
    list_cap: BREVO_LIST_CAP,
    candidates,
    verdict_counts: verdictCounts,
    per_list: perList,
    unmatched_names: unmatched,
    candidate_contacts_estimate: candidates.reduce((s, c) => s + c.subscribers, 0),
    lists_after: listsAfter,
    free_after: BREVO_LIST_CAP - listsAfter,
  };
}

// ---------------------------------------------------------------------------
// Pré-condições do --apply
// ---------------------------------------------------------------------------

export const HISTORY_LIST_NAME = "clarice-historico-envios";

export interface ApplyPreconditionInput {
  /** `list_id` do config que o SCRIPT leu. */
  configListId: number | null;
  /** O que o GUARD lê em produção (`resolveClariceHistoryListIdForGuard`). */
  guardListId: number | null;
  /** `git diff --quiet -- platform.config.json` falhou (mudança não commitada). */
  configDirty: boolean;
  /** `list_id` em `origin/master:platform.config.json` (undefined = não lido/ausente). */
  masterListId: number | null | undefined;
  /** `data/` existe no root (o snapshot não pode nascer num diretório novo). */
  dataDirExists: boolean;
  /** Nome real da lista `configListId` na Brevo (undefined = não consultado). */
  historyListName?: string;
}

/**
 * Pura. Devolve a lista de motivos pelos quais o `--apply` NÃO pode rodar
 * (vazia = pode). Cada item protege uma forma de o guard ler um histórico
 * diferente do que o script popula: config não commitado / divergente do
 * master some num `git-sync` e o guard do `300` leria outro id.
 */
export function checkApplyPreconditions(i: ApplyPreconditionInput): string[] {
  const errs: string[] = [];
  if (i.configListId === null) {
    errs.push(
      `clarice_list_history.list_id é null — crie a lista \`${HISTORY_LIST_NAME}\` na conta Brevo da Clarice e preencha o id.`,
    );
    return errs;
  }
  if (i.guardListId !== i.configListId) {
    errs.push(`o guard lê list_id=${String(i.guardListId)} e o script usaria ${i.configListId} — precisam ser o mesmo.`);
  }
  if (i.configDirty) {
    errs.push("platform.config.json tem mudança não commitada — commite e mergeie o list_id antes (o guard em produção lê o master).");
  }
  if (i.masterListId !== i.configListId) {
    errs.push(
      `origin/master:platform.config.json tem list_id=${String(i.masterListId)} (esperado ${i.configListId}) — mergeie o id antes do --apply.`,
    );
  }
  if (!i.dataDirExists) {
    errs.push("data/ não existe no --root — o snapshot (cópia de segurança do DELETE) sumiria com o diretório. Rode do checkout com data/.");
  }
  if (i.historyListName !== undefined && i.historyListName !== HISTORY_LIST_NAME) {
    errs.push(`a lista ${i.configListId} se chama "${i.historyListName}", esperado "${HISTORY_LIST_NAME}" — config apontando pra lista errada?`);
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Execução (--apply)
// ---------------------------------------------------------------------------

export interface ListArchiveSnapshot {
  listId: number;
  name: string;
  campaignIds: number[];
  sentDates: string[];
  emails: string[];
  history_list_id: number;
  archived_at: string;
}

/**
 * Total de MEMBROS de uma lista a partir do `GET /contacts/lists/{id}`.
 * `totalSubscribers` da Brevo EXCLUI os blacklistados, mas
 * `/contacts/lists/{id}/contacts` devolve todos — comparar com ele faz toda
 * lista com 1+ blacklistado falhar como "truncada" (achado ao vivo 03/10,
 * lista 9: 50 baixados × totalSubscribers 49, uniqueSubscribers 50). Prefere
 * `uniqueSubscribers`; sem ele, `totalSubscribers + totalBlacklisted`.
 */
export function listMemberCount(info: { totalSubscribers: number; totalBlacklisted?: number; uniqueSubscribers?: number }): number {
  if (typeof info.uniqueSubscribers === "number" && Number.isFinite(info.uniqueSubscribers)) return info.uniqueSubscribers;
  return info.totalSubscribers + (info.totalBlacklisted ?? 0);
}

/** Cliente injetável — o script real liga na Brevo + disco; os testes num fake. */
export interface ConsolidationClient {
  /**
   * Nº FRESCO de membros da lista (GET /contacts/lists/{id}) — via
   * `listMemberCount`, nunca `totalSubscribers` cru (exclui blacklistados).
   */
  getListCount(listId: number): Promise<number>;
  /** Todos os e-mails membros da lista (paginado). Lança em 404/erro. */
  listContacts(listId: number): Promise<string[]>;
  /** Persiste o snapshot local (deve lançar se não conseguir gravar). */
  writeSnapshot(snapshot: ListArchiveSnapshot): Promise<void>;
  /** Relê o snapshot gravado (prova de persistência antes de seguir). */
  readSnapshot(listId: number): Promise<ListArchiveSnapshot | null>;
  /** `POST /contacts/lists/{listId}/contacts/add` com ≤150 e-mails. */
  addToList(listId: number, emails: string[]): Promise<{ success: string[]; failure: string[] }>;
  /** Confere por GET de contato que `email` está em `listId`. */
  contactInList(email: string, listId: number): Promise<boolean>;
  /** ids de lista referenciados (alvo OU exclusão) por campanha não-terminal, AO VIVO. */
  fetchNonTerminalListRefs(): Promise<Set<number>>;
  /** Grava o marcador irreversível `consolidated_at` (antes do 1º DELETE). */
  markConsolidated(iso: string): Promise<void>;
  /** `DELETE /contacts/lists/{listId}`. */
  deleteList(listId: number): Promise<void>;
}

export type FailStep = "contacts" | "snapshot" | "add" | "verify" | "recheck" | "delete";

export type ListApplyResult =
  | { listId: number; name: string; status: "deleted"; emails: number; added: number }
  | { listId: number; name: string; status: "skipped"; reason: string }
  | { listId: number; name: string; status: "failed"; step: FailStep; error: string };

export interface ApplyOptions {
  historyListId: number;
  /** Membros JÁ presentes na lista de histórico (lidos 1× no início). Mutado: recebe os adicionados. */
  historyMembers: Set<string>;
  /** Listas que NUNCA podem ser apagadas (config + --protect). Asserção de defesa. */
  protectedListIds: ReadonlySet<number>;
  limit?: number;
  now: () => Date;
  log?: (msg: string) => void;
  /** Chamado a cada resultado, na hora (o script grava 1 linha JSONL). */
  onResult?: (r: ListApplyResult) => void;
  /** Para a rodada depois de N falhas (falha sistêmica — quota, auth). Default 3. */
  maxFailures?: number;
  /** Re-checagem de não-terminais a cada N listas. Default RECHECK_EVERY. */
  recheckEvery?: number;
  /**
   * Esperas entre re-tentativas da amostra por GET de contato. O add da Brevo
   * propaga com atraso de segundos (achado ao vivo 03/10: contato ausente logo
   * após o add, presente instantes depois). Default VERIFY_RETRY_DELAYS_MS.
   */
  verifyRetryDelaysMs?: readonly number[];
  /** Injetável (testes). */
  sleep?: (ms: number) => Promise<void>;
}

/** Esperas (ms) antes de cada nova tentativa da amostra — ~32s no total. */
export const VERIFY_RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 10_000, 15_000];

function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface ListState {
  /** marcador `consolidated_at` já gravado nesta rodada. */
  marked: boolean;
}

/**
 * Processa uma lista. Invariante: `deleteList` só é chamado depois de (a)
 * contagem fresca == membros baixados, (b) snapshot gravado E relido com o
 * MESMO conteúdo, (c) TODO e-mail da lista confirmado na lista de histórico
 * (resposta do add restrita ao lote enviado, ou já estava lá) mais uma
 * amostra conferida por GET de contato, e (d) o marcador `consolidated_at`
 * gravado.
 */
export async function consolidateOneList(
  cand: CandidateList,
  client: ConsolidationClient,
  opts: ApplyOptions,
  state: ListState = { marked: false },
): Promise<ListApplyResult> {
  const { historyListId, historyMembers } = opts;
  if (cand.listId === historyListId) {
    throw new Error(`consolidateOneList: lista ${cand.listId} é a própria lista de histórico — bug no plano.`);
  }
  if (opts.protectedListIds.has(cand.listId)) {
    throw new Error(`consolidateOneList: lista ${cand.listId} é protegida — bug no plano.`);
  }
  const fail = (step: FailStep, e: unknown): ListApplyResult => ({
    listId: cand.listId,
    name: cand.name,
    status: "failed",
    step,
    error: errMsg(e),
  });

  // (a) contagem fresca + membros, sem truncamento
  let emails: string[];
  try {
    const count = await client.getListCount(cand.listId);
    emails = [...new Set((await client.listContacts(cand.listId)).map(normEmail).filter(Boolean))].sort();
    if (emails.length !== count) {
      throw new Error(`membros baixados (${emails.length}) ≠ membros da lista (${count}) — paginação truncada ou lista mudou`);
    }
  } catch (e) {
    return fail("contacts", e);
  }
  const snapshot: ListArchiveSnapshot = {
    listId: cand.listId,
    name: cand.name,
    campaignIds: cand.campaignIds,
    sentDates: cand.sentDates,
    emails,
    history_list_id: historyListId,
    archived_at: opts.now().toISOString(),
  };
  try {
    await client.writeSnapshot(snapshot);
    const back = await client.readSnapshot(cand.listId);
    if (
      !back ||
      back.listId !== cand.listId ||
      back.name !== cand.name ||
      back.history_list_id !== historyListId ||
      !Array.isArray(back.emails) ||
      back.emails.join("\n") !== emails.join("\n")
    ) {
      throw new Error("snapshot relido não confere com o que foi gravado");
    }
  } catch (e) {
    return fail("snapshot", e);
  }

  // (b) add à lista de histórico — só quem ainda não está lá
  const toAdd = emails.filter((e) => !historyMembers.has(e));
  const added: string[] = [];
  try {
    for (let i = 0; i < toAdd.length; i += ADD_BATCH_SIZE) {
      const batch = toAdd.slice(i, i + ADD_BATCH_SIZE);
      const batchSet = new Set(batch);
      const res = await client.addToList(historyListId, batch);
      for (const e of res.success) {
        const n = normEmail(e);
        if (!batchSet.has(n)) throw new Error(`a Brevo confirmou ${n}, que não estava no lote enviado`);
        historyMembers.add(n);
        added.push(n);
      }
    }
  } catch (e) {
    return fail("add", e);
  }
  const missing = emails.filter((e) => !historyMembers.has(e));
  if (missing.length > 0) {
    return fail(
      "add",
      `${missing.length} e-mail(s) não confirmados na lista de histórico ${historyListId} (ex: ${missing.slice(0, 3).join(", ")}) — lista NÃO apagada`,
    );
  }
  // Amostra por GET de contato — só entre os RECÉM-adicionados, não confiar
  // só no 2xx/`success` do POST.
  try {
    const delays = opts.verifyRetryDelaysMs ?? VERIFY_RETRY_DELAYS_MS;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (const e of added.slice(0, SPOT_CHECK_SAMPLE)) {
      let ok = await client.contactInList(e, historyListId);
      for (let i = 0; !ok && i < delays.length; i++) {
        await sleep(delays[i]);
        ok = await client.contactInList(e, historyListId);
      }
      if (!ok) {
        throw new Error(`${e} não aparece na lista de histórico ${historyListId} após o add (${delays.length + 1} tentativas)`);
      }
    }
  } catch (e) {
    return fail("verify", e);
  }

  // (c) marcador irreversível ANTES do 1º DELETE (marcador sem DELETE é
  // inócuo; DELETE sem marcador deixaria `list_id: null` aceitável).
  if (!state.marked) {
    try {
      await client.markConsolidated(opts.now().toISOString());
      state.marked = true;
    } catch (e) {
      return fail("delete", `marcador consolidated_at não gravado: ${errMsg(e)}`);
    }
  }

  // (d) só agora: DELETE
  try {
    await client.deleteList(cand.listId);
  } catch (e) {
    return fail("delete", e);
  }
  return { listId: cand.listId, name: cand.name, status: "deleted", emails: emails.length, added: added.length };
}

export async function applyListConsolidation(
  candidates: CandidateList[],
  client: ConsolidationClient,
  opts: ApplyOptions,
): Promise<ListApplyResult[]> {
  const log = opts.log ?? (() => {});
  const maxFailures = opts.maxFailures ?? 3;
  const recheckEvery = opts.recheckEvery ?? RECHECK_EVERY;
  const queue = opts.limit !== undefined ? candidates.slice(0, opts.limit) : candidates;
  const results: ListApplyResult[] = [];
  const state: ListState = { marked: false };
  const emit = (r: ListApplyResult) => {
    results.push(r);
    opts.onResult?.(r);
  };
  let failures = 0;
  let nonTerminalRefs = new Set<number>();
  for (let i = 0; i < queue.length; i++) {
    const cand = queue[i];
    if (i % recheckEvery === 0) {
      // Re-checagem ao vivo: campanha criada/editada DEPOIS do plano pode
      // ter passado a mirar (ou excluir) uma lista candidata.
      try {
        nonTerminalRefs = await client.fetchNonTerminalListRefs();
      } catch (e) {
        log(`⛔ re-checagem de campanhas não-terminais falhou (${errMsg(e)}) — parando antes de apagar mais nada.`);
        emit({ listId: cand.listId, name: cand.name, status: "failed", step: "recheck", error: errMsg(e) });
        break;
      }
    }
    if (nonTerminalRefs.has(cand.listId)) {
      const r: ListApplyResult = {
        listId: cand.listId,
        name: cand.name,
        status: "skipped",
        reason: "referenciada por campanha não-terminal na re-checagem",
      };
      emit(r);
      log(`⏭️  lista ${cand.listId} (${cand.name}): ${r.reason} — mantida.`);
      continue;
    }
    const r = await consolidateOneList(cand, client, opts, state);
    emit(r);
    if (r.status === "deleted") {
      log(`✅ lista ${r.listId} (${r.name}): ${r.emails} e-mail(s) arquivados, ${r.added} novo(s) no histórico, apagada.`);
    } else if (r.status === "failed") {
      failures++;
      log(`❌ lista ${r.listId} (${r.name}): falhou em ${r.step} — ${r.error}. NÃO apagada.`);
      if (failures >= maxFailures) {
        log(`⛔ ${failures} falha(s) — parando a rodada (provável falha sistêmica: quota/auth/rede).`);
        break;
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Leitura do arquivo de snapshots (consumidores: plan-wave, auditoria #7880)
// ---------------------------------------------------------------------------

/** Metadados de uma lista apagada, lidos do snapshot local (null se não houver). */
export function readListArchiveMeta(
  archiveDir: string,
  listId: number,
): { name: string; total: number; sentDates: string[] } | null {
  const p = resolve(archiveDir, `${listId}.json`);
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, "utf8")) as Partial<ListArchiveSnapshot>;
  if (typeof s.name !== "string" || !Array.isArray(s.emails)) {
    throw new Error(`snapshot ${p} malformado (sem name/emails).`);
  }
  return { name: s.name, total: s.emails.length, sentDates: Array.isArray(s.sentDates) ? s.sentDates : [] };
}

/**
 * Snapshots de listas apagadas com algum `sentDate` dentro de [startIso,
 * endIsoExclusive). A auditoria #7880 cruza a onda contra listas AO VIVO — uma
 * lista apagada some do índice, então colisões nessa janela não seriam vistas.
 */
export function archivedListsInWindow(
  archiveDir: string,
  startIso: string,
  endIsoExclusive: string,
): { listId: number; name: string }[] {
  if (!existsSync(archiveDir)) return [];
  const start = Date.parse(startIso);
  const end = Date.parse(endIsoExclusive);
  const out: { listId: number; name: string }[] = [];
  for (const f of readdirSync(archiveDir)) {
    const m = /^(\d+)\.json$/.exec(f);
    if (!m) continue;
    const meta = readListArchiveMeta(archiveDir, Number(m[1]));
    if (!meta) continue;
    if (meta.sentDates.some((d) => {
      const ms = Date.parse(d);
      return ms >= start && ms < end;
    })) {
      out.push({ listId: Number(m[1]), name: meta.name });
    }
  }
  return out.sort((a, b) => a.listId - b.listId);
}
