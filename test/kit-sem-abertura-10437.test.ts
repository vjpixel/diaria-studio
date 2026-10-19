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
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEngagementIndex,
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
  resolveDiariaAudience,
  verifyDiariaAudienceFilter,
  KIT_ENVIO_BREVO_TAG_NAME,
} from "../scripts/lib/kit-diaria-audience.ts";
import { buildAllSubscribersFilter, buildSegmentFilter } from "../scripts/lib/kit-broadcasts.ts";
import { parseOrigin, buildOrigin } from "../scripts/lib/shared/brevo-diaria-origin.ts";
import {
  parseKitSubscriberId,
  parseKitSemAberturaSubscriberId,
  removeKitEnvioBrevoTag,
  runEvaluation,
} from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact, type BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";
import { runKitSemAberturaSync, type KitSemAberturaDeps, type KitSemAberturaPlatformConfig } from "../scripts/sync-kit-sem-abertura-to-brevo.ts";
import { scheduleNewsletterKit, type ScheduleNewsletterKitDeps } from "../scripts/schedule-newsletter-kit.ts";
import { confirmDiariaAudienceOnBroadcast } from "../scripts/publish-newsletter-kit.ts";
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
  for (let i = 1; i <= mature; i++) per.push({ broadcastId: i, sent: [email], opens: [], clicks: [] });
  extra.forEach((e, i) => per.push({ broadcastId: 1000 + i, sent: [], opens: [], clicks: [], ...e }));
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

  it("escopo nos broadcasts da diária: abertura do DOI/boas-vindas não está no registro e não conta (cadastro novo qualifica)", () => {
    // O índice só é montado a partir dos broadcasts do registro da diária —
    // nenhum evento fora dele (DOI, boas-vindas) existe aqui por construção.
    const r = select(candidate("novo@x.com", { created_at: "2026-10-05T00:00:00.000Z" }));
    assert.equal(r.selected.length, 1);
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
    const per = sentIds.map((id) => ({ broadcastId: id, sent: ["a@x.com"], opens: [], clicks: [] }));
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
    fetchEngagement: async (id) => ({ broadcastId: id, sent: ["mover@x.com"], opens: [], clicks: [] }),
    findEnvioBrevoTagId: async () => 555,
    readStore: () => store,
    writeStore: (s) => {
      calls.push("store");
      store = s;
    },
    rolloutPaused: () => false,
    transactionalToday: async () => 0,
    ingestBrevo: async (email) => {
      calls.push(`brevo:${email}`);
    },
    tagKit: async (tagId, id) => {
      calls.push(`tag:${tagId}:${id}`);
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
    transactionalToday: boom,
    ingestBrevo: boom,
    tagKit: boom,
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

  it("falha na tag do Kit ⇒ store NÃO gravado (próxima rodada retenta), exit 1", async () => {
    const { deps, calls } = fakeDeps({
      tagKit: async () => {
        throw new Error("429");
      },
    });
    const r = await runKitSemAberturaSync(cfg(true, true), { push: true }, deps);
    assert.equal(r.code, 1);
    assert.deepEqual(calls, ["brevo:mover@x.com"]);
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
