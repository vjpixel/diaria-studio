/**
 * geo-faq.ts (#4558 Parte B)
 *
 * Bloco de estrutura GEO ("Generative Engine Optimization") compartilhado
 * pelas 3 páginas de curadoria já existentes (livros, cursos, arquivo) — não
 * cobre hubs temáticos novos (Parte A do #4558, deliberadamente fora de
 * escopo desta sessão — decisão do editor 260804, exige síntese editorial
 * genuína, não conteúdo raso). Objetivo: aumentar a chance de a página ser
 * CITADA por um assistente (ChatGPT/Claude/Gemini/Perplexity) quando alguém
 * pergunta algo relacionado — não SEO tradicional de ranqueamento no Google
 * (rationale completo no corpo da #4558: 24 impressões/1 clique em 9 dias,
 * 1 domínio externo apontando pro site — ranquear depende de autoridade que
 * não existe; ser citado depende mais de estrutura e especificidade).
 *
 * Os 6 elementos pedidos pela issue, e onde cada um vive:
 *   1. Resposta à pergunta principal nos primeiros ~200 palavras — cada
 *      caller escreve o próprio parágrafo intro (conteúdo editorial, não
 *      boilerplate — este módulo não gera prosa introdutória).
 *   2. H2 em formato de pergunta literal — idem, cada caller escreve o H2
 *      da intro; só o H2 do bloco de FAQ (`renderGeoFaqSection`) é genérico.
 *   3. Bloco de 6-10 perguntas e respostas — `renderGeoFaqSection` abaixo.
 *   4. Schema FAQPage + Article em JSON-LD — `renderGeoJsonLd` abaixo.
 *   5. Autor nomeado e verificável externamente — `GEO_AUTHOR` (Pixel,
 *      editor da diar.ia.br — mesmo identificador já usado em
 *      `scripts/lib/inbox-stats.ts`/`scripts/render-categorized-md.ts` no
 *      rodapé de e-mail: "[Pixel](https://www.linkedin.com/in/vjpixel/)").
 *      Exposto duas vezes: `renderGeoByline` (visível, clicável) + `author`
 *      no JSON-LD (estruturado) — um identificador novo por página não
 *      seria "verificável", seria só mais uma alegação.
 *   6. Dados e números próprios — cada caller deriva do próprio dataset
 *      (contagens, distribuições reais) ao montar `GeoFaqItem[]`; este
 *      módulo só formata, nunca inventa número.
 *
 * IMPORTANTE — datas estáticas, não wall-clock: `datePublished`/
 * `dateModified` do Article NÃO devem usar `new Date()` em runtime nas
 * páginas geradas por script (livros/cursos) — isso quebraria
 * `test/livros-asset-drift.test.ts`/`test/cursos-asset-drift.test.ts`
 * (comparam o HTML committed contra um render FRESCO; uma data de "hoje"
 * nunca bateria com o commit de ontem). `arquivo` é a exceção: é renderizado
 * por request a partir de dados live (sitemap), então pode derivar
 * `dateModified` deterministicamente da ENTRADA (data da edição mais
 * recente no sitemap) sem quebrar nenhum teste — ver `render-archive.ts`.
 */
import { escHtml as esc } from "../html-escape.ts";
import { renderInlineLinks, stripMarkdownLinks } from "./markdown-links.ts"; // #4635: respostas de FAQ do hub ganham link [texto](url); outras 3 páginas não usam o subset, comportamento intacto

export interface GeoAuthor {
  name: string;
  /** URL externa que confirma a identidade (perfil verificável). */
  url: string;
}

/** Autor canônico das páginas de curadoria — mesmo identificador já usado no
 * rodapé de e-mail da newsletter ("[Pixel](https://www.linkedin.com/in/vjpixel/)",
 * `scripts/render-categorized-md.ts`/`scripts/lib/inbox-stats.ts`). Reusar o
 * MESMO identificador em toda superfície pública é o que torna a verificação
 * externa possível — um nome/perfil novo por página não seria "verificável",
 * seria só uma alegação a mais. */
export const GEO_AUTHOR: GeoAuthor = {
  name: "Pixel",
  url: "https://www.linkedin.com/in/vjpixel/",
};

export interface GeoFaqItem {
  /** Pergunta literal, no formato como alguém perguntaria a um assistente. */
  question: string;
  /** Resposta completa. Suporta o subset de markdown `[texto](url)`
   * (#4635 item 3, `scripts/lib/shared/markdown-links.ts`) — renderizado
   * como `<a href>` de verdade no bloco visível (`renderInlineLinks`, via
   * `renderGeoFaqSection`) e como TEXTO PURO sem colchete/URL no JSON-LD
   * (`stripMarkdownLinks`, via `renderGeoJsonLd`), nunca o mesmo texto cru
   * nos dois lugares quando há link: schema.org espera prosa legível em
   * `acceptedAnswer.text`, não markup — Google invalidaria o rich result
   * se recebesse `[texto](url)` literal ali. Sem `[texto](url)` na resposta
   * (caso de livros/cursos/arquivo hoje) as duas saídas são idênticas ao
   * texto de entrada, como antes de #4635. */
  answer: string;
}

