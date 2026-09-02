import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  openDiariaSubscribersDb,
  ensureSubscriber,
  upsertSubscription,
  recordEvent,
  getStoreCounts,
  getSubscriberTimeline,
  findSubscriberIdsByEmail,
} from "../scripts/lib/diaria-subscribers-db.ts";
import {
  resolveIdentitiesByEmail,
  buildUnmatchedReport,
  CROSS_PLATFORM_FLOOR_NOTE,
} from "../scripts/lib/diaria-subscribers-identity-resolve.ts";

const NOW = "2026-09-02T09:00:00.000Z";

// ---------------------------------------------------------------------------
// resolveIdentitiesByEmail — casamento determinístico por e-mail
// ---------------------------------------------------------------------------

describe("resolveIdentitiesByEmail — casa por e-mail exato entre plataformas", () => {
  it("funde 2 subscribers de plataformas diferentes com o MESMO e-mail em 1 só", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const beehiivId = ensureSubscriber(db, "beehiiv", "bh-1", "leitor@example.com", NOW);
    const kitId = ensureSubscriber(db, "kit", null, "leitor@example.com", NOW);
    assert.notEqual(beehiivId, kitId);

    const summary = resolveIdentitiesByEmail(db, NOW);

    assert.equal(summary.email_groups_merged, 1);
    assert.equal(summary.subscribers_merged, 1);

    const counts = getStoreCounts(db);
    assert.equal(counts.subscribers, 1);
    assert.equal(counts.identity_aliases, 2);

    const ids = findSubscriberIdsByEmail(db, "leitor@example.com");
    assert.equal(ids.length, 1);
    db.close();
  });

  it("mantém o subscriber_id de MENOR id como canônico (determinístico, estável)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const beehiivId = ensureSubscriber(db, "beehiiv", "bh-1", "leitor@example.com", NOW);
    const kitId = ensureSubscriber(db, "kit", null, "leitor@example.com", NOW);
    const lowerId = Math.min(beehiivId, kitId);

    resolveIdentitiesByEmail(db, NOW);

    const ids = findSubscriberIdsByEmail(db, "leitor@example.com");
    assert.deepEqual(ids, [lowerId]);
    db.close();
  });

  it("funde 3 plataformas com o mesmo e-mail num único subscriber (transitivo, não só pares)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "beehiiv", "bh-1", "jornada@example.com", NOW);
    ensureSubscriber(db, "brevo_diaria", "brevo-1", "jornada@example.com", NOW);
    ensureSubscriber(db, "kit", null, "jornada@example.com", NOW);
    assert.equal(getStoreCounts(db).subscribers, 3);

    const summary = resolveIdentitiesByEmail(db, NOW);

    assert.equal(summary.email_groups_merged, 1);
    assert.equal(summary.subscribers_merged, 2); // 3 subscribers -> 1 = 2 merges
    assert.equal(getStoreCounts(db).subscribers, 1);
    assert.deepEqual(findSubscriberIdsByEmail(db, "jornada@example.com").length, 1);
    db.close();
  });

  it("preserva TODOS os eventos das identidades fundidas numa timeline unificada", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const beehiivId = ensureSubscriber(db, "beehiiv", "bh-1", "jornada@example.com", NOW);
    const kitId = ensureSubscriber(db, "kit", null, "jornada@example.com", NOW);

    recordEvent(db, {
      subscriberId: beehiivId,
      platform: "beehiiv",
      type: "subscribe",
      externalEventId: "beehiiv-sub:bh-1",
      ts: "2025-01-01T00:00:00.000Z",
    });
    recordEvent(db, {
      subscriberId: kitId,
      platform: "kit",
      type: "click",
      externalEventId: "kit-broadcast-1:jornada@example.com",
      ts: "2026-08-15T00:00:00.000Z",
    });

    const summary = resolveIdentitiesByEmail(db, NOW);
    const canonicalId = summary.merges[0].canonical_subscriber_id;

    const timeline = getSubscriberTimeline(db, canonicalId);
    assert.equal(timeline.length, 2);
    assert.deepEqual(
      timeline.map((e) => e.platform),
      ["beehiiv", "kit"],
    );
    db.close();
  });
});

describe("resolveIdentitiesByEmail — canonicalização Gmail (ponto/plus, #1969)", () => {
  it("casa 'user.name@gmail.com' (beehiiv) com 'username+promo@gmail.com' (kit) — mesma caixa Gmail", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "beehiiv", "bh-1", "user.name@gmail.com", NOW);
    ensureSubscriber(db, "kit", null, "username+promo@gmail.com", NOW);

    const summary = resolveIdentitiesByEmail(db, NOW);

    assert.equal(summary.subscribers_merged, 1);
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });

  it("casa 2 variantes de ponto do MESMO Gmail dentro da MESMA plataforma (Kit não tem external_id)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    // Kit ingere só por e-mail (sem external_id nativo) — duas grafias do
    // mesmo Gmail viram 2 identity_alias distintos na ingestão bruta.
    ensureSubscriber(db, "kit", null, "a.b.c@gmail.com", NOW);
    ensureSubscriber(db, "kit", null, "abc@gmail.com", NOW);
    assert.equal(getStoreCounts(db).subscribers, 2);

    const summary = resolveIdentitiesByEmail(db, NOW);

    assert.equal(summary.subscribers_merged, 1);
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });

  it("NÃO casa domínios não-Gmail com ponto (pontos são significativos fora do Gmail)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "beehiiv", "bh-1", "user.name@empresa.com.br", NOW);
    ensureSubscriber(db, "kit", null, "username@empresa.com.br", NOW);

    const summary = resolveIdentitiesByEmail(db, NOW);

    assert.equal(summary.subscribers_merged, 0);
    assert.equal(getStoreCounts(db).subscribers, 2);
    db.close();
  });
});

