/**
 * #14116 item 3 (decisão do editor de 27/11/2026): o doc editável do gate da
 * Etapa 4 (Claude Docs, #9964) deixou de ser criado por padrão. Só roda quando
 * o editor responde `doc` no gate; sem `doc_url` o `check` do §4e passa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { runCheck } from "../scripts/lib/stage4-docs-sync.ts";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("#14116 — doc do gate opt-in", () => {
  it("o step 3b não roda por padrão e é disparado pela resposta `doc`", () => {
    const pre = read(".claude/agents/orchestrator-stage-4.md");
    assert.doesNotMatch(pre, /3b\. \*\*Documento editável do gate no Claude Docs \(#9964\) — SEMPRE/);
    assert.match(pre, /SÓ A PEDIDO DO EDITOR desde o #14116/);
    assert.match(pre, /quando o editor responde `doc` no gate/);
  });

  it("o gate oferece `doc` no lugar do link e a receita existe", () => {
    const gate = read(".claude/agents/orchestrator-stage-4-gate.md");
    assert.match(gate, /Doc não pedido \(default, #14116\) → `responda doc para criar`/);
    const receitas = read("context/stage-4-gate-receitas.md");
    assert.match(receitas, /\*\*`doc`\*\* \(criar o doc editável, opt-in desde #14116\)/);
  });

  it("sem doc_url o check do §4e passa (o gate não trava sem doc)", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-opt-in-14116-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const r = runCheck({ editionDir: dir });
      assert.equal(r.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
