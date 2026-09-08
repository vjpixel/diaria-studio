/**
 * annual-render.ts (#7569)
 *
 * `AnnualDraft` → HTML do e-mail da edição anual. Puro, sem I/O.
 *
 * Escrito do zero em vez de reusar `lib/mensal/monthly-render.ts` por dois
 * motivos, nessa ordem: (1) `lib/anual/` não pode importar de `lib/mensal/`
 * (`test/lib-boundary.test.ts`), e mover as 1.600 linhas do render mensal pra
 * `shared/` arrastaria os 8 testes de render do mensal junto — risco alto
 * numa unidade que se comprometeu a não tocar na `/diaria-mensal`; (2) o
 * render mensal carrega muita coisa que a anual não tem (boxes da Clarice,
 * perfis de UTM, Use Melhor, Radar, poll do "É IA?", livros, cursos). O que
 * é de fato comum — tokens de design e as regras de CSS do e-mail — vem de
 * `lib/shared/`, que é o lugar certo.
 *
 * O layout é o mesmo sistema visual das outras edições: serif Georgia nos
 * títulos, sans no corpo, teal só em link, régua bege entre seções.
 */

import { COLORS, FONTS, LAYOUT } from "../shared/design-tokens.ts";
import { buildDiariaStyleBlock } from "../shared/newsletter-styles.ts";
import type { AnnualDraft, AnnualTheme } from "./annual-parse.ts";

export interface AnnualRenderOptions {
  /** Rótulo da janela — ex. "agosto/2025 a agosto/2026". */
  windowLabel: string;
  tipo: "aniversario" | "janeiro";
  /**
   * URL pública da imagem de cada tema, por índice 1-based. Tema sem imagem
   * renderiza sem `<img>` — o lint é quem decide se isso reprova.
   */
  images?: Record<number, string>;
}

export interface AnnualRenderResult {
  html: string;
  /** Quantos `<img>` o render emitiu — a sonda do guardrail do lint. */
  imageCount: number;
  /** Temas que ficaram sem imagem. */
  missingImages: number[];
  warnings: string[];
}

/**
 * Escapa texto para HTML, **incluindo aspas duplas** — o valor é interpolado
 * dentro de atributos (`alt="..."`, `href="..."`), e um título com aspas
 * retas (`Sam Altman diz "a IA muda tudo"`, comum em português) fecharia o
 * atributo no meio e vazaria o resto do título como marcação solta.
 * `lib/weekly-linkedin-render.ts::escapeHtml` já escapava aspas pelo mesmo
 * motivo; omiti-las aqui era uma regressão silenciosa em relação a ele.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Markdown inline → HTML: links ancorados e negrito. Escapa o texto ANTES de
 * injetar as tags, pra um título com `<` ou `&` não quebrar o e-mail.
 */
