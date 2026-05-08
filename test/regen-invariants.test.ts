/**
 * test/regen-invariants.test.ts (#969)
 *
 * Cobre helpers puros (categorize, extractRule, renderInvariants).
 * Não testa loadConventionIssues (depende de gh CLI external).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  categorize,
  extractRule,
  renderInvariants,
  type ConventionIssue,
} from "../scripts/regen-invariants.ts";

function mkIssue(overrides: Partial<ConventionIssue> = {}): ConventionIssue {
  return {
    number: 999,
    title: "test",
    body: "",
    state: "CLOSED",
    labels: [],
    ...overrides,
  };
}

describe("categorize (#969)", () => {
  it("Editorial: detecta categorized/reviewed", () => {
    assert.equal(
      categorize(mkIssue({ title: "ux: categorized/reviewed devem dizer só qual imagem é IA" })),
      "Editorial",
    );
  });

  it("Editorial: detecta destaque/lançamento", () => {
    assert.equal(
      categorize(mkIssue({ title: "Lançamentos só com link oficial" })),
      "Editorial",
    );
  });

  it("Drive sync: detecta drive-sync no título", () => {
    assert.equal(
      categorize(mkIssue({ title: "fix: drive-sync conflito" })),
      "Drive sync",
    );
  });

  it("Pipeline / MCP: detecta MCP no título", () => {
    assert.equal(
      categorize(mkIssue({ title: "MCP disconnect: fail-fast" })),
      "Pipeline / MCP",
    );
  });

  it("Processo / PRs: detecta sprint/PR/política", () => {
    assert.equal(
      categorize(mkIssue({ title: "process: política de 1 PR aberto por vez" })),
      "Processo / PRs",
    );
  });

  it("Lint / Validação: detecta lint/validate/invariant", () => {
    assert.equal(
      categorize(mkIssue({ title: "feat: scripts/check-invariants.ts" })),
      "Lint / Validação",
    );
  });

  it("Publicação: detecta beehiiv/linkedin", () => {
    assert.equal(
      categorize(mkIssue({ title: "Beehiiv: criar template Default" })),
      "Publicação",
    );
  });

  it("Outros: fallback quando nada bate", () => {
    assert.equal(categorize(mkIssue({ title: "qualquer coisa" })), "Outros");
  });
});

describe("extractRule (#969)", () => {
  it("usa título quando body não tem ## Regra", () => {
    const r = extractRule(mkIssue({ title: "fix: meu fix bonito", body: "Body sem regra." }));
    assert.equal(r, "meu fix bonito", "strip prefix 'fix:'");
  });

  it("usa título quando ## Regra está vazia (template comentário)", () => {
    const body = `## Regra\n<!-- Imperativo curto. -->\n\n## Justificativa`;
    const r = extractRule(mkIssue({ title: "infra: label convention", body }));
    assert.equal(r, "label convention");
  });

  it("extrai ## Regra quando preenchida", () => {
    const body = `## Contexto\n\nblá\n\n## Regra\n\nNunca cometer X em Y.\n\n## Justificativa`;
    const r = extractRule(mkIssue({ title: "any", body }));
    assert.equal(r, "Nunca cometer X em Y.");
  });

  it("strip de '(closes #N)' do título fallback", () => {
    const r = extractRule(mkIssue({ title: "fix: bla (closes #123)", body: "" }));
    assert.equal(r, "bla");
  });
});

describe("renderInvariants (#969)", () => {
  it("agrupa por categoria com ordem estável", () => {
    const issues = [
      mkIssue({ number: 1, title: "fix: drive-sync push falha" }),
      mkIssue({ number: 2, title: "MCP disconnect handling" }),
      mkIssue({ number: 3, title: "Lançamentos com link oficial" }),
    ];
    const md = renderInvariants(issues, new Date("2026-05-08T00:00:00Z"));
    // Drive sync vem antes de Pipeline/MCP por sectionOrder
    const driveIdx = md.indexOf("## Drive sync");
    const mcpIdx = md.indexOf("## Pipeline / MCP");
    const editorialIdx = md.indexOf("## Editorial");
    assert.ok(driveIdx > 0);
    assert.ok(driveIdx < mcpIdx);
    assert.ok(mcpIdx > 0);
    assert.ok(editorialIdx > 0);
  });

  it("ordena issues por número decrescente dentro da categoria", () => {
    const issues = [
      mkIssue({ number: 100, title: "fix: drive-sync A" }),
      mkIssue({ number: 200, title: "fix: drive-sync B" }),
      mkIssue({ number: 50, title: "fix: drive-sync C" }),
    ];
    const md = renderInvariants(issues);
    const idx200 = md.indexOf("(#200)");
    const idx100 = md.indexOf("(#100)");
    const idx50 = md.indexOf("(#50)");
    assert.ok(idx200 < idx100, "200 antes de 100");
    assert.ok(idx100 < idx50, "100 antes de 50");
  });

  it("inclui header + total + fonte de issues", () => {
    const issues = [mkIssue({ number: 1, title: "fix: any" })];
    const md = renderInvariants(issues);
    assert.match(md, /# Invariantes do projeto Diar\.ia/);
    assert.match(md, /Fonte: 1 issue/);
  });

  it("array vazio: gera doc com 0 issues sem crash", () => {
    const md = renderInvariants([]);
    assert.match(md, /Fonte: 0 issue/);
  });
});