/** Bloco de FAQ visível (issue #4558: 6-10 perguntas — quem monta a lista
 * decide a contagem exata; este módulo não valida o intervalo, é
 * responsabilidade do caller). H2 por pergunta, sem `<details>`/accordion:
 * o objetivo é responder direto no HTML server-rendered, não esconder atrás
 * de um clique que um crawler de assistente não executa.
 *
 * `answer` suporta o subset de markdown `[texto](url)` (renderizado via
 * `renderInlineLinks`, #4635 item 3 — resposta de FAQ também vira link
 * interno pra edição de origem) — livros/cursos/arquivo não usam esse
 * subset hoje, então o comportamento pra eles é idêntico a antes (`esc()`
 * puro quando não há `[...](...)` no texto).
 *
 * `opts.heading` (#4635 item 1): rótulo do H2 do bloco — default "Perguntas
 * frequentes" preserva o comportamento das 3 páginas antigas; o hub passa
 * um rótulo próprio pra não ler como um 2º bloco de FAQ idêntico ao de
 * `.hub-sections` logo acima (achado do editor 260804).
 *
 * `sectionId`/`heading` como objeto de opções, não 2 parâmetros posicionais
 * soltos (achado do fleet review da PR #4642): os dois são `string`
 * opcionais — nomeados, uma troca de ordem num call site futuro não
 * compila limpo silenciosamente como compilaria com posição. */
export function renderGeoFaqSection(
  items: GeoFaqItem[],
  opts: { sectionId?: string; heading?: string } = {},
): string {
  const { sectionId = "faq", heading = "Perguntas frequentes" } = opts;
  const blocks = items
    .map(
      (item) => `    <div class="geo-faq-item">
      <h2>${esc(item.question)}</h2>
      <p>${renderInlineLinks(item.answer)}</p>
    </div>`,
    )
    .join("\n");
  return `  <section class="geo-faq" id="${esc(sectionId)}" aria-labelledby="${esc(sectionId)}-heading">
    <h2 id="${esc(sectionId)}-heading" class="geo-faq-heading">${esc(heading)}</h2>
${blocks}
  </section>`;
}

/** CSS do bloco de FAQ — Georgia serif pros H2 (mesmo DS canônico das outras
 * seções de curadoria), sem accordion/JS (issue #4558: a resposta tem que
 * estar no HTML, não atrás de um toggle que um crawler não clica). */
export function renderGeoFaqStyles(): string {
  return `  .geo-faq { margin: 48px 0 0; padding: 32px 0 0; border-top: 1px solid var(--rule); }
  .geo-faq-heading { font-family: Georgia, 'Times New Roman', serif; font-size: 15px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--teal); margin: 0 0 24px; }
  .geo-faq-item { margin: 0 0 28px; }
  .geo-faq-item h2 { font-family: Georgia, 'Times New Roman', serif; font-size: 20px; font-weight: 600;
    line-height: 1.3; margin: 0 0 8px; color: var(--ink); }
  .geo-faq-item p { font-size: 16px; line-height: 1.6; margin: 0; color: var(--ink); }
  .geo-byline { font-size: 13px; color: var(--ink); margin: 8px 0 0; }
  .geo-byline a { color: var(--teal); text-decoration: none; }
  .geo-byline a:hover { text-decoration: underline; }
  .geo-intro { font-size: 17px; line-height: 1.6; color: var(--ink); margin: 20px 0 0; max-width: 720px; }
  .geo-h2 { font-family: Georgia, 'Times New Roman', serif; font-size: 26px; font-weight: 700;
    line-height: 1.25; color: var(--ink); margin: 32px 0 12px; }`;
}

/** Linha de crédito visível ("Por Pixel") — autoria NOMEADA e clicável
 * (issue #4558 item 5: precisa ser verificável externamente, não só uma
 * string solta em JSON-LD que ninguém vê na página). */
export function renderGeoByline(author: GeoAuthor = GEO_AUTHOR, dateLabel?: string): string {
  const datePart = dateLabel ? ` · ${esc(dateLabel)}` : "";
  return `  <p class="geo-byline">Por <a href="${esc(author.url)}" rel="author">${esc(author.name)}</a>${datePart}</p>`;
}

const PT_BR_MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

/**
 * Formata uma data `YYYY-MM-DD` como "{mês} de {ano}" em pt-BR (ex:
 * "2026-08-04" → "agosto de 2026"). Achado #4616 (code-reviewer, PR #4558
 * B+C): `build-cursos-page.ts`/`build-livros-page.ts` hardcodavam o texto
 * visível do byline ("atualizado em agosto de 2026") como string literal
 * independente de `GEO_CONTENT_DATE` — um bump futuro da constante não
 * atualizava o texto que o leitor vê, criando divergência com
 * `datePublished`/`dateModified` do JSON-LD (exatamente o tipo de
 * inconsistência que validadores de dado estruturado do Google sinalizam).
 * `formatMonthYear` deriva o rótulo DA constante, então os dois nunca podem
 * divergir. Pure — lança se `dateIso` não bater no formato esperado (fail
 * loud em vez de imprimir uma data quebrada silenciosamente).
 */
