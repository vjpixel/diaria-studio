/**
 * test/kit-sem-abertura-10437.test.ts (#10437)
 *
 * Kit → Brevo: ativos no Kit com 6 envios maduros da diária sem abrir nem
 * clicar. Cobre os critérios de aceite da issue:
 *   - predicado (escopo nos broadcasts da diária, borda 5/6, envio imaturo,
 *     clique sem abertura, exclusões);
 *   - contato movido NÃO sai da Brevo pelo Passo 1 enquanto ativo no Kit;
 *   - promoção remove a tag e o contato não volta pra Brevo na rodada seguinte;
 *   - broadcast do Kit não sai com filtro não resolvido;
 *   - flags `false` = comportamento idêntico ao atual.
 */
import { describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEngagementIndex,
  checkNewSignupsFitAccountQuota,
  countKitSemAberturaInBrevo,
  diariaSendDayUtc,
  parseKitSemAberturaNumbers,
  classifyDiariaBroadcasts,
  computeBacklogSlots,
  dedupeBroadcastRecords,
  parseDiariaBroadcastState,
  planKitSemAberturaWave,
  selectKitSemAbertura,
  type BroadcastEngagement,
  type KitActiveCandidate,
} from "../scripts/lib/kit-sem-abertura.ts";
import {
  parseDiariaExclusionSegment,
  resolveDiariaAudience,
  verifyDiariaAudienceFilter,
  KIT_ENVIO_BREVO_TAG_NAME,
} from "../scripts/lib/kit-diaria-audience.ts";
import { buildAllSubscribersFilter, buildSegmentFilter, listSubscriberTags } from "../scripts/lib/kit-broadcasts.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";
import { kitSendAudienceWithExclusionSegment } from "../scripts/reconcile-send-audiences.ts";
import { parseOrigin, buildOrigin } from "../scripts/lib/shared/brevo-diaria-origin.ts";
import {
  parseKitSubscriberId,
  parseKitSemAberturaSubscriberId,
  removeKitEnvioBrevoTag,
  runEvaluation,
} from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact, type BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";
import {
  readDiariaBroadcastRegistry,
  runKitSemAberturaSync,
  type KitSemAberturaDeps,
  type KitSemAberturaPlatformConfig,
} from "../scripts/sync-kit-sem-abertura-to-brevo.ts";
import { scheduleNewsletterKit, type ScheduleNewsletterKitDeps } from "../scripts/schedule-newsletter-kit.ts";
import { confirmDiariaAudienceOnBroadcast, unscheduleKitBroadcast } from "../scripts/publish-newsletter-kit.ts";
import { runBrevoDiaria, type ExecFn } from "../scripts/brevo-diaria-run.ts";
import { resolveDailyBrevoIntro } from "../scripts/publish-daily-brevo.ts";
import { applyKitActiveExclusionGuard, kitSemAberturaExemptEmails } from "../scripts/lib/brevo-kit-active-exclusion.ts";
import { EDITOR_SEED_EMAILS } from "../scripts/lib/editor-copy.ts";
import type { KitNewsletterPublished } from "../scripts/publish-newsletter-kit.ts";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function candidate(email: string, overrides: Partial<KitActiveCandidate> = {}): KitActiveCandidate {
  return { id: 100, email, created_at: "2026-09-01T00:00:00.000Z", tagNames: [], ...overrides };
}

/** N broadcasts maduros onde `email` recebeu todos e não abriu nada. */
function engagementFor(email: string, mature: number, extra: Partial<BroadcastEngagement>[] = []) {
  const per: BroadcastEngagement[] = [];
  for (let i = 1; i <= mature; i++) per.push({ broadcastId: i, delivered: [email], opens: [], clicks: [] });
  extra.forEach((e, i) => per.push({ broadcastId: 1000 + i, delivered: [], opens: [], clicks: [], ...e }));
  const matureIds = new Set(per.filter((b) => b.broadcastId < 1000).map((b) => b.broadcastId));
  return buildEngagementIndex(per, matureIds);
}

function select(c: KitActiveCandidate, engagement = engagementFor(c.email, 6), storeEmails: string[] = []) {
  return selectKitSemAbertura({ subscribers: [c], engagement, storeEmails, seedEmails: EDITOR_SEED_EMAILS });
}

