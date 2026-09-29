/**
 * test/review-test-email-prefetch.test.ts (#9000)
 *
 * O conector Gmail pode aparecer com prefixo UUID, fora da allowlist `tools:`
 * do agent review-test-email (#8902/#8953 nao resolveram). Fix: o top-level
 * (orchestrator-stage-5 §5f passo 0) busca o e-mail e passa `email_file`;
 * o agent nao chama Gmail nesse modo. Guard de spec/wiring (grep).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agent = readFileSync(resolve(ROOT, ".claude/agents/review-test-email.md"), "utf8");
const orch = readFileSync(resolve(ROOT, ".claude/agents/orchestrator-stage-5.md"), "utf8");

describe("review-test-email pre-fetch pelo top-level (#9000)", () => {
  it("agent declara inputs email_file e email_subject", () => {
    assert.match(agent, /- `email_file` \(opcional, #9000\)/);
    assert.match(agent, /- `email_subject` \(opcional, #9000\)/);
  });

  it("agent tem secao Modo pre-buscado que proibe Gmail e mcp_unavailable", () => {
    const i = agent.indexOf("## Modo pré-buscado");
    assert.ok(i !== -1);
    const sec = agent.slice(i, agent.indexOf("\n## ", i + 1));
    assert.match(sec, /NÃO chamar nenhuma tool Gmail/);
    assert.match(sec, /Nunca retornar `mcp_unavailable` neste modo/);
  });

  it("busca Beehiiv (secao 1) e Kit (K1) mandam pular com email_file", () => {
    const beehiiv = agent.slice(agent.indexOf("### 1. Buscar o email"), agent.indexOf("### 1c."));
    const kit = agent.slice(agent.indexOf("### K1."), agent.indexOf("### K2."));
    assert.match(beehiiv, /Com `email_file` \(#9000\): pular/);
    assert.match(kit, /Com `email_file` \(#9000\): pular/);
  });

  it("orchestrator-stage-5 §5f pre-busca no top-level e repassa email_file", () => {
    assert.match(orch, /Pré-buscar o e-mail de teste no top-level \(#9000\)/);
    assert.match(orch, /ToolSearch/);
    assert.match(orch, /`email_file` e `email_subject`/);
    assert.ok(orch.indexOf("Pré-buscar o e-mail") < orch.indexOf("Verificar email de teste."));
  });
});
