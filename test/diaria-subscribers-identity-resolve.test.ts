import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
  planIdentityMerges,
  checkMergeConservation,
  backupStoreFile,
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

describe("resolveIdentitiesByEmail — defensivo contra e-mail vazio (nunca ocorre via ensureSubscriber, mas guarda o invariante)", () => {
  it("NÃO funde 2 subscribers cujo alias tem email = '' (bypass direto de SQL, fora do caminho público)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    // ensureSubscriber normaliza email:"" para NULL antes de gravar (ternária
    // `email ? ... : null`) — este teste simula um INSERT direto que
    // contornasse esse caminho, pra travar que resolveIdentitiesByEmail
    // nunca trata "" como um e-mail canonicalizável de verdade.
    db.exec("BEGIN");
    db.prepare("INSERT INTO subscriber (created_at, updated_at) VALUES (?, ?)").run(NOW, NOW);
    const s1 = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'beehiiv', 'ext-1', '', ?)",
    ).run(s1, NOW);
    db.prepare("INSERT INTO subscriber (created_at, updated_at) VALUES (?, ?)").run(NOW, NOW);
    const s2 = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'kit', 'ext-2', '', ?)",
    ).run(s2, NOW);
    db.exec("COMMIT");

    const summary = resolveIdentitiesByEmail(db, NOW);

    assert.equal(summary.subscribers_merged, 0);
    assert.equal(getStoreCounts(db).subscribers, 2);
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
    // beehiiv total inclui o casado (que tem alias em beehiiv) + o não-casado.
    assert.equal(byPlatform.beehiiv.total_subscribers, 2);
    db.close();
  });

  it("relatório inclui as 3 plataformas mesmo quando alguma tem zero subscribers", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "kit", null, "unico@example.com", NOW);

    const report = buildUnmatchedReport(db, NOW);
    const platforms = report.by_platform.map((p) => p.platform).sort();
    assert.deepEqual(platforms, ["beehiiv", "brevo_diaria", "kit"].sort());
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

// ---------------------------------------------------------------------------
// planIdentityMerges — dry-run: mesma REGRA de casamento, NUNCA escreve (#7205)
// ---------------------------------------------------------------------------

