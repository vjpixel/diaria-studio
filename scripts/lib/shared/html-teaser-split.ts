/**
 * html-teaser-split.ts (#7030)
 *
 * Corte de teaser NO SERVIDOR — pure, sem parser de DOM (Cheerio/jsdom
 * seriam overkill pra um corte em 1 ponto marcado explicitamente no HTML
 * fonte). Usado por `scripts/build-artigo-especial-teaser.ts` pra separar
 * cada Artigo Especial (`workers/artigos/public/{ano}/{slug}/index.html`) em
 * `teaser` (servido estático, sempre) e `full` (embutido num módulo
 * `.generated.ts`, servido só depois do gate — mesmo padrão de
 * `workers/cursos/src/courses-full.generated.ts`).
 *
 * O ponto de corte é um comentário HTML `<!-- ESPECIAL:GATE_CUT -->` inserido
 * manualmente no source de cada artigo, sempre logo antes do `<h3 id="s02">`
 * — ou seja, o teaser cobre a abertura + a 1ª seção nomeada do artigo,
 * decisão tomada olhando a estrutura real dos 2 artigos publicados (#7030,
 * ver PR body), não um chute de N parágrafos/caracteres.
 */

export const GATE_CUT_MARKER = "<!-- ESPECIAL:GATE_CUT -->";

export interface MarkerSplit {
  before: string;
  after: string;
}

/** Divide `html` no marcador — `null` se o marcador não existir (caller
 * decide se isso é erro; o build script trata como falha dura, nunca
 * publica um teaser "por acidente completo" ou vice-versa). */
export function splitAtMarker(html: string, marker: string = GATE_CUT_MARKER): MarkerSplit | null {
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  return { before: html.slice(0, idx), after: html.slice(idx + marker.length) };
}

/**
 * Pure: conta quantos `<div` abertos em `html` ainda não foram fechados por
 * um `</div>` correspondente — contagem simples de abre/fecha (não valida
 * aninhamento nem tags auto-fechadas, não há nenhuma no HTML de origem antes
 * do ponto de corte). Usado pra fechar a árvore de forma válida quando o
 * teaser trunca o documento no meio: `before` (texto antes do marcador)
 * sempre termina logo após um `</p>`/`</div>` completo (ponto de corte
 * escolhido de propósito, ver docstring do topo) — a única coisa que falta
 * fechar são os `<div>` ainda abertos acima desse ponto.
 */
export function countUnclosedDivs(html: string): number {
  const opens = (html.match(/<div\b/gi) ?? []).length;
  const closes = (html.match(/<\/div>/gi) ?? []).length;
  return Math.max(0, opens - closes);
}

/**
 * Extrai o bloco `<script type="application/ld+json">…</script>` de `html`
 * (JSON-LD `Article` — metadados estruturados, nunca conteúdo pago). `""` se
 * ausente. Usado pra o teaser CARREGAR o mesmo JSON-LD do artigo completo —
 * ele normalmente vive perto do fim do documento (depois do ponto de
 * corte), e sem isso o teaser perderia `Article`/`author`/`datePublished`
 * pro SEO/GEO (#7030, achado do guard `test/artigos-sitemap-5126.test.ts`).
 *
 * Cauda `[\s\S]*?<\/script>` é um regex não-guloso simples — não um parser
 * (review do #7038, baixa confiança/P3): se o JSON-LD algum dia tiver um
 * campo contendo a substring literal `</script>`, o corte trunca cedo. Não
 * é um problema hoje (nenhum dos 2 artigos publicados tem esse caractere
 * nos campos) — decisão consciente de não trocar por um parser real por
 * um risco hipotético; revisar se um artigo futuro tiver esse conteúdo.
 */
export function extractLdJsonScript(html: string): string {
  const match = html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/);
  return match ? match[0] : "";
}

/**
 * Reescreve, dentro de `before` (a metade do artigo que sobra no teaser
 * estático), toda âncora `href="#sNN"` cujo `id="sNN"` correspondente NÃO
 * existe em `before` — ou seja, aponta pra uma seção que só existe no HTML
 * completo pós-gate. O destino vira `#${ctaId}` (o bloco de convite ao fim
 * do teaser, ver `GATE_CTA_ID` em `artigo-especial-gate-cta.ts`): clicar
 * numa seção bloqueada no índice leva direto a como destravá-la, em vez de
 * âncora morta (test/artigos-cross-refs-5924.test.ts pegou esse caso —
 * o TOC lista as 5 seções do artigo de propósito, como isca do gate, mas só
 * a 1ª sobrevive no teaser estático). Âncoras cujo id JÁ existe em `before`
 * (a seção s01, sempre presente) não são tocadas.
 */
export function rewriteGatedTocAnchors(before: string, ctaId: string): string {
  const presentIds = new Set([...before.matchAll(/\bid="(s\d+)"/g)].map((m) => m[1]));
  return before.replace(/href="#(s\d+)"/g, (full, id: string) =>
    presentIds.has(id) ? full : `href="#${ctaId}"`,
  );
}

/**
 * Monta o documento teaser: `before` + bloco de CTA + JSON-LD (se presente
 * em `fullHtml`, mesmo cuidado de SEO do docstring de `extractLdJsonScript`)
 * + `</div>` suficientes pra fechar a árvore + `</body></html>`. `ctaHtml` é
 * injetado cru (caller controla o conteúdo — nunca vem de input de
 * usuário).
 */
export function buildTeaserDocument(before: string, ctaHtml: string, fullHtml: string = ""): string {
  const unclosed = countUnclosedDivs(before);
  const closingDivs = "</div>".repeat(unclosed);
  const ldJson = extractLdJsonScript(fullHtml);
  return `${before}${ctaHtml}\n${closingDivs}\n${ldJson}\n</body>\n</html>\n`;
}