describe("resolveIdentitiesByEmail — sem heurística: casos que ficam separados de propósito", () => {
  it("NÃO casa e-mails genuinamente diferentes (sem heurística de nome/proximidade)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "beehiiv", "bh-1", "pixel@example.com", NOW);
    ensureSubscriber(db, "kit", null, "pixel@outrodominio.com", NOW);

    const summary = resolveIdentitiesByEmail(db, NOW);

    assert.equal(summary.subscribers_merged, 0);
    assert.equal(getStoreCounts(db).subscribers, 2);
    db.close();
  });

  it("NÃO casa voto anônimo do É IA? ({uuid}@web...) com identidade real de outra plataforma", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "beehiiv", "bh-1", "leitor@example.com", NOW);
    ensureSubscriber(
      db,
      "kit",
      null,
      "3f9a1c2e-7b4d-4e11-9c3a-1a2b3c4d5e6f@web.diar.ia.br",
      NOW,
    );

    const summary = resolveIdentitiesByEmail(db, NOW);

    assert.equal(summary.subscribers_merged, 0);
    assert.equal(getStoreCounts(db).subscribers, 2);
    db.close();
  });
});

describe("resolveIdentitiesByEmail — idempotência", () => {
  it("rodar 2x não gera novo merge nem duplica/perde dado", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "beehiiv", "bh-1", "leitor@example.com", NOW);
    ensureSubscriber(db, "kit", null, "leitor@example.com", NOW);

    const first = resolveIdentitiesByEmail(db, NOW);
    const afterFirst = getStoreCounts(db);

    const second = resolveIdentitiesByEmail(db, NOW);
    const afterSecond = getStoreCounts(db);

    assert.equal(first.subscribers_merged, 1);
    assert.equal(second.subscribers_merged, 0);
    assert.deepEqual(afterSecond, afterFirst);
    db.close();
  });

  it("seguro rodar depois de uma NOVA ingestão que adiciona 1 alias a mais no mesmo e-mail", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "beehiiv", "bh-1", "leitor@example.com", NOW);
    ensureSubscriber(db, "kit", null, "leitor@example.com", NOW);
    resolveIdentitiesByEmail(db, NOW); // 1ª rodada: beehiiv + kit fundem

    // Ingestão da Brevo chega depois, cria um 3º subscriber pro mesmo e-mail
    // (ensureSubscriber não sabe de cross-plataforma).
    ensureSubscriber(db, "brevo_diaria", "brevo-1", "leitor@example.com", NOW);
    assert.equal(getStoreCounts(db).subscribers, 2);

    const second = resolveIdentitiesByEmail(db, NOW);

    assert.equal(second.subscribers_merged, 1);
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });
});

describe("resolveIdentitiesByEmail — conflito de subscription na mesma plataforma", () => {
  it("mantém a subscription com updated_at mais recente e descarta a outra, sem violar UNIQUE(subscriber_id, platform)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const s1 = ensureSubscriber(db, "kit", null, "a.b@gmail.com", NOW);
    const s2 = ensureSubscriber(db, "kit", null, "ab@gmail.com", NOW);

    upsertSubscription(
      db,
      s1,
      "kit",
      { status: "active", enteredAt: "2026-01-01", exitedAt: null, source: "antiga" },
      "2026-01-01T00:00:00.000Z",
    );
    upsertSubscription(
      db,
      s2,
      "kit",
      { status: "active", enteredAt: "2026-08-01", exitedAt: null, source: "recente" },
      "2026-08-01T00:00:00.000Z",
    );

    const summary = resolveIdentitiesByEmail(db, NOW);
    assert.equal(summary.subscribers_merged, 1);
    assert.equal(summary.merges[0].subscriptions_dropped, 1);

    const counts = getStoreCounts(db);
    assert.equal(counts.subscriptions, 1); // não duplicou nem sumiu com as duas

    const canonicalId = summary.merges[0].canonical_subscriber_id;
    const row = db
      .prepare("SELECT source FROM subscription WHERE subscriber_id = ? AND platform = 'kit'")
      .get(canonicalId) as { source: string };
    assert.equal(row.source, "recente"); // a mais recente por updated_at sobreviveu
    db.close();
  });
});

