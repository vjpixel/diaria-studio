/**
 * newsletter-render-html.ts (#1889)
 *
 * Render phase: NewsletterContent → HTML.
 * Extracted from render-newsletter-html.ts — byte-identical functions.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { escHtml as esc } from "./html-escape.ts"; // #1990
import { COLORS, FONTS } from "./shared/design-tokens.ts"; // #1936
import { buildDiariaStyleBlock, buildDarkCanvasStyleBlock } from "./shared/newsletter-styles.ts"; // #2635 — CSS base compartilhado; #3104 — dark mode (fullDocument-only)
import { tealDot } from "./shared/email-components.ts"; // #3269 — 1º componente extraído pra shared/; re-exportado abaixo (back-compat: monthly-render.ts e outros importavam daqui)
import { applyWordJoiner } from "./word-joiner.ts"; // #2018 — shared helper
import {
  displaySectionName,
} from "./section-naming.ts";
import type {
  RenderDestaque,
  SectionItem,
  Section,
  EIA,
  NewsletterContent,
} from "./newsletter-parse.ts";
import {
  unescapeMd,
  pickErroIntencionalReveal,
} from "./newsletter-parse.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// #1936: design system canônico (vjpixel/diaria-design) — valores inline via
// scripts/lib/shared/design-tokens.ts. Paleta de 4 cores (ink·bege·papel·teal); texto
// sempre ink (sem cinzas — hierarquia por tamanho/peso). Teal = único acento
// (links, kickers, marcas). Réguas/bordas = bege (--rule); ver design-tokens.ts.
// #1943: fundo do e-mail BRANCO (override email-only). O token canônico
// --paper (#FBFAF6) segue em design-tokens.ts pra web/mensal/É IA?; só o
// render do e-mail diário usa branco. PAPER aqui é o fundo do container +
// dos boxes "contorno" (Por que importa / reveal), que acompanham o fundo.
const PAPER = "#FFFFFF"; // #1943 (era COLORS.paper #FBFAF6)
const SURFACE = COLORS.paperAlt; // --paper-alt #EBE5D0 (boxes/callouts/É IA? — painéis de contraste, mantidos bege)
// #1945: fundo EXTERNO do e-mail branco (sem as faixas bege laterais ao redor
// do container). Antes usava SURFACE (#EBE5D0), que aparecia como bandas bege
// à esquerda/direita em telas largas. Os painéis de contraste seguem SURFACE.
const PAGE_BG = "#FFFFFF"; // #1945 (era SURFACE #EBE5D0 no wrapper externo)
const TEAL = COLORS.brand; // --brand #00A0A0 (accent: underline/links/CTA/kicker/régua)
const TEXT_COLOR = COLORS.ink; // --ink #171411 (todo o texto)
const RULE = COLORS.rule; // --rule #EBE5D0 (hairline bege sob nomes de seção + bordas dos boxes contorno)
// #1936: DS usa serif Georgia SÓ em manchetes/títulos; CORPO + labels/kickers em
// sans Geist (confirmado pelo template de email do DS + typography.css "Body & UI
// (sans)"). Georgia é email-safe; Geist cai pra system sans em email.
const FONT_HEADING = FONTS.serif;
const FONT_BODY = FONTS.sans;
const FONT_LABEL = FONTS.sans;
// #1186: URL montada inline com edition literal + merge tag Beehiiv `{{email}}`
// (reserved field). Modo merge-tag — sem sig HMAC por subscriber.
// inject-poll-sig.ts foi removido. Sintaxe Beehiiv: SEM espaços, SEM prefix.
// (validado contra docs oficiais 2026-05-11).
const POLL_WORKER_URL = "https://poll.diaria.workers.dev";

/**
 * #2067: helper DS body — sans 16px line-height 1.62 ink. `margin` aceita
 * qualquer shorthand CSS (ex: "18px 0 0", "12px 0 0", "0 0 12px", "0").
 *
 * DECISÃO line-height: canônico é 1.62 (DS body). As duas ocorrências de 1.6
 * em renderCoverage e renderSectionItem eram drift silencioso — unificadas aqui.
 *
 * DECISÃO margin inconsistência multi vs single (box de divulgação):
 *   - single-parágrafo: `margin:0 0 12px` (espaço de 12px ABAIXO do texto,
 *     antes do botão CTA — intencional, cria respiro entre corpo e pill).
 *   - multi-parágrafo: corpo usa `margin:0` / `margin:12px 0 0` entre parágrafos
 *     (empilha sem margem-inferior — o espaço já vem do padding do container).
 *   Não unificamos: os contextos são distintos (single tem CTA depois; multi não).
 */
function bodyP(margin: string, content: string): string {
  return `<p style="margin:${margin};font-family:${FONT_BODY};font-size:16px;line-height:1.62;color:${TEXT_COLOR};">${content}</p>`;
}

// #1936 (DS): cada seção é UMA linha `<tr><td class="pad">` com
// padding lateral de 32px (mobile → 12px via .pad, #2514). Os helpers abaixo retornam
// HTML INTERNO (sem `<tr>`); os render* de topo embrulham na linha padded.
const PAD_SECTION = "40px 32px 0"; // padrão entre seções
const PAD_LEAD = "36px 32px 0"; // destaque líder (D1)

// #3104: padding do box "contorno" (papel + borda bege) unificado — era
// `23px 27px` em renderWhyBoxInner ("Por que isso importa", compensando a
// borda 1px) vs `24px 28px` em renderErroIntencionalReveal (reveal do
// Sorteio), 1px de drift sem motivo funcional. Canonicalizado em `24px 28px`
// — já é o valor dos boxes "painel" (É IA?, Sorteio, CTA de callout), então
// contorno e painel ficam com o mesmo respiro interno; só a régua (contorno)
// vs o fundo preenchido (painel) distingue os 2 estilos visualmente.
const PAD_BOX_OUTLINE = "24px 28px";

// #3104: letter-spacing de labels uppercase (kicker de seção, kicker de box,
// legenda de hero, resultado do É IA?) variava 1px/1.5px/2px sem motivo
// funcional. Canonicalizado em 2px — o valor do kicker de seção
// (renderKicker), que é o único ANCORADO: scripts/build-link-ctr.ts usa esse
// literal via regex (KICKER_TD_OPEN_SRC) pra reconhecer headings de seção no
// HTML cacheado do Beehiiv — mudar esse valor quebraria a extração de CTR
// por seção. Os demais labels (menos ancorados) sobem para o mesmo valor.
const LS_LABEL = "2px";

// #1936 (DS): media query + hover do template de email. Progressive enhancement
// (Gmail/Apple Mail honram); o design carrega nos estilos inline.
// #2635: construído via buildDiariaStyleBlock (newsletter-styles.ts) — mesmo CSS
// base compartilhado com o renderer mensal (monthly-render.ts). Output byte-idêntico.
export const DS_STYLE_BLOCK = buildDiariaStyleBlock(PAGE_BG, TEAL);
// #3104: <style> de dark-canvas, fullDocument-only (ver renderHTML). Precomputado
// uma vez — mesmo padrão de DS_STYLE_BLOCK acima, não recalculado por render.
const DARK_CANVAS_STYLE_BLOCK = buildDarkCanvasStyleBlock(TEXT_COLOR);

export interface RenderOpts {
  /** #1046 — quando `true`, omite a seção É IA? do body. Usado pelo paste
   * híbrido (Stage 4 publish-newsletter): body via ClipboardEvent + È IA?
   * via insertContent pra preservar merge tags `{{poll_x_url}}` que TipTap
   * normalizaria. Default false (output legado: body único com È IA? embutido). */
  excludeEia?: boolean;
  /** #1936 — quando `true`, embrulha o container num documento HTML completo
   * (doctype + body branco #1945 + preheader + tabela de centralização). Usado
   * pro preview/email Worker-hosted. Default `false`: emite só o container 600px
   * (fragmento pro paste no Beehiiv, que provê o shell). */
  fullDocument?: boolean;
}

