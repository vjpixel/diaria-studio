/**
 * test/mensal-skill-coleta-kit-11787.test.ts (#11787)
 *
 * O `/diaria-mensal` 2610-11 travou na Etapa 1d porque o SKILL.md mandava
 * coletar os raw-posts pelo MCP da Beehiiv (arquivo histórico desde o #11225).
 * Sem raw-posts, `kit-clicks-enrich.ts` devolve lista vazia e
 * `monthly-click-sections.ts` aborta. Guarda que o Preflight e a Etapa 1 não
 * voltam a exigir a Beehiiv e que a coleta passa por `fetch-monthly-posts.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SKILL = readFileSync(resolve(import.meta.dirname, "../.claude/skills/diaria-mensal/SKILL.md"), "utf8");

function section(start: RegExp, end: RegExp): string {
  const a = SKILL.search(start);
  assert.ok(a >= 0, `seção ${start} não encontrada`);
  const rest = SKILL.slice(a);
  const b = rest.slice(1).search(end);
  return b >= 0 ? rest.slice(0, b + 1) : rest;
}

describe("/diaria-mensal: coleta pelo Kit, sem Beehiiv (#11787)", () => {
  const preflight = section(/^## Etapa 0/m, /^## /m);
  const etapa1a = section(/^### 1a\./m, /^### 1b\./m);

  it("o Preflight não exige Beehiiv (MCP nem publicationId)", () => {
    assert.doesNotMatch(preflight, /Beehiiv MCP|beehiiv\.publicationId/);
    assert.match(preflight, /KIT_API_KEY/);
  });

  it("a Etapa 1a coleta com fetch-monthly-posts.ts, não pelo MCP da Beehiiv", () => {
    assert.doesNotMatch(etapa1a, /mcp__claude_ai_Beehiiv__/);
    assert.match(etapa1a, /npx tsx scripts\/fetch-monthly-posts\.ts --cycle \$CYCLE/);
    assert.match(etapa1a, /kit-clicks-enrich\.ts/);
  });
});
