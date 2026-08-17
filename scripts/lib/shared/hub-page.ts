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
 * **Densidade de "[fonte primária]" — decisão do editor (sessão develop
 * 260811b), retrofit em todos os hubs publicados até então.** O padrão
 * `[texto](link interno diar.ia.br) [fonte primária](link externo)` existe
 * desde o 1º hub, mas cresceu sem teto de densidade — chegou a quase toda
 * frase carregando os dois links, poluindo a leitura (achado ao vivo:
 * anthropic-claude tinha 26 ocorrências, mercado-trabalho 40). A pesquisa
 * de GEO que embasa a #4558 já registra que nenhuma técnica de otimização
 * — densidade de citação inclusa — tem efeito causal estável e comprovado
 * sobre ser citado por assistente (survey arXiv 2607.14035), então
 * `[fonte primária]` não compra ganho de GEO mensurável; compra
 * verificabilidade, com retorno decrescente rápido — a 2ª citação na mesma
 * frase não verifica nada que a 1ª já não tenha resolvido. **Regra:** no
 * máximo 1-2 `[fonte primária]` por `HubSection`, reservados pro dado mais
 * duro/mais checável do trecho (percentual, valor de multa, decisão
 * judicial, texto de lei) — nunca em manchete que já é a unidade de valor
 * por si (ex: "a empresa X demitiu N pessoas"), onde o link interno já
 * basta (a própria edição citada já linkou a fonte dela). Link interno
 * (`diar.ia.br/p/...`) continua em TODA menção, sem teto — resolve um
 * problema estrutural real e medido (auditoria de 10/08: 49 das 76 edições
 * citadas pelo hub piloto não indexadas, 42 nunca rastreadas; o hub serve
 * de link interno pra essas páginas órfãs).
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
 *
 * **`updatedDate` != frescor de dado, `coverageDate` != data de edição
 * (#5124).** `updatedDate` (acima) responde "quando a PROSA foi revisada" —
 * um bump legítimo sem nenhuma fonte nova (typo, reformulação). O que o
 * Google/JSON-LD/sitemap deveriam ler pra decidir se vale re-rastrear é
 * outra pergunta: "até quando a COBERTURA vai" — e essa segunda pergunta já
 * tinha resposta estrutural (a data mais recente em `sourceEditions`, ver
 * `hubCoverageDate` abaixo), só que `dateModified`/`<lastmod>`/
 * `Last-Modified` liam `updatedDate` em vez dela. Achado ao vivo em
 * 12/08/2026: um commit que só REMOVE conteúdo (`brasil-regulacao`, #5071 —
 * "reduz densidade de fonte primária") bumpou `updatedDate` pra hoje sem
 * adicionar nenhuma fonte nova; a página passou a declarar `Last-Modified`
 * de hoje citando uma edição de 48 dias atrás. `hubCoverageDate` é
 * DERIVADO de `sourceEditions` (nunca um campo próprio em `HubContent`) —
 * diferente do par `publishedDate`/`updatedDate`, que precisam ser
 * settáveis independentemente na autoria, `coverageDate` não tem nenhum
 * grau de liberdade além do dataset: armazená-lo separado reintroduziria
 * exatamente o risco de divergência que a nota de `publishedDate` acima já
 * descreve (dois campos que podem, em teoria, discordar do que deveriam
 * sempre concordar).
 */
import { escHtml as esc } from "../html-escape.ts";
import { slugify } from "../slug.ts"; // #5266 — id determinístico dos H2 de seção pro índice navegável
import { renderSeoMeta, renderAnalyticsHead } from "./seo-meta.ts"; // #5498: container GTM
import {
  renderCuradoriaRootStyles,
  renderCuradoriaHeaderStyles,
  renderCuradoriaFooterStyles,
  renderCuradoriaFooter,
  renderCuradoriaCtaSubscribeStyles,
  renderCuradoriaCtaSubscribeForm,
  renderCuradoriaCtaSubscribeScript,
} from "./curadoria-page.ts"; // #5167 item 2: form inline substitui o link puro pro /subscribe hospedado na Beehiiv
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
import { checkHubFacts } from "./hub-fact-gate.ts"; // #5060 Parte B1 — gate mecânico (cronologia derivada, link↔fonte, âncora de data, data futura); só `import type` daqui pra lá, evita ciclo de módulo real

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

/** Bloco de tabela opcional de uma `HubSection` (#4921 Onda 2) — dado
 * tabular específico da seção, DERIVADO de `SOURCES` em build-time e jamais
 * transcrito à mão (mesma disciplina de `deriveAnthropicClaudeFacts` em
 * `scripts/lib/hubs/anthropic-claude.ts`: um número que existe em dois
 * lugares e só um deles é fórmula é exatamente o padrão que produziu a
 * divergência hiato/dias que a auditoria #4558 catalogou como achado M-07).
 * Onda 1 (bibliografia, `.hub-sources`) já é `<table>` — este é o SEGUNDO
 * lugar da página que ganha tabela, um por seção, sempre opcional. */
export interface HubSectionTable {
  /** Legenda curta — vira `<caption>` (a11y: leitor de tela anuncia antes do
   * conteúdo da tabela). NÃO repete o H2 da seção — a seção já pergunta, a
   * legenda nomeia o que a tabela especificamente cobre. */
  caption: string;
  /** Nota de proveniência da amostra — janela, tamanho e o que é contado
   * (issue #4921 item 8). SEMPRE derivada via `defaultTableMethodologyNote`
   * (ou equivalente que leia `sources` diretamente) — nunca texto livre;
   * ver a mesma exigência em `HubContent.methodologyNote`. */
  methodology: string;
  /** Cabeçalho das colunas — vira `<th>`. */
  headers: readonly string[];
  /** Corpo da tabela — cada linha é uma tupla de células com a MESMA
   * aridade de `headers` (validado por `validateHubContent`, issue item 9).
   * Suporta o mesmo subset de markdown `[texto](url)`
   * (`renderInlineLinks`) que `paragraphs` já aceita — decisão explícita
   * (issue item 6, "decidir"): a coluna final de uma tabela derivada de
   * `SOURCES` é tipicamente um link pra edição, então célula só-texto
   * (`esc()` puro) obrigaria achatar esse link pra fora da tabela. */
  rows: readonly (readonly string[])[];
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
  /** Bloco de tabela OPCIONAL (#4921 Onda 2) — a candidata explícita da
   * issue é a cronologia de lançamento de `anthropic-claude` (S1), mas o
   * campo é genérico: qualquer seção de qualquer hub pode ganhar uma tabela
   * própria quando o dado subjacente for tabular e derivável. **Não
   * estender a outros hubs nesta onda** sem remedir — a issue documenta
   * isso como fora de escopo (`google-gemini` tem forma diferente). */
  table?: HubSectionTable;
}

export interface HubContent {
  /** Usado na rota (`/temas/{slug}`) e no path do arquivo gerado. */
  slug: string;
  /** `<title>` (via `pageTitle`, montado em `renderHubPage`) e rótulo curto
   * usado por `og:title`/`workers/arquivo/src/hubs/meta.ts`. Ex: "Anthropic
   * e Claude". Continua a ÚNICA fonte desses dois consumidores — `h1` abaixo
   * não os substitui, só o `<h1>` visível. */
  title: string;
  /** `<h1>` visível da página — opcional, default para `title` quando
   * ausente (#4912: hub que ainda não foi migrado continua funcionando sem
   * mudança). Existe pra separar o rótulo curto de navegação/`<title>`
   * (`title`, acima) do heading que carrega o intervalo coberto na prosa
   * (ex: "Anthropic e Claude — de agosto de 2025 a agosto de 2026") sem
   * duplicar esse período no `<title>`/`og:title`. Deriva o intervalo de
   * `hubCoverageWindow(SOURCES)` no `get{Hub}Hub()` de cada
   * `scripts/lib/hubs/{slug}.ts` — nunca hardcoded (mesma disciplina de
   * `metaDescription`/`introHeading`). */
  h1?: string;
  metaDescription: string;
  /** H2 em formato de pergunta literal do bloco intro (issue item 2). */
  introHeading: string;
  /** Responde a pergunta principal por inteiro, ~200 palavras no total (issue
   * item 1). Aceita `string` (1 `<p class="geo-intro">`, comportamento
   * original) OU um array não-vazio de strings (#5259, "Código habilitador"
   * — 1 `<p class="geo-intro">` POR elemento, na mesma ordem) — existe pra
   * caber o orçamento de ~200 palavras sem produzir um parágrafo-paredão
   * único: o guard de `validateHubContent` (`HUB_MAX_PARAGRAPH_WORDS`) trata
   * CADA elemento como uma unidade independente, exatamente como já trata
   * `sections[].paragraphs`. `applyBrandWordmark` é aplicado a CADA `<p>`
   * (não só ao primeiro) — ver `renderHubPage`. Um hub cujo intro já cabe
   * numa unidade só pode continuar usando `string`; não é obrigatório virar
   * array. */
  introParagraph: string | readonly [string, ...string[]];
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
  /** Ressalva epistêmica do hub — de onde vem o levantamento e o que ele NÃO
   * é (#4939/#4930). Campo OBRIGATÓRIO de propósito: a #4938 removeu do corpo
   * do texto as ~103 construções em que a publicação ocupava o lugar de
   * sujeito ou servia de moldura ("a diar.ia.br cobriu...", "segundo a
   * diar.ia.br..."), e este campo é o único lugar que sobrou pra dizer qual é
   * a base de evidência da página — não só de quem ela é. Opcional reabriria
   * o mesmo buraco que o contrato de prosa veio fechar: hub futuro nasceria
   * sem, porque nada obriga a preencher. Use `defaultMethodologyNote(SOURCES)`
   * pra derivar o texto padrão — nunca digitar N/início/fim à mão (mesma
   * disciplina de `hubCoverageWindow`). Ver nota de `HUB_PROSE_RULES` sobre a
   * isenção de `prosa-sem-deixis` que este campo recebe. */
  methodologyNote: string;
  /** Hubs irmãos pra nav "Outros temas" do rodapé (#4913 item 1 — os hubs
   * eram ilhas, só o índice do arquivo linkava pra eles, nunca o inverso).
   * OPCIONAL e preenchido por `scripts/build-hub-page.ts` (nunca pelo próprio
   * `get{Hub}Hub()` de `scripts/lib/hubs/{slug}.ts`) — é ele quem já enumera
   * `HUB_LOADERS`/importa `HUB_META` e filtra o slug atual. `hub-page.ts`
   * (este módulo) NÃO importa `workers/arquivo/src/hubs/meta.ts` diretamente,
   * de propósito: inverteria a fronteira que a docstring de `meta.ts`
   * estabelece (cada consumidor importa só o que consome; `test/lib-boundary.test.ts`
   * não pegaria essa direção, mas a razão aqui é de desenho, não de lint).
   * Ausente/vazio (hub único, ou fixture de teste) não emite a seção. */
  relatedHubs?: readonly { readonly slug: string; readonly label: string }[];
  /** Capa pra `og:image`/`twitter:image` (#5131, decisão #3106 reaberta) —
   * a capa da EDIÇÃO MAIS RECENTE que este hub cita (`sourceEditions[0]`,
   * mais viva, reusa asset que já existe — decisão da issue), não uma capa
   * fixa por hub. OPCIONAL e preenchido por `scripts/build-hub-page.ts`
   * (mesmo padrão de `relatedHubs` acima) via lookup em
   * `workers/arquivo/src/titles-cache.json` — `hub-page.ts` (este módulo)
   * não sabe de onde a URL vem, só que existe ou não. Ausente (post sem
   * thumbnail, ou cache ainda sem `coverImageUrl` — ver docstring de
   * `generate-arquivo-titles.ts`) → `renderSeoMeta` omite og:image,
   * comportamento idêntico a antes do #5131. */
  coverImage?: { readonly url: string; readonly width: number; readonly height: number };
  /** Mapa `url → título real da edição` (#5265), OPCIONAL — resolvido por
   * `scripts/build-hub-page.ts` via lookup em
   * `workers/arquivo/src/titles-cache.json` (mesmo cache que já alimenta
   * `coverImage` acima), NUNCA por `get{Hub}Hub()` (mesmo racional de
   * `relatedHubs`/`coverImage`: só o builder Node-side importa esse cache).
   * Cobre só `sections[].paragraphs`/`sections[].table.rows` — os links de
   * PROSA do corpo do hub, alvo real da issue ("menções em prosa linkam a
   * edição onde a manchete foi destaque secundário, sem aviso"). FAQ/
   * metodologia ficam FORA de propósito (escopo P3 contido: ver PR). Ausente
   * (hub sem links pro domínio de marca, ou URL sem entrada no cache) →
   * `renderInlineLinks` não emite `title=` nenhum, comportamento idêntico a
   * antes do #5265. */
  linkTitles?: Readonly<Record<string, string>>;
}

function pageUrl(slug: string): string {
  return `${DIARIA_ARQUIVO_URL}/temas/${slug}`;
}

/** URL do feed RSS do arquivo (#5127 item 3: "declarar `<link rel=alternate>`
 * nas páginas do Worker `arquivo` E nos hubs" — o feed é do arquivo como um
 * todo, não por hub; os hubs linkam pro MESMO feed, não um recorte por
 * tema). Literal (não importado de `workers/arquivo/src/render-feed.ts`) —
 * `scripts/lib/shared/` não importa de `workers/`, mesma fronteira que
 * `relatedHubs`/`HUB_META` já respeitam (ver nota daquele campo acima). */
const ARQUIVO_FEED_URL = `${DIARIA_ARQUIVO_URL}/feed.xml`;

/**
 * Rótulo "mês de ANO a mês de ANO" da janela coberta por um hub, DERIVADO do
 * dataset — nunca digitado na prosa (#4917 item 1).
 *
 * Aceita `{ date }[]` em vez de `HubSourceEntry[]` de propósito: aquele tipo
 * mora em `scripts/generate-hub-sources.ts`, que importa daqui — tipar pelo
 * campo evita o ciclo. Não assume ordenação: varre min/max, porque
 * `sourceEditions` é ordenado decrescente e `SOURCES` crescente, e um hub
 * novo pode escolher qualquer um dos dois.
 *
 * **Por que derivar, e não corrigir o literal:** em 10/08/2026, DOIS dos 4
 * hubs afirmavam uma janela que exclui a própria edição mais antiga que
 * citam — `anthropic-claude` e `openai-chatgpt` diziam "setembro de 2025"
 * com a primeira fonte em 29/08 e 27/08/2025. Escrever a janela como literal
 * é justamente o que produz esse erro: o dataset se move a cada regen
 * (`generate-hub-sources.ts`) e a prosa não. O mesmo defeito já tinha sido
 * consertado uma vez no `google-gemini` (#4895/#4896) e voltou nos gêmeos.
 */
export function hubCoverageWindow(sources: readonly { date: string }[]): {
  firstDate: string;
  lastDate: string;
  /** ex: "agosto de 2025 e agosto de 2026" — para "entre {…}". Quando
   * `since`/`until` caem no MESMO mês/ano, colapsa pro mês único sem "e"
   * repetido (ex: "agosto de 2025", não "agosto de 2025 e agosto de 2025"
   * — #4944 item 2). Ver `isSingleMonth` abaixo: quem monta a frase decide
   * o prefixo ("Em"/"Entre") com esse flag, este campo só evita a
   * duplicação textual. */
  between: string;
  /** ex: "agosto de 2025" — para "desde {…}". */
  since: string;
  /** ex: "agosto de 2026" — mês/ano de `lastDate`, gêmeo de `since` (#4922
   * item 1): `metaDescription`/`introHeading` de todo hub citam "de {since}
   * a {until}" — antes só `since` tinha rótulo pronto, `until` era montado
   * ad-hoc com `formatMonthYear(lastDate)` direto onde precisava. */
  until: string;
  /** ex: "27 de agosto de 2025 e 30 de julho de 2026" — forma longa, com
   * dia. O `google-gemini` usa esta (é o formato que a #4895 travou em
   * `test/hub-google-gemini-start-date-4895.test.ts`, absorvido pelo teste
   * genérico no #4922). Colapsa pra uma data única quando `firstDate ===
   * lastDate` (1 fonte só, ou todas na mesma data — #4944 item 2) — nesse
   * caso não há dois dias distintos pra separar com "e".
   */
  betweenLong: string;
  /** `since === until` — janela de 1 mês só (#4944 item 2). Nenhum dos 4
   * hubs reais cai neste caso hoje (é o piso de ~8 itens de lastro que
   * torna improvável, não impossível — um 5º hub com poucas edições
   * concentradas num mês poderia). `between`/`betweenLong` já colapsam a
   * forma textual sozinhos; este flag existe pra quem MONTA a frase ao
   * redor (ex: `` `Entre ${between}, ...` `` em cada `buildIntro`) trocar o
   * prefixo pra "Em" quando true — "Entre agosto de 2025, ..." lido sozinho
   * soa quebrado mesmo sem a duplicação de mês. Nenhum caller troca esse
   * prefixo ainda porque nenhum hub real precisa; o flag deixa a decisão
   * pronta pro dia em que precisar. */
  isSingleMonth: boolean;
} {
  if (sources.length === 0) throw new Error("hubCoverageWindow: sources vazio");
  let firstDate = sources[0].date;
  let lastDate = sources[0].date;
  for (const s of sources) {
    if (s.date < firstDate) firstDate = s.date;
    if (s.date > lastDate) lastDate = s.date;
  }
  const since = formatMonthYear(firstDate);
  const until = formatMonthYear(lastDate);
  const isSingleMonth = since === until;
  const isSingleDate = firstDate === lastDate;
  return {
    firstDate,
    lastDate,
    between: isSingleMonth ? since : `${since} e ${until}`,
    since,
    until,
    betweenLong: isSingleDate ? formatDateLong(firstDate) : `${formatDateLong(firstDate)} e ${formatDateLong(lastDate)}`,
    isSingleMonth,
  };
}

/**
 * "Data de cobertura" de um hub (#5124) — a edição mais recente que a
 * página de fato CITA, `YYYY-MM-DD`. DERIVADA de `sourceEditions` (nunca um
 * campo próprio em `HubContent`, ver nota do módulo) — é o que
 * `dateModified`/`<lastmod>`/`Last-Modified` deveriam refletir, em vez de
 * `updatedDate` (quando a PROSA foi revisada, conceito diferente e às vezes
 * bem mais recente — ver caso `brasil-regulacao`, #5124).
 *
 * Não assume ordenação (mesmo racional de `hubCoverageWindow`, que este
 * reusa): `sourceEditions` normalmente já vem ordenado mais-recente-primeiro
 * (invariante de `validateHubContent`), mas esta função não depende disso —
 * `hubCoverageWindow` varre min/max explicitamente.
 *
 * @pure
 */
export function hubCoverageDate(sourceEditions: readonly { date: string }[]): string {
  return hubCoverageWindow(sourceEditions).lastDate;
}

/** `YYYY-MM-DD` → "DD/MM/AAAA" (#4922 item 1) — mesma função que cada
 * `scripts/lib/hubs/{slug}.ts` reimplementava localmente como
 * `formatDateLabel`. Consolidada aqui pra virar a MESMA formatação usada
 * pelas datas derivadas novas (`maxDateGap`, `matchingDates`) — sem isso um
 * hub novo reimplementaria a função pela 5ª vez. */
export function formatDateShort(dateIso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso);
  if (!m) return dateIso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** `YYYY-MM-DD` → "D de mês de AAAA" (#4922 item 1) — extraído do helper
 * inline que só `hubCoverageWindow` tinha (`betweenLong`); exportado pra
 * formatar as bordas de um hiato derivado (`maxDateGap`) com o mesmo rótulo
 * longo que a prosa de cada hub já usa pra citar data de início/fim. */
export function formatDateLong(dateIso: string): string {
  return `${Number(dateIso.slice(8, 10))} de ${formatMonthYear(dateIso)}`;
}

/** Dias corridos (calendário) entre duas datas `YYYY-MM-DD`, `to - from`
 * (#4922 item 1). Usa `Date.UTC` — mesmo racional do helper equivalente que
 * `test/hub-google-gemini-launch-gap-4945.test.ts` já tinha local (não
 * reimplementado aqui: o teste continua com a própria cópia de propósito,
 * pra ficar uma verificação INDEPENDENTE do código de produção — ver nota no
 * próprio teste). Não valida ordem: `to` anterior a `from` devolve negativo. */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

/** `{ totalEditions, totalMentions }` de um hub, DERIVADO do dataset (#4922
 * item 1) — o motor único que `buildXxxFaq`/`buildIntro` de cada
 * `scripts/lib/hubs/{slug}.ts` computavam em paralelo, cada um com a própria
 * cópia do mesmo `reduce`. Não é o bug que a issue #4922 documenta (as duas
 * cópias sempre concordavam, mesma fórmula) — é a duplicação de código que a
 * issue pede pra eliminar: "a FAQ já é o motor de derivação, falta o resto
 * consumir o MESMO objeto". */
export function hubTotals(sources: readonly { matchedHeadlines: readonly string[] }[]): {
  totalEditions: number;
  totalMentions: number;
} {
  return {
    totalEditions: sources.length,
    totalMentions: sources.reduce((n, s) => n + s.matchedHeadlines.length, 0),
  };
}

/**
 * Texto padrão do bloco de metodologia (#4939/#4930), DERIVADO de `sources`
 * via `hubCoverageWindow`/`hubTotals` — nunca digitado. Forma canônica da
 * issue #4930: diz QUAL é a base de evidência (arquivo da diar.ia.br, não
 * fato-checagem independente), não só de quem ela é — mais forte que o
 * "segundo a diar.ia.br" que o contrato de prosa (#4899) proíbe no corpo do
 * texto. Cada `scripts/lib/hubs/{slug}.ts` chama isto com o próprio `SOURCES`
 * em vez de escrever a frase à mão; um hub que precisar de nota diferente
 * escreve a própria string (o tipo aceita qualquer `string`), mas o default
 * cobre os 4 hubs de hoje sem trabalho editorial extra.
 */
export function defaultMethodologyNote(
  sources: readonly { date: string; matchedHeadlines: readonly string[] }[],
): string {
  const { between } = hubCoverageWindow(sources);
  const { totalEditions } = hubTotals(sources);
  return `O levantamento vem de ${totalEditions} edições publicadas entre ${between}; os números saem do arquivo da diar.ia.br, não de verificação independente junto às empresas.`;
}

/**
 * Texto padrão da nota de metodologia de uma `HubSectionTable` (#4921 Onda
 * 2, issue item 8) — DERIVADO de `sources` como `defaultMethodologyNote`,
 * mas cita também o total de manchetes ("o que é contado"), que
 * `defaultMethodologyNote` omite de propósito (a nota do rodapé do hub
 * inteiro fala só de edições; a nota de uma tabela de seção — cujas linhas
 * tipicamente vêm de `matchedHeadlines` filtradas por um padrão — precisa
 * dizer também quantas manchetes formam a amostra). Os 3 números (janela,
 * edições, manchetes) saem de `hubCoverageWindow`/`hubTotals` — nenhum é
 * literal, todos mudam a cada regen de `sources.generated.json`.
 */
export function defaultTableMethodologyNote(
  sources: readonly { date: string; matchedHeadlines: readonly string[] }[],
): string {
  const { between } = hubCoverageWindow(sources);
  const { totalEditions, totalMentions } = hubTotals(sources);
  return `Levantamento sobre ${totalEditions} edições publicadas entre ${between}, somando ${totalMentions} manchetes; os números saem do arquivo da diar.ia.br.`;
}

/**
 * Cadência média de menção de um hub, em dias corridos, arredondada (#4922
 * item 1) — `Math.round(calendarDaysBetween(firstDate, lastDate) /
 * totalMentions)`. Cobre tanto a prosa que diz "dias corridos"
 * (`google-gemini`, `meta-ai`) quanto a que diz "dias úteis"
 * (`anthropic-claude`) — a fórmula manuscrita original de todo hub sempre
 * foi dias corridos / total de manchetes (conferido ao vivo contra os 3
 * hubs que citam um número único de cadência antes deste commit: o rótulo
 * "dias úteis" da prosa da Anthropic é só o nome que o texto dá ao intervalo
 * típico entre edições — a diar.ia.br só publica em dias úteis —, não uma
 * fórmula de contagem de dias úteis à parte). `openai-chatgpt` cita uma
 * FAIXA ("3-4 dias"), não um número único — não usa este helper, permanece
 * literal (#4922 item 4: faixa não é um fato único derivável).
 */
export function hubMentionCadenceDays(sources: readonly { date: string; matchedHeadlines: readonly string[] }[]): number {
  const { firstDate, lastDate } = hubCoverageWindow(sources);
  const { totalMentions } = hubTotals(sources);
  return Math.round(calendarDaysBetween(firstDate, lastDate) / totalMentions);
}

/**
 * Conta quantas manchetes de `sources` casam `pattern` (#4922 item 1) — o
 * `countMatching` que os 4 módulos de `scripts/lib/hubs/` reimplementavam
 * localmente, byte a byte idêntico entre `anthropic-claude.ts`/
 * `google-gemini.ts`/`meta-ai.ts` (só `openai-chatgpt.ts` tinha a variante
 * com `excludePattern`, preservada aqui). Normaliza pra NFC antes do teste —
 * `matchedHeadlines` vem em NFD do cache Beehiiv (ver nota original em
 * `anthropic-claude.ts`). Recebe `sources` por parâmetro sempre — nunca lê
 * um `SOURCES` de módulo — mesma disciplina que manteve `buildXxxFaq` puro e
 * testável com fixture sintético.
 */
export function countMatching(
  sources: readonly { matchedHeadlines: readonly string[] }[],
  pattern: RegExp,
  excludePattern?: RegExp,
): number {
  let n = 0;
  for (const s of sources) {
    for (const h of s.matchedHeadlines) {
      const normalized = h.normalize("NFC");
      if (pattern.test(normalized) && !(excludePattern && excludePattern.test(normalized))) n++;
    }
  }
  return n;
}

/**
 * Datas (`YYYY-MM-DD`) das manchetes de `sources` que casam `pattern`, uma
 * entrada por manchete casada (não por fonte — uma fonte com 2 manchetes
 * casadas contribui a MESMA data 2x), ordenadas ascendente (#4922 item 1).
 * Base pra `maxDateGap`/hiatos entre lançamentos: antes deste commit, o
 * único jeito de saber a duração de um hiato era transcrever as duas datas
 * de borda à mão pra prosa (ex: "125 dias, de 5 de dezembro de 2025 a 9 de
 * abril de 2026" em `anthropic-claude.ts`) — sem nada religando esse número
 * ao dataset. Mesma normalização NFC de `countMatching`.
 */
export function matchingDates(
  sources: readonly { date: string; matchedHeadlines: readonly string[] }[],
  pattern: RegExp,
  excludePattern?: RegExp,
): string[] {
  const dates: string[] = [];
  for (const s of sources) {
    for (const h of s.matchedHeadlines) {
      const normalized = h.normalize("NFC");
      if (pattern.test(normalized) && !(excludePattern && excludePattern.test(normalized))) dates.push(s.date);
    }
  }
  return dates.sort();
}

/** Gaps em dias corridos entre datas CONSECUTIVAS de uma lista já ordenada
 * ascendente (ex: saída de `matchingDates`) — `gaps[i] = dates[i+1] -
 * dates[i]` (#4922 item 1). `dates.length` entradas produzem
 * `dates.length - 1` gaps; lista com 0 ou 1 data produz `[]`. Base pra
 * `maxDateGap` e pra qualquer hiato/vão específico que a prosa cite por
 * posição (ex: `google-gemini.ts` cita o 1º e o 2º hiato entre 3 surtos de
 * lançamento — `gaps[4]`/`gaps[6]` no dataset atual — em vez de só o maior). */
function consecutiveGapDays(dates: readonly string[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(calendarDaysBetween(dates[i - 1], dates[i]));
  return gaps;
}

/** O maior gap em dias corridos entre datas consecutivas de `dates` (#4922
 * item 1) — usa `consecutiveGapDays` e devolve também as duas datas de
 * borda do gap vencedor (pra interpolar tanto o número quanto as datas que a
 * prosa cita ao lado dele, ex: "hiato de 125 dias... de 5 de dezembro de
 * 2025 a 9 de abril de 2026"). `null` se `dates` tiver menos de 2 entradas
 * (nenhum gap possível). Em empate, fica com a PRIMEIRA ocorrência do
 * máximo — determinístico, mesmo resultado a cada regen com o mesmo
 * dataset. */
export function maxDateGap(dates: readonly string[]): { fromDate: string; toDate: string; gapDays: number } | null {
  if (dates.length < 2) return null;
  let best = { fromDate: dates[0], toDate: dates[1], gapDays: calendarDaysBetween(dates[0], dates[1]) };
  for (let i = 2; i < dates.length; i++) {
    const gapDays = calendarDaysBetween(dates[i - 1], dates[i]);
    if (gapDays > best.gapDays) best = { fromDate: dates[i - 1], toDate: dates[i], gapDays };
  }
  return best;
}

/**
 * Tabela de cronologia derivada de um padrão de manchete (#4921 Onda 2,
 * generalizada #5260 — nasceu só em `anthropic-claude.ts`, hoje reusada por
 * `google-gemini`/`mercado-trabalho`) — evento | data | dias desde o
 * anterior | edição, UMA linha por manchete que casa `pattern`, em ordem
 * cronológica ascendente. Pure — recebe `sources` por parâmetro, nunca lê um
 * `SOURCES` de módulo (mesma disciplina de `countMatching`/`matchingDates`).
 *
 * **Genuinamente derivada, nada transcrito à mão:** a 1ª coluna é a própria
 * manchete casada (texto real do dataset, não um rótulo digitado à parte);
 * "Dias desde o anterior" é `calendarDaysBetween` entre duas datas
 * consecutivas da MESMA lista que `maxDateGap` usaria pra computar o maior
 * hiato — não há como esta tabela divergir do "hiato de N dias" que a prosa
 * da seção cita, porque é o mesmo cálculo sobre o mesmo array de datas.
 * "Edição" é sempre o rótulo fixo "Ver edição" linkando `s.url` — nenhuma
 * prosa por linha, só o link.
 *
 * **Regra de quando usar (documentada aqui, não só na issue):** uma seção
 * que enumera ≥6 eventos datados do mesmo tipo (mesmo padrão de manchete)
 * nasce com esta tabela — prosa-cadeia sozinha ("N dias depois... M dias
 * depois...") sobre uma lista desse tamanho é exatamente o padrão que motivou
 * a Onda 2 do #4921 e o retrofit do #5260.
 */
export function buildLaunchChronologyTable(
  sources: readonly { date: string; matchedHeadlines: readonly string[]; url: string }[],
  pattern: RegExp,
  opts: { caption: string; firstColumnHeader: string },
): HubSectionTable {
  const matches: { date: string; headline: string; url: string }[] = [];
  for (const s of sources) {
    for (const h of s.matchedHeadlines) {
      const normalized = h.normalize("NFC");
      if (pattern.test(normalized)) matches.push({ date: s.date, headline: normalized, url: s.url });
    }
  }
  matches.sort((a, b) => a.date.localeCompare(b.date));
  const rows = matches.map((m, i) => [
    m.headline,
    formatDateShort(m.date),
    i === 0 ? "—" : String(calendarDaysBetween(matches[i - 1].date, m.date)),
    `[Ver edição](${m.url})`,
  ]);
  return {
    caption: opts.caption,
    methodology: defaultTableMethodologyNote(sources),
    headers: [opts.firstColumnHeader, "Data", "Dias desde o anterior", "Edição"],
    rows,
  };
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
  /* #5266: índice navegável — mesmo max-width/tratamento visual discreto de
     .hub-related-nav (borda superior sutil, rótulo pequeno versalete), mas
     SEM borda/margem de topo — fica logo colado depois da intro, antes da
     1ª seção, não como um bloco de "fim de página" como os outros navs. */
  .hub-section-index { max-width: 720px; margin: 0 0 40px; }
  .hub-section-index-heading { font-family: Georgia, 'Times New Roman', serif; font-size: 13px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--teal); margin: 0 0 10px; }
  .hub-section-index ol { list-style: decimal; margin: 0; padding: 0 0 0 20px; display: flex; flex-direction: column; gap: 6px; }
  .hub-section-index li a { font-size: 14px; color: var(--teal); text-decoration: underline;
    text-decoration-color: var(--rule); text-underline-offset: 2px; }
  .hub-section-index li a:hover { text-decoration-color: var(--teal); }
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
  /* #4921 Onda 2: tabela opcional DENTRO de uma seção (.hub-section, já
     720px) — mais compacta que a bibliografia (.hub-sources abaixo, que é a
     página inteira de fontes). overflow-x:auto pelo mesmo motivo da Onda 1:
     não é testável automaticamente, só CSS (issue item 4/9). */
  .hub-section-table-wrap { overflow-x: auto; margin: 4px 0 16px; border-top: 1px solid var(--rule); }
  .hub-section-table-wrap table { width: 100%; border-collapse: collapse; font-size: 15px; }
  .hub-section-table-wrap caption { text-align: left; font-family: Georgia, 'Times New Roman', serif;
    font-size: 13px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--teal);
    padding: 10px 0 8px; }
  .hub-section-table-wrap thead th { text-align: left; padding: 8px; font-family: Georgia, 'Times New Roman', serif;
    font-weight: 700; font-size: 13px; letter-spacing: 0.02em; border-bottom: 1px solid var(--rule); white-space: nowrap; }
  .hub-section-table-wrap tbody td { padding: 9px 8px; border-bottom: 1px solid var(--rule); color: var(--ink);
    line-height: 1.45; vertical-align: top; }
  .hub-section-table-wrap tbody td a { color: var(--teal); text-decoration: underline;
    text-decoration-color: var(--rule); text-underline-offset: 2px; }
  .hub-section-table-wrap tbody td a:hover { text-decoration-color: var(--teal); }
  .hub-section-table-methodology { font-size: 13px; line-height: 1.55; color: var(--ink); opacity: 0.72; margin: 0 0 14px; }
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
  /* #4921 Onda 1: <ul>/<li> virou <table> (Data | Manchete | Edição, 1 linha
     por manchete casada — issue #4558 item 2, "é o que faz a tabela contar o
     que a página afirma contar"). Wrapper com overflow-x:auto porque 3
     colunas não cabem sempre nos 720px de .hub-sources em telas estreitas —
     a tabela rola horizontalmente em vez de quebrar o layout da página
     (issue #4558 item 4: "não é testável automaticamente"). */
  .hub-sources-table-wrap { overflow-x: auto; border-top: 1px solid var(--rule); }
  .hub-sources table { width: 100%; border-collapse: collapse; font-size: 15px; }
  .hub-sources thead th { text-align: left; padding: 10px 8px; font-family: Georgia, 'Times New Roman', serif;
    font-weight: 700; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--teal);
    border-bottom: 1px solid var(--rule); white-space: nowrap; }
  .hub-sources tbody td { padding: 11px 8px; border-bottom: 1px solid var(--rule); color: var(--ink);
    line-height: 1.4; vertical-align: top; }
  .hub-sources tbody td:first-child { white-space: nowrap; font-weight: 700; color: var(--teal); font-size: 13px; }
  .hub-sources tbody td a { color: var(--ink); text-decoration: none; }
  .hub-sources tbody td a:hover { color: var(--teal); text-decoration: underline; }
  .hub-methodology { margin: 32px 0 0; padding: 24px 0 0; border-top: 1px solid var(--rule); max-width: 720px; }
  .hub-methodology h2 { font-family: Georgia, 'Times New Roman', serif; font-size: 13px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--teal); margin: 0 0 10px; }
  .hub-methodology p { font-size: 14px; line-height: 1.6; color: var(--ink); opacity: 0.72; margin: 0; }
  .hub-methodology p a { color: var(--teal); text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 2px; }
  .hub-related-nav { margin: 32px 0 0; padding: 24px 0 0; border-top: 1px solid var(--rule); max-width: 720px; }
  .hub-related-nav h2 { font-family: Georgia, 'Times New Roman', serif; font-size: 13px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--teal); margin: 0 0 12px; }
  .hub-related-nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px 20px; }
  .hub-related-nav li a { font-size: 14px; color: var(--teal); text-decoration: underline;
    text-decoration-color: var(--rule); text-underline-offset: 2px; }
  .hub-related-nav li a:hover { text-decoration-color: var(--teal); }`;
}

/** Um campo reader-facing de `HubContent`, com o caminho pra mensagem de
 * erro e a natureza do campo. `kind: "heading"` é superfície de casamento
 * com consulta (H2, pergunta de FAQ — a de FAQ ainda é reemitida como
 * `Question.name` no JSON-LD por `geo-faq.ts`); `kind: "prose"` é corpo de
 * texto. As regras do contrato (`HUB_PROSE_RULES`) se aplicam por `kind`,
 * EXCETO as listadas em `exemptFrom` (#4939) — isenção por campo, nunca por
 * afrouxamento da regex da regra em si (ver nota de `methodologyNote` em
 * `HUB_PROSE_RULES`).
 *
 * Promovido de `test/hub-content-no-diaria-nickname-4795.test.ts` (#4899):
 * era helper local de um teste, e por isso cada guard novo reescrevia a
 * própria travessia — e o guard do #4795 ainda tem um array `HUBS`
 * hand-written que não descobriu o 4º hub (#4926) sozinho. */
export function collectReaderFacingStrings(
  hub: HubContent,
): { field: string; value: string; kind: "heading" | "prose"; exemptFrom?: readonly string[] }[] {
  const out: { field: string; value: string; kind: "heading" | "prose"; exemptFrom?: readonly string[] }[] = [];
  out.push({ field: "title", value: hub.title, kind: "heading" });
  // #4912: `h1` é opcional (default `title` — ver docstring do campo), mas
  // quando presente é o texto que de fato renderiza no `<h1>` visível, então
  // passa pelo mesmo contrato de prosa que qualquer outro heading.
  if (hub.h1 !== undefined) out.push({ field: "h1", value: hub.h1, kind: "heading" });
  out.push({ field: "metaDescription", value: hub.metaDescription, kind: "prose" });
  out.push({ field: "introHeading", value: hub.introHeading, kind: "heading" });
  // #5259: introParagraph pode ser string OU array não-vazio (ver docstring
  // do campo) — cada elemento entra como um item PRÓPRIO da lista, mesmo
  // tratamento que sections[].paragraphs já recebe logo abaixo. Com um
  // array de N elementos, o campo reportado numa violação é
  // "introParagraph[i]" (não "introParagraph") pra apontar o elemento certo.
  if (typeof hub.introParagraph === "string") {
    out.push({ field: "introParagraph", value: hub.introParagraph, kind: "prose" });
  } else {
    hub.introParagraph.forEach((p, i) => {
      out.push({ field: `introParagraph[${i}]`, value: p, kind: "prose" });
    });
  }
  hub.sections.forEach((section, sIdx) => {
    out.push({ field: `sections[${sIdx}].heading`, value: section.heading, kind: "heading" });
    section.paragraphs.forEach((p, pIdx) => {
      out.push({ field: `sections[${sIdx}].paragraphs[${pIdx}]`, value: p, kind: "prose" });
    });
    // #4921 Onda 2: `table.caption`/`table.methodology` são texto lido pelo
    // leitor (caption/nota de proveniência), então passam pelo MESMO
    // contrato de prosa que heading/parágrafo. `headers`/`rows` ficam FORA
    // de propósito — são dado tabular curto (rótulo de coluna, data, nome de
    // modelo, "Ver edição"), não prosa narrativa; aplicar HUB_PROSE_RULES
    // ali arriscaria falso positivo sem examinar nenhuma construção real que
    // a auditoria tenha catalogado.
    if (section.table) {
      out.push({ field: `sections[${sIdx}].table.caption`, value: section.table.caption, kind: "heading" });
      out.push({ field: `sections[${sIdx}].table.methodology`, value: section.table.methodology, kind: "prose" });
    }
  });
  hub.faq.forEach((item, fIdx) => {
    out.push({ field: `faq[${fIdx}].question`, value: item.question, kind: "heading" });
    out.push({ field: `faq[${fIdx}].answer`, value: item.answer, kind: "prose" });
  });
  // `sourceEditions[].title`/`.editionTitle` ficam FORA de propósito, apesar de
  // serem reader-facing (viram o rótulo do <li> e o `name` do ItemList no
  // JSON-LD). O motivo: esse texto é MANCHETE REAL vinda do cache Beehiiv via
  // `generate-hub-sources.ts`, não prosa que alguém escreveu aqui. Uma
  // manchete histórica que por acaso contenha uma das construções proibidas
  // faria `renderHubPage` lançar num regen de dataset — quebrando o build por
  // causa de um texto que ninguém pode reescrever sem falsificar a citação.
  // Levantado no review da PR #4938; a exclusão é deliberada, não esquecimento.
  // `methodologyNote` (#4939): kind "prose" — as regras de sujeito/moldura/
  // ponteiro continuam valendo (o bloco não deixa de ser prosa comum só por
  // falar da página). Só `prosa-sem-deixis` é isenta: é o único campo em que
  // "esta página"/"este hub" é o sujeito CORRETO — ver docstring de
  // `HUB_PROSE_RULES`.
  out.push({ field: "methodologyNote", value: hub.methodologyNote, kind: "prose", exemptFrom: ["prosa-sem-deixis"] });
  return out;
}

/** Teto de ocorrências de "N dias/semanas/meses depois/mais tarde" NUM MESMO
 * parágrafo reader-facing (#5258) — acima disso a prosa vira arco
 * cronológico só de intervalo relativo, sem data absoluta ancorando o
 * leitor (o defeito que a análise editorial de 14/08/2026, "Raio-X de
 * /temas/", catalogou: "111 dias depois... Cinco dias depois...", pior caso
 * em `mercado-trabalho` com 13 eventos por intervalo relativo num
 * parágrafo). Calibrado contra `anthropic-claude` — a referência de
 * calibragem citada na própria issue ("já perto do padrão"): o parágrafo com
 * mais ocorrências ali tem 3; 3 passa, 4+ falha. Regra editorial completa:
 * data absoluta primeiro; intervalo relativo só quando o vão É o fato
 * (hiato de lançamento, "duas coisas no mesmo dia"). */
export const HUB_MAX_RELATIVE_DATE_CHAIN = 3;
const RELATIVE_DATE_CHAIN_PATTERN = /\b(dias?|semanas?|meses)\s+(depois|mais tarde|depois disso)\b/gi;

/** Teto de palavras por parágrafo reader-facing (#5259) — "parágrafo-
 * paredão" que a issue mira: cada elemento de `sections[].paragraphs`.
 * Calibrado contra os hubs já em bom estado: o maior parágrafo de seção de
 * `anthropic-claude` tem 113 palavras — 160 dá folga sem deixar passar os
 * parágrafos de 200-450 palavras que motivaram a issue. NÃO se aplica a
 * `faq[].answer`/`methodologyNote`/`table.methodology` — resposta curta por
 * natureza, fora do escopo da issue (que mira parágrafo de SEÇÃO, não
 * resposta de FAQ). Ver `HUB_MAX_INTRO_PARAGRAPH_WORDS` abaixo pro teto
 * PRÓPRIO de `introParagraph` — mesmo guard, teto diferente. */
export const HUB_MAX_PARAGRAPH_WORDS = 160;

/** Teto de palavras de `introParagraph` (#5259) — SEPARADO do teto acima de
 * propósito. `HubContent.introParagraph` é desenhado pra ~200 palavras num
 * bloco denso que responde a pergunta principal por inteiro (ver docstring
 * do campo) — 5 dos 6 hubs publicados em 14/08/2026 já cabem nessa faixa
 * (213-271 palavras) sem precisar quebrar em array; só `brasil-regulacao`
 * (334) estourava por um bom motivo real (parágrafo genuinamente inchado,
 * não o orçamento normal do campo) — esse é o único intro que a issue #5259
 * pede pra quebrar ("brasil-regulacao: intro e seção 1"). 300 calibra
 * exatamente essa fronteira: passa os 5 hubs em ~200-270, falha só o
 * outlier. Um hub cujo intro vira array (#5259, "Código habilitador") tem
 * CADA elemento comparado contra este mesmo teto individualmente — ver
 * `collectReaderFacingStrings`, que já emite `introParagraph[i]` por
 * elemento. */
export const HUB_MAX_INTRO_PARAGRAPH_WORDS = 300;

export interface HubProseRule {
  readonly id: string;
  /** Onde a regra se aplica. `heading` inclui `title`, `introHeading`,
   * `sections[].heading` e `faq[].question`; `prose` inclui
   * `metaDescription`, `introParagraph`, `sections[].paragraphs` e
   * `faq[].answer`. */
  readonly appliesTo: "heading" | "prose";
  readonly pattern: RegExp;
  /** Mensagem de violação — diz o que fazer, não só o que está errado. */
  readonly message: string;
}

/**
 * **O contrato de prosa dos hubs (#4899).** Cada regra saiu de um achado da
 * auditoria de GEO de 10/08/2026 (#4558) e vale pros hubs de hoje e pra todo
 * hub futuro: `validateHubContent` roda sobre `collectReaderFacingStrings`, e
 * os testes que iteram `HUB_LOADERS` (`test/hub-page-drift.test.ts`,
 * `test/build-hub-page.test.ts`) exercem hub novo sem trabalho extra.
 *
 * **Por que existe:** a #4926 publicou o 4º hub um dia depois da auditoria,
 * com este contrato aberto, e ele nasceu com as 5 violações abaixo — 3
 * headings de marca, 3 sujeitos, 6 dêiticos e 8 ponteiros, mais ponteiro que
 * qualquer hub anterior. Ninguém errou de propósito: o docstring dele diz
 * "mesmo molde estrutural dos 3 anteriores". É o molde que carrega o defeito,
 * então o conserto tem de estar no gerador e não em checklist.
 *
 * **O contrato proíbe CONSTRUÇÕES, nunca palavras.** Afirmação sobre o
 * próprio arquivo — "em 76 edições ao longo de 11 meses, o ritmo veio em
 * surtos" — é o que a página tem de próprio e passa limpa de propósito; é
 * a razão de o hub existir. O que as regras pegam é a publicação ocupando o
 * lugar de sujeito que o fato deveria ter, e a edição usada como moldura
 * organizadora. O critério, quando um caso novo for duvidoso: **a cobertura
 * é o assunto, ou é o recipiente?** Assunto fica; recipiente sai. Um lint de
 * frequência de menção mataria justamente o que justifica a página, e por
 * isso nunca deve ser adicionado aqui.
 *
 * **Descartado pela auditoria, não reintroduzir:** âncora `#id` por bloco e
 * índice navegável (scroll-to-text casa texto, não id — justificativa
 * auto-refutante), reorganização de hierarquia de heading ("edições só de
 * formatação têm pouco impacto"), `BreadcrumbList`, `sameAs`, expansão do
 * FAQPage (o rich result de FAQ foi aposentado em 07/05/2026; o
 * quasi-experimento da Ahrefs mediu −4,6% em AI Overviews com schema) e
 * llms.txt (97% dos arquivos com zero requisições em 137 mil domínios).
 *
 * **Força da evidência, para não prometer o que não se mede:** o survey
 * arXiv 2607.14035 conclui que nenhuma técnica de GEO revisada mostra efeito
 * causal estável sobre descoberta, e não há estudo sobre moldura atributiva.
 * Isto é qualidade de prosa com trava durável, não promessa de citação — o
 * gargalo medido da página é recuperação (#4903, #4909), não seleção.
 *
 * **A ressalva epistêmica não desapareceu — mudou de endereço (#4939).** As
 * 103 construções que este contrato tirou do corpo do texto ("a diar.ia.br
 * cobriu...", "segundo a diar.ia.br...") não eram só enfeite: diziam de onde
 * vinha a informação. Tirar a moldura sem repor nada transformaria reportagem
 * hedgeada em afirmação categórica. O destino é `HubContent.methodologyNote`
 * — bloco próprio, fora de `sections`/`introParagraph`, que `validateHubContent`
 * exige em todo hub e isenta da regra `prosa-sem-deixis` (é o único lugar da
 * página em que "esta página" é o sujeito correto). Ler esta seção e concluir
 * que a procedência não deve aparecer em lugar nenhum é o erro que este
 * parágrafo existe pra prevenir.
 */
export const HUB_PROSE_RULES: readonly HubProseRule[] = [
  {
    // #4914. Forma AMPLA de propósito: a regex original da issue
    // (/segundo a (diar\.ia\.br|cobertura)/) deixava passar 3 headings que
    // nomeiam a marca sem essa construção — "Em quantas edições a diar.ia.br
    // destacou algo sobre X?", um em cada hub do trio original.
    id: "heading-sem-marca",
    appliesTo: "heading",
    pattern: /diar\.ia\.br|segundo a cobertura/i,
    message:
      "heading nomeia a publicação — ninguém digita o nome do veículo na pergunta. " +
      "Pergunte o que o leitor pergunta e abra a resposta pela base de evidência " +
      '(ex: "Nas 84 manchetes acompanhadas entre X e Y, ...").',
  },
  {
    // #4930. `metaDescription` está no escopo de propósito: a #4914 isentou
    // esse campo da regra de HEADING (marca ali é rótulo de documento, e é
    // legítima), mas o defeito aqui é outro — a construção que gasta a
    // abertura do trecho mais reaproveitado da página com o veículo.
    id: "prosa-sem-publicacao-como-sujeito",
    appliesTo: "prose",
    // O `(?:\S+\s){0,2}` absorve advérbio/auxiliar interposto entre sujeito e
    // verbo ("a diar.ia.br JÁ cobriu", "VEM cobrindo", "SEGUE cobrindo") — sem
    // ele a âncora quebrava e a construção passava (achado do review).
    // A lista de verbos é deliberadamente ampla e inclui as formas no
    // presente: o defeito é a publicação no lugar de sujeito, não o tempo
    // verbal. Ainda é uma denylist e por construção não é exaustiva — o
    // limite conhecido está travado por teste.
    pattern:
      /\ba diar\.ia\.br (?:\S+\s){0,2}(cobr|notici|public|registr|acompanh|destac|inform|relat|flagr|revel|document|report|mostr|mencion)(?:ou|a|am|ando|indo|iu|e|aram)?\b|\ba diar\.ia\.br (?:nunca|jamais|passou a)\b/i,
    message:
      "a publicação está no lugar de sujeito de um verbo de cobertura — o fato vira predicado " +
      "da cobertura. Ponha o fato no sujeito. Afirmação sobre o próprio arquivo " +
      '("em 76 edições, o ritmo veio em surtos") é permitida e não casa esta regra.',
  },
  {
    // #4930. O gêmeo em PROSA da regra de heading acima. Sem ela,
    // "Segundo a diar.ia.br, o modelo foi lançado em julho" passava — e essa
    // moldura atributiva é MAIS provável em prosa corrida do que num H2
    // (achado do review da PR #4938). Mesma tese da regra de sujeito: o
    // qualificador diz de quem é a evidência sem dizer QUAL é. A forma
    // recomendada — "Nas 84 manchetes acompanhadas entre X e Y, ..." — não
    // casa esta regra de propósito.
    id: "prosa-sem-qualificador-atributivo",
    appliesTo: "prose",
    pattern: /\bsegundo a (cobertura|diar\.ia\.br)|\bconforme a cobertura|\bde acordo com a diar\.ia\.br/i,
    message:
      "qualificador atributivo de marca — diz de QUEM é a evidência sem dizer QUAL é ela. " +
      'Troque pela base de evidência ("Nas 84 manchetes acompanhadas entre X e Y, ...").',
  },
  {
    // #4930. Ligar dois fatos porque compartilharam uma edição é uma relação
    // que não existe fora da newsletter — a edição é artefato do calendário
    // de publicação, a data é o fato.
    id: "prosa-sem-moldura-de-edicao",
    appliesTo: "prose",
    // "nessa/naquela mesma edição" e "na edição seguinte/anterior" são a
    // MESMA moldura e escapavam da forma original (achado do review).
    pattern:
      /\b(n[ao]|ness[ae]|naquel[ae]|mesm[ao]) mesma edição|\bn[ao] mesma edição|\bna edição (de |seguinte|anterior)|uma edição inteira/i,
    message:
      "a edição está sendo usada como moldura organizadora. Use a DATA: dois fatos que " +
      'saíram na mesma edição saíram "no mesmo dia", que é o que de fato os relaciona.',
  },
  {
    // #4917. Parágrafo que diz "este hub" é incompleto lido isolado — e o
    // JSON-LD reproduz respostas de FAQ com os links removidos
    // (`stripMarkdownLinks`, geo-faq.ts), então o dêitico viaja sem resolução.
    // Isenta em `methodologyNote` (#4939, ver `collectReaderFacingStrings`) —
    // é o único campo em que "esta página"/"este hub" é o sujeito correto, e
    // a isenção é por CAMPO (marcada em `exemptFrom`), não um afrouxamento
    // desta regex.
    id: "prosa-sem-deixis",
    appliesTo: "prose",
    // `\besta página\b` NÃO casava "nesta página" — não há fronteira de
    // palavra entre "n" e "esta" (achado do review), e "nesta página" é a
    // forma mais natural em português. `(?<![\p{L}])` resolve sem afrouxar.
    pattern: /\b(este|deste|neste) hub\b|(?<![\p{L}])(n?est[ae]|ness[ae]) página\b|(?<![\p{L}])(n?esta|nessa) seção\b/iu,
    message:
      'dêixis não resolvida ("este hub" / "esta página"): nomeie a entidade e o intervalo. ' +
      "O trecho precisa se bastar lido fora da página.",
  },
  {
    // #4917 item 7 / #4915. Forma FROUXA obrigatória: a estrita
    // (/seç(ão|ões) (acima|abaixo)/) perde "a seção sobre segurança acima",
    // que é justamente a variante que o 4º hub usou nas 8 ocorrências dele.
    id: "prosa-sem-ponteiro-de-secao",
    appliesTo: "prose",
    // `(?!\s+d[aeo])` mata o falso positivo comparativo que o review
    // demonstrou — "a seção X, com crescimento acima DA média" é dado, não
    // ponteiro. Ponteiro real ("a seção sobre segurança acima traz") nunca é
    // seguido de artigo.
    pattern: /seç(ão|ões)[^.]{0,60}\s(acima|abaixo)\b(?!\s+d[aeo]\b)/i,
    message:
      'ponteiro para outro trecho ("seção acima/abaixo") — irresolvível: os assets não têm ' +
      "nenhum href de âncora, e âncora foi descartada pela auditoria. Repita o fato no lugar.",
  },
];

/**
 * Valida os invariantes de `HubContent` que a issue #4558 e o próprio
 * módulo documentam mas o TYPE não consegue expressar sozinho (contagem de
 * FAQ, formato de data, não-vazio de listas), MAIS o contrato de prosa da
 * auditoria de GEO (`HUB_PROSE_RULES`, #4899). Pure, devolve a lista de
 * violações (vazia = válido) — nunca lança sozinha, quem chama decide.
 * Existe pra que um hub novo (decisão do editor: hubs coexistem, mais temas
 * virão) herde essas garantias automaticamente em vez de depender de um
 * teste hand-written por hub.
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
  // #4921 Onda 2 item 9: `table` é opcional, mas quando presente precisa de
  // pelo menos 1 linha e aridade igual entre `headers` e CADA linha — sem
  // isso `renderHubSectionTable` emitiria uma `<tr>` com número de `<td>`
  // diferente do número de `<th>`, quebrando a leitura por leitor de tela e
  // qualquer parser tabular. Mensagem nomeia hub + seção (issue item 9).
  hub.sections.forEach((section, sIdx) => {
    if (!section.table) return;
    const { headers, rows } = section.table;
    if (rows.length === 0) {
      errors.push(`hub "${hub.slug}" seção "${section.heading}" (sections[${sIdx}].table): rows está vazio`);
    }
    rows.forEach((row, rIdx) => {
      if (row.length !== headers.length) {
        errors.push(
          `hub "${hub.slug}" seção "${section.heading}" (sections[${sIdx}].table): rows[${rIdx}] tem ${row.length} célula(s), headers tem ${headers.length}`,
        );
      }
    });
  });
  // #4939: methodologyNote é OBRIGATÓRIO — hub futuro nasce sem, senão (a
  // issue documenta essa preocupação explicitamente). Mesmo padrão dos
  // checks acima (`sections`/`sourceEditions` vazios): o TYPE não consegue
  // expressar "string não-vazia", então o guard é em runtime.
  if (hub.methodologyNote.trim().length === 0) {
    errors.push("methodologyNote está vazio — hub sem a ressalva de procedência (#4939)");
  }
  // #4913: metaDescription vira `<meta content="...">`/og:description/
  // twitter:description via `renderSeoMeta` (esc() puro, valor de atributo —
  // não suporta markdown link). `seo-meta.ts:32` documenta ~150-160 chars
  // como ideal; 160 é o teto que este guard trava. Checagem fica aqui, não em
  // `renderSeoMeta`/`seo-meta.ts` — aquele módulo serve 5 famílias de página
  // (cursos, livros, hub, arquivo, poll) e este limite é escopo só dos hubs.
  const HUB_META_DESCRIPTION_MAX_LENGTH = 160;
  if (hub.metaDescription.length > HUB_META_DESCRIPTION_MAX_LENGTH) {
    errors.push(
      `metaDescription tem ${hub.metaDescription.length} caracteres — máximo ${HUB_META_DESCRIPTION_MAX_LENGTH} (seo-meta.ts:32 documenta ~150-160 ideal)`,
    );
  }
  // Contrato de prosa (#4899). Roda por último: as violações acima são
  // estruturais (o hub está malformado), estas são editoriais (o hub está
  // formado mas escrito do jeito que a auditoria de GEO catalogou).
  for (const { field, value, kind, exemptFrom } of collectReaderFacingStrings(hub)) {
    for (const rule of HUB_PROSE_RULES) {
      if (rule.appliesTo !== kind) continue;
      if (exemptFrom?.includes(rule.id)) continue;
      // `matchAll` e não `exec`: um parágrafo de 1500 caracteres repete a
      // mesma construção com frequência, e reportar só a 1ª fazia o autor
      // "consertar" o campo e descobrir a 2ª na rodada seguinte — whack-a-mole
      // desnecessário (achado do review da PR #4938).
      const seen = new Set<string>();
      for (const hit of value.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags + "g"))) {
        if (seen.has(hit[0].toLowerCase())) continue;
        seen.add(hit[0].toLowerCase());
        errors.push(`${field} viola ${rule.id}: "${hit[0]}" — ${rule.message}`);
      }
    }
  }
  // #5060 Parte B1: gate mecânico de fatos (cronologia derivada "N dias
  // depois" batendo com as datas absolutas do texto, link de edição citado
  // existindo em sourceEditions, todo parágrafo com âncora de data, nenhuma
  // data futura em relação a updatedDate). Roda por último, depois do
  // contrato de prosa acima — mesmo racional: primeiro estrutura, depois
  // editorial, por fim auto-consistência factual. Ver
  // scripts/lib/shared/hub-fact-gate.ts para o design e o porquê de cada
  // checagem ser deliberadamente conservadora (prefere não verificar a
  // acusar prosa correta).
  // #5258/#5259: guards de FORMA dos parágrafos de seção/intro — não são
  // CONSTRUÇÃO proibida (isso é HUB_PROSE_RULES acima), são densidade de
  // intervalo relativo e comprimento de parágrafo. Escopo restrito a
  // sections[].paragraphs[] e introParagraph[] (ver constantes acima) —
  // faq[].answer/methodologyNote ficam fora, mesmo sendo kind "prose".
  for (const { field, value, kind } of collectReaderFacingStrings(hub)) {
    if (kind !== "prose") continue;
    const isSectionParagraph = /^sections\[\d+\]\.paragraphs\[\d+\]$/.test(field);
    const isIntroParagraph = /^introParagraph(\[\d+\])?$/.test(field);
    if (!isSectionParagraph && !isIntroParagraph) continue;
    const chainMatches = value.match(RELATIVE_DATE_CHAIN_PATTERN) ?? [];
    if (chainMatches.length > HUB_MAX_RELATIVE_DATE_CHAIN) {
      errors.push(
        `${field} tem ${chainMatches.length} ocorrências de "N dias/semanas/meses depois/mais tarde" no mesmo parágrafo ` +
          `— máximo ${HUB_MAX_RELATIVE_DATE_CHAIN} (#5258). Data absoluta primeiro; intervalo relativo só quando o vão É o fato.`,
      );
    }
    const wordCount = value.trim().split(/\s+/).filter(Boolean).length;
    const maxWords = isIntroParagraph ? HUB_MAX_INTRO_PARAGRAPH_WORDS : HUB_MAX_PARAGRAPH_WORDS;
    if (wordCount > maxWords) {
      errors.push(
        `${field} tem ${wordCount} palavras — máximo ${maxWords} por parágrafo (#5259). Quebre em unidades de ~80-120 palavras.`,
      );
    }
  }
  errors.push(...checkHubFacts(hub));
  return errors;
}

/**
 * Limiar (dias corridos) que `checkUpdatedDateCeiling` usa pra sinalizar
 * `updatedDate` suspeito demais à frente de `coverageDate` (#5124 item 3).
 * Escolha do limiar: 21 dias fica acima de todo gap legítimo medido nos 6
 * hubs reais em 12/08/2026 (o maior era 11 dias, `google-gemini`) e bem
 * abaixo do caso que motivou a issue (`brasil-regulacao`, 48 dias) — folga
 * suficiente pra não alarmar um bump de prosa alguns dias depois da última
 * fonte (padrão normal de revisão editorial), mas curto o bastante pra
 * pegar um bump "cosmético" que ficou parado por semanas.
 */
export const HUB_UPDATED_DATE_CEILING_WARN_DAYS = 21;

/**
 * "Teto" de `updatedDate` vs `coverageDate` (#5124 item 3) — SEPARADO de
 * `validateHubContent` de propósito, NUNCA lança/bloqueia build.
 *
 * **Por que warning e não erro, decisão registrada aqui (issue pede
 * decisão explícita):** `validateHubContent` já tem uma checagem
 * ESTRUTURAL equivalente ao piso (`updatedDate` não pode ser ANTERIOR à
 * fonte mais recente — um estado logicamente impossível, "revisei antes de
 * saber da fonte que citei"). O teto aqui é o oposto: um `updatedDate`
 * MUITO à frente de `coverageDate` não é impossível nem necessariamente
 * errado — pode ser um bump de prosa legítimo (typo, reformulação) sem
 * fonte nova pra citar. É um HEURÍSTICO de "isso parece estranho, confira",
 * não um invariante estrutural. Colocar isto dentro de `validateHubContent`
 * (que `renderHubPage` já usa pra `throw`, quebrando os 6 hubs de uma vez —
 * ver docstring de `renderHubPage`) transformaria um sinal probabilístico
 * em bloqueio de build; o piso genuíno (`test/hub-page-drift.test.ts`, que
 * reprova o CI se o `.generated.ts` divergir do fresh render) já é a rede
 * de segurança que impede publicar sem perceber. `build-hub-page.ts` chama
 * esta função separadamente e imprime o resultado como aviso (stderr),
 * nunca como exit code != 0.
 *
 * @pure
 */
export function checkUpdatedDateCeiling(
  hub: Pick<HubContent, "updatedDate" | "sourceEditions">,
): string[] {
  if (hub.sourceEditions.length === 0) return []; // coberto por validateHubContent
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hub.updatedDate)) return []; // idem — formato inválido
  const coverageDate = hubCoverageDate(hub.sourceEditions);
  const gapDays = calendarDaysBetween(coverageDate, hub.updatedDate);
  if (gapDays < HUB_UPDATED_DATE_CEILING_WARN_DAYS) return [];
  return [
    `updatedDate "${hub.updatedDate}" está ${gapDays} dias à frente da edição mais recente citada ("${coverageDate}") ` +
      `— confira se o bump reflete cobertura nova, ou é só revisão de prosa sem fonte nova (limiar: ${HUB_UPDATED_DATE_CEILING_WARN_DAYS} dias, #5124)`,
  ];
}

/**
 * Ids de âncora determinísticos, um por `heading` de `sections` (#5266 —
 * índice navegável no topo do hub, decisão do editor 14/08/2026: UX de
 * leitor, escaneabilidade de página longa; NÃO reabre o descarte de âncora
 * como jogada de GEO do #4899/`HUB_PROSE_RULES`, que segue válido).
 *
 * `slugify` (kebab-case, NFD-strip diacríticos — `scripts/lib/slug.ts`, já
 * usado pra slug de post) garante que o mesmo heading sempre produz o mesmo
 * id entre o link do índice e o `id` do `<h2>` correspondente. Sufixo
 * `-2`/`-3`/... desambigua a rara colisão de 2 headings que geram o mesmo
 * slug (heading repetido, ou headings que só diferem em acento/pontuação) —
 * sem isso, 2 `<h2 id="...">` iguais na mesma página tornam a âncora do
 * segundo um alvo ambíguo. `"secao"` é o fallback pro caso degenerado de um
 * heading vazio/só-pontuação, que `slugify` reduziria a string vazia.
 *
 * @pure
 */
export function hubSectionAnchorIds(headings: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return headings.map((heading) => {
    const base = slugify(heading) || "secao";
    const timesSeen = seen.get(base) ?? 0;
    seen.set(base, timesSeen + 1);
    return timesSeen === 0 ? base : `${base}-${timesSeen + 1}`;
  });
}

/** Renderiza o bloco de tabela opcional de uma `HubSection` (#4921 Onda 2).
 * Célula em texto puro passa por `renderInlineLinks` (não `esc()` puro) —
 * ver decisão registrada na docstring de `HubSectionTable.rows`. */
function renderHubSectionTable(table: HubSectionTable, titleFor?: (url: string) => string | undefined): string {
  return `        <div class="hub-section-table-wrap">
          <table>
            <caption>${esc(table.caption)}</caption>
            <thead>
              <tr>${table.headers.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr>
            </thead>
            <tbody>
${table.rows
  .map((row) => `              <tr>${row.map((cell) => `<td>${renderInlineLinks(cell, titleFor)}</td>`).join("")}</tr>`)
  .join("\n")}
            </tbody>
          </table>
        </div>
        <p class="hub-section-table-methodology">${renderInlineLinks(table.methodology)}</p>`;
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
  // #5265: title="Na edição: {…}" nos links de prosa do corpo (parágrafos +
  // células de tabela de seção) — nunca no FAQ/metodologia (ver docstring de
  // `linkTitles`). `undefined` quando o hub não tem o mapa (comportamento
  // idêntico a antes do #5265).
  const titleFor = hub.linkTitles ? (linkUrl: string) => hub.linkTitles![linkUrl] : undefined;

  // Achado do editor (260804): sem um rótulo próprio, as sections (H2 já em
  // formato de pergunta, issue #4558 item 2) ficam indistinguíveis do bloco
  // "Perguntas frequentes" logo abaixo — as duas leem como "pergunta seguida
  // de resposta" na sequência da página, mas só uma tem nome. O kicker
  // "Cobertura completa" (mesmo estilo visual de `.hub-sources h2`/
  // `.geo-faq-heading` — pequeno, versalete, teal) marca a diferença: aqui é
  // a síntese longa (issue Parte A, "leitura que só existe porque alguém
  // acompanhou por meses"); "Perguntas frequentes" abaixo é o bloco curto
  // que vira dado estruturado FAQPage (issue Parte B item 3).
  // #5266: um id determinístico por seção — usado tanto pelo `<h2>` abaixo
  // quanto pelo índice navegável (`sectionIndexHtml`) montado logo depois.
  // Calculado UMA vez aqui pra garantir que os dois usam exatamente o mesmo
  // valor (nunca duas fontes de verdade pro mesmo slug).
  const sectionAnchorIds = hubSectionAnchorIds(hub.sections.map((s) => s.heading));

  const sectionsHtml = `    <section class="hub-sections" aria-labelledby="cobertura-heading">
      <h2 class="hub-sections-heading" id="cobertura-heading">Cobertura completa</h2>
${hub.sections
  .map(
    (s, i) => `      <article class="hub-section">
        <h2 id="${esc(sectionAnchorIds[i])}">${esc(s.heading)}</h2>
${s.paragraphs.map((p) => `        <p>${renderInlineLinks(p, titleFor)}</p>`).join("\n")}${s.table ? `\n${renderHubSectionTable(s.table, titleFor)}` : ""}
      </article>`,
  )
  .join("\n")}
    </section>`;

  // #5266: índice navegável — lista de `sections[].heading` logo após a
  // intro, âncoras pros `id` acabados de gerar acima. Decisão do editor
  // (14/08/2026): escaneabilidade de leitor em página de 2-3 mil palavras,
  // NÃO uma jogada de GEO (o descarte de âncora como sinal pra assistente
  // continua válido, #4899/`HUB_PROSE_RULES`) — expectativa declarada de
  // efeito em citação é zero.
  const sectionIndexHtml = `      <nav class="hub-section-index" aria-labelledby="indice-heading">
        <h2 class="hub-section-index-heading" id="indice-heading">Nesta página</h2>
        <ol>
${hub.sections.map((s, i) => `          <li><a href="#${esc(sectionAnchorIds[i])}">${esc(s.heading)}</a></li>`).join("\n")}
        </ol>
      </nav>`;

  // #4921 Onda 1: <table> Data | Manchete | Edição em vez de <ul>/<li> — uma
  // LINHA POR MANCHETE (issue #4558 item 2), não por HubSourceEdition: 8 das
  // entradas casam 2 manchetes na mesma edição (`title` é
  // `matchedHeadlines.join(" · ")`, ver `toSourceEditions` em cada
  // `scripts/lib/hubs/{slug}.ts`), e repetir a data nas duas linhas é "o que
  // faz a tabela contar o que a página afirma contar" — mesma convenção de
  // split que `sourceEditionLabel` já assume ao comparar `editionTitle`
  // contra `title.split(" · ")`. Resolve por construção o #4918 Conserto 1
  // (concatenação "06/08Modelo da Anthropic...") — data e manchete agora
  // vivem em `<td>` DISTINTOS, não precisa mais de separador textual manual.
  const sourcesHtml = `    <section class="hub-sources" aria-labelledby="fontes-heading">
      <h2 id="fontes-heading">Edições da diar.ia.br citadas nesta página</h2>
      <div class="hub-sources-table-wrap">
        <table>
          <thead>
            <tr><th scope="col">Data</th><th scope="col">Manchete</th><th scope="col">Edição</th></tr>
          </thead>
          <tbody>
${hub.sourceEditions
  .flatMap((e) => {
    // #4911 item 4: com ano (DD/MM/AAAA) — o intervalo cruza virada de ano,
    // e sem ano dois rótulos "03/09" podem mapear pra anos distintos.
    // `formatDateShort` (achado da Fase 1.5 desta rodada — este bloco
    // reimplementava a mesma regex inline em vez de reusar o helper já
    // extraído no #4922, no mesmo arquivo).
    const label = formatDateShort(e.date);
    const headlines = e.title.split(" · ");
    return headlines.map((headline) => {
      // Coluna "Edição": editionTitle real quando presente e distinto da
      // manchete casada (mesma condição de `sourceEditionLabel`, #4918
      // Conserto 2 — "a manchete casada é frequentemente um destaque
      // secundário da edição"); sem editionTitle, cai no fallback antigo de
      // repetir a própria manchete como rótulo do link.
      const editionLabel = e.editionTitle && e.editionTitle !== headline ? e.editionTitle : headline;
      return `            <tr><td>${esc(label)}</td><td>${esc(headline)}</td><td><a href="${esc(e.url)}">${esc(editionLabel)}</a></td></tr>`;
    });
  })
  .join("\n")}
          </tbody>
        </table>
      </div>
    </section>`;

  // #4939/#4930: bloco próprio, logo depois da bibliografia — é onde o
  // leitor já está olhando para a procedência dos dados. Destino da
  // ressalva epistêmica que o contrato de prosa (#4899) removeu do corpo do
  // texto (ver docstring de `HUB_PROSE_RULES`).
  const methodologyHtml = `    <section class="hub-methodology" aria-labelledby="metodologia-heading">
      <h2 id="metodologia-heading">Metodologia</h2>
      <p>${renderInlineLinks(hub.methodologyNote)}</p>
    </section>`;

  // #4913 itens 1/4: nav "Outros temas" — os hubs eram ilhas (só o índice do
  // arquivo linkava pra eles, nunca o inverso). `relatedHubs` vem já
  // filtrado (sem o próprio slug) de `scripts/build-hub-page.ts`; ausente/
  // vazio (hub único, fixture de teste) não emite a seção nenhuma — inclusive
  // sem o cross-link de volta pro índice, que mora na MESMA nav (item 4) e
  // reusa `footerNavUtm` (não é um UTM novo no registry).
  const relatedHubsHtml =
    hub.relatedHubs && hub.relatedHubs.length > 0
      ? `    <nav class="hub-related-nav" aria-labelledby="outros-temas-heading">
      <h2 id="outros-temas-heading">Outros temas</h2>
      <ul>
${hub.relatedHubs.map((r) => `        <li><a href="${esc(pageUrl(r.slug))}">${esc(r.label)}</a></li>`).join("\n")}
        <li><a href="${esc(`${DIARIA_ARQUIVO_URL}/?utm_source=${hub.footerNavUtm.source}&utm_medium=${hub.footerNavUtm.medium}`)}">Ver todos os temas no arquivo</a></li>
      </ul>
    </nav>`
      : "";

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
${renderSeoMeta({ title: pageTitle, description: hub.metaDescription, url, feed: { url: ARQUIVO_FEED_URL }, image: hub.coverImage })}
${renderAnalyticsHead()}
<meta name="robots" content="index, follow">
<style>
${renderCuradoriaRootStyles()}

${renderCuradoriaHeaderStyles()}

${renderHubBodyStyles()}

${renderGeoFaqStyles()}

${renderCuradoriaCtaSubscribeStyles()}

${renderCuradoriaFooterStyles()}
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="eyebrow">diar.ia.br · Arquivo · Temas</p>
      <hr class="rule">
      <h1>${esc(hub.h1 ?? hub.title)}<span class="dot" aria-hidden="true">.</span></h1>
      <div class="geo-intro-wrap">
        <h2 class="geo-h2">${esc(hub.introHeading)}</h2>
${(typeof hub.introParagraph === "string" ? [hub.introParagraph] : hub.introParagraph)
  .map((p) => `        <p class="geo-intro">${applyBrandWordmark(esc(p))}</p>`)
  .join("\n")}
${renderGeoByline(undefined, `atualizado em ${formatMonthYear(hub.updatedDate)}`)}
      </div>
      <p class="tagline">5 minutos diários pra se manter atualizado e usar melhor as IAs</p>
    </div>
  </header>
  <main>
    <div class="wrap">
${sectionIndexHtml}
${sectionsHtml}
<!-- #4635/#4642: FAQ logo após .hub-sections (não depois de .hub-sources) —
     achado do editor: a lista de edições citadas fica melhor por último,
     como bibliografia; "Perguntas rápidas" (heading próprio, não o default
     "Perguntas frequentes" de livros/cursos/arquivo) evita ler como um 2º
     bloco de FAQ idêntico ao de .hub-sections logo acima. -->
${renderGeoFaqSection(hub.faq, { sectionId: `faq-${hub.slug}`, heading: "Perguntas rápidas" })}
<!-- #5264: CTA "Gostou da síntese?" movido do <header> (antes de qualquer
     síntese) pra cá — depois do FAQ, antes da bibliografia. O leitor já leu
     a síntese inteira quando chega neste ponto; variantClass "end" (não
     "hero") é o estilo já desenhado pra esse lugar na página (mesma classe
     usada no fim da lista de build-livros-page.ts). Escolha (a) da issue —
     um único CTA, não dois — decisão registrada aqui: dois CTAs (prospectivo
     no topo + este no fim) duplicaria o mesmo pedido em duas vozes distintas
     na mesma leitura, sem ganho claro sobre mover o único que já existia. -->
${renderCuradoriaCtaSubscribeForm(
  { id: `hub-${hub.slug}-cta-subscribe`, source: "hub", heading: "Gostou da síntese? Assine a diar.ia.br e receba tutoriais e notícias de IA todo dia, sem enrolação." },
  "end",
)}
${sourcesHtml}
${methodologyHtml}${relatedHubsHtml ? `\n${relatedHubsHtml}` : ""}
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
  // #5124: deriva de `sourceEditions` (coverage), NÃO `hub.updatedDate`
  // (revisão de prosa) — ver `hubCoverageDate`.
  dateModified: hubCoverageDate(hub.sourceEditions),
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
${renderCuradoriaCtaSubscribeScript()}
</body>
</html>
`;
}