/** Remove emoji/símbolo + espaço do início do label (DS usa ponto ●, não emoji). */
export function stripKickerEmoji(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

/**
 * Remove SÓ o marcador de callout (📣/📚/📖/🎉 + variation selector + espaço)
 * do início. Diferente de `stripKickerEmoji`, NÃO engole `[` (markdown-link),
 * aspas ou outros não-alfanuméricos — preservando títulos que começam com
 * link/citação (#1942 review #4).
 *
 * #3232: propositalmente NÃO virou um allowlist Unicode genérico como
 * `EMOJI_LEAD_RE` em lint-checks/callout-placement.ts — isto é cosmético
 * (remove o emoji decorativo do título quando ele É um destes 4, conhecidos),
 * não um mecanismo de detecção/silent-drop (esses foram corrigidos por
 * posição+estrutura em `extractIntroCallout`/`locateBoxInGap` e por link de
 * afiliado em `isSponsoredCallout` — nenhum dos dois depende mais desta
 * função pra decidir SE um callout existe). Um marcador novo (ex: 🎥) que não
 * esteja nesta lista simplesmente fica visível no título — cosmético, não
 * crítico (revisado no #3232, item 2 do inventário do #3204).
 */
export function stripCalloutMarker(s: string): string {
  // [︎️]? — consome VS15 (texto) além do VS16 (emoji); VS15 órfão
  // viraria char invisível líder no <p> (review #2066).
  return s.replace(/^\s*(?:📣|📚|📖|🎉)[︎️]?\s*/u, "").trim();
}

/**
 * Convenção de disclosure de callout (#1942 review #1; marcador-agnóstico
 * desde #3232): um callout é PATROCINADO — e recebe o separador "Divulgação"
 * — quando o texto contém um link de AFILIADO (`?via=…` ou `tag=…`), não mais
 * quando começa com o emoji 📣. Um callout sem link de afiliado (CTA/sorteio
 * editorial, promo interna própria) fica sem disclosure.
 *
 * #3232: antes, o predicado testava literalmente `/^\s*📣/` — um bloco
 * patrocinado com um marcador novo (ou nenhum) não ganhava o disclosure
 * "Divulgação" no topo da edição (introCallout), e o título ficava serif/body
 * errado. O sinal estrutural real de "isto é patrocinado" é o link de
 * afiliado em si — todo conteúdo patrocinado real da Diar.ia (Clarice,
 * Beehiiv, Wispr Flow) já usa `?via=`; o único outro padrão observado é
 * `tag=` (convenção clássica de afiliado Amazon). O disclosure é dirigido por
 * este predicado (não pelo slot intro vs mid), então um anúncio recebe
 * "Divulgação" tanto no topo quanto entre D1 e D2 — mas note que
 * `renderDivulgacaoSeparator` no boxDivulgacao1/2 é SEMPRE emitido
 * incondicionalmente (decisão 260611, ver comentário acima) — este predicado
 * hoje só governa o introCallout (topo da edição).
 */
export function isSponsoredCallout(text: string | null | undefined): boolean {
  return !!text && /[?&](?:via|tag)=/i.test(text);
}

/**
 * Linha do separador "● DIVULGAÇÃO" (kicker com régua, #1940). Desde 260611
 * (pedido do editor, supersede a régua nua do #2069) TODO box de divulgação — 📣
 * patrocinado, 📚 promo interna, 🎉 CTA — recebe este kicker antes do box.
 */
export function renderDivulgacaoSeparator(): string {
  return `<tr><td class="pad" style="padding:32px 32px 0;">${renderKicker("Divulgação")}</td></tr>`;
}

/**
 * #3269: movido pra scripts/lib/shared/email-components.ts — 1º componente
 * genuinamente compartilhado entre diária e mensal (era um import cruzado
 * ad-hoc de monthly-render.ts direto pra este arquivo, ver #3181 e a análise
 * em docs/render-unification-analysis-3269.md). Re-exportado aqui por
 * back-compat (era `export function tealDot()` local neste arquivo).
 */
export { tealDot };

/**
 * Kicker de seção do DS: ponto ● teal + label ink uppercase (#3104 — era
 * label teal, ~3.2:1 de contraste, abaixo de AA) + régua bege preenchendo o
 * resto da linha. Retorna HTML interno (sem `<tr>`).
 */
export function renderKicker(label: string): string {
  const clean = esc(stripKickerEmoji(label));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font-family:${FONT_LABEL};font-size:12px;font-weight:bold;letter-spacing:${LS_LABEL};text-transform:uppercase;color:${TEXT_COLOR};white-space:nowrap;padding-right:12px;">${tealDot()}&nbsp;${clean}</td>
    <td style="width:100%;border-bottom:1px solid ${RULE};font-size:0;line-height:0;">&nbsp;</td>
  </tr></table>`;
}

/** Manchete de destaque: Georgia 26px, ink, underline teal (link). HTML interno. */
export function renderHeadlineInner(title: string, url: string): string {
  // #1941: underline em TODAS as linhas do título multi-linha. A versão #1936
  // usava `border-bottom` num `display:inline-block` — a borda traça só o rodapé
  // da caixa, ou seja, embaixo da última linha. `text-decoration:underline`
  // sublinha cada linha do texto. Mantemos a cor teal via `text-decoration-color`
  // (honrado por Apple Mail / Gmail moderno); onde o client remove (Outlook),
  // degrada pra cor do texto/ink — ainda sublinhado em todas as linhas, melhor
  // que o teal só na última. `display:inline-block` preservado pro `margin-top`.
  return `<a class="headline" href="${esc(url)}" style="display:inline-block;margin:18px 0 0;font-family:${FONT_HEADING};font-size:26px;line-height:1.2;color:${TEXT_COLOR};text-decoration:underline;text-decoration-color:${TEAL};text-decoration-thickness:2px;text-underline-offset:3px;" target="_blank" rel="noopener noreferrer nofollow">${esc(title)}</a>`;
}

export function imageGeneratorCredit(): string {
  try {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const gen = cfg.image_generator ?? "gemini";
    const credits: Record<string, string> = {
      gemini:     "Criada com Gemini",
      openai:     "Criada com gpt-image-2",
      cloudflare: "Criada com Cloudflare FLUX",
      comfyui:    "Criada com ComfyUI",
    };
    return credits[gen] ?? "Criada com IA";
  } catch {
    return "Criada com IA";
  }
}

/**
 * Imagem hero (só D1) + legenda sans 12px uppercase ink (DS). HTML interno.
 *
 * #3101: `width="536"` em pixels absolutos (600px do container − 32px×2 do
 * padding lateral da seção, PAD_LEAD/PAD_SECTION) além do `style width:100%`.
 * O Outlook desktop (motor Word) não honra `width` percentual em `<img>` —
 * renderiza no tamanho intrínseco do arquivo (hero é 1600×800), estourando o
 * wrapper de 600px mesmo com o `<!--[if mso]-->` da tabela externa. Clientes
 * modernos continuam responsivos via `style="width:100%;height:auto"`.
 */
export function renderHeroImageInner(placeholder: string, alt = "", caption = imageGeneratorCredit()): string {
  return `<img class="hero" src="{{IMG:${placeholder}}}" alt="${esc(alt)}" width="536" style="display:block;width:100%;height:auto;border-radius:6px;margin-top:24px;" border="0"/>
  <p style="margin:10px 0 0;font-family:${FONT_LABEL};font-size:12px;letter-spacing:${LS_LABEL};text-transform:uppercase;color:${TEXT_COLOR};">${esc(caption)}</p>`;
}

/** Parágrafos do corpo: sans 16px line-height 1.62 ink (DS). HTML interno.
 * #2456: margem entre parágrafos consecutivos reduzida de 16px → 8px.
 * O primeiro parágrafo mantém 18px (espaço após manchete/hero). */
export function renderBodyParasInner(text: string): string {
  return text
    .split(/\n\n+/)
    .filter((p) => p.trim())
    .map(
      (p, i) =>
        bodyP(`${i === 0 ? "18px" : "8px"} 0 0`, renderBodyInline(p.trim())),
    )
    .join("\n  ");
}

/** "Por que isso importa": box "contorno" do DS (papel + borda bege + kicker
 * ponto teal / label ink, #3104 — era label teal, ~3.2:1, abaixo de AA). HTML interno. */
export function renderWhyBoxInner(text: string): string {
  if (!text || !text.trim()) return "";
  const body = text.split(/\n\n+/).filter((p) => p.trim()).map((p) => escText(p.trim())).join("<br><br>");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;border-collapse:separate;border-spacing:0"><tr>
    <td style="background:${PAPER};border:1px solid ${RULE};border-radius:12px;padding:${PAD_BOX_OUTLINE};">
      <p style="margin:0 0 10px;font-family:${FONT_LABEL};font-size:12px;font-weight:bold;letter-spacing:${LS_LABEL};text-transform:uppercase;color:${TEXT_COLOR};">${tealDot()}&nbsp;Por que isso importa</p>
      ${bodyP("0", body)}
    </td>
  </tr></table>`;
}

/**
 * #1093: bloco de cobertura no topo do email. Tipograficamente discreto —
 * cinza médio, itálico, sem box ou border — pra não competir com o primeiro
 * destaque. Aparece logo após o header gerado pelo template Beehiiv (título +
 * subtítulo) e antes do primeiro destaque.
 */
export function renderCoverage(text: string): string {
  // #1936 (DS): INTRO = parágrafo sans ink (não mais cinza itálico). Primeira
  // seção, padding 44px 32px 8px.
  return `<!-- INTRO (coverage) -->
<tr><td class="pad" style="padding:44px 32px 8px;">
  ${bodyP("0", escText(text))}
</td></tr>`;
}

/**
 * #1648: CTA de destaque no topo (ex: convite pro sorteio ao vivo). DS: box
 * "painel" (bege), texto peso 600. Links via processInlineLinks (underline teal).
 *
 * #2136: callout patrocinado (📣) multi-parágrafo → último link vira botão
 * pill DS centralizado (bg paper, borda bege, radius 999px, Geist bold 16px,
 * padding 12px 22px, SEM seta). Parágrafos anteriores ao último (que é só o
 * link/CTA) ficam no corpo normal. Para o parágrafo que seja só `→ [label](url)`
 * ou `[label](url)` (sem outro texto), o parágrafo inteiro vira o botão e não
 * é emitido como `<p>` de corpo — evita `→` orphan e <p> vazio.
 *
 * #2797: `forceCtaPill` ativa o mesmo botão pill do último parágrafo CTA-only
 * em callouts NÃO-patrocinados. Usado pelo box de divulgação em formato 🛒 — que reusa este
 * render sem o marcador 📣 (logo `sponsored=false`) mas quer o CTA como pill
 * centralizado (ex: box Alexa+ "Conhecer a Alexa+ e ver as ofertas"). Sem 📣,
 * NÃO adiciona o separador "Divulgação" (o box de divulgação já tem o seu).
 */

/** #3374: parágrafo é lista quando TODA linha não-vazia começa com `- `/`* `. */
function isBulletParagraph(p: string): boolean {
  const lines = p.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => /^[-*]\s+/.test(l));
}

/**
 * #3374: `- item`/`* item` (1 por linha) → `<ul><li>` real. Usado no corpo
 * multi-parágrafo do box de divulgação (ex: lista de benefícios do programa
 * de apoio) — `<ul>`/`<li>` com estilo inline renderiza bem nos principais
 * clientes de e-mail (Gmail, Apple Mail, Outlook web/desktop moderno).
 */
function renderBulletList(p: string, marginTop: string): string {
  const items = p
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[-*]\s+/, ""));
  const lis = items
    .map(
      (item) =>
        `<li style="margin:0 0 6px;font-family:${FONT_BODY};font-size:16px;line-height:1.5;color:${TEXT_COLOR};">${processInlineLinks(item)}</li>`,
    )
    .join("\n        ");
  return `<ul style="margin:${marginTop} 0 0;padding-left:20px;">\n        ${lis}\n      </ul>`;
}

