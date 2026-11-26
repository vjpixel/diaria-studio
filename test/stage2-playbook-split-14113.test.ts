/**
 * test/stage2-playbook-split-14113.test.ts (#14113)
 *
 * A Etapa 2 ganhou o mesmo corte que o #14030 fez nos Stages 0 e 1: o
 * `orchestrator-stage-2.md` guarda o bloco do runner `stage-2-run.ts` e os
 * passos que o top-level executa fora dele; a prosa dos passos que o runner
 * executa foi para `orchestrator-stage-2-fallback.md`. A skill
 * `/diaria-2-escrita` deixou de repetir a receita. A Clarice é só REST.
 *
 * Critério de pronto da issue, travado aqui:
 *   1. nenhum playbook da Etapa 2 (nem a skill) manda o LLM chamar
 *      `mcp__clarice__correct_text`;
 *   2. skill e playbook não descrevem a mesma receita duas vezes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DELEGATED_STEPS } from "../scripts/stage-2-run.ts";
import { STAGE2_PLAYBOOK_FILES } from "../scripts/lib/stage2-playbook.ts";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const principal = read(STAGE2_PLAYBOOK_FILES[0]);
const fallback = read(STAGE2_PLAYBOOK_FILES[1]);
const skill = read(".claude/skills/diaria-2-escrita/SKILL.md");
const orchestrator = read(".claude/agents/orchestrator.md");

/** Linhas que mandam chamar a ferramenta MCP da Clarice (não as que proíbem). */
function mcpCallInstructions(md: string): string[] {
  return md
    .split("\n")
    .filter((l) => l.includes("mcp__clarice__correct_text"))
    .filter((l) => !/\b(nunca|Nunca|não chama|nenhum passo)\b/.test(l));
}

describe("#14113 — Etapa 2 sem a Clarice via MCP pelo LLM", () => {
  for (const [label, md] of [
    ["orchestrator-stage-2.md", principal],
    ["orchestrator-stage-2-fallback.md", fallback],
    ["diaria-2-escrita/SKILL.md", skill],
  ] as const) {
    it(`${label}: nenhuma instrução de chamar mcp__clarice__correct_text`, () => {
      assert.deepEqual(mcpCallInstructions(md), []);
    });
  }

  it("o frontmatter dos dois playbooks não lista a ferramenta MCP da Clarice", () => {
    for (const md of [principal, fallback]) {
      const front = md.slice(0, md.indexOf("\n---", 4));
      assert.doesNotMatch(front, /mcp__clarice/);
    }
  });

  it("a Clarice do fallback, newsletter e social, vai pelo clarice-correct.ts com --corrected-out", () => {
    const calls = fallback.match(/npx tsx scripts\/clarice-correct\.ts \\\n[^`]*?--corrected-out/g) ?? [];
    assert.equal(calls.length, 2, "uma chamada REST para a newsletter e uma para o social");
    assert.match(fallback, /--in \{EDITION_DIR\}\/03-social\.md/);
    assert.doesNotMatch(fallback, /Caminho MCP/);
    assert.doesNotMatch(fallback, /clarice MCP failed — REST fallback/);
  });
});

describe("#14113 — uma receita só (skill x playbook)", () => {
  it("a skill não repete os passos: sem dispatch próprio, sem Clarice, sem stitch/normalize/sentinel à mão", () => {
    for (const re of [
      /Agent\(\{/,
      /npx tsx scripts\/clarice-correct\.ts/,
      /npx tsx scripts\/clarice-apply\.ts/,
      /npx tsx scripts\/stitch-newsletter\.ts/,
      /npx tsx scripts\/normalize-newsletter\.ts/,
      /npx tsx scripts\/merge-social-md\.ts/,
      /npx tsx scripts\/apply-stage2-caps\.ts/,
      /^npx tsx scripts\/pipeline-sentinel\.ts write/m,
    ]) {
      assert.doesNotMatch(skill, re, `a skill ainda repete: ${re}`);
    }
  });

  it("a skill aponta o fallback e os passos fora do runner", () => {
    assert.match(skill, /\.claude\/agents\/orchestrator-stage-2-fallback\.md/);
    assert.match(skill, /\.claude\/agents\/orchestrator-stage-2\.md/);
    assert.match(skill, /stage-2-run\.ts --phase pre-dispatch/);
  });

  it("o principal manda ler o fallback quando o runner falha", () => {
    assert.match(principal, /\*\*Fallback:\*\* se o runner não existir ou falhar[^\n]*orchestrator-stage-2-fallback\.md/);
  });

  it("o principal não carrega a prosa que o runner executa", () => {
    for (const marker of [
      "### Pré-condição: sentinel Stage 1",
      "### 2a. Writer + social em paralelo",
      "**Pós:** rodar `scripts/stitch-newsletter.ts`",
      "- **Normalizar layout (inline — sem Agent, #157):**",
      "**Humanizar social (#308, #1072, refined #1546):**",
      "  - **Auto-pick de título via Sonnet (#159, #2772).**",
    ]) {
      assert.ok(!principal.includes(marker), `principal ainda tem: ${marker}`);
      assert.ok(fallback.includes(marker), `fallback perdeu: ${marker}`);
    }
  });

  it("os passos delegados ao top-level têm lugar no principal", () => {
    assert.ok(DELEGATED_STEPS.length >= 6);
    for (const needle of [
      "pendingAgentDispatch",
      "record-agent-costs.ts",
      "GATE HUMANO unificado",
      "Filtro de segurança ao PROPOR candidatos",
      "§2b — consertos por id",
      "update-stage-status.ts --stage 2",
      "tabela temática do #6083",
    ]) {
      assert.ok(principal.includes(needle), `principal sem: ${needle}`);
    }
  });

  it("o fallback guarda o que estava só na skill: limpeza dos snapshots depois do sentinel", () => {
    const sentinel = fallback.indexOf("npx tsx scripts/pipeline-sentinel.ts write");
    const cleanup = fallback.indexOf("Limpar os snapshots intermediários (#874, #9581)");
    assert.ok(sentinel > 0 && cleanup > sentinel);
  });

  it("orchestrator.md não faz @see do fallback (só é lido no ponto em que o principal manda)", () => {
    assert.doesNotMatch(orchestrator, /@see \.claude\/agents\/orchestrator-stage-2-fallback\.md/);
    assert.match(orchestrator, /orchestrator-stage-2-fallback\.md/);
  });
});
