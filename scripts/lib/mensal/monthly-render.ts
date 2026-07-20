/**
 * monthly-render.ts (#1844 — extraído de publish-monthly.ts)
 *
 * Camada de APRESENTAÇÃO do digest mensal: markdown → HTML do email Brevo.
 * Funções puras (string in → string out), sem I/O — escHtml, render* por
 * seção, parsing de labels (splitByLabels/parseHeaderChunk/normalizeLabel) e
 * draftToEmail (orquestra o render do draft inteiro). publish-monthly.ts
 * re-exporta pra back-compat (testes importam por nome) e o main() importa
 * draftToEmail pra montar a campanha.
 *
 * #1936: cores e fontes vêm do design system canônico (vjpixel/diaria-design)
 * via scripts/lib/design-tokens.ts — valores inline (email não suporta var()).
 * Paleta de 4 cores (ink·bege·papel·teal); texto sempre ink (sem cinzas). Serif
 * Georgia (email-safe), sans Geist. Teal = acento (links/kickers/marcas) + réguas
 * (decisão editorial #1936). Shell bege #EBE5D0, card papel #FBFAF6.
 */
import { COLORS, FONTS } from "../shared/design-tokens.ts"; // #1936
export { escHtml } from "../html-escape.ts"; // #1990: re-export for back-compat callers
import { escHtml } from "../html-escape.ts"; // #1990: local usage
import { applyWordJoiner } from "../word-joiner.ts"; // #2018 — shared helper (refs #2048)
import { applyBrandWordmark } from "../newsletter-render-html.ts"; // wordmark diar.ia.br, mesmo da diária (#3181) — candidato a mover pra shared/, ver docs/render-unification-analysis-3269.md
import { tealDot } from "../shared/email-components.ts"; // #3269 — extraído de newsletter-render-html.ts pra shared/ (era o mesmo import cruzado ad-hoc do applyBrandWordmark acima; ponto ● teal, #3181)
import { buildMensalStyleBlock } from "../shared/newsletter-styles.ts"; // #2635 — CSS base compartilhado
import {
  DIARIA_FACEBOOK_PAGE_URL,
  DIARIA_LINKEDIN_PAGE_URL,
  DIARIA_INSTAGRAM_URL,
  DIARIA_THREADS_URL,
} from "../canonical-urls.ts"; // #2645/#2790 — reusa as URLs canônicas (mesmas que a diária)

const INK = COLORS.ink; // --ink #171411 (todo o texto)
const BRAND = COLORS.brand; // --brand #00A0A0
const TEAL = BRAND; // alias dos templates (acento + régua)
// #1955: e-mail mensal BRANCO (override email-only, espelha o diário #1943/#1945).
// O token canônico --paper (#FBFAF6) segue em design-tokens.ts pra web; só o
// render do e-mail usa branco. SHELL (página) idem. BEGE (boxes/régua) fica.
const PAPER = "#FFFFFF"; // #1955 card branco (era COLORS.paper #FBFAF6)
const SHELL = "#FFFFFF"; // #1955 página branca (era COLORS.paperAlt #EBE5D0)
const BEGE = COLORS.paperAlt; // --paper-alt #EBE5D0 (boxes recuados / É IA? / réguas — contraste, mantido)
const FONT_SERIF = FONTS.serif; // Georgia — manchetes/títulos (corpo é sans Geist, #2599)
const FONT_SANS = FONTS.sans; // Geist (labels/kickers)

// #3183: porta pra mensal as 2 constantes que a diária extraiu no PR#3182
// (Refs #3104) pra eliminar micro-drifts de token sem motivo funcional.
// LS_LABEL ("2px") — letter-spacing de labels uppercase (kicker, "O fio
// condutor", legenda de hero, "Acesse nossas curadorias:", "Clarice ×
// Diar.ia", "Siga a Clarice × Diar.ia") variava 1px/1.5px/2px na mensal —
// mesmo drift que a diária tinha antes do PR#3182. Canonicalizado no mesmo
// valor da diária (2px) para paridade visual entre os 2 produtos — nenhum
// dos usos aqui é ancorado por regex externo (diferente do kicker da diária,
// que build-link-ctr.ts lê via KICKER_TD_OPEN_SRC).
const LS_LABEL = "2px";
// PAD_BOX_OUTLINE ("24px 28px") — padding do box "contorno" (fundo PAPER +
// borda BEGE 1px), usado só pela caixa "O fio condutor" (boxFor, abaixo).
// Era 22px 26px, 2px de drift vs o valor canônico da diária (mesmo box
// "contorno" em renderWhyBoxInner/renderErroIntencionalReveal). NÃO se aplica
// aos boxes "painel" da mensal (fundo BEGE preenchido — renderClariceBox,
// renderEncerramento, renderEia), que já usam 24px 28px como literal e não
// são o mesmo estilo estrutural (sem borda, sem "contorno") — mesma distinção
// que a diária mantém entre os 2 estilos de box.
const PAD_BOX_OUTLINE = "24px 28px";

/** Strip backslash escapes do export Drive (`\!` `\&` `\[` `\]`). */
export function stripBackslashEscapes(s: string): string {
  return s.replace(/\\([!&\[\]])/g, "$1");
}

/**
 * Renderiza um trecho de texto FORA de link: escapa HTML, depois `**bold**` e
 * `*italic*`. Bold roda primeiro — a regex de bold consome os `**`, então a de
 * italic (1 asterisco, com lookaround anti-`**`) não os repega.
 *
 * #1917: a regex de italic exige conteúdo **flanqueado por não-espaço**
 * (`*x*`, não `* x *`). A versão solta portada da diária (`\*([^*\n]+?)\*`)
 * transformava em itálico qualquer par de `*` avulsos numa linha — e a mensal
 * carrega conteúdo cheio deles que a diária não tem: rodapés de produto no
 * RADAR/USE MELHOR (`5GB* (*com anúncios)`), tutoriais de CLI/glob do
 * Laboratório Clarice (`*.json`), multiplicação (`palavras * 1.3 * margem`).
 * O flanco não-espaço preserva o caso real (`*Canis aureus*`) e ignora esses.
 */
// #template-branding (260703): na MENSAL, toda ocorrência de `diar.ia.br` vira
// link pra o cadastro no Beehiiv (a mensal sai pela Brevo pra base da Clarice —
// o wordmark linkado converte esse público pro Diar.ia). A diária NÃO recebe o
// link (já vive no Beehiiv) — por isso o destino entra como argumento aqui, não
// no applyBrandWordmark compartilhado.
const MENSAL_BRAND_LINK = "https://diaria.beehiiv.com";

/**
 * #2975: assinantes que migram da Clarice News mensal pro Beehiiv chegavam
 * "anônimos" no Acquisition details (Brevo auto-taggeia `utm_source=sendinblue`
 * + `utm_campaign` vazio nos links que ele reenvia) — impossível medir a
 * conversão da migração Clarice→Diar.ia, que é o objetivo de todo o rollout
 * cold em andamento. Solução: UTM PRÓPRIO em todo link `diaria.beehiiv.com`
 * do email mensal (`utm_source=clarice`, `utm_medium=email`,
 * `utm_campaign=clarice-{ciclo}`) — sobrescreve/precede o auto-tag do Brevo e
 * permite filtrar no Beehiiv "assinantes vindos da Clarice" por ciclo.
 *
 * Estado module-level (setado 1x por render em `draftToEmail`, resetado no
 * `finally`) em vez de threadar um parâmetro `ciclo` por TODA função render*
 * deste arquivo (renderTextInline é chamado transitivamente por praticamente
 * todas elas). `draftToEmail` é sempre síncrono e single-pass — sem risco de
 * interleaving entre ciclos diferentes.
 */
let currentMonthlyUtmCiclo: string | null = null;

/** Exposto para teste direto de `withClariceUtm`/`normalizeKnownUrl` sem passar por `draftToEmail`. */
export function setMonthlyUtmCiclo(ciclo: string | null): void {
  currentMonthlyUtmCiclo = ciclo;
}

/**
 * Injeta (ou sobrescreve) o UTM de atribuição Clarice em URLs que apontam pra
 * `diaria.beehiiv.com` — no-op para qualquer outro host (Clarice, tecnoblog,
 * Workers de curadoria, etc.) e no-op se nenhum ciclo estiver setado no
 * momento (render fora de `draftToEmail`, ex.: chamada direta de teste).
 */
function withClariceUtm(url: string): string {
  if (!currentMonthlyUtmCiclo) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url; // URL relativa/inválida — não é o link do Beehiiv, preserva como está.
  }
  if (parsed.hostname !== "diaria.beehiiv.com") return url;
  parsed.searchParams.set("utm_source", "clarice");
  parsed.searchParams.set("utm_medium", "email");
  parsed.searchParams.set("utm_campaign", `clarice-${currentMonthlyUtmCiclo}`);
  return parsed.toString();
}

/**
 * escHtml + `**bold**` + `*italic*`, SEM wordmark/word-joiner. Base de
 * `renderTextInline` e usado DIRETO no rótulo de link (`renderInline`) — o
 * rótulo não pode receber wordmark (`diar.ia.br` → link Beehiiv), que aninharia
 * um `<a>` dentro do `<a>` do próprio link. Assim `[**Título**](url)` (bold
 * dentro do rótulo, ex: título de livro) vira `<strong>` sem `**` literal.
 */
