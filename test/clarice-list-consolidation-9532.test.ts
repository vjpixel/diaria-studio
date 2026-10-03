/**
 * clarice-list-consolidation-9532.test.ts (#9532)
 *
 * Teto de 300 listas na conta Brevo da Clarice. Consolidação: membros das
 * listas de campanhas enviadas antigas (ciclo fechado) vão pra uma lista de
 * HISTÓRICO única, o guard por contato (#7406/#3682) passa a ler esse id
 * como "comprometido", e só então a lista original é apagada. Cobertura:
 *   - seleção de candidatas (idade, ciclo fechado, allowlist de nome, refs)
 *   - pré-condições do --apply
 *   - ordem contagem → snapshot → add → marcador → delete; falha em qualquer
 *     passo (inclusive truncamento, 404, re-checagem) não apaga
 *   - guard: id de histórico entra em `committed`, nunca em `queued`;
 *     `list_id: null` mantém o comportamento anterior
 *   - config malformado / marcador `consolidated_at` falham alto
 *   - fallback de nome de lista apagada no plan-wave
 *   - varredura paginada completa (404 / count divergente abortam)
 * Zero rede: cliente fake + `fetch` mockado.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planListConsolidation,
  applyListConsolidation,
  checkApplyPreconditions,
  isCampaignListName,
  isListCycleClosed,
  archivedListsInWindow,
  BREVO_LIST_CAP,
  ADD_BATCH_SIZE,
  HISTORY_LIST_NAME,
  type ApplyPreconditionInput,
  type ConsolidationCampaign,
  type ConsolidationClient,
  type ConsolidationList,
  type CandidateList,
  type ListArchiveSnapshot,
  type ListApplyResult,
  listMemberCount,
} from "../scripts/lib/clarice-list-consolidation.ts";
import {
  parseClariceListHistoryConfig,
  loadClariceListHistoryConfig,
  insertConsolidatedAt,
  __setClariceHistoryListIdOverrideForTests,
} from "../scripts/lib/clarice-list-history-config.ts";
import { fetchQueuedAndCommittedCampaignListIds, fetchCommittedCampaignListIds } from "../scripts/lib/brevo-client.ts";
import { buildDailySendQueue } from "../scripts/lib/clarice-segment.ts";
import { collectConfiguredListIds, paginateComplete, makeBrevoConsolidationClient } from "../scripts/clarice-consolidate-lists.ts";
import { enrichWithLists } from "../scripts/clarice-plan-wave.ts";

const NOW = new Date("2026-10-03T12:00:00Z"); // ciclo esperado: 2609-10
const OLD = "2026-06-10T10:00:00Z"; // > 45 dias, mês fechado
const RECENT = "2026-09-25T10:00:00Z"; // < 45 dias

const HISTORY = 900;

function l(id: number, subs = 10, name = `Clarice 2605-06 d${id}`): ConsolidationList {
  return { id, name, uniqueSubscribers: subs };
}
function c(id: number, status: string, lists: number[], sentDate: string | null = null, exclusionLists: number[] = []): ConsolidationCampaign {
  return { id, status, sentDate, recipients: { lists, exclusionLists } };
}

function plan(lists: ConsolidationList[], campaigns: ConsolidationCampaign[], protectedIds: number[] = [], minAgeDays = 45) {
  return planListConsolidation({
    lists,
    campaigns,
    historyListId: HISTORY,
    protectedListIds: new Set(protectedIds),
    minAgeDays,
    now: NOW,
  });
}
function verdictOf(p: ReturnType<typeof plan>, id: number) {
  return p.per_list.find((x) => x.listId === id)?.verdict;
}

describe("planListConsolidation (#9532)", () => {
  it("sent antigo, ciclo fechado, nome conhecido → candidata; contagem de livres", () => {
    const p = plan([l(1, 7), l(2)], [c(10, "sent", [1], OLD)]);
    assert.equal(verdictOf(p, 1), "candidate");
    assert.deepEqual(p.candidates.map((x) => x.listId), [1]);
    assert.equal(p.candidates[0].subscribers, 7);
    assert.deepEqual(p.candidates[0].campaignIds, [10]);
    assert.equal(p.lists_after, 1);
    assert.equal(p.free_after, BREVO_LIST_CAP - 1);
    assert.equal(p.current_cycle, "2609-10");
  });

  it("archive conta como terminal", () => {
    assert.equal(verdictOf(plan([l(1)], [c(10, "archive", [1], OLD)]), 1), "candidate");
  });

  it("sent recente ✗ — mesmo que outra campanha antiga também a use", () => {
    const p = plan([l(1)], [c(10, "sent", [1], OLD), c(11, "sent", [1], RECENT)]);
    assert.equal(verdictOf(p, 1), "recent-sent");
    assert.equal(p.candidates.length, 0);
  });

  it("ciclo da lista ainda aberto ✗ mesmo com envio antigo (summarizeCycleSends depende do nome)", () => {
    const p = plan([l(1, 5, "Clarice 2609-10 d1-ter01 — onda unica")], [c(10, "sent", [1], OLD)], [], 1);
    assert.equal(verdictOf(p, 1), "open-cycle");
  });

  it("isListCycleClosed: ciclo no nome compara com o esperado; sem ciclo usa o mês do sentDate", () => {
    assert.equal(isListCycleClosed("Clarice 2608-09 d1", [], NOW), true);
    assert.equal(isListCycleClosed("Clarice 2609-10 d1", [], NOW), false);
    assert.equal(isListCycleClosed("Clarice Novos 30/09 (novos-260930)", ["2026-09-30T12:00:00Z"], NOW), true);
    assert.equal(isListCycleClosed("Clarice Novos 01/10 (novos-261001)", ["2026-10-01T12:00:00Z"], NOW), false);
    assert.equal(isListCycleClosed("Clarice Novos 01/10 (novos-261001)", ["lixo"], NOW), false);
  });

  it("referenciada por queued (ou qualquer não-terminal / status desconhecido) ✗", () => {
    for (const status of ["queued", "draft", "in_process", "suspended", "in_review", "algo-novo"]) {
      const p = plan([l(1)], [c(10, "sent", [1], OLD), c(11, status, [1])]);
      assert.equal(verdictOf(p, 1), "non-terminal-ref", status);
    }
  });

  it("exclusionList de campanha queued ✗", () => {
    const p = plan([l(1)], [c(10, "sent", [1], OLD), c(11, "queued", [2], null, [1])]);
    assert.equal(verdictOf(p, 1), "non-terminal-ref");
  });

  it("só exclusão de campanha enviada ✗ — membros NÃO receberam, não podem ir pro histórico", () => {
    const p = plan([l(1)], [c(10, "sent", [2], OLD, [1])]);
    assert.equal(verdictOf(p, 1), "exclusion-only");
  });

  it("exclusão de campanha enviada RECENTE também segura a lista", () => {
    const p = plan([l(1)], [c(10, "sent", [1], OLD), c(11, "sent", [2], RECENT, [1])]);
    assert.equal(verdictOf(p, 1), "recent-sent");
  });

  it("lista de histórico ✗, protegida ✗, sem campanha ✗, sentDate ausente ✗", () => {
    const p = plan(
      [l(HISTORY), l(7), l(3), l(4)],
      [c(10, "sent", [HISTORY, 7], OLD), c(11, "sent", [4], null)],
      [7],
    );
    assert.equal(verdictOf(p, HISTORY), "history");
    assert.equal(verdictOf(p, 7), "protected");
    assert.equal(verdictOf(p, 3), "no-campaign");
    assert.equal(verdictOf(p, 4), "sent-without-date");
    assert.equal(p.candidates.length, 0);
    assert.equal(p.verdict_counts["no-campaign"], 1);
  });

  it("allowlist: nome fora dos padrões de lista de campanha vira unmatched-name e é listado", () => {
    const p = plan([l(1, 3, "Supressão manual"), l(2, 3, "T1-W2 (top 100)")], [c(10, "sent", [1, 2], OLD)]);
    assert.equal(verdictOf(p, 1), "unmatched-name");
    assert.equal(verdictOf(p, 2), "candidate");
    assert.deepEqual(p.unmatched_names, [{ listId: 1, name: "Supressão manual" }]);
  });

  it("allowlist cobre os formatos reais medidos no dry-run", () => {
    for (const n of [
      "T1-W1 (top 50)",
      "Clarice Novos 19/09 (novos-260919) novos — Novos (cadastro recente)",
      "Clarice Novos 31/07 novos — Novos (cadastro recente)",
      "Clarice 2608-09 d3-qui03-C — célula C",
      "Clarice News 2606-07 C (A/B/C assunto)",
      "2606-07 cold d1",
      "cold 2606-07 sab-C",
      "Clarice Jun/2026 d03-C (sex)",
      "Diar.ia Mensal 2606 — envio 9 (ramp-warm sex 24/07)",
      "Clarice 1º envio seguro (2) ramp-warm-envio2 — Ramp warm envio 2 (dom)",
      "Clarice Ramp warm envio 11 (ter 28/07) ramp-warm — Ramp warm (1º envio seguro)",
      "Clarice assinantes novos jul-2026 (1o envio) #3819",
      "Clarice Score 0/-20 260915 score0-neg20-260915 — Waterfall multi-tier (score0-neg20-260915)",
      "Clarice Orfaos set orfaos-notsent-260915 — Órfãos CSV score=0 sem envio em setembro (#8117)",
    ]) {
      assert.equal(isCampaignListName(n), true, n);
    }
    for (const n of ["Teste", "Pixel", "identified_contacts", "Contatos envolvidos em conversas", HISTORY_LIST_NAME]) {
      assert.equal(isCampaignListName(n), false, n);
    }
  });

  it("candidatas saem ordenadas da mais antiga pra mais nova (--limit apaga as mais antigas)", () => {
    const p = plan([l(1), l(2)], [c(10, "sent", [1], "2026-07-20T00:00:00Z"), c(11, "sent", [2], "2026-06-01T00:00:00Z")]);
    assert.deepEqual(p.candidates.map((x) => x.listId), [2, 1]);
  });
});

// ---------------------------------------------------------------------------

describe("checkApplyPreconditions (#9532)", () => {
  const ok: ApplyPreconditionInput = {
    configListId: 313,
    guardListId: 313,
    configDirty: false,
    masterListId: 313,
    dataDirExists: true,
    historyListName: HISTORY_LIST_NAME,
  };
  it("tudo certo → sem erro", () => {
    assert.deepEqual(checkApplyPreconditions(ok), []);
  });
  it("list_id null recusa", () => {
    assert.match(checkApplyPreconditions({ ...ok, configListId: null }).join(), /null/);
  });
  it("nome errado da lista de histórico recusa", () => {
    assert.match(checkApplyPreconditions({ ...ok, historyListName: "Teste" }).join(), /esperado/);
  });
  it("data/ ausente recusa", () => {
    assert.match(checkApplyPreconditions({ ...ok, dataDirExists: false }).join(), /data\//);
  });
  it("config divergente do guard / não commitado / diferente do master recusa", () => {
    assert.match(checkApplyPreconditions({ ...ok, guardListId: 999 }).join(), /guard/);
    assert.match(checkApplyPreconditions({ ...ok, configDirty: true }).join(), /não commitada/);
    assert.match(checkApplyPreconditions({ ...ok, masterListId: null }).join(), /origin\/master/);
    assert.match(checkApplyPreconditions({ ...ok, masterListId: undefined }).join(), /origin\/master/);
  });
});

// ---------------------------------------------------------------------------

function cand(listId: number): CandidateList {
  return { listId, name: `lista-${listId}`, campaignIds: [10], sentDates: [OLD], subscribers: 0, lastSentAt: OLD };
}

interface FakeOpts {
  members?: Record<number, string[]>;
  counts?: Record<number, number>;
  contactsThrows?: boolean;
  addFails?: boolean;
  addReportsFailure?: boolean;
  addConfirmsForeign?: boolean;
  snapshotFails?: boolean;
  snapshotCorrupts?: boolean;
  spotCheckFalse?: boolean;
  deleteFails?: boolean;
  nonTerminalRefs?: number[][];
  recheckFails?: boolean;
}

function fakeClient(o: FakeOpts = {}) {
  const calls: string[] = [];
  const snapshots = new Map<number, ListArchiveSnapshot>();
  const inHistory = new Set<string>();
  let recheck = 0;
  const client: ConsolidationClient = {
    async getListCount(id) {
      calls.push(`count:${id}`);
      return o.counts?.[id] ?? (o.members?.[id] ?? []).length;
    },
    async listContacts(id) {
      calls.push(`contacts:${id}`);
      if (o.contactsThrows) throw new Error("Brevo API GET /contacts/lists/1/contacts falhou (404)");
      return o.members?.[id] ?? [];
    },
    async writeSnapshot(s) {
      calls.push(`snapshot:${s.listId}`);
      if (o.snapshotFails) throw new Error("disco cheio");
      snapshots.set(s.listId, o.snapshotCorrupts ? { ...s, emails: s.emails.map(() => "x@x") } : s);
    },
    async readSnapshot(id) {
      return snapshots.get(id) ?? null;
    },
    async addToList(id, emails) {
      calls.push(`add:${id}:${emails.length}`);
      if (o.addFails) throw new Error("HTTP 500");
      if (o.addReportsFailure) return { success: [], failure: emails };
      if (o.addConfirmsForeign) return { success: [...emails, "intruso@x.com"], failure: [] };
      emails.forEach((e) => inHistory.add(e));
      return { success: emails, failure: [] };
    },
    async contactInList(email) {
      calls.push(`verify:${email}`);
      return o.spotCheckFalse ? false : inHistory.has(email);
    },
    async fetchNonTerminalListRefs() {
      calls.push("recheck");
      if (o.recheckFails) throw new Error("cota baixa");
      return new Set(o.nonTerminalRefs?.[recheck++] ?? []);
    },
    async markConsolidated() {
      calls.push("mark");
    },
    async deleteList(id) {
      calls.push(`delete:${id}`);
      if (o.deleteFails) throw new Error("HTTP 500");
    },
  };
  return { client, calls, snapshots };
}

function opts(historyMembers = new Set<string>(), extra: Partial<Parameters<typeof applyListConsolidation>[2]> = {}) {
  return { historyListId: HISTORY, historyMembers, protectedListIds: new Set<number>([7]), now: () => NOW, ...extra };
}
const failStep = (r: ListApplyResult) => (r.status === "failed" ? r.step : r.status);

describe("applyListConsolidation (#9532) — contagem → snapshot → add → marcador → delete", () => {
  it("ordem estrita; marcador gravado UMA vez antes do 1º DELETE", async () => {
    const { client, calls, snapshots } = fakeClient({ members: { 1: ["B@x.com", "a@x.com"], 2: ["c@x.com"] } });
    const res = await applyListConsolidation([cand(1), cand(2)], client, opts());
    assert.deepEqual(res.map((r) => r.status), ["deleted", "deleted"]);
    assert.deepEqual(calls, [
      "recheck",
      "count:1", "contacts:1", "snapshot:1", `add:${HISTORY}:2`, "verify:a@x.com", "verify:b@x.com", "mark", "delete:1",
      "count:2", "contacts:2", "snapshot:2", `add:${HISTORY}:1`, "verify:c@x.com", "delete:2",
    ]);
    assert.deepEqual(snapshots.get(1)?.emails, ["a@x.com", "b@x.com"]);
    assert.equal(snapshots.get(1)?.history_list_id, HISTORY);
  });

  it("onResult recebe cada resultado na hora", async () => {
    const seen: string[] = [];
    const { client } = fakeClient({ members: { 1: ["a@x.com"] } });
    await applyListConsolidation([cand(1)], client, opts(new Set(), { onResult: (r) => seen.push(r.status) }));
    assert.deepEqual(seen, ["deleted"]);
  });

  it("membros truncados vs totalSubscribers NÃO apaga (contacts)", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x.com"] }, counts: { 1: 2 } });
    const [r] = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(failStep(r), "contacts");
    assert.ok(!calls.some((x) => x.startsWith("snapshot") || x.startsWith("delete")));
  });

  it("lista vazia com totalSubscribers>0 NÃO apaga", async () => {
    const { client } = fakeClient({ members: { 1: [] }, counts: { 1: 5 } });
    const [r] = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(failStep(r), "contacts");
  });

  it("404 ao listar membros NÃO apaga", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x.com"] }, contactsThrows: true });
    const [r] = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(failStep(r), "contacts");
    assert.ok(!calls.some((x) => x.startsWith("delete")));
  });

  it("falha no add NÃO apaga", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x.com"] }, addFails: true });
    const [r] = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(failStep(r), "add");
    assert.ok(!calls.some((x) => x.startsWith("delete") || x === "mark"));
  });

  it("add 2xx com e-mails em `failure` (não confirmados) NÃO apaga", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x.com"] }, addReportsFailure: true });
    const [r] = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(failStep(r), "add");
    assert.ok(!calls.some((x) => x.startsWith("delete")));
  });

  it("`success` com e-mail fora do lote enviado NÃO apaga", async () => {
    const { client } = fakeClient({ members: { 1: ["a@x.com"] }, addConfirmsForeign: true });
    const [r] = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(failStep(r), "add");
  });

  it("e-mail já no histórico conta como confirmado (não re-adiciona, não entra na amostra)", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x.com"] } });
    const [r] = await applyListConsolidation([cand(1)], client, opts(new Set(["a@x.com"])));
    assert.equal(r.status, "deleted");
    assert.ok(!calls.some((x) => x.startsWith("add") || x.startsWith("verify")));
  });

  it("falha no snapshot NÃO adiciona nem apaga", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x.com"] }, snapshotFails: true });
    const [r] = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(failStep(r), "snapshot");
    assert.deepEqual(calls, ["recheck", "count:1", "contacts:1", "snapshot:1"]);
  });

  it("snapshot relido com CONTEÚDO diferente (mesma contagem) NÃO segue", async () => {
    const { client } = fakeClient({ members: { 1: ["a@x.com"] }, snapshotCorrupts: true });
    const [r] = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(failStep(r), "snapshot");
  });

  it("verificação por GET de contato negativa NÃO apaga", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x.com"] }, spotCheckFalse: true });
    const [r] = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(failStep(r), "verify");
    assert.ok(!calls.some((x) => x.startsWith("delete")));
  });

  it("DELETE que falha vira resultado failed/delete (não lança)", async () => {
    const { client } = fakeClient({ members: { 1: ["a@x.com"] }, deleteFails: true });
    const [r] = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(failStep(r), "delete");
  });

  it("re-checagem: lista que passou a ser referenciada por campanha não-terminal é pulada", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x"], 2: ["b@x"] }, nonTerminalRefs: [[2]] });
    const res = await applyListConsolidation([cand(1), cand(2)], client, opts());
    assert.deepEqual(res.map((r) => r.status), ["deleted", "skipped"]);
    assert.ok(!calls.includes("delete:2"));
  });

  it("re-checagem roda a cada N listas e falha nela para tudo", async () => {
    const a = fakeClient({ members: { 1: ["a@x"], 2: ["b@x"], 3: ["c@x"] } });
    await applyListConsolidation([cand(1), cand(2), cand(3)], a.client, opts(new Set(), { recheckEvery: 2 }));
    assert.equal(a.calls.filter((x) => x === "recheck").length, 2);
    const b = fakeClient({ members: { 1: ["a@x"] }, recheckFails: true });
    const res = await applyListConsolidation([cand(1)], b.client, opts());
    assert.equal(failStep(res[0]), "recheck");
    assert.ok(!b.calls.some((x) => x.startsWith("delete")));
  });

  it("asserção: nunca processa a lista de histórico nem lista protegida", async () => {
    const { client } = fakeClient({});
    await assert.rejects(() => applyListConsolidation([cand(HISTORY)], client, opts()), /histórico/);
    await assert.rejects(() => applyListConsolidation([cand(7)], client, opts()), /protegida/);
  });

  it(`add em lotes de ≤${ADD_BATCH_SIZE}`, async () => {
    const emails = Array.from({ length: 320 }, (_, i) => `u${String(i).padStart(3, "0")}@x.com`);
    const { client, calls } = fakeClient({ members: { 1: emails } });
    await applyListConsolidation([cand(1)], client, opts());
    assert.deepEqual(calls.filter((x) => x.startsWith("add")), [`add:${HISTORY}:150`, `add:${HISTORY}:150`, `add:${HISTORY}:20`]);
  });

  it("--limit processa só as N primeiras; para após 3 falhas", async () => {
    const a = fakeClient({});
    const r1 = await applyListConsolidation([cand(1), cand(2), cand(3)], a.client, opts(new Set(), { limit: 2 }));
    assert.equal(r1.length, 2);
    const b = fakeClient({ members: { 1: ["a@x"], 2: ["b@x"], 3: ["c@x"], 4: ["d@x"] }, addFails: true });
    const r2 = await applyListConsolidation([cand(1), cand(2), cand(3), cand(4)], b.client, opts());
    assert.equal(r2.length, 3);
  });
});

// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
  } as unknown as Response);
}

async function withFetch<T>(impl: (u: string) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => impl(String(url))) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}
const campaignsFetch = (u: string) =>
  u.includes("status=queued")
    ? jsonResponse({ campaigns: [{ id: 1, recipients: { lists: [11] } }] })
    : jsonResponse({ campaigns: [{ id: 2, recipients: { lists: [22] } }] });

describe("guard committed × lista de histórico (#9532)", () => {
  after(() => __setClariceHistoryListIdOverrideForTests(undefined));

  it("list_id configurado → entra em committed, NUNCA em queued", async () => {
    __setClariceHistoryListIdOverrideForTests(HISTORY);
    const { queued, committed } = await withFetch(campaignsFetch, () => fetchQueuedAndCommittedCampaignListIds("k"));
    assert.deepEqual([...queued].sort(), ["11"]);
    assert.deepEqual([...committed].sort(), ["11", "22", String(HISTORY)]);
    const viaWrapper = await withFetch(campaignsFetch, () => fetchCommittedCampaignListIds("k"));
    assert.ok(viaWrapper.has(String(HISTORY)), "fetchCommittedCampaignListIds herda o id de histórico");

    // Ponta a ponta no guard por contato: lista original apagada, contato só
    // no histórico. Sem histórico (sends_count=0) é barrado; com histórico
    // de envio continua elegível pra re-envio (eixo queued).
    const base = {
      send_eligible: 1,
      priority_points: 0,
      mv_bucket: "verified",
      cohort: null,
      created: "2026-01-01",
      brevo_list_ids: JSON.stringify([HISTORY]),
    };
    const rows = [
      { ...base, email: "nunca@x.com", sends_count: 0 },
      { ...base, email: "ja@x.com", sends_count: 2 },
    ];
    const emails = (xs: { email: string }[]) => xs.map((r) => r.email).sort();
    const semHistorico = new Set([...committed].filter((id) => id !== String(HISTORY)));
    // Controle: sem o id de histórico os dois passariam (o bug que a #9532 evita).
    assert.deepEqual(
      emails(buildDailySendQueue(rows as never, { queuedListIds: queued, committedListIds: semHistorico })),
      ["ja@x.com", "nunca@x.com"],
    );
    assert.deepEqual(
      emails(buildDailySendQueue(rows as never, { queuedListIds: queued, committedListIds: committed })),
      ["ja@x.com"],
    );
  });

  it("list_id: null → comportamento anterior (queued ∪ sent, sem id extra)", async () => {
    __setClariceHistoryListIdOverrideForTests(null);
    const { committed } = await withFetch(campaignsFetch, () => fetchQueuedAndCommittedCampaignListIds("k"));
    assert.deepEqual([...committed].sort(), ["11", "22"]);
  });
});

describe("clarice_list_history config (#9532)", () => {
  it("config real do repo é válido, com piso de 45 dias", () => {
    const cfg = loadClariceListHistoryConfig();
    assert.ok(cfg.listId === null || (Number.isInteger(cfg.listId) && cfg.listId > 0));
    assert.ok(cfg.minAgeDays >= 45);
  });

  it("list_id null aceito", () => {
    assert.deepEqual(parseClariceListHistoryConfig({ list_id: null, min_age_days: 45 }), {
      listId: null,
      minAgeDays: 45,
      consolidatedAt: null,
    });
  });

  it("bloco ausente/malformado falha ALTO (nunca encolhe o guard em silêncio)", () => {
    assert.throws(() => parseClariceListHistoryConfig(undefined), /ausente/);
    assert.throws(() => parseClariceListHistoryConfig({}), /list_id/);
    assert.throws(() => parseClariceListHistoryConfig({ list_id: "313", min_age_days: 45 }), /inválido/);
    assert.throws(() => parseClariceListHistoryConfig({ list_id: 0, min_age_days: 45 }), /inválido/);
    assert.throws(() => parseClariceListHistoryConfig({ list_id: 1 }), /min_age_days.*ausente/);
    assert.throws(() => parseClariceListHistoryConfig({ list_id: 1, min_age_days: 14 }), /≥ 45/);
    assert.throws(() => parseClariceListHistoryConfig([]), /objeto/);
  });

  it("marcador consolidated_at: list_id null passa a ser rejeitado", () => {
    assert.throws(
      () => parseClariceListHistoryConfig({ list_id: null, min_age_days: 45, consolidated_at: "2026-10-04T00:00:00Z" }),
      /consolidated_at/,
    );
    assert.equal(
      parseClariceListHistoryConfig({ list_id: 313, min_age_days: 45, consolidated_at: "2026-10-04T00:00:00Z" }).consolidatedAt,
      "2026-10-04T00:00:00Z",
    );
    assert.throws(() => parseClariceListHistoryConfig({ list_id: 313, min_age_days: 45, consolidated_at: "ontem" }), /ISO/);
  });

  it("insertConsolidatedAt edita só o bloco, preserva o resto do arquivo e é idempotente", () => {
    // Fixtures derivadas do config real mas independentes do list_id que estiver
    // commitado nele (null antes de configurar, numérico depois — #9540).
    const real = readFileSync(join(import.meta.dirname, "..", "platform.config.json"), "utf8");
    const listIdRe = /("clarice_list_history":\s*\{\s*\n\s*"list_id":\s*)(null|\d+)/;
    assert.match(real, listIdRe, "bloco clarice_list_history com list_id no formato esperado");
    const withNull = real.replace(listIdRe, "$1null");
    const withId = real.replace(listIdRe, "$1313");
    const out = insertConsolidatedAt(withId, "2026-10-04T00:00:00.000Z");
    assert.equal(out.split("\n").length, withId.split("\n").length + 1);
    assert.equal(loadFromText(out).consolidatedAt, "2026-10-04T00:00:00.000Z");
    assert.equal(insertConsolidatedAt(out, "2027-01-01T00:00:00.000Z"), out);
    assert.throws(() => insertConsolidatedAt(withNull, "2026-10-04T00:00:00.000Z"), /formato/); // list_id null
  });

  it("arquivo ilegível/JSON quebrado falha alto", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-9532-"));
    try {
      const bad = join(dir, "platform.config.json");
      writeFileSync(bad, "{ nope");
      assert.throws(() => loadClariceListHistoryConfig(bad), /JSON/);
      assert.throws(() => loadClariceListHistoryConfig(join(dir, "nao-existe.json")), /ler/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collectConfiguredListIds protege todo list_id numérico do config", () => {
    const ids = collectConfiguredListIds({ a: { list_id: 7 }, b: { x: { d10_list_id: 9 } }, c: { list_id: null }, d: [{ list_id: 8 }] });
    assert.deepEqual([...ids].sort(), [7, 8, 9]);
  });
});

function loadFromText(text: string) {
  return parseClariceListHistoryConfig((JSON.parse(text) as Record<string, unknown>).clarice_list_history);
}

describe("varredura paginada completa (#9532)", () => {
  it("404 aborta", async () => {
    await assert.rejects(
      () => paginateComplete(async () => ({ status: 404, body: {} }), "/emailCampaigns", "campaigns", 100),
      /404/,
    );
  });
  it("total coletado ≠ count aborta", async () => {
    await assert.rejects(
      () => paginateComplete(async () => ({ status: 200, body: { lists: [{ id: 1 }], count: 2 } }), "/contacts/lists", "lists", 50),
      /count/,
    );
  });
  it("pagina até a página incompleta e confere count", async () => {
    const pages = [Array.from({ length: 2 }, (_, i) => ({ id: i })), [{ id: 9 }]];
    let n = 0;
    const out = await paginateComplete(async () => ({ status: 200, body: { lists: pages[n++], count: 3 } }), "/contacts/lists", "lists", 2);
    assert.equal(out.length, 3);
  });
  it("status vazio ({campaigns: [], count: 0}, formato medido ao vivo) passa", async () => {
    const out = await paginateComplete(async () => ({ status: 200, body: { campaigns: [], count: 0 } }), "/emailCampaigns?status=inReview", "campaigns", 100);
    assert.deepEqual(out, []);
  });
});

describe("listas apagadas: snapshot como fonte de nome (#9532)", () => {
  it("plan-wave usa o nome do snapshot quando a lista devolve 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archive-9532-"));
    try {
      writeFileSync(
        join(dir, "55.json"),
        JSON.stringify({ listId: 55, name: "Clarice 2608-09 d3-qui03-C — célula C", emails: ["a@x", "b@x"], sentDates: [OLD] }),
      );
      const out = await withFetch(
        (u) => (u.includes("/contacts/lists/55") ? jsonResponse({ code: "document_not_found" }, 404) : jsonResponse({ name: "viva", totalSubscribers: 4 })),
        () =>
          enrichWithLists(
            "k",
            [
              { id: 1, name: "c1", recipients: { lists: [55] } },
              { id: 2, name: "c2", recipients: { lists: [56] } },
            ] as never,
            dir,
          ),
      );
      assert.equal(out[0].listName, "Clarice 2608-09 d3-qui03-C — célula C");
      assert.equal(out[0].listSize, 2);
      assert.equal(out[1].listName, "viva");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auditoria #7880: snapshot com envio dentro da janela é reportado", () => {
    const dir = mkdtempSync(join(tmpdir(), "archive-9532-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "1.json"), JSON.stringify({ listId: 1, name: "jun", emails: [], sentDates: ["2026-06-10T10:00:00Z"] }));
      writeFileSync(join(dir, "2.json"), JSON.stringify({ listId: 2, name: "ago", emails: [], sentDates: ["2026-08-10T10:00:00Z"] }));
      assert.deepEqual(archivedListsInWindow(dir, "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z"), [{ listId: 1, name: "jun" }]);
      assert.deepEqual(archivedListsInWindow(join(dir, "nao-existe"), "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z"), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listMemberCount — contagem de membros comparável ao /contacts (#9532, achado ao vivo 03/10)", () => {
  it("usa uniqueSubscribers: lista 9 real (49 + 1 blacklistado = 50) não é 'truncada'", () => {
    assert.equal(listMemberCount({ totalSubscribers: 49, totalBlacklisted: 1, uniqueSubscribers: 50 }), 50);
  });
  it("sem uniqueSubscribers, soma totalSubscribers + totalBlacklisted", () => {
    assert.equal(listMemberCount({ totalSubscribers: 49, totalBlacklisted: 1 }), 50);
    assert.equal(listMemberCount({ totalSubscribers: 12 }), 12);
  });
  it("uniqueSubscribers vence a soma quando divergem; NaN cai na soma; 0 é aceito", () => {
    assert.equal(listMemberCount({ totalSubscribers: 49, totalBlacklisted: 1, uniqueSubscribers: 48 }), 48);
    assert.equal(listMemberCount({ totalSubscribers: 49, totalBlacklisted: 1, uniqueSubscribers: Number.NaN }), 50);
    assert.equal(listMemberCount({ totalSubscribers: 0, totalBlacklisted: 0, uniqueSubscribers: 0 }), 0);
  });
  it("makeBrevoConsolidationClient.getListCount conta blacklistados (wiring real, fetch stubado)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 9, name: "T1-W1 (top 50)", totalSubscribers: 49, totalBlacklisted: 1, uniqueSubscribers: 50 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const client = makeBrevoConsolidationClient("k", tmpdir(), "/nao-usado.json");
      assert.equal(await client.getListCount(9), 50);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
