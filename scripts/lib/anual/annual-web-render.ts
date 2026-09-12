/**
 * annual-web-render.ts (#8039)
 *
 * `AnnualDraft` → página WEB da edição anual (`retrospectiva.diar.ia.br/…`),
 * no design system do site — não no layout de e-mail. Puro, sem I/O.
 *
 * Até o #8039 a página pública era o próprio HTML do e-mail
 * (`renderAnnualEmail`): tabelas de layout, fundo branco, container de 656px
 * e nenhum `<title>`. No navegador isso lê como "um e-mail aberto no site", e
 * não como uma página da diar.ia.br. O e-mail do Kit continua saindo de
 * `annual-render.ts`, intocado; este módulo é só a superfície web.
 *
 * Mesmo sistema das outras páginas públicas (curadoria, arquivo, especial):
 * tokens de `design-tokens.ts`, fundo papel, Georgia nos títulos, sans no
 * corpo, teal só na régua do cabeçalho e nos pontos da marca, e o rodapé de
 * navegação cruzada comum (`renderCuradoriaFooter`).
 *
 * Contrato com o Worker `retrospectiva` (não mudou): o TRECHO recebe o bloco
 * de cadastro injetado antes do ÚLTIMO `</body>` (`renderTeaserWithSignup`) e
 * as metas de SEO antes do último `</head>` (`injectRetrospectivaHeadMeta`) —
 * por isso o documento é completo e o trecho sai SEM rodapé: o convite de
 * cadastro fecha a página, em vez de aparecer depois do rodapé.
 */

import { COLORS, FONTS } from "../shared/design-tokens.ts";
import { applyBrandWordmark } from "../shared/brand-wordmark.ts";
import {
  renderCuradoriaFooter,
  renderCuradoriaFooterStyles,
  renderCuradoriaRootStyles,
} from "../shared/curadoria-page.ts";
import type { AnnualDraft, AnnualTheme } from "./annual-parse.ts";
import type { AnnualRenderOptions, AnnualRenderResult } from "./annual-render.ts";

export interface AnnualWebRenderOptions extends AnnualRenderOptions {
  /**
   * `teaser` omite o rodapé: o Worker injeta o convite de cadastro antes do
   * último `</body>`, e ele precisa ser o fim da página.
   */
  variant?: "full" | "teaser";
}

const FALLBACK_TITLE = "Retrospectiva diar.ia.br";

/** Escapa texto para HTML, incluindo aspas (o valor também vai em atributos). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Markdown inline → HTML: links ancorados e negrito, depois o wordmark da
 * marca (sempre DEPOIS do escape — `applyBrandWordmark` não toca URLs).
 * Sem estilo inline: a cor dos links vem do CSS da página.
 */
function inline(text: string): string {
  const html = escapeHtml(text)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_m, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return applyBrandWordmark(html);
}

/** Texto puro (sem markdown) — para `<title>` e `alt`. */
function plain(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").trim();
}

function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^-{3,}$/.test(p))
    .map((p) => `<p>${inline(p)}</p>`)
    .join("\n");
}

function renderTheme(theme: AnnualTheme, imageUrl: string | undefined): string {
  const parts = [`<section class="theme" id="tema-${theme.index}">`];
  if (theme.name) parts.push(`<p class="kicker">${escapeHtml(theme.name)}</p>`);
  parts.push(`<h2>${inline(theme.title)}</h2>`);
  if (imageUrl) {
    parts.push(
      `<figure><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(plain(theme.title))}" loading="lazy" /></figure>`,
    );
  }
  parts.push(theme.paragraphs.map((p) => `<p>${inline(p)}</p>`).join("\n"));
  if (theme.fioCondutor) {
    parts.push(`<aside class="fio"><p class="kicker">O fio condutor</p>${paragraphs(theme.fioCondutor)}</aside>`);
  }
  parts.push("</section>");
  return parts.join("\n");
}