export function renderIntroCallout(
  text: string,
  titleStyle: "serif" | "body" = "serif",
  forceCtaPill = false,
  bold = true,
): string {
  // #1938: split em parágrafos (`\n\n`). Callout de 1 parágrafo (intro/sorteio)
  // mantém o comportamento antigo (negrito, emoji preservado). Bloco
  // multi-parágrafo (ex: divulgação CLARICE reaproveitada da mensal) segue o DS:
  // 1º parágrafo = título serif (emoji de marcação removido), demais = corpo
  // peso normal; os links já saem em negrito via processInlineLinks.
  const sponsored = isSponsoredCallout(text);
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let inner: string;
  if (paras.length > 1) {
    // multi-parágrafo: 1º = título (marcador 📣/📚/🎉 removido), demais = corpo normal.
    // titleStyle "serif" (default) = título serif grande (sponsored/mid callout);
    // "body" = mesmo tamanho do corpo, em negrito (intro 🎉 — pedido do editor 260701).
    const title = stripCalloutMarker(paras[0]);
    // #260701 review: estilo do header body-size (título + sub-cabeçalho) num só
    // lugar — evita divergência silenciosa entre os 2 usos (cf. lbStyle em renderEIA).
    const bodyHeadingStyle = `font-family:${FONT_HEADING};font-weight:600;font-size:16px;line-height:1.4;color:${TEXT_COLOR};`;
    const titleHtml = titleStyle === "body"
      ? `<p style="margin:0 0 10px;${bodyHeadingStyle}">${processInlineLinks(title)}</p>`
      : `<p style="margin:0 0 14px;font-family:${FONT_HEADING};font-size:26px;line-height:1.2;color:${TEXT_COLOR};">${processInlineLinks(title)}</p>`;

    // #2136: callout patrocinado → verifica se ALGUM parágrafo é só o link CTA
    // (possivelmente prefixado por `→ ` ou `Acesse `). Se sim, extrai o link
    // como botão pill centralizado; remove-o dos parágrafos de corpo. Parágrafos
    // ANTES do CTA seguem como corpo acima do botão; parágrafos DEPOIS (ex: um
    // disclosure de comissão/afiliado) seguem como corpo ABAIXO do botão (#2996
    // — antes só o ÚLTIMO parágrafo virava pill, quebrando o botão quando havia
    // texto de disclosure depois dele).
    let bodyParas = paras.slice(1);
    let afterCtaParas: string[] = [];
    let ctaButtonHtml = "";
    if (sponsored || forceCtaPill) {
      for (let idx = 0; idx < bodyParas.length; idx++) {
        const para = bodyParas[idx];
        // Strip `→ ` / `Acesse ` prefix antes de testar se sobrou só um link.
        const stripped = para.replace(/^(?:→\s*|Acesse\s+)/u, "").trim();
        const links = findMarkdownLinks(stripped);
        if (links.length === 0) continue;
        // #260622: o parágrafo é "só CTAs" quando, removidos TODOS os links e os
        // separadores (·/•/| + pontuação/seta), não sobra texto substancial.
        // Suporta múltiplos botões (ex: "→ [Livros](u1) · [Cursos](u2)").
        let rem = stripped;
        for (let k = links.length - 1; k >= 0; k--) {
          rem = rem.slice(0, links[k].start) + rem.slice(links[k].end);
        }
        const onlyCtas = rem.replace(/[·•|,.!?…\s→]/gu, "").trim() === "";
        if (!onlyCtas) continue;

        if (links.length > 1) {
          // Múltiplos CTAs → 1 pill por link (margin entre eles).
          const pills = links
            .map(
              (l) =>
                `<a href="${esc(l.url)}" style="display:inline-block;background:${COLORS.paper};border:1px solid ${RULE};border-radius:999px;color:${TEXT_COLOR};font-family:${FONT_BODY};font-weight:bold;font-size:16px;text-decoration:none;padding:12px 22px;margin:0 4px 8px;">${esc(l.label)}</a>`,
            )
            .join("");
          ctaButtonHtml = `<tr><td style="padding:16px 20px 0;text-align:center;">${pills}</td></tr>`;
        } else {
          // 1 link (+ possível pontuação) → botão pill único.
          // (#finding-4: label vem do campo `label` de findMarkdownLinks, dedup com renderMidCallout)
          const firstLink = links[0];
          const safeLabel = esc(firstLink.label);
          const safeHref = esc(firstLink.url);
          ctaButtonHtml = `<tr><td style="padding:16px 20px 0;text-align:center;">` +
            `<a href="${safeHref}" style="display:inline-block;background:${COLORS.paper};border:1px solid ${RULE};border-radius:999px;color:${TEXT_COLOR};font-family:${FONT_BODY};font-weight:bold;font-size:16px;text-decoration:none;padding:12px 22px;">${safeLabel}</a>` +
            `</td></tr>`;
        }
        afterCtaParas = bodyParas.slice(idx + 1).map((p) => p.replace(/^→\s*/u, ""));
        bodyParas = bodyParas.slice(0, idx);
        break;
      }
      if (!ctaButtonHtml && bodyParas.length > 0) {
        // #finding-2: nenhum parágrafo qualificou como CTA-only — strip `→ `
        // prefix do último parágrafo pra não deixar seta órfã no corpo.
        bodyParas = [
          ...bodyParas.slice(0, -1),
          bodyParas[bodyParas.length - 1].replace(/^→\s*/u, ""),
        ];
      }
    }

    // #260701: quando titleStyle="body" (intro 🎉), um parágrafo inteiramente em
    // negrito (`**Sorteio**`) vira sub-cabeçalho com o MESMO estilo do título
    // (body 16px, peso 600) — pedido do editor para o box de campeões/sorteio.
    const bodyHtml = bodyParas
      .map((p, i) => {
        const mt = i === 0 ? "0" : "12px";
        // #3374: bloco de lista (`- item`/`* item`) vira `<ul><li>` real.
        if (isBulletParagraph(p)) {
          return renderBulletList(p, mt);
        }
        const fullBold = titleStyle === "body" &&
          /^\*\*[^*][\s\S]*\*\*$/.test(p) && !p.slice(2, -2).includes("**");
        if (fullBold) {
          return `<p style="margin:${mt} 0 0;${bodyHeadingStyle}">${processInlineLinks(p.slice(2, -2))}</p>`;
        }
        return bodyP(`${mt} 0 0`, processInlineLinks(p));
      })
      .join("\n      ");
    // #finding-3: bodyHtml vazio não deve deixar whitespace no inner.
    inner = bodyHtml ? `${titleHtml}\n      ${bodyHtml}` : titleHtml;

    if (ctaButtonHtml) {
      // #2996: parágrafos DEPOIS do CTA (ex: disclosure de comissão) renderizam
      // como corpo normal ABAIXO do botão, numa linha própria dentro do box.
      // #3391: mesma checagem de lista (`- item`) do bodyHtml acima — sem isso,
      // uma lista depois do CTA saía como texto corrido com hífen literal.
      const afterCtaHtml = afterCtaParas
        .map((p, i) => {
          const mt = i === 0 ? "12px" : "8px";
          if (isBulletParagraph(p)) {
            return renderBulletList(p, mt);
          }
          return bodyP(`${mt} 0 0`, processInlineLinks(p));
        })
        .join("\n      ");
      // Botão pill em linha separada dentro do mesmo box, centralizado.
      return `<!-- #1648 intro callout (sorteio/CTA) -->
<tr><td class="pad" style="padding:8px 32px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};border-radius:12px;">
    <tr><td style="padding:16px 20px;">
      ${inner}
    </td></tr>
    ${ctaButtonHtml}${afterCtaHtml ? `\n    <tr><td style="padding:12px 20px 0;">${afterCtaHtml}</td></tr>` : ""}
    <tr><td style="padding:0 0 16px;"></td></tr>
  </table>
</td></tr>`;
    }
  } else {
    // 1 parágrafo: anúncio (📣) tem o marcador removido — o separador "Divulgação"
    // já rotula (#1942 review #3). 🎉/📚 preservam o emoji decorativo.
    // #3373: peso de fonte segue `bold` (default true = visual histórico).
    const single = paras[0] ?? text;
    const only = sponsored ? stripCalloutMarker(single) : single;
    inner = `<p style="margin:0;font-family:${FONT_BODY};font-weight:${bold ? 600 : 400};font-size:16px;line-height:1.5;color:${TEXT_COLOR};">${processInlineLinks(only)}</p>`;
  }
  return `<!-- #1648 intro callout (sorteio/CTA) -->
<tr><td class="pad" style="padding:8px 32px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};border-radius:12px;">
    <tr><td style="padding:16px 20px;">
      ${inner}
    </td></tr>
  </table>
</td></tr>`;
}

/**
 * Acha os links markdown `[texto](url)` de `s` com parsing de parênteses
 * balanceados (#1634 — a regex ingênua `\(([^)]+)\)` trunca URLs que contêm
 * parênteses, ex: `...(1).pdf`). Retorna {url, start, end} na ordem de aparição;
 * `end` é exclusivo (índice logo após o `)` de fechamento).
 */
export function findMarkdownLinks(
  s: string,
): { url: string; label: string; start: number; end: number }[] {
  const out: { url: string; label: string; start: number; end: number }[] = [];
  const linkStart = /\[([^\]]+)\]\(/g;
  let m: RegExpExecArray | null;
  while ((m = linkStart.exec(s)) !== null) {
    const label = m[1];
    const destStart = m.index + m[0].length;
    let depth = 0;
    let j = destStart;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (j >= s.length) continue; // sem `)` de fechamento — não é link válido
    out.push({ url: s.slice(destStart, j).trim(), label, start: m.index, end: j + 1 });
    linkStart.lastIndex = j + 1;
  }
  return out;
}

/**
 * #3204: decide se o box de divulgação usa o formato "carrinho" (CTA pill
 * centralizado, via `renderIntroCallout(forceCtaPill=true)`) por ESTRUTURA do
 * conteúdo — não por um allowlist de marcador emoji. Sinais:
 *   - legado: box começa com o marcador carrinho 🛒 — comportamento
 *     pré-#3204 preservado (compat com hábito editorial/edições antigas);
 *     `forceCtaPill=true` é seguro mesmo se nenhum parágrafo qualificar como
 *     CTA-only (renderIntroCallout degrada graciosamente pra no-op nesse caso).
 *   - estrutural: 2+ links no total no box (#3028 — prateleira com múltiplos
 *     títulos), OU QUALQUER parágrafo é SÓ um link (opcionalmente prefixado
 *     por `→`/`Acesse`) — mesmo critério que `renderIntroCallout` já usa
 *     internamente pra decidir o pill de um CTA-only paragraph (#2797),
 *     generalizado pro dispatcher e sem exigir que seja o ÚLTIMO parágrafo
 *     (um box pode ter um parágrafo de disclosure DEPOIS do CTA, #2996).
 * Sem o sinal estrutural, um box novo sem marcador emoji reconhecido nunca
 * ganharia o tratamento carrinho/pill.
 */
function shouldForceCtaPill(box: string): boolean {
  if (/^\s*🛒/u.test(box)) return true;
  if (findMarkdownLinks(box).length >= 2) return true;
  const paras = box.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length <= 1) return false;
  return paras.some((p) => {
    const stripped = p.replace(/^(?:→\s*|Acesse\s+)/u, "").trim();
    const links = findMarkdownLinks(stripped);
    if (links.length === 0) return false;
    let rem = stripped;
    for (let k = links.length - 1; k >= 0; k--) {
      rem = rem.slice(0, links[k].start) + rem.slice(links[k].end);
    }
    return rem.replace(/[·•|,.!?…\s→]/gu, "").trim() === "";
  });
}

/**
 * #2978/#3204: dispatcher único pros 2 boxes de divulgação (slot 1 = gap
 * D1/D2, slot 2 = gap D2/D3). O FORMATO é decidido pela ESTRUTURA do próprio
 * box (`shouldForceCtaPill`), não pelo slot nem por um marcador emoji
 * reconhecido: conteúdo "carrinho" (CTA-only no fim, ou 2+ links) → prateleira
 * multi-parágrafo com CTA pill (reusa `renderIntroCallout` com
 * `forceCtaPill=true`; um eventual marcador legado 🛒/📚 é removido do HTML);
 * qualquer outro conteúdo → bold-line/mid-callout (reusa `renderMidCallout`,
 * que aceita imagem opcional — #2978-slot2-parity: agora nos 2 slots). Ambos
 * os slots chamam este dispatcher.
 *
 * `bold` (#3373): peso de fonte do box SÓ-TEXTO (sem imagem, sem CTA pill) —
 * `true` (default) reproduz o visual histórico; `false` quando a fonte do box
 * é texto plano (sem `**...**` embrulhando o bloco inteiro). Não afeta o path
 * com imagem/CTA pill, que já tem peso próprio hardcoded por estrutura.
 */
export function renderBoxDivulgacao(
  box: string,
  imageUrl: string | null = null,
  bold = true,
): string {
  if (shouldForceCtaPill(box)) {
    // Remove um eventual marcador estrutural legado (🛒/📚) da 1ª linha antes
    // de renderizar — não deve vazar cru no HTML. `\r?\n?` cobre o marcador
    // sozinho na própria linha, pra não deixar um `\n` órfão que vira um
    // <p></p> vazio no topo do box. Marcadores novos (sem allowlist) não são
    // stripados aqui — ficam como texto decorativo no título, igual ao
    // comportamento já existente pra 🎉/📚 no path sem CTA pill.
    return renderIntroCallout(box.replace(/^\s*(?:🛒|📚)[ \t]*\r?\n?/u, ""), "serif", true, bold);
  }
  return renderMidCallout(box, imageUrl, bold);
}

