/**
 * orchestrator-prompt.test.ts (#634 frente C)
 *
 * Snapshot test do conteúdo dos arquivos orchestrator.md + sub-arquivos.
 * Objetivo: detectar remoção acidental de seções ou invariantes críticos
 * durante refactors. Não testa comportamento — testa presença de conteúdo.
 *
 * Para atualizar snapshot intencionalmente após refactor legítimo:
 *   npm test -- --test-name-pattern "orchestrator-prompt" --update-snapshots
 *
 * Ou via node-test built-in snapshot update (Node 22):
 *   NODE_TEST_SNAPSHOTS=1 npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = resolve(ROOT, ".claude/agents");
const SNAPSHOT_PATH = resolve(ROOT, "test/__snapshots__/orchestrator-prompt.snap.json");

const ORCHESTRATOR_FILES = [
  "orchestrator.md",
  "orchestrator-stage-0-preflight.md",
  "orchestrator-stage-1-research.md",
  "orchestrator-stage-2.md",
  "orchestrator-stage-3.md",
  "orchestrator-stage-4.md",
];

/** Invariants that must be present in the combined orchestrator content. */
const REQUIRED_INVARIANTS = [
  // Cross-file structural requirements
  "Stage 0",
  "Stage 1",
  "## Stage 0",
  "## Stage 1",
  "Etapa 2",
  "Etapa 3",
  "Etapa 4",
  // Critical operational invariants
  "GATE HUMANO",
  "drive-sync.ts",
  "01-categorized.md",
  "01-approved.json",
  // Anti-skip guards
  "validate-pool",                         // inject-inbox-urls sentinel
  "drive_sync",                            // Stage 1w anti-skip
  // Stage 4 publication safety
  "confirmação explícita",
  // Smoke-compatible sections
  "inbox-drain",
  "scorer",
  "render-categorized-md",
];

function readOrchestratorFiles(): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const file of ORCHESTRATOR_FILES) {
    const path = resolve(AGENTS_DIR, file);
    assert.ok(existsSync(path), `Orchestrator file missing: ${file}`);
    contents[file] = readFileSync(path, "utf8");
  }
  return contents;
}

function computeHash(contents: Record<string, string>): string {
  // Normalize CRLF → LF before hashing for cross-platform consistency.
  // Windows writes CRLF, Linux/CI uses LF — without normalization hashes differ.
  const combined = ORCHESTRATOR_FILES
    .map((f) => `=== ${f} ===\n${contents[f].replace(/\r\n/g, "\n")}`)
    .join("\n\n");
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

function loadSnapshot(): { hash: string; file_sizes: Record<string, number> } | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveSnapshot(hash: string, fileSizes: Record<string, number>): void {
  writeFileSync(
    SNAPSHOT_PATH,
    JSON.stringify({ hash, file_sizes: fileSizes, updated_at: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
}

describe("orchestrator-prompt (#634)", () => {
  const contents = readOrchestratorFiles();
  const combined = Object.values(contents).join("\n");

  it("todos os arquivos existem e são não-vazios", () => {
    for (const [file, content] of Object.entries(contents)) {
      assert.ok(content.length > 100, `${file} parece vazio (< 100 chars)`);
    }
  });

  it("tamanhos de arquivo dentro dos targets", () => {
    const lines = Object.fromEntries(
      Object.entries(contents).map(([f, c]) => [f, c.split("\n").length]),
    );
    // root orchestrator.md ≤ 200 linhas
    assert.ok(lines["orchestrator.md"] <= 200, `orchestrator.md tem ${lines["orchestrator.md"]} linhas (target ≤200)`);
    // sub-arquivos ≤ 450 linhas (target 250, tolerância para arquivos de pesquisa)
    for (const file of ORCHESTRATOR_FILES.slice(1)) {
      assert.ok(
        lines[file] <= 450,
        `${file} tem ${lines[file]} linhas (target ≤450)`,
      );
    }
  });

  it("conteúdo combinado contém todas as invariantes obrigatórias", () => {
    for (const invariant of REQUIRED_INVARIANTS) {
      assert.ok(
        combined.includes(invariant),
        `Invariante ausente no orchestrator: "${invariant}"`,
      );
    }
  });

  it("sub-arquivos de stage referenciados no orchestrator.md raiz", () => {
    const root = contents["orchestrator.md"];
    assert.ok(root.includes("orchestrator-stage-0-preflight.md"), "orchestrator.md não referencia stage-0-preflight");
    assert.ok(root.includes("orchestrator-stage-1-research.md"), "orchestrator.md não referencia stage-1-research");
    assert.ok(root.includes("orchestrator-stage-2.md"), "orchestrator.md não referencia stage-2");
    assert.ok(root.includes("orchestrator-stage-4.md"), "orchestrator.md não referencia stage-4");
  });

  it("snapshot hash — detecta mudanças não-intencionais", () => {
    const hash = computeHash(contents);
    const fileSizes = Object.fromEntries(
      Object.entries(contents).map(([f, c]) => [f, c.split("\n").length]),
    );

    const snap = loadSnapshot();
    if (!snap) {
      // Primeira vez: criar snapshot
      saveSnapshot(hash, fileSizes);
      console.log(`  [snapshot] criado: ${hash}`);
      return;
    }

    // Verificar se hash mudou — se sim, exigir update intencional
    if (snap.hash !== hash) {
      // Check if running with update flag
      const updating = process.env.NODE_TEST_SNAPSHOTS === "1" ||
                       process.argv.includes("--update-snapshots");
      if (updating) {
        saveSnapshot(hash, fileSizes);
        console.log(`  [snapshot] atualizado: ${snap.hash} → ${hash}`);
      } else {
        assert.fail(
          `Orchestrator content changed (${snap.hash} → ${hash}).\n` +
          `Se o refactor é intencional, atualize o snapshot:\n` +
          `  NODE_TEST_SNAPSHOTS=1 npm test`
        );
      }
    }
  });
});
