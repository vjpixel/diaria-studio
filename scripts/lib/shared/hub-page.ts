/**
 * hub-page.ts (#4558 Parte A)
 *
 * Renderer genérico dos "hubs temáticos" do acervo — páginas publicadas em
 * `arquivo.diar.ia.br/temas/{slug}` que agrupam a cobertura da diar.ia.br
 * sobre um tema específico (ex: Anthropic/Claude) com síntese editorial real,
 * não uma lista de manchete reempacotada.
 *
 * **Critério de qualidade da issue #4558 (não-negociável):** "cada hub
 * precisa carregar uma leitura que só existe porque alguém acompanhou o
 * tema por meses. Hub que reempacota manchete sem síntese própria é
 * conteúdo fino — não ganha citação e ainda arrasta o domínio." Este módulo
 * só formata — a prosa de cada `HubSection` é escrita à mão por edição
 * (`scripts/lib/hubs/{slug}.ts`), nunca gerada a partir de título/subtítulo.
 *
 * Reusa a mesma infraestrutura de `build-livros-page.ts`/`build-cursos-page.ts`/
 * `render-archive.ts`: DS canônico (`curadoria-page.ts`), estrutura GEO
 * (`geo-faq.ts` — FAQ + JSON-LD FAQPage/Article + autoria), `seo-meta.ts`.
 *
 * **Data ESTÁTICA, não `new Date()`** — mesma disciplina de
 * `build-livros-page.ts`/`build-cursos-page.ts` (ver nota em geo-faq.ts): o
 * HTML de cada hub é gerado e COMMITADO (`workers/arquivo/src/hubs/*.generated.ts`,
 * mesmo padrão de `courses-full.generated.ts`), então `contentDate` em
 * `HubContent` precisa ser um literal `YYYY-MM-DD` — um valor dinâmico
 * quebraria o teste de asset-drift (compara o HTML committed contra um
 * render fresco).
 */
import { escHtml as esc } from "../html-escape.ts";
import { renderSeoMeta } from "./seo-meta.ts";
import {
  renderCuradoriaRootStyles,
  renderCuradoriaHeaderStyles,
  renderCuradoriaFooterStyles,
  renderCuradoriaFooter,
} from "./curadoria-page.ts";
import {
  formatMonthYear,
  renderGeoByline,
  renderGeoFaqSection,
  renderGeoFaqStyles,
  renderGeoJsonLd,
  type GeoFaqItem,
} from "./geo-faq.ts";
import { DIARIA_ARQUIVO_URL } from "../canonical-urls.ts";

/** Um link markdown `[label](url)` já parseado — `start`/`end` são o span
 * (índices) do match completo na string de origem, meio-aberto (`end`
 * exclusivo). Nomeado (não shape inline) porque o MESMO shape existe em
 * `findMarkdownLinks` (`scripts/lib/newsletter-render-html.ts`) — nomear
 * documenta que as duas funções concordam no contrato, mesmo duplicando a
 * lógica (achado do fleet review). */
export interface ParsedLink {
  url: string;
  label: string;
  start: number;
  end: number;
}

/**
 * Acha links markdown `[texto](url)` num parágrafo, com parênteses
 * balanceados na URL (mesmo algoritmo de `findMarkdownLinks` em
 * `scripts/lib/newsletter-render-html.ts` — REIMPLEMENTADO aqui, não
 * importado. **Não é porque este arquivo é bundlado no Worker hoje — não é**
 * (`workers/arquivo/src/hubs/registry.ts` garante de propósito que o Worker
 * só importa o HTML já gerado, nunca `scripts/lib/hubs/` nem este módulo;
 * achado do fleet review corrigindo uma alegação errada da versão anterior
 * deste comentário). O motivo real: `newsletter-render-html.ts` importa
 * `readFileSync` de `node:fs` no topo do arquivo e carrega toda uma cadeia
 * de dependência específica de e-mail (word-joiner, wordmark de marca,
 * estilo inline pro Outlook) que não serve a uma página web comum — puxar
 * qualquer export de lá acopla este módulo a essa cadeia inteira à toa, e
 * fica uma armadilha se este arquivo um dia passar a ser importado por algo
 * que É bundlado no Worker (`geo-faq.ts`, por exemplo, já é).
 *
 * **`[texto]()` com URL vazia não é tratado como link** (mesmo guard do
 * `mdInlineToHtml`/`processInlineLinks` na função original — "preserva
 * texto bruto", ver comentário lá) — sem isso, um typo comum ao digitar
 * link à mão vira um `href=""` silencioso (link morto, sem erro nenhum;
 * achado do fleet review). */