/**
 * Box de divulgação (slot 1 gap D1/D2 OU slot 2 gap D2/D3, #2978-slot2-parity)
 * com imagem proeminente + texto + botão CTA. Sem imagem → cai no box
 * só-texto (renderIntroCallout, repassando `bold` — #3373). Extrai o link
 * `[texto](url)` do próprio box pra usar na imagem clicável e no botão.
 */
export function renderMidCallout(text: string, imageUrl: string | null, bold = true): string {
  if (!imageUrl) return renderIntroCallout(text, "serif", false, bold);
  // #1634-safe: parênteses balanceados em vez de `\(([^)]+)\)`. Primeiro link
  // vira destino da imagem clicável + botão; TODOS os links saem do corpo.
  // #2067: anchor text do 1º link → alt da imagem + label do CTA (genérico).
  const links = findMarkdownLinks(text);
  const firstLink = links.length ? links[0] : null;
  const link = firstLink ? firstLink.url : null;
  // #finding-4: label vem do campo `label` de findMarkdownLinks (dedup com renderIntroCallout).
  const firstLinkLabel = firstLink ? firstLink.label : "";
  let body = text;
  for (let i = links.length - 1; i >= 0; i--) {
    let { start, end } = links[i];
    // #2136: engole também `→ ` / `Acesse ` literais imediatamente antes do link
    // (além do whitespace genérico) — evita seta orphan no corpo pós-strip.
    while (start > 0 && /\s/.test(body[start - 1])) start--;
    // Recua mais para consumir `→` ou `Acesse` imediatamente antes do espaço.
    const prefix = body.slice(0, start);
    const arrowMatch = prefix.match(/(?:→|Acesse)\s*$/u);
    if (arrowMatch) start -= arrowMatch[0].length;
    if (body[end] === ".") end++; // e o ponto final do markdown-link
    body = body.slice(0, start) + body.slice(end);
  }
  body = body.trim();
  // esc() nos atributos: imageUrl vem do cache e link do reviewed.md — escapar
  // `"`/`<`/`>`/`&` evita quebrar o atributo HTML (#code-review 1807).
  const safeImg = esc(imageUrl);
  const safeLink = link ? esc(link) : null;
  // #2067: alt e label do CTA derivados do anchor text do 1º link no texto do box.
  // #2136: sem seta no ctaLabel (decisão do editor 260612).
  const ctaLabel = firstLinkLabel ? esc(firstLinkLabel) : "Acesse";
  const imgAlt = firstLinkLabel ? esc(firstLinkLabel) : "";
  // #3101: width="536" em pixels (600px container − 32px×2 padding lateral do
  // `<td class="pad" style="padding:8px 32px 0">` que envolve este box — sem
  // padding adicional na table interna antes da imagem). Outlook desktop
  // ignora width percentual em <img> e renderia no tamanho intrínseco.
  const imgTag = `<img src="${safeImg}" width="536" alt="${imgAlt}" style="display:block;width:100%;height:auto;border:0;border-radius:6px 6px 0 0;" />`;
  const imgBlock = safeLink ? `<a href="${safeLink}" style="text-decoration:none;">${imgTag}</a>` : imgTag;
  const cta = safeLink
    ? `<a href="${safeLink}" style="display:inline-block;background:${COLORS.paper};border:1px solid ${RULE};border-radius:999px;color:${TEXT_COLOR};font-family:${FONT_BODY};font-weight:bold;font-size:16px;text-decoration:none;padding:12px 22px;">${ctaLabel}</a>`
    : "";
  // #1942 review #2: corpo multi-parágrafo não vira blocão. >1 parágrafo → 1º =
  // título serif (marcador removido) + demais peso normal, igual ao caminho
  // sem imagem (#1938). 1 parágrafo: a imagem já identifica a promo — marcador
  // (📣/📚/🎉) removido e corpo no estilo de texto do DS (peso normal, 1.62),
  // não o bold 600 herdado do box texto-puro (pedido do editor, 260611).
  const bodyParas = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  // review #2066: corpo que era só marcador+link fica vazio pós-strip — sem o
  // guard, sairia um <p> fantasma com 12px de margem entre a imagem e o CTA.
  const singleBody = stripCalloutMarker(body);
  const bodyHtml =
    bodyParas.length > 1
      ? `<p style="margin:0 0 12px;font-family:${FONT_HEADING};font-size:26px;line-height:1.2;color:${TEXT_COLOR};">${processInlineLinks(stripCalloutMarker(bodyParas[0]))}</p>\n      ` +
        bodyParas
          .slice(1)
          .map(
            (p, i) =>
              bodyP(`${i === 0 ? "0" : "12px"} 0 0`, processInlineLinks(p))
          )
          .join("\n      ")
      : singleBody
        ? bodyP("0 0 12px", processInlineLinks(singleBody))
        : "";
  return `<!-- mid callout com imagem -->
<tr><td class="pad" style="padding:8px 32px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};border-radius:12px;">
    <tr><td style="padding:0;line-height:0;font-size:0;">${imgBlock}</td></tr>
    <tr><td style="padding:16px 20px;">
      ${bodyHtml}
      ${cta ? `<div style="text-align:center;margin-top:12px;">${cta}</div>` : ""}
    </td></tr>
  </table>
</td></tr>`;
}

export function renderDestaque(d: RenderDestaque): string {
  // #1936 (DS email template): seção = uma linha padded (32px lateral). Estrutura:
  // kicker (●+régua) → manchete Georgia 26px (underline teal) → imagem hero
  // (#1077: D1; #2133/#2141: D1/D2/D3 todos com hero 2:1) → parágrafos sans →
  // box "Por que isso importa". Sem <hr> separador (cada seção abre com kicker).
  // Hero usa sempre o arquivo 2:1 — D1 já era "04-d1-2x1.jpg"; D2/D3 passam a
  // usar "04-d{N}-2x1.jpg" gerado pelo Stage 3 (#2133/#2141).
  const heroFile = `04-d${d.n}-2x1.jpg`;
  const pad = d.n === 1 ? PAD_LEAD : PAD_SECTION;
  const inner = [
    renderKicker(d.category),
    renderHeadlineInner(d.title, d.url),
    renderHeroImageInner(heroFile, d.title),
    renderBodyParasInner(d.body),
    renderWhyBoxInner(d.why),
  ].filter(Boolean).join("\n  ");
  return `<!-- Destaque ${d.n} -->
<tr><td class="pad" style="padding:${pad};">
  ${inner}
</td></tr>`;
}

export function renderEIA(eia: EIA): string {
  const creditHtml = processInlineLinks(eia.credit);
  // Leaderboard (#1160): linha "🏆 Vencedores…" sans ink dentro do painel.
  // #3103: 12px → 16px (não 14px — o type-scale do e-mail só permite
  // {12,16,22,26}px, cf. test/email-type-scale-white-shell.test.ts). Resultado
  // da última edição + CTA pro leaderboard são a mecânica central de
  // engajamento recorrente (loop resultado→ranking), não um rodapé qualquer —
  // mereciam mais peso visual que o crédito da imagem (que continua 12px, ver
  // abaixo). 16px = mesmo tamanho do corpo/título do painel ("Clique na imagem
  // que foi gerada por IA."), dando à linha o mesmo peso do texto principal.
  const lbStyle = `margin:8px 0 0;font-family:${FONT_BODY};font-size:16px;line-height:1.5;color:${TEXT_COLOR};`;
  const leaderboardRow = renderLeaderboardTop1Row(eia, lbStyle);
  // #1970: link persistente pra leaderboard em TODA edição (pódio acima é 1ª-do-mês).
  const leaderboardLinkRow = renderLeaderboardLinkRow(lbStyle);

  // #1630: "Resultado da última edição: X% acertaram", no rodapé do painel.
  // #3220: destylizado a pedido do editor — pra ler como frase comum, não como
  // label gritado. Antes (herdado do padrão kicker/whyBox de #3103/#3104) era
  // bold+uppercase+letter-spacing+ponto teal; agora é parágrafo de corpo puro,
  // desacoplado desse padrão.
  const prevResultHtml = eia.prevResultLine
    ? `\n      <tr><td><p style="margin:6px 0 0;font-family:${FONT_BODY};font-size:16px;line-height:1.5;color:${TEXT_COLOR};">${processInlineLinks(eia.prevResultLine)}</p></td></tr>`
    : "";

  const buildVoteUrl = (choice: "A" | "B") =>
    `${POLL_WORKER_URL}/vote?email={{email}}&edition=${eia.edition}&choice=${choice}`;
  // #2541: imagens A/B empilhadas (1 coluna), A acima de B, em desktop e mobile.
  const eiaChoice = (choice: "A" | "B", imgFile: string, paddingTop?: string) => {
    // #3101: width="480" em pixels (600px container − 32px×2 padding da seção
    // − 28px×2 padding do painel `background:${SURFACE}...padding:24px 28px`
    // em que o É IA? é envolvido). Sem isso, Outlook desktop renderiza no
    // tamanho intrínseco (800×450) e estoura o wrapper de 600px.
    const img = `<img src="{{IMG:${imgFile}}}" alt="Imagem ${choice}" width="480" style="display:block;width:100%;height:auto;border-radius:6px;" border="0"/>`;
    const inner = eia.edition
      ? `<a href="${buildVoteUrl(choice)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">${img}</a>`
      : img;
    const style = paddingTop ? `padding-top:${paddingTop};` : "";
    return `<tr><td${style ? ` style="${style}"` : ""}>${inner}</td></tr>`;
  };

  return `<!-- É IA? (poll) -->
<tr><td class="pad" style="padding:${PAD_SECTION};">
  ${renderKicker("É IA?")}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;border-collapse:separate;border-spacing:0"><tr>
    <td style="background:${SURFACE};border-radius:12px;padding:24px 28px;">
      <p style="margin:0;font-family:${FONT_HEADING};font-size:26px;line-height:1.2;color:${TEXT_COLOR};">Clique na imagem que foi gerada por IA</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;">
        ${eiaChoice("A", eia.imageA)}
        ${eiaChoice("B", eia.imageB, "16px")}
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td>
        <!-- #3103: crédito da imagem continua 12px (linha secundária, não faz
             parte do loop de engajamento resultado→leaderboard). -->
        <p style="margin:16px 0 0;font-family:${FONT_BODY};font-size:12px;line-height:1.5;color:${TEXT_COLOR};">${creditHtml}</p>
      </td></tr>${prevResultHtml}
${leaderboardRow}
${leaderboardLinkRow}
      </table>
    </td>
  </tr></table>
</td></tr>`;
}

