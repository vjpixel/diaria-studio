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
 * mesmo padrão de `courses-full.generated.ts`), então `publishedDate`/
 * `updatedDate` em `HubContent` (#4911 — campos separados de propósito,
 * nunca podem colapsar num só) precisam ser literais `YYYY-MM-DD` — um
 * valor dinâmico quebraria o teste de asset-drift (compara o HTML
 * committed contra um render fresco).
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
import { renderInlineLinks } from "./markdown-links.ts"; // #4558/#4635: parser [texto](url), compartilhado com geo-faq.ts (respostas de FAQ também ganharam link)
import { DIARIA_ARQUIVO_URL } from "../canonical-urls.ts";
import { applyBrandWordmark } from "./brand-wordmark.ts"; // #4797 — wordmark da marca no corpo do hub (introParagraph não passa por renderInlineLinks — ver nota do campo)

/** Uma edição da diar.ia.br citada como fonte do hub — link interno real
 * (issue #4558: "efeito colateral bom: hub temático é link interno de
 * verdade"). `url` é sempre o domínio de marca (`diar.ia.br/p/{slug}`, não
 * `diaria.beehiiv.com` — #4059). */
export interface HubSourceEdition {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Manchete(s) que casaram a palavra-chave do hub (`matchedHeadlines`
   * joinado com " · " — ver `toSourceEditions` de cada `scripts/lib/hubs/{slug}.ts`).
   * NÃO é necessariamente o título da edição pra onde `url` aponta — a
   * manchete casada é frequentemente um destaque secundário da edição
   * (issue #4918). */
  title: string;
  /** Título real da edição apontada por `url` (`post.title` do cache
   * Beehiiv, ou fallback via `workers/arquivo/src/titles-cache.json` —
   * `scripts/generate-hub-sources.ts`). Opcional: ausência cai no rótulo
   * antigo, só com `title` (#4918 Conserto 2). */
  editionTitle?: string;
  url: string;
}

/** Rótulo textual de uma fonte citada — usado tanto no `<li>` visível
 * quanto no `name` do `ListItem` do JSON-LD (paridade, #4558 Parte B). Sem
 * `editionTitle`, cai no comportamento antigo: só a manchete. Com
 * `editionTitle` presente, mostra os dois — a manchete que casou a
 * palavra-chave E a edição real pra onde o link aponta (issue #4918: "o
 * item não diz de qual edição veio") — EXCETO quando `editionTitle` já
 * aparece dentro de `title` (idêntico, ou uma das manchetes do join " · "
 * nos ~8 itens por hub que casam 2+ manchetes na mesma edição — achado do
 * self-review: comparar só contra a string inteira deixava passar
 * "A · B (edição: A)" quando `editionTitle` era exatamente a manchete A). */
export function sourceEditionLabel(e: HubSourceEdition): string {
  if (e.editionTitle && !e.title.split(" · ").includes(e.editionTitle)) {
    return `${e.title} (edição: ${e.editionTitle})`;
  }
  return e.title;
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
   * `[texto](url)` (`scripts/lib/shared/markdown-links.ts::renderInlineLinks`)
   * — mesmo suporte das respostas de `GeoFaqItem.answer` (#4635 item 3).
   * `introParagraph`/`metaDescription` continuam SEM suporte a link
   * (renderizados via `esc()` puro) — um `[texto](url)` nesses dois campos
   * renderiza colchete literal, não link. `introParagraph` GANHA o wordmark
   * da marca (#4797, `applyBrandWordmark` pós-`esc()`) — `metaDescription`
   * não, porque vira valor de atributo (`<meta content="...">`/`og:description`
   * via `renderSeoMeta`), onde HTML cru quebraria o atributo. */
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
  /** `YYYY-MM-DD` estático — dia em que a página nasceu (issue #4911: campo
   * separado de `updatedDate` de propósito — os dois nunca podem divergir
   * quando são o mesmo campo, e é exatamente essa impossibilidade
   * estrutural que fazia `dateModified` do JSON-LD mentir sempre que só o
   * corpo mudava). Ver nota do módulo sobre por que estático. */
  publishedDate: string;
  /** `YYYY-MM-DD` estático — dia em que o CORPO da página foi revisado por
   * último (prosa de `sections`/`introParagraph`/`metaDescription`/FAQ).
   * Bump manual junto de qualquer edição de conteúdo — nunca cosmético
   * (#4911: um bump sem mudança de corpo é o padrão que a issue desaconselha
   * explicitamente). `validateHubContent` exige `updatedDate >= publishedDate`
   * e `updatedDate >= data da fonte mais recente em `sourceEditions`. */
  updatedDate: string;
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
  /* #4558: .geo-h2 (H2 da intro, geo-faq.ts) não tem max-width no módulo
     compartilhado. Livros/cursos/arquivo usam o MESMO container .wrap de
     1120px (curadoria-page.ts) — não têm um container mais estreito, só um
     introHeading mais curto (~57-70 caracteres) que por coincidência não
     estoura 720px ali dentro. O introHeading do hub (~89 caracteres,
     scripts/lib/hubs/anthropic-claude.ts) é mais longo, e sem este override
     ficava mais largo que o parágrafo logo abaixo (que TEM max-width via
     .geo-intro) e que o resto da página. Correção do comentário original
     (achado do fleet review da PR #4642): mesmo bug pode aparecer em
     livros/cursos/arquivo se o texto de intro deles crescer — não é
     estruturalmente impossível lá, só não aconteceu ainda. Achado do editor
     260804. */
  .geo-intro-wrap { max-width: 720px; }
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hub.publishedDate)) {
    errors.push(`publishedDate "${hub.publishedDate}" não é YYYY-MM-DD`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hub.updatedDate)) {
    errors.push(`updatedDate "${hub.updatedDate}" não é YYYY-MM-DD`);
  }
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(hub.publishedDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(hub.updatedDate) &&
    hub.updatedDate < hub.publishedDate
  ) {
    errors.push(`updatedDate "${hub.updatedDate}" é anterior a publishedDate "${hub.publishedDate}"`);
  }
  // #4911: um hub não pode alegar atualização anterior à última fonte que
  // ele mesmo lista — sourceEditions está ordenado mais-recente-primeiro
  // (invariante checado abaixo), então o índice 0 é a data mais recente.
  if (
    hub.sourceEditions.length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(hub.updatedDate) &&
    hub.updatedDate < hub.sourceEditions[0].date
  ) {
    errors.push(
      `updatedDate "${hub.updatedDate}" é anterior à edição mais recente citada em sourceEditions ("${hub.sourceEditions[0].date}")`,
    );
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
${s.paragraphs.map((p) => `        <p>${renderInlineLinks(p)}</p>`).join("\n")}
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
    // #4911 item 4: com ano (DD/MM/AAAA) — o intervalo cruza virada de ano,
    // e sem ano dois rótulos "03/09" podem mapear pra anos distintos.
    const label = dm ? `${dm[3]}/${dm[2]}/${dm[1]}` : e.date;
    // #4918 Conserto 1: separador textual explícito entre data e título —
    // sem isso, quem extrai o texto do <li> (assistente, leitor de tela,
    // colagem) recebe "06/08/2026Modelo da Anthropic..." colado, sem
    // fronteira nenhuma (a separação era só visual, via margin-right). Um
    // espaço solto não sobrevive a colapso de whitespace na extração — por
    // isso " — " (travessão) e não `&nbsp;`/espaço puro.
    return `        <li><a href="${esc(e.url)}"><span class="li-date">${esc(label)}</span> — ${esc(sourceEditionLabel(e))}</a></li>`;
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
        <p class="geo-intro">${applyBrandWordmark(esc(hub.introParagraph))}</p>
${renderGeoByline(undefined, `atualizado em ${formatMonthYear(hub.updatedDate)}`)}
      </div>
      <p class="subscribe-cta"><a href="${esc(SUBSCRIBE_URL)}">Assine a diar.ia.br →</a></p>
    </div>
  </header>
  <main>
    <div class="wrap">
${sectionsHtml}
<!-- #4635/#4642: FAQ logo após .hub-sections (não depois de .hub-sources) —
     achado do editor: a lista de edições citadas fica melhor por último,
     como bibliografia; "Perguntas rápidas" (heading próprio, não o default
     "Perguntas frequentes" de livros/cursos/arquivo) evita ler como um 2º
     bloco de FAQ idêntico ao de .hub-sections logo acima. -->
${renderGeoFaqSection(hub.faq, { sectionId: `faq-${hub.slug}`, heading: "Perguntas rápidas" })}
${sourcesHtml}
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
  datePublished: hub.publishedDate,
  dateModified: hub.updatedDate,
  faq: hub.faq,
  // #4558 Parte B: a lista de fontes já visível em `.hub-sources` (issue
  // item 6, "dados e números próprios") também vira `ItemList` estruturado —
  // mesmos itens, mesma ordem, nenhuma reformulação (paridade com o FAQ).
  // #4918: `name` usa `sourceEditionLabel` — o MESMO texto que entra no
  // rótulo visível do `<li>` (menos a data), preservando a paridade
  // visível↔schema que `test/build-hub-page.test.ts` trava.
  itemList: {
    name: `Edições da diar.ia.br citadas em ${hub.title}`,
    items: hub.sourceEditions.map((e) => ({ name: sourceEditionLabel(e), url: e.url })),
  },
})}
</body>
</html>
`;
}
