/**
 * test/kit-frio-residuos-11294.test.ts
 *
 * #11294 — resíduos do PR #11285 (frio do Kit + premissa B):
 *  1. cache por broadcast do engajamento no `sync-kit-frio.ts`;
 *  2. a semanal de frio já agendada acompanha o principal (reagenda/desagenda);
 *  3. o unlink da premissa B é relido antes de gravar `suppressed`;
 *  4. o estoque da premissa B é contado (e alarmado acima dos tetos).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildKitFrioEngagementCache,
  cachedBroadcastEngagement,
  isFreezableEngagement,
  parseKitFrioEngagementCache,
  type KitFrioEngagementCache,
} from "../scripts/lib/kit-frio-engagement-cache.ts";
import {
  KIT_SEM_ABERTURA_AGUARDANDO_FRIO_ALARM_COUNT,
  KIT_SEM_ABERTURA_AGUARDANDO_FRIO_ALARM_DAYS,
  summarizeAwaitingFrioBacklog,
  type KitFrioCandidate,
  type KitSemanalFrioPublished,
} from "../scripts/lib/kit-frio.ts";
import { runKitFrioSync, type KitFrioDeps } from "../scripts/sync-kit-frio.ts";
import { publishKitSemanalFrio, type SemanalFrioPublishDeps } from "../scripts/publish-kit-semanal-frio.ts";
import { runEvaluation, verifyUnlinkedFromBrevoList } from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";
import { buildTagFilter } from "../scripts/lib/kit-broadcasts.ts";
import type { DiariaBroadcastRecord } from "../scripts/lib/kit-sem-abertura.ts";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2027-02-01T12:00:00Z");

const cfgFrioOn = {
  kit: {
    frio: { enabled: true, semanal_enabled: true, segmento_exclui_frio_confirmado: true },
    diaria_exclusion_segment: { enabled: true, segment_id: 599796 },
  },
};

// ── 1. cache de engajamento do frio ──────────────────────────────────────

describe("cache de engajamento do frio (#11294 item 1)", () => {
  it("ida e volta: o cache devolve as mesmas listas (normalizadas), sem duplicar e-mails", () => {
    const cache = buildKitFrioEngagementCache([
      { broadcastId: 2, delivered: ["B@x.com", "a@x.com"], opens: ["a@x.com"], clicks: [] },
      { broadcastId: 1, delivered: ["a@x.com"], opens: [], clicks: ["a@x.com"] },
    ]);
    assert.deepEqual(cache.emails, ["a@x.com", "b@x.com"]);
    const parsed = parseKitFrioEngagementCache(JSON.parse(JSON.stringify(cache)));
    assert.ok(parsed);
    assert.deepEqual(cachedBroadcastEngagement(parsed, 2), { broadcastId: 2, delivered: ["a@x.com", "b@x.com"], opens: ["a@x.com"], clicks: [] });
    assert.deepEqual(cachedBroadcastEngagement(parsed, 1)?.clicks, ["a@x.com"]);
    assert.equal(cachedBroadcastEngagement(parsed, 3), null);
  });

  it("formato inválido ⇒ descartado (versão, índice fora da tabela, id não numérico)", () => {
    assert.equal(parseKitFrioEngagementCache(null), null);
    assert.equal(parseKitFrioEngagementCache({ version: 2, emails: [], broadcasts: {} }), null);
    assert.equal(parseKitFrioEngagementCache({ version: 1, emails: ["a@x.com"], broadcasts: { "1": { d: [1], o: [], c: [] } } }), null);
    assert.equal(parseKitFrioEngagementCache({ version: 1, emails: ["a@x.com"], broadcasts: { abc: { d: [0], o: [], c: [] } } }), null);
  });

  it("só congela com >= 7 dias E indexado (entregues + alguma abertura/clique)", () => {
    const ok = { broadcastId: 1, delivered: ["a@x.com"], opens: ["a@x.com"], clicks: [] };
    const old = new Date(NOW - 8 * DAY).toISOString();
    assert.equal(isFreezableEngagement(ok, old, NOW), true);
    assert.equal(isFreezableEngagement(ok, new Date(NOW - 6 * DAY).toISOString(), NOW), false, "novo demais");
    assert.equal(isFreezableEngagement({ ...ok, opens: [] }, old, NOW), false, "não indexado (#10787)");
    assert.equal(isFreezableEngagement({ ...ok, delivered: [] }, old, NOW), false);
  });

  // Registro: 1 diária antiga (madura) e 1 recente.
  const reg: DiariaBroadcastRecord[] = [
    { broadcastId: 1, sentAt: new Date(NOW - 20 * DAY).toISOString(), edition: "a" },
    { broadcastId: 2, sentAt: new Date(NOW - 2 * DAY).toISOString(), edition: "b" },
  ];
  function deps(fetched: number[], store: { cache: unknown; writes: number }): KitFrioDeps {
    return {
      nowMs: NOW,
      log: () => {},
      readDiariaRegistry: () => reg,
      readSemanalRegistry: () => [],
      listKitActive: async () => [] as KitFrioCandidate[],
      fetchEngagement: async (id) => {
        fetched.push(id);
        return { broadcastId: id, delivered: ["a@x.com"], opens: ["a@x.com"], clicks: [] };
      },
      findTagId: async () => 900,
      tag: async () => {},
      untag: async () => {},
      listComplainedEmails: async () => [],
      readPause: () => ({ paused: false }),
      writePause: () => {},
      raiseAlarm: () => {},
      appendLog: () => {},
      engagementCache: {
        read: () => store.cache,
        write: (c) => {
          store.cache = JSON.parse(JSON.stringify(c));
          store.writes++;
        },
      },
    };
  }

  it("REGRESSÃO: 2ª rodada não relê do Kit a diária já madura (só a recente)", async () => {
    const store = { cache: null as unknown, writes: 0 };
    const first: number[] = [];
    await runKitFrioSync(cfgFrioOn, { push: true }, deps(first, store));
    assert.deepEqual(first, [1, 2]);
    assert.deepEqual(Object.keys((store.cache as KitFrioEngagementCache).broadcasts), ["1"], "só a madura congela");
    const second: number[] = [];
    await runKitFrioSync(cfgFrioOn, { push: true }, deps(second, store));
    assert.deepEqual(second, [2]);
    assert.equal(store.writes, 1, "nada novo congelou: não regrava");
  });

  it("cache ilegível ⇒ relê tudo, sem lançar", async () => {
    const store = { cache: { version: 1, emails: "x" } as unknown, writes: 0 };
    const fetched: number[] = [];
    const r = await runKitFrioSync(cfgFrioOn, { push: true }, deps(fetched, store));
    assert.equal(r.code, 0);
    assert.deepEqual(fetched, [1, 2]);
  });

  it("diária que sai da janela sai do cache", async () => {
    const stale = buildKitFrioEngagementCache([
      { broadcastId: 1, delivered: ["a@x.com"], opens: ["a@x.com"], clicks: [] },
      { broadcastId: 77, delivered: ["z@x.com"], opens: ["z@x.com"], clicks: [] },
    ]);
    const store = { cache: stale as unknown, writes: 0 };
    await runKitFrioSync(cfgFrioOn, { push: true }, deps([], store));
    assert.deepEqual(Object.keys((store.cache as KitFrioEngagementCache).broadcasts), ["1"]);
    assert.ok(!(store.cache as KitFrioEngagementCache).emails.includes("z@x.com"));
  });

  it("REGRESSÃO (review #11308): dry-run lê o cache mas nunca o grava", async () => {
    const store = { cache: null as unknown, writes: 0 };
    const fetched: number[] = [];
    await runKitFrioSync(cfgFrioOn, { push: false }, deps(fetched, store));
    assert.deepEqual(fetched, [1, 2]);
    assert.equal(store.writes, 0);
    assert.equal(store.cache, null);
  });
});

// ── 2. semanal acompanha o principal ─────────────────────────────────────

type MainState = ReturnType<SemanalFrioPublishDeps["readMainState"]>;
function followDeps(main: MainState, over: Partial<SemanalFrioPublishDeps> = {}) {
  const sendAt = new Map<number, string>([[11, "2026-11-02T09:00:00.000Z"]]);
  const scheduled: string[] = [];
  const written: KitSemanalFrioPublished[] = [];
  const alarms: string[] = [];
  const created: unknown[] = [];
  const own: KitSemanalFrioPublished = {
    broadcast_id: 11,
    status: "scheduled",
    scheduled_at: "2026-11-02T09:00:00.000Z",
    source_broadcast_id: 10,
    tag_id: 900,
    created_at: "2026-11-01T22:00:00Z",
  };
  const d: SemanalFrioPublishDeps = {
    log: () => {},
    nowIso: () => "2026-11-01T23:00:00Z",
    readMainState: () => main,
    readOwnState: () => own,
    writeOwnState: (_dir, s) => void written.push(s),
    readPause: () => ({ paused: false }),
    findTagId: async () => 900,
    countTagMembers: async () => 5,
    getBroadcast: async (id) =>
      ({
        id,
        subject: "S",
        content: "<p>x</p>",
        status: sendAt.has(id) ? "scheduled" : "draft",
        send_at: sendAt.get(id) ?? null,
        subscriber_filter: buildTagFilter(900),
      }) as never,
    createBroadcast: async (input) => {
      created.push(input);
      return { id: 99 } as never;
    },
    scheduleBroadcast: async (id, at) => {
      scheduled.push(`${id}@${at}`);
      if (at === null) sendAt.delete(id);
      else sendAt.set(id, at);
    },
    updateBroadcastContent: async () => {
      throw new Error("não deveria re-sincronizar conteúdo");
    },
    deleteBroadcast: async () => {},
    raiseAlarm: (title) => void alarms.push(title),
    ...over,
  };
  return { d, scheduled, written, alarms, created };
}
const mainAt = (at: string): MainState => ({ broadcast_id: 10, subject: "S", preview_text: "P", status: "scheduled", scheduled_at: at });

describe("semanal de frio acompanha o principal (#11294 item 2)", () => {
  it("mesmo instante ⇒ already_done, sem PATCH", async () => {
    const t = followDeps(mainAt("2026-11-02T09:00:00Z"));
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "already_done");
    assert.deepEqual(t.scheduled, []);
  });

  it("REGRESSÃO: principal reagendado ⇒ a semanal é re-PATCHada pro novo horário e o estado grava o novo send_at", async () => {
    const t = followDeps(mainAt("2026-11-02T11:00:00.000Z"));
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "rescheduled");
    assert.deepEqual(t.scheduled, ["11@2026-11-02T11:00:00.000Z"]);
    assert.equal(t.written.at(-1)!.scheduled_at, "2026-11-02T11:00:00.000Z");
    assert.equal(t.written.at(-1)!.status, "scheduled");
    assert.equal(t.created.length, 0);
  });

  it("REGRESSÃO: principal desagendado (draft) ⇒ a semanal é desagendada e volta a created_unverified", async () => {
    const t = followDeps({ broadcast_id: 10, subject: "S", preview_text: "P", status: "draft" });
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true, followOnly: true }, t.d);
    assert.equal(r.status, "unscheduled");
    assert.deepEqual(t.scheduled, ["11@null"]);
    assert.equal(t.written.at(-1)!.status, "created_unverified");
  });

  it("desagendamento não confirmado na releitura ⇒ failed + alarme (sairia sozinha)", async () => {
    const t = followDeps(null, { scheduleBroadcast: async () => {} });
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, t.d);
    assert.equal(r.status, "failed");
    assert.equal(r.code, 1);
    assert.equal(t.alarms.length, 1);
    assert.equal(t.written.length, 0);
  });

  it("dry-run não mexe em nada", async () => {
    const t = followDeps(mainAt("2026-11-02T11:00:00Z"));
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: false }, t.d);
    assert.equal(r.status, "dry_run");
    assert.deepEqual(t.scheduled, []);
  });

  it("followOnly sem semanal agendada ⇒ nothing_to_follow, nunca cria", async () => {
    const t = followDeps(null, { readOwnState: () => null });
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true, followOnly: true }, t.d);
    assert.equal(r.status, "nothing_to_follow");
    assert.equal(t.created.length, 0);
  });

  it("desagendada pelo principal, o reagendamento seguinte do principal a retoma (mesmo id, sem criar outra)", async () => {
    let state: KitSemanalFrioPublished | null = null;
    const t1 = followDeps({ broadcast_id: 10, subject: "S", preview_text: "P", status: "draft" });
    await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, { ...t1.d, writeOwnState: (_d, s) => void (state = s) });
    assert.equal(state!.status, "created_unverified");
    const t2 = followDeps(mainAt("2026-11-02T10:00:00.000Z"), { readOwnState: () => state, writeOwnState: (_d, s) => void (state = s) });
    // o rascunho já não tem send_at no Kit
    await t2.d.scheduleBroadcast(11, null);
    t2.scheduled.length = 0;
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, t2.d);
    assert.equal(r.status, "scheduled");
    assert.equal(r.broadcastId, 11);
    assert.equal(t2.created.length, 0);
    assert.deepEqual(t2.scheduled, ["11@2026-11-02T10:00:00.000Z"]);
  });

  it("REGRESSÃO (review #11308, P2): desagendada no Kit mas estado local não gravado ⇒ failed; a rodada seguinte, com o principal no MESMO horário, relê o Kit e reagenda", async () => {
    // Rodada 1: principal desagendado; o PATCH null é confirmado no Kit, mas a gravação do estado falha.
    const t1 = followDeps({ broadcast_id: 10, subject: "S", preview_text: "P", status: "draft" }, {
      writeOwnState: () => {
        throw new Error("EIO");
      },
    });
    const r1 = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true, followOnly: true }, t1.d);
    assert.equal(r1.status, "failed");
    assert.equal(r1.code, 1);
    assert.deepEqual(t1.scheduled, ["11@null"]);
    // Rodada 2: estado local continua `scheduled` 09:00; principal reagendado pras MESMAS 09:00; no Kit a semanal é rascunho.
    const t2 = followDeps(mainAt("2026-11-02T09:00:00Z"));
    await t2.d.scheduleBroadcast(11, null);
    t2.scheduled.length = 0;
    const r2 = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, t2.d);
    assert.equal(r2.status, "rescheduled", "nunca already_done com o Kit mostrando rascunho");
    assert.deepEqual(t2.scheduled, ["11@2026-11-02T09:00:00Z"]);
    assert.equal(t2.written.at(-1)!.status, "scheduled");
    assert.equal(t2.created.length, 0);
  });
});

// ── 3. releitura do unlink da premissa B ─────────────────────────────────

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
async function withFetch<T>(impl: (url: string, init?: RequestInit) => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => impl(String(url), init)) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}
function contact(email: string, origin: string): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: origin,
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: "2026-10-10T00:00:00.000Z",
    last_evaluated_at: null,
  };
}

describe("premissa B: unlink relido (#11294 item 3)", () => {
  it("verifyUnlinkedFromBrevoList: fora da lista ⇒ true; ainda na lista, sem listIds ou != 200 ⇒ false", async () => {
    assert.equal(await withFetch(() => jsonRes(200, { listIds: [3] }), () => verifyUnlinkedFromBrevoList("k", 7, "a@x.com")), true);
    assert.equal(await withFetch(() => jsonRes(200, { listIds: [7] }), () => verifyUnlinkedFromBrevoList("k", 7, "a@x.com")), false);
    assert.equal(await withFetch(() => jsonRes(200, {}), () => verifyUnlinkedFromBrevoList("k", 7, "a@x.com")), false);
    // 5xx lança no brevoGet (retry esgotado) e cai no catch por contato do loop: segue in_brevo.
    assert.equal(await withFetch(() => jsonRes(404, {}), () => verifyUnlinkedFromBrevoList("k", 7, "a@x.com")), false);
  });

  it("REGRESSÃO: unlink 2xx que não tirou da lista ⇒ fica in_brevo (nunca suppressed com o contato ainda na lista)", async () => {
    const sent = Array.from({ length: 6 }, (_, i) => ({ campaignId: i + 1, eventTime: "2026-10-01T09:00:00Z" }));
    const r = await withFetch(
      (url, init) => {
        if (url.includes("api.kit.com")) throw new Error(`Kit não deveria ser chamado: ${url}`);
        if (init?.method === "PUT") return jsonRes(200, {}); // 2xx que não fez nada
        return jsonRes(200, { emailBlacklisted: false, listIds: [7], statistics: { messagesSent: sent, opened: [] } });
      },
      () => {
        const contacts = [contact("frio@x.com", "kit-sem-abertura:42")];
        return runEvaluation({
          contacts,
          store: { contacts },
          push: true,
          publicationId: "pub",
          beehiivApiKey: "b",
          brevoApiKey: "br",
          kitApiKey: "k",
          listId: 7,
          log: () => {},
          newsletterBackend: "kit",
        });
      },
    );
    const stored = findContact(r.store, "frio@x.com")!;
    assert.equal(stored.status, "in_brevo");
    assert.equal(r.kitSemAberturaAwaitingFrio, 0);
    assert.equal(r.failed, 1);
    assert.ok(r.failedContacts.some((f) => /não confirmado na releitura/.test(f.reason)));
  });
});

// ── 4. estoque da premissa B ─────────────────────────────────────────────

describe("estoque aguardando o frio (#11294 item 4)", () => {
  const waiting = (daysAgo: number) => ({
    status: "suppressed",
    resolution_reason: "kit_sem_abertura_aguardando_frio",
    suppressed_at: new Date(NOW - daysAgo * DAY).toISOString(),
  });
  it("conta só os aguardando o frio e mede o mais antigo", () => {
    const s = summarizeAwaitingFrioBacklog([waiting(3), waiting(10), { status: "suppressed", resolution_reason: "score_threshold" }, { status: "in_brevo" }], NOW);
    assert.equal(s.count, 2);
    assert.equal(s.oldestDays, 10);
    assert.deepEqual(s.alarmReasons, []);
  });
  it("alarma acima do teto de quantidade ou de idade", () => {
    const many = Array.from({ length: KIT_SEM_ABERTURA_AGUARDANDO_FRIO_ALARM_COUNT }, () => waiting(1));
    assert.equal(summarizeAwaitingFrioBacklog(many, NOW).alarmReasons.length, 1);
    assert.equal(summarizeAwaitingFrioBacklog([waiting(KIT_SEM_ABERTURA_AGUARDANDO_FRIO_ALARM_DAYS)], NOW).alarmReasons.length, 1);
    assert.equal(summarizeAwaitingFrioBacklog([], NOW).oldestDays, null);
  });
});
