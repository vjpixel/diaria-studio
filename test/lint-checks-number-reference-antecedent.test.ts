import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNumberReferenceAntecedent } from "../scripts/lib/lint-checks/number-reference-antecedent.ts";

// Trecho real do D3 da edição 261020 (02-reviewed.md), #11196.
const D3_261020 = `---

**DESTAQUE 3 | 💼 MERCADO**

**[Salário em tecnologia já beira os R$ 40 mil](https://tecnoblog.net/noticias/salarios-em-tecnologia-se-aproximam-dos-r-40-mil-veja-principais-cargos/)**

Uma em cada três empresas consultadas pela Michael Page aponta o domínio de ferramentas de IA como diferencial para contratar em tecnologia no próximo ano. O número está no Guia Salarial 2027 da consultoria de recrutamento, repercutido pelo Tecnoblog.

O mesmo guia registra salários na área que já se aproximam de R$ 40 mil e mostra a IA ganhando espaço no mercado de tecnologia. Os 33% mostram esse avanço de forma direta: saber usar essas ferramentas já pesa na escolha entre candidatos.

Por que isso importa:

A fluência em ferramentas de IA entra na conta do recrutador como critério de diferenciação.

---
`;

test("#11196: frase real da 261020 ('Os 33%' sem antecedente) é sinalizada", () => {
  const r = checkNumberReferenceAntecedent(D3_261020);
  assert.equal(r.ok, false);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].match, "Os 33%");
  assert.equal(r.warnings[0].line, 9);
});

test("#11196: reescrita do editor (Stack 26w43) passa", () => {
  const fixed = D3_261020.replace(
    "Os 33% mostram esse avanço de forma direta: saber usar essas ferramentas já pesa na escolha entre candidatos.",
    "Em uma de cada três empresas, saber usar essas ferramentas já pesa na escolha entre candidatos.",
  );
  assert.equal(checkNumberReferenceAntecedent(fixed).ok, true);
});

test("#11196: número dado antes no bloco é antecedente válido (inclui vírgula decimal e 'por cento')", () => {
  const cases = [
    "Uma em cada três empresas (33%) aponta a IA. Os 33% mostram o avanço.",
    "A taxa chegou a 12,5% em 2025. Esses 12,5% equivalem a um recorde.",
    "Cerca de 40 por cento dos usuários desistiram. Os 40% citam preço.",
    "**[33% das empresas já exigem IA](https://x.com/a)**\n\nOs 33% concentram-se no Sudeste.",
  ];
  for (const c of cases) assert.equal(checkNumberReferenceAntecedent(c).ok, true, c);
});

test("#11196: partitivo define o número no próprio sintagma, não é anáfora", () => {
  const cases = [
    "Os 10% dos domicílios mais ricos concentram metade da renda.",
    "Os 33% de empresas que exigem IA estão no Sudeste.",
    "Esses 5% das vagas pagam acima de R$ 40 mil.",
  ];
  for (const c of cases) assert.equal(checkNumberReferenceAntecedent(c).ok, true, c);
});

test("#11196: preposição 'a'/contrações não contam como determinante", () => {
  const cases = [
    "A participação chegou a 33% no trimestre.",
    "O índice subiu aos 33% depois da mudança.",
    "A alta dos 20% foi puxada por serviços.",
  ];
  for (const c of cases) assert.equal(checkNumberReferenceAntecedent(c).ok, true, c);
});

test("#11196: número só em outro bloco (separado por ---) não serve de antecedente", () => {
  const md = "O estudo mostra 33% de adoção.\n\n---\n\nOs 33% mostram o avanço.\n";
  const r = checkNumberReferenceAntecedent(md);
  assert.equal(r.ok, false);
  assert.equal(r.warnings[0].line, 5);
});

test("#11196: número só na URL do link não serve de antecedente", () => {
  const md = "**[Salários sobem](https://x.com/sobem-33%25-em-2027)**\n\nOs 33% mostram o avanço.";
  // '%25' na URL não casa como "33%", e o alvo do link é descartado de qualquer forma.
  assert.equal(checkNumberReferenceAntecedent(md).ok, false);
});

test("#11196: 'Esses N números' exige N números antes no bloco", () => {
  assert.equal(
    checkNumberReferenceAntecedent("A receita subiu 12% e o lucro, 8%. Esses dois números mostram fôlego.").ok,
    true,
  );
  const r = checkNumberReferenceAntecedent("A receita subiu muito e o lucro também. Esses dois números mostram fôlego.");
  assert.equal(r.ok, false);
  assert.match(r.warnings[0].reason, /2 números/);
  assert.equal(
    checkNumberReferenceAntecedent("O relatório traz 3 cifras: 10, 20 e 30. Estes 3 dados resumem o ano.").ok,
    true,
  );
});

test("#11196: número sem % após artigo não é sinalizado (introduz no próprio sintagma)", () => {
  const cases = ["Os 500 maiores bancos do país testam IA.", "As 3 empresas citadas negaram."];
  for (const c of cases) assert.equal(checkNumberReferenceAntecedent(c).ok, true, c);
});
