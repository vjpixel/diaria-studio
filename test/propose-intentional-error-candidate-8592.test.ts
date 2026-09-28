/**
 * test/propose-intentional-error-candidate-8592.test.ts (#8592)
 *
 * `proposeIntentionalErrorCandidate` (scripts/lib/propose-intentional-error-candidate.ts)
 * é o gerador determinístico do candidato "aceitável em 1 clique" que o
 * Stage 4 deve propor PROATIVAMENTE quando monta o gate e
 * `_internal/intentional-error.json` ainda tem campos `{PREENCHER}`.
 *
 * Escopo (comentário do editor na issue, 21/09/2026): SÓ gerar a proposta —
 * nunca gravar/plantar nada em disco. Este módulo é puro: recebe o texto de
 * `02-reviewed.md` e devolve um candidato (ou `null`), nunca toca no disco.
 *
 * Filtro de segurança aplicado (#3808 + #5742, `context/editorial-rules.md`
 * §10):
 *   1. Nunca no fato central de um DESTAQUE — o gerador só procura em seções
 *      secundárias (RADAR/USE MELHOR/LANÇAMENTOS/VÍDEOS/É IA?), nunca em
 *      blocos `DESTAQUE N`.
 *   2. Erro cômico/leve — catálogo de grafias erradas óbvias em nomes de
 *      entidades de IA muito conhecidas (padrão #5742: "Craude", "Anthropik",
 *      "Hugging Race").
 *   3. Categoria sempre `ortografico` (segura por design, `checkIntentionalErrorSafety`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { proposeIntentionalErrorCandidate } from "../scripts/lib/propose-intentional-error-candidate.ts";
import { checkIntentionalErrorSafety } from "../scripts/lib/lint-checks/intentional-error.ts";

describe("#8592: proposeIntentionalErrorCandidate", () => {
  it("nenhuma entidade conhecida em nenhuma seção secundária → null", () => {
    const md = `
**DESTAQUE 1 | 🚀 LANÇAMENTO**
[Uma empresa qualquer lança algo](https://example.com/a)
Descrição qualquer sem nenhuma marca conhecida.

**RADAR**
[Outra notícia qualquer](https://example.com/b)
Descrição sem nenhuma marca conhecida do catálogo.
`;
    assert.equal(proposeIntentionalErrorCandidate(md), null);
  });

  it("entidade conhecida SÓ dentro de um bloco DESTAQUE → null (Regra 3, nunca no fato central de um destaque)", () => {
    const md = `
**DESTAQUE 1 | 🚀 LANÇAMENTO**
[A Anthropic lança um novo modelo](https://example.com/a)
A Anthropic anunciou o Claude 5 hoje.

**RADAR**
[Outra notícia qualquer](https://example.com/b)
Descrição sem nenhuma marca conhecida do catálogo.
`;
    assert.equal(proposeIntentionalErrorCandidate(md), null);
  });

  it("entidade conhecida em RADAR (menção lateral) → candidato completo com os 5 campos, categoria ortografico", () => {
    const md = `
**DESTAQUE 1 | 🚀 LANÇAMENTO**
[Uma empresa qualquer lança algo](https://example.com/a)
Descrição qualquer sem nenhuma marca conhecida.

**RADAR**
[Um pesquisador comentou sobre o Claude](https://example.com/b)
Ele usou o Claude, da Anthropic, para escrever o artigo.
`;
    const candidate = proposeIntentionalErrorCandidate(md);
    assert.ok(candidate, "esperava candidato");
    assert.equal(candidate!.category, "ortografico");
    assert.match(candidate!.location, /RADAR/);
    assert.equal(typeof candidate!.description, "string");
    assert.ok(candidate!.description.length > 0);
    assert.equal(typeof candidate!.reveal, "string");
    assert.match(candidate!.reveal, new RegExp(candidate!.wrong_value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(candidate!.reveal, new RegExp(candidate!.correct_value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // Filtro de segurança #2149/#5742: categoria segura por design.
    const safety = checkIntentionalErrorSafety(candidate!.category);
    assert.equal(safety.safe, true);
  });

  it("entidade conhecida em USE MELHOR também é candidata válida", () => {
    const md = `
**USE MELHOR**
[Como usar o Hugging Face para achar modelos](https://example.com/c)
Tutorial rápido sobre o Hugging Face.
`;
    const candidate = proposeIntentionalErrorCandidate(md);
    assert.ok(candidate);
    assert.match(candidate!.location, /USE MELHOR/);
    assert.equal(candidate!.correct_value, "Hugging Face");
  });

  it("múltiplas entidades presentes → escolhe a primeira em ordem de documento (determinístico)", () => {
    const md = `
**RADAR**
[Notícia sobre o Gemini](https://example.com/d)
O Gemini, do Google, foi atualizado.

**USE MELHOR**
[Tutorial de Claude](https://example.com/e)
Um tutorial usando Claude.
`;
    const candidate = proposeIntentionalErrorCandidate(md);
    assert.ok(candidate);
    assert.equal(candidate!.correct_value, "Gemini");
    assert.match(candidate!.location, /RADAR/);
  });

  it("wrong_value nunca é igual a correct_value (é sempre uma grafia diferente)", () => {
    const md = `
**RADAR**
[Notícia sobre a Anthropic](https://example.com/f)
A Anthropic comentou sobre o assunto.
`;
    const candidate = proposeIntentionalErrorCandidate(md);
    assert.ok(candidate);
    assert.notEqual(candidate!.wrong_value, candidate!.correct_value);
  });
});
