/**
 * test/list-invariants.test.ts (#1580)
 *
 * Cobre o gerador de docs de invariants + o gate --check que detecta drift.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { generateInvariantsMarkdown } from "../scripts/list-invariants.ts";
import { ALL_INVARIANT_RULES } from "../scripts/lib/invariant-checks/index.ts";

function runCli(args: string[]): {
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "list-invariants.ts");
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, ...args],
    { cwd: projectRoot, encoding: "utf8" },
  );
  return { status: r.status, stderr: r.stderr || "", stdout: r.stdout || "" };
}

describe("generateInvariantsMarkdown (#1580)", () => {
  it("inclui todas as rules do ALL_INVARIANT_RULES", () => {
    const md = generateInvariantsMarkdown();
    for (const rule of ALL_INVARIANT_RULES) {
      assert.match(md, new RegExp(`\\\`${escapeRegex(rule.id)}\\\``), `${rule.id} ausente`);
    }
  });

  it("agrupa por stage com headers reconhecíveis", () => {
    const md = generateInvariantsMarkdown();
    assert.match(md, /## Static \(estrutura do repo\)/);
    // Pelo menos algum stage deve aparecer (depende de quais têm rules)
    assert.match(md, /## Stage \d/);
  });

  it("conta total de invariants no header", () => {
    const md = generateInvariantsMarkdown();
    const m = md.match(/\*\*Total\*\*: (\d+) invariants/);
    assert.ok(m);
    const total = parseInt(m![1], 10);
    // Total bate com ALL_INVARIANT_RULES + STATIC_RULES (2)
    assert.ok(total >= ALL_INVARIANT_RULES.length);
  });

  it("rules dentro de cada stage saem em ordem alfabética por id", () => {
    const md = generateInvariantsMarkdown();
    const lines = md.split("\n");
    let currentStageIds: string[] = [];
    for (const line of lines) {
      if (line.startsWith("## ")) {
        // Verify previous stage
        const sorted = [...currentStageIds].sort();
        assert.deepEqual(currentStageIds, sorted, "ids deveriam estar alfabéticos");
        currentStageIds = [];
      }
      const m = line.match(/^\| \`([^`]+)\` \|/);
      if (m) currentStageIds.push(m[1]);
    }
    // Final stage
    const sorted = [...currentStageIds].sort();
    assert.deepEqual(currentStageIds, sorted);
  });

  it("escapa pipes na descrição (não quebra tabela markdown)", () => {
    const md = generateInvariantsMarkdown();
    // Verifica que não há `|` não-escapado fora das células da tabela
    const tableLines = md.split("\n").filter((l) => l.startsWith("| `"));
    for (const line of tableLines) {
      // Cada linha deve ter exatamente 4 `|`: borda esquerda, 2 separadores, borda direita
      const pipeCount = (line.match(/\|/g) ?? []).length;
      const escapedCount = (line.match(/\\\|/g) ?? []).length;
      assert.equal(
        pipeCount - escapedCount,
        4,
        `Linha quebra tabela: ${line}`,
      );
    }
  });
});

describe("list-invariants CLI (#1580)", () => {
  it("--out grava arquivo MD", () => {
    const dir = mkdtempSync(join(tmpdir(), "list-inv-out-"));
    try {
      // Use absolute path to avoid project root resolution
      const outPath = join(dir, "invariants.md");
      const r = runCli(["--out", outPath]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(outPath));
      const md = readFileSync(outPath, "utf8");
      assert.match(md, /# Editorial invariants/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("--check ok quando arquivo bate com registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "list-inv-check-"));
    try {
      const outPath = join(dir, "invariants.md");
      // Generate first
      runCli(["--out", outPath]);
      // Then check — should pass
      const r = runCli(["--check", outPath]);
      assert.equal(r.status, 0, r.stderr);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("--check exit 1 quando arquivo divergiu (alguém adicionou invariant sem regenerar)", () => {
    const dir = mkdtempSync(join(tmpdir(), "list-inv-drift-"));
    try {
      const outPath = join(dir, "invariants.md");
      writeFileSync(outPath, "# Versão antiga\n\nSem invariants documentados.\n");
      const r = runCli(["--check", outPath]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /divergiu/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("--check exit 1 quando arquivo ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "list-inv-miss-"));
    try {
      const outPath = join(dir, "nonexistent.md");
      const r = runCli(["--check", outPath]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /não existe/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("docs/editorial-invariants.md committed (#1580)", () => {
  it("arquivo committed bate com registry atual", () => {
    const docPath = resolve(import.meta.dirname, "..", "docs", "editorial-invariants.md");
    assert.ok(existsSync(docPath), "docs/editorial-invariants.md deve estar committado");
    const committed = readFileSync(docPath, "utf8");
    const generated = generateInvariantsMarkdown();
    assert.equal(
      committed.trim(),
      generated.trim(),
      "Re-rodar: npx tsx scripts/list-invariants.ts --out docs/editorial-invariants.md",
    );
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