export function inlineMarkdown(text: string, brand: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_m, label: string, url: string) =>
        // A URL vem do `[texto](url)` do draft, ou seja, de conteúdo escrito
        // por agente — escapar aspas aqui também, pelo mesmo motivo do `alt`.
        `<a href="${url.replace(/"/g, "&quot;")}" style="color:${brand};text-decoration:underline;">${label}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function paragraph(text: string, brand: string, extraStyle = ""): string {
  return `<p style="margin:0 0 16px;font-family:${FONTS.sans};font-size:16px;line-height:1.6;color:${COLORS.ink};${extraStyle}">${inlineMarkdown(text, brand)}</p>`;
}

function sectionOpen(padTop: number): string {
  return `<tr><td class="pad" style="padding:${padTop}px ${LAYOUT.sidePad}px 0;">`;
}

function rule(): string {
  return `<tr><td class="pad" style="padding:32px ${LAYOUT.sidePad}px 0;"><div style="border-top:1px solid ${COLORS.rule};"></div></td></tr>`;
}

function kicker(text: string): string {
  return `<p style="margin:0 0 8px;font-family:${FONTS.sans};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${COLORS.brand};">${escapeHtml(text)}</p>`;
}

function heading(text: string, brand: string, size = 26): string {
  return `<h2 style="margin:0 0 16px;font-family:${FONTS.serif};font-size:${size}px;line-height:1.25;color:${COLORS.ink};font-weight:normal;">${inlineMarkdown(text, brand)}</h2>`;
}

function renderTheme(theme: AnnualTheme, imageUrl: string | undefined, brand: string): string {
  const parts: string[] = [];
  parts.push(sectionOpen(LAYOUT.sectionTop));
  if (theme.name) parts.push(kicker(theme.name));
  parts.push(heading(theme.title, brand));
  parts.push("</td></tr>");

  if (imageUrl) {
    parts.push(
      `<tr><td class="pad" style="padding:0 ${LAYOUT.sidePad}px 20px;">` +
        `<img src="${imageUrl}" alt="${escapeHtml(theme.title)}" width="${LAYOUT.containerWidth - LAYOUT.sidePad * 2}" ` +
        `style="display:block;width:100%;height:auto;border:0;" /></td></tr>`,
    );
  }

  parts.push(`<tr><td class="pad" style="padding:0 ${LAYOUT.sidePad}px 0;">`);
  for (const p of theme.paragraphs) parts.push(paragraph(p, brand));
  if (theme.fioCondutor) {
    parts.push(
      `<div style="margin:${LAYOUT.boxMargin}px 0 0;padding:${LAYOUT.boxPad}px;background:${COLORS.paperAlt};">` +
        kicker("O fio condutor") +
        `<p style="margin:0;font-family:${FONTS.sans};font-size:15px;line-height:1.6;color:${COLORS.ink};">${inlineMarkdown(theme.fioCondutor, brand)}</p>` +
        `</div>`,
    );
  }
  parts.push("</td></tr>");
  return parts.join("\n");
}

function renderProse(title: string | null, text: string, brand: string): string {
  if (!text) return "";
  const parts: string[] = [sectionOpen(LAYOUT.sectionTop)];
  if (title) parts.push(heading(title, brand, 22));
  for (const p of text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)) {
    parts.push(paragraph(p, brand));
  }
  parts.push("</td></tr>");
  return parts.join("\n");
}

/**
 * Renderiza o e-mail completo. Não decide nada sobre validade — um draft sem
 * tema nenhum renderiza um e-mail vazio, e é o lint (que roda ANTES do envio)
 * que reprova. Misturar as duas responsabilidades esconderia o erro dentro de
 * um HTML "que quase funciona".
 */
export function renderAnnualEmail(draft: AnnualDraft, opts: AnnualRenderOptions): AnnualRenderResult {
  const brand = COLORS.brand;
  const images = opts.images ?? {};
  const warnings: string[] = [];
  const missingImages: number[] = [];
  const body: string[] = [];

  body.push(sectionOpen(LAYOUT.leadTop));
  body.push(kicker(`Retrospectiva · ${opts.windowLabel}`));
  if (draft.intro) {
    for (const p of draft.intro.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)) {
      body.push(paragraph(p, brand, "font-size:17px;"));
    }
  }
  body.push("</td></tr>");

  if (opts.tipo === "aniversario") {
    if (draft.anniversary) {
      body.push(rule());
      body.push(renderProse("Um ano de diar.ia.br", draft.anniversary, brand));
    } else {
      warnings.push("rodada de aniversário sem bloco ANIVERSÁRIO");
    }
  } else if (draft.anniversary) {
    warnings.push("rodada de janeiro com bloco ANIVERSÁRIO — ignorado no render");
  }

  for (const theme of draft.themes) {
    body.push(rule());
    const url = images[theme.index];
    if (!url) missingImages.push(theme.index);
    body.push(renderTheme(theme, url, brand));
  }

  if (draft.whatChanged) {
    body.push(rule());
    body.push(renderProse("O que mudou", draft.whatChanged, brand));
  }
  if (draft.predictions) {
    body.push(rule());
    body.push(renderProse("Previsões", draft.predictions, brand));
  }
  if (draft.closing) {
    body.push(rule());
    body.push(renderProse(null, draft.closing, brand));
  }

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
${buildDiariaStyleBlock(COLORS.paperEmail, brand, LAYOUT.sidePad)}
</head>
<body style="margin:0;padding:0;background:${COLORS.paperEmail};">
<table role="presentation" class="container" width="${LAYOUT.containerWidth}" cellpadding="0" cellspacing="0" border="0" align="center" style="width:${LAYOUT.containerWidth}px;max-width:100%;background:${COLORS.paperEmail};">
${body.join("\n")}
<tr><td class="pad" style="padding:40px ${LAYOUT.sidePad}px 48px;">
<div style="border-top:2px solid ${COLORS.ruleStrong};padding-top:16px;">
<p style="margin:0;font-family:${FONTS.sans};font-size:13px;line-height:1.6;color:${COLORS.ink};">diar.ia.br — 5 minutos diários para entender a IA.</p>
</div>
</td></tr>
</table>
</body>
</html>`;

  const imageCount = (html.match(/<img\s/g) ?? []).length;
  return { html, imageCount, missingImages, warnings };
}
