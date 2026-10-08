/**
 * monthly-web-render.ts (#9872)
 *
 * Markdown do draft mensal → página WEB da Retrospectiva do Mês
 * (`retrospectiva.diar.ia.br/{AAMM}`), em HTML semântico no estilo do Artigo
 * Especial (`workers/artigos/articles-src/`): HTML5, head completo, classes
 * (`masthead`, `manuscript`, `kicker`…) e CSS próprio, sem `<table>` de layout.
 * Puro, sem I/O.
 *
 * Até o #9872 a página era o próprio HTML do e-mail (`wrapEmail`): uma faixa
 * de 600px feita de tabelas, XHTML 1.0 Transitional, ~190 `style=` inline e
 * nenhum description/canonical/OG. O e-mail continua saindo de
 * `monthly-render.ts`, byte a byte igual (golden em
 * `test/fixtures/retrospectiva-web-9872/`); este módulo é só a superfície web.
 *
 * ## O texto é o do e-mail, por construção
 *
 * O parsing de cada seção é o MESMO do e-mail — `classifySection`,
 * `parseDestaqueChunk`, `parseBoxChunk`, `parseLinkListChunk`,
 * `parseEncerramento`, `parseCtaLine`, `eiaCreditContent` vivem em
 * `monthly-render.ts` e os dois renders os consomem —, e o texto inline passa
 * pelo mesmo `renderInline` (links, negrito, wordmark, word-joiner, UTM). Só a
 * marcação em volta muda. `test/retrospectiva-web-semantica-9872.test.ts`
 * compara os segmentos de texto das duas saídas.
 *
 * ## O que é diferente de propósito
 *
 * - O ● dos kickers vem do CSS (`::before`), não do texto.
 * - As fotos do É IA? não são link de voto (#9864): na web ninguém resolve a
 *   merge tag de e-mail, e voto sem identidade não vale.
 * - O "Ver ranking" aponta para o leaderboard `clarice` (#9865, decisão do
 *   editor 08/10/2026), não para o brand do canal de e-mail dos apoiadores.
 */
import { escHtml } from "../html-escape.ts";
import { breakBrandDomainAutolink } from "../shared/brand-wordmark.ts";
import { applyBrandWordmark } from "../shared/brand-wordmark.ts";
import { FAVICON_DATA_URI } from "../shared/seo-meta.ts";
import type { Brand } from "../../../workers/poll/src/lib.ts";
import {
  classifySection,
  eiaCreditContent,
  eiaEditionFromYymm,
  eiaLeaderboardRawUrl,
  livroAbreComParagrafoDeLink,
  normalizeKnownUrl,
  normalizeLabel,
  parseAssuntoCandidate,
  parseBoxChunk,
  parseCtaLine,
  parseDestaqueChunk,
  parseDivulgacaoChunk,
  parseEncerramento,
  parseLinkListChunk,
  pillPosicao,
  renderInline,
  setMonthlyUtmCiclo,
  setMonthlyUtmSecao,
  splitByLabels,
  capitalizeFirstLetter,
  type MonthlyUtmProfile,
} from "./monthly-render.ts";
import { slugifySecao } from "../shared/utm-registry.ts";

/** Insumos do render web — os mesmos que `draftToEmail` recebe, por nome. */
export interface MonthlyWebRenderInput {
  draft: string;
  yymm: string;
  utmProfile: MonthlyUtmProfile;
  /** Brand do "Ver ranking" (#9865). Independe do `utmProfile.pollBrand`. */
  leaderboardBrand: Brand;
  eiaImageUrlA?: string;
  eiaImageUrlB?: string;
  eiaCredit?: string;
  eiaPrevResultLine?: string | null;
  destaqueImageUrls?: Record<number, string>;
  destaqueImageCaption?: string;
  livrosImageUrl?: string;
}

/**
 * `renderInline` é compartilhado com o e-mail e põe `style=` inline em `<a>` e
 * `<em>` (cliente de e-mail não lê CSS de classe). Na página a cor vem do CSS,
 * então o atributo sai. O wordmark (`<span style="color:…">`) fica: é o mesmo
 * tratamento do Artigo Especial (`BRAND` em `artigo-especial-draft.ts`).
 */
function inline(text: string, posicao?: string): string {
  return stripInlineStyle(renderInline(text, posicao));
}

function stripInlineStyle(html: string): string {
  return html.replace(/<(a|em)\b([^>]*?)\s+style="[^"]*"/g, "<$1$2");
}