/**
 * Pure (#1160): renderiza linha do leaderboard no rodapé do È IA?.
 * Inclui leitores até o 3º lugar (dense rank) na mesma ordem do leaderboard
 * público. #1646: posições ordinais por acertos, sem percentual nem % de ranking.
 *
 * Formato:
 *   - 1 leader: "🏆 Vencedores de Maio: 1º Davyd Wilkerson"
 *   - 2 leitores: "🏆 Vencedores de Maio: 1º Davyd, 2º Luisao P"
 *   - 3+ leitores: "🏆 Vencedores de Maio: 1º Davyd, 2º Luisao P, 3º Vanessa"
 *   - Vazio (1ª edição do mês): convite linkado pra leaderboard do mês, ou ""
 *
 * Prefere `leaderboardPodium` (ranks 1-3); cai em `leaderboardTop1` (rank 1
 * only) pra compat com arquivos legacy.
 */
export function renderLeaderboardTop1Row(eia: EIA, paragraphStyle: string): string {
  // Source: prefere podium (#1160 followup), cai em top1 legacy. Preserva o
  // rank pra exibir posições ordinais (1º, 2º, 3º). #1646: ranking por acertos.
  const ranked: { nickname: string; rank: number }[] =
    eia.leaderboardPodium && eia.leaderboardPodium.length > 0
      ? eia.leaderboardPodium.map((e) => ({ nickname: e.nickname, rank: e.rank }))
      : eia.leaderboardTop1 && eia.leaderboardTop1.length > 0
        // #1672: `top1` (worker computeTop1) são TODOS líderes em rank 1 —
        // empatados (mesmo pct E mesmo correct, sem campo rank). Atribuir rank 1 a
        // todos, não i+1, senão fabricamos 2º/3º (ordem alfabética acidental) pra
        // quem empatou em 1º.
        ? eia.leaderboardTop1.map((e) => ({ nickname: e.nickname, rank: 1 }))
        : [];
  const period = eia.leaderboardPeriod ? ` de ${eia.leaderboardPeriod}` : "";
  // URL histórica permanente do mês (#1345). Linka o bloco quando o slug existe.
  const slug = eia.leaderboardPeriodSlug || "";
  const lbUrl = slug ? `${POLL_WORKER_URL}/leaderboard/${slug}` : "";
  const linkStyle = `color:${TEAL};text-decoration:underline;font-weight:bold;`;

  // Sem líderes ainda (ex: 1ª edição do mês) — em vez de omitir o bloco,
  // convidar o leitor pra acompanhar a leaderboard do mês na URL histórica.
  if (ranked.length === 0) {
    if (!lbUrl) return "";
    const label = eia.leaderboardPeriod
      ? `Acompanhe a leaderboard de ${eia.leaderboardPeriod}`
      : "Acompanhe a leaderboard do mês";
    return `      <tr><td align="left" style="padding:8px 0 0 0;">
        <p style="${paragraphStyle}">🏆 <a href="${lbUrl}" target="_blank" rel="noopener noreferrer" style="${linkStyle}">${esc(label)}</a></p>
      </td></tr>`;
  }

  // Posições ordinais: "1º Bruna Quevedo, 2º Joshu, 3º Ana Cândida".
  const phrase = ranked
    .map((e) => `${e.rank}º ${esc(e.nickname)}`)
    .join(", ");

  // Quando há slug, o título "Vencedores de {mês}" vira link pra leaderboard histórica.
  const heading = lbUrl
    ? `<a href="${lbUrl}" target="_blank" rel="noopener noreferrer" style="${linkStyle}">Vencedores${period}</a>`
    : `<strong>Vencedores${period}</strong>`;

  return `      <tr><td align="left" style="padding:8px 0 0 0;">
        <p style="${paragraphStyle}">🏆 ${heading}: ${phrase}</p>
      </td></tr>`;
}

/**
 * Pure (#1970): link PERSISTENTE pra leaderboard pública no rodapé do É IA?.
 * Renderiza em TODA edição (não só na 1ª do mês — o pódio/convite de
 * `renderLeaderboardTop1Row` é 1ª-do-mês, #1753). Estático, sem fetch: aponta
 * pra raiz `/leaderboard` (sempre mostra o ranking vigente, sem precisar do
 * slug do mês). Dá ao leitor um ponto de entrada estável pro ranking de quem
 * mais acerta o "É IA?" toda edição.
 */
export function renderLeaderboardLinkRow(paragraphStyle: string): string {
  const url = `${POLL_WORKER_URL}/leaderboard`;
  // #3103: `display:inline-block;padding:4px 0` engorda a área de toque do CTA
  // (era só o texto do link, sem padding — alvo de toque apertado em mobile).
  const linkStyle = `color:${TEAL};text-decoration:underline;font-weight:bold;display:inline-block;padding:4px 0;`;
  return `      <tr><td align="left" style="padding:8px 0 0 0;">
        <p style="${paragraphStyle}">Veja o ranking de quem mais acerta → <a href="${url}" target="_blank" rel="noopener noreferrer" style="${linkStyle}">leaderboard</a></p>
      </td></tr>`;
}

/**
 * Item de lista (Use melhor / Lançamentos / Radar) no padrão DS: título Georgia
 * 22px com underline teal + descrição sans ink. Itens separados por spacer 22px
 * (exceto o primeiro). Retorna um `<tr>` com o item; HTML interno do bloco.
 */
export function renderSectionItem(item: SectionItem, first: boolean): string {
  const titleHtml = item.url
    ? `<a href="${esc(item.url)}" style="font-family:${FONT_HEADING};font-size:22px;line-height:1.14;color:${TEXT_COLOR};text-decoration:none;border-bottom:1px solid ${TEAL};" target="_blank" rel="noopener noreferrer nofollow">${esc(item.title)}</a>`
    : `<span style="font-family:${FONT_HEADING};font-size:22px;line-height:1.14;color:${TEXT_COLOR};">${esc(item.title)}</span>`;
  const spacer = first ? "" : `<div style="height:22px;line-height:22px;font-size:0;">&nbsp;</div>`;
  const desc = item.description
    ? `\n      ${bodyP("7px 0 0", esc(item.description))}`
    : "";
  return `<tr><td style="padding:22px 0 0;">
      ${spacer}${titleHtml}${desc}
    </td></tr>`;
}

export function renderSection(section: Section): string {
  if (section.items.length === 0) return "";

  const itemsHtml = section.items
    .map((item, i) => renderSectionItem(item, i === 0))
    .join("\n    ");

  // #1070 + #1328: singular quando só tem 1 item. stripKickerEmoji remove o emoji
  // (DS usa ponto ●, não emoji).
  const displayName = displaySectionName(section.name, section.items.length);

  return `<!-- ${section.name} -->
<tr><td class="pad" style="padding:${PAD_SECTION};">
  ${renderKicker(displayName)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${itemsHtml}
  </table>
</td></tr>`;
}

/**
 * Converte markdown inline simples (links `[text](url)`, bold `**text**`)
 * em HTML. Cobre o que aparece em SORTEIO/PARA ENCERRAR. Não é parser
 * markdown completo — só o subset necessário pros 2 blocos.
 */
// #2008/#2018: applyWordJoiner importado de ./word-joiner.ts (shared helper).
// Ver scripts/lib/word-joiner.ts para documentação completa e GUARDED_DOMAINS.

export function mdInlineToHtml(s: string): string {
  // #1117: normalizar backslash escapes ASCII antes de qualquer parsing.
  const input = unescapeMd(s);
  // #2001 follow-up: usa findMarkdownLinks (paren-balanced) em vez de regex
  // ingênua `[^)]+` — URLs com `)` (ex: Wikipedia GPT-4_(language_model))
  // não são truncadas. Label extraído entre `[` e `](`; garantido sem `]`
  // pelo regex interno (`[^\]]+`).
  const links = findMarkdownLinks(input);
  const parts: string[] = [];
  let lastIdx = 0;
  for (const { url, start, end } of links) {
    // URL vazia `[texto]()` — preserva texto bruto, igual ao guard de processInlineLinks.
    if (!url) continue;
    const labelEnd = input.indexOf("]", start + 1);
    const label = input.slice(start + 1, labelEnd);
    // #2008: word-joiner aplicado nos segmentos de TEXTO (não no href da URL
    // nem no label do link — label já tem href explícito, sem risco de linkify).
    // #2532/#2533 review: wordmark também só nos segmentos de TEXTO (não no
    // label nem no href) — simétrico com processInlineLinks. Aplicado ANTES do
    // passo de `**` abaixo, então `**Diar.ia**` → `**{wordmark}**` → `<b>{wordmark}</b>`.
    parts.push(applyBrandWordmark(applyWordJoiner(input.slice(lastIdx, start))));
    // #3102: reusa inlineLinkHtml (mesmo tratamento de `processInlineLinks`/
    // `renderBodyInline` — underline teal via text-decoration-color). Antes,
    // mdInlineToHtml tinha seu PRÓPRIO estilo de link (border-bottom teal), que
    // degrada de forma diferente no Outlook (mantém a linha teal) vs o resto do
    // e-mail (degrada pra sublinhado cor-do-texto) — 2 tratamentos sem motivo
    // funcional no mesmo email.
    parts.push(inlineLinkHtml(label, url));
    lastIdx = end;
  }
  parts.push(applyBrandWordmark(applyWordJoiner(input.slice(lastIdx))));
  let out = parts.join("");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  return out;
}

/**
 * #1279: renderiza o reveal "Na última edição, ..." como callout box bordered
 * (1px solid #1a1a1a, border-radius 10px) — formato histórico usado em todas
 * edições publicadas no Beehiiv. Posicionado entre SORTEIO e PARA ENCERRAR.
 * Filtra: pega só parágrafo que começa com "Na última edição".
 */
export function renderErroIntencionalReveal(text: string): string {
  const reveal = pickErroIntencionalReveal(text);
  if (!reveal) return "";
  // DS: box "contorno" (papel + borda bege) logo abaixo dos parágrafos do
  // Sorteio — diferencia o reveal (informativo) dos painéis preenchidos.
  // Top padding pequeno (14px) pra encostar na seção acima, sem kicker próprio.
  return `<!-- ERRO INTENCIONAL — reveal -->
<tr><td class="pad" style="padding:14px 32px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0"><tr>
    <td style="background:${PAPER};border:1px solid ${RULE};border-radius:12px;padding:${PAD_BOX_OUTLINE};">
      ${bodyP("0", mdInlineToHtml(reveal))}
    </td>
  </tr></table>
</td></tr>`;
}

/**
 * Pure (#1076, #2080): bloco SORTEIO no padrão DS.
 *
 * #2080: kicker "🎁 SORTEIO" (●+régua) FORA do box (padrão de seção), corpo
 * DENTRO de um box "painel" do DS (fundo SURFACE bege #EBE5D0, sem borda,
 * border-radius 12px, padding 24px 28px) — análogo ao box do É IA?. Segue o
 * mesmo markup de painel usado em renderEIA e no CTA de renderEncerrar.
 *
 * O reveal "Na última edição…" vai num box contorno separado
 * (renderErroIntencionalReveal), que renderiza logo abaixo.
 */
