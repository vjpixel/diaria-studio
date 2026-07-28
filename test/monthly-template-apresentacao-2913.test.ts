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
 *      INTRO), com os links CORRIGIDOS (#3971 unificou o href pro canônico
 *      diar.ia.br pós-fix do redirect Cloudflare, #2613 — supera a decisão
 *      anterior do #2937/#2913 que mandava pro Beehiiv por causa do bug de
 *      query string, já corrigido):
 *        - "aqui" → https://diar.ia.br/?utm_source=clarice (href canônico,
 *          com UTM de atribuição — NÃO mais diaria.beehiiv.com)
 *        - "diar.ia.br" em texto PLANO (nunca link markdown, pro wordmark
 *          automático de applyBrandWordmark funcionar)
 *        - Clarice → https://clarice.ai/?via=diaria
 *        - descadastro → merge tag {{ unsubscribe }}
 *        - "na Clarice" (não "em Clarice")
 *   2. O bloco extraído do template, passado pelo render real (`draftToEmail`),
 *      produz HTML com o wordmark da marca aplicado (desde 260727 o wordmark
 *      é só estilo, NÃO é mais link — não convertia e somava densidade
 *      promocional) e o link "aqui" apontando direto pro href canônico
 *      diar.ia.br com UTM — fechando o ciclo entre "o texto está certo" e "o
 *      render faz o que a gente espera com esse texto".
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

  it("link 'aqui' aponta pro href canônico diar.ia.br com utm_source=clarice (#3971)", () => {
    const block = extractFormatBlock(readTemplate());
    assert.match(block, /\[aqui\]\(https:\/\/diar\.ia\.br\/\?utm_source=clarice\)/);
    assert.doesNotMatch(block, /\[aqui\]\(https?:\/\/diaria\.beehiiv\.com[^)]*\)/);
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

  it("renderiza via draftToEmail com o wordmark da marca SEM link + o CTA 'aqui'", () => {
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
    // O wordmark NÃO é link (decisão do editor 260727, revertendo o
    // #template-branding de 260703). Ele aparecia 4× por edição, todas
    // apontando pra raiz do site, e o editor conferiu que não convertem —
    // somadas ao "aqui" (2×) e ao botão davam 7 âncoras pro mesmo destino, só
    // densidade promocional no eixo que o CTA-01 apontou como gatilho de spam.
    // A diária nunca linkou; agora as duas superfícies se comportam igual.
    assert.doesNotMatch(html, /utm_campaign=clarice-2606-07-wordmark/);
    // O CTA "aqui" (#3971) aponta pro mesmo host canônico e, desde o #4040,
    // também é normalizado com a posição `inline`.
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\/\?utm_source=clarice[^"]*utm_campaign=clarice-2606-07-inline"[^>]*>aqui<\/a>/);
    assert.doesNotMatch(html, /sendinblue/);
  });
});