function kicker(label: string): string {
  return `<p class="kicker">${escHtml(label)}</p>`;
}

/** Equivalente web de `renderParagraphs`: listas viram `<ul>`/`<ol>`. */
function paragraphs(text: string): string {
  return text
    .split(/\n\n+/)
    .filter((p) => p.trim())
    .map((p) => {
      const lines = p.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return "";
      if (lines.every((l) => /^[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ""))}</li>`).join("\n")}</ul>`;
      }
      if (lines.every((l) => /^\d+\.\s+/.test(l))) {
        return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\d+\.\s+/, ""))}</li>`).join("\n")}</ol>`;
      }
      return `<p>${inline(p.trim().replace(/\n/g, " "))}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

function renderIntroWeb(body: string): string {
  const paras = body
    .split(/\n\n+/)
    .filter((p) => p.trim())
    .map((p) => `<p>${inline(p.trim().replace(/\n/g, " "))}</p>`)
    .join("\n");
  return `<section class="intro">\n${kicker("Resumo do mês")}\n${paras}\n</section>`;
}

function renderDestaqueWeb(chunk: string, n: number, imageUrl?: string, imageCaption?: string): string {
  const { tema, title, paras, fio } = parseDestaqueChunk(chunk);
  const parts = [`<section class="destaque" id="destaque-${n}">`];
  if (tema) parts.push(kicker(tema));
  if (title) parts.push(`<h2>${inline(title)}</h2>`);
  if (imageUrl) {
    parts.push(
      `<figure class="cover"><img src="${escHtml(imageUrl)}" alt="${escHtml(title || tema)}" loading="lazy"><figcaption>${escHtml(imageCaption ?? "Criada com IA")}</figcaption></figure>`,
    );
  }
  for (const p of paras) parts.push(`<p>${inline(p.replace(/\n/g, " "))}</p>`);
  if (fio !== null) {
    parts.push(
      `<aside class="fio"><p class="fio-tag">O fio condutor</p><p>${inline(capitalizeFirstLetter(fio.replace(/\n/g, " ")))}</p></aside>`,
    );
  }
  parts.push("</section>");
  return parts.join("\n");
}

function renderCtaWeb(line: string): string {
  const cta = parseCtaLine(line);
  if ("text" in cta) return `<p>${inline(cta.text)}</p>`;
  return `<p class="cta"><a class="cta-btn" href="${escHtml(normalizeKnownUrl(cta.rawUrl, "cta"))}">${escHtml(cta.label)}</a></p>`;
}

function renderBoxWeb(chunk: string, headerLabel: string, imageUrl?: string, noSubtitle = false, imageAlt?: string): string {
  const { subtitle, blocks } = parseBoxChunk(chunk, noSubtitle);
  const inner: string[] = [];
  if (imageUrl) {
    inner.push(`<img class="panel-img" src="${escHtml(imageUrl)}" alt="${escHtml(imageAlt || subtitle || headerLabel)}" loading="lazy">`);
  }
  inner.push(`<div class="panel-body">`);
  if (subtitle) inner.push(`<h3>${inline(subtitle)}</h3>`);
  for (const b of blocks) {
    if (b.kind === "ol") inner.push(`<ol>${b.items.map((i) => `<li>${inline(i)}</li>`).join("\n")}</ol>`);
    else if (b.kind === "cta") inner.push(renderCtaWeb(b.line));
    else inner.push(`<p>${inline(b.text)}</p>`);
  }
  inner.push(`</div>`);
  return `<section class="box">\n${kicker(headerLabel)}\n<div class="panel">\n${inner.join("\n")}\n</div>\n</section>`;
}

function renderLinkListWeb(chunk: string, displayTitle: string): string {
  const { intro, footer, items } = parseLinkListChunk(chunk);
  const posicao = slugifySecao(displayTitle);
  const parts = [`<section class="links">`, kicker(displayTitle)];
  if (intro) parts.push(`<p class="links-cta">${inline(intro, posicao)}</p>`);
  if (items.length) {
    const lis = items.map(({ title, desc }) => {
      const tm = title.match(/^\[(.+?)\]\((https?:\/\/[^)]+)\)/);
      const titleHtml = tm
        ? `<a class="item-title" href="${escHtml(normalizeKnownUrl(tm[2], "titulo"))}">${escHtml(tm[1])}</a>`
        : `<span class="item-title">${inline(title)}</span>`;
      return `<li>${titleHtml}${desc ? `\n<p>${inline(desc)}</p>` : ""}</li>`;
    });
    parts.push(`<ul class="link-list">\n${lis.join("\n")}\n</ul>`);
  }
  if (footer) parts.push(`<p class="links-cta">${inline(footer, posicao)}</p>`);
  parts.push("</section>");
  return parts.join("\n");
}

function renderEiaWeb(
  chunk: string,
  yymm: string,
  brand: Brand,
  imageUrlA?: string,
  imageUrlB?: string,
  creditOverride?: string,
  prevResultLine?: string | null,
): string {
  const content = eiaCreditContent(chunk, creditOverride);
  const img = (label: "A" | "B", url?: string): string =>
    url
      ? `<img src="${escHtml(url)}" alt="Imagem ${label}" loading="lazy">`
      : `<div class="eia-ph">Imagem ${label}</div>`;
  const parts = [
    `<section class="eia">`,
    kicker("É IA?"),
    `<div class="panel"><div class="panel-body">`,
    `<p class="eia-title">Clique na imagem que foi gerada por IA</p>`,
    `<div class="eia-pair">${img("A", imageUrlA)}${img("B", imageUrlB)}</div>`,
    `<p class="credit">${inline(content)}</p>`,
  ];
  if (prevResultLine) parts.push(`<p>${inline(prevResultLine)}</p>`);
  parts.push(
    `<p class="credit"><a href="${escHtml(normalizeKnownUrl(eiaLeaderboardRawUrl(yymm, brand), "leaderboard"))}">Ver ranking</a></p>`,
    `</div></div>`,
    `</section>`,
  );
  return parts.join("\n");
}

function renderEncerramentoWeb(body: string): string {
  const { head, groups, last } = parseEncerramento(body);
  const parts = [`<section class="encerramento">`, kicker("Para encerrar")];
  for (const p of head) parts.push(`<p>${inline(p)}</p>`);
  for (const g of groups) {
    parts.push(`<p class="pill-label">${breakBrandDomainAutolink(escHtml(g.label))}</p>`);
    const pills = g.pills.map(
      (p) => `<a class="pill" href="${escHtml(normalizeKnownUrl(p.rawUrl, pillPosicao(p.label)))}">${escHtml(p.label)}</a>`,
    );
    parts.push(`<p class="pills">${pills.join("")}</p>`);
  }
  if (last) parts.push(`<div class="panel"><div class="panel-body"><p>${inline(last)}</p></div></div>`);
  parts.push("</section>");
  return parts.join("\n");
}

/**
 * Corpo semântico do artigo (o conteúdo de `<article class="manuscript">`) +
 * subject/preview extraídos do draft — mesma extração de `draftToEmail`.
 */
export function draftToWebArticle(input: MonthlyWebRenderInput): { subject: string; previewText: string; bodyHtml: string } {
  const text = input.draft.replace(/\r\n/g, "\n");
  const chunkBody = (chunk: string): string => chunk.split("\n").slice(1).join("\n").trim();
  let subject = "";
  let previewText = "";
  const parts: string[] = [];

  setMonthlyUtmCiclo(eiaEditionFromYymm(input.yymm), input.utmProfile);
  try {
    for (const raw of splitByLabels(text)) {
      const chunk = raw.trim();
      if (!chunk) continue;
      const label = normalizeLabel(chunk.split("\n")[0].trim());
      setMonthlyUtmSecao(label);
      const kind = classifySection(label);
      switch (kind.kind) {
        case "remetente":
          break;
        case "assunto": {
          const candidate = parseAssuntoCandidate(chunkBody(chunk));
          if (!subject && candidate) subject = candidate;
          break;
        }
        case "preview":
          previewText = chunkBody(chunk).split("\n").join(" ").trim();
          break;
        case "intro": {
          const body = chunkBody(chunk);
          if (body) parts.push(renderIntroWeb(body));
          break;
        }
        case "apresentacao": {
          const body = chunkBody(chunk);
          if (body) parts.push(`<section class="prose">\n${paragraphs(body)}\n</section>`);
          break;
        }
        case "divulgacao": {
          const d = parseDivulgacaoChunk(chunk);
          parts.push(renderBoxWeb(d.chunk, "Divulgação", d.imageUrl, false, d.imageAlt));
          break;
        }
        case "livros":
          parts.push(renderBoxWeb(chunk, "Livros", input.livrosImageUrl));
          break;
        case "livro":
          parts.push(renderBoxWeb(chunk, "Livro do mês", undefined, livroAbreComParagrafoDeLink(chunk)));
          break;
        case "destaque":
          parts.push(renderDestaqueWeb(chunk, kind.n, input.destaqueImageUrls?.[kind.n], input.destaqueImageCaption));
          break;
        case "clarice":
          parts.push(renderBoxWeb(chunk, "Desconto exclusivo"));
          break;
        case "laboratorio":
          parts.push(renderBoxWeb(chunk, "LABORATÓRIO CLARICE"));
          break;
        case "use-melhor":
          parts.push(renderLinkListWeb(chunk, "Use Melhor"));
          break;
        case "radar":
          parts.push(renderLinkListWeb(chunk, "Radar"));
          break;
        case "outras-noticias":
          parts.push(renderLinkListWeb(chunk, "Outras Notícias do Mês"));
          break;
        case "eia":
          parts.push(
            renderEiaWeb(
              chunk,
              input.yymm,
              input.leaderboardBrand,
              input.eiaImageUrlA,
              input.eiaImageUrlB,
              input.eiaCredit,
              input.eiaPrevResultLine,
            ),
          );
          break;
        case "encerramento": {
          const body = chunkBody(chunk);
          if (body) parts.push(renderEncerramentoWeb(body));
          break;
        }
        case "fallback":
          parts.push(`<section class="prose">\n${paragraphs(chunk)}\n</section>`);
          break;
      }
    }
  } finally {
    setMonthlyUtmCiclo(null);
    setMonthlyUtmSecao(null);
  }
  return { subject, previewText, bodyHtml: parts.join("\n\n") };
}

/** Largura máxima, em px, em que o layout de celular vale (#9872 / #9492). */
export const WEB_MOBILE_MAX_WIDTH = 640;

/**
 * CSS da página. Tokens e classes do Artigo Especial (`:root` com `--bg`,
 * `--bg-raised`, `--ink`, `--accent`, `--serif`, `--sans`; `.sheet`,
 * `.masthead .kicker`, `.manuscript`, `.cover`), mais os componentes da
 * retrospectiva (destaque, caixas, listas, É IA?, pills). Nada de largura fixa:
 * a coluna é `max-width` e o celular (≤640px) só reduz respiro.
 */
export const MONTHLY_WEB_STYLE = `<style>
  /* Tokens do design system diar.ia.br — os mesmos do Artigo Especial (espelho de design-tokens.ts, #1936). */
  :root {
    --bg: #FBFAF6;
    --bg-raised: #EBE5D0;
    --ink: #171411;
    --ink-soft: rgba(23,20,17,0.72);
    --rule: #EBE5D0;
    --accent: #00A0A0;
    --serif: Georgia, 'Times New Roman', serif;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); }
  body { padding: 4.5rem 1.5rem 6rem; line-height: 1.62; font-size: 16px; }
  h1, h2, h3 { font-family: var(--serif); }
  img { max-width: 100%; height: auto; }
  p, li, h1, h2, h3, a { overflow-wrap: break-word; word-wrap: break-word; }
  a { color: var(--ink); text-decoration-color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:hover { color: var(--accent); }

  .sheet { max-width: 42rem; margin: 0 auto; }
  .masthead { border-bottom: 1px solid var(--rule); padding-bottom: 1.75rem; margin-bottom: 2.75rem; }
  .masthead .kicker { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.25rem 1rem; }
  .masthead h1 { font-size: clamp(1.8rem, 4vw, 2.4rem); line-height: 1.2; margin: 0.6rem 0 0; text-wrap: balance; font-weight: 600; }

  .kicker { font-family: var(--sans); font-size: 0.72rem; letter-spacing: 2px; text-transform: uppercase; font-weight: 700; margin: 0 0 1rem; }
  .manuscript .kicker::before, .masthead .kicker > span:first-child::before { content: "\\25CF"; color: var(--accent); margin-right: 0.5em; font-size: 0.85em; }

  .manuscript > section { margin: 0 0 3rem; }
  .manuscript > section + section { border-top: 1px solid var(--rule); padding-top: 2.6rem; }
  .manuscript h2 { font-size: 1.6rem; line-height: 1.22; margin: 0 0 1.2rem; text-wrap: balance; font-weight: 600; }
  .manuscript h3 { font-size: 1.25rem; line-height: 1.3; margin: 0 0 0.9rem; font-weight: 600; }
  .manuscript p { margin: 0 0 1.15rem; }
  .manuscript ul, .manuscript ol { padding-left: 1.4rem; margin: 0 0 1.15rem; display: grid; gap: 0.5rem; }

  .cover { margin: 0 0 1.6rem; }
  .cover img { display: block; width: 100%; border-radius: 6px; }
  .cover figcaption { margin: 0.6rem 0 0; font-size: 0.72rem; letter-spacing: 2px; text-transform: uppercase; }

  .fio { border: 1px solid var(--rule); border-radius: 12px; padding: 1.4rem 1.6rem; margin: 1.6rem 0 0; }
  .fio p:last-child { margin: 0; }
  .fio-tag { font-size: 0.72rem; letter-spacing: 2px; text-transform: uppercase; font-weight: 700; margin: 0 0 0.5rem !important; }
  .fio-tag::before { content: "\\25CF"; color: var(--accent); margin-right: 0.5em; font-size: 0.85em; }

  .panel { background: var(--bg-raised); border-radius: 12px; overflow: hidden; }
  .panel-body { padding: 1.5rem 1.75rem; }
  .panel-body > :last-child { margin-bottom: 0; }
  .panel-img { display: block; width: 100%; }
  .cta { text-align: center; margin: 1.25rem 0 0 !important; }
  .cta-btn { display: inline-block; background: var(--bg); border: 1px solid var(--rule); border-radius: 999px; padding: 0.75rem 1.4rem; font-weight: 700; text-decoration: none; }

  .link-list { list-style: none; padding: 0 !important; gap: 1.25rem !important; }
  .link-list p { margin: 0.25rem 0 0; }
  .item-title { font-family: var(--serif); font-size: 1.25rem; line-height: 1.25; text-decoration-thickness: 2px; text-underline-offset: 3px; }

  .eia-title { font-family: var(--serif); font-size: 1.5rem; line-height: 1.2; }
  .eia-pair { display: grid; gap: 1rem; margin: 0 0 1rem; }
  .eia-pair img { display: block; width: 100%; border-radius: 6px; }
  .eia-ph { height: 160px; border: 2px dashed var(--ink); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; }
  .credit { font-size: 0.78rem; }

  .pill-label { font-size: 0.72rem; letter-spacing: 2px; text-transform: uppercase; font-weight: 700; margin: 1.2rem 0 0.5rem !important; }
  .pills { display: flex; flex-wrap: wrap; gap: 0.6rem; }
  .pill { display: inline-block; background: var(--bg); border: 1px solid var(--rule); border-radius: 999px; padding: 0.6rem 1.2rem; font-weight: 700; text-decoration: none; }
  .encerramento .panel { margin-top: 1.2rem; }

  @media only screen and (max-width: ${WEB_MOBILE_MAX_WIDTH}px) {
    body { padding: 2rem 1rem 4rem; }
    .manuscript h2 { font-size: 1.4rem; }
    .panel-body { padding: 1.25rem 1.1rem; }
    .fio { padding: 1.1rem 1.1rem; }
  }
</style>`;

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** "setembro de 2026" a partir do `yymm` do conteúdo; `null` se inválido. */
export function monthLabelFromYymm(yymm: string): string | null {
  const mes = MESES[Number(yymm.slice(2, 4)) - 1];
  return mes ? `${mes} de 20${yymm.slice(0, 2)}` : null;
}

export interface MonthlyWebPageInput {
  /** `<title>`/`og:title` — o ASSUNTO do draft (contrato #3940 + guard #7719). */
  title: string;
  /** Título visível da página (`<h1>`). */
  heading: string;
  description: string;
  canonical: string;
  monthLabel: string;
  bodyHtml: string;
}

/**
 * Documento completo. Contrato com o Worker `retrospectiva` (não muda): o
 * trecho recebe o bloco de paywall antes do ÚLTIMO `</body>`, e o JSON-LD
 * antes do último `</head>` — por isso description/canonical já vêm aqui e o
 * Worker não os duplica (`injectRetrospectivaHeadMeta`).
 */
export function renderMonthlyWebPage(p: MonthlyWebPageInput): string {
  const t = escHtml(p.title);
  const d = escHtml(p.description);
  const url = escHtml(p.canonical);
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${url}">
<link rel="icon" href="${FAVICON_DATA_URI}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="diar.ia.br">
<meta property="og:locale" content="pt_BR">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
${MONTHLY_WEB_STYLE}
</head>
<body>
<div class="sheet">
<header class="masthead">
<div class="kicker"><span>${applyBrandWordmark("diar.ia.br")}: retrospectiva do mês</span><span>${escHtml(p.monthLabel)}</span></div>
<h1>${escHtml(p.heading)}</h1>
</header>
<article class="manuscript">
${p.bodyHtml}
</article>
</div>
</body>
</html>`;
}
