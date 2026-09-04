/**
 * beehiiv-exit-history.test.ts (#7248)
 *
 * Cobre o miolo puro da drenagem de `exited_at` REAL — parse/filtro de
 * registros crus de `list_subscriptions` e o checkpoint de paginação.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseExitHistoryRecord,
  parseExitHistoryPage,
  exitHistoryRecordKey,
  mergeExitHistoryRecords,
  buildInitialExitHistoryManifest,
  applyExitHistoryPageToManifest,
  nextExitHistoryPage,
  type BeehiivExitHistoryRawRecord,
  type BeehiivExitHistoryRecord,
} from "../scripts/lib/beehiiv-exit-history.ts";

describe("parseExitHistoryRecord", () => {
  it("status inactive + unsubscribed_on presente → registro usável", () => {
    const raw: BeehiivExitHistoryRawRecord = {
      id: "sub_1",
      email: "leitor@example.com",
      status: "inactive",
      unsubscribed_on: "2026-09-04T01:19:07Z",
    };
    assert.deepEqual(parseExitHistoryRecord(raw), {
      externalId: "sub_1",
      email: "leitor@example.com",
      unsubscribedOn: "2026-09-04T01:19:07Z",
    });
  });

  it("status active → null (nunca tem unsubscribed_on de verdade)", () => {
    assert.equal(
      parseExitHistoryRecord({ id: "sub_1", email: "a@b.com", status: "active", unsubscribed_on: null }),
      null,
    );
  });

  it("status pending → null", () => {
    assert.equal(parseExitHistoryRecord({ id: "sub_1", status: "pending" }), null);
  });

  it("status inactive SEM unsubscribed_on (campo ausente/null) → null, nunca inventa timestamp", () => {
    assert.equal(parseExitHistoryRecord({ id: "sub_1", email: "a@b.com", status: "inactive" }), null);
    assert.equal(
      parseExitHistoryRecord({ id: "sub_1", email: "a@b.com", status: "inactive", unsubscribed_on: null }),
      null,
    );
  });

  it("unsubscribed_on vazio/espaços → null", () => {
    assert.equal(
      parseExitHistoryRecord({ id: "sub_1", status: "inactive", unsubscribed_on: "   " }),
      null,
    );
  });

  it("sem id NEM email → null (sem identidade utilizável)", () => {
    assert.equal(parseExitHistoryRecord({ status: "inactive", unsubscribed_on: "2026-09-04T01:19:07Z" }), null);
  });

  it("linha null/undefined/não-objeto → null, nunca lança (#7426 review finding 1, reproduzido ao vivo antes do fix)", () => {
    // @ts-expect-error — testando robustez contra shape inválido vindo de uma resposta MCP malformada/truncada.
    assert.equal(parseExitHistoryRecord(null), null);
    // @ts-expect-error
    assert.equal(parseExitHistoryRecord(undefined), null);
    // @ts-expect-error
    assert.equal(parseExitHistoryRecord("garbage"), null);
    // @ts-expect-error
    assert.equal(parseExitHistoryRecord(42), null);
  });

  it("só id (sem email) → usável", () => {
    const parsed = parseExitHistoryRecord({ id: "sub_1", status: "inactive", unsubscribed_on: "2026-09-04T01:19:07Z" });
    assert.deepEqual(parsed, { externalId: "sub_1", email: null, unsubscribedOn: "2026-09-04T01:19:07Z" });
  });

  it("só email (sem id) → usável", () => {
    const parsed = parseExitHistoryRecord({
      email: "leitor@example.com",
      status: "inactive",
      unsubscribed_on: "2026-09-04T01:19:07Z",
    });
    assert.deepEqual(parsed, { externalId: null, email: "leitor@example.com", unsubscribedOn: "2026-09-04T01:19:07Z" });
  });

  it("email normalizado (trim + lowercase)", () => {
    const parsed = parseExitHistoryRecord({
      id: "sub_1",
      email: "  Leitor@Example.com  ",
      status: "inactive",
      unsubscribed_on: "2026-09-04T01:19:07Z",
    });
    assert.equal(parsed?.email, "leitor@example.com");
  });
});

describe("parseExitHistoryPage", () => {
  it("filtra uma página mista — só os inactive-com-unsubscribed_on sobrevivem", () => {
    const page: BeehiivExitHistoryRawRecord[] = [
      { id: "sub_1", status: "inactive", unsubscribed_on: "2026-09-04T01:19:07Z" },
      { id: "sub_2", status: "pending", unsubscribed_on: null },
      { id: "sub_3", status: "active", unsubscribed_on: null },
      { id: "sub_4", status: "inactive", unsubscribed_on: "2026-09-03T07:03:07Z" },
    ];
    const parsed = parseExitHistoryPage(page);
    assert.equal(parsed.length, 2);
    assert.deepEqual(
      parsed.map((r) => r.externalId),
      ["sub_1", "sub_4"],
    );
  });

  it("página vazia → []", () => {
    assert.deepEqual(parseExitHistoryPage([]), []);
  });

  it("página com uma linha null/malformada no meio não derruba a página inteira (#7426 review finding 1)", () => {
    const page = [
      { id: "sub_1", status: "inactive", unsubscribed_on: "2026-09-04T01:19:07Z" },
      null,
      { id: "sub_2", status: "inactive", unsubscribed_on: "2026-09-03T07:03:07Z" },
      // @ts-expect-error
    ] as BeehiivExitHistoryRawRecord[];
    const parsed = parseExitHistoryPage(page);
    assert.equal(parsed.length, 2, "a linha null é descartada, as 2 linhas válidas sobrevivem");
  });
});

describe("exitHistoryRecordKey / mergeExitHistoryRecords", () => {
  it("chave prefere externalId sobre email", () => {
    const r: BeehiivExitHistoryRecord = { externalId: "sub_1", email: "a@b.com", unsubscribedOn: "2026-09-04T01:19:07Z" };
    assert.equal(exitHistoryRecordKey(r), "sub_1");
  });

  it("chave cai pro email quando externalId ausente", () => {
    const r: BeehiivExitHistoryRecord = { externalId: null, email: "a@b.com", unsubscribedOn: "2026-09-04T01:19:07Z" };
    assert.equal(exitHistoryRecordKey(r), "a@b.com");
  });

  it("mescla 2 páginas disjuntas sem perder nenhuma", () => {
    const p1: BeehiivExitHistoryRecord[] = [{ externalId: "sub_1", email: null, unsubscribedOn: "2026-09-01T00:00:00Z" }];
    const p2: BeehiivExitHistoryRecord[] = [{ externalId: "sub_2", email: null, unsubscribedOn: "2026-09-02T00:00:00Z" }];
    const merged = mergeExitHistoryRecords(p1, p2);
    assert.equal(merged.length, 2);
  });

  it("re-aplicar a MESMA página (re-fetch) não duplica — incoming vence", () => {
    const existing: BeehiivExitHistoryRecord[] = [{ externalId: "sub_1", email: null, unsubscribedOn: "2026-09-01T00:00:00Z" }];
    const incoming: BeehiivExitHistoryRecord[] = [{ externalId: "sub_1", email: null, unsubscribedOn: "2026-09-01T00:00:00Z" }];
    const merged = mergeExitHistoryRecords(existing, incoming);
    assert.equal(merged.length, 1);
  });
});

describe("checkpoint de paginação (manifest)", () => {
  it("manifest inicial começa em pages_fetched=0, complete=false", () => {
    const m = buildInitialExitHistoryManifest("2026-09-04T00:00:00Z");
    assert.equal(m.pages_fetched, 0);
    assert.equal(m.complete, false);
    assert.equal(m.total_pages, null);
  });

  it("nextExitHistoryPage de um manifest novo é 1", () => {
    const m = buildInitialExitHistoryManifest("2026-09-04T00:00:00Z");
    assert.equal(nextExitHistoryPage(m), 1);
  });

  it("aplicar a página 1 de 9 avança o checkpoint sem completar", () => {
    let m = buildInitialExitHistoryManifest("2026-09-04T00:00:00Z");
    m = applyExitHistoryPageToManifest(m, { page: 1, per_page: 100, total: 847, total_pages: 9 }, "2026-09-04T00:01:00Z");
    assert.equal(m.pages_fetched, 1);
    assert.equal(m.total_pages, 9);
    assert.equal(m.total, 847);
    assert.equal(m.complete, false);
    assert.equal(nextExitHistoryPage(m), 2);
  });

  it("aplicar a última página (pages_fetched === total_pages) fecha complete: true", () => {
    let m = buildInitialExitHistoryManifest("2026-09-04T00:00:00Z");
    for (let page = 1; page <= 9; page++) {
      m = applyExitHistoryPageToManifest(m, { page, per_page: 100, total: 847, total_pages: 9 }, "2026-09-04T00:01:00Z");
    }
    assert.equal(m.pages_fetched, 9);
    assert.equal(m.complete, true);
  });

  it("aplicar páginas fora de ordem soma páginas DISTINTAS aplicadas (não regride, mas também não infla)", () => {
    let m = buildInitialExitHistoryManifest("2026-09-04T00:00:00Z");
    m = applyExitHistoryPageToManifest(m, { page: 5, total_pages: 9 }, "t1");
    m = applyExitHistoryPageToManifest(m, { page: 2, total_pages: 9 }, "t2");
    assert.equal(m.pages_fetched, 2, "2 páginas distintas aplicadas (5 e 2), não a maior página vista");
    assert.deepEqual(m.applied_pages, [2, 5]);
  });

  it("reaplicar a MESMA página não a conta 2x em applied_pages/pages_fetched", () => {
    let m = buildInitialExitHistoryManifest("2026-09-04T00:00:00Z");
    m = applyExitHistoryPageToManifest(m, { page: 3, total_pages: 9 }, "t1");
    m = applyExitHistoryPageToManifest(m, { page: 3, total_pages: 9 }, "t2");
    assert.equal(m.pages_fetched, 1);
    assert.deepEqual(m.applied_pages, [3]);
  });

  it("#7426 review finding 2 (bug reproduzido, agora corrigido): aplicar SÓ a última página de um total NUNCA fecha complete — as páginas anteriores continuam faltando", () => {
    let m = buildInitialExitHistoryManifest("2026-09-04T00:00:00Z");
    // Só a página 5 de um total de 5 foi aplicada — 1,2,3,4 nunca vieram.
    m = applyExitHistoryPageToManifest(m, { page: 5, total_pages: 5 }, "t1");
    assert.equal(m.pages_fetched, 1, "só 1 página distinta aplicada, mesmo com número de página alto");
    assert.equal(m.complete, false, "gap real (páginas 1-4 faltando) — antes da correção isto fechava complete:true");
    assert.equal(nextExitHistoryPage(m), 1, "retoma da menor página faltando, não de pages_fetched+1");
  });

  it("nextExitHistoryPage retoma no primeiro GAP, não em pages_fetched+1, quando páginas foram aplicadas fora de ordem", () => {
    let m = buildInitialExitHistoryManifest("2026-09-04T00:00:00Z");
    m = applyExitHistoryPageToManifest(m, { page: 1, total_pages: 9 }, "t1");
    m = applyExitHistoryPageToManifest(m, { page: 2, total_pages: 9 }, "t2");
    m = applyExitHistoryPageToManifest(m, { page: 4, total_pages: 9 }, "t3"); // pula a 3
    assert.equal(nextExitHistoryPage(m), 3, "retoma no gap (página 3), não em pages_fetched+1 (que seria 4)");
  });

  it("complete: true só quando TODA página 1..total_pages foi aplicada — completar em qualquer ordem funciona", () => {
    let m = buildInitialExitHistoryManifest("2026-09-04T00:00:00Z");
    for (const page of [3, 1, 2]) {
      m = applyExitHistoryPageToManifest(m, { page, total_pages: 3 }, "t");
    }
    assert.equal(m.complete, true);
    assert.equal(m.pages_fetched, 3);
  });

  it("total_pages ausente na página preserva o valor anterior do manifest", () => {
    let m = buildInitialExitHistoryManifest("2026-09-04T00:00:00Z");
    m = applyExitHistoryPageToManifest(m, { page: 1, total_pages: 9 }, "t1");
    m = applyExitHistoryPageToManifest(m, { page: 2 }, "t2"); // sem total_pages desta vez
    assert.equal(m.total_pages, 9, "total_pages não regride pra null só porque a página seguinte não repetiu o campo");
  });

  it("complete permanece false sem total_pages conhecido — nunca inferido de ausência de campo (diferente do bug #7197 da MCP irmã)", () => {
    let m = buildInitialExitHistoryManifest("2026-09-04T00:00:00Z");
    m = applyExitHistoryPageToManifest(m, { page: 1 }, "t1"); // sem total_pages
    assert.equal(m.complete, false, "sem total_pages, nunca fecha complete por acidente");
  });
});