function escHtmlWithEmphasis(s: string): string {
  return escHtml(s)
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)(\S(?:[^*\n]*?\S)?)\*(?!\*)/g, '<em style="font-style:italic;">$1</em>');
}

function renderTextInline(s: string): string {
  // #2008/#2018: applyWordJoiner roda após escHtml+bold/italic — anti auto-linkify
  // via shared helper (scripts/lib/word-joiner.ts; lookbehind protege URLs cruas).
  // applyBrandWordmark após word-joiner (mesma ordem da diária, #2532/#2533):
  // estiliza "diar.ia" / "diar.ia.br" como o wordmark da marca (pontos teal) E,
  // na mensal, envolve num link pro Beehiiv (#template-branding 260703).
  return applyBrandWordmark(
    applyWordJoiner(escHtmlWithEmphasis(s)),
    withClariceUtm(MENSAL_BRAND_LINK), // #2975: link do wordmark carrega UTM clarice
  );
}

/**
 * #2261: normaliza URLs de curadoria que migraram de domínio. As páginas de
 * cursos/livros saíram do Beehiiv (`diaria.beehiiv.com/cursos-gratuitos-de-ia`,
 * `/livros-sobre-ia`) — que agora dão **404** — pros domínios de marca atuais
 * (`cursos.diar.ia.br`, `livros.diar.ia.br`, #3698, iguais ao diário).
 * Aplicado em TODO href do render mensal (defensivo): mesmo que o draft do
 * `writer-monthly` nasça com o link velho, o email sai com o correto — e o ciclo
 * 2605-06 (cujo S2/S3 reusa este conteúdo) é corrigido sem reescrever o draft.
 * O lookahead `(?=$|[/?#])` casa só o FIM do segmento (fim da string, `/`, `?`
 * ou `#`) — NÃO um hífen de continuação (evita over-match em `...-de-ia-2024`).
 * Adicionar aqui se outra página migrar.
 */
