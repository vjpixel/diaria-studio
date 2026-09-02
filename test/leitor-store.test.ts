/**
 * leitor-store.test.ts (#6464 fatia 7 — #6591)
 *
 * Cobre `scripts/lib/leitor-store.ts` contra um SQLite `:memory:` real:
 * exclusão de `brevo_clarice`, detecção de capacidade `delivered` a partir
 * do dado, derivação `sent − bounce` quando `delivered` não existe,
 * deduplicação de clique por edição (o caso Brevo multi-link), status
 * cross-plataforma "ativo em qualquer uma", e o summary batch com a nota de
 * piso (#6589).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  openDiariaSubscribersDb,
  ensureSubscriber,
  upsertSubscription,
  recordEvent,
  PLATFORMS,
} from "../scripts/lib/diaria-subscribers-db.ts";
import {
  LEITOR_DIARIA_PLATFORMS,
  detectPlatformCapabilities,
  computeReceivedForPlatform,
  computeUniqueClickedForPlatform,
  computeStoreLeitorInput,
  computeStoreLeitorResult,
  summarizeStoreLeitores,
  main as leitorStoreMain,
} from "../scripts/lib/leitor-store.ts";
import { isLeitorV1 } from "../scripts/lib/leitor.ts";

const NOW = "2026-09-01T12:00:00.000Z";

// ---------------------------------------------------------------------------
// LEITOR_DIARIA_PLATFORMS
// ---------------------------------------------------------------------------

describe("LEITOR_DIARIA_PLATFORMS", () => {
  it("exclui brevo_clarice; inclui as 3 plataformas da diária", () => {
    assert.deepEqual([...LEITOR_DIARIA_PLATFORMS].sort(), ["beehiiv", "brevo_diaria", "kit"].sort());
    assert.ok(!LEITOR_DIARIA_PLATFORMS.includes("brevo_clarice"));
  });

  it("é um subconjunto estrito de PLATFORMS (nunca inventa plataforma nova)", () => {
    for (const p of LEITOR_DIARIA_PLATFORMS) {
      assert.ok((PLATFORMS as readonly string[]).includes(p));
    }
  });
});

// ---------------------------------------------------------------------------
// detectPlatformCapabilities
// ---------------------------------------------------------------------------

describe("detectPlatformCapabilities", () => {
  it("marca só as plataformas com ao menos 1 evento delivered gravado", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const kitId = ensureSubscriber(db, "kit", null, "a@x.com", NOW);
    recordEvent(db, { subscriberId: kitId, platform: "kit", type: "delivered", externalEventId: "k1", edicao: "b1", ts: NOW });
    const brevoId = ensureSubscriber(db, "brevo_diaria", "c1", "b@x.com", NOW);
    recordEvent(db, { subscriberId: brevoId, platform: "brevo_diaria", type: "sent", externalEventId: "br1", edicao: "camp1", ts: NOW });

    const caps = detectPlatformCapabilities(db);
    assert.equal(caps.platformsWithDelivered.has("kit"), true);
    assert.equal(caps.platformsWithDelivered.has("brevo_diaria"), false);
    db.close();
  });

  it("store vazio: nenhuma plataforma tem delivered", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const caps = detectPlatformCapabilities(db);
    assert.equal(caps.platformsWithDelivered.size, 0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// computeReceivedForPlatform
// ---------------------------------------------------------------------------

describe("computeReceivedForPlatform", () => {
  it("Kit (delivered explícito): usa COUNT(DISTINCT edicao) de delivered, ignora sent", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "a@x.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "kit", type: "sent", externalEventId: "s1", edicao: "b1", ts: NOW });
    recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: "d1", edicao: "b1", ts: NOW });
    recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: "d2", edicao: "b2", ts: NOW });
    const caps = detectPlatformCapabilities(db);
    assert.equal(computeReceivedForPlatform(db, id, "kit", caps), 2);
    db.close();
  });

  it("Brevo (sem delivered): deriva sent − bounce, nunca negativo", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "brevo_diaria", "c1", "a@x.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "sent", externalEventId: "s1", edicao: "camp1", ts: NOW });
    recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "sent", externalEventId: "s2", edicao: "camp2", ts: NOW });
    recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "sent", externalEventId: "s3", edicao: "camp3", ts: NOW });
    recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "bounce", externalEventId: "b1", edicao: "camp2", ts: NOW });
    const caps = detectPlatformCapabilities(db);
    assert.equal(computeReceivedForPlatform(db, id, "brevo_diaria", caps), 2);
    db.close();
  });

  it("bounce sem sent correspondente (dado inconsistente) nunca produz negativo", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "brevo_diaria", "c1", "a@x.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "bounce", externalEventId: "b1", edicao: "camp1", ts: NOW });
    recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "bounce", externalEventId: "b2", edicao: "camp2", ts: NOW });
    const caps = detectPlatformCapabilities(db);
    assert.equal(computeReceivedForPlatform(db, id, "brevo_diaria", caps), 0);
    db.close();
  });

  it("subscriber sem nenhum evento na plataforma: 0", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "a@x.com", NOW);
    const caps = detectPlatformCapabilities(db);
    assert.equal(computeReceivedForPlatform(db, id, "kit", caps), 0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// computeUniqueClickedForPlatform — o caso central desta fatia
// ---------------------------------------------------------------------------

describe("computeUniqueClickedForPlatform", () => {
  it("Brevo: 2 links clicados na MESMA campanha contam como 1 edição clicada, não 2", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "brevo_diaria", "c1", "a@x.com", NOW);
    // Mesma edicao (campanha), external_event_id diferente por causa da url
    // — exatamente o shape que buildBrevoEventExternalId produz.
    recordEvent(db, {
      subscriberId: id,
      platform: "brevo_diaria",
      type: "click",
      externalEventId: "a@x.com:clicked:77:2026-01-01T00:00:00.000Z:https://a",
      edicao: "77",
      url: "https://a",
      ts: NOW,
    });
    recordEvent(db, {
      subscriberId: id,
      platform: "brevo_diaria",
      type: "click",
      externalEventId: "a@x.com:clicked:77:2026-01-01T00:05:00.000Z:https://b",
      edicao: "77",
      url: "https://b",
      ts: NOW,
    });
    assert.equal(computeUniqueClickedForPlatform(db, id, "brevo_diaria"), 1);
    db.close();
  });

  it("2 edições diferentes clicadas contam como 2", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "brevo_diaria", "c1", "a@x.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "click", externalEventId: "e1", edicao: "77", ts: NOW });
    recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "click", externalEventId: "e2", edicao: "78", ts: NOW });
    assert.equal(computeUniqueClickedForPlatform(db, id, "brevo_diaria"), 2);
    db.close();
  });

  it("Kit: 1 evento click por broadcast já é a contagem certa", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "a@x.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "kit", type: "click", externalEventId: "a@x.com:501:clicks", edicao: "501", ts: NOW });
    assert.equal(computeUniqueClickedForPlatform(db, id, "kit"), 1);
    db.close();
  });

  it("evento legado sem edicao (null) cai no fallback por external_event_id, nunca lança", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "a@x.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "kit", type: "click", externalEventId: "legacy-1", ts: NOW });
    recordEvent(db, { subscriberId: id, platform: "kit", type: "click", externalEventId: "legacy-2", ts: NOW });
    assert.equal(computeUniqueClickedForPlatform(db, id, "kit"), 2);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// computeStoreLeitorInput — soma cross-plataforma + status + exclusão da Clarice
// ---------------------------------------------------------------------------

describe("computeStoreLeitorInput", () => {
  it("soma recebidas/cliques do Beehiiv + Kit pro MESMO subscriber (migração)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    // 1 subscriber, alias em beehiiv E kit (simulando resolução de
    // identidade já rodada, #6589) — mais simples que rodar
    // resolveIdentitiesByEmail aqui: ensureSubscriber com o mesmo alias
    // cross-plataforma exigiria e-mail canonicalizado batendo, o que já é
    // testado em diaria-subscribers-identity-resolve.test.ts; aqui
    // fabricamos o estado PÓS-resolução direto.
    const id = ensureSubscriber(db, "beehiiv", "bh-1", "leitor@x.com", NOW);
    // Kit não tem external_id nativo — ensureSubscriber com um alias NOVO
    // (platform diferente) cria um subscriber novo; simulamos o merge
    // inserindo o alias Kit apontando pro MESMO subscriber_id diretamente
    // (o que resolveIdentitiesByEmail faria de verdade).
    db.prepare(
      "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'kit', NULL, ?, ?)",
    ).run(id, "leitor@x.com", NOW);

    for (let i = 0; i < 15; i++) {
      recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "delivered", externalEventId: `bh-d${i}`, edicao: `bh-ed${i}`, ts: NOW });
    }
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "click", externalEventId: "bh-c1", edicao: "bh-ed1", ts: NOW });

    for (let i = 0; i < 10; i++) {
      recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: `kit-d${i}`, edicao: `kit-ed${i}`, ts: NOW });
    }
    recordEvent(db, { subscriberId: id, platform: "kit", type: "click", externalEventId: "kit-c1", edicao: "kit-ed1", ts: NOW });

    const caps = detectPlatformCapabilities(db);
    const input = computeStoreLeitorInput(db, id, caps);
    assert.equal(input.totalReceived, 25); // 15 + 10
    assert.equal(input.totalUniqueClicked, 2); // 1 + 1
    db.close();
  });

  it("brevo_clarice do MESMO subscriber é ignorado no cômputo (nunca soma engajamento de outro produto)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "leitor@x.com", NOW);
    db.prepare(
      "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'brevo_clarice', ?, ?, ?)",
    ).run(id, "clarice-999", "leitor@x.com", NOW);

    for (let i = 0; i < 5; i++) {
      recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: `kit-d${i}`, edicao: `kit-ed${i}`, ts: NOW });
    }
    // Muito engajamento na Clarice — não deve contar pra leitor-v1 da diária.
    for (let i = 0; i < 100; i++) {
      recordEvent(db, { subscriberId: id, platform: "brevo_clarice", type: "delivered", externalEventId: `cl-d${i}`, edicao: `cl-ed${i}`, ts: NOW });
      recordEvent(db, { subscriberId: id, platform: "brevo_clarice", type: "click", externalEventId: `cl-c${i}`, edicao: `cl-ed${i}`, ts: NOW });
    }

    const caps = detectPlatformCapabilities(db);
    const input = computeStoreLeitorInput(db, id, caps);
    assert.equal(input.totalReceived, 5);
    assert.equal(input.totalUniqueClicked, 0);
    db.close();
  });

  it("status: ativo em QUALQUER plataforma coberta conta como active (migração Beehiiv->Kit)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "bh-1", "leitor@x.com", NOW);
    db.prepare(
      "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'kit', NULL, ?, ?)",
    ).run(id, "leitor@x.com", NOW);
    upsertSubscription(db, id, "beehiiv", { status: "unsubscribed", enteredAt: null, exitedAt: NOW, source: null }, NOW);
    upsertSubscription(db, id, "kit", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);

    const caps = detectPlatformCapabilities(db);
    const input = computeStoreLeitorInput(db, id, caps);
    assert.equal(input.status, "active");
    db.close();
  });

  it("status: nenhuma plataforma coberta ativa -> inactive", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "bh-1", "leitor@x.com", NOW);
    upsertSubscription(db, id, "beehiiv", { status: "unsubscribed", enteredAt: null, exitedAt: NOW, source: null }, NOW);
    const caps = detectPlatformCapabilities(db);
    assert.equal(computeStoreLeitorInput(db, id, caps).status, "inactive");
    db.close();
  });

  it("subscriber sem alias em nenhuma plataforma coberta (só clarice): zeros, status inactive", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "brevo_clarice", "cl-1", "leitor@x.com", NOW);
    upsertSubscription(db, id, "brevo_clarice", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);
    const caps = detectPlatformCapabilities(db);
    const input = computeStoreLeitorInput(db, id, caps);
    assert.deepEqual(input, { status: "inactive", totalReceived: 0, totalUniqueClicked: 0 });
    db.close();
  });
});

// ---------------------------------------------------------------------------
// computeStoreLeitorResult — conveniência input + predicado
// ---------------------------------------------------------------------------

describe("computeStoreLeitorResult", () => {
  it("combina computeStoreLeitorInput + isLeitorV1 num resultado só", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "leitor@x.com", NOW);
    upsertSubscription(db, id, "kit", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);
    for (let i = 0; i < 25; i++) {
      recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: `d${i}`, edicao: `ed${i}`, ts: NOW });
    }
    for (let i = 0; i < 2; i++) {
      recordEvent(db, { subscriberId: id, platform: "kit", type: "click", externalEventId: `c${i}`, edicao: `ed${i}`, ts: NOW });
    }
    const caps = detectPlatformCapabilities(db);
    const result = computeStoreLeitorResult(db, id, caps);
    assert.equal(result.subscriberId, id);
    assert.deepEqual(result.input, { status: "active", totalReceived: 25, totalUniqueClicked: 2 });
    assert.equal(result.isLeitor, isLeitorV1(result.input));
    assert.equal(result.isLeitor, true); // 25 recebidas, 2/25 = 8% CTR >= 2%
    db.close();
  });
});

// ---------------------------------------------------------------------------
// summarizeStoreLeitores — batch + nota de piso
// ---------------------------------------------------------------------------

describe("summarizeStoreLeitores", () => {
  it("store vazio: zeros, sem lançar", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const summary = summarizeStoreLeitores(db);
    assert.equal(summary.total_subscribers, 0);
    assert.equal(summary.total_active, 0);
    assert.equal(summary.leitores_v1, 0);
    assert.equal(summary.note.length > 0, true);
    db.close();
  });

  it("conta leitores-v1 cross-plataforma, ignora quem só existe em brevo_clarice, e sempre inclui a nota de piso", () => {
    const db = openDiariaSubscribersDb(":memory:");

    // Subscriber A: leitor de verdade no Kit (ativo, 25 recebidas, CTR alto).
    const a = ensureSubscriber(db, "kit", null, "leitor-a@x.com", NOW);
    upsertSubscription(db, a, "kit", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);
    for (let i = 0; i < 25; i++) {
      recordEvent(db, { subscriberId: a, platform: "kit", type: "delivered", externalEventId: `a-d${i}`, edicao: `a-ed${i}`, ts: NOW });
    }
    recordEvent(db, { subscriberId: a, platform: "kit", type: "click", externalEventId: "a-c1", edicao: "a-ed1", ts: NOW });

    // Subscriber B: ativo mas CTR baixo — não é leitor.
    const b = ensureSubscriber(db, "kit", null, "nao-leitor-b@x.com", NOW);
    upsertSubscription(db, b, "kit", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);
    for (let i = 0; i < 25; i++) {
      recordEvent(db, { subscriberId: b, platform: "kit", type: "delivered", externalEventId: `b-d${i}`, edicao: `b-ed${i}`, ts: NOW });
    }

    // Subscriber C: só existe na Clarice — fora do universo desta métrica.
    const c = ensureSubscriber(db, "brevo_clarice", "cl-1", "clarice-only@x.com", NOW);
    upsertSubscription(db, c, "brevo_clarice", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);
    for (let i = 0; i < 50; i++) {
      recordEvent(db, { subscriberId: c, platform: "brevo_clarice", type: "delivered", externalEventId: `c-d${i}`, edicao: `c-ed${i}`, ts: NOW });
      recordEvent(db, { subscriberId: c, platform: "brevo_clarice", type: "click", externalEventId: `c-c${i}`, edicao: `c-ed${i}`, ts: NOW });
    }

    const summary = summarizeStoreLeitores(db);
    assert.equal(summary.total_subscribers, 2); // A e B — C fica de fora
    assert.equal(summary.total_active, 2);
    assert.equal(summary.leitores_v1, 1); // só A
    assert.deepEqual(summary.platforms_counted.sort(), ["beehiiv", "brevo_diaria", "kit"].sort());
    assert.match(summary.note, /piso/i);
    db.close();
  });

  it("thresholds customizados sobrescrevem o default sem mutar LEITOR_V1_THRESHOLDS", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const a = ensureSubscriber(db, "kit", null, "leitor@x.com", NOW);
    upsertSubscription(db, a, "kit", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);
    for (let i = 0; i < 5; i++) {
      recordEvent(db, { subscriberId: a, platform: "kit", type: "delivered", externalEventId: `d${i}`, edicao: `ed${i}`, ts: NOW });
    }
    recordEvent(db, { subscriberId: a, platform: "kit", type: "click", externalEventId: "c1", edicao: "ed1", ts: NOW });

    const defaultSummary = summarizeStoreLeitores(db);
    assert.equal(defaultSummary.leitores_v1, 0); // 5 < piso de 20

    const relaxed = summarizeStoreLeitores(db, { ctrMinPct: 2, receivedMin: 3 });
    assert.equal(relaxed.leitores_v1, 1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe("main (CLI)", () => {
  it("--db apontando pra caminho inexistente: exitCode 1, nunca lança", () => {
    const bogusPath = resolve(
      tmpdir(),
      `leitor-store-test-${Date.now()}`,
      "nao-existe",
      "store.db",
    );
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      leitorStoreMain(["--db", bogusPath]);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});
