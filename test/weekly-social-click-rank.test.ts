/**
 * weekly-social-click-rank.test.ts (#4511 fleet review MÉDIO — pr-test-analyzer)
 *
 * Cobre o núcleo de ranking/desempate compartilhado por
 * `weekly-linkedin-select.ts` e `weekly-instagram-select.ts`
 * (`scripts/lib/weekly-social-click-rank.ts`, extraído da duplicação
 * byte-a-byte entre os 2 pelo #4511), com foco nos 2 gaps de cobertura
 * apontados pelo fleet review da PR #4511:
 *
 *   1. `editorialTiebreakScore` (Brasil +100 > profissional +50 > diversidade
 *      +10) só tinha o critério ÂNGULO BRASIL exercitado isoladamente —
 *      faltava (a) um caso onde só IMPLICAÇÃO PROFISSIONAL distingue 2
 *      candidatos, e (b) um caso onde o termo de DIVERSIDADE (+10)
 *      participa do desempate (só acontece quando `alreadySelectedCategories`
 *      não está vazio — nenhum teste anterior testava uma "2ª rodada" de
 *      seleção onde uma categoria já tinha sido escolhida).
 *   2. `withinClickNoise` só tinha testes com `opens` IDÊNTICOS nos dois
 *      candidatos — o branch `Math.max(100/a.opens, 100/b.opens)` (que pega
 *      o INCREMENTO MAIOR entre denominadores DIFERENTES) era código morto
 *      pra fins de teste.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  withinClickNoise,
  hasBrazilAngle,
  hasProfessionalImplication,
  editorialTiebreakScore,
  byRateDescThenTitle,
  isCommercialOrOwnLink,
  hasSuspiciousCommercialLanguage,
  type ClickRankedCandidate,
} from "../scripts/lib/weekly-social-click-rank.ts";

function candidate(
  overrides: Partial<ClickRankedCandidate> & Pick<ClickRankedCandidate, "title">,
): ClickRankedCandidate {
  return {
    url: "https://exemplo.com/materia",
    body: "",
    why: "",
    category: "NOTÍCIAS",
    ratePct: 0,
    opens: 100,
    hasClickData: true,
    ...overrides,
  };
}

describe("editorialTiebreakScore — critérios isolados (#4511)", () => {
  it("quando nenhum candidato tem ângulo Brasil, implicação profissional decide sozinha o desempate", () => {
    const withJob = candidate({ title: "Vaga de emprego em startup de IA cresce no setor", category: "MERCADO" });
    const withoutJob = candidate({ title: "Ferramenta de IA generativa é lançada globalmente", category: "MERCADO" });
    assert.equal(hasBrazilAngle(withJob), false, "assunção do teste: sem ângulo Brasil");
    assert.equal(hasBrazilAngle(withoutJob), false, "assunção do teste: sem ângulo Brasil");
    assert.equal(hasProfessionalImplication(withJob), true);
    assert.equal(hasProfessionalImplication(withoutJob), false);

    const selectedCategories = new Set<string>();
    const scoreWithJob = editorialTiebreakScore(withJob, selectedCategories);
    const scoreWithoutJob = editorialTiebreakScore(withoutJob, selectedCategories);
    assert.ok(scoreWithJob > scoreWithoutJob, "implicação profissional deveria decidir sozinha o desempate");
  });

  it("termo de diversidade (+10) participa do desempate quando a categoria já foi selecionada numa rodada anterior", () => {
    // Simula uma 2ª rodada de seleção: candidato de categoria JÁ escolhida na
    // 1ª rodada vs. candidato de categoria NOVA — nenhum tem ângulo Brasil
    // nem implicação profissional, então só a diversidade decide.
    const sameCategoryAsRound1 = candidate({ title: "Segunda matéria de mercado", category: "MERCADO" });
    const newCategory = candidate({ title: "Matéria de uma categoria nova", category: "SAÚDE" });
    assert.equal(hasBrazilAngle(sameCategoryAsRound1), false);
    assert.equal(hasBrazilAngle(newCategory), false);
    assert.equal(hasProfessionalImplication(sameCategoryAsRound1), false);
    assert.equal(hasProfessionalImplication(newCategory), false);

    const alreadySelectedCategories = new Set<string>(["MERCADO"]); // 1ª rodada já escolheu MERCADO
    const scoreSameCategory = editorialTiebreakScore(sameCategoryAsRound1, alreadySelectedCategories);
    const scoreNewCategory = editorialTiebreakScore(newCategory, alreadySelectedCategories);
    assert.equal(scoreSameCategory, 0, "categoria já selecionada não ganha o bônus de diversidade");
    assert.equal(scoreNewCategory, 10, "categoria nova ganha o bônus de diversidade");
    assert.ok(scoreNewCategory > scoreSameCategory, "diversidade deveria decidir o desempate da 2ª rodada");
  });

  it("ordem lexicográfica se mantém: ângulo Brasil sozinho supera profissional+diversidade combinados", () => {
    const brazilOnly = candidate({ title: "Notícia sobre o Brasil", category: "MERCADO" });
    const professionalPlusDiversity = candidate({ title: "Vaga de emprego nova", category: "SAÚDE" });
    const alreadySelected = new Set<string>(["MERCADO"]);
    // brazilOnly: 100 (Brasil) + 0 (sem profissional) + 0 (categoria já selecionada) = 100
    // professionalPlusDiversity: 0 (sem Brasil) + 50 (profissional) + 10 (categoria nova) = 60
    assert.equal(editorialTiebreakScore(brazilOnly, alreadySelected), 100);
    assert.equal(editorialTiebreakScore(professionalPlusDiversity, alreadySelected), 60);
  });
});

describe("withinClickNoise — opens DIFERENTES entre os 2 candidatos (#4511)", () => {
  it("usa a banda de ruído mais generosa (calculada a partir do MENOR opens — maior incremento-de-1-clique)", () => {
    // a: opens=100 → 1 clique = 1pp. b: opens=500 → 1 clique = 0.2pp.
    // Math.max(1, 0.2) = 1pp — a banda usada é a do MENOR opens (mais generosa).
    const a = candidate({ title: "A", opens: 100, ratePct: 3.0 });
    const b = candidate({ title: "B", opens: 500, ratePct: 3.8 });
    // diferença = 0.8pp: dentro de 1pp (banda do menor opens), mas FORA de
    // 0.2pp (banda do maior opens) — só passa se a implementação usar o maior incremento.
    assert.ok(Math.abs(a.ratePct - b.ratePct) > 100 / b.opens, "assunção: 0.8pp > 0.2pp (banda do maior opens, não usada)");
    assert.equal(withinClickNoise(a, b), true, "diferença de 0.8pp deveria estar dentro da banda de 1pp (do menor opens)");

    const c = candidate({ title: "C", opens: 100, ratePct: 3.0 });
    const d = candidate({ title: "D", opens: 500, ratePct: 4.2 });
    // diferença = 1.2pp > 1pp (banda do menor opens) → fora do ruído nos dois cálculos possíveis.
    assert.equal(withinClickNoise(c, d), false, "diferença de 1.2pp deveria estar FORA da banda de 1pp");
  });
});

describe("byRateDescThenTitle / isCommercialOrOwnLink / hasSuspiciousCommercialLanguage — sanidade do módulo compartilhado", () => {
  it("byRateDescThenTitle ordena por taxa desc, desempate por título", () => {
    const list: ClickRankedCandidate[] = [
      candidate({ title: "B", ratePct: 5 }),
      candidate({ title: "A", ratePct: 5 }),
      candidate({ title: "C", ratePct: 8 }),
    ];
    const sorted = [...list].sort(byRateDescThenTitle);
    assert.deepEqual(sorted.map((c) => c.title), ["C", "A", "B"]);
  });

  it("isCommercialOrOwnLink/hasSuspiciousCommercialLanguage seguem exportadas e funcionais no módulo compartilhado", () => {
    assert.equal(isCommercialOrOwnLink("https://apoia.se/diaria"), true);
    assert.equal(isCommercialOrOwnLink("https://exemplo.com/materia"), false);
    assert.equal(hasSuspiciousCommercialLanguage("Cupom especial em parceria"), true);
    assert.equal(hasSuspiciousCommercialLanguage("Matéria editorial normal"), false);
  });
});
