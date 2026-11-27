/**
 * #14116 item 3 (decisão do editor de 27/11/2026): o doc editável do gate da
 * Etapa 4 (Claude Docs, #9964) deixou de ser criado por padrão. Só roda quando
 * o editor responde `doc` no gate; sem `doc_url` o `check` do §4e passa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCheck } from "../scripts/lib/stage4-docs-sync.ts";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("#14116 — doc do gate opt-in", () => {
  it("o step 3b não roda por padrão e é disparado pela resposta `doc`", () => {
    const pre = read(".claude/agents/orchestrator-stage-4.md");
    assert.doesNotMatch(pre, /3b\. \*\*Documento editável do gate no Claude Docs \(#9964\) — SEMPRE/);
    assert.match(pre, /SÓ A PEDIDO DO EDITOR desde o #14116/);
    assert.match(pre, /quando o editor responde `doc` no gate/);
    // A abertura no gate pelo pré-gate headless (#14034) não cria o doc.
    assert.doesNotMatch(pre, /o §4b step 3b \(doc do Claude Docs, que o `-p` pulou\)/);
    assert.match(pre, /nada do §4b step 3b \(o doc do Claude Docs só nasce com a resposta `doc` no gate/);
    // O `disable` de auto_approve continua rodando na preparação.
    assert.match(pre, /deste passo só roda o ramo `auto_approve` abaixo/);
  });

  it("o menu de respostas do gate lista `doc`", () => {
    const gate = read(".claude/agents/orchestrator-stage-4-gate.md");
    assert.match(gate, /^ {2}doc {5}→ cria o doc editável e re-apresenta \(#14116\)$/m);
  });

  it("o gate oferece `doc` no lugar do link e a receita existe", () => {
    const gate = read(".claude/agents/orchestrator-stage-4-gate.md");
    assert.match(gate, /Sem doc \(default, #14116\) → a linha toda vira `📝 Doc editável: responda doc para criar`/);
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
