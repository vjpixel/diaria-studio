/**
 * test/kit-sem-abertura-revert-blacklist-10557.test.ts (#10557)
 *
 * Regressão: depois do #10536, um contato `kit-sem-abertura:` que já estava
 * `emailBlacklisted` na Brevo antes de entrar na lista ficava `in_brevo` sem
 * canal — a Brevo não envia pra ele e a tag `envio-brevo` o tira do segmento
 * da diária no Kit. O evaluate só gerava um warn. E o sync reconciliava órfão
 * blacklisted re-ingerindo-o, sem olhar o blacklist.
 *
 * Agora a movimentação é desfeita nos dois pontos: tag removida no Kit com
 * releitura, desvínculo da lista Brevo e store gravado só depois da
 * confirmação (evaluate); órfão nunca re-ingerido (sync). Nunca descadastro
 * no Kit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEvaluation, type KitEnvioBrevoTagDeps } from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact, type BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";
import {
  runKitSemAberturaSync,
  type KitSemAberturaDeps,
  type KitSemAberturaPlatformConfig,
} from "../scripts/sync-kit-sem-abertura-to-brevo.ts";
import { KIT_ENVIO_BREVO_TAG_NAME } from "../scripts/lib/kit-diaria-audience.ts";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const TAG = 555;

// ── evaluate (Passo 0) ───────────────────────────────────────────────────

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

/** Brevo: contato blacklisted com hard bounce ANTERIOR ao `added_at` (blacklist pré-existente). */
function brevoFetch(http: string[], putStatus = 200) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    http.push(`${method} ${u}${init?.body ? ` ${String(init.body)}` : ""}`);
    if (u.includes("beehiiv") || u.includes("api.kit.com")) throw new Error(`não deveria tocar ${u}`);
    if (method === "PUT") return jsonRes(putStatus, putStatus === 200 ? {} : { message: "bad" });
    return jsonRes(200, {
      emailBlacklisted: true,
      listIds: [7],
      statistics: {
        messagesSent: [{ campaignId: 1, eventTime: "2026-10-11T09:00:00Z" }],
        opened: [],
        hardBounces: [{ campaignId: 9, eventTime: "2026-08-01T00:00:00Z" }],
      },
    });
  }) as typeof fetch;
}

function tagDeps(kit: string[], stillTagged = false): KitEnvioBrevoTagDeps {
  return {
    findTagId: async () => {
      kit.push("findTag");
      return TAG;
    },
    untag: async (tagId, id) => {
      kit.push(`untag:${tagId}:${id}`);
    },
    listTags: async (id) => {
      kit.push(`listTags:${id}`);
      return stillTagged ? [{ id: TAG, name: KIT_ENVIO_BREVO_TAG_NAME } as never] : [];
    },
  };
}

async function evaluate(opts: { putStatus?: number; stillTagged?: boolean }) {
  const http: string[] = [];
  const kit: string[] = [];
  const logLines: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = brevoFetch(http, opts.putStatus);
  try {
    const contact = movedContact("m@x.com");
    const r = await runEvaluation({
      contacts: [contact],
      store: { contacts: [contact] },
      push: true,
      publicationId: "pub",
      beehiivApiKey: "b",
      brevoApiKey: "br",
      kitApiKey: "k",
      listId: 7,
      log: () => {},
      newsletterBackend: "kit",
      appendKitSemAberturaLog: (line) => logLines.push(line),
      unsubscribeKitSemAberturaDeps: {
        unsubscribe: async (id: number) => {
          kit.push(`unsubscribe:${id}`);
        },
        getState: async (id: number) => {
          kit.push(`get:${id}`);
          return "active";
        },
      },
      kitEnvioBrevoTagDeps: tagDeps(kit, opts.stillTagged),
    });
    return { r, http, kit, logLines };
  } finally {
    globalThis.fetch = origFetch;
  }
}

describe("evaluate: desfaz a movimentação de quem já estava blacklisted (#10557)", () => {
  it("tag removida + releitura, desvínculo da lista, converted_to_kit; nunca descadastra no Kit", async () => {
    const { r, http, kit, logLines } = await evaluate({});
    assert.deepEqual(kit, ["findTag", `untag:${TAG}:42`, "listTags:42"], "só remove a tag e relê — nada de unsubscribe");
    const puts = http.filter((h) => h.startsWith("PUT "));
    assert.equal(puts.length, 1);
    assert.match(puts[0], /unlinkListIds/);
    const c = findContact(r.store, "m@x.com")!;
    assert.equal(c.status, "converted_to_kit");
    assert.equal(c.resolution_reason, "kit_sem_abertura_preexisting_blacklist");
    assert.equal(r.kitSemAberturaPreexistingBlacklist, 1);
    assert.equal(r.kitSemAberturaBlacklistReverted, 1);
    assert.equal(r.failed, 0);
    assert.equal(r.unsubscribedNative + r.bouncedNative, 0);
    assert.equal(logLines.length, 1);
    const entry = JSON.parse(logLines[0]);
    assert.equal(entry.event, "kit_tag_removed_preexisting_blacklist");
    assert.equal(entry.step, "evaluate");
    assert.equal(entry.kit_subscriber_id, 42);
  });

  it("releitura ainda mostra a tag ⇒ fica in_brevo, nada desvinculado, conta em failed (exit code)", async () => {
    const { r, http, kit } = await evaluate({ stillTagged: true });
    assert.ok(!kit.some((k) => k.startsWith("unsubscribe")));
    assert.ok(!http.some((h) => h.startsWith("PUT ")), "store/lista só mudam depois da releitura confirmar");
    assert.equal(findContact(r.store, "m@x.com")!.status, "in_brevo");
    assert.equal(r.kitSemAberturaPreexistingBlacklist, 1);
    assert.equal(r.kitSemAberturaBlacklistReverted, 0);
    assert.equal(r.failed, 1);
    assert.match(r.failedContacts[0].reason, /blacklist pré-existente/);
  });

  it("desvínculo da Brevo falha depois da tag removida ⇒ fica in_brevo e conta em failed", async () => {
    const { r } = await evaluate({ putStatus: 400 });
    assert.equal(findContact(r.store, "m@x.com")!.status, "in_brevo");
    assert.equal(r.kitSemAberturaBlacklistReverted, 0);
    assert.equal(r.failed, 1);
  });
});

