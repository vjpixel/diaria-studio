/**
 * test/monthly-template-apresentacao-2913.test.ts (#2913, regressão #633)
 *
 * O bloco APRESENTAÇÃO (preâmbulo "Esta é a newsletter mensal da Clarice, em
 * parceria com a diar.ia.br..." + CTA de prioridade + linha de descadastro) é
 * fixo, usado todo mês — mas faltou na edição real do ciclo 2606-07 porque
 * não morava no template (`context/templates/newsletter-monthly.md`) nem era
 * emitido automaticamente pelo `writer-monthly`. Foi reinserido manualmente
 * naquele ciclo.
 *
 * Este teste cobre a Frente 2 do fix (#633: "teste de que um draft gerado
 * inclui a seção" via o template canônico, já que a Frente 1 — instrução de
 * agent prompt lida por um LLM — não é testável automaticamente, igual ao
 * padrão já documentado em test/lint-monthly-draft.test.ts para #2794):
 *
 *   1. O template contém APRESENTAÇÃO na posição canônica (entre PREVIEW e
 *      INTRO), com os links CORRIGIDOS (#2937 já mergeou e mudou os URLs
 *      originais da issue #2913 — este teste usa os corrigidos):
 *        - "aqui" → https://diaria.beehiiv.com (NÃO diar.ia.br)
 *        - "diar.ia.br" em texto PLANO (nunca link markdown, pro wordmark
 *          automático de applyBrandWordmark funcionar)
 *        - Clarice → https://clarice.ai/?via=diaria
 *        - descadastro → merge tag {{ unsubscribe }}
 *        - "na Clarice" (não "em Clarice")
 *   2. O bloco extraído do template, passado pelo render real (`draftToEmail`),
 *      produz HTML com o wordmark da marca aplicado e o link correto pro
 *      Beehiiv — fechando o ciclo entre "o texto está certo" e "o render faz
 *      o que a gente espera com esse texto".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { draftToEmail } from "../scripts/lib/mensal/monthly-render.ts";

const TEMPLATE_PATH = join(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "..",
  "context",
  "templates",
  "newsletter-monthly.md",
);

function readTemplate(): string {
  return readFileSync(TEMPLATE_PATH, "utf8");
}

/** Extrai o bloco de código dentro do primeiro ``` ... ``` do template — o
 * formato exato que o writer-monthly deve reproduzir. */
function extractFormatBlock(template: string): string {
  const match = template.match(/```\n([\s\S]*?)\n```/);
  assert.ok(match, "template deveria ter um bloco de código ``` ... ```");
  return match![1];
}

describe("template mensal — bloco APRESENTAÇÃO (#2913)", () => {
  it("existe na posição canônica: entre PREVIEW e INTRO", () => {
    const block = extractFormatBlock(readTemplate());
    const previewIdx = block.indexOf("**PREVIEW**");
    const apresentacaoIdx = block.indexOf("**APRESENTAÇÃO**");
    const introIdx = block.indexOf("**INTRO**");

    assert.ok(previewIdx >= 0, "PREVIEW deveria estar presente");
    assert.ok(apresentacaoIdx >= 0, "APRESENTAÇÃO deveria estar presente");
    assert.ok(introIdx >= 0, "INTRO deveria estar presente");
    assert.ok(
      previewIdx < apresentacaoIdx && apresentacaoIdx < introIdx,
      `ordem esperada PREVIEW < APRESENTAÇÃO < INTRO, recebido: PREVIEW=${previewIdx} APRESENTAÇÃO=${apresentacaoIdx} INTRO=${introIdx}`,
    );
  });

  it("link 'aqui' aponta pro Beehiiv (https://diaria.beehiiv.com), NÃO diar.ia.br", () => {
    const block = extractFormatBlock(readTemplate());
    assert.match(block, /\[aqui\]\(https:\/\/diaria\.beehiiv\.com\)/);
    assert.doesNotMatch(block, /\[aqui\]\(https?:\/\/diar\.ia\.br[^)]*\)/);
  });

  it("'diar.ia.br' aparece em texto PLANO (nunca como link markdown)", () => {
    const block = extractFormatBlock(readTemplate());
    const apresentacaoSection = block.slice(
      block.indexOf("**APRESENTAÇÃO**"),
      block.indexOf("**INTRO**"),
    );
    assert.match(apresentacaoSection, /parceria com a diar\.ia\.br:/);
    // nunca "[diar.ia.br](...)" — isso quebraria o wordmark automático
    assert.doesNotMatch(apresentacaoSection, /\[diar\.ia\.br\]\(/);
  });

  it("link da Clarice aponta pra clarice.ai/?via=diaria (2 ocorrências)", () => {
    const block = extractFormatBlock(readTemplate());
    const matches = block.match(/\[Clarice\]\(https:\/\/clarice\.ai\/\?via=diaria\)/g) ?? [];
    assert.ok(matches.length >= 2, `esperava >=2 ocorrências do link Clarice, achou ${matches.length}`);
  });

  it("descadastro usa a merge tag literal {{ unsubscribe }}", () => {
    const block = extractFormatBlock(readTemplate());
    assert.match(block, /\[descadastrar aqui\]\(\{\{ unsubscribe \}\}\)/);
  });

  it("usa 'na Clarice' (gramaticalmente correto), não 'em Clarice'", () => {
    const block = extractFormatBlock(readTemplate());
    assert.match(block, /se cadastrou na \[Clarice\]/);
    assert.doesNotMatch(block, /se cadastrou em \[Clarice\]/);
  });

  it("renderiza via draftToEmail com o wordmark da marca + link pro Beehiiv aplicados", () => {
    const template = readTemplate();
    const block = extractFormatBlock(template);
    const apresentacaoSection = block
      .slice(block.indexOf("**APRESENTAÇÃO**"), block.indexOf("**INTRO**"))
      .trim();

    // Draft mínimo: só o bloco APRESENTAÇÃO como seção (suficiente pra exercitar
    // o render dessa seção isoladamente, sem depender dos destaques do mês).
    const draft = [apresentacaoSection].join("\n");

    const { html } = draftToEmail(draft, "Assunto de teste", "2606");

    // O wordmark estiliza "diar.ia.br" com pontos teal (applyBrandWordmark) —
    // ver test/monthly-branding-2937.test.ts para o formato exato do span.
    assert.match(html, /diar<span[^>]*>\.<\/span>ia<span[^>]*>\.br<\/span>/);
    // E, na mensal, o wordmark vira link pro Beehiiv (MENSAL_BRAND_LINK, #2937),
    // carregando o UTM de atribuição Clarice→Beehiiv (#2975 — sem isso, o
    // Beehiiv taggeia esses assinantes como "sendinblue" e a migração fica
    // invisível na atribuição). Ver test/monthly-utm-clarice-2975.test.ts.
    assert.match(html, /<a href="https:\/\/diaria\.beehiiv\.com\/\?utm_source=clarice[^"]*utm_campaign=clarice-2606-07"[^>]*>/);
    // O CTA "aqui" segue como link normal pro mesmo destino, também com UTM.
    assert.match(html, /<a href="https:\/\/diaria\.beehiiv\.com\/\?utm_source=clarice[^"]*utm_campaign=clarice-2606-07"[^>]*>aqui<\/a>/);
    assert.doesNotMatch(html, /sendinblue/);
  });
});
