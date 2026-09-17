/**
 * test/acquisition-health-store.test.ts (#8243 item 2)
 *
 * Lógica pura de `scripts/lib/acquisition-health-store.ts` — critério de
 * exclusão da migração em bloco (`isMigratedFromBeehiiv`), leitura do store
 * (`buildKitChannelSubscribersFromStore`) e frescor (`isStoreStale`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openDiariaSubscribersDb, ensureSubscriber, upsertSubscription } from "../scripts/lib/diaria-subscribers-db.ts";
import {
  isMigratedFromBeehiiv,
  buildKitChannelSubscribersFromStore,
  isStoreStale,
  KIT_BULK_MIGRATION_CUTOFF_ISO,
  STORE_STALENESS_MAX_DAYS,
} from "../scripts/lib/acquisition-health-store.ts";

// ---------------------------------------------------------------------------
// isMigratedFromBeehiiv
// ---------------------------------------------------------------------------

describe("isMigratedFromBeehiiv (#8243)", () => {
  it("marcador beehiiv-sync: sempre migrada, independente da data", () => {
    assert.equal(
      isMigratedFromBeehiiv({ origem_cadastro: "beehiiv-sync", entered_at: "2026-09-10T00:00:00.000Z" }),
      true,
    );
  });

  it("marcador kit-nativo: sempre nativa, mesmo com entered_at antes do cutoff", () => {
    assert.equal(
      isMigratedFromBeehiiv({ origem_cadastro: "kit-nativo", entered_at: "2026-01-01T00:00:00.000Z" }),
      false,
    );
  });

  it("marcador brevo-diaria-score: sempre nativa", () => {
    assert.equal(
      isMigratedFromBeehiiv({ origem_cadastro: "brevo-diaria-score", entered_at: "2026-01-01T00:00:00.000Z" }),
      false,
    );
  });

  it("sem marcador, entered_at ANTES do cutoff (#7386): fallback = migrada", () => {
    assert.equal(isMigratedFromBeehiiv({ origem_cadastro: null, entered_at: "2026-09-01T00:00:00.000Z" }), true);
  });

  it("sem marcador, entered_at DEPOIS do cutoff: fallback = nativa", () => {
    assert.equal(isMigratedFromBeehiiv({ origem_cadastro: null, entered_at: "2026-09-10T00:00:00.000Z" }), false);
  });

  it("sem marcador, sem entered_at: precaução — trata como migrada (exclui)", () => {
    assert.equal(isMigratedFromBeehiiv({ origem_cadastro: null, entered_at: null }), true);
  });

  it("sem marcador, entered_at inválido: precaução — trata como migrada", () => {
    assert.equal(isMigratedFromBeehiiv({ origem_cadastro: null, entered_at: "não-é-data" }), true);
  });

  it("cutoff é exatamente 2026-09-04 (#7386/#7395)", () => {
    assert.equal(KIT_BULK_MIGRATION_CUTOFF_ISO, "2026-09-04T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// buildKitChannelSubscribersFromStore
// ---------------------------------------------------------------------------

function seedKitSubscriber(
  db: ReturnType<typeof openDiariaSubscribersDb>,
  opts: {
    email: string;
    status: string;
    enteredAt: string;
    utmSource: string;
    origemCadastro?: string | null;
  },
): void {
  const subscriberId = ensureSubscriber(db, "kit", opts.email, opts.email);
  upsertSubscription(db, subscriberId, "kit", {
    status: opts.status,
    enteredAt: opts.enteredAt,
    exitedAt: null,
    source: opts.utmSource,
    utmSource: opts.utmSource,
    origemCadastro: opts.origemCadastro ?? null,
  });
}

describe("buildKitChannelSubscribersFromStore (#8243)", () => {
  it("exclui a migração em bloco da Beehiiv do denominador — meta-ads e google-ads voltam a ser monitorados", () => {
    const db = openDiariaSubscribersDb(":memory:");
    try {
      // Migração em bloco (#7386): marcador beehiiv-sync, todos ativos —
      // é o exato viés de sobrevivente citado no corpo da #8243
      // (`www.alquimiaoperativa.news`, 257 na Beehiiv, 20/20 ativos no Kit).
      for (let i = 0; i < 20; i++) {
        seedKitSubscriber(db, {
          email: `migrado${i}@x.com`,
          status: "active",
          enteredAt: "2026-08-01T00:00:00.000Z",
          utmSource: "www.alquimiaoperativa.news",
          origemCadastro: "beehiiv-sync",
        });
      }

      // Canais pagos NATIVOS do Kit — nunca apareciam no snapshot Beehiiv
      // (corpo da #8243: "meta-ads, google-ads e diaria-apex nunca aparecem
      // no snapshot da Beehiiv"). Entrada depois do cutoff, sem marcador.
      for (let i = 0; i < 10; i++) {
        seedKitSubscriber(db, {
          email: `meta${i}@x.com`,
          status: i < 8 ? "active" : "cancelled",
          enteredAt: "2026-09-10T00:00:00.000Z",
          utmSource: "meta-ads",
        });
      }
      for (let i = 0; i < 6; i++) {
        seedKitSubscriber(db, {
          email: `google${i}@x.com`,
          status: "active",
          enteredAt: "2026-09-12T00:00:00.000Z",
          utmSource: "google-ads",
        });
      }

      const result = buildKitChannelSubscribersFromStore(db, ["kit"]);

      assert.equal(result.excludedMigrated, 20, "as 20 linhas beehiiv-sync devem ser excluídas");
      assert.equal(result.totalSubscriptions, 36);
      assert.equal(result.subscribers.length, 16, "só os 16 nativos (meta-ads + google-ads) sobram");

      const channels = new Set(result.subscribers.map((s) => s.utm_source));
      assert.ok(channels.has("meta-ads"), "meta-ads precisa estar entre os canais avaliados");
      assert.ok(channels.has("google-ads"), "google-ads precisa estar entre os canais avaliados");
      assert.ok(!channels.has("www.alquimiaoperativa.news"), "canal só-migrado não deve sobrar");

      // #8236 — CTR sempre suprimido (stats zerado), nunca fabricado.
      for (const s of result.subscribers) {
        assert.equal(s.stats?.total_received, 0);
        assert.equal(s.stats?.total_unique_clicked, 0);
      }
    } finally {
      db.close();
    }
  });

  it("linha sem email não entra no resultado (mesmo critério de leitor-store.ts)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    try {
      const subscriberId = ensureSubscriber(db, "kit", "ext-only-id", null);
      upsertSubscription(db, subscriberId, "kit", {
        status: "active",
        enteredAt: "2026-09-10T00:00:00.000Z",
        exitedAt: null,
        source: "meta-ads",
        utmSource: "meta-ads",
      });
      const result = buildKitChannelSubscribersFromStore(db, ["kit"]);
      assert.equal(result.subscribers.length, 0);
    } finally {
      db.close();
    }
  });

  it("asOf reflete o updated_at mais recente das subscription cobertas", () => {
    const db = openDiariaSubscribersDb(":memory:");
    try {
      seedKitSubscriber(db, {
        email: "a@x.com",
        status: "active",
        enteredAt: "2026-09-10T00:00:00.000Z",
        utmSource: "direct",
      });
      const result = buildKitChannelSubscribersFromStore(db, ["kit"]);
      assert.ok(result.asOf != null);
    } finally {
      db.close();
    }
  });

  it("store sem nenhuma subscription: asOf null, subscribers vazio (nunca lança)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    try {
      const result = buildKitChannelSubscribersFromStore(db, ["kit"]);
      assert.equal(result.asOf, null);
      assert.deepEqual(result.subscribers, []);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// isStoreStale
// ---------------------------------------------------------------------------

describe("isStoreStale (#8243, mesma regra do #5281)", () => {
  const now = Date.parse("2026-09-17T12:00:00.000Z");

  it("asOf null: sempre stale (sem captura nenhuma)", () => {
    assert.equal(isStoreStale(null, now), true);
  });

  it("asOf dentro do limite (1 dia): não stale", () => {
    assert.equal(isStoreStale("2026-09-16T12:00:00.000Z", now), false);
  });

  it("asOf além do limite (8 dias, > STORE_STALENESS_MAX_DAYS=7): stale", () => {
    assert.equal(isStoreStale("2026-09-09T00:00:00.000Z", now), true);
    assert.equal(STORE_STALENESS_MAX_DAYS, 7);
  });

  it("asOf inválido: trata como stale (precaução)", () => {
    assert.equal(isStoreStale("não-é-data", now), true);
  });
});