const LEGACY_URL_FIXES: Array<[RegExp, string]> = [
  [/^https?:\/\/diaria\.beehiiv\.com\/cursos-gratuitos-de-ia(?=$|[/?#])/i, "https://cursos.diar.ia.br"],
  [/^https?:\/\/diaria\.beehiiv\.com\/livros-sobre-ia(?=$|[/?#])/i, "https://livros.diar.ia.br"],
  // #3698: cutover do próprio Worker (cursos/livros.diaria.workers.dev) pro
  // domínio de marca — mesma defesa de conteúdo antigo/cacheado que ainda
  // referencia o subdomínio legado.
  [/^https?:\/\/cursos\.diaria\.workers\.dev(?=$|[/?#])/i, "https://cursos.diar.ia.br"],
  [/^https?:\/\/livros\.diaria\.workers\.dev(?=$|[/?#])/i, "https://livros.diar.ia.br"],
];

export function normalizeKnownUrl(url: string): string {
  for (const [re, fixed] of LEGACY_URL_FIXES) if (re.test(url)) return fixed;
  // #2975: cobre links `diaria.beehiiv.com` escritos como markdown `[texto](url)`
  // pelo writer-monthly (boilerplate APRESENTAÇÃO, CTA de ENCERRAMENTO) — não só
  // o wordmark automático (`renderTextInline`/`applyBrandWordmark`).
  return withClariceUtm(url);
}

/**
 * #template-branding (260703): caixas "O fio condutor" começam com inicial
 * MAIÚSCULA. O writer às vezes emite o fecho em continuação minúscula ("em um
 * mês...", "a OpenAI..."); aqui a 1ª letra do parágrafo é capitalizada. Pula
 * marcadores markdown iniciais (`*`, `[`, aspas, parêntese, espaço) e capitaliza
 * a 1ª letra Unicode — idempotente se já estiver maiúscula.
 *
 * #2951: o skip-set é EXPLÍCITO (`\s*_["'(`), nunca "todo não-letra". O regex
 * antigo (`[^\p{L}]*`) consumia também dígitos/pontuação, então uma abertura
 * numérica ("30% das empresas…") capitalizava a letra ERRADA no meio da palavra
 * seguinte ("30% Das…"). Se a frase abre com número, o regex não casa e o texto
 * volta intacto — o que é correto (não se capitaliza a palavra após o número).
 */
export function capitalizeFirstLetter(text: string): string {
  return text.replace(/^([\s*_["'(]*)(\p{L})/u, (_m, pre, ch) => pre + ch.toLocaleUpperCase("pt-BR"));
}

/**
 * Conta ocorrências NÃO sobrepostas de `**` numa string (avança 2 posições a
 * cada match — "****" conta como 2, não 3). Espelha `countDoubleAsterisk` de
 * `../newsletter-render-html.ts` (#3299 — porta o merge bold+link do
 * #3220/#3280/#3284/#3316 pra cá). Duplicado em vez de importado: a mensal
 * mantém seu parser markdown self-contained (ver
 * `docs/render-unification-analysis-3269.md` §2.3 — extrair o scanner de
 * baixo nível pro shared/ é candidato Tier 1 de baixo risco mas não
 * obrigatório; o objetivo aqui é fechar o bug, não a unificação).
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
 * desemparelhado no texto adjacente — livre pra fundir com o link — ou já
 * está auto-pareado ali (não deve fundir)? Contagem PAR de `**` em
 * `adjacentText` = tudo já pareado, o candidato está livre; ÍMPAR = sobra um
 * marcador anterior sem par, que consome o candidato. Espelha
 * `isUnpairedBoldMarker` de `../newsletter-render-html.ts` (#3280) — ver lá a
 * explicação completa da heurística.
 */
function isUnpairedBoldMarker(adjacentText: string): boolean {
  return countDoubleAsterisk(adjacentText) % 2 === 0;
}

/**
 * Índice do próximo `[label](url)` VÁLIDO (URL não-vazia, parênteses
 * balanceados) a partir de `from`. Espelha `nextLinkStartIndex` de
 * `../newsletter-render-html.ts` (#3280 code-review) — usado só pra delimitar
 * o texto conector entre 2 links ao decidir a paridade de `**` (#3284/#3316:
 * sem isso, 2+ links bold-wrapped consecutivos no mesmo parágrafo paravam de
 * fundir). Retorna `str.length` se não houver mais links válidos.
 */
function nextLinkStartIndex(str: string, from: number): number {
  const rest = str.slice(from);
  const linkStart = /\[([^\]]+)\]\(/g;
  let m: RegExpExecArray | null;
  while ((m = linkStart.exec(rest)) !== null) {
    const destStart = m.index + m[0].length;
    let depth = 0;
    let j = destStart;
    for (; j < rest.length; j++) {
      const ch = rest[j];
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (j >= rest.length) continue; // sem `)` de fechamento — não é link válido
    if (j > destStart) return from + m.index; // URL não-vazia
    linkStart.lastIndex = j + 1;
  }
  return str.length;
}

/**
 * Converts [text](url) markdown links to <a> tags; o texto AO REDOR dos links
 * ganha bold/italic + wordmark via renderTextInline. O rótulo do link em si
 * (`m[1]`) ganha bold/italic via `escHtmlWithEmphasis` (mas NÃO wordmark — evita
 * `<a>` aninhado), então `[**Título**](url)` — bold DENTRO do rótulo, ex: título
 * de livro no box de recomendação de leitura — vira `<a><strong>Título</strong></a>`
 * em vez de vazar `**` literal (bug detectado no ciclo 2606-07).
 *
 * #1917/#1634: o destino do link é parseado contando parênteses balanceados,
 * não com `\([^)]+\)`. A regex antiga (split por `\[[^\]]+\]\([^)]+\)`) fechava
 * o link no PRIMEIRO `)`, então uma URL com parênteses — ex: um PDF da Clarice
 * `.../arquivo%20(1).pdf` — truncava o href e vazava `.pdf)` como texto puro.
 * Mesmo bug que o #1634 corrigiu na diária; a mensal nunca tinha recebido o fix.
 *
 * #3299: `**[label](url)**` (negrito envolvendo um link) fundia SEM checar se
 * os `**` já estavam auto-pareados no texto adjacente — `renderTextInline`
 * só casa `**...**` DENTRO do mesmo segmento de texto, e o link quebra o
 * texto em 2 segmentos, cada um com um `**` órfão sem par que vazava literal
 * no HTML final. Porta o merge bold+link do #3220/#3280/#3284/#3316 (diária,
 * `tokenizeInline`): só funde quando os DOIS lados têm um `**` genuinamente
 * desemparelhado colado ao link (não quando o `**` já fecha/abre um bold
 * independente que só encosta no link por acidente, nem quando um dos 2+
 * links consecutivos bold-wrapped "rouba" o `**` de fechamento do anterior).
 */
export function renderInline(text: string): string {
  // Pre-strip backslash escapes ANTES do escHtml — assim `\&` vira `&` que então
  // vira `&amp;`, e não `\&amp;` (que aconteceria se strippássemos depois).
  const input = stripBackslashEscapes(text);
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
    if (url.length === 0) {
      // `[texto]()` não é link — preserva (não emite `<a href="">`).
      linkStart.lastIndex = j + 1;
      continue;
    }

    // #3299: `**` colado ao link (dos 2 lados) só funde quando genuinamente
    // desemparelhado no texto adjacente — ver docstring da função acima.
    let textBefore = input.substring(lastIdx, m.index);
    const hasOpenBold =
      textBefore.endsWith("**") &&
      isUnpairedBoldMarker(textBefore.slice(0, -2));
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

    if (textBefore.length > 0) parts.push(renderTextInline(textBefore));
    const linkHtml = `<a href="${escHtml(normalizeKnownUrl(url))}" style="color:${INK};text-decoration:underline;text-decoration-color:${TEAL};">${escHtmlWithEmphasis(m[1])}</a>`;
    parts.push(boldLink ? `<strong>${linkHtml}</strong>` : linkHtml);
    lastIdx = boldLink ? j + 3 : j + 1;
    linkStart.lastIndex = lastIdx; // retoma a busca após o link (e o `**` de fechamento, se consumido)
  }
  if (lastIdx < input.length) parts.push(renderTextInline(input.substring(lastIdx)));
  return parts.join("");
}

/**
 * Kicker de seção no padrão DS/diária: ● teal + label + régua hairline bege à
 * direita (espelha renderKicker da diária). letter-spacing 2px, Geist 12px bold.
 *
 * #3181: label teal (~3.2:1 de contraste sobre papel/branco) falhava AA
 * (4.5:1) — mesmo achado do PR#3179 na diária (Refs #3104), nunca portado
 * pra cá. Fix idêntico: o ponto ● continua teal (tealDot(), importado da
 * diária — assinatura de cor do DS), só o TEXTO do label vira ink (~14:1).
 * Antes ponto+label viviam no MESMO <td> cor teal — nem separava os dois.
 */
export function renderKicker(label: string): string {
  return (
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 16px 0;"><tr>` +
    `<td style="white-space:nowrap;font-family:${FONT_SANS};font-size:12px;font-weight:bold;letter-spacing:${LS_LABEL};text-transform:uppercase;color:${INK};padding:0 12px 0 0;">${tealDot()}&nbsp;${escHtml(label)}</td>` +
    `<td width="100%" style="border-bottom:1px solid ${BEGE};font-size:0;line-height:0;">&nbsp;</td>` +
    `</tr></table>`
  );
}

/**
 * Renders blank-line-separated blocks. Cada bloco é renderizado como `<p>`
 * por padrão, ou como `<ul>` / `<ol>` se todas as linhas forem itens de lista.
 *
 * Detecta:
 *   - bullet list: `- texto`, `* texto` (com indent opcional)
 *   - ordered list: `1. texto`, `2. texto` (com indent opcional)
 */
export function renderParagraphs(text: string): string {
  const paras = text.split(/\n\n+/).filter((p) => p.trim());
  return paras
    .map((p) => {
      const lines = p.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return "";

      const isUnordered = lines.every((l) => /^[-*]\s+/.test(l));
      const isOrdered = lines.every((l) => /^\d+\.\s+/.test(l));

      if (isUnordered) {
        const items = lines
          .map((l) => l.replace(/^[-*]\s+/, ""))
          .map((item) => `<li style="margin:0 0 8px 0;">${renderInline(item)}</li>`)
          .join("\n");
        return `<ul style="margin:0 0 16px 0;padding-left:24px;">${items}</ul>`;
      }
      if (isOrdered) {
        const items = lines
          .map((l) => l.replace(/^\d+\.\s+/, ""))
          .map((item) => `<li style="margin:0 0 8px 0;">${renderInline(item)}</li>`)
          .join("\n");
        return `<ol style="margin:0 0 16px 0;padding-left:24px;">${items}</ol>`;
      }

      const inline = renderInline(p.trim().replace(/\n/g, " "));
      return `<p style="margin:0 0 16px 0;font-family:${FONT_SANS};">${inline}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * #2018: mapa gerador → legenda da imagem. Centralizado aqui (único lugar)
 * para que publish-monthly.ts e monthly-preview-cloudflare.ts importem em vez
 * de duplicar. Adicionando um novo gerador, basta atualizar este mapa.
 */
export const GENERATOR_LABELS: Record<string, string> = {
  gemini: "Criada com Gemini",
  comfyui: "Criada com ComfyUI",
  cloudflare: "Criada com Cloudflare AI",
  openai: "Criada com DALL-E",
};

/** Deriva a legenda de imagem a partir do slug do gerador configurado.
 * Fallback: "Criada com IA" (genérico, seguro para qualquer gerador). */
export function captionForGenerator(imageGenerator: string): string {
  return GENERATOR_LABELS[imageGenerator] ?? "Criada com IA";
}

/**
 * Renders a DESTAQUE section block. Aceita override de tema (usado pra
 * LABORATÓRIO CLARICE etc — seções editorialmente equivalentes a destaques).
 * `imageUrl` (#1916): imagem 2x1 do destaque, embutida no topo do bloco.
 *
 * Formatos de header reconhecidos (após `normalizeLabel`):
 *   - `DESTAQUE 1 | ANTHROPIC` (formato antigo, separador `|`)
 *   - `DESTAQUE 1\] ANTHROPIC` (Drive markdown export, com `\]` interno)
 *   - `DESTAQUE 1 ANTHROPIC` (qualquer separador whitespace)
 */
/**
 * #2018: imageCaption parametriza a legenda da imagem gerada — antes era
 * hardcoded "Criada com Gemini", mas o gerador configurado pode ser
 * ComfyUI, Cloudflare, etc. Caller (draftToEmail) lê platform.config.json
 * e passa a legenda correta. Default: "Criada com IA" (genérico, seguro).
 */
export function renderDestaque(chunk: string, temaOverride?: string, imageUrl?: string, imageCaption?: string): string {
  const lines = chunk.split("\n");
  // Limpar header: remover bold/brackets, separadores `\]` `|`, normalizar spaces.
  const cleaned = normalizeLabel(lines[0])
    .replace(/\\\]/g, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const m = cleaned.match(/^DESTAQUE\s+(\d+)\s+(.+)$/);
  const tema = temaOverride ?? (m ? m[2] : cleaned);

  // Find title: first non-empty line after header. Strip `**...**` (Drive bold).
  let i = 1;
  while (i < lines.length && !lines[i].trim()) i++;
  const title = i < lines.length
    ? lines[i].trim().replace(/^\*\*+/, "").replace(/\*\*+$/, "").trim()
    : "";
  i++;

  const remaining = lines.slice(i).join("\n").trim();
  const paragraphs = remaining.split(/\n\n+/).filter((p) => p.trim());

  const mainParas: string[] = [];
  let conductorText = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.startsWith("O fio condutor:")) {
      conductorText = trimmed.slice("O fio condutor:".length).trim();
    } else {
      mainParas.push(trimmed);
    }
  }

  // Renderiza o tema sempre (não filtra por VALID_CATEGORIES — temas mensais
  // como ANTHROPIC, OPENAI, LABORATÓRIO CLARICE são editoriais e devem aparecer).
  const label = tema ? renderKicker(tema) : "";
  // #template-branding (260703): título do destaque SEM sublinhado — não é link.
  // (O sublinhado teal fica só onde há link real: labels de link no corpo e no Radar.)
  const titleHtml = title
    ? `<h2 style="margin:0 0 20px 0;font-size:26px;font-family:${FONT_SERIF};line-height:1.2;color:${INK};">${renderInline(title)}</h2>`
    : "";
  // #1936: o ÚLTIMO parágrafo de cada destaque fecha com uma régua bege
  // (border-left no --rule #EBE5D0; o DS não usa teal em estrutura). Só quando
  // NÃO há "O fio condutor:" — que já carrega a régua como pull-quote italic.
  // #DS: o fecho do destaque (fio condutor explícito OU último parágrafo) vai
  // numa caixa "Por que isso importa" (fundo branco + borda bege), como na diária.
  // #3181/#3183: label "O fio condutor" era teal (~3.2:1, abaixo de AA) e o
  // box tinha padding:22px 26px (2px de drift vs o box "contorno" canônico
  // da diária, 24px 28px — mesmo achado dos PR#3179/PR#3182, Refs #3104,
  // nunca portado pra mensal). Fix: ponto ● teal (tealDot()) + label ink,
  // padding/letter-spacing unificados via PAD_BOX_OUTLINE/LS_LABEL.
  const boxFor = (text: string): string =>
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:24px 0 0;"><tr><td style="background:${PAPER};border:1px solid ${BEGE};border-radius:12px;padding:${PAD_BOX_OUTLINE};">` +
    `<p style="margin:0 0 8px 0;font-family:${FONT_SANS};font-size:12px;font-weight:bold;letter-spacing:${LS_LABEL};text-transform:uppercase;color:${INK};">${tealDot()}&nbsp;O fio condutor</p>` +
    `<p style="margin:0;font-family:${FONT_SANS};">${renderInline(capitalizeFirstLetter(text.replace(/\n/g, " ")))}</p></td></tr></table>`;
  let mainHtml = "";
  let conductorHtml = "";
  if (conductorText) {
    mainHtml = mainParas.map((p) => `<p style="margin:0 0 16px 0;font-family:${FONT_SANS};">${renderInline(p.replace(/\n/g, " "))}</p>`).join("\n");
    conductorHtml = boxFor(conductorText);
  } else if (mainParas.length) {
    mainHtml = mainParas.slice(0, -1).map((p) => `<p style="margin:0 0 16px 0;font-family:${FONT_SANS};">${renderInline(p.replace(/\n/g, " "))}</p>`).join("\n");
    conductorHtml = boxFor(mainParas[mainParas.length - 1]);
  }

  // #1916: imagem 2x1 do destaque no topo do bloco (full-width responsiva).
  // alt = título descritivo (cai pra tema/categoria só se faltar) — #1922 review.
  // #2018: legenda parametrizada (imageCaption) — antes hardcoded "Criada com Gemini".
  const caption = imageCaption ?? "Criada com IA";
  const imageHtml = imageUrl
    ? `<img src="${escHtml(imageUrl)}" alt="${escHtml(title || tema)}" style="display:block;width:100%;height:auto;border-radius:6px;margin:0 0 10px 0;" />` +
      `<p style="margin:0 0 20px 0;font-family:${FONT_SANS};font-size:12px;letter-spacing:${LS_LABEL};text-transform:uppercase;color:${INK};">${escHtml(caption)}</p>`
    : "";

  return label + titleHtml + imageHtml + mainHtml + conductorHtml;
}

/**
 * Renders a INTRO section como sumário editorial destacado.
 * Estrutura: label teal "RESUMO DO MÊS" + parágrafo italic com border-left teal.
 */
export function renderIntro(body: string): string {
  const paras = body.split(/\n\n+/).filter((p) => p.trim());
  const bodyHtml = paras
    .map((p) => {
      const inline = renderInline(p.trim().replace(/\n/g, " "));
      return `<p style="margin:0 0 16px 0;font-family:${FONT_SANS};font-size:16px;color:${INK};line-height:1.62;">${inline}</p>`;
    })
    .join("\n");
  return renderKicker("Resumo do mês") + bodyHtml;
}

/**
 * CTA "→ ..." dentro dos boxes Clarice/Laboratório → botão teal (fundo #00A0A0,
 * texto branco bold), como o CTA da diária. O label é o texto visível da linha
 * (sem o "→" e sem o link quando o texto do link é uma URL); href = URL do link.
 */
export function renderCtaButton(line: string): string {
  const text = line.replace(/^→\s*/, "").trim();
  const linkM = text.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
  if (!linkM) return `<p style="margin:16px 0 0 0;font-family:${FONT_SANS};color:${INK};">${renderInline(text)}</p>`;
  const idx = linkM.index ?? 0;
  const url = normalizeKnownUrl(linkM[2]); // #2975: CTA pra diaria.beehiiv.com também ganha UTM clarice
  const linkText = linkM[1];
  const pre = text.slice(0, idx).trim().replace(/[:：]\s*$/, "").trim();
  const post = text.slice(idx + linkM[0].length).trim().replace(/[.。]\s*$/, "").trim();
  const looksUrl = !/\s/.test(linkText) && /^(https?:\/\/|[\w.-]+\.[a-z]{2,})/i.test(linkText);
  const label = pre && looksUrl ? pre : [pre, linkText, post].filter(Boolean).join(" ").trim();
  // Botão CTA (decisão final do editor 2026-06-09): pill "contorno" — fundo
  // paper #FBFAF6 + borda 1px bege, radius 999px, texto INK bold 16px (tamanho
  // do corpo). Centralizado.
  // Centralização à prova de balas: wrapper full-width com td align=center
  // (Gmail e afins ignoram margin:auto em <table>). O pill interno encolhe ao
  // conteúdo e fica centralizado pela td.
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:20px 0 0;"><tr><td align="center"><table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;"><tr><td style="background:${COLORS.paper};border:1px solid ${BEGE};border-radius:999px;"><a href="${escHtml(url)}" style="display:inline-block;padding:12px 22px;font-family:${FONT_SANS};font-size:16px;font-weight:bold;color:${INK};text-decoration:none;">${escHtml(label)}</a></td></tr></table></td></tr></table>`;
}

/**
 * Renders a LABORATÓRIO CLARICE section como caixa similar ao CLARICE
 * mas com formatação rica (h3 título, parágrafos, lista numerada).
 *
 * Estrutura esperada (após `**` strip):
 *   LABORATÓRIO CLARICE
 *
 *   **Subtítulo bold**
 *
 *   Parágrafo introdutório.
 *
 *   1. Item lista
 *   2. Item lista
 *   ...
 *
 *   Dica: ...
 *   → Teste agora: [link](url)
 */
export function renderLaboratorio(chunk: string): string {
  return renderClariceBox(chunk, "LABORATÓRIO CLARICE");
}

/**
 * Box de marca Clarice (borda tracejada, h3 título, parágrafos, lista numerada),
 * com rótulo de cabeçalho parametrizável. Compartilhado por LABORATÓRIO CLARICE
 * e CLARICE — DIVULGAÇÃO (#1918 review request: divulgação usa o mesmo box,
 * com rótulo "Desconto exclusivo").
 *
 * Estrutura esperada (após `**` strip):
 *   {RÓTULO}
 *
 *   **Subtítulo bold**
 *
 *   Parágrafo introdutório.
 *   1. Item lista ...
 *   → CTA: [link](url)
 */
export function renderClariceBox(chunk: string, headerLabelText: string, imageUrl?: string, noSubtitle = false): string {
  const lines = chunk.split("\n");
  // Skip header (o rótulo de seção) + blank lines.
  let i = 1;
  while (i < lines.length && !lines[i].trim()) i++;

  // Subtítulo: primeira linha não-vazia (espera `**...**`). Com `noSubtitle`
  // (box RECOMENDAÇÃO DE LEITURA), o box NÃO tem título interno — o kicker já
  // nomeia a seção; todo o corpo (a partir daqui) vira parágrafo.
  let subtitle = "";
  if (!noSubtitle) {
    const subtitleRaw = i < lines.length ? lines[i].trim() : "";
    subtitle = subtitleRaw.replace(/^\*\*+/, "").replace(/\*\*+$/, "").trim();
    i++;
  }

  const remaining = lines.slice(i).join("\n").trim();

  // Split em blocos: parágrafos, listas, dica final.
  const blocks = remaining.split(/\n\n+/).filter((b) => b.trim());

  const renderedBlocks: string[] = [];
  for (const block of blocks) {
    const blockLines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    // Bloco é uma lista numerada se TODAS as linhas começam com `\d+\.`.
    const isOrdered = blockLines.length > 0 && blockLines.every((l) => /^\d+\.\s/.test(l));
    if (isOrdered) {
      const items = blockLines
        .map((l) => l.replace(/^\d+\.\s+/, ""))
        .map((item) => `<li style="margin:0 0 8px 0;">${renderInline(item)}</li>`)
        .join("\n");
      renderedBlocks.push(
        `<ol style="margin:0 0 16px 0;padding-left:24px;color:${INK};">${items}</ol>`
      );
    } else if (/^→/.test(block.trim())) {
      renderedBlocks.push(renderCtaButton(block.trim().replace(/\n/g, " ")));
    } else {
      const inline = renderInline(block.trim().replace(/\n/g, " "));
      renderedBlocks.push(`<p style="margin:0 0 16px 0;font-family:${FONT_SANS};color:${INK};">${inline}</p>`);
    }
  }

  const subtitleHtml = subtitle
    ? `<h3 style="margin:0 0 16px 0;font-size:22px;font-weight:bold;font-family:${FONT_SERIF};line-height:1.3;color:${INK};">${renderInline(subtitle)}</h3>`
    : "";

  // #editor: imagem no topo do box (full-bleed, cantos superiores arredondados),
  // como o box de curadoria de livros da diária (renderMidCallout).
  const imageRow = imageUrl
    ? `<tr><td style="padding:0;line-height:0;font-size:0;"><img src="${escHtml(imageUrl)}" width="100%" alt="${escHtml(subtitle || headerLabelText)}" style="display:block;width:100%;height:auto;border:0;border-radius:12px 12px 0 0;" /></td></tr>`
    : "";
  return [
    renderKicker(headerLabelText),
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-radius:12px;background:${BEGE};">`,
    imageRow,
    `<tr><td style="padding:24px 28px;">`,
    subtitleHtml,
    renderedBlocks.join("\n"),
    `</td></tr></table>`,
  ].join("");
}

/**
 * Renders a CLARICE — DIVULGAÇÃO section. Mesmo box do laboratório, com rótulo
 * "Desconto exclusivo" (não "CLARICE — DIVULGAÇÃO", que é só o label interno do
 * draft). Pedido do editor: divulgação com a mesma formatação do laboratório.
 */
export function renderClarice(chunk: string): string {
  return renderClariceBox(chunk, "Desconto exclusivo");
}

/**
 * Renderiza uma seção de lista de links (título inline + descrição). Usada por
 * USE MELHOR DO MÊS, RADAR DO MÊS (#1901/#1902) e a legada OUTRAS NOTÍCIAS DO MÊS.
 */
export function renderLinkListSection(chunk: string, displayTitle: string): string {
  const lines = chunk.split("\n");
  const content = lines.slice(1).join("\n").trim();

  const header = renderKicker(displayTitle);

  // Items: [título](url) + blank line + descrição (separados por blank entre itens).
  // split(/\n\n+/) quebra título e descrição em chunks separados — a descrição
  // ficaria sem título e renderizaria como negrito indevidamente.
  // Fix: agrupar por linha de inline link (nova entrada = [título](url)).
  const TITLE_RE = /^\[.+\]\(https?:\/\/[^)]+\)/;
  const nonBlankLines = content.split("\n").map((l) => l.trim()).filter((l) => l);

  const parsed: Array<{ title: string; desc: string }> = [];
  let currentTitle: string | null = null;
  const descBuf: string[] = [];

  for (const line of nonBlankLines) {
    if (TITLE_RE.test(line)) {
      if (currentTitle !== null) {
        parsed.push({ title: currentTitle, desc: descBuf.join(" ").trim() });
        descBuf.length = 0;
      }
      currentTitle = line;
    } else {
      descBuf.push(line);
    }
  }
  if (currentTitle !== null) {
    parsed.push({ title: currentTitle, desc: descBuf.join(" ").trim() });
  }

  const itemsHtml = parsed
    .map(({ title, desc }) => {
      const tm = title.match(/^\[(.+?)\]\((https?:\/\/[^)]+)\)/);
      const titleHtml = tm
        ? `<p style="margin:0 0 4px 0;"><a href="${escHtml(normalizeKnownUrl(tm[2]))}" style="font-family:${FONT_SERIF};font-size:20px;line-height:1.25;color:${INK};text-decoration:underline;text-decoration-color:${TEAL};text-decoration-thickness:2px;text-underline-offset:3px;">${escHtml(tm[1])}</a></p>`
        : `<p style="margin:0 0 4px 0;font-family:${FONT_SERIF};font-size:20px;color:${INK};">${renderInline(title)}</p>`;
      return titleHtml + (desc
        ? `<p style="margin:0 0 20px 0;font-family:${FONT_SANS};color:${INK};">${renderInline(desc)}</p>`
        : `<div style="margin-bottom:20px;"></div>`);
    })
    .join("\n");

  return header + itemsHtml;
}

/** @deprecated back-compat: use renderLinkListSection. */
export function renderOutrasNoticias(chunk: string): string {
  return renderLinkListSection(chunk, "Outras Notícias do Mês");
}

/**
 * Pill outline compartilhado (#2790) entre `renderEncerramento` e
 * `renderSocialFooter` — mesmo idioma visual (fundo + borda BEGE + radius
 * 999px), variando só tamanho/padding/fundo entre os 2 usos. `renderCtaButton`
 * (acima) NÃO usa este helper: sua estrutura é diferente (background/borda no
 * `<td>` externo pra centralização via tabela, não no `<a>`) — refatorar pra
 * unificar mudaria a estrutura de tags do botão CTA sem necessidade real
 * (visualmente idêntico hoje), então foi deixado como está.
 */
function renderPillLink(
  label: string,
  url: string,
  opts: { fontSize?: number; padding?: string; background?: string } = {},
): string {
  const { fontSize = 16, padding = "12px 22px", background = COLORS.paper } = opts;
  return `<a href="${escHtml(url)}" style="display:inline-block;background:${background};border:1px solid ${BEGE};border-radius:999px;padding:${padding};margin:0 8px 10px 0;font-family:${FONT_SANS};font-size:${fontSize}px;font-weight:bold;color:${INK};text-decoration:none;">${escHtml(label)}</a>`;
}

/**
 * Encerramento no padrão da diária (#DS Tier 3): kicker "Para encerrar" + texto
 * de fechamento numa caixa bege; curadorias (bullets `- [texto](url)`) viram
 * pills outline. Degrada pra só kicker + caixa bege quando o conteúdo é simples.
 */
export function renderEncerramento(body: string): string {
  const blocks = body.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const proseBlocks: string[] = [];
  const pills: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const nonLink: string[] = [];
    let hadPill = false;
    for (const line of lines) {
      const m = line.match(/^[-*]\s+\[(.+?)\]\((https?:\/\/[^)]+)\)\s*$/);
      if (m) {
        pills.push(renderPillLink(m[1], normalizeKnownUrl(m[2])));
        hadPill = true;
      } else {
        nonLink.push(line);
      }
    }
    // "Acesse:" e afins (linhas não-link de um bloco de pills) são descartadas —
    // o label das pills vem fixo abaixo. Blocos sem pills viram prose.
    if (!hadPill && nonLink.length) proseBlocks.push(nonLink.join(" "));
  }

  const parts: string[] = [renderKicker("Para encerrar")];
  const head = proseBlocks.slice(0, -1);
  const last = proseBlocks.length ? proseBlocks[proseBlocks.length - 1] : "";
  for (const p of head) parts.push(`<p style="margin:0 0 16px 0;font-family:${FONT_SANS};">${renderInline(p)}</p>`);
  if (pills.length) {
    parts.push(
      `<p style="margin:16px 0 8px 0;font-family:${FONT_SANS};font-size:12px;font-weight:bold;letter-spacing:${LS_LABEL};text-transform:uppercase;color:${INK};">Acesse nossas curadorias:</p>`,
    );
    // #2139: centralizar via table align="center" + margin:0 auto (Outlook word-renderer
    // ignora align= em <table> — margin:auto garante centralização no Outlook 2007–2019).
    parts.push(`<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td style="text-align:center;">${pills.join("")}</td></tr></table>`);
  }
  if (last) {
    parts.push(
      `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background:${BEGE};border-radius:12px;margin:16px 0 0;"><tr><td style="padding:24px 28px;"><p style="margin:0;font-family:${FONT_SANS};">${renderInline(last)}</p></td></tr></table>`,
    );
  }
  return parts.join("\n");
}

/**
 * Deriva o código de edição do É IA? mensal no formato de ciclo `{YYMM}-{MM}`,
 * onde YYMM é o mês do CONTEÚDO e MM é o mês do ENVIO (conteúdo + 1).
 * Ex: "2605" → "2605-06" (digest de maio, enviado em junho).
 *     "2612" → "2612-01" (digest de dezembro, enviado em janeiro do ano seguinte).
 *
 * #2115: formato novo ciclo substitui o legado AAMMDD (ex-"260531") que era
 * confuso pro leitor que recebia em junho e via "edição de 31 de maio".
 * Back-compat: edition=260531 em links/votos antigos continua funcionando no
 * Worker — as chaves KV são opacas e cada link lê suas próprias chaves.
 */
export function eiaEditionFromYymm(yymm: string): string {
  const contentMonth = parseInt(yymm.slice(2, 4), 10);
  const sendMonth = (contentMonth % 12) + 1;
  return `${yymm}-${String(sendMonth).padStart(2, "0")}`;
}

/**
 * Pure (#1914): extrai a legenda/crédito do `01-eia.md` (o corpo após o header
 * `**É IA?**`, sem o frontmatter `eia_answer`). É essa legenda que vira o crédito
 * da imagem no card do É IA? mensal. Retorna "" se não achar corpo.
 */
export function parseEiaLegend(eiaMd: string): string {
  const noFront = eiaMd.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "");
  // Remove a linha de header (`**É IA?**` ou `É IA?`), pega o resto. Sem `\b`:
  // o boundary ASCII não casa antes de `É` nem depois de `*` (#1914 review).
  const lines = noFront.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /É\s*IA\?/.test(l)); // \s* tolera 2+ espaços
  const body = (startIdx >= 0 ? lines.slice(startIdx + 1) : lines).join("\n").trim();
  return body;
}

/**
 * Renders the É IA? section (#465). Layout espelha a diária (#1918): imagens
 * A/B lado a lado, clicáveis (o voto vai no clique da própria imagem — sem
 * botão), empilhando no mobile via `.mob-stack`; frase "Clique na imagem que
 * foi gerada por IA.". Voto vai pro leaderboard `brand=clarice` (#1905).
 * `creditOverride` (#1914): legenda vinda do `01-eia.md` — quando presente,
 * substitui o corpo do chunk (que na mensal é só um placeholder `[...]`).
 * `prevResultLine` (#2709): linha "Resultado da última edição: X% acertaram",
 * espelhando a diária — opt-in (renderiza só quando o caller tiver o dado;
 * ver nota no PR sobre a fonte ainda não estar plugada na mensal).
 */
export function renderEia(
  chunk: string,
  yymm: string,
  imageUrlA?: string,
  imageUrlB?: string,
  creditOverride?: string,
  prevResultLine?: string | null,
): string {
  const lines = chunk.split("\n");
  // #1914: prefere a legenda do 01-eia.md; cai pro corpo do chunk só se ela
  // vier vazia. E descarta um corpo que seja só placeholder `[...]` (#1915
  // review) pra ele nunca vazar como crédito no email.
  const fallbackBody = lines.slice(1).join("\n").trim();
  const cleanFallback = /^\[[\s\S]*\]$/.test(fallbackBody) ? "" : fallbackBody;
  const content = creditOverride?.trim() || cleanFallback;
  const workerUrl = process.env.POLL_WORKER_URL ?? "https://poll.diaria.workers.dev";
  const edition = eiaEditionFromYymm(yymm);
  // #1905: brand=clarice — votos do É IA? mensal vão pro leaderboard da Clarice
  // News, isolado do diário (Diar.ia).
  const voteUrlA = `${workerUrl}/vote?email={{ contact.EMAIL }}&amp;edition=${edition}&amp;choice=A&amp;brand=clarice`;
  const voteUrlB = `${workerUrl}/vote?email={{ contact.EMAIL }}&amp;edition=${edition}&amp;choice=B&amp;brand=clarice`;

  // #1918: imagem clicável (sem botão), lado a lado e empilhando no mobile —
  // espelha o renderEIA da diária. O voto vai no clique da própria imagem.
  const imageCell = (label: "A" | "B", imgUrl: string | undefined, voteUrl: string): string => {
    // #1923 review: só envolve em <a> de voto quando há imagem — sem imagem, o
    // placeholder cinza não deve ser clicável/votável.
    const inner = imgUrl
      ? `<a href="${voteUrl}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;display:block;"><img src="${escHtml(imgUrl)}" alt="Imagem ${label}" width="100%" style="display:block;width:100%;height:auto;border-radius:6px;" border="0" /></a>`
      : `<div style="width:100%;height:160px;background:${BEGE};border:2px dashed ${INK};border-radius:6px;text-align:center;line-height:160px;color:${INK};font-family:${FONT_SANS};font-size:12px;">Imagem ${label}</div>`;
    return inner;
  };

  // #2709: renderiza só quando o caller passar o dado (ver nota acima).
  // #3181/#3183 self-review: a issue original pedia portar o tratamento do
  // PR#3179 aqui (ponto ● teal + label ink, bold+uppercase+letter-spacing) —
  // mas a diária JÁ tinha ido além disso: o commit 42c4a266/8a275b5e (#3220)
  // destylizou o prevResultLine da diária a pedido do editor, "pra ler como
  // frase comum, não como label gritado" (ver newsletter-render-html.ts
  // renderEIA) — removeu bold/uppercase/letter-spacing/ponto por completo,
  // virou parágrafo de corpo puro (FONT_BODY 16px line-height:1.5 ink).
  // Portar o estado intermediário da issue criaria drift NOVO (mensal com
  // ponto+label-style, diária sem) — o objetivo de #3181/#3183 é eliminar
  // drift, não recriá-lo. Aplicado aqui o estado ATUAL da diária (parity real).
  const prevResultHtml = prevResultLine
    ? `\n    <p style="margin:6px 0 0;font-family:${FONT_SANS};font-size:16px;line-height:1.5;color:${INK};">${renderInline(prevResultLine)}</p>`
    : "";

  return renderKicker("É IA?") + `
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background:${BEGE};border-radius:12px;margin:0;">
  <tr><td style="padding:24px 28px;">

    <!-- Título -->
    <!-- #3183: line-height 1.2 (era 1.15) — mesmo valor das outras manchetes
         26px serif da mensal (renderDestaque titleHtml) e da diária (PR#3182,
         Refs #3104: headline/introCallout/boxDivulgacao/É IA? title, todas 1.2). -->
    <p style="margin:0;font-family:${FONT_SERIF};font-size:26px;line-height:1.2;color:${INK};">Clique na imagem que foi gerada por IA</p>

    <!-- Imagens A / B empilhadas (A acima de B), como na diária (#2541) -->
    <!-- #2709: margin-top:22px compensa a remoção do margin do título acima (item 2) —
         mesmo valor da diária (newsletter-render-html.ts renderEIA), que usa essa margem
         na tabela de imagens (não no título) pra abrir espaço depois do título. -->
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:22px;">
      <tr><td>${imageCell("A", imageUrlA, voteUrlA)}</td></tr>
      <tr><td style="padding-top:16px;">${imageCell("B", imageUrlB, voteUrlB)}</td></tr>
    </table>

    <!-- Crédito -->
    <p style="margin:16px 0 0;font-family:${FONT_SANS};font-size:12px;color:${INK};">${renderInline(content)}</p>
${prevResultHtml}

    <!-- Leaderboard -->
    <p style="margin:12px 0 0;font-family:${FONT_SANS};font-size:12px;color:${INK};">
      <a href="${workerUrl}/leaderboard/20${yymm.slice(0, 2)}?brand=clarice" style="color:${INK};text-decoration:none;border-bottom:1px solid ${TEAL};">Ver ranking</a>
    </p>

  </td></tr>
</table>`;
}

/**
 * Normaliza um label de seção, removendo bold (`**...**`), brackets escapados
 * (`\[...\]`) ou nus (`[...]`) e espaços. Necessário pois o Drive exporta
 * Google Docs com formatação markdown (negrito, brackets) que o parser original
 * não reconhecia.
 *
 * Exemplos:
 *   "**REMETENTE**"           → "REMETENTE"
 *   "**\\[INTRO\\]**"         → "INTRO"
 *   "**[CLARICE — DIVULGAÇÃO]**" → "CLARICE — DIVULGAÇÃO"
 *   "**DESTAQUE 1 | ANTHROPIC**" → "DESTAQUE 1 | ANTHROPIC"
 */
export function normalizeLabel(line: string): string {
  return line
    .trim()
    .replace(/^\*\*+/, "")
    .replace(/\*\*+$/, "")
    .replace(/^\\?\[/, "")
    .replace(/\\?\]$/, "")
    .trim();
}

/** Parses the header chunk (before first ---) to extract subject, preview, intro. */
export function parseHeaderChunk(chunk: string): {
  subjectOptions: string[];
  preview: string;
  intro: string;
} {
  // Pre-normaliza: strip `**` ao redor de labels canônicos pra os regex abaixo funcionarem.
  // (Drive exporta `**ASSUNTO**` em vez de `ASSUNTO`; mantemos os regex simples.)
  const text = chunk
    .trim()
    .replace(/^\*\*(REMETENTE|ASSUNTO|PREVIEW|INTRO)\*\*\s*$/gm, "$1")
    .replace(/^\*\*\\?\[(REMETENTE|ASSUNTO|PREVIEW|INTRO)\\?\]\*\*\s*$/gm, "$1");

  const subjectOptions: string[] = [];
  let preview = "";
  let intro = "";

  // Find ASSUNTO section
  const assuntoMatch = text.match(
    /ASSUNTO[^\n]*\n([\s\S]*?)(?=\nPREVIEW|\nINTRO|$)/
  );
  if (assuntoMatch) {
    const lines = assuntoMatch[1].trim().split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const m = line.match(/^\d+\.\s+(.+)$/);
      if (m) subjectOptions.push(m[1].trim());
    }
    // Fallback (#XXXX): se ASSUNTO não tem lista numerada, tratar conteúdo como
    // subject único. Drive doc só lista 1 ASSUNTO sem numeração.
    if (subjectOptions.length === 0 && lines.length > 0) {
      subjectOptions.push(lines.join(" ").trim());
    }
  }

  // Find PREVIEW section
  const previewMatch = text.match(/\nPREVIEW\n+([\s\S]*?)(?=\nINTRO|$)/);
  if (previewMatch) preview = previewMatch[1].trim();

  // Find INTRO section
  const introMatch = text.match(/\nINTRO\n+([\s\S]*)$/);
  if (introMatch) intro = introMatch[1].trim();

  return { subjectOptions, preview, intro };
}

/**
 * #2645/#2790: URLs canônicas dos canais sociais da marca Diar.ia, reusadas no
 * rodapé co-brand do shell mensal. As 4 vêm de `canonical-urls.ts`
 * (`DIARIA_{FACEBOOK,LINKEDIN,INSTAGRAM,THREADS}_PAGE_URL`/`_URL`) — fonte
 * única compartilhada com `build-link-ctr.ts`, `stitch-newsletter.ts` e
 * `lint-social-md.ts` (#2790 substituiu os literais hardcoded que existiam
 * aqui antes, cada um copiado independentemente nesses outros pontos).
 */
const SOCIAL_LINKS: ReadonlyArray<{ label: string; url: string }> = [
  { label: "Facebook", url: DIARIA_FACEBOOK_PAGE_URL },
  { label: "LinkedIn", url: DIARIA_LINKEDIN_PAGE_URL },
  { label: "Instagram", url: DIARIA_INSTAGRAM_URL },
  { label: "Threads", url: DIARIA_THREADS_URL },
];

/**
 * #2645: ponto único de injeção do logo Clarice quando o asset existir. Enquanto
 * vazio (hoje — decisão do editor 260701: sem asset ainda), o header renderiza o
 * nome "Clarice" via tipografia/cor do DS (co-brand TEXTUAL, não uma cópia do
 * header da diária). Setar esta constante para uma URL de imagem troca o header
 * pra `<img>` sem qualquer outra mudança de código.
 */
const COBRAND_LOGO_URL = "";

/**
 * Header/capa do shell mensal (#2645): co-brand Clarice × Diar.ia. Decisão do
 * editor (Gate 1, `/diaria-develop` 260701, comentário durável em #2645): o
 * mensal é uma parceria Clarice com identidade PRÓPRIA — não uma cópia visual do
 * header da diária. "Clarice" ganha destaque tipográfico (serif DS + teal, mesmo
 * tratamento visual dos títulos de destaque) com "Clarice × Diar.ia" abaixo,
 * indicando a parceria.
 */
export function renderCobrandHeader(): string {
  const wordmark = COBRAND_LOGO_URL
    ? `<img src="${escHtml(COBRAND_LOGO_URL)}" alt="Clarice" style="display:block;height:32px;width:auto;margin:0 0 6px 0;" />`
    // #1955/#2645: font-size restrito à type scale {12,16,22,26}px do DS — 26px
    // (mesmo tamanho do <h2> de título de destaque, renderDestaque) em vez de 28px.
    // #3181: cor TEAL preservada (fora de escopo) — 26px bold qualifica como
    // "large text" do WCAG (exige só 3:1), teal passa nesse limiar.
    // #3183: line-height 1.2 (era 1.15) — mesma unificação do título do É IA?
    // acima e das manchetes 26px serif da diária (PR#3182).
    : `<div style="font-family:${FONT_SERIF};font-size:26px;font-weight:bold;color:${TEAL};line-height:1.2;">Clarice</div>`;
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 28px 0;"><tr><td>
    ${wordmark}
    <div style="margin:6px 0 0;font-family:${FONT_SANS};font-size:12px;font-weight:bold;letter-spacing:${LS_LABEL};text-transform:uppercase;color:${INK};">Clarice &times; Diar.ia</div>
    <div style="border-bottom:1px solid ${BEGE};margin:18px 0 0;line-height:0;font-size:0;">&nbsp;</div>
  </td></tr></table>`;
}

/**
 * Footer do shell mensal (#2645): ícones sociais (Facebook/LinkedIn/Instagram/
 * Threads — a lista fixa em `SOCIAL_LINKS` acima, NÃO derivada de
 * `platform.config.json#socials` em runtime — #2790: comentário anterior aqui
 * afirmava o contrário; se o editor desabilitar um canal no config, este
 * footer não reflete automaticamente) que o Brevo não anexa automaticamente
 * (diferente do Beehiiv, que envolve a diária no seu shell configurável de
 * publicação, com esses ícones no footer). Renderizados
 * como pills outline (mesmo idioma visual de `renderEncerramento`/`renderCtaButton`
 * — INK sobre PAPER com borda BEGE) em vez de `<svg>` inline: suporte de SVG em
 * clientes de email é inconsistente (Outlook/Gmail app frequentemente removem),
 * enquanto o pill de texto já é um padrão testado no resto do render mensal.
 */
export function renderSocialFooter(): string {
  // #1955/#2645: font-size restrito à type scale {12,16,22,26}px do DS — 12px
  // (mesmo tamanho de renderKicker/legendas) em vez de 13px.
  const pills = SOCIAL_LINKS.map(({ label, url }) =>
    renderPillLink(label, url, { fontSize: 12, padding: "10px 18px", background: PAPER }),
  ).join("");
  return `<div style="border-top:1px solid ${BEGE};margin:28px 0 20px 0;line-height:0;font-size:0;">&nbsp;</div>
  <p style="margin:0 0 12px 0;font-family:${FONT_SANS};font-size:12px;font-weight:bold;letter-spacing:${LS_LABEL};text-transform:uppercase;color:${INK};">Siga a Clarice &times; Diar.ia</p>
  <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td style="text-align:center;">${pills}</td></tr></table>`;
}

/** Wraps rendered HTML parts in a full email document. */
export function wrapEmail(subject: string, bodyParts: string[]): string {
  // #1935: régua entre seções no teal da marca (era cinza #e0e0e0).
  // #DS: sem <hr> entre seções — a régua vive ao lado do kicker (renderKicker),
  // como na diária. Aqui só um respiro vertical entre os blocos.
  const divider = `<div style="line-height:28px;font-size:0;">&nbsp;</div>`;
  const body = bodyParts.join(divider);

  // #2635: buildMensalStyleBlock (newsletter-styles.ts) constrói o bloco <style> a
  // partir do módulo compartilhado. PRESERVA o output atual da mensal — só a media
  // query .mob-stack (#1918), sem o reset body/img/table de emailBaseRules. Adotar a
  // base compartilhada na mensal é follow-up editorial (mudaria o render por causa do
  // `table { border-collapse:collapse; }` em tabelas arredondadas sem guard inline —
  // ver nota de escopo em newsletter-styles.ts). #2645: agora também emite o dark
  // theme (canvas), com o INK do DS explícito (o módulo não importa design-tokens).
  const styleBlock = buildMensalStyleBlock(SHELL, INK);
  // Header co-brand + footer social do shell #2645 REMOVIDOS a pedido do editor
  // (260703): a APRESENTAÇÃO já faz o co-brand textual no topo, e o footer social
  // era redundante. renderCobrandHeader/renderSocialFooter seguem exportadas pra
  // reuso futuro (ex: quando houver logo). Ver issue de remoção.
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${escHtml(subject)}</title>
  ${styleBlock}
</head>
<body style="margin:0;padding:0;background:${SHELL};">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" class="ds-canvas">
    <tr>
      <td align="center" style="padding:20px 10px;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:${PAPER};">
          <tr>
            <td style="padding:36px 32px;font-family:${FONT_SANS};color:${INK};font-size:16px;line-height:1.62;">
              ${body}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// #2794: vocabulário de labels SEM negrito — usado como defesa em profundidade
// quando o writer-monthly emite `DESTAQUE 1 | TEMA` em texto plano (causa raiz
// real do ciclo 2606-07: sem `**`, splitByLabels não separava NADA e o draft
// inteiro caía no fallback renderParagraphs — zero imagens, zero seções).
//
// Deliberadamente restrito, DUPLAMENTE:
//   1. Labels de vocabulário FIXO (sem parte variável) exigem match da linha
//      INTEIRA ($ ancorado) — uma linha de prosa comum não pode virar seção
//      por acidente. Só os 3 formatos com parte variável (`DESTAQUE N | TEMA`,
//      `CLARICE — ...`, `É IA? ...`) usam prefixo.
//   2. CASE-SENSITIVE (sem flag `/i`) — o template sempre emite labels em
//      CAIXA ALTA ("PREVIEW", "DESTAQUE 1 | BRASIL"). Prosa comum do corpo
//      não é toda-maiúscula, então isso evita falso-positivo em corpo que
//      contenha a MESMA palavra em caixa mista como texto comum (ex: a
//      palavra "Preview" apareceria como body text sem ser confundida com
//      o label `PREVIEW`; sem essa restrição um teste real capturou esse
//      exato colapso — 3 seções em vez de 2 porque "Preview" virou boundary).
const FIXED_LABEL_RE_NO_BOLD =
  /^(REMETENTE|ASSUNTO(\s*\(\s*3\s*OP[ÇC][ÕO]ES\s*\))?|PREVIEW|APRESENTA[ÇC][ÃA]O|INTRO|DIVULGA[ÇC][ÃA]O|LIVROS|LIVRO( DO M[ÊE]S)?|LABORAT[ÓO]RIO CLARICE|USE MELHOR( DO M[ÊE]S)?|RADAR( DO M[ÊE]S)?|OUTRAS NOT[ÍI]CIAS DO M[ÊE]S|ENCERRAMENTO|PARA ENCERRAR)$/;
// "É IA?" não-bold só é label quando é a linha INTEIRA ("É IA?") ou seguido de
// travessão ("É IA? — DESTAQUE DO MÊS") — NUNCA prosa que começa com a pergunta
// ("É IA? do mês: duas versões..."), que senão vira 2ª seção e renderiza o card
// duas vezes (incidente 2606-07). DESTAQUE/CLARICE seguem como prefixo (têm
// parte variável estruturada, não colidem com prosa).
const VARIABLE_TAIL_LABEL_RE_NO_BOLD = /^(DESTAQUE \d+\b|CLARICE —|É ?IA\?(?:\s*[—–-]|\s*$))/;

/**
 * Detecta se uma linha é um label de seção (formatado como `**LABEL**` ou
 * `**\[LABEL\]**` no Drive markdown, OU — #2794 — em texto plano sem negrito,
 * restrito ao vocabulário conhecido). Não depende de `---` separators.
 */
export function isSectionLabel(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("**") && trimmed.endsWith("**")) {
    const normalized = normalizeLabel(trimmed);
    // #1904-followup: aceita os rótulos com OU sem " DO MÊS" — o editor encurta
    // pra "USE MELHOR"/"RADAR" (igual ao diário). Sufixo opcional cobre ambos.
    // "RADAR"/"USE MELHOR" são ancorados ao fim ($) porque são palavras comuns:
    // sem o $, uma linha 100%-bold tipo **RADAR DA OPENAI** viraria seção espúria.
    return /^(REMETENTE|ASSUNTO|PREVIEW|APRESENTAÇÃO|APRESENTACAO|INTRO|DIVULGAÇÃO$|LIVROS$|LIVRO(\s+DO\s+M[ÊE]S)?$|DESTAQUE\s+\d+|CLARICE\s+—|LABORAT[ÓO]RIO\s+CLARICE|USE\s+MELHOR(\s+DO\s+M[ÊE]S)?$|RADAR(\s+DO\s+M[ÊE]S)?$|OUTRAS\s+NOTÍCIAS\s+DO\s+M[ÊE]S|É\s+IA\?|ENCERRAMENTO|PARA\s+ENCERRAR)/i.test(
      normalized
    );
  }
  // #2794: fallback sem negrito — ver comentário do vocabulário acima.
  return FIXED_LABEL_RE_NO_BOLD.test(trimmed) || VARIABLE_TAIL_LABEL_RE_NO_BOLD.test(trimmed);
}

/**
 * Splits draft text em chunks por section label (não por `\n---\n`).
 * Mais robusto: Drive export pode ou não preservar horizontal rules.
 */
export function splitByLabels(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (isSectionLabel(line)) {
      if (current.length > 0) {
        const chunk = current.join("\n").trim();
        if (chunk) sections.push(chunk);
      }
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    const chunk = current.join("\n").trim();
    if (chunk) sections.push(chunk);
  }

  // Strip horizontal rules residuais (caso o markdown ainda os tenha).
  return sections
    .map((s) => s.replace(/^---\s*$/gm, "").trim())
    .filter((s) => s.length > 0);
}

/** Converts draft.md content + optional chosen subject to { subject, previewText, html }.
 *
 * @param destaqueImageCaption #2018 — legenda das imagens geradas (ex: "Criada com Gemini",
 *   "Criada com ComfyUI"). Default: "Criada com IA". Lida de platform.config.json pelo caller.
 */
export function draftToEmail(
  draft: string,
  chosenSubject: string | null,
  yymm: string,
  eiaImageUrlA?: string,
  eiaImageUrlB?: string,
  eiaCredit?: string,
  destaqueImageUrls?: Record<number, string>, // #1916: {1: url, 2: url, 3: url}
  destaqueImageCaption?: string, // #2018: legenda parametrizada do gerador
  livrosImageUrl?: string, // #editor: imagem do box de curadoria de livros
  eiaPrevResultLine?: string | null, // #2709: "Resultado da última edição: X% acertaram" — opt-in, ver renderEia
): { subject: string; previewText: string; html: string } {
  const text = draft.replace(/\r\n/g, "\n");
  const rawSections = splitByLabels(text);

  let subject = chosenSubject ?? "";
  let previewText = "";
  const bodyParts: string[] = [];

  // Helper: extrai conteúdo de um chunk (linhas após a primeira).
  const chunkBody = (chunk: string): string =>
    chunk.split("\n").slice(1).join("\n").trim();

  // #2975: liga o UTM `clarice-{ciclo}` pra todo link diaria.beehiiv.com renderizado
  // abaixo (wordmark + markdown links + CTA). `eiaEditionFromYymm` já deriva o
  // ciclo `{YYMM-conteúdo}-{MM-envio}` (ex: "2606" → "2606-07") — mesmo formato
  // usado no resto do email (É IA?, polls). `finally` garante reset mesmo em erro,
  // pra não vazar o ciclo dessa chamada pra um `draftToEmail` seguinte no mesmo processo.
  setMonthlyUtmCiclo(eiaEditionFromYymm(yymm));
  try {
    return draftToEmailBody();
  } finally {
    setMonthlyUtmCiclo(null);
  }

  function draftToEmailBody(): { subject: string; previewText: string; html: string } {
  for (let idx = 0; idx < rawSections.length; idx++) {
    const chunk = rawSections[idx].trim();
    if (!chunk) continue;

    const firstLine = chunk.split("\n")[0].trim();
    const label = normalizeLabel(firstLine);

    // REMETENTE: metadata, não renderiza no corpo.
    if (label === "REMETENTE") continue;

    // ASSUNTO: extrai como subject (override se chosenSubject não setado).
    // #2794: tolera o sufixo " (3 OPÇÕES)" (template atual) — sem isso, o
    // match exato falhava e a seção inteira caía no fallback renderParagraphs,
    // vazando "ASSUNTO (3 OPÇÕES)\n1. ...\n2. ...\n3. ..." como prosa no corpo.
    if (label === "ASSUNTO" || /^ASSUNTO\b/i.test(label)) {
      const body = chunkBody(chunk);
      const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
      let candidate = "";
      for (const line of lines) {
        const m = line.match(/^\d+\.\s+(.+)$/);
        if (m) { candidate = m[1].trim(); break; }
      }
      if (!candidate && lines.length > 0) candidate = lines.join(" ").trim();
      if (!subject && candidate) subject = candidate;
      continue;
    }

    // PREVIEW: extrai como previewText.
    if (label === "PREVIEW") {
      previewText = chunkBody(chunk).split("\n").join(" ").trim();
      continue;
    }

    // INTRO: sumário editorial do mês — render destacado (label teal + italic + border).
    if (label === "INTRO") {
      const body = chunkBody(chunk);
      if (body) bodyParts.push(renderIntro(body));
      continue;
    }

    // APRESENTAÇÃO: parágrafos planos.
    if (["APRESENTAÇÃO", "APRESENTACAO"].includes(label)) {
      const body = chunkBody(chunk);
      if (body) bodyParts.push(renderParagraphs(body));
      continue;
    }

    // DIVULGAÇÃO: box de divulgação/afiliado (bege) pra 1 item avulso (ex: acesso
    // a produto) antes do Use Melhor. Reusa o box do Clarice com rótulo "Divulgação".
    if (label === "DIVULGAÇÃO") {
      bodyParts.push(renderClariceBox(chunk, "Divulgação"));
      continue;
    }

    // LIVROS: box promovendo a página de curadoria de livros da Diar.ia (bege),
    // igual ao box de livros da diária. Reusa o box do Clarice com rótulo "Livros".
    if (label === "LIVROS") {
      bodyParts.push(renderClariceBox(chunk, "Livros", livrosImageUrl));
      continue;
    }

    // LIVRO: box de indicação de UM livro (bege), kicker "Livro" e SEM título
    // interno (noSubtitle) — o título do livro em negrito-com-link é o próprio
    // âncora visual. Sem imagem. (#3581: kicker perdeu o sufixo "do mês", que
    // era redundante pro leitor; label longo "LIVRO DO MÊS" segue aceito na
    // detecção por back-compat com edições/drafts em voo.)
    if (label === "LIVRO" || label === "LIVRO DO MÊS") {
      bodyParts.push(renderClariceBox(chunk, "Livro", undefined, true));
      continue;
    }

    // DESTAQUE — aceita `DESTAQUE N | TEMA` antigo E `DESTAQUE N\] TEMA` novo.
    const destaqueMatch = label.match(/^DESTAQUE\s+(\d+)/);
    if (destaqueMatch) {
      const n = Number(destaqueMatch[1]); // #1916: imagem 2x1 por destaque
      // #2018: repassa a legenda parametrizada do gerador configurado
      bodyParts.push(renderDestaque(chunk, undefined, destaqueImageUrls?.[n], destaqueImageCaption));
      continue;
    }

    if (label.startsWith("CLARICE —")) {
      bodyParts.push(renderClarice(chunk));
      continue;
    }

    // LABORATÓRIO CLARICE: caixa dedicada (h3 + parágrafos + lista numerada).
    if (label === "LABORATÓRIO CLARICE") {
      bodyParts.push(renderLaboratorio(chunk));
      continue;
    }

    // #1904-followup: dispatch tolerante ao rótulo curto (editor encurta
    // "USE MELHOR DO MÊS" → "USE MELHOR"). O título de exibição é sempre o longo.
    if (label === "USE MELHOR" || label === "USE MELHOR DO MÊS") {
      bodyParts.push(renderLinkListSection(chunk, "Use Melhor")); // #1919: sem "do Mês"
      continue;
    }

    if (label === "RADAR" || label === "RADAR DO MÊS") {
      bodyParts.push(renderLinkListSection(chunk, "Radar")); // #1919: sem "do Mês"
      continue;
    }

    if (label === "OUTRAS NOTÍCIAS DO MÊS") {
      bodyParts.push(renderOutrasNoticias(chunk));
      continue;
    }

    // #1914: tolera qualquer sufixo no rótulo ("É IA? — DESTAQUE DO MÊS" e
    // variantes de travessão/encurtamento do editor) além do curto "É IA?".
    // startsWith é dash-agnóstico no sufixo — match exato no em-dash era frágil
    // (#1915 review). Sem isso a seção cai no fallback e o placeholder `[...]`
    // aparece literal no email.
    if (label === "É IA?" || label.startsWith("É IA?")) {
      bodyParts.push(renderEia(chunk, yymm, eiaImageUrlA, eiaImageUrlB, eiaCredit, eiaPrevResultLine));
      continue;
    }

    // ENCERRAMENTO antigo + PARA ENCERRAR (renomeado pelo editor).
    if (label === "ENCERRAMENTO" || label === "PARA ENCERRAR") {
      const body = chunkBody(chunk);
      if (body) bodyParts.push(renderEncerramento(body));
      continue;
    }

    // Fallback: render as plain paragraphs (chunk inteiro, com label).
    bodyParts.push(renderParagraphs(chunk));
  }

  return {
    subject,
    previewText,
    html: wrapEmail(subject, bodyParts),
  };
  }
}
