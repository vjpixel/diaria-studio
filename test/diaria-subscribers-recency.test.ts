/**
 * diaria-subscribers-recency.test.ts (#7163 fatia 13 — #7208)
 *
 * Cobre `scripts/lib/diaria-subscribers-recency.ts`: quarentena de
 * subscribers sintéticos, recência por (subscriber × plataforma) e
 * cross-plataforma, e o teste específico que DOCUMENTA (sem corrigir) o
 * viés `ts` do Kit (todo evento do broadcast carrega o mesmo timestamp).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  openDiariaSubscribersDb,
  ensureSubscriber,
  recordEvent,
} from "../scripts/lib/diaria-subscribers-db.ts";
import {
  isSyntheticSubscriberEmail,
  getSyntheticSubscriberIds,
  filterOutSyntheticSubscribers,
  computeSubscriberPlatformRecency,
  computeSubscriberCrossPlatformRecency,
} from "../scripts/lib/diaria-subscribers-recency.ts";

const NOW = "2026-09-01T12:00:00.000Z";

// ---------------------------------------------------------------------------
// isSyntheticSubscriberEmail
// ---------------------------------------------------------------------------

describe("isSyntheticSubscriberEmail", () => {
  it("detecta a identidade anônima do voto do É IA? (web.eia.diaria.local)", () => {
    assert.equal(isSyntheticSubscriberEmail("a1b2c3@web.eia.diaria.local"), true);
  });

  it("detecta o pseudo-email de token de voto (vote.eia.diaria.local)", () => {
    assert.equal(isSyntheticSubscriberEmail("tok123@vote.eia.diaria.local"), true);
  });

  it("detecta qualquer domínio .local genérico", () => {
    assert.equal(isSyntheticSubscriberEmail("fulano@qualquer-coisa.local"), true);
  });

  it("detecta os domínios reservados RFC 2606 (example.com/.org/.net)", () => {
    assert.equal(isSyntheticSubscriberEmail("a@example.com"), true);
    assert.equal(isSyntheticSubscriberEmail("a@example.org"), true);
    assert.equal(isSyntheticSubscriberEmail("a@example.net"), true);
  });

  it("detecta local-part sintético de suíte E2E (prefixo-epoch), independente do domínio", () => {
    assert.equal(isSyntheticSubscriberEmail("collab-1787632203829-4ltker@clarice.ai"), true);
    assert.equal(isSyntheticSubscriberEmail("test-1787632203829@gmail.com"), true);
    assert.equal(isSyntheticSubscriberEmail("e2e-1787632203829@qualquerdominio.com.br"), true);
  });

  it("NÃO derruba e-mail real com prefixo parecido mas sem o formato epoch", () => {
    assert.equal(isSyntheticSubscriberEmail("teste@gmail.com"), false);
    assert.equal(isSyntheticSubscriberEmail("testadora@gmail.com"), false);
  });

  it("e-mail real de provedor comum não é sintético", () => {
    assert.equal(isSyntheticSubscriberEmail("vjpixel@gmail.com"), false);
  });

  it("null/vazio nunca é sintético", () => {
    assert.equal(isSyntheticSubscriberEmail(null), false);
    assert.equal(isSyntheticSubscriberEmail(undefined), false);
    assert.equal(isSyntheticSubscriberEmail(""), false);
  });
});

// ---------------------------------------------------------------------------
// getSyntheticSubscriberIds / filterOutSyntheticSubscribers
// ---------------------------------------------------------------------------

describe("getSyntheticSubscriberIds", () => {
  it("identifica só os subscribers com e-mail sintético em qualquer plataforma", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const real = ensureSubscriber(db, "beehiiv", "b1", "leitor@gmail.com", NOW);
    const fake = ensureSubscriber(db, "beehiiv", "b2", "verify999@web.eia.diaria.local", NOW);
    const ids = getSyntheticSubscriberIds(db);
    assert.equal(ids.has(fake), true);
    assert.equal(ids.has(real), false);
    db.close();
  });

  it("store sem nenhum e-mail sintético devolve Set vazio", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "kit", null, "a@gmail.com", NOW);
    assert.equal(getSyntheticSubscriberIds(db).size, 0);
    db.close();
  });
});

describe("filterOutSyntheticSubscribers", () => {
  it("remove da lista os ids sintéticos, preserva os reais", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const real = ensureSubscriber(db, "beehiiv", "b1", "leitor@gmail.com", NOW);
    const fake = ensureSubscriber(db, "beehiiv", "b2", "x@example.com", NOW);
    const filtered = filterOutSyntheticSubscribers(db, [real, fake]);
    assert.deepEqual(filtered, [real]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// computeSubscriberPlatformRecency
// ---------------------------------------------------------------------------

describe("computeSubscriberPlatformRecency", () => {
  it("sem nenhum evento: todos os campos null", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "a@gmail.com", NOW);
    const r = computeSubscriberPlatformRecency(db, id, "kit");
    assert.deepEqual(r, {
      lastSent: null,
      lastDelivered: null,
      lastOpened: null,
      lastClicked: null,
      sendsSinceLastOpen: null,
      sendsSinceLastClick: null,
    });
    db.close();
  });

  it("last_* pega o MAX(ts) por tipo, ignorando outra plataforma", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "b1", "a@gmail.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "delivered", externalEventId: "e1", edicao: "260401", ts: "2026-04-01T09:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "delivered", externalEventId: "e2", edicao: "260402", ts: "2026-04-02T09:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "open", externalEventId: "e3", edicao: "260401", ts: "2026-04-01T10:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "click", externalEventId: "e4", edicao: "260401", ts: "2026-04-01T11:00:00.000Z" });
    // Evento em outra plataforma não deve vazar pro cálculo desta.
    recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: "k1", edicao: "999", ts: "2026-05-01T00:00:00.000Z" });

    const r = computeSubscriberPlatformRecency(db, id, "beehiiv");
    assert.equal(r.lastDelivered, "2026-04-02T09:00:00.000Z");
    assert.equal(r.lastOpened, "2026-04-01T10:00:00.000Z");
    assert.equal(r.lastClicked, "2026-04-01T11:00:00.000Z");
    assert.equal(r.lastSent, null); // beehiiv nunca grava "sent"
    db.close();
  });

  it("sends_since_last_open conta edições distintas de sent/delivered DEPOIS da última abertura", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "b1", "a@gmail.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "delivered", externalEventId: "e1", edicao: "260401", ts: "2026-04-01T09:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "open", externalEventId: "e1o", edicao: "260401", ts: "2026-04-01T10:00:00.000Z" });
    // 3 edições entregues depois da abertura de 260401, nenhuma reaberta.
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "delivered", externalEventId: "e2", edicao: "260402", ts: "2026-04-02T09:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "delivered", externalEventId: "e3", edicao: "260403", ts: "2026-04-03T09:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "delivered", externalEventId: "e4", edicao: "260404", ts: "2026-04-04T09:00:00.000Z" });

    const r = computeSubscriberPlatformRecency(db, id, "beehiiv");
    assert.equal(r.sendsSinceLastOpen, 3);
  });

  it("nunca abriu: sends_since_last_open conta TODAS as edições enviadas (âncora null)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "a@gmail.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "kit", type: "sent", externalEventId: "s1", edicao: "b1", ts: "2026-04-01T09:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "kit", type: "sent", externalEventId: "s2", edicao: "b2", ts: "2026-04-02T09:00:00.000Z" });

    const r = computeSubscriberPlatformRecency(db, id, "kit");
    assert.equal(r.lastOpened, null);
    assert.equal(r.sendsSinceLastOpen, 2);
  });

  it("abriu a edição mais recente: sends_since_last_open é 0", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "a@gmail.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "kit", type: "sent", externalEventId: "s1", edicao: "b1", ts: "2026-04-01T09:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "kit", type: "sent", externalEventId: "s2", edicao: "b2", ts: "2026-04-02T09:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "kit", type: "open", externalEventId: "o2", edicao: "b2", ts: "2026-04-02T09:00:00.000Z" });

    const r = computeSubscriberPlatformRecency(db, id, "kit");
    assert.equal(r.sendsSinceLastOpen, 0);
  });

  it("sent e delivered da MESMA edição não duplicam a contagem (COUNT DISTINCT edicao)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "a@gmail.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "kit", type: "sent", externalEventId: "s1", edicao: "b1", ts: "2026-04-01T09:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: "d1", edicao: "b1", ts: "2026-04-01T09:00:00.000Z" });

    const r = computeSubscriberPlatformRecency(db, id, "kit");
    assert.equal(r.sendsSinceLastOpen, 1);
  });
});

// ---------------------------------------------------------------------------
// computeSubscriberCrossPlatformRecency
// ---------------------------------------------------------------------------

describe("computeSubscriberCrossPlatformRecency", () => {
  it("last_* é o mais recente entre as plataformas onde a pessoa existe", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "b1", "a@gmail.com", NOW);
    // Mesma pessoa, mesmo subscriber_id (simulação pós-fusão de identidade —
    // não é preciso rodar resolveIdentitiesByEmail aqui, o teste injeta o
    // mesmo subscriberId nas 2 plataformas diretamente).
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "open", externalEventId: "e1", edicao: "260401", ts: "2026-04-01T10:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "kit", type: "open", externalEventId: "e2", edicao: "b2", ts: "2026-04-05T10:00:00.000Z" });

    const r = computeSubscriberCrossPlatformRecency(db, id);
    assert.equal(r.lastOpened, "2026-04-05T10:00:00.000Z");
  });

  it("sem evento em nenhuma plataforma: todos os campos null", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "b1", "a@gmail.com", NOW);
    const r = computeSubscriberCrossPlatformRecency(db, id);
    assert.deepEqual(r, {
      lastSent: null,
      lastDelivered: null,
      lastOpened: null,
      lastClicked: null,
      sendsSinceLastOpen: null,
      sendsSinceLastClick: null,
    });
  });

  it("usa a chave CANÔNICA de edição — mesma edição em 2 plataformas conta 1x, não 2x (#7204)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "b1", "a@gmail.com", NOW);
    // Mesmo dia de publicação (260401), 2 plataformas, 2 ids nativos
    // diferentes — sem a chave canônica isto contaria como 2 edições.
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "delivered", externalEventId: "e1", edicao: "post_abc", ts: "2026-04-01T09:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "kit", type: "sent", externalEventId: "k1", edicao: "999111", ts: "2026-04-01T09:30:00.000Z" });

    const r = computeSubscriberCrossPlatformRecency(db, id);
    assert.equal(r.sendsSinceLastOpen, 1);
    assert.equal(r.sendsSinceLastClick, 1);
  });

  it("sem a chave canônica o mesmo cenário contaria 2x — trava a regressão que a dedup evita", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "b1", "a@gmail.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "delivered", externalEventId: "e1", edicao: "post_abc", ts: "2026-04-01T09:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "kit", type: "sent", externalEventId: "k1", edicao: "999111", ts: "2026-04-01T09:30:00.000Z" });

    // Contagem NATIVA (sem dedup canônica) — o que este módulo evita.
    const naiveCount = db
      .prepare(
        `SELECT COUNT(DISTINCT platform || ':' || COALESCE(edicao, external_event_id)) AS n
         FROM event WHERE subscriber_id = ? AND type IN ('sent', 'delivered')`,
      )
      .get(id) as { n: number };
    assert.equal(naiveCount.n, 2);

    const r = computeSubscriberCrossPlatformRecency(db, id);
    assert.equal(r.sendsSinceLastOpen, 1);
  });

  it("respeita a lista de plataformas passada explicitamente (nunca inclui brevo_clarice, que nem é Platform válida)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "beehiiv", "b1", "a@gmail.com", NOW);
    recordEvent(db, { subscriberId: id, platform: "beehiiv", type: "open", externalEventId: "e1", edicao: "260401", ts: "2026-04-01T10:00:00.000Z" });
    recordEvent(db, { subscriberId: id, platform: "kit", type: "open", externalEventId: "e2", edicao: "b2", ts: "2026-04-05T10:00:00.000Z" });

    const r = computeSubscriberCrossPlatformRecency(db, id, ["beehiiv"]);
    assert.equal(r.lastOpened, "2026-04-01T10:00:00.000Z"); // ignora o evento do Kit
  });
});

// ---------------------------------------------------------------------------
// Viés do Kit — documentado, NÃO corrigido (ver docstring do módulo,
// "Contaminação 2")
// ---------------------------------------------------------------------------

describe("viés do Kit: ts é do broadcast, não da pessoa (documentado, não corrigido)", () => {
  it("2 assinantes que abriram o MESMO broadcast (ts idêntico, herdado do disparo) aparentam ter aberto no mesmo instante", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const broadcastTs = "2026-04-05T13:00:00.000Z"; // published_at do broadcast, não hora real de abertura
    const alice = ensureSubscriber(db, "kit", null, "alice@gmail.com", NOW);
    const bob = ensureSubscriber(db, "kit", null, "bob@gmail.com", NOW);
    // ingestBroadcastAudience grava exatamente este padrão: MESMO ts pros 2,
    // porque POST /v4/subscribers/filter não devolve timestamp por pessoa.
    recordEvent(db, { subscriberId: alice, platform: "kit", type: "open", externalEventId: "alice:broadcast1:opens", edicao: "broadcast1", ts: broadcastTs });
    recordEvent(db, { subscriberId: bob, platform: "kit", type: "open", externalEventId: "bob:broadcast1:opens", edicao: "broadcast1", ts: broadcastTs });

    const rAlice = computeSubscriberPlatformRecency(db, alice, "kit");
    const rBob = computeSubscriberPlatformRecency(db, bob, "kit");
    // Este `equal` é o COMPORTAMENTO DOCUMENTADO (viés), não uma garantia
    // desejável — se o Kit algum dia passar a devolver timestamp real por
    // pessoa e o ingestor for atualizado pra usá-lo, este teste deve
    // começar a falhar, e é esse o sinal de que o docstring precisa mudar
    // junto.
    assert.equal(rAlice.lastOpened, rBob.lastOpened);
    assert.equal(rAlice.lastOpened, broadcastTs);
  });

  it("Beehiiv NÃO tem este viés — cada evento carrega o ts real do webhook/API por-contato", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const alice = ensureSubscriber(db, "beehiiv", "b1", "alice@gmail.com", NOW);
    const bob = ensureSubscriber(db, "beehiiv", "b2", "bob@gmail.com", NOW);
    recordEvent(db, { subscriberId: alice, platform: "beehiiv", type: "open", externalEventId: "a1", edicao: "post1", ts: "2026-04-05T13:05:00.000Z" });
    recordEvent(db, { subscriberId: bob, platform: "beehiiv", type: "open", externalEventId: "b1", edicao: "post1", ts: "2026-04-05T18:40:00.000Z" });

    const rAlice = computeSubscriberPlatformRecency(db, alice, "beehiiv");
    const rBob = computeSubscriberPlatformRecency(db, bob, "beehiiv");
    assert.notEqual(rAlice.lastOpened, rBob.lastOpened);
  });
});