describe("predicado de seleção (#10437)", () => {
  it("6 envios maduros da diária, 0 aberturas, 0 cliques → selecionado", () => {
    const r = select(candidate("a@x.com"));
    assert.equal(r.selected.length, 1);
    assert.equal(r.selected[0].matureSends, 6);
  });

  it("borda: 5 envios maduros → fora (envios_insuficientes); 6 → dentro", () => {
    assert.equal(select(candidate("a@x.com"), engagementFor("a@x.com", 5)).excluded.envios_insuficientes, 1);
    assert.equal(select(candidate("a@x.com"), engagementFor("a@x.com", 6)).selected.length, 1);
  });

  it("envio não maduro (<48h) não conta: 5 maduros + 1 recente → fora", () => {
    const records = [
      ...[1, 2, 3, 4, 5].map((i) => ({ broadcastId: i, sentAt: new Date(NOW - (10 - i) * DAY).toISOString(), edition: `e${i}` })),
      { broadcastId: 6, sentAt: new Date(NOW - 20 * 60 * 60 * 1000).toISOString(), edition: "e6" },
    ];
    const { sentIds, matureIds } = classifyDiariaBroadcasts(records, NOW);
    assert.deepEqual(sentIds, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(matureIds, [1, 2, 3, 4, 5]);
    const per = sentIds.map((id) => ({ broadcastId: id, delivered: ["a@x.com"], opens: [], clicks: [] }));
    const r = select(candidate("a@x.com"), buildEngagementIndex(per, new Set(matureIds)));
    assert.equal(r.excluded.envios_insuficientes, 1);
  });

  it("abertura num envio ainda não maduro também exclui", () => {
    const e = engagementFor("a@x.com", 6, [{ opens: ["a@x.com"] }]);
    assert.equal(select(candidate("a@x.com"), e).excluded.abriu, 1);
  });

  it("clique sem abertura (pixel bloqueado) → fora", () => {
    const e = engagementFor("a@x.com", 6, [{ clicks: ["a@x.com"] }]);
    const r = select(candidate("a@x.com"), e);
    assert.equal(r.selected.length, 0);
    assert.equal(r.excluded.clicou, 1);
  });

  it("exclusões: apoiador (campo e tag), seed do editor, fixture, tag de teste, tag envio-brevo, já no store", () => {
    const cases: [KitActiveCandidate, keyof ReturnType<typeof select>["excluded"], string[]?][] = [
      [candidate("ap@x.com", { fields: { apoio_nivel: "patrono" } }), "apoiador"],
      [candidate("ap2@x.com", { tagNames: ["apoio-retrospectiva"] }), "apoiador"],
      [candidate(EDITOR_SEED_EMAILS[0]), "editor_seed"],
      [candidate("teste-algo@x.com"), "fixture"],
      [candidate("t@x.com", { tagNames: ["diaria-test-email"] }), "tag_teste"],
      [candidate("t2@x.com", { tagNames: [KIT_ENVIO_BREVO_TAG_NAME] }), "ja_tem_tag_envio_brevo"],
      [candidate("st@x.com"), "ja_passou_pelo_store", ["st@x.com"]],
    ];
    for (const [c, reason, store] of cases) {
      const r = select(c, engagementFor(c.email, 6), store ?? []);
      assert.equal(r.selected.length, 0, c.email);
      assert.equal(r.excluded[reason], 1, `${c.email} → ${reason}`);
    }
  });

  it("apoio_nivel vazio não exclui", () => {
    assert.equal(select(candidate("a@x.com", { fields: { apoio_nivel: "" } })).selected.length, 1);
  });
});

describe("registro de broadcasts da diária (#10437, armadilha 2)", () => {
  it("só conta broadcast agendado (status scheduled + scheduled_at legível)", () => {
    assert.equal(parseDiariaBroadcastState({ broadcast_id: 1, status: "draft" }, "e"), null);
    assert.equal(parseDiariaBroadcastState({ broadcast_id: 1, status: "test_sent" }, "e"), null);
    assert.equal(parseDiariaBroadcastState({ broadcast_id: 1, status: "scheduled", scheduled_at: "lixo" }, "e"), null);
    assert.deepEqual(parseDiariaBroadcastState({ broadcast_id: 7, status: "scheduled", scheduled_at: "2026-10-01T09:00:00Z" }, "e"), {
      broadcastId: 7,
      sentAt: "2026-10-01T09:00:00Z",
      edition: "e",
    });
  });

  it("dedup por id", () => {
    const r = dedupeBroadcastRecords([
      { broadcastId: 1, sentAt: "2026-10-01T09:00:00Z", edition: "a" },
      { broadcastId: 1, sentAt: "2026-10-01T09:00:00Z", edition: "a" },
    ]);
    assert.equal(r.length, 1);
  });
});

describe("onda: backlog pela cota, novos sempre (#10437)", () => {
  it("computeBacklogSlots: menor entre fila e cota da conta; cota ilegível ⇒ 0", () => {
    assert.equal(
      computeBacklogSlots({ queueCap: 295, currentActiveCount: 39, seedCount: 2, newCount: 0, dailyLimit: 300, transactionalToday: 50 }),
      300 - 50 - 41,
    );
    assert.equal(
      computeBacklogSlots({ queueCap: 100, currentActiveCount: 39, seedCount: 2, newCount: 1, dailyLimit: 300, transactionalToday: 0 }),
      60,
    );
    assert.equal(
      computeBacklogSlots({ queueCap: 295, currentActiveCount: 39, seedCount: 2, newCount: 0, dailyLimit: 300, transactionalToday: null }),
      0,
    );
    assert.equal(
      computeBacklogSlots({ queueCap: 295, currentActiveCount: 39, seedCount: 2, newCount: 0, dailyLimit: 300, transactionalToday: 290 }),
      0,
    );
  });

  it("cadastros novos entram mesmo sem slot; backlog mais antigo primeiro; pausa zera tudo", () => {
    const sel = [
      { ...candidate("novo@x.com", { created_at: new Date(NOW - 10 * DAY).toISOString() }), matureSends: 6 },
      { ...candidate("velho2@x.com", { created_at: "2026-09-10T00:00:00Z" }), matureSends: 6 },
      { ...candidate("velho1@x.com", { created_at: "2026-09-02T00:00:00Z" }), matureSends: 6 },
    ];
    const w = planKitSemAberturaWave({ selected: sel, nowMs: NOW, newSignupWindowDays: 30, backlogSlots: () => 1, rolloutPaused: false });
    assert.deepEqual(w.toMove.map((c) => [c.email, c.wave]), [["novo@x.com", "novo"], ["velho1@x.com", "backlog"]]);
    assert.equal(w.deferred, 1);
    const zero = planKitSemAberturaWave({ selected: sel, nowMs: NOW, newSignupWindowDays: 30, backlogSlots: () => 0, rolloutPaused: false });
    assert.deepEqual(zero.toMove.map((c) => c.email), ["novo@x.com"]);
    const paused = planKitSemAberturaWave({ selected: sel, nowMs: NOW, newSignupWindowDays: 30, backlogSlots: () => 9, rolloutPaused: true });
    assert.equal(paused.toMove.length, 0);
  });
});

// ── runKitSemAberturaSync ────────────────────────────────────────────────

function cfg(kitSemAbertura: boolean, segment: boolean): KitSemAberturaPlatformConfig {
  return {
    brevo_diaria: { api_key_env: "X", list_id: 7, daily_send_cap: 295, kit_sem_abertura: { enabled: kitSemAbertura } },
    kit: { diaria_exclusion_segment: { enabled: segment, segment_id: segment ? 99 : null } },
  };
}

function fakeDeps(overrides: Partial<KitSemAberturaDeps> = {}) {
  const calls: string[] = [];
  let store: BrevoDiariaStore = { contacts: [] };
  const records = [1, 2, 3, 4, 5, 6].map((i) => ({ broadcastId: i, sentAt: new Date(NOW - (10 - i) * DAY).toISOString(), edition: `e${i}` }));
  const deps: KitSemAberturaDeps = {
    nowMs: NOW,
    log: () => {},
    readRegistry: () => records,
    listKitActive: async () => [candidate("mover@x.com", { id: 42 })],
    fetchEngagement: async (id) => ({ broadcastId: id, delivered: ["mover@x.com"], opens: ["leitor-fora-da-base@x.com"], clicks: [] }),
    findEnvioBrevoTagId: async () => 555,
    readStore: () => store,
    writeStore: (s) => {
      calls.push("store");
      store = s;
    },
    rolloutPaused: () => false,
    transactionalOnSendDay: async () => 0,
    getApoioNivel: async () => null,
    isBrevoBlacklisted: async () => false,
    ingestBrevo: async (email) => {
      calls.push(`brevo:${email}`);
    },
    tagKit: async (tagId, id) => {
      calls.push(`tag:${tagId}:${id}`);
    },
    untagKit: async (tagId, id) => {
      calls.push(`untag:${tagId}:${id}`);
    },
    appendLog: (line) => {
      calls.push(`log:${JSON.parse(line).origin}`);
    },
    ...overrides,
  };
  return { deps, calls, getStore: () => store };
}

function throwingDeps(): KitSemAberturaDeps {
  const boom = () => {
    throw new Error("nenhum I/O deveria rodar com a flag desligada");
  };
  return {
    nowMs: NOW,
    log: () => {},
    readRegistry: boom,
    listKitActive: boom,
    fetchEngagement: boom,
    findEnvioBrevoTagId: boom,
    readStore: boom,
    writeStore: boom,
    rolloutPaused: boom,
    transactionalOnSendDay: boom,
    getApoioNivel: boom,
    isBrevoBlacklisted: boom,
    ingestBrevo: boom,
    tagKit: boom,
    untagKit: boom,
    appendLog: boom,
  };
}

describe("runKitSemAberturaSync (#10437)", () => {
  it("flag desligada ⇒ nada roda, nem leitura (comportamento atual)", async () => {
    const r = await runKitSemAberturaSync(cfg(false, false), { push: true }, throwingDeps());
    assert.equal(r.disabled, true);
    assert.equal(r.code, 0);
  });

  it("flag ligada SEM o segmento no Kit ⇒ --push vira dry-run (tag sem segmento = edição em dobro)", async () => {
    const { deps, calls } = fakeDeps();
    const r = await runKitSemAberturaSync(cfg(true, false), { push: true }, deps);
    assert.equal(r.dryRun, true);
    assert.equal(r.selected, 1);
    assert.deepEqual(calls, []);
  });

  it("as duas flags ⇒ ordem Brevo → tag → store (origem kit-sem-abertura:) → log", async () => {
    const { deps, calls, getStore } = fakeDeps();
    const r = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.equal(r.moved, 1);
    assert.deepEqual(calls, ["brevo:mover@x.com", "tag:555:42", "store", "log:kit-sem-abertura:42"]);
    assert.equal(findContact(getStore(), "mover@x.com")!.beehiiv_subscription_id, "kit-sem-abertura:42");
  });

  it("falha na tag do Kit ⇒ store gravado COM kit_tag_pending (nunca órfão sem canal), exit 1; rodada seguinte retenta e limpa", async () => {
    let tagFails = true;
    const { deps, calls, getStore } = fakeDeps({
      tagKit: async (tagId, id) => {
        calls.push(`tag:${tagId}:${id}`);
        if (tagFails) throw new Error("releitura das tags não mostra a tag");
      },
    });
    const r = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.equal(r.code, 1);
    assert.equal(r.moved, 0);
    assert.deepEqual(calls, ["brevo:mover@x.com", "tag:555:42", "store", "log:kit-sem-abertura:42"]);
    const c = findContact(getStore(), "mover@x.com")!;
    assert.equal(c.status, "in_brevo");
    assert.equal(c.kit_tag_pending, true);
    // O guard #6485 o isenta (está no store, in_brevo) — não sai da Brevo.
    assert.deepEqual(kitSemAberturaExemptEmails(getStore()), ["mover@x.com"]);

    // Rodada seguinte: o Kit já lista a tag (ou não) — o contato não é
    // re-selecionado (está no store) e a tag pendente é retentada.
    tagFails = false;
    calls.length = 0;
    const again = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.equal(again.reconciled, 1);
    assert.deepEqual(calls, ["tag:555:42", "store"]);
    assert.equal(findContact(getStore(), "mover@x.com")!.kit_tag_pending, undefined);
  });

  it("writeStore falha depois da tag ⇒ falha contada; rodada seguinte reconcilia o órfão (tag sem store) em vez de excluí-lo", async () => {
    let writes = 0;
    const { deps, calls, getStore } = fakeDeps();
    const realWrite = deps.writeStore;
    deps.writeStore = (st) => {
      writes++;
      if (writes <= 2) throw new Error("EBUSY");
      realWrite(st);
    };
    const r = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.equal(r.code, 1);
    assert.equal(findContact(getStore(), "mover@x.com"), undefined);

    // O Kit agora mostra a tag; o store não tem o contato ⇒ órfão.
    calls.length = 0;
    deps.listKitActive = async () => [candidate("mover@x.com", { id: 42, tagNames: [KIT_ENVIO_BREVO_TAG_NAME] })];
    const again = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.equal(again.reconciled, 1);
    assert.deepEqual(calls.slice(0, 3), ["brevo:mover@x.com", "store", "log:kit-sem-abertura:42"]);
    assert.equal(findContact(getStore(), "mover@x.com")!.beehiiv_subscription_id, "kit-sem-abertura:42");
  });

  it("falha no ingest da Brevo ⇒ Kit não é tocado", async () => {
    const { deps, calls } = fakeDeps({
      ingestBrevo: async () => {
        throw new Error("releitura sem a lista");
      },
    });
    const r = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.equal(r.failed, 1);
    assert.deepEqual(calls, []);
  });

  it("--max-add 0 ⇒ ninguém, nem cadastro novo (mesma semântica do brevo-diaria-run)", async () => {
    const { deps, calls } = fakeDeps({
      listKitActive: async () => [candidate("mover@x.com", { id: 42, created_at: new Date(NOW - 12 * DAY).toISOString() })],
    });
    const r = await runKitSemAberturaSync(cfg(true, true), { push: true, maxAdd: 0 }, deps);
    assert.equal(r.moved, 0);
    assert.equal(r.deferred, 1);
    assert.deepEqual(calls, []);
  });

  it("tag envio-brevo inexistente no Kit ⇒ exit 2, nada movido", async () => {
    const { deps, calls } = fakeDeps({ findEnvioBrevoTagId: async () => null });
    const r = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.equal(r.code, 2);
    assert.deepEqual(calls, []);
  });
});

// ── origem + evaluate-brevo-diaria ───────────────────────────────────────

describe("origem kit-sem-abertura: (#10437, armadilha 5)", () => {
  it("round-trip e não colide com kit:", () => {
    const raw = buildOrigin("kit-sem-abertura", "42");
    assert.equal(raw, "kit-sem-abertura:42");
    assert.deepEqual(parseOrigin(raw), { kind: "kit-sem-abertura", payload: "42", raw });
    assert.equal(parseKitSubscriberId(raw).kind, "not-kit");
    assert.equal(parseKitSemAberturaSubscriberId(raw), 42);
    assert.equal(parseKitSemAberturaSubscriberId("kit:42"), undefined);
    assert.equal(parseKitSemAberturaSubscriberId("kit-sem-abertura:abc"), 0);
  });
});

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function movedContact(email: string): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: "kit-sem-abertura:42",
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: "2026-10-10T00:00:00.000Z",
    last_evaluated_at: null,
  };
}