export function findParagraphLinks(s: string): ParsedLink[] {
  const out: ParsedLink[] = [];
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
    const url = s.slice(destStart, j).trim();
    if (!url) continue; // `[texto]()` — URL vazia, preserva texto bruto (não vira <a href="">)
    out.push({ url, label, start: m.index, end: j + 1 });
    linkStart.lastIndex = j + 1;
  }
  return out;
}

/** Converte `[texto](url)` num parágrafo de `HubSection` em `<a href>` —
 * único subset de markdown suportado na prosa do hub (issue #4558: "hub
 * temático é link interno de verdade" — cada afirmação linka a edição de
 * origem, não só a lista de fontes no rodapé). Todo texto fora dos links,
 * e o `label`/`url` de cada link, passa por `esc()`; nunca interpola HTML
 * cru vindo do conteúdo. `HubContent.introParagraph`/`metaDescription` NÃO
 * passam por aqui (renderizados via `esc()` puro em `renderHubPage`) — só
 * `HubSection.paragraphs` suporta este subset de markdown; um `[texto](url)`
 * em qualquer outro campo de `HubContent` renderiza como colchete literal,
 * não como link. */
export function renderParagraphInline(p: string): string {
  const links = findParagraphLinks(p);
  if (links.length === 0) return esc(p);
  const parts: string[] = [];
  let lastIdx = 0;
  for (const { url, label, start, end } of links) {
    parts.push(esc(p.slice(lastIdx, start)));
    parts.push(`<a href="${esc(url)}">${esc(label)}</a>`);
    lastIdx = end;
  }
  parts.push(esc(p.slice(lastIdx)));
  return parts.join("");
}

/** Uma edição da diar.ia.br citada como fonte do hub — link interno real
 * (issue #4558: "efeito colateral bom: hub temático é link interno de
 * verdade"). `url` é sempre o domínio de marca (`diar.ia.br/p/{slug}`, não
 * `diaria.beehiiv.com` — #4059). */
export interface HubSourceEdition {
  /** `YYYY-MM-DD`. */
  date: string;
  title: string;
  url: string;
}

/** Uma seção narrativa do hub — H2 em formato de pergunta literal (issue
 * item 2) + 1 ou mais parágrafos de síntese editorial (item 1/6: dado
 * próprio, não reempacote de manchete). */
export interface HubSection {
  heading: string;
  /** Parágrafos — cada string vira um `<p>`. Tupla não-vazia (não
   * `string[]`) — uma seção com 0 parágrafos renderizaria um H2 sem nada
   * embaixo; o tipo torna isso impossível em vez de depender de validação
   * em runtime (achado do fleet review). Suporta o subset de markdown
   * `[texto](url)` (renderizado como `<a href>` via `renderParagraphInline`)
   * — ÚNICO campo de `HubContent` com esse suporte; outros campos de texto
   * livre (`introParagraph`, `metaDescription`) renderizam colchete literal
   * se alguém escrever markdown neles (achado do fleet review). */
  paragraphs: [string, ...string[]];
}

export interface HubContent {
  /** Usado na rota (`/temas/{slug}`) e no path do arquivo gerado. */
  slug: string;
  /** `<title>` / H1 curto (ex: "Anthropic e Claude"). */
  title: string;
  metaDescription: string;
  /** H2 em formato de pergunta literal do bloco intro (issue item 2). */
  introHeading: string;
  /** Responde a pergunta principal por inteiro, ~200 palavras (issue item 1). */
  introParagraph: string;
  sections: HubSection[];
  faq: GeoFaqItem[];
  /** Edições citadas como fonte, mais recente primeiro. */
  sourceEditions: HubSourceEdition[];
  /** `YYYY-MM-DD` estático — ver nota do módulo. */
  contentDate: string;
  /** `utm_source`/`utm_medium` do link "diar.ia.br" no rodapé — sempre uma
   * constante registrada em `utm-registry.ts` (nunca um literal solto aqui;
   * ver `HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM`). */
  footerNavUtm: { readonly source: string; readonly medium: string };
}

function pageUrl(slug: string): string {
  return `${DIARIA_ARQUIVO_URL}/temas/${slug}`;
}

