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

describe("filterAgentIssues — orchestrator integration (#1421)", () => {
  it("#1421: caso 260520 — drop 2 encoding_drops falso-positivos, mantém 2 reais", () => {
    const html = "<p>pré-treino e funcionários estão corretos</p>";
    const issues = [
      "email:encoding_drop: 'pré-treino' pode estar corrompido",  // falso-pos
      "email:encoding_drop: 'funcionários' pode estar corrompido",  // falso-pos
      "email:unexpected_content: Seção 'Liderança de Maio' presente",  // mantém (não validável)
      "email:formatting: caption não está em itálico",  // mantém
    ];
    const r = filterAgentIssues(issues, html, "260520");
    assert.equal(r.kept.length, 2);
    assert.equal(r.dropped.length, 2);
    assert.match(r.kept[0], /unexpected_content/);
    assert.match(r.kept[1], /formatting/);
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
