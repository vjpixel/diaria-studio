/**
 * diaria-subscribers-edicao-canonica.test.ts (#7204)
 *
 * Cobre `scripts/lib/diaria-subscribers-edicao-canonica.ts`: conversão de
 * timestamp pra `AAMMDD` ajustado pra BRT, derivação do mapa canônico a
 * partir do `event` real do store, e a deduplicação por chave canônica que
 * fecha a dupla contagem cross-plataforma.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tsToBrtAAMMDD,
  nativeEdicaoKey,
  buildCanonicalEdicaoMapFromEvents,
  resolveCanonicalEdicao,
  countDistinctCanonicalEditions,
} from "../scripts/lib/diaria-subscribers-edicao-canonica.ts";
import { openDiariaSubscribersDb, ensureSubscriber, recordEvent } from "../scripts/lib/diaria-subscribers-db.ts";

describe("tsToBrtAAMMDD", () => {
  it("converte um ts UTC do meio do dia pra AAMMDD do mesmo dia BRT", () => {
    assert.equal(tsToBrtAAMMDD("2026-04-27T12:00:00.000Z"), "260427");
  });

  it("madrugada UTC (antes das 03:00) vaza pro dia BRT ANTERIOR — mesmo ajuste de unixSecondsToBrtDate", () => {
    // 2026-04-27T02:00:00Z - 3h = 2026-04-26T23:00:00 BRT
    assert.equal(tsToBrtAAMMDD("2026-04-27T02:00:00.000Z"), "260426");
  });

  it("exatamente às 03:00 UTC já cai no dia BRT seguinte (0h BRT)", () => {
    assert.equal(tsToBrtAAMMDD("2026-04-27T03:00:00.000Z"), "260427");
  });

  it("lança erro claro pra ts inválido, nunca devolve NaN silencioso", () => {
    assert.throws(() => tsToBrtAAMMDD("não-é-uma-data"), /inválido/);
  });
});

describe("nativeEdicaoKey", () => {
  it("compõe plataforma + edição nativa — chaves de plataformas diferentes com o mesmo id nativo NUNCA colidem", () => {
    assert.notEqual(nativeEdicaoKey("beehiiv", "77"), nativeEdicaoKey("kit", "77"));
    assert.equal(nativeEdicaoKey("kit", "77"), "kit::77");
  });
});

describe("buildCanonicalEdicaoMapFromEvents", () => {
  it("mapeia (platform, edicao) -> AAMMDD do MENOR ts entre delivered/sent do grupo", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "a@x.com", "2026-04-27T09:00:00.000Z");
    recordEvent(db, {
      subscriberId: id,
      platform: "kit",
      type: "delivered",
      externalEventId: "d1",
      edicao: "bcast-1",
      ts: "2026-04-27T09:05:00.000Z",
    });
    // Click da MESMA edição, dias depois — não deve mudar a data canônica
    // (que vem do delivered/sent, não do click).
    recordEvent(db, {
      subscriberId: id,
      platform: "kit",
      type: "click",
      externalEventId: "c1",
      edicao: "bcast-1",
      ts: "2026-04-30T18:00:00.000Z",
    });

    const map = buildCanonicalEdicaoMapFromEvents(db);
    assert.equal(map.get(nativeEdicaoKey("kit", "bcast-1")), "260427");
    db.close();
  });

  it("edicao nativa SEM nenhum delivered/sent fica de fora do mapa (não inventa data a partir de click isolado)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "kit", null, "a@x.com", "2026-04-27T09:00:00.000Z");
    recordEvent(db, {
      subscriberId: id,
      platform: "kit",
      type: "click",
      externalEventId: "c1",
      edicao: "orfa-1",
      ts: "2026-04-27T09:00:00.000Z",
    });
    const map = buildCanonicalEdicaoMapFromEvents(db);
    assert.equal(map.has(nativeEdicaoKey("kit", "orfa-1")), false);
    db.close();
  });

  it("2 plataformas disparando a MESMA edição do dia resolvem pro MESMO AAMMDD", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const beehiivId = ensureSubscriber(db, "beehiiv", "bh-1", "a@x.com", "2026-04-27T06:00:00.000Z");
    const kitId = ensureSubscriber(db, "kit", null, "b@x.com", "2026-04-27T06:00:00.000Z");
    recordEvent(db, {
      subscriberId: beehiivId,
      platform: "beehiiv",
      type: "delivered",
      externalEventId: "bh-d1",
      edicao: "post_abc",
      ts: "2026-04-27T06:00:00.000Z",
    });
    recordEvent(db, {
      subscriberId: kitId,
      platform: "kit",
      type: "delivered",
      externalEventId: "kit-d1",
      edicao: "bcast_xyz",
      ts: "2026-04-27T06:10:00.000Z",
    });

    const map = buildCanonicalEdicaoMapFromEvents(db);
    assert.equal(map.get(nativeEdicaoKey("beehiiv", "post_abc")), "260427");
    assert.equal(map.get(nativeEdicaoKey("kit", "bcast_xyz")), "260427");
    db.close();
  });
});

describe("resolveCanonicalEdicao", () => {
  it("resolve pelo par (platform, edicaoNativa) quando o mapa conhece", () => {
    const map = new Map([["kit::77", "260427"]]);
    assert.equal(resolveCanonicalEdicao(map, "kit", "77"), "260427");
  });

  it("null quando edicaoNativa é ausente", () => {
    const map = new Map([["kit::77", "260427"]]);
    assert.equal(resolveCanonicalEdicao(map, "kit", null), null);
    assert.equal(resolveCanonicalEdicao(map, "kit", undefined), null);
  });

  it("null quando o mapa não conhece o par (nunca inventa)", () => {
    const map = new Map<string, string>();
    assert.equal(resolveCanonicalEdicao(map, "kit", "77"), null);
  });
});

describe("countDistinctCanonicalEditions — o caso central do #7204", () => {
  it("a MESMA pessoa recebendo a MESMA edição do dia por 2 plataformas conta 1, não 2", () => {
    const canonicalMap = new Map([
      ["beehiiv::post_abc", "260427"],
      ["kit::bcast_xyz", "260427"],
    ]);
    const entries = [
      { platform: "beehiiv" as const, edicao: "post_abc", externalEventId: "bh-1" },
      { platform: "kit" as const, edicao: "bcast_xyz", externalEventId: "kit-1" },
    ];
    // Hoje (sem canônica), 2 chaves nativas distintas contariam 2 — aqui,
    // com o mapa canônico dedup, conta 1.
    assert.equal(countDistinctCanonicalEditions(entries, canonicalMap), 1);
  });

  it("2 edições GENUINAMENTE diferentes (dias diferentes) continuam contando 2", () => {
    const canonicalMap = new Map([
      ["beehiiv::post_abc", "260427"],
      ["beehiiv::post_def", "260428"],
    ]);
    const entries = [
      { platform: "beehiiv" as const, edicao: "post_abc", externalEventId: "bh-1" },
      { platform: "beehiiv" as const, edicao: "post_def", externalEventId: "bh-2" },
    ];
    assert.equal(countDistinctCanonicalEditions(entries, canonicalMap), 2);
  });

  it("par sem mapeamento cai no fallback platform::native — nunca funde com outro par por acidente", () => {
    const canonicalMap = new Map<string, string>(); // vazio — nada resolvido
    const entries = [
      { platform: "beehiiv" as const, edicao: "post_abc", externalEventId: "bh-1" },
      { platform: "kit" as const, edicao: "bcast_xyz", externalEventId: "kit-1" },
    ];
    // Sem canônica resolvida, cada par nativo continua distinto — 2, não 1.
    assert.equal(countDistinctCanonicalEditions(entries, canonicalMap), 2);
  });

  it("evento legado sem edicao (null) cai no fallback por external_event_id", () => {
    const canonicalMap = new Map<string, string>();
    const entries = [
      { platform: "kit" as const, edicao: null, externalEventId: "legacy-1" },
      { platform: "kit" as const, edicao: null, externalEventId: "legacy-2" },
    ];
    assert.equal(countDistinctCanonicalEditions(entries, canonicalMap), 2);
  });
});
