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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  tsToBrtAAMMDD,
  nativeEdicaoKey,
  buildCanonicalEdicaoMapFromEvents,
  resolveCanonicalEdicao,
  countDistinctCanonicalEditions,
  backfillCanonicalEdicaoColumn,
  runCanonicalEdicaoBackfillFailSoft,
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

  it("1 grupo com ts malformado é PULADO (logado), sem abortar os demais grupos (#7458 review, silent-failure-hunter)", () => {
    // `event.ts` não tem validação de formato em `recordEvent` — sem o
    // try/catch por-linha, esse único grupo ruim derrubava a função
    // inteira, e `runCanonicalEdicaoBackfillFailSoft` engolia isso como
    // "erro genérico", desabilitando o backfill de TODOS os grupos.
    const db = openDiariaSubscribersDb(":memory:");
    const good = ensureSubscriber(db, "kit", null, "a@x.com", "2026-04-27T06:00:00.000Z");
    const bad = ensureSubscriber(db, "beehiiv", "bh-9", "b@x.com", "2026-04-27T06:00:00.000Z");
    recordEvent(db, { subscriberId: good, platform: "kit", type: "delivered", externalEventId: "k1", edicao: "bcast_1", ts: "2026-04-27T06:00:00.000Z" });
    recordEvent(db, { subscriberId: bad, platform: "beehiiv", type: "delivered", externalEventId: "bh1", edicao: "post_bad", ts: "não-é-um-timestamp" });

    const orig = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]) => messages.push(args.join(" "));
    let map: Map<string, string>;
    try {
      map = buildCanonicalEdicaoMapFromEvents(db);
    } finally {
      console.error = orig;
    }
    assert.equal(map.get(nativeEdicaoKey("kit", "bcast_1")), "260427", "grupo válido resolve normalmente");
    assert.equal(map.has(nativeEdicaoKey("beehiiv", "post_bad")), false, "grupo com ts inválido nunca entra no mapa");
    assert.ok(messages.some((m) => m.includes("post_bad")), "o grupo pulado é logado, não silenciado");
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

describe("backfillCanonicalEdicaoColumn (#7204, follow-up pós-#7249)", () => {
  it("grava edicao_canonica pra TODO evento do grupo (delivered E click), não só delivered/sent", () => {
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
    recordEvent(db, {
      subscriberId: id,
      platform: "kit",
      type: "click",
      externalEventId: "c1",
      edicao: "bcast-1",
      ts: "2026-04-30T18:00:00.000Z", // click dias depois — mesmo grupo
    });

    const result = backfillCanonicalEdicaoColumn(db);
    assert.equal(result.groupsResolved, 1);
    assert.equal(result.rowsUpdated, 2, "as 2 linhas (delivered + click) do grupo, não só delivered/sent");

    const rows = db.prepare("SELECT type, edicao_canonica FROM event ORDER BY type").all() as Array<{
      type: string;
      edicao_canonica: string | null;
    }>;
    assert.deepEqual(
      rows.map((r) => r.edicao_canonica),
      ["260427", "260427"],
    );
    db.close();
  });

  it("edicao nativa sem delivered/sent fica NULL — nunca inventa canônica a partir de click isolado", () => {
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
    const result = backfillCanonicalEdicaoColumn(db);
    assert.equal(result.groupsResolved, 0);
    assert.equal(result.rowsUpdated, 0);
    const row = db.prepare("SELECT edicao_canonica FROM event WHERE external_event_id = 'c1'").get() as {
      edicao_canonica: string | null;
    };
    assert.equal(row.edicao_canonica, null);
    db.close();
  });

  it("idempotente — 2ª execução sem evento novo atualiza 0 linhas", () => {
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
    const first = backfillCanonicalEdicaoColumn(db);
    assert.equal(first.rowsUpdated, 1);
    const second = backfillCanonicalEdicaoColumn(db);
    assert.equal(second.rowsUpdated, 0, "sem evento novo, nada diverge — 0 linhas regravadas");
    db.close();
  });

  it("2 plataformas disparando a MESMA edição do dia gravam o MESMO edicao_canonica — o caso central da issue", () => {
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
    backfillCanonicalEdicaoColumn(db);
    const rows = db
      .prepare("SELECT platform, edicao_canonica FROM event ORDER BY platform")
      .all() as Array<{ platform: string; edicao_canonica: string | null }>;
    assert.deepEqual(
      rows.map((r) => ({ platform: r.platform, edicao_canonica: r.edicao_canonica })),
      [
        { platform: "beehiiv", edicao_canonica: "260427" },
        { platform: "kit", edicao_canonica: "260427" },
      ],
    );
    // Prova a promessa central: SQL puro já responde a pergunta cross-plataforma.
    const distinct = db
      .prepare("SELECT COUNT(DISTINCT edicao_canonica) AS n FROM event WHERE edicao_canonica IS NOT NULL")
      .get() as { n: number };
    assert.equal(distinct.n, 1);
    db.close();
  });
});

describe("runCanonicalEdicaoBackfillFailSoft", () => {
  it("roda o backfill contra um .db real em disco e retorna o resultado", () => {
    const dataRoot = mkdtempSync(resolve(tmpdir(), "edicao-canonica-failsoft-"));
    const dbPath = resolve(dataRoot, "diaria-subscribers.db");
    const seed = openDiariaSubscribersDb(dbPath);
    const id = ensureSubscriber(seed, "kit", null, "a@x.com", "2026-04-27T09:00:00.000Z");
    recordEvent(seed, {
      subscriberId: id,
      platform: "kit",
      type: "delivered",
      externalEventId: "d1",
      edicao: "bcast-1",
      ts: "2026-04-27T09:05:00.000Z",
    });
    seed.close();

    const result = runCanonicalEdicaoBackfillFailSoft(dbPath);
    assert.ok(result);
    assert.equal(result!.rowsUpdated, 1);
  });

  it("nunca lança — .db inexistente devolve null", () => {
    const bogusPath = resolve(tmpdir(), `edicao-canonica-failsoft-bogus-${Date.now()}`, "nao-existe.db");
    assert.doesNotThrow(() => {
      const result = runCanonicalEdicaoBackfillFailSoft(bogusPath);
      assert.equal(result, null);
    });
  });

  it("null por erro AVISA no stderr — antes era silencioso (#7458 review, silent-failure-hunter)", () => {
    const bogusPath = resolve(tmpdir(), `edicao-canonica-failsoft-bogus-${Date.now()}`, "nao-existe.db");
    const orig = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]) => messages.push(args.join(" "));
    let result: ReturnType<typeof runCanonicalEdicaoBackfillFailSoft>;
    try {
      result = runCanonicalEdicaoBackfillFailSoft(bogusPath);
    } finally {
      console.error = orig;
    }
    assert.equal(result, null);
    assert.ok(messages.some((m) => m.includes("canonical-edicao-backfill")), "falha vira aviso visível, não silêncio total");
  });
});
