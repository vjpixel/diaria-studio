/**
 * test/agent-issue-validator.test.ts (#1421)
 *
 * Cobre o filter determinístico de issues do review-test-email contra
 * falso-positivos de encoding. Casos derivados literal do caso 260520.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractQuotedTerms,
  isEncodingDropFalsePositive,
  isPollSigMissingFalsePositive,
  isVoteEditionMalformedFalsePositive,
  isBoldMissingFalsePositive,
  isItalicMissingFalsePositive,
  isMergeTagUnexpandedFalsePositive,
  filterAgentIssues,
} from "../scripts/lib/agent-issue-validator.ts";

describe("extractQuotedTerms (#1421)", () => {
  it("extrai múltiplos termos entre aspas simples", () => {
    const issue = "email:encoding_drop: 'é' em 'pré-treino' / 'pré-treinamento' pode estar corrompido";
    assert.deepEqual(extractQuotedTerms(issue), ["é", "pré-treino", "pré-treinamento"]);
  });

  it("retorna [] quando não há aspas", () => {
    assert.deepEqual(extractQuotedTerms("email:encoding_drop: corrupted body"), []);
  });
});

describe("isEncodingDropFalsePositive (#1421)", () => {
  it("#1421: caso 260520 — termos presentes no HTML local com acentos OK", () => {
    const html = "<p>Karpathy entra no time de pré-treino da Anthropic</p>";
    const issue = "email:encoding_drop: 'pré-treino' pode estar corrompido";
    const r = isEncodingDropFalsePositive(issue, html);
    assert.equal(r.falsePositive, true);
    if (r.falsePositive) {
      assert.match(r.reason, /pré-treino/);
    }
  });

  it("não-falso-positivo quando termo de fato falta no HTML", () => {
    const html = "<p>Karpathy entra no time da Anthropic</p>";
    const issue = "email:encoding_drop: 'pré-treino' pode estar corrompido";
    const r = isEncodingDropFalsePositive(issue, html);
    assert.equal(r.falsePositive, false);
  });

  it("issue sem termos entre aspas → não dá pra validar (mantém)", () => {
    const r = isEncodingDropFalsePositive("email:encoding_drop: corruption", "<p>anything</p>");
    assert.equal(r.falsePositive, false);
  });

  it("múltiplos termos: 1 ausente → não é falso-positivo (mantém issue)", () => {
    const html = "<p>pré-treino sim, funcionários NÃO</p>";
    // O HTML acima tem 'pré-treino' e 'funcionários'. Vamos forçar caso onde 1 falta:
    const html2 = "<p>pré-treino sim</p>";
    const issue = "email:encoding_drop: 'pré-treino' e 'funcionários' corrompidos";
    const r = isEncodingDropFalsePositive(issue, html2);
    assert.equal(r.falsePositive, false);
  });
});

describe("isPollSigMissingFalsePositive (#1421)", () => {
  it("#1421: caso 260520 — {{poll_sig}} merge tag presente no HTML local", () => {
    const html = '<a href="https://poll.diaria.workers.dev/vote?sig={{poll_sig}}">vote</a>';
    const r = isPollSigMissingFalsePositive(html);
    assert.equal(r.falsePositive, true);
  });

  it("sig= como URL param já resolvido também conta", () => {
    const html = '<a href="https://poll.diaria.workers.dev/vote?sig=abc123">vote</a>';
    const r = isPollSigMissingFalsePositive(html);
    assert.equal(r.falsePositive, true);
  });

  it("HTML realmente sem merge tag nem sig → não-falso-positivo (válido)", () => {
    const html = "<p>just body, no vote link</p>";
    const r = isPollSigMissingFalsePositive(html);
    assert.equal(r.falsePositive, false);
  });
});

describe("isVoteEditionMalformedFalsePositive (#1421)", () => {
  it("#1421: caso 260520 — edition=260520 presente no HTML mas agent leu como &edition&0520", () => {
    const html = '<a href="...&amp;edition=260520&amp;choice=A">vote</a>';
    const r = isVoteEditionMalformedFalsePositive(html, "260520");
    assert.equal(r.falsePositive, true);
  });

  it("não-falso-positivo quando edition= de fato malformed", () => {
    const html = '<a href="...&amp;edition&amp;0520">vote</a>';
    const r = isVoteEditionMalformedFalsePositive(html, "260520");
    assert.equal(r.falsePositive, false);
  });
});

describe("#1949 — FPs do novo DS + merge tags", () => {
  it("isBoldMissingFalsePositive: 'título sem negrito' é FP (DS serif sem bold)", () => {
    assert.equal(isBoldMissingFalsePositive("email:formatting: D2 título sem negrito").falsePositive, true);
    assert.equal(isBoldMissingFalsePositive("email:formatting: link sem diferenciação").falsePositive, false);
  });

  it("isItalicMissingFalsePositive: 'não está em itálico' é FP (DS sans sem itálico)", () => {
    assert.equal(
      isItalicMissingFalsePositive("email:formatting: seção É IA? crédito não está em itálico").falsePositive,
      true,
    );
    // italic_literal (`*texto*` não convertido) é bug REAL — NÃO é FP
    assert.equal(
      isItalicMissingFalsePositive("email:italic_literal: '*Canis aureus*' literal").falsePositive,
      false,
    );
  });

  it("isMergeTagUnexpandedFalsePositive: SÓ conjunto fechado {{email}}/{{poll_sig}} em link/formatting", () => {
    assert.equal(
      isMergeTagUnexpandedFalsePositive("email:link_broken: href tem {{email}} não expandido").falsePositive,
      true,
    );
    assert.equal(
      isMergeTagUnexpandedFalsePositive("email:formatting: {{poll_sig}} aparece literal = blocker").falsePositive,
      true,
    );
    assert.equal(isMergeTagUnexpandedFalsePositive("email:link_dead: https://x.com 404").falsePositive, false);
  });

  it("code-review: NÃO over-dropa bugs reais que co-mencionam negrito/itálico/{{...}}", () => {
    // F1: subject_mismatch é SEMPRE blocker (#1645) — nunca dropar, mesmo com {{...}}.
    assert.equal(
      isMergeTagUnexpandedFalsePositive("email:subject_mismatch: subject é '{{title}}' literal").falsePositive,
      false,
    );
    // F2: {{unknown_field}}/{{utm_campaign}} num link É bug real (var vazada) — não é o conjunto fechado.
    assert.equal(
      isMergeTagUnexpandedFalsePositive("email:link_wrong: D1 aponta pra https://x.com/{{utm_campaign}}").falsePositive,
      false,
    );
    // F3: defeito INVERSO (título em negrito demais) NÃO é "sem negrito" → mantém.
    assert.equal(
      isBoldMissingFalsePositive("email:formatting: título do D2 em NEGRITO além do tamanho, peso duplicado").falsePositive,
      false,
    );
    // F3b: link_missing cujo TÍTULO cita "negrito" não é formatting → mantém.
    assert.equal(
      isBoldMissingFalsePositive("email:link_missing: URL do título 'Texto em negrito no Notion' ausente").falsePositive,
      false,
    );
    // F4: hierarquia de título que co-menciona "sem itálico" (sem contexto de caption) → mantém.
    assert.equal(
      isItalicMissingFalsePositive("email:formatting: D3 título sem itálico E sem tamanho diferenciado").falsePositive,
      false,
    );
  });

  it("code-review: filterAgentIssues NÃO dropa subject_mismatch com {{...}} (never-FP #1645)", () => {
    const issues = [
      "email:subject_mismatch: subject é '{{subject}}' literal não expandido",
      "email:formatting: D1 título sem negrito", // FP → dropa
    ];
    const r = filterAgentIssues(issues, "<p>x</p>", "260608");
    assert.ok(r.kept.some((i) => /subject_mismatch/.test(i)), "subject_mismatch mantido apesar do {{...}}");
    assert.equal(r.kept.length, 1);
  });

  it("filterAgentIssues: dropa as 4 classes de FP do 260608, mantém bug real", () => {
    // Caso 260608 (#1949): ~6 issues, todos FP exceto um defeito real plantado.
    const issues = [
      "email:formatting: {{email}} não expandido = blocker crítico", // FP merge tag
      "email:link_dead: https://diaria.beehiiv.com/cursos → HTTP 403", // (403 já filtrado no link script, mas se vier)
      "email:formatting: D1 título sem negrito", // FP DS
      "email:formatting: caption não está em itálico", // FP DS
      "email:subject_mismatch: subject é placeholder 'New post'", // REAL — mantém
    ];
    const r = filterAgentIssues(issues, "<p>x</p>", "260608");
    assert.ok(r.kept.some((i) => /subject_mismatch/.test(i)), "bug real (subject) mantido");
    assert.ok(!r.kept.some((i) => /sem negrito|não está em itálico|\{\{/.test(i)), "FPs dropados");
  });
});

describe("filterAgentIssues — orchestrator integration (#1421)", () => {
  it("#1421/#1949: drop 2 encoding_drops + 1 itálico-FP, mantém 1 real", () => {
    const html = "<p>pré-treino e funcionários estão corretos</p>";
    const issues = [
      "email:encoding_drop: 'pré-treino' pode estar corrompido",  // falso-pos
      "email:encoding_drop: 'funcionários' pode estar corrompido",  // falso-pos
      "email:unexpected_content: Seção 'Liderança de Maio' presente",  // mantém (não validável)
      "email:formatting: caption não está em itálico",  // #1949: agora DROPADO (DS sans sem itálico)
    ];
    const r = filterAgentIssues(issues, html, "260520");
    assert.equal(r.kept.length, 1);
    assert.equal(r.dropped.length, 3);
    assert.match(r.kept[0], /unexpected_content/);
  });

  it("issues 100% validáveis → kept vazio, dropped completo", () => {
    const html = '<p>pré-treino</p><a href="?sig={{poll_sig}}&edition=260520">x</a>';
    const issues = [
      "email:encoding_drop: 'pré-treino' corrompido",
      "email:poll_sig_missing: stripped",
      "email:vote_edition_malformed: &edition& errado",
    ];
    const r = filterAgentIssues(issues, html, "260520");
    assert.equal(r.kept.length, 0);
    assert.equal(r.dropped.length, 3);
  });

  it("issues que não dá pra validar passam intactas (kind desconhecido)", () => {
    const issues = [
      "email:something_else: weird",
      "email:another_type: stuff",
    ];
    const r = filterAgentIssues(issues, "anything", "260520");
    assert.equal(r.kept.length, 2);
    assert.equal(r.dropped.length, 0);
  });

  it("input vazio → output vazio (no-op safe)", () => {
    const r = filterAgentIssues([], "anything", "260520");
    assert.deepEqual(r, { kept: [], dropped: [] });
  });
});
