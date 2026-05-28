/**
 * research-reviewer-out-path.test.ts (#1271, removed in #1553)
 *
 * Originalmente verificava que o orchestrator invocava research-reviewer com
 * out_path explícito. Em #1553 (P3 speed optimization) o agent foi removido
 * do Stage 1 — o Filtro 2 (theme dedup) é coberto deterministicamente por
 * dedup.ts Pass 1d (#1475 — theme-entity match) e Pass 1c (#1331 — Jaccard
 * com threshold lowered quando entidades coincidem).
 *
 * Os testes abaixo são anti-regressão: garantem que a seção 1p2 do playbook
 * NÃO re-introduza a invocação do agent acidentalmente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

describe("research-reviewer removal (#1553 P3)", () => {
  it("orchestrator-stage-1-research.md NÃO invoca research-reviewer agent", () => {
    const md = readFileSync(resolve(ROOT, ".claude/agents/orchestrator-stage-1-research.md"), "utf8");
    // Buscar invocação ativa (Agent dispatch ou comando shell)
    // Excluir menções históricas/comentários que apenas referenciam o removal
    const activeInvocation = /Disparar `research-reviewer`/.test(md);
    assert.equal(
      activeInvocation,
      false,
      "research-reviewer agent foi removido em #1553 (coberto por dedup.ts) — não re-invocar",
    );
  });

  it("seção 1p2 documenta a remoção com rationale", () => {
    const md = readFileSync(resolve(ROOT, ".claude/agents/orchestrator-stage-1-research.md"), "utf8");
    const f2section = md.match(/### 1p2\.[\s\S]{0,1500}/);
    assert.ok(f2section, "seção 1p2 deve existir (mesmo que apenas pra documentar remoção)");
    assert.match(f2section![0], /REMOVIDO/i, "seção deve marcar explicitamente como removida");
    assert.match(f2section![0], /dedup\.ts/i, "deve mencionar quem cobre o filtro agora");
  });
});