export function renderSorteio(text: string): string {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());
  const innerHtml = paragraphs.map((p, i) =>
    bodyP(`${i === 0 ? "0" : "12px"} 0 0`, mdInlineToHtml(p.trim()))
  ).join("\n      ");
  return `<!-- Sorteio -->
<tr><td class="pad" style="padding:${PAD_SECTION};">
  ${renderKicker("Sorteio")}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;border-collapse:separate;border-spacing:0"><tr>
    <td style="background:${SURFACE};border-radius:12px;padding:24px 28px;">
      ${innerHtml}
    </td>
  </tr></table>
</td></tr>`;
}

/**
 * Pure (#1076): renderiza o bloco 🙋🏼‍♀️ PARA ENCERRAR. Lista `- item` no MD
 * vira `<ul><li>...`; resto vira parágrafos.
 */
export function renderEncerrar(text: string): string {
  const lines = text.split("\n");
  type Block = { type: "p" | "ul"; content: string[] };
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    const isLi = /^[-*]\s+/.test(line);
    if (isLi) {
      if (current?.type !== "ul") {
        if (current) blocks.push(current);
        current = { type: "ul", content: [] };
      }
      current.content.push(line.replace(/^[-*]\s+/, ""));
    } else {
      if (current?.type !== "p") {
        if (current) blocks.push(current);
        current = { type: "p", content: [] };
      }
      current.content.push(line);
    }
  }
  if (current) blocks.push(current);

  // #1148: último parágrafo (CTA "Agora que chegou...") vai numa caixa
  // estilo É IA? — fundo #FAFAFA, padding 32px/24px, border-radius 8px.
  // Heurística: separar último item dos blocos se for um `<p>` começando com
  // "Agora que chegou"; render o resto inline e o último envelopado em box.
  const lastBlock = blocks[blocks.length - 1];
  const isAgoraCta =
    lastBlock?.type === "p" &&
    /^agora que chegou/i.test(lastBlock.content.join(" ").trim());
  const mainBlocks = isAgoraCta ? blocks.slice(0, -1) : blocks;
  const ctaBlock = isAgoraCta ? lastBlock : null;

  // DS: lista `- [label](url)` vira PILLS (borda bege, radius 999px) precedidas
  // do rótulo "Acesse:". Parágrafos = sans ink com links underline teal.
  // #2138: font-size 12→16px (CTA no tamanho do corpo, alinhado c/ #2079).
  // #2139: centralizado via align="center" + margin:0 auto (Outlook word-renderer
  // ignora align= em <table> — ambos os atributos garantem centralização cross-client).
  // #2160: padding reduzido 18→14px pra caber 3 pills sem overflow em iPhone SE (320px).
  // Layout: pills ficam dentro de um único <td> como inline-block — o navegador/cliente
  // faz wrap natural quando a linha encher. Não usamos nowrap, não forçamos uma linha só.
  const pillStyle = `display:inline-block;border:1px solid ${RULE};border-radius:999px;padding:10px 14px;margin:0 6px 8px 0;font-family:${FONT_LABEL};font-size:16px;font-weight:bold;color:${TEXT_COLOR};text-decoration:none;`;
  const renderBlock = (b: { type: "p" | "ul"; content: string[] }) => {
    if (b.type === "ul") {
      const pills = b.content.map((c) => {
        const m = c.match(/^\[([^\]]+)\]\((.+)\)$/);
        // Link puro → pill clicável. Senão, mdInlineToHtml (links/bold inline)
        // pra NUNCA vazar markdown cru (invariante "output sem markdown").
        return m
          ? `<a href="${esc(m[2].trim())}" style="${pillStyle}">${esc(m[1])}</a>`
          : `<span style="${pillStyle}">${mdInlineToHtml(c)}</span>`;
      }).join("");
      // Pills numa única <td> permitem wrap natural — não forçamos nowrap.
      return `<p style="margin:22px 0 8px;font-family:${FONT_LABEL};font-size:12px;font-weight:bold;letter-spacing:${LS_LABEL};text-transform:uppercase;color:${TEXT_COLOR};">Acesse nossas curadorias:</p>
  <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td>${pills}</td></tr></table>`;
    }
    return bodyP("22px 0 0", mdInlineToHtml(b.content.join(" ")));
  };

  const html = mainBlocks.map(renderBlock).join("\n  ");

  // CTA final ("Agora que chegou…") = box "painel" do DS.
  const ctaBox = ctaBlock
    ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-collapse:separate;border-spacing:0"><tr>
    <td style="background:${SURFACE};border-radius:12px;padding:24px 28px;">
      ${bodyP("0", mdInlineToHtml(ctaBlock.content.join(" ")))}
    </td>
  </tr></table>`
    : "";

  return `<!-- Para encerrar -->
<tr><td class="pad" style="padding:40px 32px 8px;">
  ${renderKicker("Para encerrar")}
  ${html}${ctaBox}
</td></tr>`;
}

export function renderHTML(content: NewsletterContent, opts: RenderOpts = {}): string {
  const parts: string[] = [];

  // #1093: linha de cobertura no topo, antes do primeiro destaque. Graceful
  // skip quando ausente (edições antigas pré-#1095/#1097).
  if (content.coverageLine) {
    parts.push(renderCoverage(content.coverageLine));
  }

  // #1648: CTA de destaque (ex: sorteio ao vivo) logo após a coverage line.
  if (content.introCallout) {
    // #1942 review #1: disclosure também cobre anúncio (📣) colocado no topo.
    if (isSponsoredCallout(content.introCallout)) parts.push(renderDivulgacaoSeparator());
    // #260701 review: title "body" SÓ para callout editorial (🎉); patrocinado (📣)
    // mantém o serif 26px (consistente com os boxes de divulgação). Sem o gate, um 📣 no
    // intro regredia o título pra 16px e o fullBold-subheader disparava nele.
    parts.push(renderIntroCallout(
      content.introCallout,
      isSponsoredCallout(content.introCallout) ? "serif" : "body",
    ));
  }

  // #1077 — É IA? idealmente entre D2 e D3 (após i === 1), per memory
  // `feedback_beehiiv_sections.md` e convention pre-existente. Fallback
  // robusto (#1085): se destaques.length < 2 (test fixtures ou edições
  // atípicas), insere no fim do loop pra garantir que È IA? não seja
  // silenciosamente omitido.
  const includeEia = !!(!opts.excludeEia && content.eia.credit);
  let eiaInserted = false;
  for (let i = 0; i < content.destaques.length; i++) {
    parts.push(renderDestaque(content.destaques[i]));
    // #2978: box de divulgação slot 1 — SEMPRE na lacuna D1/D2 (após D1, i===0).
    // O formato (bold-line 📚/📣/🎉 ou carrinho 🛒) é decidido por
    // renderBoxDivulgacao, não pelo slot. TODO box de divulgação recebe o
    // kicker "● DIVULGAÇÃO" antes (260611, supersede #1940/#2069).
    if (content.boxDivulgacao1 && i === 0) {
      parts.push(renderDivulgacaoSeparator());
      parts.push(
        renderBoxDivulgacao(
          content.boxDivulgacao1,
          content.boxDivulgacao1Image ?? null,
          content.boxDivulgacao1Bold ?? true,
        ),
      );
    }
    // #2978: box de divulgação slot 2 — SEMPRE na lacuna D2/D3 (após D2, i===1).
    // Só existe em edições de 3 destaques (sem gap D2/D3 em edições de 2).
    if (content.boxDivulgacao2 && i === 1) {
      parts.push(renderDivulgacaoSeparator());
      // #2978-slot2-parity: passa a imagem (quando presente) igual ao slot 1 —
      // antes caía sempre em renderMidCallout(text, null) → degradava pro box
      // só-texto (sem imagem/CTA-pill) mesmo quando o box de livros caía aqui.
      parts.push(
        renderBoxDivulgacao(
          content.boxDivulgacao2,
          content.boxDivulgacao2Image ?? null,
          content.boxDivulgacao2Bold ?? true,
        ),
      );
    }
    // #2546: È IA? renderiza APÓS o ÚLTIMO destaque (D3 em edições de 3
    // destaques; D2 em edições de 2). Antes ficava fixo após o D2 (i === 1).
    if (includeEia && !eiaInserted && i === content.destaques.length - 1) {
      parts.push(renderEIA(content.eia));
      eiaInserted = true;
    }
  }
  if (includeEia && !eiaInserted) {
    parts.push(renderEIA(content.eia));
  }

  for (const section of content.sections) {
    parts.push(renderSection(section));
  }

  // #1076: blocos fixos do template Beehiiv (SORTEIO + PARA ENCERRAR).
  // Renderer só emite quando o reviewed.md tem o bloco (graceful skip).
  if (content.sorteio?.trim()) parts.push(renderSorteio(content.sorteio));
  // #1279: reveal "Na última edição..." renderiza entre SORTEIO e PARA ENCERRAR
  if (content.erroIntencional) parts.push(renderErroIntencionalReveal(content.erroIntencional));
  if (content.encerrar) parts.push(renderEncerrar(content.encerrar));

  // #1936/#1945 (DS): container do corpo, máx. 600px (email-safe — Outlook corta
  // acima disso, cf. checkWideTables). **#260629:** `width="100%"` + `max-width:600px`
  // como BASE (responsivo sem depender do `@media`). O Beehiiv às vezes remove o
  // `<style>` do htmlSnippet no build do e-mail, então a media query `.container
  // { width:100% }` não aplicava e o `width:600px` forçado ficava estreito/escalado
  // no mobile (editor reportou "largura estreita" no Gmail mobile, 260629). Com
  // `width:100%` o corpo preenche a largura disponível (mobile) e ainda cap em 600px
  // no desktop — sem precisar da media query. Sem os "trilhos" bege laterais
  // (#1945), fundo branco (#1943). Cada `part` é uma linha `<tr><td class="pad">`.
  const innerTable = `<table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${PAPER};">
${parts.join("\n")}
</table>`;
  // #260629 (b): wrapper MSO. O Outlook desktop IGNORA `max-width` e respeita o
  // atributo `width` — então com `width="100%"` o corpo iria a 100% da janela do
  // Outlook (perde o cap de 600). O conditional `<!--[if mso]>` embrulha o corpo
  // numa tabela fixa de 600 SÓ no Outlook; clientes modernos ignoram o comentário
  // e usam a tabela `width:100%`/`max-width:600`. Se o Beehiiv remover o comentário
  // (como faz com `<style>`), degrada pro `width:100%` — sem downside vs (a).
  const container = `<!--[if mso]><table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0"><tr><td width="600"><![endif]-->
${innerTable}
<!--[if mso]></td></tr></table><![endif]-->`;

  if (!opts.fullDocument) {
    // Fragmento pro Beehiiv: container + style (progressive enhancement).
    // #1945: wrapper externo branco (PAGE_BG) — sem faixas bege nas laterais.
    return `<!-- Diar.ia newsletter body — auto-generated by render-newsletter-html.ts -->
${DS_STYLE_BLOCK}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};"><tr><td align="center" style="padding:0;">
${container}
</td></tr></table>`;
  }

  // Documento completo (preview / email Worker-hosted): shell branco (#1945) + preheader.
  const preheader = esc(
    content.destaques.map((d) => d.title).filter(Boolean).slice(0, 2).join(" · "),
  );
  // #3104: paridade de dark mode com o mensal (#2645) — só neste caminho
  // (fullDocument), não no fragmento colado no Beehiiv. `content="light dark"`
  // (não só "light") nos DOIS metas — igual ao mensal — porque Apple Mail
  // trata um `color-scheme`/`supported-color-schemes` de valor único como "este
  // e-mail só suporta claro" e some com a regra de dark-canvas abaixo (não a
  // aplica de qualquer jeito); "light dark" é o que faz o Apple Mail de fato
  // honrar o `@media (prefers-color-scheme: dark)` autoral que segue no
  // <style> — sem isso a paridade com o mensal seria só de papel (self-review:
  // achado real, confirmado contra a documentação de dark mode em e-mail).
  // Risco prático de deixar o auto-dark-mode ligado é baixo hoje porque toda
  // cor do e-mail já é setada inline (nunca texto sem cor sobre fundo sem cor).
  return `<!doctype html>
<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>Diar.ia — Edição</title>
${DS_STYLE_BLOCK}
${DARK_CANVAS_STYLE_BLOCK}
</head>
<body style="margin:0; padding:0; background:${PAGE_BG};">
<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${preheader}</div>
<table role="presentation" class="ds-canvas" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};"><tr><td align="center" style="padding:0;">
${container}
</td></tr></table>
</body>
</html>`;
}

