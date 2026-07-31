/**
 * brevo-diaria-intro.ts (#4266 item 5)
 *
 * Bloco de abertura OBRIGATÓRIO pro segmento Pending (canal Brevo próprio do
 * editor) — decisão do editor (comentário 260730 da issue #4266): o
 * recebimento do e-mail é o opt-in desse grupo, mas isso só é honesto se o
 * topo do e-mail explicar por que a pessoa está recebendo (ela NÃO é
 * assinante confirmada — só se inscreveu e nunca completou o double opt-in).
 *
 * Reusa a MESMA convenção de formato/render dos boxes de divulgação normais
 * (`renderBoxDivulgacao`, `scripts/lib/newsletter-render-html.ts` —
 * título sem marcador + 1 parágrafo + CTA isolado `→ [texto](url)` que
 * `shouldForceCtaPill` transforma em botão pill) — não reimplementa nenhum
 * HTML novo. O texto vem de `context/snippets/brevo-diaria-pending-intro.md`,
 * mesma convenção de todo bloco em `context/snippets/` (comentário HTML de
 * header + corpo, lido via `readSnippetFile`).
 *
 * O CONTEÚDO desse snippet ainda é RASCUNHO (ver o próprio arquivo) — o
 * editor precisa aprovar a cópia final antes do primeiro envio real. Este
 * módulo não bloqueia a leitura/render (útil pra testar o mecanismo), mas
 * `scripts/publish-daily-brevo.ts` recusa enviar (fora de `--dry-run`) sem a
 * flag explícita `--i-reviewed-the-copy` justamente por causa disso.
 */

import { readSnippetFile } from "./shared/snippet-loader.ts";
import { renderBoxDivulgacao } from "./newsletter-render-html.ts";

export const PENDING_INTRO_SNIPPET_FILENAME = "brevo-diaria-pending-intro.md";

/**
 * Lê + renderiza o bloco de intro. `null` se o snippet não existir/estiver
 * vazio — caller (`publish-daily-brevo.ts`) trata isso como bloqueio (o
 * envio pro segmento Pending NUNCA pode sair sem esta explicação).
 */
export function renderPendingIntroHtml(): string | null {
  const box = readSnippetFile(PENDING_INTRO_SNIPPET_FILENAME);
  if (!box) return null;
  return renderBoxDivulgacao(box, null, false);
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