describe("resolveIdentitiesByEmail — regressão onda 1 (#6504): 81 casam 81/81", () => {
  it("81 assinantes migrados por e-mail exato (Beehiiv desativado + Kit taggeado) casam 81/81", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const N = 81;
    for (let i = 0; i < N; i++) {
      const email = `assinante${i}@example.com`;
      ensureSubscriber(db, "beehiiv", `bh-${i}`, email, NOW);
      ensureSubscriber(db, "kit", null, email, NOW);
    }
    assert.equal(getStoreCounts(db).subscribers, N * 2);

    const summary = resolveIdentitiesByEmail(db, NOW);

    assert.equal(summary.email_groups_merged, N);
    assert.equal(summary.subscribers_merged, N);
    assert.equal(getStoreCounts(db).subscribers, N);

    // Confirma, um por um, que os 81 casaram de fato — não só a contagem
    // agregada bater por coincidência.
    let matched = 0;
    for (let i = 0; i < N; i++) {
      const ids = findSubscriberIdsByEmail(db, `assinante${i}@example.com`);
      if (ids.length === 1) matched++;
    }
    assert.equal(matched, N);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// buildUnmatchedReport — o entregável real da fatia 5
// ---------------------------------------------------------------------------

describe("buildUnmatchedReport — contagem de não-casados por plataforma", () => {
  it("conta subscribers casados (2+ plataformas) vs. não-casados (1 plataforma só)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    // Casado: mesmo e-mail em beehiiv + kit.
    ensureSubscriber(db, "beehiiv", "bh-1", "casado@example.com", NOW);
    ensureSubscriber(db, "kit", null, "casado@example.com", NOW);
    resolveIdentitiesByEmail(db, NOW);

    // Não-casados: 1 só em cada plataforma.
    ensureSubscriber(db, "beehiiv", "bh-2", "so-beehiiv@example.com", NOW);
    ensureSubscriber(db, "kit", null, "so-kit@example.com", NOW);
    ensureSubscriber(db, "brevo_diaria", "brevo-2", "so-brevo@example.com", NOW);

    const report = buildUnmatchedReport(db, NOW);

    assert.equal(report.total_subscribers, 4); // 1 casado + 3 não-casados
    assert.equal(report.matched_subscribers, 1);
    assert.equal(report.unmatched_subscribers, 3);

    const byPlatform = Object.fromEntries(report.by_platform.map((p) => [p.platform, p]));
    assert.equal(byPlatform.beehiiv.unmatched_subscribers, 1);
    assert.equal(byPlatform.kit.unmatched_subscribers, 1);
    assert.equal(byPlatform.brevo_diaria.unmatched_subscribers, 1);
    assert.equal(byPlatform.brevo_clarice.unmatched_subscribers, 0);
    // beehiiv total inclui o casado (que tem alias em beehiiv) + o não-casado.
    assert.equal(byPlatform.beehiiv.total_subscribers, 2);
    db.close();
  });

  it("relatório inclui as 4 plataformas mesmo quando alguma tem zero subscribers", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "kit", null, "unico@example.com", NOW);

    const report = buildUnmatchedReport(db, NOW);
    const platforms = report.by_platform.map((p) => p.platform).sort();
    assert.deepEqual(platforms, ["beehiiv", "brevo_clarice", "brevo_diaria", "kit"].sort());
    db.close();
  });

  it("carrega a nota de PISO — toda métrica cross-plataforma é piso, nunca exata", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const report = buildUnmatchedReport(db, NOW);
    assert.equal(report.note, CROSS_PLATFORM_FLOOR_NOTE);
    assert.match(report.note, /PISO/);
    db.close();
  });
});

describe("buildUnmatchedReport — sinal fraco (informativo, NUNCA funde)", () => {
  it("aponta mesmo local-part em plataformas diferentes como sinal fraco, sem fundir os subscribers", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "beehiiv", "bh-1", "pixel@gmail.com", NOW);
    ensureSubscriber(db, "kit", null, "pixel@empresa.com.br", NOW);
    resolveIdentitiesByEmail(db, NOW); // não deve fundir — domínios diferentes

    const report = buildUnmatchedReport(db, NOW);

    assert.equal(report.matched_subscribers, 0);
    assert.equal(report.unmatched_subscribers, 2); // continuam SEPARADOS
    assert.equal(report.weak_signals.length, 1);
    assert.equal(report.weak_signals[0].local_part, "pixel");
    assert.deepEqual(report.weak_signals[0].platforms.sort(), ["beehiiv", "kit"]);
    assert.equal(report.weak_signals[0].subscriber_ids.length, 2);
    db.close();
  });

  it("NÃO reporta sinal fraco quando o mesmo local-part está só numa plataforma", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "beehiiv", "bh-1", "pixel@gmail.com", NOW);
    ensureSubscriber(db, "beehiiv", "bh-2", "pixel@empresa.com.br", NOW);

    const report = buildUnmatchedReport(db, NOW);

    assert.equal(report.weak_signals.length, 0);
    db.close();
  });
});