// ── sync (reconciliação de órfão) ────────────────────────────────────────

function cfg(): KitSemAberturaPlatformConfig {
  return {
    brevo_diaria: { api_key_env: "X", list_id: 7, daily_send_cap: 295, kit_sem_abertura: { enabled: true } },
    kit: { diaria_exclusion_segment: { enabled: true, segment_id: 99 } },
  };
}

function orphanDeps(overrides: Partial<KitSemAberturaDeps>) {
  const calls: string[] = [];
  let store: BrevoDiariaStore = { contacts: [] };
  const records = [1, 2, 3, 4, 5, 6].map((i) => ({ broadcastId: i, sentAt: new Date(NOW - (10 - i) * DAY).toISOString(), edition: `e${i}` }));
  const deps: KitSemAberturaDeps = {
    nowMs: NOW,
    log: () => {},
    readRegistry: () => records,
    // Órfão: tem a tag `envio-brevo` no Kit e não está no store.
    listKitActive: async () => [
      { id: 42, email: "orfa@x.com", created_at: "2026-09-01T00:00:00.000Z", tagNames: [KIT_ENVIO_BREVO_TAG_NAME] },
    ],
    fetchEngagement: async (id) => ({ broadcastId: id, delivered: ["orfa@x.com"], opens: [], clicks: [] }),
    findEnvioBrevoTagId: async () => TAG,
    readStore: () => store,
    writeStore: (s) => {
      calls.push("store");
      store = s;
    },
    rolloutPaused: () => false,
    transactionalOnSendDay: async () => 0,
    getApoioNivel: async () => null,
    isBrevoBlacklisted: async () => true,
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
      calls.push(`log:${JSON.parse(line).event ?? "move"}`);
    },
    ...overrides,
  };
  return { deps, calls, getStore: () => store };
}

describe("sync: órfão blacklisted volta pro Kit em vez de ser re-ingerido (#10557)", () => {
  it("blacklisted ⇒ tag removida, sem ingest, fora do store, exit 0", async () => {
    const { deps, calls, getStore } = orphanDeps({});
    const r = await runKitSemAberturaSync(cfg(), { push: true }, deps);
    assert.equal(r.code, 0);
    assert.equal(r.orphansReturnedToKit, 1);
    assert.equal(r.reconciled, 0);
    assert.ok(calls.includes(`untag:${TAG}:42`));
    assert.ok(calls.includes("log:kit_tag_removed_preexisting_blacklist"));
    assert.ok(!calls.includes("brevo:orfa@x.com"), "nunca re-ingere quem a Brevo não alcança");
    assert.ok(!calls.includes("store"));
    assert.equal(findContact(getStore(), "orfa@x.com"), undefined);
  });

  it("remoção da tag sem confirmação ⇒ falha (exit 1), sem ingest nem store", async () => {
    const { deps, calls } = orphanDeps({
      untagKit: async () => {
        throw new Error("releitura das tags ainda mostra a tag");
      },
    });
    const r = await runKitSemAberturaSync(cfg(), { push: true }, deps);
    assert.equal(r.code, 1);
    assert.equal(r.orphansReturnedToKit, 0);
    assert.ok(!calls.some((c) => c.startsWith("brevo:") || c === "store"));
  });

  it("leitura do blacklist falha ⇒ falha, órfão não é ingerido às cegas", async () => {
    const { deps, calls } = orphanDeps({
      isBrevoBlacklisted: async () => {
        throw new Error("HTTP 500");
      },
    });
    const r = await runKitSemAberturaSync(cfg(), { push: true }, deps);
    assert.equal(r.code, 1);
    assert.ok(!calls.some((c) => c.startsWith("brevo:") || c.startsWith("untag:") || c === "store"));
  });

  it("órfão NÃO blacklisted segue reconciliado como antes (ingest + store)", async () => {
    const { deps, calls, getStore } = orphanDeps({ isBrevoBlacklisted: async () => false });
    const r = await runKitSemAberturaSync(cfg(), { push: true }, deps);
    assert.equal(r.reconciled, 1);
    assert.equal(r.orphansReturnedToKit, 0);
    assert.ok(calls.includes("brevo:orfa@x.com"));
    assert.ok(!calls.some((c) => c.startsWith("untag:")));
    assert.equal(findContact(getStore(), "orfa@x.com")!.beehiiv_subscription_id, "kit-sem-abertura:42");
  });
});
