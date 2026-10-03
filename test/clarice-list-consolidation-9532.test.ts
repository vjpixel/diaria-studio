/**
 * clarice-list-consolidation-9532.test.ts (#9532)
 *
 * Teto de 300 listas na conta Brevo da Clarice. Consolidação: membros das
 * listas de campanhas `sent` antigas vão pra uma lista de HISTÓRICO única, o
 * guard por contato (#7406/#3682) passa a ler esse id como "comprometido", e
 * só então a lista original é apagada. Cobertura:
 *   - seleção de candidatas (planListConsolidation)
 *   - ordem snapshot → add → delete, e falha em qualquer passo não apaga
 *   - guard: id de histórico entra em `committed`, nunca em `queued`;
 *     `list_id: null` mantém o comportamento anterior
 *   - config malformado falha alto
 * Zero rede: cliente fake + `fetch` mockado.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planListConsolidation,
  applyListConsolidation,
  BREVO_LIST_CAP,
  ADD_BATCH_SIZE,
  type ConsolidationCampaign,
  type ConsolidationClient,
  type ConsolidationList,
  type CandidateList,
  type ListArchiveSnapshot,
} from "../scripts/lib/clarice-list-consolidation.ts";
import {
  parseClariceListHistoryConfig,
  loadClariceListHistoryConfig,
  __setClariceHistoryListIdOverrideForTests,
} from "../scripts/lib/clarice-list-history-config.ts";
import { fetchQueuedAndCommittedCampaignListIds, fetchCommittedCampaignListIds } from "../scripts/lib/brevo-client.ts";
import { buildDailySendQueue } from "../scripts/lib/clarice-segment.ts";
import { collectConfiguredListIds } from "../scripts/clarice-consolidate-lists.ts";

const NOW = new Date("2026-10-03T12:00:00Z");
const OLD = "2026-08-01T10:00:00Z"; // > 14 dias
const RECENT = "2026-09-30T10:00:00Z"; // < 14 dias

const HISTORY = 900;

function l(id: number, subs = 10): ConsolidationList {
  return { id, name: `lista-${id}`, uniqueSubscribers: subs };
}
function c(id: number, status: string, lists: number[], sentDate: string | null = null, exclusionLists: number[] = []): ConsolidationCampaign {
  return { id, status, sentDate, recipients: { lists, exclusionLists } };
}

function plan(lists: ConsolidationList[], campaigns: ConsolidationCampaign[], protectedIds: number[] = []) {
  return planListConsolidation({
    lists,
    campaigns,
    historyListId: HISTORY,
    protectedListIds: new Set(protectedIds),
    minAgeDays: 14,
    now: NOW,
  });
}
function verdictOf(p: ReturnType<typeof plan>, id: number) {
  return p.per_list.find((x) => x.listId === id)?.verdict;
}

describe("planListConsolidation (#9532)", () => {
  it("sent antigo → candidata; contagem de livres sob o teto", () => {
    const p = plan([l(1, 7), l(2)], [c(10, "sent", [1], OLD)]);
    assert.equal(verdictOf(p, 1), "candidate");
    assert.deepEqual(p.candidates.map((x) => x.listId), [1]);
    assert.equal(p.candidates[0].subscribers, 7);
    assert.deepEqual(p.candidates[0].campaignIds, [10]);
    assert.equal(p.lists_after, 1);
    assert.equal(p.free_after, BREVO_LIST_CAP - 1);
  });

  it("archive conta como terminal", () => {
    assert.equal(verdictOf(plan([l(1)], [c(10, "archive", [1], OLD)]), 1), "candidate");
  });

  it("sent recente ✗ — mesmo que outra campanha antiga também a use", () => {
    const p = plan([l(1)], [c(10, "sent", [1], OLD), c(11, "sent", [1], RECENT)]);
    assert.equal(verdictOf(p, 1), "recent-sent");
    assert.equal(p.candidates.length, 0);
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

  it("candidatas saem ordenadas da mais antiga pra mais nova (--limit apaga as mais antigas)", () => {
    const p = plan([l(1), l(2)], [c(10, "sent", [1], "2026-08-20T00:00:00Z"), c(11, "sent", [2], "2026-06-01T00:00:00Z")]);
    assert.deepEqual(p.candidates.map((x) => x.listId), [2, 1]);
  });
});

// ---------------------------------------------------------------------------

function cand(listId: number): CandidateList {
  return { listId, name: `lista-${listId}`, campaignIds: [10], sentDates: [OLD], subscribers: 0, lastSentAt: OLD };
}

interface FakeOpts {
  members?: Record<number, string[]>;
  addFails?: boolean;
  addReportsFailure?: boolean;
  snapshotFails?: boolean;
  spotCheckFalse?: boolean;
}

function fakeClient(o: FakeOpts = {}) {
  const calls: string[] = [];
  const snapshots = new Map<number, ListArchiveSnapshot>();
  const inHistory = new Set<string>();
  const client: ConsolidationClient = {
    async listContacts(id) {
      calls.push(`contacts:${id}`);
      return o.members?.[id] ?? [];
    },
    async writeSnapshot(s) {
      calls.push(`snapshot:${s.listId}`);
      if (o.snapshotFails) throw new Error("disco cheio");
      snapshots.set(s.listId, s);
    },
    async readSnapshot(id) {
      return snapshots.get(id) ?? null;
    },
    async addToList(id, emails) {
      calls.push(`add:${id}:${emails.length}`);
      if (o.addFails) throw new Error("HTTP 500");
      if (o.addReportsFailure) return { success: [], failure: emails };
      emails.forEach((e) => inHistory.add(e));
      return { success: emails, failure: [] };
    },
    async contactInList(email) {
      calls.push(`verify:${email}`);
      return o.spotCheckFalse ? false : inHistory.has(email);
    },
    async deleteList(id) {
      calls.push(`delete:${id}`);
    },
  };
  return { client, calls, snapshots };
}

function opts(historyMembers = new Set<string>()) {
  return { historyListId: HISTORY, historyMembers, now: () => NOW };
}

describe("applyListConsolidation (#9532) — snapshot → add → delete", () => {
  it("ordem estrita: contatos, snapshot, add, verificação, delete", async () => {
    const { client, calls, snapshots } = fakeClient({ members: { 1: ["B@x.com", "a@x.com"] } });
    const res = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(res[0].status, "deleted");
    assert.deepEqual(calls, ["contacts:1", "snapshot:1", `add:${HISTORY}:2`, "verify:a@x.com", "verify:b@x.com", "delete:1"]);
    assert.deepEqual(snapshots.get(1)?.emails, ["a@x.com", "b@x.com"]);
    assert.equal(snapshots.get(1)?.history_list_id, HISTORY);
  });

  it("falha no add NÃO apaga", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x.com"] }, addFails: true });
    const res = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(res[0].status, "failed");
    assert.equal(res[0].status === "failed" && res[0].step, "add");
    assert.ok(!calls.some((x) => x.startsWith("delete")));
  });

  it("add 2xx com e-mails em `failure` (não confirmados) NÃO apaga", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x.com"] }, addReportsFailure: true });
    const res = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(res[0].status === "failed" && res[0].step, "add");
    assert.ok(!calls.some((x) => x.startsWith("delete")));
  });

  it("e-mail já no histórico conta como confirmado (não re-adiciona)", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x.com"] } });
    const res = await applyListConsolidation([cand(1)], client, opts(new Set(["a@x.com"])));
    assert.equal(res[0].status, "deleted");
    assert.ok(!calls.some((x) => x.startsWith("add")));
  });

  it("falha no snapshot NÃO adiciona nem apaga", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x.com"] }, snapshotFails: true });
    const res = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(res[0].status === "failed" && res[0].step, "snapshot");
    assert.deepEqual(calls, ["contacts:1", "snapshot:1"]);
  });

  it("verificação por GET de contato negativa NÃO apaga", async () => {
    const { client, calls } = fakeClient({ members: { 1: ["a@x.com"] }, spotCheckFalse: true });
    const res = await applyListConsolidation([cand(1)], client, opts());
    assert.equal(res[0].status === "failed" && res[0].step, "verify");
    assert.ok(!calls.some((x) => x.startsWith("delete")));
  });

  it(`add em lotes de ≤${ADD_BATCH_SIZE}`, async () => {
    const emails = Array.from({ length: 320 }, (_, i) => `u${String(i).padStart(3, "0")}@x.com`);
    const { client, calls } = fakeClient({ members: { 1: emails } });
    await applyListConsolidation([cand(1)], client, opts());
    assert.deepEqual(calls.filter((x) => x.startsWith("add")), [`add:${HISTORY}:150`, `add:${HISTORY}:150`, `add:${HISTORY}:20`]);
  });

  it("--limit processa só as N primeiras; para após 3 falhas", async () => {
    const a = fakeClient({});
    const r1 = await applyListConsolidation([cand(1), cand(2), cand(3)], a.client, { ...opts(), limit: 2 });
    assert.equal(r1.length, 2);
    const b = fakeClient({ members: { 1: ["a@x"], 2: ["b@x"], 3: ["c@x"], 4: ["d@x"] }, addFails: true });
    const r2 = await applyListConsolidation([cand(1), cand(2), cand(3), cand(4)], b.client, opts());
    assert.equal(r2.length, 3);
  });
});

// ---------------------------------------------------------------------------

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => "application/json" },
  } as unknown as Response);
}

async function withCampaignsFetch<T>(fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("status=queued")) return jsonResponse({ campaigns: [{ id: 1, recipients: { lists: [11] } }] });
    return jsonResponse({ campaigns: [{ id: 2, recipients: { lists: [22] } }] });
  }) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

describe("guard committed × lista de histórico (#9532)", () => {
  after(() => __setClariceHistoryListIdOverrideForTests(undefined));

  it("list_id configurado → entra em committed, NUNCA em queued", async () => {
    __setClariceHistoryListIdOverrideForTests(HISTORY);
    const { queued, committed } = await withCampaignsFetch(() => fetchQueuedAndCommittedCampaignListIds("k"));
    assert.deepEqual([...queued].sort(), ["11"]);
    assert.deepEqual([...committed].sort(), ["11", "22", String(HISTORY)]);
    const viaWrapper = await withCampaignsFetch(() => fetchCommittedCampaignListIds("k"));
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
    const { committed } = await withCampaignsFetch(() => fetchQueuedAndCommittedCampaignListIds("k"));
    assert.deepEqual([...committed].sort(), ["11", "22"]);
  });
});

describe("clarice_list_history config (#9532)", () => {
  it("config real do repo é válido", () => {
    const cfg = loadClariceListHistoryConfig();
    assert.ok(cfg.listId === null || (Number.isInteger(cfg.listId) && cfg.listId > 0));
    assert.equal(cfg.minAgeDays, 14);
  });

  it("list_id null aceito; min_age_days default 14", () => {
    assert.deepEqual(parseClariceListHistoryConfig({ list_id: null }), { listId: null, minAgeDays: 14 });
    assert.deepEqual(parseClariceListHistoryConfig({ list_id: 313, min_age_days: 30 }), { listId: 313, minAgeDays: 30 });
  });

  it("bloco ausente/malformado falha ALTO (nunca encolhe o guard em silêncio)", () => {
    assert.throws(() => parseClariceListHistoryConfig(undefined), /ausente/);
    assert.throws(() => parseClariceListHistoryConfig({}), /list_id/);
    assert.throws(() => parseClariceListHistoryConfig({ list_id: "313" }), /inválido/);
    assert.throws(() => parseClariceListHistoryConfig({ list_id: 0 }), /inválido/);
    assert.throws(() => parseClariceListHistoryConfig({ list_id: 1, min_age_days: 0 }), /min_age_days/);
    assert.throws(() => parseClariceListHistoryConfig([]), /objeto/);
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