/**
 * #1046 — Render È IA? section standalone (em outer table própria), pra paste
 * via `editor.commands.insertContent({type: 'htmlSnippet', ...})` no TipTap
 * Beehiiv. Preserva merge tags `{{poll_a_url}}` / `{{poll_b_url}}` que
 * paste-handler normalizaria a empty hrefs.
 *
 * Retorna `null` se a edição não tem È IA? configurada (eia.credit vazio).
 * Caller deve fazer fallback gracioso (renderiza só o body).
 */
export function renderEiaStandalone(content: NewsletterContent): string | null {
  if (!content.eia.credit) return null;
  return `<!-- Diar.ia È IA? section — auto-generated by render-newsletter-html.ts (#1046) -->
<!-- Paste via editor.commands.insertContent pra preservar merge tags. -->
<table role="none" width="100%" border="0" cellspacing="0" cellpadding="0">
${renderEIA(content.eia)}
</table>`;
}

/**
 * #1364: converte `*text*` (italic markdown) em `<em>text</em>` inline,
 * preservando `**text**` (bold) intacto.
 *
 * Writer agent + crédito do É IA? usam `*Canis aureus*` pra nome científico.
 * Antes do #1364 o renderer mantinha os asteriscos literais → o email saía
 * com "(*Canis aureus*)" em texto puro, sem itálico.
 *
 * Regex: `*` solo (não-precedido nem seguido de `*`), conteúdo sem `*` nem
 * newline. `font-style:italic` inline garante renderização email-safe.
 *
 * Pure helper — exportado pra teste.
 */
