/**
 * clarice-list-consolidation.ts (#9532) — lógica PURA + orquestração com
 * cliente injetável de `scripts/clarice-consolidate-lists.ts`.
 *
 * Contexto: a conta Brevo da Clarice tem teto de 300 listas (`POST
 * /contacts/lists` → 405 "list creation limit"), o que quebra
 * `diaria-clarice-novos`/`diaria-clarice-envio`. Decisão do editor (caminho 1
 * da #9532): consolidar as listas de campanhas `sent` antigas numa lista de
 * HISTÓRICO única (`clarice_list_history.list_id`), que o guard por contato
 * (#7406/#3682) passa a ler como "já comprometido"
 * (`fetchQueuedAndCommittedCampaignListIds`), e SÓ ENTÃO apagar as originais.
 *
 * Duas peças:
 *   1. `planListConsolidation` — pura, decide quais listas são candidatas.
 *   2. `applyListConsolidation` — por lista candidata, na ordem: snapshot
 *      local (gravado e relido) → add à lista de histórico (confirmado) →
 *      DELETE. Qualquer falha antes do DELETE pula a lista sem apagá-la.
 */

/** Teto de listas da conta Brevo da Clarice (medido ao vivo, #9532). */
export const BREVO_LIST_CAP = 300;

/** Lote máximo do `POST /contacts/lists/{id}/contacts/add` síncrono da Brevo. */
export const ADD_BATCH_SIZE = 150;

/** Quantos membros recém-adicionados conferir por GET de contato, por lista. */
export const SPOT_CHECK_SAMPLE = 3;

/**
 * Status de campanha que significam "já disparada, nunca mais muda de
 * audiência". `archive` = campanha enviada e arquivada. Qualquer outro status
 * — inclusive desconhecido — é tratado como NÃO-terminal (conservador: as
 * listas dela ficam protegidas).
 */
export const SENT_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["sent", "archive"]);

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
  | "protected" // citada em platform.config.json/código como fixa
  | "no-campaign" // nenhuma campanha referencia — fora do escopo, só contada
  | "exclusion-only" // só aparece como exclusionList de campanhas enviadas — membros NÃO receberam
  | "non-terminal-ref" // referenciada (alvo ou exclusão) por campanha não-terminal
  | "recent-sent" // campanha enviada há menos de min_age_days
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
  total_lists: number;
  list_cap: number;
  candidates: CandidateList[];
  verdict_counts: Record<ListVerdict, number>;
  per_list: { listId: number; name: string; verdict: ListVerdict }[];
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
    "no-campaign": 0,
    "exclusion-only": 0,
    "non-terminal-ref": 0,
    "recent-sent": 0,
    "sent-without-date": 0,
  };
}

export function isSentTerminal(status: string | undefined): boolean {
  return status !== undefined && SENT_TERMINAL_STATUSES.has(status);
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
 *     anterior a `now - minAgeDays`.
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

  for (const l of lists) {
    const r = refs.get(l.id);
    let verdict: ListVerdict;
    let lastSentMs = -Infinity;
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
        if (ms > lastSentMs) lastSentMs = ms;
      }
      if (verdict === "candidate" && lastSentMs >= cutoffMs) verdict = "recent-sent";
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
    total_lists: lists.length,
    list_cap: BREVO_LIST_CAP,
    candidates,
    verdict_counts: verdictCounts,
    per_list: perList,
    candidate_contacts_estimate: candidates.reduce((s, c) => s + c.subscribers, 0),
    lists_after: listsAfter,
    free_after: BREVO_LIST_CAP - listsAfter,
  };
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

/** Cliente injetável — o script real liga na Brevo + disco; os testes num fake. */
export interface ConsolidationClient {
  /** Todos os e-mails membros da lista (paginado). */
  listContacts(listId: number): Promise<string[]>;
  /** Persiste o snapshot local (deve lançar se não conseguir gravar). */
  writeSnapshot(snapshot: ListArchiveSnapshot): Promise<void>;
  /** Relê o snapshot gravado (prova de persistência antes de seguir). */
  readSnapshot(listId: number): Promise<ListArchiveSnapshot | null>;
  /** `POST /contacts/lists/{listId}/contacts/add` com ≤150 e-mails. */
  addToList(listId: number, emails: string[]): Promise<{ success: string[]; failure: string[] }>;
  /** Confere por GET de contato que `email` está em `listId`. */
  contactInList(email: string, listId: number): Promise<boolean>;
  /** `DELETE /contacts/lists/{listId}`. */
  deleteList(listId: number): Promise<void>;
}

export type ListApplyResult =
  | { listId: number; name: string; status: "deleted"; emails: number; added: number }
  | {
      listId: number;
      name: string;
      status: "failed";
      step: "contacts" | "snapshot" | "add" | "verify" | "delete";
      error: string;
    };

export interface ApplyOptions {
  historyListId: number;
  /** Membros JÁ presentes na lista de histórico (lidos 1× no início). Mutado: recebe os adicionados. */
  historyMembers: Set<string>;
  limit?: number;
  now: () => Date;
  log?: (msg: string) => void;
  /** Para a rodada depois de N falhas (falha sistêmica — quota, auth). Default 3. */
  maxFailures?: number;
}

function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Processa uma lista. Invariante: `deleteList` só é chamado depois de (a)
 * snapshot gravado E relido com o mesmo número de e-mails e (b) TODO e-mail
 * da lista confirmado na lista de histórico (pela resposta do add ou por já
 * estar lá) mais uma amostra conferida por GET de contato.
 */
export async function consolidateOneList(
  cand: CandidateList,
  client: ConsolidationClient,
  opts: ApplyOptions,
): Promise<ListApplyResult> {
  const { historyListId, historyMembers } = opts;
  const fail = (step: Extract<ListApplyResult, { status: "failed" }>["step"], e: unknown): ListApplyResult => ({
    listId: cand.listId,
    name: cand.name,
    status: "failed",
    step,
    error: errMsg(e),
  });

  // (a) membros + snapshot
  let emails: string[];
  try {
    emails = [...new Set((await client.listContacts(cand.listId)).map(normEmail).filter(Boolean))].sort();
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
    if (!back || back.listId !== cand.listId || !Array.isArray(back.emails) || back.emails.length !== emails.length) {
      throw new Error(
        `snapshot relido não confere (esperado ${emails.length} e-mails, lido ${back?.emails?.length ?? "nada"})`,
      );
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
      const res = await client.addToList(historyListId, batch);
      for (const e of res.success) {
        const n = normEmail(e);
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
  // Amostra por GET de contato — não confiar só no 2xx/`success` do POST.
  try {
    for (const e of added.slice(0, SPOT_CHECK_SAMPLE)) {
      if (!(await client.contactInList(e, historyListId))) {
        throw new Error(`${e} não aparece na lista de histórico ${historyListId} após o add`);
      }
    }
  } catch (e) {
    return fail("verify", e);
  }

  // (c) só agora: DELETE
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
  const queue = opts.limit !== undefined ? candidates.slice(0, opts.limit) : candidates;
  const results: ListApplyResult[] = [];
  let failures = 0;
  for (const cand of queue) {
    const r = await consolidateOneList(cand, client, opts);
    results.push(r);
    if (r.status === "deleted") {
      log(`✅ lista ${r.listId} (${r.name}): ${r.emails} e-mail(s) arquivados, ${r.added} novo(s) no histórico, apagada.`);
    } else {
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
