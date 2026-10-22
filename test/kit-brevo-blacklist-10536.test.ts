/**
 * test/kit-brevo-blacklist-10536.test.ts (#10536)
 *
 * Regressão: o Kit→Brevo (#10437) movia quem já estava `emailBlacklisted` na
 * Brevo diária, e o Passo 0 de `evaluate-brevo-diaria.ts` lia esse blacklist
 * antigo como saída nova e DESCADASTRAVA a pessoa no Kit (irreversível).
 *
 * Duas travas:
 * - sync: selecionado já blacklisted na Brevo não é movido (nada no Kit, nada
 *   na Brevo, nada no store); leitura falhando adia, nunca move às cegas.
 * - evaluate: o ramo `kit-sem-abertura:` só trata o blacklist como saída se
 *   houver evento datado em `>= added_at`; senão o Kit não é tocado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runEvaluation,
  isKitSemAberturaBlacklistNew,
  latestBlacklistEventTime,
} from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact, type BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";
import {
  runKitSemAberturaSync,
  type KitSemAberturaDeps,
  type KitSemAberturaPlatformConfig,
} from "../scripts/sync-kit-sem-abertura-to-brevo.ts";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function cfg(): KitSemAberturaPlatformConfig {
  return {
    brevo_diaria: { api_key_env: "X", list_id: 7, daily_send_cap: 295, kit_sem_abertura: { enabled: true } },
    kit: { diaria_exclusion_segment: { enabled: true, segment_id: 99 } },
  };
}

function syncDeps(isBlacklisted: (email: string) => Promise<boolean>) {
  const calls: string[] = [];
  let store: BrevoDiariaStore = { contacts: [] };
  const records = [1, 2, 3, 4, 5, 6].map((i) => ({ broadcastId: i, sentAt: new Date(NOW - (10 - i) * DAY).toISOString(), edition: `e${i}` }));
  const deps: KitSemAberturaDeps = {
    nowMs: NOW,
    log: () => {},
    readRegistry: () => records,
    listKitActive: async () => [
      { id: 42, email: "bloqueada@x.com", created_at: "2026-09-01T00:00:00.000Z", tagNames: [] },
      { id: 43, email: "livre@x.com", created_at: "2026-09-01T00:00:00.000Z", tagNames: [] },
    ],
    fetchEngagement: async (id) => ({ broadcastId: id, delivered: ["bloqueada@x.com", "livre@x.com"], opens: ["leitor-fora-da-base@x.com"], clicks: [] }),
    findEnvioBrevoTagId: async () => 555,
    readStore: () => store,
    writeStore: (s) => {
      calls.push("store");
      store = s;
    },
    rolloutPaused: () => false,
    transactionalOnSendDay: async () => 0,
    getApoioNivel: async () => null,
    isBrevoBlacklisted: async (email) => {
      calls.push(`check:${email}`);
      return isBlacklisted(email);
    },
    ingestBrevo: async (email) => {
      calls.push(`brevo:${email}`);
    },
    tagKit: async (tagId, id) => {
      calls.push(`tag:${tagId}:${id}`);
    },
    untagKit: async (tagId, id) => {
      calls.push(`untag:${tagId}:${id}`);
    },
    appendLog: () => {},
  };
  return { deps, calls, getStore: () => store };
}

describe("sync Kit→Brevo não move quem já está blacklisted na Brevo (#10536)", () => {
  it("blacklisted ⇒ sem ingest, sem tag no Kit, fora do store; o outro é movido normalmente", async () => {
    const { deps, calls, getStore } = syncDeps(async (email) => email === "bloqueada@x.com");
    const r = await runKitSemAberturaSync(cfg(), { push: true }, deps);
    assert.equal(r.code, 0);
    assert.equal(r.moved, 1);
    assert.equal(r.skippedBlacklisted, 1);
    assert.ok(!calls.includes("brevo:bloqueada@x.com"));
    assert.ok(!calls.includes("tag:555:42"), "nunca aplica envio-brevo em quem a Brevo não alcança");
    assert.equal(findContact(getStore(), "bloqueada@x.com"), undefined);
    assert.ok(calls.includes("brevo:livre@x.com"));
    assert.ok(calls.includes("tag:555:43"));
  });

  it("leitura do blacklist falhando ⇒ adiado, nada mutado", async () => {
    const { deps, calls } = syncDeps(async () => {
      throw new Error("HTTP 500");
    });
    const r = await runKitSemAberturaSync(cfg(), { push: true }, deps);
    assert.equal(r.moved, 0);
    assert.ok(r.deferred >= 2);
    assert.ok(!calls.some((c) => c.startsWith("brevo:") || c.startsWith("tag:") || c === "store"));
  });

  it("dry-run também exclui o blacklisted da prévia (sem mutação)", async () => {
    const lines: string[] = [];
    const { deps, calls } = syncDeps(async (email) => email === "bloqueada@x.com");
    deps.log = (m) => lines.push(m);
    const r = await runKitSemAberturaSync(cfg(), { push: false }, deps);
    assert.equal(r.dryRun, true);
    assert.equal(r.skippedBlacklisted, 1);
    assert.ok(lines.some((l) => l.includes("+ livre@x.com")));
    assert.ok(!lines.some((l) => l.includes("+ bloqueada@x.com")));
    assert.ok(!calls.some((c) => c.startsWith("brevo:") || c.startsWith("tag:")));
  });
});

describe("helpers puros do Passo 0 (#10536)", () => {
  it("latestBlacklistEventTime pega o mais recente entre user/admin/hardBounce; sem horário ⇒ null", () => {
    assert.equal(
      latestBlacklistEventTime({
        unsubscriptions: { userUnsubscription: [{ eventTime: "2026-10-01T00:00:00Z" }], adminUnsubscription: [{ eventTime: "2026-10-15T00:00:00Z" }] },
        hardBounces: [{ campaignId: 1, eventTime: "2026-10-05T00:00:00Z" } as never],
      }),
      "2026-10-15T00:00:00.000Z",
    );
    assert.equal(latestBlacklistEventTime({ unsubscriptions: { adminUnsubscription: [{}] } }), null);
    assert.equal(latestBlacklistEventTime(undefined), null);
  });

  it("isKitSemAberturaBlacklistNew: só com evento >= added_at; ausente/anterior/ilegível ⇒ false", () => {
    const added = "2026-10-10T00:00:00.000Z";
    assert.equal(isKitSemAberturaBlacklistNew("2026-10-12T00:00:00.000Z", added), true);
    assert.equal(isKitSemAberturaBlacklistNew(added, added), true);
    assert.equal(isKitSemAberturaBlacklistNew("2026-10-02T00:00:00.000Z", added), false);
    assert.equal(isKitSemAberturaBlacklistNew(null, added), false);
    assert.equal(isKitSemAberturaBlacklistNew(undefined, added), false);
    assert.equal(isKitSemAberturaBlacklistNew("2026-10-12T00:00:00.000Z", "lixo"), false);
  });
});

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

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function brevoBlacklisted(statistics: Record<string, unknown>, http: string[]) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    http.push(`${method} ${u}`);
    if (u.includes("beehiiv") || u.includes("api.kit.com")) throw new Error(`não deveria tocar ${u}`);
    if (method !== "GET") return jsonRes(200, {});
    return jsonRes(200, {
      emailBlacklisted: true,
      listIds: [7],
      statistics: { messagesSent: [{ campaignId: 1, eventTime: "2026-10-11T09:00:00Z" }], opened: [], ...statistics },
    });
  }) as typeof fetch;
}

describe("evaluate: blacklist anterior à entrada não descadastra no Kit (#10536)", () => {
  const origFetch = globalThis.fetch;

  for (const [label, statistics] of [
    ["bloqueio sem evento datado (onboarding transacional #6042)", {}],
    ["hard bounce anterior ao added_at", { hardBounces: [{ campaignId: 9, eventTime: "2026-08-01T00:00:00Z" }] }],
    ["descadastro anterior ao added_at", { unsubscriptions: { userUnsubscription: [{ campaignId: 9, eventTime: "2026-09-01T00:00:00Z" }] } }],
  ] as const) {
    it(`${label}: dry-run — Kit intocado, fica in_brevo, contado à parte (não é falha)`, async () => {
      const http: string[] = [];
      const kit: string[] = [];
      globalThis.fetch = brevoBlacklisted(statistics, http);
      try {
        const contact = movedContact("m@x.com");
        const r = await runEvaluation({
          contacts: [contact],
          store: { contacts: [contact] },
          push: false,
          publicationId: "pub",
          beehiivApiKey: "b",
          brevoApiKey: "br",
          kitApiKey: "k",
          listId: 7,
          log: () => {},
          newsletterBackend: "kit",
          unsubscribeKitSemAberturaDeps: {
            unsubscribe: async (id: number) => {
              kit.push(`unsubscribe:${id}`);
            },
            getState: async (id: number) => {
              kit.push(`get:${id}`);
              return "active";
            },
          },
        });
        assert.deepEqual(kit, [], "nunca descadastra no Kit");
        assert.ok(!http.some((u) => u.startsWith("PUT ")), "nada desvinculado da lista");
        assert.equal(findContact(r.store, "m@x.com")!.status, "in_brevo");
        assert.equal(r.kitSemAberturaPreexistingBlacklist, 1);
        assert.equal(r.failed, 0);
        assert.equal(r.unsubscribedNative + r.bouncedNative, 0);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  }
});
