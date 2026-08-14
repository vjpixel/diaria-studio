/**
 * brevo-diaria-intro.ts (#4266 item 5)
 *
 * Bloco de abertura OBRIGATÓRIO pro segmento Pending (canal Brevo próprio do
 * editor) — decisão do editor (comentário 260730 da issue #4266): o
 * recebimento do e-mail é o opt-in desse grupo, mas isso só é honesto se o
 * topo do e-mail explicar por que a pessoa está recebendo (ela NÃO é
 * assinante confirmada — só se inscreveu e nunca completou o double opt-in).
 *
 * NÃO usa mais a caixa/cartão bege dos boxes de divulgação normais (achado
 * 260803, pedido do editor no 1º rascunho real: "tira o texto dessa caixa").
 * Composição manual a partir de peças já existentes em
 * `newsletter-render-html.ts`: `renderCoverage` (parágrafo de corpo, mesmo
 * estilo tipográfico da antiga saudação "Olá! Eu sou o Pixel...", sem fundo)
 * → `renderBarePillButton` (botão pill solto, sem caixa ao redor) →
 * `renderCoverageTrailer` (parágrafo de disclosure/descadastro, mesmo estilo
 * sem fundo). O texto vem de `data/snippets/brevo-diaria-pending-intro.md`
 * (#5227, migrado de `context/snippets/`),
 * mesma convenção de todo bloco em `data/snippets/` (comentário HTML de
 * header + corpo, lido via `readSnippetFile`) — formato: N parágrafos de
 * corpo, 1 parágrafo CTA isolado (`→ [texto](url)`, detectado via
 * `isCtaOnlyParagraph`), N parágrafos de disclosure. Sem `shouldForceCtaPill`/
 * `renderBoxDivulgacao` — aquele caminho sempre envolve tudo (texto + botão)
 * numa `<table>` com fundo, que é exatamente o que não queremos aqui.
 *
 * O CONTEÚDO desse snippet ainda é RASCUNHO (ver o próprio arquivo) — o
 * editor precisa aprovar a cópia final antes do primeiro envio real. Este
 * módulo não bloqueia a leitura/render (útil pra testar o mecanismo), mas
 * `scripts/publish-daily-brevo.ts` recusa enviar (fora de `--dry-run`) sem a
 * flag explícita `--i-reviewed-the-copy` justamente por causa disso.
 */

import { readSnippetFile } from "./shared/snippet-loader.ts";
import {
  renderCoverage,
  renderCoverageTrailer,
  renderBarePillButton,
  isCtaOnlyParagraph,
  findMarkdownLinks,
  PAGE_BG,
} from "./newsletter-render-html.ts";
import { LAYOUT } from "./shared/design-tokens.ts"; // #5176: container width em paridade com o real

export const PENDING_INTRO_SNIPPET_FILENAME = "brevo-diaria-pending-intro.md";

/**
 * Lê + renderiza o bloco de intro. `null` se o snippet não existir/estiver
 * vazio — caller (`publish-daily-brevo.ts`) trata isso como bloqueio (o
 * envio pro segmento Pending NUNCA pode sair sem esta explicação). Lança se
 * o snippet existir mas não tiver um parágrafo CTA isolado reconhecível —
 * mais seguro que publicar sem botão de cadastro.
 */
