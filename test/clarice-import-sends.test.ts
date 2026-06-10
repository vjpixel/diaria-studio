import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sendListName, toImportCsv, parseArgs, mergeSendsSummaryWithListIds } from "../scripts/clarice-import-sends.ts";

describe("sendListName", () => {
  it("nome determinístico: dNN zero-padded + dia planejado", () => {
    assert.equal(sendListName(1, "qua", "Jun/2026"), "Clarice Jun/2026 d01 (qua)");
    assert.equal(sendListName(21, "ter", "Jun/2026"), "Clarice Jun/2026 d21 (ter)");
  });
});

describe("toImportCsv", () => {
  it("reduz a email+NOME (descarta TIER) e normaliza header -> EMAIL", () => {
    const { csv, count } = toImportCsv("email,NOME,TIER\na@b.com,Ana,maio\nc@d.com,Caio,T2\n");
    assert.ok(csv.startsWith("EMAIL,NOME"), `header: ${csv.split("\n")[0]}`);
    assert.ok(!/TIER/.test(csv), "TIER não deve ir pro Brevo");
    assert.ok(csv.includes("a@b.com,Ana"));
    assert.equal(count, 2);
  });

  it("aceita variação 'E-mail' e trim no email", () => {
    const { csv, count } = toImportCsv("Nome,E-mail\nZé,  x@y.com \n");
    assert.equal(csv.split("\n")[0], "EMAIL,NOME");
    assert.ok(csv.includes("x@y.com"));
    assert.equal(count, 1);
  });
});

describe("parseArgs", () => {
  it("defaults: dry-run, label Jun/2026, folder 1, only null", () => {
    const a = parseArgs([]);
    assert.equal(a.execute, false);
    assert.equal(a.label, "Jun/2026");
    assert.equal(a.folderId, 1);
    assert.equal(a.only, null);
  });

  it("--execute, --label, --folder-id, --only", () => {
    const a = parseArgs(["--execute", "--label", "Mai→Jun", "--folder-id", "4", "--only", "1,2,3"]);
    assert.equal(a.execute, true);
    assert.equal(a.label, "Mai→Jun");
    assert.equal(a.folderId, 4);
    assert.deepEqual(a.only, [1, 2, 3]);
  });

  it("--label não engole a flag seguinte", () => {
    const a = parseArgs(["--label", "--execute"]);
    assert.equal(a.label, "Jun/2026");
    assert.equal(a.execute, true);
  });

  it("--folder-id inválido cai no default 1", () => {
    assert.equal(parseArgs(["--folder-id", "abc"]).folderId, 1);
    assert.equal(parseArgs(["--folder-id", "0"]).folderId, 1);
  });
});

// Regressão #2007 (Fix 1): roundtrip import→sends-summary→schedule.
// clarice-import-sends deve gravar {n → listId} em sends-summary.json após --execute,
// caso contrário clarice-schedule-sends não encontra listId e S2/S3 --create falha.
// Se mergeSendsSummaryWithListIds for revertida (ex: remover a injeção de listId),
// todos estes testes quebram, cumprindo a regra #633.
describe("mergeSendsSummaryWithListIds (roundtrip import→summary #2007)", () => {
  const makeSummary = (sends: { n: number; [k: string]: unknown }[]) => ({ sends });

  it("injeta listId nos sends correspondentes", () => {
    const summary = makeSummary([
      { n: 8, file: "d08-17jun.csv", day: "ter", week: 2, planned: 1900, actual: 1898, comp: {} },
      { n: 9, file: "d09-18jun.csv", day: "qua", week: 2, planned: 1900, actual: 1899, comp: {} },
    ]);
    const results = [
      { n: 8, listId: 4201, processId: "pid-1", count: 1898 },
      { n: 9, listId: 4202, processId: "pid-2", count: 1899 },
    ];
    const merged = mergeSendsSummaryWithListIds(summary, results);
    assert.equal(merged.sends[0].listId, 4201, "d08 deve ter listId=4201");
    assert.equal(merged.sends[1].listId, 4202, "d09 deve ter listId=4202");
  });

  it("preserva todos os campos existentes (file, day, week, comp) — merge cirúrgico", () => {
    const comp = { T2: 500, T3: 1398 };
    const summary = makeSummary([
      { n: 8, file: "d08-17jun.csv", day: "ter", week: 2, planned: 1900, actual: 1898, comp },
    ]);
    const merged = mergeSendsSummaryWithListIds(summary, [{ n: 8, listId: 9999, processId: "x", count: 1898 }]);
    const s = merged.sends[0];
    assert.equal(s.file, "d08-17jun.csv", "file preservado");
    assert.equal(s.day, "ter", "day preservado");
    assert.equal(s.week, 2, "week preservado");
    assert.equal(s.planned, 1900, "planned preservado");
    assert.equal(s.actual, 1898, "actual preservado");
    assert.deepEqual(s.comp, comp, "comp preservado");
    assert.equal(s.listId, 9999, "listId injetado");
  });

  it("não injeta listId em sends sem resultado correspondente", () => {
    const summary = makeSummary([
      { n: 8, file: "d08.csv", day: "ter", week: 2 },
      { n: 9, file: "d09.csv", day: "qua", week: 2 },
    ]);
    // Só d08 foi importada
    const merged = mergeSendsSummaryWithListIds(summary, [{ n: 8, listId: 4201, processId: "x", count: 10 }]);
    assert.equal(merged.sends[0].listId, 4201, "d08 tem listId");
    assert.ok(!("listId" in merged.sends[1]), "d09 não deve ter listId injetado");
  });

  it("idempotente: reimportar send já com listId atualiza para o novo valor", () => {
    const summary = makeSummary([{ n: 8, file: "d08.csv", day: "ter", week: 2, listId: 4201 }]);
    const merged = mergeSendsSummaryWithListIds(summary, [{ n: 8, listId: 9999, processId: "x", count: 10 }]);
    assert.equal(merged.sends[0].listId, 9999, "listId atualizado para novo valor");
  });

  it("lista vazia de resultados não altera sends", () => {
    const summary = makeSummary([{ n: 8, file: "d08.csv", day: "ter", week: 2 }]);
    const merged = mergeSendsSummaryWithListIds(summary, []);
    assert.deepEqual(merged.sends, summary.sends);
  });
});
