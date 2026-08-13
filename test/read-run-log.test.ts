/**
 * read-run-log.test.ts (#5191)
 *
 * Cobre a lógica pura de scripts/read-run-log.ts — o que `/diaria-log`
 * fazia por interpretação de prosa a cada invocação (filtro por edição/nível,
 * sort desc, top 50, truncamento de details.stack).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRunLog,
  filterRunLog,
  sortByTimestampDesc,
  truncateDetails,
  buildRunLogView,
  formatRunLog,
  type RunLogEntry,
} from "../scripts/read-run-log.ts";

function ev(overrides: Partial<RunLogEntry> = {}): RunLogEntry {
  return {
    timestamp: "2026-04-18T10:00:00.000Z",
    edition: "260418",
    stage: 1,
    agent: "source-researcher",
    level: "info",
    message: "ok",
    details: null,
    ...overrides,
  };
}

describe("parseRunLog (#5191)", () => {
  it("parseia linhas JSONL válidas, ignora malformadas e em branco", () => {
    const lines = [
      JSON.stringify(ev({ message: "a" })),
      "{ not json",
      "",
      "   ",
      JSON.stringify(ev({ message: "b" })),
    ].join("\n");
    const parsed = parseRunLog(lines);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed.map((e) => e.message), ["a", "b"]);
  });

  it("string vazia produz array vazio", () => {
    assert.deepEqual(parseRunLog(""), []);
  });
});

describe("filterRunLog (#5191)", () => {
  const entries = [
    ev({ edition: "260418", level: "error", message: "e1" }),
    ev({ edition: "260418", level: "warn", message: "w1" }),
    ev({ edition: "260418", level: "info", message: "i1" }),
    ev({ edition: "260419", level: "error", message: "e2" }),
  ];

  it("sem edition, filtra só por level", () => {
    const out = filterRunLog(entries, { levels: ["error"] });
    assert.deepEqual(out.map((e) => e.message), ["e1", "e2"]);
  });

  it("com edition, filtra por edição + level", () => {
    const out = filterRunLog(entries, { edition: "260418", levels: ["error", "warn"] });
    assert.deepEqual(out.map((e) => e.message), ["e1", "w1"]);
  });

  it("levels=[error,warn,info] (equivalente a --level all) não filtra nada", () => {
    const out = filterRunLog(entries, { levels: ["error", "warn", "info"] });
    assert.equal(out.length, 4);
  });

  it("edition sem match nenhum retorna vazio", () => {
    const out = filterRunLog(entries, { edition: "999999", levels: ["error", "warn", "info"] });
    assert.deepEqual(out, []);
  });
});

describe("sortByTimestampDesc (#5191)", () => {
  it("ordena do mais recente pro mais antigo", () => {
    const entries = [
      ev({ timestamp: "2026-04-18T10:00:00.000Z", message: "meio" }),
      ev({ timestamp: "2026-04-18T12:00:00.000Z", message: "mais recente" }),
      ev({ timestamp: "2026-04-18T08:00:00.000Z", message: "mais antigo" }),
    ];
    const sorted = sortByTimestampDesc(entries);
    assert.deepEqual(sorted.map((e) => e.message), ["mais recente", "meio", "mais antigo"]);
  });

  it("não muta o array original (pure)", () => {
    const entries = [ev({ timestamp: "t1" }), ev({ timestamp: "t2" })];
    const sorted = sortByTimestampDesc(entries);
    assert.notEqual(sorted, entries);
  });
});

describe("truncateDetails (#5191)", () => {
  it("details sem stack passa intocado", () => {
    const details = { url: "https://x", status: 403 };
    assert.deepEqual(truncateDetails(details), details);
  });

  it("details=null passa intocado", () => {
    assert.equal(truncateDetails(null), null);
  });

  it("stack curto (poucas linhas, poucos chars) passa intocado", () => {
    const details = { stack: "Error: x\n  at foo()\n  at bar()" };
    assert.deepEqual(truncateDetails(details), details);
  });

  it("stack com muitas linhas é truncado e marcado", () => {
    const longStack = Array.from({ length: 20 }, (_, i) => `  at frame${i}()`).join("\n");
    const truncated = truncateDetails({ stack: longStack, other: "preserved" }) as { stack: string; other: string };
    assert.ok(truncated.stack.includes("... (truncated)"));
    assert.ok(truncated.stack.split("\n").length <= 6); // 5 linhas + marcador
    assert.equal(truncated.other, "preserved"); // outros campos de details preservados
  });

  it("stack com poucas linhas mas muito longo (1 linha gigante) também é truncado por char", () => {
    const details = { stack: "x".repeat(2000) };
    const truncated = truncateDetails(details) as { stack: string };
    assert.ok(truncated.stack.includes("... (truncated)"));
    assert.ok(truncated.stack.length < 1000);
  });
});

describe("buildRunLogView (#5191) — pipeline completo", () => {
  it("parse → filter → sort desc → limit → truncate, em sequência", () => {
    const lines = [
      JSON.stringify(ev({ timestamp: "2026-04-18T08:00:00.000Z", level: "info", message: "old-info" })),
      JSON.stringify(ev({ timestamp: "2026-04-18T09:00:00.000Z", level: "error", message: "e1" })),
      JSON.stringify(ev({ timestamp: "2026-04-18T10:00:00.000Z", level: "warn", message: "w1" })),
    ].join("\n");

    const view = buildRunLogView(lines, { levels: ["error", "warn"] });
    // info excluído pelo filtro default; error+warn presentes, mais recente primeiro
    assert.deepEqual(view.map((e) => e.message), ["w1", "e1"]);
  });

  it("respeita --edition", () => {
    const lines = [
      JSON.stringify(ev({ edition: "260418", message: "a" })),
      JSON.stringify(ev({ edition: "260419", message: "b" })),
    ].join("\n");
    const view = buildRunLogView(lines, { edition: "260419", levels: ["error", "warn", "info"] });
    assert.deepEqual(view.map((e) => e.message), ["b"]);
  });

  it("respeita limit (top N após sort)", () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify(ev({ timestamp: `2026-04-18T${String(i).padStart(2, "0")}:00:00.000Z`, level: "info", message: `m${i}` })),
    ).join("\n");
    const view = buildRunLogView(lines, { levels: ["info"], limit: 3 });
    assert.equal(view.length, 3);
    assert.deepEqual(view.map((e) => e.message), ["m9", "m8", "m7"]);
  });

  it("trunca details.stack de cada evento no resultado final", () => {
    const longStack = Array.from({ length: 20 }, (_, i) => `  at frame${i}()`).join("\n");
    const lines = JSON.stringify(ev({ level: "error", details: { stack: longStack } }));
    const view = buildRunLogView(lines, { levels: ["error"] });
    assert.ok((view[0].details as { stack: string }).stack.includes("... (truncated)"));
  });
});

describe("formatRunLog (#5191)", () => {
  it("lista vazia produz header + mensagem clara", () => {
    const out = formatRunLog([], { edition: "260418" });
    assert.match(out, /edição 260418/);
    assert.match(out, /nenhum evento/i);
  });

  it("header sem edition usa 'últimos N eventos'", () => {
    const out = formatRunLog([ev({ level: "error" })], {});
    assert.match(out, /últimos 1 evento/);
  });

  it("inclui level, stage, agent, message e details formatados", () => {
    const out = formatRunLog(
      [ev({ level: "error", stage: 1, agent: "source-researcher", message: "retornou 403", details: { status: 403 } })],
      { edition: "260418" },
    );
    assert.match(out, /\[ERROR\]/);
    assert.match(out, /stage 1/);
    assert.match(out, /source-researcher/);
    assert.match(out, /retornou 403/);
    assert.match(out, /"status":403/);
  });

  it("stage/agent null viram '-' em vez de 'null' literal", () => {
    const out = formatRunLog([ev({ stage: null, agent: null })], {});
    assert.match(out, /stage -/);
    assert.match(out, / · -$/m);
  });
});