export function renderPendingIntroHtml(): string | null {
  const box = readSnippetFile(PENDING_INTRO_SNIPPET_FILENAME);
  if (!box) return null;

  const paras = box.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const ctaIdx = paras.findIndex(isCtaOnlyParagraph);
  if (ctaIdx === -1) {
    throw new Error(
      `renderPendingIntroHtml: ${PENDING_INTRO_SNIPPET_FILENAME} não tem parágrafo CTA isolado (→ [texto](url)) — bloco sem botão de cadastro é inseguro pro segmento Pending.`,
    );
  }
  const links = findMarkdownLinks(paras[ctaIdx]);
  const cta = links[0]; // isCtaOnlyParagraph já garante >= 1 link

  const bodyParas = paras.slice(0, ctaIdx);
  const disclosureParas = paras.slice(ctaIdx + 1);

  const parts: string[] = [];
  if (bodyParas.length > 0) parts.push(renderCoverage(bodyParas.join("\n\n")));
  parts.push(renderBarePillButton(cta.url, cta.label));
  if (disclosureParas.length > 0) parts.push(renderCoverageTrailer(disclosureParas.join("\n\n")));

  // #4266/achado 260803 (2ª rodada): as peças acima retornam `<tr><td>` SEM
  // `<table>` próprio (mesma convenção de `renderCoverage`/`renderCoverageTrailer`,
  // pensada pra colar direto no meio do `container` de `renderHTML`). Mas
  // `injectPendingIntro` insere ANTES do `<table class="ds-canvas">` que
  // `renderHTML(fullDocument:true)` abre — ou seja, fora do container
  // (LAYOUT.containerWidth), na zona "canvas externo" que `darkCanvasMediaRule` (#2645/#3104,
  // `newsletter-styles.ts`) escurece de propósito em dark mode (`body,
  // .ds-canvas { background:${PAGE_BG} → ink }`). Duas quebras distintas
  // aconteceram em sequência ao tirar a caixa:
  //   1ª (`<tr>` órfão, sem tabela própria) — texto sumia, botão flutuava
  //      sobre o masthead. Corrigido envolvendo numa `<table>` própria.
  //   2ª (só descoberta DEPOIS da 1ª correção, testando o rascunho real): a
  //      `<table>` própria não tinha fundo explícito — em dark mode ela
  //      herdava o fundo escuro do `body` (zona que É PRA escurecer), e o
  //      texto (cor ink fixa, igual em claro/escuro por design — ver escopo
  //      de `buildDarkCanvasStyleBlock`) ficava ink-sobre-ink, invisível. O
  //      box antigo nunca teve esse problema por acidente: seu cartão bege
  //      tinha fundo PRÓPRIO opaco, isolado do fundo do body de qualquer jeito.
  // Fundo explícito PAGE_BG (branco, o mesmo do container real) resolve as
  // duas sem reintroduzir cartão visível — mesma cor do que já está ao redor,
  // não lê como caixa, só protege o texto do dark-mode do canvas externo.
  //
  // 3ª quebra (achado 260803, pós-envio agendado): `width="100%"` sem teto
  // vira 100% do CLIENTE DE E-MAIL inteiro (não do container real)
  // porque esta `<table>` está fora do `.ds-canvas`, na mesma zona "canvas
  // externo" da nota acima — o container de verdade só fica estreito porque
  // tem `class="container"` + `max-width` (LAYOUT.containerWidth, ver
  // newsletter-render-html.ts, `innerTable`). Linha ficava larga demais em
  // clientes desktop largos. `class="container"` (reusa a mesma media query
  // mobile já existente, `.container { width:100% !important; }`) +
  // `max-width` + `align`/
  // `margin:0 auto` (padrão email-safe: atributo pros clientes antigos,
  // margin pros modernos) alinha esta tabela ao mesmo teto/centralização do
  // container real, sem depender de mover o ponto de inserção.
  //
  // 4ª quebra (review PR #4522): Outlook desktop IGNORA `max-width` e honra
  // só o atributo `width` — que aqui é `"100%"` — então SEM o wrapper MSO
  // abaixo, esta tabela reproduziria em Outlook exatamente a mesma quebra de
  // largura que a nota #3 corrigiu pros outros clientes. Mesmo padrão
  // exato do `container`/`innerTable` em newsletter-render-html.ts (#260629b):
  // conditional comment embrulha numa tabela FIXA de LAYOUT.containerWidth
  // só no Outlook; clientes modernos ignoram o comentário e usam a tabela
  // `width:100%`/`max-width`.
  return (
    `<!-- #4266 intro Pending Brevo (achado 260803: fora de caixa) -->\n` +
    `<!--[if mso]><table role="presentation" align="center" width="${LAYOUT.containerWidth}" cellpadding="0" cellspacing="0"><tr><td width="${LAYOUT.containerWidth}"><![endif]-->\n` +
    `<table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" align="center" style="width:100%;max-width:${LAYOUT.containerWidth}px;margin:0 auto;background:${PAGE_BG};">\n` +
    parts.join("\n") +
    `\n</table>\n` +
    `<!--[if mso]></td></tr></table><![endif]-->`
  );
}

/**
 * Pura — insere o HTML da intro logo após a abertura de `<body ...>` do
 * documento completo (`renderHTML(content, { fullDocument: true, ... })`
 * sempre emite exatamente uma tag `<body`). Lança se não encontrar a tag —
 * mais seguro que inserir silenciosamente no lugar errado (ou não inserir
 * nada) num HTML que não tem a forma esperada.
 */
export function injectPendingIntro(fullDocumentHtml: string, introHtml: string): string {
  const bodyOpenIdx = fullDocumentHtml.indexOf("<body");
  if (bodyOpenIdx === -1) {
    throw new Error("injectPendingIntro: HTML de entrada não tem tag <body> — esperado fullDocument:true.");
  }
  const closeIdx = fullDocumentHtml.indexOf(">", bodyOpenIdx);
  if (closeIdx === -1) {
    throw new Error("injectPendingIntro: tag <body> malformada (sem '>' de fechamento).");
  }
  const insertAt = closeIdx + 1;
  return fullDocumentHtml.slice(0, insertAt) + introHtml + fullDocumentHtml.slice(insertAt);
}