function renderProse(title: string | null, text: string): string {
  if (!text) return "";
  return `<section class="prose">${title ? `<h2>${inline(title)}</h2>` : ""}\n${paragraphs(text)}\n</section>`;
}

function styles(): string {
  return `<style>
${renderCuradoriaRootStyles()}
  .wrap { max-width: 720px; }
  .site-top { padding: 28px 0 0; font-family: ${FONTS.serif}; font-size: 20px; }
  .site-top a { text-decoration: none; }
  article { padding: 40px 0 64px; }
  .eyebrow { font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; margin: 0 0 14px; }
  .rule { height: 2px; background: var(--teal); border: 0; margin: 0 0 22px; }
  h1 { font-family: ${FONTS.serif}; font-weight: 700; font-size: clamp(32px, 5.5vw, 48px); line-height: 1.08;
    letter-spacing: -0.015em; margin: 0 0 24px; text-wrap: balance; }
  h2 { font-family: ${FONTS.serif}; font-weight: 600; font-size: clamp(24px, 3.6vw, 30px); line-height: 1.22;
    margin: 0 0 18px; text-wrap: balance; }
  p { font-size: 17px; line-height: 1.65; margin: 0 0 18px; }
  .lede p { font-size: 19px; line-height: 1.55; }
  a { text-decoration-color: var(--teal); text-underline-offset: 2px; }
  a:hover { color: var(--teal); }
  .kicker { font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 600; margin: 0 0 10px; }
  .theme, .prose { border-top: 1px solid var(--rule); padding-top: 44px; margin-top: 44px; }
  figure { margin: 0 0 24px; }
  figure img { display: block; width: 100%; height: auto; border-radius: 12px; }
  .fio { background: ${COLORS.paperAlt}; border-radius: 12px; padding: 20px 24px 4px; margin: 8px 0 0; }
  .fio p { font-size: 16px; }
${renderCuradoriaFooterStyles()}
  footer { padding: 28px 0 40px; font-size: 13px; }
</style>`;
}

/**
 * Página web completa. Não valida nada (mesma divisão de responsabilidade de
 * `renderAnnualEmail`): quem reprova draft inválido é o lint da Etapa 4.
 */
export function renderAnnualWebPage(draft: AnnualDraft, opts: AnnualWebRenderOptions): AnnualRenderResult {
  const images = opts.images ?? {};
  const warnings: string[] = [];
  const missingImages: number[] = [];
  const title = plain(draft.subjects[0] ?? "") || FALLBACK_TITLE;
  const body: string[] = [];

  body.push(`<header><p class="eyebrow">Retrospectiva</p><hr class="rule" /><h1>${inline(title)}</h1></header>`);
  if (draft.intro) body.push(`<div class="lede">${paragraphs(draft.intro)}</div>`);

  if (opts.tipo === "aniversario") {
    if (draft.anniversary) body.push(renderProse("Um ano de diar.ia.br", draft.anniversary));
    else warnings.push("rodada de aniversário sem bloco ANIVERSÁRIO");
  } else if (draft.anniversary) {
    warnings.push("rodada de janeiro com bloco ANIVERSÁRIO — ignorado no render");
  }

  for (const theme of draft.themes) {
    const url = images[theme.index];
    if (!url) missingImages.push(theme.index);
    body.push(renderTheme(theme, url));
  }

  body.push(renderProse("O que mudou", draft.whatChanged));
  body.push(renderProse("Previsões", draft.predictions));
  body.push(renderProse(null, draft.closing));

  const footer =
    opts.variant === "teaser" ? "" : renderCuradoriaFooter("diar.ia.br — 5 minutos diários para entender a IA.");

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
${styles()}
</head>
<body>
<div class="wrap">
<p class="site-top"><a href="https://diar.ia.br">${applyBrandWordmark("diar.ia.br")}</a></p>
<article>
${body.filter(Boolean).join("\n")}
</article>
</div>
${footer}
</body>
</html>`;

  const imageCount = (html.match(/<img\s/g) ?? []).length;
  return { html, imageCount, missingImages, warnings };
}
