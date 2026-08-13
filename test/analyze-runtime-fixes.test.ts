/**
 * test/analyze-runtime-fixes.test.ts (#1210, item 5)
 *
 * Cobre a agregação cross-edição de runtime-fixes.jsonl (helper puro) e o
 * CLI end-to-end via subprocess com --editions-dir isolado (nunca toca
 * data/editions/ real — junction OneDrive).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  aggregateByComponent,
  detectRecurringComponents,
  readRuntimeFixesForEditions,
  type RuntimeFixEntry,
} from "../scripts/analyze-runtime-fixes.ts";

const ROOT = resolve(import.meta.dirname, "..");

function fix(overrides: Partial<RuntimeFixEntry> = {}): RuntimeFixEntry {
  return {
    timestamp: "2026-08-13T05:00:00Z",
    edition: "260813",
    stage: 3,
    fix_type: "tooling",
    component: "title-picker",
    description: "fix genérico",
    severity: "P2",
    ...overrides,
  };
}

describe("aggregateByComponent (#1210 item 5)", () => {
  it("agrupa entries de múltiplas edições pelo mesmo component", () => {
    const byEdition: Record<string, RuntimeFixEntry[]> = {
      "260810": [fix({ edition: "260810" })],
      "260811": [fix({ edition: "260811" })],
      "260812": [fix({ edition: "260812", component: "writer" })],
    };
    const agg = aggregateByComponent(byEdition);
    const titlePicker = agg.find((a) => a.component === "title-picker")!;
    assert.equal(titlePicker.edition_count, 2);
    assert.deepEqual(titlePicker.editions, ["260810", "260811"]);
    assert.equal(titlePicker.fix_count, 2);

    const writer = agg.find((a) => a.component === "writer")!;
    assert.equal(writer.edition_count, 1);
  });

  it("mesma edição com 2 fixes do mesmo componente conta 1 edição, 2 fixes", () => {
    const byEdition: Record<string, RuntimeFixEntry[]> = {
      "260813": [
        fix({ description: "fix A" }),
        fix({ description: "fix B" }),
      ],
    };
    const agg = aggregateByComponent(byEdition);
    assert.equal(agg[0].edition_count, 1);
    assert.equal(agg[0].fix_count, 2);
  });

  it("worst_severity pega a pior (P1 < P2 em urgência)", () => {
    const byEdition: Record<string, RuntimeFixEntry[]> = {
      "260813": [fix({ severity: "P2" }), fix({ severity: "P1" }), fix({ severity: "P3" })],
    };
    const agg = aggregateByComponent(byEdition);
    assert.equal(agg[0].worst_severity, "P1");
  });

  it("fix_types deduplicado e ordenado", () => {
    const byEdition: Record<string, RuntimeFixEntry[]> = {
      "260813": [fix({ fix_type: "format" }), fix({ fix_type: "structural" }), fix({ fix_type: "format" })],
    };
    const agg = aggregateByComponent(byEdition);
    assert.deepEqual(agg[0].fix_types, ["format", "structural"]);
  });

  it("ordena por edition_count desc, depois fix_count desc", () => {
    const byEdition: Record<string, RuntimeFixEntry[]> = {
      "260810": [fix({ edition: "260810", component: "A" })],
      "260811": [fix({ edition: "260811", component: "B" }), fix({ edition: "260811", component: "B" })],
    };
    const agg = aggregateByComponent(byEdition);
    // B: 1 edição, 2 fixes. A: 1 edição, 1 fix. Empate em edition_count → B primeiro (mais fixes).
    assert.equal(agg[0].component, "B");
  });

  it("input vazio → agregado vazio", () => {
    assert.deepEqual(aggregateByComponent({}), []);
  });
});

describe("detectRecurringComponents (#1210 item 5)", () => {
  it("filtra por threshold de edições distintas (default 3)", () => {
    const aggregates = [
      { component: "A", edition_count: 3, editions: ["1", "2", "3"], fix_count: 3, fix_types: ["tooling"], worst_severity: "P2" as const, sample_descriptions: [] },
      { component: "B", edition_count: 2, editions: ["1", "2"], fix_count: 2, fix_types: ["tooling"], worst_severity: "P2" as const, sample_descriptions: [] },
    ];
    const recurring = detectRecurringComponents(aggregates, 3);
    assert.equal(recurring.length, 1);
    assert.equal(recurring[0].component, "A");
  });

  it("--min-editions customizado", () => {
    const aggregates = [
      { component: "B", edition_count: 2, editions: ["1", "2"], fix_count: 2, fix_types: ["tooling"], worst_severity: "P2" as const, sample_descriptions: [] },
    ];
    assert.equal(detectRecurringComponents(aggregates, 2).length, 1);
    assert.equal(detectRecurringComponents(aggregates, 3).length, 0);
  });
});

describe("readRuntimeFixesForEditions (#1210 item 5)", () => {
  it("lê runtime-fixes.jsonl de cada dir no índice, ignora edições sem o arquivo", () => {
    const root = mkdtempSync(join(tmpdir(), "analyze-rf-"));
    try {
      const ed1 = join(root, "260810");
      const ed2 = join(root, "260811");
      mkdirSync(join(ed1, "_internal"), { recursive: true });
      mkdirSync(ed2, { recursive: true }); // sem _internal/runtime-fixes.jsonl
      writeFileSync(
        join(ed1, "_internal/runtime-fixes.jsonl"),
        JSON.stringify(fix({ edition: "260810" })) + "\n",
      );
      const index = new Map([
        ["260810", ed1],
        ["260811", ed2],
      ]);
      const out = readRuntimeFixesForEditions(index);
      assert.ok(out["260810"]);
      assert.equal(out["260810"].length, 1);
      assert.ok(!out["260811"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("linhas malformadas são puladas sem crashar", () => {
    const root = mkdtempSync(join(tmpdir(), "analyze-rf-"));
    try {
      const ed1 = join(root, "260810");
      mkdirSync(join(ed1, "_internal"), { recursive: true });
      writeFileSync(
        join(ed1, "_internal/runtime-fixes.jsonl"),
        "{garbage\n" + JSON.stringify(fix()) + "\n",
      );
      const out = readRuntimeFixesForEditions(new Map([["260810", ed1]]));
      assert.equal(out["260810"].length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("analyze-runtime-fixes CLI (#1210 item 5)", () => {
  it("--json com --editions-dir isolado detecta componente recorrente", () => {
    const root = mkdtempSync(join(tmpdir(), "analyze-rf-cli-"));
    try {
      for (const edition of ["260810", "260811", "260812"]) {
        const dir = join(root, edition, "_internal");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "runtime-fixes.jsonl"),
          JSON.stringify(fix({ edition, component: "title-picker" })) + "\n",
        );
      }
      const result = spawnSync(
        "npx",
        ["tsx", "scripts/analyze-runtime-fixes.ts", "--editions-dir", root, "--json", "--min-editions", "3"],
        { cwd: ROOT, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.editions_scanned, 3);
      assert.equal(parsed.recurring_components.length, 1);
      assert.equal(parsed.recurring_components[0].component, "title-picker");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem --json imprime markdown com o header esperado", () => {
    const root = mkdtempSync(join(tmpdir(), "analyze-rf-cli-md-"));
    try {
      const result = spawnSync(
        "npx",
        ["tsx", "scripts/analyze-runtime-fixes.ts", "--editions-dir", root],
        { cwd: ROOT, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /# Runtime fixes — análise cross-edição \(#1210\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