export function processInlineItalics(s: string): string {
  return s.replace(
    /(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g,
    '<em style="font-style:italic;">$1</em>',
  );
}

/**
 * Escape pra HTML body text — combina `unescapeMd` (remove backslash do MD)
 * + `esc` (HTML entities) + `processInlineItalics` (#1364 — `*x*` → `<em>x</em>`)
 * + `applyInlineBold` (#3301 — `**x**` → `<strong>x</strong>`)
 * + word-joiner anti-linkify (#2008 — "Clarice.ai" em texto puro)
 * + wordmark da marca (#2532 — `Diar.ia` → `diar.ia.br` teal).
 * Ordem: unescape → esc → italics → bold → word-joiner → wordmark. Os 2
 * últimos rodam pós-esc (injetam HTML cru de propósito). Usar em conteúdo
 * editorial destinado a `<p>` de corpo; NÃO em URLs nem em atributos
 * (`alt=`/`title=`) — o output contém `<span>`/`<wbr>` não-escapados que
 * quebrariam o atributo.
 *
 * #3301: antes, `**bold**` solto (sem link por perto) sobrevivia literal no
 * corpo de destaque — `escText` (via `renderBodyInline`/`renderWhyBoxInner`/
 * `renderCoverage`) nunca chamava `applyInlineBold`, diferente de
 * `processInlineLinks` (callouts/boxes), que sempre aplica bold aos
 * segmentos de texto. O template (`context/templates/newsletter.md`) e o
 * humanizador (`context/publishers/humanizador-rubric.md`) proíbem `**` fora
 * de headers/títulos — então isso não deveria ocorrer no fluxo normal — mas
 * nenhum lint estrutural garante isso linha a linha (só checam trailing
 * spaces/frontmatter/section headers/contagem de bold-link nesting, ver
 * `lint-humanized-output.ts`); um `**` solto que escapasse dessas checagens
 * violaria "Output final sem markdown" (CLAUDE.md) sem este fix. `**` roda
 * ANTES do italic seria equivalente aqui (a regex de italic já exclui `**`
 * via lookaround `(?<!\*)...(?!\*)`, e a de bold exige o par completo
 * `**...**` sem `*` interno) — ordem escolhida (italic primeiro) só pra
 * manter o comentário de ordem acima estável.
 */
function escText(s: string): string {
  // #2008: word-joiner aplicado via applyWordJoiner (declarado acima) — análogo
  // ao monthly-render.ts renderTextInline (commit 1ec81b0).
  // #2532: wordmark da marca aplicado por último (já pós-esc — injeta <span> raw).
  return applyBrandWordmark(applyWordJoiner(applyInlineBold(processInlineItalics(esc(unescapeMd(s))))));
}

/**
 * #2532: wordmark da marca no corpo — token `Diar.ia` (D maiúsculo) → o domínio
 * `diar.ia.br` com os separadores destacados em teal (`.` e `.br` em #00A0A0;
 * `diar`/`ia` em ink). Pedido do editor (2026-06-23): a marca, onde aparece no
 * corpo, exibe o domínio com os pontos em verde.
 *
 * Aplica-se a conteúdo de TEXTO já renderizado (segmentos de prosa). Casa o
 * token `Diar.ia` (nome) E `diar.ia.br` (domínio em minúscula, #2674 — ex: a
 * linha de comissão do box de afiliados, que antes saía plana), absorvendo um
 * sufixo `.br` opcional no MESMO match (sem `.br` duplicado, #2533 review).
 * #2674: o `i` faz casar minúsculas; os lookbehind/lookahead garantem que
 * **NUNCA toca URLs** — um `diar.ia.br` precedido por `/` `.` `@` ou letra (ex:
 * `https://diar.ia.br/p`, `www.diar.ia.br`) ou seguido por `/` letra `@` (path
 * de URL) NÃO casa. Também não casa `diaria` sem ponto. Output lowercase
 * (`diar...`), logo re-aplicar é idempotente. O caso bold (`**`/`<b>`) envolve o
 * wordmark (negrito redundante mas HTML válido).
 */
// #2674 (260630): wordmark em negrito, com `.` e `.br` no teal da marca.
const BRAND_WORDMARK_HTML =
  `<strong>diar<span style="color:${TEAL}">.</span>ia<span style="color:${TEAL}">.br</span></strong>`;
// Regex de módulo (não realocar por chamada). `replace` com `/g` é stateless.
// `i`: casa `Diar.ia` (nome) e `diar.ia.br` (domínio minúsculo, ex: comissão).
// Alternância URL-safe (#2674 review): o domínio cheio `diar.ia.br` casa salvo
// se seguido por `/` `\w` `@` (path de URL); o nome `diar.ia` casa salvo se
// seguido por `.br` (deixa o domínio cheio capturar) ou por `/` `\w` `@` (URL).
// Lookbehind `(?<![/\w.@])` exclui `https://diar.ia.br`, `www.diar.ia.br`,
// `user@diar.ia.br`. Fim de frase (`Diar.ia.` / `diar.ia.br.`) continua casando.
const BRAND_WORDMARK_RE =
  /(?<![/\w.@])(?:diar\.ia\.br(?![/\w@])|diar\.ia(?!\.br)(?![/\w@]))/gi;
/**
 * @param linkHref (opcional) — quando presente, envolve o wordmark num link pra
 *   esse destino (mantendo o estilo do wordmark: negrito + pontos teal, sem
 *   sublinhar). Usado pela MENSAL (#template-branding 260703): toda ocorrência
 *   de `diar.ia.br` vira link pra `diaria.beehiiv.com`. Sem o param, comportamento
 *   inalterado (texto puro) — a DIÁRIA segue sem link (já vive no Beehiiv).
 */
export function applyBrandWordmark(s: string, linkHref?: string): string {
  const html = linkHref
    ? `<a href="${linkHref}" style="color:inherit;text-decoration:none">${BRAND_WORDMARK_HTML}</a>`
    : BRAND_WORDMARK_HTML;
  // Replacement via função: `html` (que embute `linkHref` arbitrário) é inserido
  // LITERAL — evita a interpretação de `$&`/`$1`/`$$` que o replace-string faz se
  // a URL contiver `$` (agora que linkHref é parâmetro, não mais só a constante).
  return s.replace(BRAND_WORDMARK_RE, () => html);
}

/** Process markdown links [text](url) to <a> tags, escaping surrounding text.
 * Input é normalizado via `unescapeMd` antes (#1117) — remove backslash escapes
 * de pontuação ASCII que o writer pode ter adicionado. URLs em markdown não
 * usam backslash escape (usam % encoding), então unescape upfront é seguro. */
/**
 * Processa markdown links inline `[texto](url)` → `<a>`.
 *
 * #1634: o destino é parseado contando parênteses balanceados, não com
 * `\(([^)]+)\)`. A regex antiga fechava o link no PRIMEIRO `)`, então uma URL
 * com parênteses (ex: `.../The-Founders-Playbook-05062026_v3%20(1).pdf`)
 * quebrava — o href saía truncado em `...(1` e o resto vazava como texto.
 * CommonMark permite pares de parênteses balanceados no destino; aqui um `(`
 * aumenta a profundidade e só um `)` em profundidade 0 fecha o link.
 */
/**
 * #2665 follow-up: converte `**negrito**` em `<strong>` nos segmentos de TEXTO
 * (não nos labels de link, já tratados). Roda DEPOIS do esc/wordmark — `*` não é
 * escapado por esc(), então o par `**…**` sobrevive intacto. Non-greedy + sem
 * `*` interno evita casar pares aninhados/cruzados. Antes, um `**Não compre**`
 * num box (box de divulgação/introCallout) vazava com asteriscos literais (260630).
 */
function applyInlineBold(html: string): string {
  return html.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
}

/**
 * Conta ocorrências NÃO sobrepostas de `**` numa string (avança 2 posições a
 * cada match — "****" conta como 2, não 3). Usado por `tokenizeInline` pra
 * checar paridade (par = tudo já pareado; ímpar = sobra um `**` desemparelhado).
 */
function countDoubleAsterisk(str: string): number {
  let count = 0;
  let idx = str.indexOf("**");
  while (idx !== -1) {
    count++;
    idx = str.indexOf("**", idx + 2);
  }
  return count;
}

/**
 * O `**` candidato (adjacente a um link) é um marcador genuinamente
 * desemparelhado dentro de `adjacentText` — abertura/fechamento legítimo pro
 * bold-wrap do link — ou já está auto-pareado ali (não deve fundir com o
 * link)? Contagem ÍMPAR de `**` em `adjacentText` = há um marcador anterior
 * sem par, e o candidato (NÃO participa dessa contagem — já foi removido
 * pelo caller) pareia com ele — logo o candidato já está auto-pareado, não
 * deve fundir com o link. Contagem PAR (0, 2, 4...) = todos os marcadores
 * anteriores já se pareiam entre si, sobrando nada pro candidato pairear —
 * ele está de fato desemparelhado, livre pra fundir com o link. Compartilhado
 * entre os dois lados (`hasOpenBold` e `hasCloseBold`) — mesma fórmula, evita
 * os dois lados divergirem (#3280 code-review).
 */
function isUnpairedBoldMarker(adjacentText: string): boolean {
  return countDoubleAsterisk(adjacentText) % 2 === 0;
}

/**
 * #3302: o LABEL de um link (`m[1]` cru, antes de esc/applyInlineBold) é
 * inteiramente envolto em `**...**`, sem `**` interno (`**Título**`, não
 * `**A**B**`)? Espelha o predicado `fullBold` já usado em
 * `renderIntroCallout` (linha ~397) para o mesmo formato. Usado só para
 * decidir se o wrap externo de bold-link deve ser omitido (o label já sai
 * `<strong>` via `applyInlineBold` dentro de `inlineLinkHtml`) — não afeta
 * se os `**` externos são CONSUMIDOS (isso continua governado por `boldLink`).
 */
function isLabelFullyBold(label: string): boolean {
  return /^\*\*[^*][\s\S]*\*\*$/.test(label) && !label.slice(2, -2).includes("**");
}

/**
 * Posição do próximo `[label](url)` VÁLIDO a partir de `from` — reusa
 * `findMarkdownLinks` (parênteses balanceados + URL não-vazia, o mesmo
 * parser do loop principal de `tokenizeInline`/`findMarkdownLinks`), não uma
 * regex crua: um `[x](` malformado (sem fechamento, ou destino vazio) não
 * deve ser confundido com um boundary real (#3280 code-review — Reuse/
 * wrapper-correctness). Retorna `str.length` se não houver mais links válidos.
 */
function nextLinkStartIndex(str: string, from: number): number {
  const rest = str.slice(from);
  const link = findMarkdownLinks(rest).find((l) => l.url.length > 0);
  return link ? from + link.start : str.length;
}

/**
 * Tokenizador inline compartilhado: varre `[label](url)` (destino com parênteses
 * balanceados), chamando `onText` nos segmentos de TEXTO e `onLink` em cada link.
 * Base de `processInlineLinks` (texto via esc+wordmark+bold) e de `renderBodyInline`
 * (texto via escText — preserva itálico/word-joiner do corpo). `s` já passa por
 * `unescapeMd` aqui; os callbacks recebem o segmento cru.
 *
 * #3220: `**[label](url)**` (negrito envolvendo um link) vazava como
 * asterisco literal — `onText` só casa `**...**` DENTRO do mesmo segmento de
 * texto, e o link quebra o texto em 2 segmentos, cada um com um `**` órfão
 * sem par. Tratado como sinal explícito do autor ("quero esse link em
 * negrito") — os `**` órfãos ao redor do link são consumidos e o `<a>`
 * resultante sai envolto em `<strong>`, em vez de vazar pro HTML final ou de
 * simplesmente descartar o negrito pedido.
 */
function tokenizeInline(
  s: string,
  onText: (seg: string) => string,
  onLink: (label: string, url: string) => string,
): string {
  const input = unescapeMd(s);
  const parts: string[] = [];
  let lastIdx = 0;
  const linkStart = /\[([^\]]+)\]\(/g;
  let m: RegExpExecArray | null;
  while ((m = linkStart.exec(input)) !== null) {
    const destStart = m.index + m[0].length;
    // Varre o destino balanceando parênteses: `(` aprofunda, `)` em depth 0 fecha.
    let depth = 0;
    let j = destStart;
    for (; j < input.length; j++) {
      const ch = input[j];
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (j >= input.length) continue; // sem `)` de fechamento → não é link válido
    const url = input.substring(destStart, j);
    // URL vazia (`[texto]()`) não é link — preserva o comportamento da regex
    // antiga (`[^)]+` exigia destino não-vazio) e evita emitir `<a href="">`.
    if (url.length === 0) {
      linkStart.lastIndex = j + 1;
      continue;
    }
    // #3220: `**` colado no link (`**[label](url)**`) — sem isso, o `**`
    // antes do link e o `**` depois ficam em segmentos de texto separados, cada
    // um sem par, e vazam literal no HTML. Só aplica quando os DOIS lados têm
    // o marcador colado ao link (não mexe em bold legítimo mais afastado) —
    // nesse caso o `<a>` do link sai envolto em `<strong>`.
    // #3280: `endsWith`/`startsWith` sozinhos não bastam — em
    // `**Atenção:**[link](url)**hoje** foi importante.` os dois lados também
    // "encostam" `**` no link, mas são 2 bolds INDEPENDENTES que só ficam
    // colados ao link, não um bold-wrap do link. Antes de aceitar, confere se
    // o `**` candidato já está AUTO-PAREADO no texto adjacente (contagem
    // par/ímpar de `**`, #2532-style heurístico): se o resto de `textBefore`
    // (sem o `**` final) tem contagem PAR, esse `**` final está de fato
    // desemparelhado — sobra pro link (abertura legítima). Se ÍMPAR, o `**`
    // final já fecha um bold anterior dentro do próprio `textBefore` (ex:
    // "Atenção:") — não é abertura pro link.
    let textBefore = input.substring(lastIdx, m.index);
    const hasOpenBold =
      textBefore.endsWith("**") &&
      isUnpairedBoldMarker(textBefore.slice(0, -2));
    // Lado de depois do link — mesma ideia espelhada, bounded pelo próximo
    // link (pra não contaminar a contagem com `**` dentro do label de um link
    // seguinte). #3280 code-review (achado #A/#B/#E/Altitude, confirmado
    // empiricamente): quando HÁ um próximo link `**[label2](url2)**` colado
    // ao fim do texto entre os dois links, o `**` final desse texto PODE ser
    // a ABERTURA do wrap do link seguinte (resolvida pelo `hasOpenBold` dele,
    // na iteração seguinte) — mas só quando o texto conector, tomado como um
    // todo (SEM strip nenhum), já não é auto-suficiente. Sem isso, 2+ links
    // bold-wrapped consecutivos no mesmo parágrafo quebravam: nenhum fundia,
    // `**` vazava literal, e o texto conector entre eles virava `<strong>`
    // por engano.
    // #3316: a versão original stripava o `**` final incondicionalmente
    // sempre que colado ao próximo link — mas se o conector JÁ contém uma
    // frase bold auto-contida e pareada (ex: `**word**`, contagem PAR de
    // `**`), esse `**` final é na verdade o FECHAMENTO dessa frase, não uma
    // abertura emprestada pro link seguinte. Stripar incondicionalmente
    // desmanchava esse par (sobrando um `**` órfão) e derrubava a paridade
    // deste link. Só stripa quando o conector CRU (antes de qualquer strip)
    // tem contagem ÍMPAR — sinal de que sobra de fato um marcador solto pra
    // resolver "emprestando" a abertura pro link seguinte; contagem PAR
    // significa que o conector já fecha sozinho, e o `**` candidato deste
    // link está livre (fundiu com nada) — usa o conector como está.
    // `closeBoundary` só é computado quando o `**` candidato existe (lazy —
    // evita o scan de `nextLinkStartIndex` na maioria dos links, que não têm
    // `**` colado).
    let hasCloseBold = false;
    if (input.startsWith("**", j + 1)) {
      const closeBoundary = nextLinkStartIndex(input, j + 3);
      let closeAdjacent = input.substring(j + 3, closeBoundary);
      if (
        closeBoundary < input.length &&
        closeAdjacent.endsWith("**") &&
        !isUnpairedBoldMarker(closeAdjacent)
      ) {
        closeAdjacent = closeAdjacent.slice(0, -2);
      }
      hasCloseBold = isUnpairedBoldMarker(closeAdjacent);
    }
    const boldLink = hasOpenBold && hasCloseBold;
    if (boldLink) {
      textBefore = textBefore.slice(0, -2);
    }
    if (textBefore.length > 0) parts.push(onText(textBefore));
    const linkHtml = onLink(m[1], url);
    // #3302: quando o LABEL do link já é inteiramente bold (`**[**Título**](url)**`),
    // `onLink` (via `inlineLinkHtml`/`applyInlineBold`) já envolve o texto em
    // `<strong>` — sem este guard, o wrap externo do bold-link (`boldLink`
    // acima) duplicava o `<strong>` (`<strong><a><strong>Título</strong></a></strong>`).
    // Markup redundante mas não quebrava visualmente; o guard evita a duplicação
    // sem alterar a lógica de CONSUMO dos `**` externos (`lastIdx`/`linkStart.lastIndex`
    // abaixo seguem baseados em `boldLink`, não em `wrapBold` — os `**` externos
    // continuam sendo estruturalmente reconhecidos como bold-wrap do link).
    const wrapBold = boldLink && !isLabelFullyBold(m[1]);
    parts.push(wrapBold ? `<strong>${linkHtml}</strong>` : linkHtml);
    lastIdx = boldLink ? j + 3 : j + 1;
    linkStart.lastIndex = lastIdx; // retoma a busca após o link (e o `**` de fechamento, se consumido)
  }
  if (lastIdx < input.length) parts.push(onText(input.substring(lastIdx)));
  return parts.join("");
}

// #2004: link inline sem font-weight:bold — só underline teal (decisão 2026-06-09).
// #recomendacao-leitura: EXCEÇÃO opt-in — se o rótulo vier com `**...**` (ex:
// `[**título**](url)`), o negrito é aplicado dentro do link. Links sem `**` no
// rótulo continuam sem negrito (comportamento #2004 preservado).
function inlineLinkHtml(label: string, url: string): string {
  return `<a href="${esc(url)}" style="color:${TEXT_COLOR};text-decoration:underline;text-decoration-color:${TEAL};" target="_blank" rel="noopener noreferrer nofollow">${applyInlineBold(esc(label))}</a>`;
}

export function processInlineLinks(s: string): string {
  // #2532: wordmark só nos segmentos de TEXTO (não no label do link).
  return tokenizeInline(s, (seg) => applyInlineBold(applyBrandWordmark(esc(seg))), inlineLinkHtml);
}

/**
 * #2665 follow-up: inline do CORPO de destaque — preserva o pipeline do escText
 * (itálico, word-joiner, wordmark) E renderiza links markdown `[label](url)`.
 * Antes, `renderBodyParasInner` usava escText puro, então um link no corpo do
 * destaque vazava como markdown literal (260630: `amazon.com.br/alexaplus`).
 */
function renderBodyInline(s: string): string {
  return tokenizeInline(s, escText, inlineLinkHtml);
}
