/**
 * leitor-store.test.ts (#6464 fatia 7 — #6591)
 *
 * Cobre `scripts/lib/leitor-store.ts` contra um SQLite `:memory:` real:
 * detecção de capacidade `delivered` a partir do dado, derivação
 * `sent − bounce` quando `delivered` não existe, deduplicação de clique por
 * edição (o caso Brevo multi-link), status cross-plataforma "ativo em
 * qualquer uma", o summary batch com a nota de piso (#6589), e o guard de
 * cobertura de `subscription` (#7198 — "0 leitores" não é fato quando a
 * dimensão `subscription` está pouco populada). `brevo_clarice` nunca é
 * um valor de `Platform` válido desde #7196 — a exclusão virou estrutural
 * (guard mecânico em `test/store-excludes-clarice.test.ts`), então os
 * cenários que este arquivo testava com `brevo_clarice` como plataforma
 * real foram substituídos por cenários com `platforms` restrito
 * explicitamente pelo caller.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
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
  computeStoreLeitorInputCanonicalDedup,
  computeStoreLeitorResult,
  summarizeStoreLeitores,
  summarizeStoreLeitoresCanonicalDedup,
  main as leitorStoreMain,
} from "../scripts/lib/leitor-store.ts";
import { isLeitorV1 } from "../scripts/lib/leitor.ts";
import { buildCanonicalEdicaoMapFromEvents } from "../scripts/lib/diaria-subscribers-edicao-canonica.ts";

const NOW = "2026-09-01T12:00:00.000Z";

// ---------------------------------------------------------------------------
// LEITOR_DIARIA_PLATFORMS
// ---------------------------------------------------------------------------

describe("LEITOR_DIARIA_PLATFORMS", () => {
  it("as 3 plataformas da diária (brevo_clarice nunca existiu como valor de Platform desde #7196)", () => {
    assert.deepEqual([...LEITOR_DIARIA_PLATFORMS].sort(), ["beehiiv", "brevo_diaria", "kit"].sort());
  });

  it("é (hoje) idêntico a PLATFORMS (nunca inventa plataforma nova)", () => {
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

  it("event.subtype (#7203, hard/soft do bounce da Brevo) não muda o cálculo — a leitura ainda casa por type='bounce', ignorando subtype", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "brevo_diaria", "c1", "a@x.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "sent", externalEventId: "s1", edicao: "camp1", ts: NOW });
    recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "sent", externalEventId: "s2", edicao: "camp2", ts: NOW });
    recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "sent", externalEventId: "s3", edicao: "camp3", ts: NOW });
    recordEvent(db, {
      subscriberId: id,
      platform: "brevo_diaria",
      type: "bounce",
      externalEventId: "b1",
      edicao: "camp2",
      subtype: "hard",
      ts: NOW,
    });
    const caps = detectPlatformCapabilities(db);
    // Idêntico ao teste "Brevo (sem delivered): deriva sent − bounce" acima —
    // o único delta é subtype: "hard" no bounce, resultado tem que ser igual.
    assert.equal(computeReceivedForPlatform(db, id, "brevo_diaria", caps), 2);
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

  it("plataforma fora de `platforms` (restrito pelo caller) é ignorada no cômputo, mesmo com evento gravado", () => {
    // Não existe mais um valor de Platform "fora da diária" por default
    // (#7196) — este cenário só acontece quando o CALLER restringe
    // `platforms` explicitamente (ex: análise ad-hoc só do Kit). Mesmo
    // comportamento que a exclusão de brevo_clarice tinha antes do #7196,
    // agora exercitado via restrição explícita em vez de uma plataforma
    // "de outro produto" fixa.
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "leitor@x.com", NOW);
    db.prepare(
      "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'brevo_diaria', ?, ?, ?)",
    ).run(id, "brevo-999", "leitor@x.com", NOW);

    for (let i = 0; i < 5; i++) {
      recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: `kit-d${i}`, edicao: `kit-ed${i}`, ts: NOW });
    }
    // Muito engajamento na Brevo — não deve contar quando o caller pediu
    // só Kit.
    for (let i = 0; i < 100; i++) {
      recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "delivered", externalEventId: `br-d${i}`, edicao: `br-ed${i}`, ts: NOW });
      recordEvent(db, { subscriberId: id, platform: "brevo_diaria", type: "click", externalEventId: `br-c${i}`, edicao: `br-ed${i}`, ts: NOW });
    }

    const onlyKit = ["kit"] as const;
    const caps = detectPlatformCapabilities(db, onlyKit);
    const input = computeStoreLeitorInput(db, id, caps, onlyKit);
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

  it("subscriber sem alias em nenhuma plataforma coberta (platforms restrito pelo caller): zeros, status inactive", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "bh-1", "leitor@x.com", NOW);
    upsertSubscription(db, id, "beehiiv", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);
    const onlyKit = ["kit"] as const;
    const caps = detectPlatformCapabilities(db, onlyKit);
    const input = computeStoreLeitorInput(db, id, caps, onlyKit);
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

  it("conta leitores-v1 cross-plataforma (platforms restrito exclui quem está fora), e sempre inclui a nota de piso", () => {
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

    // Subscriber C: só existe na Brevo — quando o caller restringe
    // `platforms` a só Kit, fica fora do universo desta métrica (mesmo
    // efeito que a exclusão de brevo_clarice tinha antes do #7196).
    const c = ensureSubscriber(db, "brevo_diaria", "br-1", "brevo-only@x.com", NOW);
    upsertSubscription(db, c, "brevo_diaria", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);
    for (let i = 0; i < 50; i++) {
      recordEvent(db, { subscriberId: c, platform: "brevo_diaria", type: "delivered", externalEventId: `c-d${i}`, edicao: `c-ed${i}`, ts: NOW });
      recordEvent(db, { subscriberId: c, platform: "brevo_diaria", type: "click", externalEventId: `c-c${i}`, edicao: `c-ed${i}`, ts: NOW });
    }

    const onlyKit = ["kit"] as const;
    const summary = summarizeStoreLeitores(db, undefined, onlyKit);
    assert.equal(summary.total_subscribers, 2); // A e B — C fica de fora (só Brevo, fora de `platforms`)
    assert.equal(summary.total_active, 2);
    assert.equal(summary.leitores_v1, 1); // só A
    assert.deepEqual(summary.platforms_counted, ["kit"]);
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
// Guard de cobertura de subscription (#7198) — "0 leitores" não é fato
// quando a dimensão `subscription` está pouco populada. Regressão do bug:
// antes deste guard, o cenário abaixo (eventos presentes, `subscription`
// vazia — o estado REAL medido no store em 02/09/2026) devolvia
// `leitores_v1: 0`/`total_active: 0` sem NENHUM sinal de que o número não
// era confiável.
// ---------------------------------------------------------------------------

describe("subscription_data_coverage_low (#7198)", () => {
  it("subscription inteiramente vazia (estado de produção medido) + eventos presentes: coverage_low true, avisa", () => {
    const db = openDiariaSubscribersDb(":memory:");
    // 229 pessoas "passariam nos cortes de recebidas/CTR" segundo a issue —
    // aqui simulado em escala menor: 3 subscribers com engajamento real,
    // NENHUM com upsertSubscription chamado (subscription fica vazia).
    for (let n = 0; n < 3; n++) {
      const id = ensureSubscriber(db, "kit", null, `leitor-${n}@x.com`, NOW);
      for (let i = 0; i < 25; i++) {
        recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: `${n}-d${i}`, edicao: `${n}-ed${i}`, ts: NOW });
      }
      recordEvent(db, { subscriberId: id, platform: "kit", type: "click", externalEventId: `${n}-c1`, edicao: `${n}-ed1`, ts: NOW });
    }

    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    let summary;
    try {
      summary = summarizeStoreLeitores(db);
    } finally {
      console.warn = originalWarn;
    }

    // Sem subscription, status cross-plataforma cai em "inactive" pra todo
    // mundo (resolveCrossPlatformStatus não acha nenhuma linha "active") —
    // leitores_v1/total_active saem 0, exatamente o "0 sem aviso" do bug.
    assert.equal(summary.total_active, 0);
    assert.equal(summary.leitores_v1, 0);
    // O que muda com o fix: o resultado agora carrega o sinal explícito de
    // que esse "0" não é fato.
    assert.equal(summary.subscription_data_coverage_low, true);
    assert.ok(warned, "console.warn deve disparar quando a cobertura está baixa");
    db.close();
  });

  it("subscription bem populada (cobertura alta): coverage_low false, sem warn", () => {
    const db = openDiariaSubscribersDb(":memory:");
    for (let n = 0; n < 3; n++) {
      const id = ensureSubscriber(db, "kit", null, `leitor-${n}@x.com`, NOW);
      upsertSubscription(db, id, "kit", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);
      recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: `${n}-d1`, edicao: `${n}-ed1`, ts: NOW });
    }
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    let summary;
    try {
      summary = summarizeStoreLeitores(db);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(summary.subscription_data_coverage_low, false);
    assert.equal(warned, false);
    db.close();
  });

  it("store vazio (sem subscriber nenhum): coverage_low false — nada pra avaliar cobertura", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const summary = summarizeStoreLeitores(db);
    assert.equal(summary.subscription_data_coverage_low, false);
    db.close();
  });
});

describe("StoreLeitorResult.missingSubscriptionData (#7198 — propagado pra ficha do painel)", () => {
  it("subscriber sem NENHUMA subscription nas plataformas cobertas: missingSubscriptionData true, mesmo com isLeitor false por falta de dado", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "leitor@x.com", NOW);
    for (let i = 0; i < 25; i++) {
      recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: `d${i}`, edicao: `ed${i}`, ts: NOW });
    }
    const caps = detectPlatformCapabilities(db);
    const result = computeStoreLeitorResult(db, id, caps);
    assert.equal(result.missingSubscriptionData, true);
    assert.equal(result.isLeitor, false); // status "inactive" por falta de subscription — não é "não é leitor", é "não sei"
    db.close();
  });

  it("subscriber COM subscription gravada: missingSubscriptionData false", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "leitor@x.com", NOW);
    upsertSubscription(db, id, "kit", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);
    const caps = detectPlatformCapabilities(db);
    const result = computeStoreLeitorResult(db, id, caps);
    assert.equal(result.missingSubscriptionData, false);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// computeStoreLeitorInputCanonicalDedup / summarizeStoreLeitoresCanonicalDedup
// (#7204) — o caso central: mesma pessoa, mesma edição do dia, 2 plataformas
// ---------------------------------------------------------------------------

describe("computeStoreLeitorInputCanonicalDedup — dedup por edição canônica", () => {
  it("hoje (computeStoreLeitorInput) conta 2 recebidas pra 1 edição enviada por 2 plataformas; com a canônica conta 1", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "bh-1", "leitor@x.com", NOW);
    db.prepare(
      "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'kit', NULL, ?, ?)",
    ).run(id, "leitor@x.com", NOW);

    // A MESMA edição do dia 27/04, disparada pela Beehiiv às 06:00 BRT e
    // pelo Kit às 06:10 BRT — ids nativos diferentes, mesmo dia editorial.
    recordEvent(db, {
      subscriberId: id,
      platform: "beehiiv",
      type: "delivered",
      externalEventId: "bh-d1",
      edicao: "post_abc",
      ts: "2026-04-27T09:00:00.000Z", // 06:00 BRT
    });
    recordEvent(db, {
      subscriberId: id,
      platform: "kit",
      type: "delivered",
      externalEventId: "kit-d1",
      edicao: "bcast_xyz",
      ts: "2026-04-27T09:10:00.000Z", // 06:10 BRT
    });

    const caps = detectPlatformCapabilities(db);

    // Hoje: soma por plataforma — 1 + 1 = 2 (dupla contagem).
    const naive = computeStoreLeitorInput(db, id, caps);
    assert.equal(naive.totalReceived, 2);

    // Com a canônica: dedup pela mesma edição do dia — 1.
    const canonicalMap = buildCanonicalEdicaoMapFromEvents(db);
    const deduped = computeStoreLeitorInputCanonicalDedup(db, id, caps, canonicalMap);
    assert.equal(deduped.totalReceived, 1);
    db.close();
  });

  it("2 edições GENUINAMENTE diferentes (dias diferentes) continuam contando 2 mesmo com a canônica", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "leitor@x.com", NOW);
    recordEvent(db, {
      subscriberId: id,
      platform: "kit",
      type: "delivered",
      externalEventId: "d1",
      edicao: "bcast-27",
      ts: "2026-04-27T09:00:00.000Z",
    });
    recordEvent(db, {
      subscriberId: id,
      platform: "kit",
      type: "delivered",
      externalEventId: "d2",
      edicao: "bcast-28",
      ts: "2026-04-28T09:00:00.000Z",
    });

    const caps = detectPlatformCapabilities(db);
    const canonicalMap = buildCanonicalEdicaoMapFromEvents(db);
    const deduped = computeStoreLeitorInputCanonicalDedup(db, id, caps, canonicalMap);
    assert.equal(deduped.totalReceived, 2);
    db.close();
  });

  it("cliques da MESMA edição do dia por 2 plataformas também dedupam pra 1", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "bh-1", "leitor@x.com", NOW);
    db.prepare(
      "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'kit', NULL, ?, ?)",
    ).run(id, "leitor@x.com", NOW);

    for (const [platform, edicao, ts] of [
      ["beehiiv", "post_abc", "2026-04-27T09:00:00.000Z"],
      ["kit", "bcast_xyz", "2026-04-27T09:10:00.000Z"],
    ] as const) {
      recordEvent(db, {
        subscriberId: id,
        platform,
        type: "delivered",
        externalEventId: `${platform}-d1`,
        edicao,
        ts,
      });
      recordEvent(db, {
        subscriberId: id,
        platform,
        type: "click",
        externalEventId: `${platform}-c1`,
        edicao,
        ts,
      });
    }

    const caps = detectPlatformCapabilities(db);
    const canonicalMap = buildCanonicalEdicaoMapFromEvents(db);
    const naive = computeStoreLeitorInput(db, id, caps);
    const deduped = computeStoreLeitorInputCanonicalDedup(db, id, caps, canonicalMap);
    assert.equal(naive.totalUniqueClicked, 2);
    assert.equal(deduped.totalUniqueClicked, 1);
    db.close();
  });
});

describe("summarizeStoreLeitoresCanonicalDedup", () => {
  it("mesmo shape de summarizeStoreLeitores, com a nota de PISO, e leitores_v1 <= a versão não-deduplicada", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "bh-1", "leitor@x.com", NOW);
    db.prepare(
      "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'kit', NULL, ?, ?)",
    ).run(id, "leitor@x.com", NOW);
    upsertSubscription(db, id, "beehiiv", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);

    // 25 edições REAIS (dias distintos) na Beehiiv — passa no piso de 20
    // recebidas mesmo depois do dedup canônico (nenhuma delas se repete
    // entre plataformas).
    for (let i = 0; i < 25; i++) {
      recordEvent(db, {
        subscriberId: id,
        platform: "beehiiv",
        type: "delivered",
        externalEventId: `bh-d${i}`,
        edicao: `post-${i}`,
        ts: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, "0")}T09:00:00.000Z`,
      });
    }
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "click", externalEventId: "bh-c1", edicao: "post-0", ts: NOW });

    const summary = summarizeStoreLeitoresCanonicalDedup(db);
    assert.equal(summary.total_subscribers, 1);
    assert.match(summary.note, /PISO/);
    assert.equal(summary.leitores_v1, 1); // 25 recebidas, CTR 4% >= 2%
    db.close();
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe("main (CLI)", () => {
  it("--canonical-dedup imprime summary via summarizeStoreLeitoresCanonicalDedup (mesmo shape)", () => {
    const dataRoot = mkdtempSync(resolve(tmpdir(), "leitor-store-canonical-cli-"));
    const dbDir = resolve(dataRoot, "diaria-subscribers");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, "diaria-subscribers.db");
    const seed = openDiariaSubscribersDb(dbPath);
    ensureSubscriber(seed, "kit", null, "leitor@x.com", NOW);
    seed.close();

    const origLog = console.log;
    let out = "";
    console.log = (msg?: unknown) => {
      out += String(msg);
    };
    try {
      leitorStoreMain(["--db", dbPath, "--canonical-dedup"]);
    } finally {
      console.log = origLog;
    }
    const payload = JSON.parse(out);
    assert.match(payload.note, /PISO/);
    assert.equal(payload.total_subscribers, 1); // 1 alias em kit, mesmo sem evento
    assert.equal(payload.leitores_v1, 0); // sem evento nenhum, nunca passa no piso
  });

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
