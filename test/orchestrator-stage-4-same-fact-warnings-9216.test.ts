import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const md = readFileSync(".claude/agents/orchestrator-stage-4.md", "utf8");
// Parágrafos = blocos separados por linha em branco.
const paragraphs = md.split(/\n\s*\n/);
const hits = paragraphs.filter((p) => p.includes("same_fact_warnings"));

describe("orchestrator-stage-4 same_fact_warnings (#9216)", () => {
  it("existe exatamente 1 parágrafo com a instrução", () => {
    assert.equal(hits.length, 1, `esperado 1 parágrafo, achou ${hits.length}`);
  });
  it("é passo próprio e incondicional, warn-only, lendo o JSON do Stage 1", () => {
    // Isola o trecho da instrução (do marcador até "Nunca bloqueia.").
    const m = hits[0].match(/\*\*Passo incondicional — `same_fact_warnings`[\s\S]*?Nunca bloqueia\./);
    assert.ok(m, "trecho 'Passo incondicional — same_fact_warnings' ausente");
    const p = m[0];
    assert.match(p, /WARN-ONLY/);
    assert.match(p, /_internal\/01-highlight-theme-check\.json/);
    assert.match(p, /02-reviewed\.md/);
    assert.match(p, /\{violations_block\}/);
    assert.match(p, /item_title \+ matched_edition \+ matched_title/);
    assert.match(p, /Nunca bloqueia/);
  });
  it("vive no parágrafo incondicional do agregador, não no de um check (só lido quando o id falha)", () => {
    const p = hits[0];
    assert.doesNotMatch(p, /^`[a-z0-9-]+`/);
    // Bloco §4c.2 (lints consolidados): a linha da instrução é a do agregador (#5416).
    assert.match(p, /^\*\*4c\.2 — Lints consolidados:\*\*/);
    const line = p.split("\n").find((l) => l.includes("same_fact_warnings"))!;
    assert.match(line, /^\(#5416\) O 2º comando substitui/);
    assert.ok(!p.includes("radar-summary-matches-title"));
  });
  it("o artefato citado é o que o Stage 1 grava", () => {
    const s1 = readFileSync(".claude/agents/orchestrator-stage-1-research.md", "utf8");
    assert.match(s1, /--out-json \{EDITION_DIR\}\/_internal\/01-highlight-theme-check\.json/);
  });
});