describe("planIdentityMerges — plano read-only, mesma regra de resolveIdentitiesByEmail", () => {
  it("relata o mesmo grupo que resolveIdentitiesByEmail fundiria, sem tocar o store", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const beehiivId = ensureSubscriber(db, "beehiiv", "bh-1", "leitor@example.com", NOW);
    const kitId = ensureSubscriber(db, "kit", null, "leitor@example.com", NOW);

    const plan = planIdentityMerges(db, NOW);

    assert.equal(plan.email_groups_would_merge, 1);
    assert.equal(plan.subscribers_would_merge, 1);
    assert.equal(plan.merges.length, 1);
    assert.equal(plan.merges[0].canonical_subscriber_id, Math.min(beehiivId, kitId));
    assert.deepEqual(plan.merges[0].loser_subscriber_ids, [Math.max(beehiivId, kitId)]);
    assert.equal(plan.merges[0].canonical_email, "leitor@example.com");

    // Nada foi escrito — os 2 subscribers continuam separados.
    assert.equal(getStoreCounts(db).subscribers, 2);
    db.close();
  });

  it("chamar 2x seguidas dá o MESMO plano — puro, sem efeito colateral", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "beehiiv", "bh-1", "leitor@example.com", NOW);
    ensureSubscriber(db, "kit", null, "leitor@example.com", NOW);

    const first = planIdentityMerges(db, NOW);
    const second = planIdentityMerges(db, NOW);

    assert.deepEqual(first, second);
    assert.equal(getStoreCounts(db).subscribers, 2); // ainda não fundiu
    db.close();
  });

  it("plano vazio quando não há e-mail casando em 2+ plataformas", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "beehiiv", "bh-1", "a@example.com", NOW);
    ensureSubscriber(db, "kit", null, "b@example.com", NOW);

    const plan = planIdentityMerges(db, NOW);

    assert.equal(plan.email_groups_would_merge, 0);
    assert.equal(plan.subscribers_would_merge, 0);
    assert.deepEqual(plan.merges, []);
    db.close();
  });

  it("resolveIdentitiesByEmail depois de planIdentityMerges funde exatamente o que o plano previu", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ensureSubscriber(db, "beehiiv", "bh-1", "jornada@example.com", NOW);
    ensureSubscriber(db, "brevo_diaria", "brevo-1", "jornada@example.com", NOW);
    ensureSubscriber(db, "kit", null, "jornada@example.com", NOW);

    const plan = planIdentityMerges(db, NOW);
    assert.equal(plan.subscribers_would_merge, 2); // 3 -> 1 = 2 merges previstos

    const resolution = resolveIdentitiesByEmail(db, NOW);
    assert.equal(resolution.subscribers_merged, plan.subscribers_would_merge);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// checkMergeConservation — fusão move linhas, nunca perde (#7205)
// ---------------------------------------------------------------------------

describe("checkMergeConservation", () => {
  it("ok=true quando aliases e eventos batem antes/depois", () => {
    const result = checkMergeConservation(
      { identity_aliases: 991, events: 77945 },
      { identity_aliases: 991, events: 77945 },
    );
    assert.equal(result.ok, true);
  });

  it("ok=false quando aliases divergem (perda ou duplicação)", () => {
    const result = checkMergeConservation(
      { identity_aliases: 991, events: 77945 },
      { identity_aliases: 990, events: 77945 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.identity_aliases_before, 991);
    assert.equal(result.identity_aliases_after, 990);
  });

  it("ok=false quando eventos divergem, mesmo com aliases batendo", () => {
    const result = checkMergeConservation(
      { identity_aliases: 991, events: 77945 },
      { identity_aliases: 991, events: 77944 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.events_before, 77945);
    assert.equal(result.events_after, 77944);
  });

  it("um merge real no store passa no guard de conservação (aliases/eventos preservados)", () => {
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

    const before = getStoreCounts(db);
    resolveIdentitiesByEmail(db, NOW);
    const after = getStoreCounts(db);

    const check = checkMergeConservation(
      { identity_aliases: before.identity_aliases, events: before.events },
      { identity_aliases: after.identity_aliases, events: after.events },
    );
    assert.equal(check.ok, true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// backupStoreFile — snapshot em disco antes de qualquer escrita real (#7205)
// ---------------------------------------------------------------------------

describe("backupStoreFile", () => {
  function tmpDataRoot(prefix: string): string {
    return mkdtempSync(resolve(tmpdir(), prefix));
  }

  it("copia o .db real pra {dbPath}.backup-{timestamp}, preservando o original", () => {
    const dataRoot = tmpDataRoot("dsri-backup-");
    const dbPath = resolve(dataRoot, "store.db");
    const db = openDiariaSubscribersDb(dbPath);
    ensureSubscriber(db, "beehiiv", "bh-1", "a@example.com", NOW);
    db.close();

    const backupPath = backupStoreFile(dbPath, "2026-09-03T01:02:03.456Z");

    assert.equal(existsSync(dbPath), true); // original intacto
    assert.equal(existsSync(backupPath), true);
    assert.equal(backupPath, `${dbPath}.backup-2026-09-03T01-02-03-456Z`);

    // O conteúdo copiado é IGUAL ao original no momento do backup.
    const originalBytes = readFileSync(dbPath);
    const backupBytes = readFileSync(backupPath);
    assert.deepEqual(backupBytes, originalBytes);
  });

  it("lança erro claro quando o store não existe — nunca cria um backup vazio", () => {
    const dataRoot = tmpDataRoot("dsri-backup-missing-");
    const dbPath = resolve(dataRoot, "nao-existe.db");
    assert.throws(() => backupStoreFile(dbPath, NOW), /não encontrado/);
  });
});