function brevoContactRes(sent: number, opened: number): Response {
  const ids = Array.from({ length: sent }, (_, i) => ({ campaignId: i + 1, eventTime: "2026-10-01T09:00:00Z" }));
  return jsonRes(200, {
    emailBlacklisted: false,
    listIds: [7],
    statistics: { messagesSent: ids, opened: ids.slice(0, opened) },
  });
}

describe("runEvaluation com origem kit-sem-abertura: (#10437)", () => {
  const origFetch = globalThis.fetch;

  it("ativo no Kit NÃO sai da Brevo pelo Passo 1 (nenhuma leitura de Kit/Beehiiv; segue in_brevo)", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("api.kit.com") || u.includes("beehiiv")) throw new Error(`não deveria consultar: ${u}`);
      return brevoContactRes(1, 0);
    }) as typeof fetch;
    try {
      const contacts = [movedContact("m@x.com")];
      const r = await runEvaluation({
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
      assert.equal(r.selfConfirmed, 0);
      assert.equal(r.failed, 0);
      assert.equal(findContact(r.store, "m@x.com")!.status, "in_brevo");
      assert.ok(!urls.some((u) => u.includes("api.kit.com")));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("abertura alta ⇒ remove a tag no Kit (releitura confirma), desvincula da Brevo, e o seletor não o re-move na rodada seguinte", async () => {
    const kitCalls: string[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("api.kit.com")) {
        kitCalls.push(`${method} ${u.replace(/^https:\/\/api\.kit\.com\/v4/, "")}`);
        if (u.includes("/tags?")) return jsonRes(200, { tags: [{ id: 555, name: KIT_ENVIO_BREVO_TAG_NAME }], pagination: { has_next_page: false } });
        if (method === "DELETE") return new Response(null, { status: 204 });
        if (u.includes("/subscribers/42/tags")) return jsonRes(200, { tags: [] });
        throw new Error(`Kit inesperado: ${method} ${u}`);
      }
      if (u.includes("beehiiv")) throw new Error(`não deveria tocar a Beehiiv: ${u}`);
      if (method === "PUT") return jsonRes(200, {});
      if (method === "POST") return jsonRes(200, {});
      return brevoContactRes(3, 3);
    }) as typeof fetch;
    try {
      const contacts = [movedContact("m@x.com")];
      const r = await runEvaluation({
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
      const stored = findContact(r.store, "m@x.com")!;
      assert.equal(stored.status, "promoted_beehiiv");
      assert.equal(stored.resolution_reason, "score_threshold_kit_tag_removed");
      assert.ok(kitCalls.includes("DELETE /tags/555/subscribers/42"));
      assert.ok(!kitCalls.some((c) => c.startsWith("POST /subscribers")), "nunca recria o assinante no Kit");

      // Rodada seguinte: 0 aberturas no Kit, ≥6 envios — mas já passou pelo store.
      const again = selectKitSemAbertura({
        subscribers: [candidate("m@x.com", { id: 42 })],
        engagement: engagementFor("m@x.com", 8),
        storeEmails: r.store.contacts.map((c) => c.email),
        seedEmails: EDITOR_SEED_EMAILS,
      });
      assert.equal(again.selected.length, 0);
      assert.equal(again.excluded.ja_passou_pelo_store, 1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("releitura ainda mostra a tag ⇒ mantém in_brevo (fail-safe)", async () => {
    const r = await removeKitEnvioBrevoTag({
      subscriberId: 42,
      kitApiKey: "k",
      resolveTagId: async () => 555,
      deps: { untag: async () => {}, listTags: async () => [{ id: 555, name: KIT_ENVIO_BREVO_TAG_NAME, created_at: "" }] },
    });
    assert.equal(r.ok, false);
  });
});

// ── audiência do broadcast da diária no Kit ──────────────────────────────

describe("audiência do broadcast principal (#10437)", () => {
  it("flag desligada ⇒ base inteira, sem listar segmentos (idêntico ao atual)", async () => {
    const r = await resolveDiariaAudience(undefined, {
      listSegments: async () => {
        throw new Error("não deveria chamar");
      },
    });
    assert.equal(r.ok && r.mode, "all");
    assert.deepEqual(r.ok && r.filter, buildAllSubscribersFilter());
    const off = await resolveDiariaAudience({ enabled: false, segment_id: 99 }, {
      listSegments: async () => {
        throw new Error("não deveria chamar");
      },
    });
    assert.equal(off.ok && off.mode, "all");
  });

  it("flag ligada e segmento não resolvido ⇒ aborta (nunca base inteira)", async () => {
    assert.equal((await resolveDiariaAudience({ enabled: true, segment_id: null }, { listSegments: async () => [] })).ok, false);
    assert.equal((await resolveDiariaAudience({ enabled: true, segment_id: 99 }, { listSegments: async () => [{ id: 1, name: "x" }] })).ok, false);
    assert.equal(
      (
        await resolveDiariaAudience({ enabled: true, segment_id: 99 }, {
          listSegments: async () => {
            throw new Error("500");
          },
        })
      ).ok,
      false,
    );
  });

  it("flag ligada e segmento existente ⇒ filtro de segmento", async () => {
    const r = await resolveDiariaAudience({ enabled: true, segment_id: 99 }, { listSegments: async () => [{ id: 99, name: "sem envio-brevo" }] });
    assert.ok(r.ok && r.mode === "segment");
    assert.deepEqual(r.ok && r.filter, [{ all: [{ type: "segment", ids: [99] }] }]);
  });

  it("releitura: ausente ou divergente reprova; igual passa", () => {
    const f = buildSegmentFilter(99);
    assert.equal(verifyDiariaAudienceFilter(undefined, f).ok, false);
    assert.equal(verifyDiariaAudienceFilter([], f).ok, false);
    assert.equal(verifyDiariaAudienceFilter(f, f).ok, true);
  });

  it("publish: releitura divergente apaga o draft recém-criado", async () => {
    const deleted: number[] = [];
    const r = await confirmDiariaAudienceOnBroadcast(7, buildSegmentFilter(99), {
      getBroadcast: async () => ({ subscriber_filter: [] }),
      deleteBroadcast: async (id) => {
        deleted.push(id);
      },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(deleted, [7]);
  });
});

describe("schedule-newsletter-kit com audiência por segmento (#10437)", () => {
  // #11689: guard de horário passado usa o relógio real; fixa antes das datas do fixture.
  before(() => mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-01T00:00:00.000Z") }));
  after(() => mock.timers.reset());
  const published: KitNewsletterPublished = { broadcast_id: 7, subject: "s", preview_text: "p", status: "test_sent" };
  function deps(filterBefore: unknown, filterAfter: unknown) {
    const patches: (string | null)[] = [];
    let reads = 0;
    const d: ScheduleNewsletterKitDeps = {
      readPublished: () => published,
      writePublished: () => {},
      patchSchedule: async (_id, at) => {
        patches.push(at);
      },
      getBroadcastStatus: async () => {
        reads++;
        return reads === 1 && filterBefore !== "skip"
          ? { status: "draft", sendAt: null, subscriberFilter: filterBefore }
          : { status: "scheduled", sendAt: "2026-10-20T09:00:00.000Z", subscriberFilter: filterAfter };
      },
    };
    return { d, patches, reads: () => reads };
  }

  it("sem a opção (flag desligada) ⇒ nenhuma leitura extra, agenda como sempre", async () => {
    const { d, patches, reads } = deps("skip", undefined);
    const r = await scheduleNewsletterKit("/tmp/x", "2026-10-20T09:00:00.000Z", d);
    assert.equal(r.ok, true);
    assert.deepEqual(patches, ["2026-10-20T09:00:00.000Z"]);
    assert.equal(reads(), 1);
  });

  it("filtro relido antes do PATCH não é o segmento ⇒ code 7, nada agendado", async () => {
    const { d, patches } = deps([], buildSegmentFilter(99));
    const r = await scheduleNewsletterKit("/tmp/x", "2026-10-20T09:00:00.000Z", d, { expectedAudienceFilter: buildSegmentFilter(99) });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, 7);
    assert.deepEqual(patches, []);
  });

  it("filtro diverge depois do PATCH ⇒ desfaz o agendamento (send_at null), code 7", async () => {
    const { d, patches } = deps(buildSegmentFilter(99), []);
    const r = await scheduleNewsletterKit("/tmp/x", "2026-10-20T09:00:00.000Z", d, { expectedAudienceFilter: buildSegmentFilter(99) });
    assert.equal(!r.ok && r.code, 7);
    assert.deepEqual(patches, ["2026-10-20T09:00:00.000Z", null]);
  });

  it("segmento confirmado antes e depois ⇒ agenda", async () => {
    const { d } = deps(buildSegmentFilter(99), buildSegmentFilter(99));
    const r = await scheduleNewsletterKit("/tmp/x", "2026-10-20T09:00:00.000Z", d, { expectedAudienceFilter: buildSegmentFilter(99) });
    assert.equal(r.ok, true);
  });
});

describe("brevo-diaria-run com flags desligadas = sequência atual (#10437)", () => {
  function run(argv: string[], enabled: boolean | undefined) {
    const calls: string[] = [];
    const exec: ExecFn = (script) => {
      calls.push(script);
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = runBrevoDiaria(argv, {
      rootDir: "/fake",
      exec,
      ...(enabled === undefined ? {} : { kitSemAberturaEnabled: () => enabled }),
    });
    return { result, calls };
  }

  it("flag ausente/false ⇒ Passo 3c nunca é invocado (preflight e apply)", () => {
    for (const enabled of [undefined, false]) {
      assert.ok(!run([], enabled).calls.includes("scripts/sync-kit-sem-abertura-to-brevo.ts"));
      assert.ok(!run(["--apply"], enabled).calls.includes("scripts/sync-kit-sem-abertura-to-brevo.ts"));
    }
  });

  it("flag true ⇒ Passo 3c depois do 3b, com --push no apply", () => {
    const { calls, result } = run(["--apply"], true);
    assert.equal(calls[calls.length - 1], "scripts/sync-kit-sem-abertura-to-brevo.ts");
    assert.deepEqual(result.steps[result.steps.length - 1].args, ["--push"]);
  });
});

describe("guard Kit-ativo do #6485 não desfaz a movimentação (#10437)", () => {
  it("contato kit-sem-abertura: in_brevo fica isento; o resto do guard segue igual", async () => {
    const store: BrevoDiariaStore = {
      contacts: [movedContact("m@x.com"), { ...movedContact("velho@x.com"), beehiiv_subscription_id: "kit:9" }],
    };
    assert.deepEqual(kitSemAberturaExemptEmails(store), ["m@x.com"]);
    assert.deepEqual(kitSemAberturaExemptEmails({ contacts: [{ ...movedContact("p@x.com"), status: "promoted_beehiiv" }] }), []);
    const removed: string[][] = [];
    const r = await applyKitActiveExclusionGuard(
      { brevoApiKey: "br", brevoListId: 7, seedEmails: [] },
      {
        fetchBrevoListEmails: async () => ["m@x.com", "velho@x.com"],
        fetchKitActiveEmails: async () => ["m@x.com", "velho@x.com"],
        removeFromBrevoList: async (_k, _l, emails) => {
          removed.push(emails);
          return { contacts: { success: emails, failure: [] } };
        },
        readStore: () => store,
        writeStore: () => {},
        appendLog: () => {},
        now: () => "2026-10-19T00:00:00Z",
      },
    );
    assert.deepEqual(r.excluded, ["velho@x.com"]);
    assert.deepEqual(removed, [["velho@x.com"]]);
  });
});

describe("intro da Brevo por origem (#10437)", () => {
  const render = { pending: () => "<p>PENDING</p>", kitSemAbertura: () => "<p>KIT</p>" };

  it("flag desligada ⇒ exatamente o intro do Pending", () => {
    assert.equal(resolveDailyBrevoIntro(undefined, undefined, render), "<p>PENDING</p>");
    assert.equal(resolveDailyBrevoIntro({ enabled: false }, undefined, render), "<p>PENDING</p>");
  });

  it("flag ligada ⇒ condicional no atributo ORIGEM_DIARIA; sem o snippet da variante, lança", () => {
    const html = resolveDailyBrevoIntro({ enabled: true }, undefined, render)!;
    assert.match(html, /\{% if contact\.ORIGEM_DIARIA == "kit_sem_abertura" %\}\n<p>KIT<\/p>\n\{% else %\}\n<p>PENDING<\/p>\n\{% endif %\}/);
    assert.throws(() => resolveDailyBrevoIntro({ enabled: true }, undefined, { ...render, kitSemAbertura: () => null }));
  });
});

// ── fixes do fleet review (#10437) ───────────────────────────────────────

describe("registro de broadcasts: escopo DOI real no layout aninhado (#10437, armadilha 1)", () => {
  function writeState(root: string, aamm: string, edition: string, file: string, body: string) {
    const dir = join(root, aamm, edition, "_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), body, "utf8");
  }

  it("lê {AAMM}/{AAMMDD}/_internal/*; draft/test_sent descartados; test_broadcast_ids nunca contam", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-sem-abertura-reg-"));
    try {
      writeState(root, "2610", "261016", "newsletter-kit-published.json",
        JSON.stringify({ broadcast_id: 501, status: "scheduled", scheduled_at: "2026-10-16T09:00:00Z", test_broadcast_ids: [9001, 9002] }));
      writeState(root, "2610", "261017", "newsletter-kit-published.json",
        JSON.stringify({ broadcast_id: 502, status: "draft", test_broadcast_ids: [9003] }));
      writeState(root, "2610", "261018", "newsletter-kit-published.json",
        JSON.stringify({ broadcast_id: 503, status: "test_sent", test_broadcast_ids: [9004] }));
      writeState(root, "2609", "260930", "kit-diaria-published.json",
        JSON.stringify({ broadcast_id: 400, status: "scheduled", scheduled_at: "2026-09-30T09:00:00Z" }));
      const recs = readDiariaBroadcastRegistry(root);
      assert.deepEqual(recs.map((r) => r.broadcastId), [400, 501]);
      assert.deepEqual(recs.map((r) => r.edition), ["260930", "261016"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("JSON ilegível no registro ⇒ lança (o Passo 3c aborta, nunca conta sem aquele broadcast)", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-sem-abertura-reg-"));
    try {
      writeState(root, "2610", "261016", "newsletter-kit-published.json", "{ quebrado");
      assert.throws(() => readDiariaBroadcastRegistry(root), /ilegível/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runKitSemAberturaSync: fetchEngagement recebe SÓ os ids do registro (nunca DOI/boas-vindas/teste)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-sem-abertura-reg-"));
    try {
      for (let i = 1; i <= 6; i++) {
        const day = String(i).padStart(2, "0");
        writeState(root, "2610", `2610${day}`, "newsletter-kit-published.json",
          JSON.stringify({ broadcast_id: 700 + i, status: "scheduled", scheduled_at: `2026-10-${day}T09:00:00Z`, test_broadcast_ids: [9900 + i] }));
      }
      const asked: number[] = [];
      const { deps } = fakeDeps({
        readRegistry: () => readDiariaBroadcastRegistry(root),
        fetchEngagement: async (id) => {
          asked.push(id);
          return { broadcastId: id, delivered: ["mover@x.com"], opens: ["leitor-fora-da-base@x.com"], clicks: [] };
        },
      });
      const r = await runKitSemAberturaSync(cfg(true, true), { push: false }, deps);
      assert.deepEqual(asked, [701, 702, 703, 704, 705, 706]);
      assert.equal(r.selected, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registro ilegível ⇒ exit 2, nada lido do Kit nem movido", async () => {
    const { deps, calls } = fakeDeps({
      readRegistry: () => {
        throw new Error("1 arquivo(s) ilegível(is)");
      },
      listKitActive: async () => {
        throw new Error("não deveria listar");
      },
    });
    const r = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.equal(r.code, 2);
    assert.match(r.summary, /lacuna/);
    assert.deepEqual(calls, []);
  });
});

describe("config única + validação (#10437)", () => {
  it("parseDiariaExclusionSegment: ausente/false ⇒ off; true com id ruim ⇒ erro; enabled não booleano ⇒ erro", () => {
    assert.deepEqual(parseDiariaExclusionSegment(undefined), { enabled: false });
    assert.deepEqual(parseDiariaExclusionSegment({ enabled: false, segment_id: null }), { enabled: false });
    assert.deepEqual(parseDiariaExclusionSegment({ enabled: true, segment_id: 99 }), { enabled: true, segmentId: 99 });
    for (const bad of [{ enabled: true, segment_id: null }, { enabled: true, segment_id: 1.5 }, { enabled: true, segment_id: -3 }, { enabled: "true", segment_id: 9 }]) {
      assert.ok("error" in parseDiariaExclusionSegment(bad), JSON.stringify(bad));
    }
  });

  it("sync: segmento ligado com segment_id inválido ⇒ exit 2, ninguém movido", async () => {
    const { deps, calls } = fakeDeps();
    const c = cfg(true, true);
    c.kit = { diaria_exclusion_segment: { enabled: true, segment_id: null } };
    const r = await runKitSemAberturaSync(c, { push: true }, deps);
    assert.equal(r.code, 2);
    assert.deepEqual(calls, []);
  });

  it("parseKitSemAberturaNumbers: min_mature_sends inteiro >=1; janela inteira 1..365", () => {
    assert.deepEqual(parseKitSemAberturaNumbers(undefined), { ok: true, minMatureSends: 6, newSignupWindowDays: 30 });
    for (const bad of [{ min_mature_sends: 0 }, { min_mature_sends: 2.5 }, { new_signup_window_days: 0 }, { new_signup_window_days: 400 }, { new_signup_window_days: 3.2 }]) {
      assert.equal(parseKitSemAberturaNumbers(bad).ok, false, JSON.stringify(bad));
    }
  });

  it("sync: min_mature_sends 0 ⇒ exit 2 (nunca moveria quem nunca recebeu nada)", async () => {
    const { deps, calls } = fakeDeps();
    const c = cfg(true, true);
    c.brevo_diaria!.kit_sem_abertura = { enabled: true, min_mature_sends: 0 };
    const r = await runKitSemAberturaSync(c, { push: true }, deps);
    assert.equal(r.code, 2);
    assert.deepEqual(calls, []);
  });
});

describe("cota da conta também pros cadastros novos, no DIA DE ENVIO (#10437)", () => {
  it("diariaSendDayUtc: amanhã no calendário de Brasília", () => {
    assert.equal(diariaSendDayUtc(Date.parse("2026-10-19T12:00:00Z")), "2026-10-20");
    // 01:00 UTC do dia 20 ainda é dia 19 em BRT ⇒ envio dia 20.
    assert.equal(diariaSendDayUtc(Date.parse("2026-10-20T01:00:00Z")), "2026-10-20");
  });

  it("sync consulta a cota do dia de envio", async () => {
    const days: string[] = [];
    const { deps } = fakeDeps({
      transactionalOnSendDay: async (d) => {
        days.push(d);
        return 0;
      },
    });
    await runKitSemAberturaSync(cfg(true, true), { push: false }, deps);
    assert.deepEqual(days, [diariaSendDayUtc(NOW)]);
  });

  it("cadastros novos que não cabem na cota ⇒ Passo 3c abortado (exit 1), ninguém movido", async () => {
    const { deps, calls } = fakeDeps({
      listKitActive: async () => [candidate("novo@x.com", { id: 43, created_at: new Date(NOW - 5 * DAY).toISOString() })],
      fetchEngagement: async (id) => ({ broadcastId: id, delivered: ["novo@x.com"], opens: ["leitor-fora-da-base@x.com"], clicks: [] }),
      transactionalOnSendDay: async () => 299,
    });
    const r = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.equal(r.code, 1);
    assert.equal(r.moved, 0);
    assert.match(r.summary, /abortado/);
    assert.deepEqual(calls, []);
  });

  it("cota ilegível com cadastros novos ⇒ abortado (cota ilegível nunca vira permissão)", async () => {
    const { deps, calls } = fakeDeps({
      listKitActive: async () => [candidate("novo@x.com", { id: 43, created_at: new Date(NOW - 5 * DAY).toISOString() })],
      fetchEngagement: async (id) => ({ broadcastId: id, delivered: ["novo@x.com"], opens: ["leitor-fora-da-base@x.com"], clicks: [] }),
      transactionalOnSendDay: async () => null,
    });
    const r = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.equal(r.code, 1);
    assert.deepEqual(calls, []);
  });

  it("checkNewSignupsFitAccountQuota: 0 novos sempre ok", () => {
    assert.deepEqual(
      checkNewSignupsFitAccountQuota({ currentActiveCount: 0, seedCount: 0, newCount: 0, dailyLimit: 300, transactionalOnSendDay: null }),
      { ok: true },
    );
  });
});

describe("apoiador confirmado pelo GET singular antes de mover (#10437)", () => {
  it("listagem sem apoio_nivel mas GET singular com nível ⇒ não move", async () => {
    const asked: number[] = [];
    const { deps, calls } = fakeDeps({
      getApoioNivel: async (id) => {
        asked.push(id);
        return "amigo";
      },
    });
    const r = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.deepEqual(asked, [42]);
    assert.equal(r.moved, 0);
    assert.deepEqual(calls, []);
  });

  it("GET singular falha ⇒ adiado, não movido", async () => {
    const { deps, calls } = fakeDeps({
      getApoioNivel: async () => {
        throw new Error("429");
      },
    });
    const r = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.equal(r.moved, 0);
    assert.equal(r.deferred, 1);
    assert.deepEqual(calls, []);
  });
});

describe("contagem sobre ENTREGUES (#10437)", () => {
  it("bounce não conta como envio: 6 broadcasts, entregue em 5 ⇒ envios_insuficientes", () => {
    const per = [1, 2, 3, 4, 5, 6].map((id) => ({ broadcastId: id, delivered: id === 6 ? [] : ["a@x.com"], opens: [], clicks: [] }));
    const idx = buildEngagementIndex(per, new Set([1, 2, 3, 4, 5, 6]));
    assert.equal(select(candidate("a@x.com"), idx).excluded.envios_insuficientes, 1);
  });
});

describe("flag do segmento desligada com gente já movida (#10437)", () => {
  it("countKitSemAberturaInBrevo: conta só kit-sem-abertura: em in_brevo; JSON quebrado com o prefixo ⇒ erro", () => {
    const store = {
      contacts: [
        movedContact("a@x.com"),
        { ...movedContact("b@x.com"), status: "promoted_beehiiv" },
        { ...movedContact("c@x.com"), beehiiv_subscription_id: "kit:1" },
      ],
    };
    assert.deepEqual(countKitSemAberturaInBrevo(JSON.stringify(store)), { count: 1 });
    assert.deepEqual(countKitSemAberturaInBrevo(null), { count: 0 });
    assert.ok("error" in countKitSemAberturaInBrevo('{"contacts":[{"beehiiv_subscription_id":"kit-sem-abertura:1"'));
    const semPrefixo = countKitSemAberturaInBrevo("{ quebrado");
    assert.ok(!("error" in semPrefixo) && semPrefixo.count === 0 && semPrefixo.warning);
  });

  it("resolveDiariaAudience: flag desligada + movidos > 0 ⇒ aborta (nunca base inteira em silêncio)", async () => {
    const r = await resolveDiariaAudience({ enabled: false }, { listSegments: async () => [] }, { movedToBrevoCount: 3 });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /3 contato/);
    const zero = await resolveDiariaAudience({ enabled: false }, { listSegments: async () => [] }, { movedToBrevoCount: 0 });
    assert.equal(zero.ok && zero.mode, "all");
  });

  it("intro da Brevo: flag desligada mas gente movida ⇒ condicional por origem (snippet obrigatório)", () => {
    const render = { pending: () => "<p>PENDING</p>", kitSemAbertura: () => "<p>KIT</p>" };
    assert.match(resolveDailyBrevoIntro({ enabled: false }, undefined, render, 2)!, /ORIGEM_DIARIA/);
    assert.throws(() => resolveDailyBrevoIntro(undefined, undefined, { ...render, kitSemAbertura: () => null }, 2));
    assert.equal(resolveDailyBrevoIntro(undefined, undefined, render, 0), "<p>PENDING</p>");
  });
});

describe("releitura do filtro por estrutura (#10437)", () => {
  it("mesma estrutura com chaves em outra ordem passa; tipo ou id diferente reprova", () => {
    const f = buildSegmentFilter(99);
    assert.equal(verifyDiariaAudienceFilter([{ all: [{ ids: [99], type: "segment" }] }], f).ok, true);
    assert.equal(verifyDiariaAudienceFilter([{ all: [{ type: "tag", ids: [99] }] }], f).ok, false);
    assert.equal(verifyDiariaAudienceFilter([{ all: [{ type: "segment", ids: [98] }] }], f).ok, false);
    assert.equal(verifyDiariaAudienceFilter("lixo", f).ok, false);
  });
});

describe("re-run do publish/schedule sobre broadcast JÁ agendado (#10437)", () => {
  it("publish: filtro divergente num broadcast agendado ⇒ desagenda (unschedule) e avisa o caller", async () => {
    const unscheduled: number[] = [];
    const r = await confirmDiariaAudienceOnBroadcast(7, buildSegmentFilter(99), {
      getBroadcast: async () => ({ subscriber_filter: [] }),
      unschedule: async (id) => {
        unscheduled.push(id);
      },
    });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.unscheduled, true);
    assert.deepEqual(unscheduled, [7]);
  });

  it("unscheduleKitBroadcast: PATCH send_at null + releitura; send_at ainda presente ⇒ lança", async () => {
    const patches: unknown[] = [];
    await unscheduleKitBroadcast(7, {
      updateBroadcast: async (_id, input) => {
        patches.push(input);
      },
      getBroadcast: async () => ({ send_at: null }),
    });
    assert.deepEqual(patches, [{ send_at: null }]);
    await assert.rejects(
      unscheduleKitBroadcast(7, { updateBroadcast: async () => {}, getBroadcast: async () => ({ send_at: "2026-10-20T09:00:00Z" }) }),
      /send_at/,
    );
  });

  it("schedule: pré-checagem acha o broadcast já agendado com filtro divergente ⇒ desagenda, estado local vira draft, code 7", async () => {
    const published: KitNewsletterPublished = {
      broadcast_id: 7,
      subject: "s",
      preview_text: "p",
      status: "scheduled",
      scheduled_at: "2026-10-20T09:00:00.000Z",
    };
    const patches: (string | null)[] = [];
    const written: KitNewsletterPublished[] = [];
    let sendAt: string | null = "2026-10-20T09:00:00.000Z";
    const r = await scheduleNewsletterKit(
      "/tmp/x",
      "2026-10-20T09:00:00.000Z",
      {
        readPublished: () => published,
        writePublished: (_d, st) => {
          written.push(st);
        },
        patchSchedule: async (_id, at) => {
          patches.push(at);
          sendAt = at;
        },
        getBroadcastStatus: async () => ({ status: sendAt ? "scheduled" : "draft", sendAt, subscriberFilter: [] }),
      },
      { expectedAudienceFilter: buildSegmentFilter(99) },
    );
    assert.equal(!r.ok && r.code, 7);
    assert.match(!r.ok ? r.reason : "", /JÁ ESTAVA agendado/);
    assert.match(!r.ok ? r.reason : "", /confirmado por releitura/);
    assert.deepEqual(patches, [null]);
    assert.equal(written[0].status, "draft");
    assert.equal(written[0].scheduled_at, undefined);
  });
});

describe("listSubscriberTags não fabrica [] (#10437)", () => {
  it("envelope sem tags lança; pagina até o fim", async () => {
    const orig = globalThis.fetch;
    try {
      globalThis.fetch = (async () => jsonRes(200, {})) as typeof fetch;
      await assert.rejects(listSubscriberTags(42, { apiKey: "k" }), /sem o array "tags"/);
      const urls: string[] = [];
      globalThis.fetch = (async (url: string | URL) => {
        urls.push(String(url));
        return String(url).includes("after=")
          ? jsonRes(200, { tags: [{ id: 555, name: KIT_ENVIO_BREVO_TAG_NAME }], pagination: { has_next_page: false, end_cursor: null } })
          : jsonRes(200, { tags: [{ id: 1, name: "x" }], pagination: { has_next_page: true, end_cursor: "c1" } });
      }) as typeof fetch;
      const tags = await listSubscriberTags(42, { apiKey: "k" });
      assert.deepEqual(tags.map((t) => t.id), [1, 555]);
      assert.equal(urls.length, 2);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("promoção: DELETE 404 e unlink falhando (#10437)", () => {
  it("DELETE da tag dá 404 ⇒ 'já removida', confirmado pela releitura", async () => {
    const r = await removeKitEnvioBrevoTag({
      subscriberId: 42,
      kitApiKey: "k",
      resolveTagId: async () => 555,
      deps: {
        untag: async () => {
          throw new KitApiError("/tags/555/subscribers/42", 404, "not found");
        },
        listTags: async () => [],
      },
    });
    assert.deepEqual(r, { ok: true });
  });

  it("DELETE 500 ⇒ não confirma", async () => {
    const r = await removeKitEnvioBrevoTag({
      subscriberId: 42,
      kitApiKey: "k",
      resolveTagId: async () => 555,
      deps: {
        untag: async () => {
          throw new KitApiError("/tags/555/subscribers/42", 500, "boom");
        },
        listTags: async () => [],
      },
    });
    assert.equal(r.ok, false);
  });
});

/** fetch da Brevo/Kit pro Passo 0 / promoção com um contato `kit-sem-abertura:`. */
function brevoRouter(
  state: { blacklisted: boolean; unsubscribed?: boolean; hardBounce?: boolean; sent?: number; opened?: number },
  log: string[],
  failUnlink = false,
) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    log.push(`${method} ${u}`);
    if (u.includes("beehiiv")) throw new Error(`não deveria tocar a Beehiiv: ${u}`);
    if (u.includes("api.kit.com")) {
      if (u.includes("/tags?")) return jsonRes(200, { tags: [{ id: 555, name: KIT_ENVIO_BREVO_TAG_NAME }], pagination: { has_next_page: false } });
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (u.includes("/subscribers/42/tags")) return jsonRes(200, { tags: [] });
      throw new Error(`Kit inesperado: ${method} ${u}`);
    }
    if (method === "PUT") {
      if (failUnlink && String(init?.body).includes("unlinkListIds")) return jsonRes(400, { message: "boom" });
      return jsonRes(200, {});
    }
    const sent = state.sent ?? 1;
    const ids = Array.from({ length: sent }, (_, i) => ({ campaignId: i + 1, eventTime: "2026-10-01T09:00:00Z" }));
    return jsonRes(200, {
      emailBlacklisted: state.blacklisted,
      listIds: [7],
      statistics: {
        messagesSent: ids,
        opened: ids.slice(0, state.opened ?? 0),
        ...(state.unsubscribed
          ? { unsubscriptions: { userUnsubscription: [{ campaignId: 1, eventTime: "2026-10-12T00:00:00Z" }], adminUnsubscription: [] } }
          : {}),
        ...(state.hardBounce ? { hardBounces: [{ campaignId: 1, eventTime: "2026-10-12T00:00:00Z" }] } : {}),
      },
    });
  }) as typeof fetch;
}

function kitUnsubDeps(states: string[], calls: string[]) {
  return {
    unsubscribe: async (id: number) => {
      calls.push(`unsubscribe:${id}`);
    },
    getState: async (id: number) => {
      calls.push(`get:${id}`);
      return states.shift() ?? "active";
    },
  };
}

function evalParams(contacts: BrevoDiariaContact[], extra: Partial<Parameters<typeof runEvaluation>[0]> = {}): Parameters<typeof runEvaluation>[0] {
  return {
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
    ...extra,
  };
}

describe("Passo 0: saída NATIVA de kit-sem-abertura: vale nas DUAS bases (#10437); supressão por score nunca descadastra no Kit (#11221)", () => {
  const origFetch = globalThis.fetch;

  for (const [label, state, expected] of [
    ["descadastro nativo", { blacklisted: true, unsubscribed: true }, "unsubscribed"],
    ["hard bounce", { blacklisted: true, hardBounce: true }, "bounced"],
  ] as const) {
    it(`${label}: zero Beehiiv, descadastra no Kit (releitura), desvincula da lista, grava a saída e o log`, async () => {
      const http: string[] = [];
      const kit: string[] = [];
      const logLines: string[] = [];
      globalThis.fetch = brevoRouter(state, http);
      try {
        const r = await runEvaluation(
          evalParams([movedContact("m@x.com")], {
            unsubscribeKitSemAberturaDeps: kitUnsubDeps(["active", "cancelled"], kit),
            appendKitSemAberturaLog: (l) => logLines.push(l),
          }),
        );
        assert.ok(!http.some((u) => u.includes("beehiiv")));
        assert.deepEqual(kit, ["get:42", "unsubscribe:42", "get:42"]);
        assert.ok(http.some((u) => u.startsWith("PUT ")), "desvincula da lista Brevo");
        assert.equal(findContact(r.store, "m@x.com")!.status, expected);
        assert.equal(logLines.length, 1);
        assert.equal(JSON.parse(logLines[0]).event, "kit_unsubscribed");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  }

  it("descadastro no Kit NÃO confirmado (releitura segue active) ⇒ fica in_brevo, falha contada, nada desvinculado", async () => {
    const http: string[] = [];
    const kit: string[] = [];
    globalThis.fetch = brevoRouter({ blacklisted: true, unsubscribed: true }, http);
    try {
      const r = await runEvaluation(
        evalParams([movedContact("m@x.com")], { unsubscribeKitSemAberturaDeps: kitUnsubDeps(["active", "active"], kit) }),
      );
      assert.equal(findContact(r.store, "m@x.com")!.status, "in_brevo");
      assert.equal(r.failed, 1);
      assert.ok(!http.some((u) => u.startsWith("PUT ")));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("supressão por baixa abertura NUNCA descadastra no Kit: volta com a tag frio (#11221 revisa o #10437)", async () => {
    const kit: string[] = [];
    const ops: string[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("beehiiv") || u.includes("api.kit.com")) throw new Error(`inesperado: ${u}`);
      if (method === "PUT") {
        ops.push(`PUT ${String(init?.body)}`);
        return jsonRes(200, {});
      }
      const ids = Array.from({ length: 10 }, (_, i) => ({ campaignId: i + 1, eventTime: "2026-09-01T09:00:00Z" }));
      return jsonRes(200, { emailBlacklisted: false, listIds: [7], statistics: { messagesSent: ids, opened: [] } });
    }) as typeof fetch;
    try {
      const r = await runEvaluation(
        evalParams([movedContact("m@x.com")], {
          unsubscribeKitSemAberturaDeps: kitUnsubDeps(["active", "cancelled"], kit),
          kitFrioFullyOn: true,
          kitFrioTagDeps: {
            findTagId: async () => 900,
            tag: async (t, id) => void ops.push(`tag ${t} ${id}`),
            listTags: async () => [{ id: 900, name: "frio" } as never],
          },
          kitEnvioBrevoTagDeps: {
            findTagId: async () => 555,
            untag: async (t, id) => void ops.push(`untag ${t} ${id}`),
            listTags: async () => [],
          },
        }),
      );
      const stored = findContact(r.store, "m@x.com")!;
      assert.equal(stored.status, "converted_to_kit");
      assert.equal(stored.resolution_reason, "kit_sem_abertura_frio");
      assert.deepEqual(kit, [], "nenhuma leitura/descadastro no Kit pelo caminho de unsubscribe");
      assert.deepEqual(ops.slice(0, 2), ["tag 900 42", "untag 555 42"]);
      assert.ok(!ops.some((o) => o.includes("emailBlacklisted")), "sai da lista Brevo sem blacklist");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("promoção: unlink da Brevo falha depois de remover a tag ⇒ in_brevo, falha registrada (retenta na próxima)", async () => {
    const http: string[] = [];
    globalThis.fetch = brevoRouter({ blacklisted: false, sent: 3, opened: 3 }, http, true);
    try {
      const r = await runEvaluation(evalParams([movedContact("m@x.com")]));
      assert.equal(findContact(r.store, "m@x.com")!.status, "in_brevo");
      assert.equal(r.failed, 1);
      assert.ok(http.some((u) => u.startsWith("DELETE ")));
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("reconcile-send-audiences com o segmento ligado (#10437)", () => {
  it("audiência do Kit = ativos menos a tag envio-brevo e menos os movidos do store", () => {
    assert.deepEqual(
      kitSendAudienceWithExclusionSegment(["a@x.com", "B@x.com", "c@x.com", "d@x.com"], ["b@x.com"], ["c@x.com"]),
      ["a@x.com", "d@x.com"],
    );
  });
});

describe("#10533: movidos sem campanha Brevo", () => {
  const seg = { enabled: true, segment_id: 99 };
  const deps = { listSegments: async () => [{ id: 99, name: "sem envio-brevo" }] };
  it("segmento + movidos + sem campanha Brevo ⇒ aborta (não agenda o Kit em silêncio)", async () => {
    const r = await resolveDiariaAudience(seg, deps, { movedToBrevoCount: 215, brevoCampaignPublished: false });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /SEM a edição/);
  });
  it("segmento + movidos + campanha Brevo existe ⇒ ok; sem movidos ⇒ ok", async () => {
    assert.equal((await resolveDiariaAudience(seg, deps, { movedToBrevoCount: 215, brevoCampaignPublished: true })).ok, true);
    assert.equal((await resolveDiariaAudience(seg, deps, { movedToBrevoCount: 0, brevoCampaignPublished: false })).ok, true);
  });
  it("hasBrevoDiariaCampaign: exige campaign_id numérico", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { hasBrevoDiariaCampaign } = await import("../scripts/lib/kit-diaria-audience.ts");
    const d = mkdtempSync(join(tmpdir(), "t10533-"));
    assert.equal(hasBrevoDiariaCampaign(d), false);
    mkdirSync(join(d, "_internal"));
    writeFileSync(join(d, "_internal", "brevo-diaria-published.json"), "{}");
    assert.equal(hasBrevoDiariaCampaign(d), false);
    writeFileSync(join(d, "_internal", "brevo-diaria-published.json"), '{"campaign_id":7}');
    assert.equal(hasBrevoDiariaCampaign(d), true);
  });
});