/** CSS específico do corpo narrativo do hub (seções + lista de fontes) — o
 * que NÃO é coberto por `curadoria-page.ts` (grid de cards) nem por
 * `geo-faq.ts` (bloco de FAQ, reusado tal qual). */
function renderHubBodyStyles(): string {
  return `  main { padding: 40px 0 64px; }
  .hub-sections { max-width: 720px; }
  .hub-sections-heading { font-family: Georgia, 'Times New Roman', serif; font-size: 15px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--teal); margin: 0 0 24px; }
  .hub-section { margin: 0 0 40px; max-width: 720px; }
  .hub-section h2 { font-family: Georgia, 'Times New Roman', serif; font-size: 24px; font-weight: 700;
    line-height: 1.28; margin: 0 0 14px; color: var(--ink); }
  .hub-section p { font-size: 17px; line-height: 1.65; color: var(--ink); margin: 0 0 14px; }
  .hub-section p a { color: var(--teal); text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 2px; }
  .hub-section p a:hover { text-decoration-color: var(--teal); }
  .hub-section p:last-child { margin-bottom: 0; }
  .hub-sources { margin: 48px 0 0; padding: 32px 0 0; border-top: 1px solid var(--rule); max-width: 720px; }
  /* #4558: .geo-faq vem de geo-faq.ts (compartilhado com livros/cursos/arquivo,
     sem max-width — lá o conteúdo ao redor já é largo, grid de cards ou lista
     de edições). No hub, .hub-section/.geo-intro/.hub-sources são 720px pra
     leitura longa; sem este override o FAQ ficava sozinho mais largo que o
     resto da página. Seletor com "main" (especificidade maior que a classe
     solta) pra vencer .geo-faq sem depender da ordem de concatenação dos
     blocos de CSS em renderHubPage. */
  main .geo-faq { max-width: 720px; }
  .hub-sources h2 { font-family: Georgia, 'Times New Roman', serif; font-size: 15px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--teal); margin: 0 0 20px; }
  .hub-sources ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--rule); }
  .hub-sources li { border-bottom: 1px solid var(--rule); }
  .hub-sources li a { display: block; padding: 11px 2px; font-size: 15px; line-height: 1.4;
    color: var(--ink); text-decoration: none; }
  .hub-sources li a:hover { color: var(--teal); }
  .hub-sources .li-date { color: var(--teal); font-weight: 700; margin-right: 8px; font-size: 13px; }
  .subscribe-cta { margin: 20px 0 0; }
  .subscribe-cta a { font-size: 15px; font-weight: 700; color: var(--teal); text-decoration: none;
    border-bottom: 1px solid var(--teal); padding-bottom: 2px; }
  .subscribe-cta a:hover { opacity: 0.75; }`;
}

const SUBSCRIBE_URL = "https://diar.ia.br/subscribe";

/**
 * Valida os invariantes de `HubContent` que a issue #4558 e o próprio
 * módulo documentam mas o TYPE não consegue expressar sozinho (contagem de
 * FAQ, formato de data, não-vazio de listas). Pure, devolve a lista de
 * violações (vazia = válido) — nunca lança sozinha, quem chama decide.
 * Existe pra que um 2º/3º hub (decisão do editor: hubs coexistem, mais
 * temas virão) herde essas garantias automaticamente em vez de depender de
 * um teste hand-written por hub (achado do fleet review — hoje só
 * `anthropic-claude` tem essa cobertura via teste, não via estrutura).
 */
export function validateHubContent(hub: HubContent): string[] {
  const errors: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hub.contentDate)) {
    errors.push(`contentDate "${hub.contentDate}" não é YYYY-MM-DD`);
  }
  if (hub.faq.length < 6 || hub.faq.length > 10) {
    errors.push(`faq tem ${hub.faq.length} perguntas — issue #4558 item 3 pede 6-10`);
  }
  if (hub.sourceEditions.length === 0) {
    errors.push("sourceEditions está vazio — hub sem nenhuma edição citada como fonte");
  }
  for (let i = 1; i < hub.sourceEditions.length; i++) {
    if (hub.sourceEditions[i - 1].date < hub.sourceEditions[i].date) {
      errors.push("sourceEditions não está ordenado da edição mais recente pra mais antiga");
      break;
    }
  }
  for (const e of hub.sourceEditions) {
    if (!e.url.startsWith("https://diar.ia.br/")) {
      errors.push(`sourceEdition com url fora do domínio de marca: "${e.url}"`);
    }
  }
  if (hub.sections.length === 0) {
    errors.push("sections está vazio — hub sem nenhuma seção narrativa");
  }
  return errors;
}