export function formatMonthYear(dateIso: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(dateIso);
  if (!m) throw new Error(`formatMonthYear: data inválida "${dateIso}", esperado YYYY-MM-DD`);
  const [, year, month] = m;
  const monthName = PT_BR_MONTHS[Number(month) - 1];
  if (!monthName) throw new Error(`formatMonthYear: mês inválido "${month}" em "${dateIso}"`);
  return `${monthName} de ${year}`;
}

/** Item de uma lista estruturada (`ItemList`) — issue #4558 Parte B, mesma
 * lógica do item 6 ("dados e números próprios"): a lista de fontes de um hub
 * (ou qualquer outra página que enumere itens com URL própria) já EXISTE no
 * HTML visível; isto só espelha esses mesmos itens em dado estruturado, pra
 * que um assistente enxergue a estrutura sem precisar fazer parsing de
 * `<li>`. */
export interface GeoItemListEntry {
  name: string;
  url: string;
}

export interface GeoJsonLdOptions {
  /** URL absoluta canônica da página. */
  pageUrl: string;
  /** Título do artigo/página (headline do Article). */
  headline: string;
  /** Descrição curta (~150-160 chars). */
  description: string;
  /** `YYYY-MM-DD`. Ver nota do módulo — estático em livros/cursos, dinâmico em arquivo. */
  datePublished: string;
  /** `YYYY-MM-DD`. */
  dateModified: string;
  /** As MESMAS perguntas/respostas do bloco visível (`renderGeoFaqSection`) —
   * nunca um subconjunto ou reformulação. */
  faq: GeoFaqItem[];
  author?: GeoAuthor;
  /** Nome do site — default "diar.ia.br". */
  siteName?: string;
  /** `ItemList` opcional (issue #4558 Parte B) — pra páginas que enumeram
   * itens com URL própria no HTML visível (ex: a lista de edições-fonte de
   * um hub temático). Omitido (ou lista vazia) → nenhum node `ItemList` no
   * `@graph`, comportamento idêntico a antes desta opção existir (livros,
   * cursos e arquivo não passam este campo). `items` deve ser EXATAMENTE os
   * mesmos itens do bloco visível, na mesma ordem — mesma disciplina de
   * paridade já aplicada ao FAQ acima. */
  itemList?: { name: string; items: readonly GeoItemListEntry[] };
}

/**
 * Monta o `<script type="application/ld+json">` com `@graph` de 2 nodes —
 * `FAQPage` (mainEntity = as perguntas/respostas visíveis) e `Article`
 * (autor nomeado, datas, publisher, `inLanguage`). Pure — string pronta pra
 * interpolar no `<head>`, entre `<title>` e `<style>`.
 *
 * `acceptedAnswer.text` usa `stripMarkdownLinks(item.answer)` (#4635 item
 * 3) — schema.org espera texto legível ali, não markup; embutir
 * `[texto](url)` cru faria um crawler/rich-result mostrar colchete e
 * parêntese literais na resposta. O bloco VISÍVEL (`renderGeoFaqSection`)
 * continua renderizando o link de verdade — só o JSON-LD recebe a versão
 * sem marcação.
 */
export function renderGeoJsonLd(opts: GeoJsonLdOptions): string {
  const { pageUrl, headline, description, datePublished, dateModified, faq, siteName = "diar.ia.br" } = opts;
  const author = opts.author ?? GEO_AUTHOR;
  const graph: Record<string, unknown>[] = [
    {
      "@type": "FAQPage",
      "@id": `${pageUrl}#faq`,
      mainEntity: faq.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: stripMarkdownLinks(item.answer) },
      })),
    },
    {
      "@type": "Article",
      "@id": `${pageUrl}#article`,
      headline,
      description,
      url: pageUrl,
      mainEntityOfPage: pageUrl,
      datePublished,
      dateModified,
      author: { "@type": "Person", name: author.name, url: author.url },
      publisher: { "@type": "Organization", name: siteName, url: "https://diar.ia.br" },
      inLanguage: "pt-BR",
    },
  ];
  if (opts.itemList && opts.itemList.items.length > 0) {
    graph.push({
      "@type": "ItemList",
      "@id": `${pageUrl}#itemlist`,
      name: opts.itemList.name,
      numberOfItems: opts.itemList.items.length,
      itemListElement: opts.itemList.items.map((item, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: item.name,
        url: item.url,
      })),
    });
  }
  // </script>-safe embed — mesmo padrão de themeLabelJson em build-livros-page.ts/build-cursos-page.ts.
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replaceAll("<", "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}