/** Renderiza o HTML completo de um hub temático. Pure — sem I/O, sem
 * `Date.now()`. Lança se `validateHubContent` encontrar violação (fail-fast
 * — melhor quebrar o build do que publicar um hub malformado). Chamada por
 * `scripts/build-hub-page.ts` (nunca em runtime no Worker, que só importa o
 * HTML já gerado). */
export function renderHubPage(hub: HubContent): string {
  const violations = validateHubContent(hub);
  if (violations.length > 0) {
    throw new Error(`renderHubPage: HubContent inválido para "${hub.slug}":\n- ${violations.join("\n- ")}`);
  }
  const url = pageUrl(hub.slug);
  const pageTitle = `${hub.title} — cobertura da diar.ia.br`;

  // Achado do editor (260804): sem um rótulo próprio, as sections (H2 já em
  // formato de pergunta, issue #4558 item 2) ficam indistinguíveis do bloco
  // "Perguntas frequentes" logo abaixo — as duas leem como "pergunta seguida
  // de resposta" na sequência da página, mas só uma tem nome. O kicker
  // "Cobertura completa" (mesmo estilo visual de `.hub-sources h2`/
  // `.geo-faq-heading` — pequeno, versalete, teal) marca a diferença: aqui é
  // a síntese longa (issue Parte A, "leitura que só existe porque alguém
  // acompanhou por meses"); "Perguntas frequentes" abaixo é o bloco curto
  // que vira dado estruturado FAQPage (issue Parte B item 3).
  const sectionsHtml = `    <section class="hub-sections" aria-labelledby="cobertura-heading">
      <h2 class="hub-sections-heading" id="cobertura-heading">Cobertura completa</h2>
${hub.sections
  .map(
    (s) => `      <article class="hub-section">
        <h2>${esc(s.heading)}</h2>
${s.paragraphs.map((p) => `        <p>${renderParagraphInline(p)}</p>`).join("\n")}
      </article>`,
  )
  .join("\n")}
    </section>`;

  const sourcesHtml = `    <section class="hub-sources" aria-labelledby="fontes-heading">
      <h2 id="fontes-heading">Edições da diar.ia.br citadas nesta página</h2>
      <ul>
${hub.sourceEditions
  .map((e) => {
    const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(e.date);
    const label = dm ? `${dm[3]}/${dm[2]}` : e.date;
    return `        <li><a href="${esc(e.url)}"><span class="li-date">${esc(label)}</span>${esc(e.title)}</a></li>`;
  })
  .join("\n")}
      </ul>
    </section>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
${renderSeoMeta({ title: pageTitle, description: hub.metaDescription, url })}
<meta name="robots" content="index, follow">
<style>
${renderCuradoriaRootStyles()}

${renderCuradoriaHeaderStyles()}

${renderHubBodyStyles()}

${renderGeoFaqStyles()}

${renderCuradoriaFooterStyles()}
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="eyebrow">diar.ia.br · Arquivo · Temas</p>
      <hr class="rule">
      <h1>${esc(hub.title)}<span class="dot" aria-hidden="true">.</span></h1>
      <p class="tagline">5 minutos diários pra se manter atualizado e usar melhor as IAs</p>
      <div class="geo-intro-wrap">
        <h2 class="geo-h2">${esc(hub.introHeading)}</h2>
        <p class="geo-intro">${esc(hub.introParagraph)}</p>
${renderGeoByline(undefined, `atualizado em ${formatMonthYear(hub.contentDate)}`)}
      </div>
      <p class="subscribe-cta"><a href="${esc(SUBSCRIBE_URL)}">Assine a diar.ia.br →</a></p>
    </div>
  </header>
  <main>
    <div class="wrap">
${sectionsHtml}
${sourcesHtml}
${renderGeoFaqSection(hub.faq, `faq-${hub.slug}`)}
    </div>
  </main>
  ${renderCuradoriaFooter(
    `diar.ia.br — hub temático: ${hub.title}`,
    `utm_source=${hub.footerNavUtm.source}&utm_medium=${hub.footerNavUtm.medium}`,
  )}
${renderGeoJsonLd({
  pageUrl: url,
  headline: pageTitle,
  description: hub.metaDescription,
  datePublished: hub.contentDate,
  dateModified: hub.contentDate,
  faq: hub.faq,
})}
</body>
</html>
`;
}
