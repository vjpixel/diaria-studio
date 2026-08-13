/**
 * entity-page.ts (#5125 item 2/3)
 *
 * Spec + renderer do formato "página por entidade" — uma das 2 superfícies
 * NOVAS, derivadas do corpus (`data/beehiiv-cache/posts/*.json`), aprovadas
 * pelo editor no #5125 (comentário 12/08/2026: opção C — "não espelhar o
 * acervo, produzir páginas que não existem na Beehiiv"). Publicadas em
 * `especial.diar.ia.br/entidades/{slug}/` — mesmo Worker de assets estáticos
 * (`workers/artigos`) que já hospeda os artigos avulsos, path novo dentro do
 * mesmo `custom_domain` (não é hub novo — hubs vivem em `arquivo.diar.ia.br`
 * com moratória própria até ~07/10, #4558; isto é outro Worker, outro tipo de
 * conteúdo, sem relação com essa moratória).
 *
 * ## As 2 formatos aprovados pelo editor (spec, #5125 item 2)
 *
 * **1. Página por entidade** ("Tudo sobre {empresa/produto} no diar.ia.br",
 * este módulo) — índice CRONOLÓGICO das menções de UMA entidade (empresa,
 * produto, pessoa) no corpus da diária, com um recorte/resumo curto PRÓPRIO
 * por menção (não reempacotamento de manchete — ver critério anti-thin-content
 * abaixo) + link pra edição original que a cita. Formato mais barato de
 * templatizar porque o "eixo" de agrupamento (nome da entidade) já é uma
 * regex determinística sobre título/subtítulo — o mesmo mecanismo que
 * `HUB_KEYWORD_PATTERNS` (`scripts/generate-hub-sources.ts`) já usa pra
 * hubs, aplicado a uma entidade de cauda longa em vez de uma das 6 já
 * cobertas por hub dedicado.
 *
 * **2. Timeline temática** ("O que aconteceu com {tema} — linha do tempo") —
 * recorte cronológico de um TEMA não-produto (um evento ou desenvolvimento
 * contínuo — ex: uma disputa regulatória específica, uma corrida entre
 * modelos, um debate público que se desenrola em várias edições), não uma
 * empresa/produto nomeável. A diferença estrutural do formato 1: o "eixo" de
 * agrupamento não é um match de nome próprio determinístico — é um recorte
 * editorial de QUAIS menções pertencem ao mesmo fio narrativo, que normalmente
 * exige julgamento humano (ou de agente) sobre o que conta como parte do
 * mesmo tema, não só uma regex. Reusaria a mesma `EntityContent`-like shape
 * (lista cronológica de `{data, resumo próprio, link}` + intro + metodologia)
 * mas com um `EntityMatchSpec` mais livre (não necessariamente uma regex
 * única — pode ser uma curadoria manual de URLs de edição). **Fora de escopo
 * de implementação nesta rodada (#5125 item 3, decisão do editor 260813) —
 * só a spec acima, sem página real nem renderer.** Quando a 1ª timeline for
 * escrita, o tipo dela deve nascer aqui do lado de `EntityContent`, reusando
 * o máximo de `renderEntityPage`/`validateEntityContent` que fizer sentido
 * (o header/footer/CTA/SEO são idênticos; o que muda é só a origem da lista
 * de menções — regex de nome vs. curadoria de tema).
 *
 * ## Critério anti-thin-content (#5125 item 2 — não-negociável)
 *
 * A política de spam do Google mira "scaled content abuse" e "doorway
 * pages" — uma página gerada por template a partir de um corpus é
 * EXATAMENTE o padrão sob escrutínio (issue #5125, citando a doc do
 * Google). O critério que separa isto de conteúdo fino, mesmo já usado nos
 * hubs temáticos (#4558): **valor próprio para o leitor, não volume.**
 * Concretamente, para uma página de entidade:
 *
 *   - Cada `EntityMention.summary` é uma síntese PRÓPRIA de 1-3 frases,
 *     escrita depois de ler o corpo real da edição (`content.free.web` do
 *     cache Beehiiv) — nunca a manchete/subtítulo reformulados com sinônimos.
 *     `validateEntityContent` abaixo checa mecanicamente que `summary` não é
 *     idêntico (nem um prefixo/sufixo trivial) de `headline`, mas a checagem
 *     de fato — "isto é síntese real, não paráfrase de manchete" — é
 *     editorial, não automatizável; quem escreve o conteúdo (agente ou
 *     humano) precisa ter lido o corpo da edição, não só o título.
 *   - `mentions.length` tem um piso mínimo (`MIN_MENTIONS`, abaixo) — menos
 *     que isso é lastro insuficiente pra justificar uma página PRÓPRIA em
 *     vez de aparecer só como item avulso no Radar/no corpo de uma edição.
 *     O piso é deliberadamente mais baixo que o de FAQ dos hubs (6-10,
 *     #4558 item 3) porque o formato aqui é mais modesto por design (índice
 *     cronológico com blurb curto, não síntese narrativa de seção longa) —
 *     ver nota "honestidade sobre profundidade" abaixo.
 *   - `introParagraph` amarra o arco em prosa própria (~80-150 palavras) —
 *     não é gerado por concatenação de headlines; é uma leitura de conjunto
 *     de todas as menções.
 *   - Nenhuma menção pode ser só o rodapé de apresentação da newsletter
 *     ("Na Diar.ia usamos a Perplexity para automatizar a pesquisa...") —
 *     isso é autopromoção do PRODUTO diar.ia.br usando a entidade como
 *     ferramenta, não cobertura EDITORIAL da entidade como notícia. Quem
 *     monta `mentions` filtra esses parágrafos fora antes de popular o
 *     array (não há guard automático pra isso — é uma leitura editorial do
 *     corpo de cada edição, mesma natureza do parágrafo acima sobre
 *     paráfrase).
 *
 * ## Honestidade sobre profundidade (guardrail do dispatch desta unidade)
 *
 * Este módulo NÃO tenta gerar uma narrativa sintética "descobrindo" um arco
 * dramático a partir das menções — isso exigiria um pipeline de sumarização
 * automática que a unidade de trabalho desta rodada marcou fora de escopo
 * (preferir uma versão mais simples e honesta a uma sofisticada e frágil).
 * O que o formato entrega é um recorte cronológico com contexto real por
 * menção — cada `summary` é factual e específico (o que a edição de fato
 * disse), o `introParagraph` amarra o fio em 2-3 frases, e o resto é a
 * lista. Isso já cruza a régua "valor próprio" (nenhuma outra página do
 * acervo reúne todas as menções de uma entidade num só lugar, cronológico,
 * com contexto) sem prometer uma profundidade editorial que o processo de
 * geração não sustenta.
 *
 * ## Infra reusada dos hubs (mesma convenção, ver `hub-page.ts`)
 *
 * `curadoria-page.ts` (header/footer/CTA de assinatura/CSS base),
 * `seo-meta.ts` (`<head>` de compartilhamento), `geo-faq.ts` (autoria
 * verificável, JSON-LD `ItemList`, formatação de data) — MESMOS módulos,
 * nenhuma cópia paralela. O que este módulo NÃO reusa de `hub-page.ts`: o
 * contrato de prosa `HUB_PROSE_RULES` (denylist de construções tipo "a
 * diar.ia.br cobriu...") — esse contrato nasceu de uma auditoria específica
 * sobre PROSA NARRATIVA LONGA (seções de várias centenas de palavras); o
 * formato de entidade é uma LISTA com blurbs curtos, onde esse tipo de
 * construção é bem menos provável de aparecer e o custo de portar a
 * denylist inteira não se paga nesta 1ª iteração. Se um `summary` real cair
 * numa das construções proibidas, adicionar o guard aqui quando aparecer —
 * não especular hoje.
 */
import { escHtml as esc } from "../html-escape.ts";
import { renderSeoMeta } from "./seo-meta.ts";
import {
  renderCuradoriaRootStyles,
  renderCuradoriaHeaderStyles,
  renderCuradoriaFooterStyles,
  renderCuradoriaFooter,
  renderCuradoriaCtaSubscribeStyles,
  renderCuradoriaCtaSubscribeForm,
  renderCuradoriaCtaSubscribeScript,
} from "./curadoria-page.ts";
import {
  renderGeoByline,
  renderGeoFaqSection,
  renderGeoFaqStyles,
  renderGeoJsonLd,
  formatMonthYear,
  type GeoFaqItem,
} from "./geo-faq.ts";
import { renderInlineLinks } from "./markdown-links.ts";
import { DIARIA_ESPECIAL_URL } from "../canonical-urls.ts";
import { applyBrandWordmark } from "./brand-wordmark.ts";
import { FONTS } from "./design-tokens.ts";

/** Piso de menções pra uma página de entidade se justificar como página
 * PRÓPRIA (ver seção "Critério anti-thin-content" no docstring do módulo).
 * Escolha de 5: abaixo dos 6-10 de FAQ dos hubs (#4558 item 3, formato mais
 * ambicioso), mas alto o bastante pra excluir uma entidade que aparece só
 * de passagem (1-3x) — essa fica melhor coberta pelo Radar/busca no
 * arquivo, não por uma página dedicada. Reavaliar com dado real se uma 2ª
 * entidade candidata ficar bem abaixo/acima deste piso. */
export const MIN_ENTITY_MENTIONS = 5;

/** Uma menção da entidade numa edição da diar.ia.br — a unidade do índice
 * cronológico (issue #5125: "índice cronológico de menções... com
 * recorte/resumo curto PRÓPRIO"). */
export interface EntityMention {
  /** `YYYY-MM-DD` — data de publicação da edição (BRT, mesma convenção de
   * `HubSourceEdition.date`). */
  date: string;
  /** Manchete/subtítulo real que mencionou a entidade nesta edição — o texto
   * ORIGINAL da diária, não reescrito. Serve só de referência estrutural
   * (o que a edição chamou aquele fato); o valor da página está em
   * `summary`, não aqui. */
  headline: string;
  /** URL da edição no domínio de marca (`https://diar.ia.br/p/{slug}`). */
  editionUrl: string;
  /** Título REAL da edição (`post.title` do cache) — pode divergir de
   * `headline` quando a menção veio do subtítulo/de um item secundário,
   * mesmo padrão de `HubSourceEdition.editionTitle`. */
  editionTitle: string;
  /**
   * Síntese PRÓPRIA de 1-3 frases sobre o que aconteceu — escrita depois de
   * ler `content.free.web` da edição, nunca uma paráfrase da manchete (ver
   * critério anti-thin-content do docstring do módulo). Suporta o subset
   * `[texto](url)` (`renderInlineLinks`) pra linkar uma fonte primária
   * externa quando o corpo da edição citar uma (mesmo padrão de
   * `HubSection.paragraphs`).
   */
  summary: string;
}

export interface EntityContent {
  /** Usado na rota (`especial.diar.ia.br/entidades/{slug}/`) e no path do
   * arquivo estático gerado. */
  slug: string;
  /** Nome da entidade (ex: "Perplexity") — rótulo curto usado em
   * `<title>`/`og:title` e no `<h1>`. */
  name: string;
  metaDescription: string;
  /** H2 do bloco intro, formato de pergunta literal (mesma convenção dos
   * hubs, issue #4558 item 2 — reaplicada aqui por consistência de DS, não
   * porque #5125 exige explicitamente). */
  introHeading: string;
  /** ~80-150 palavras amarrando o arco das menções em prosa própria — não
   * gerado por concatenação de headlines (ver docstring do módulo). */
  introParagraph: string;
  /** Ordem CRONOLÓGICA ASCENDENTE (mais antiga primeiro) — "índice
   * cronológico" (issue #5125 item 2, formato 1) lido como uma linha do
   * tempo que avança, não uma lista decrescente tipo blog (diferente de
   * `HubContent.sourceEditions`, que é decrescente — a inversão é
   * deliberada: hub é bibliografia, isto é uma HISTÓRIA que se desenrola). */
  mentions: EntityMention[];
  /** FAQ opcional (issue #4558 padrão de GEO, reaplicado por consistência —
   * `renderEntityPage` só emite a seção quando não-vazio). Sem piso de
   * 6-10 como os hubs — o formato de entidade é mais modesto por design. */
  faq: GeoFaqItem[];
  /** `YYYY-MM-DD` estático — dia em que a página nasceu. */
  publishedDate: string;
  /** `YYYY-MM-DD` estático — dia da última revisão de prosa/dado. */
  updatedDate: string;
  /** Ressalva de procedência (mesma disciplina de `HubContent.methodologyNote`,
   * #4939/#4930) — de onde vem o levantamento e o que ele NÃO é. */
  methodologyNote: string;
  footerNavUtm: { readonly source: string; readonly medium: string };
}

function pageUrl(slug: string): string {
  return `${DIARIA_ESPECIAL_URL}/entidades/${slug}/`;
}

/**
 * Valida um `EntityContent` contra o critério anti-thin-content mecanizável
 * (a parte editorial — "é síntese real, não paráfrase" — não é
 * automatizável, ver docstring do módulo). Retorna a lista de violações;
 * vazio = válido. `renderEntityPage` chama isto e lança se houver violação
 * (fail-fast, mesmo padrão de `validateHubContent`).
 *
 * @pure
 */
export function validateEntityContent(entity: EntityContent): string[] {
  const errors: string[] = [];
  if (entity.mentions.length < MIN_ENTITY_MENTIONS) {
    errors.push(
      `mentions tem ${entity.mentions.length} entrada(s) — mínimo ${MIN_ENTITY_MENTIONS} pra justificar página própria (ver MIN_ENTITY_MENTIONS)`,
    );
  }
  for (let i = 1; i < entity.mentions.length; i++) {
    if (entity.mentions[i - 1].date > entity.mentions[i].date) {
      errors.push("mentions não está ordenado cronologicamente (mais antiga primeiro)");
      break;
    }
  }
  entity.mentions.forEach((m, i) => {
    if (!m.editionUrl.startsWith("https://diar.ia.br/")) {
      errors.push(`mentions[${i}].editionUrl fora do domínio de marca: "${m.editionUrl}"`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date)) {
      errors.push(`mentions[${i}].date não é YYYY-MM-DD: "${m.date}"`);
    }
    const summaryNorm = m.summary.trim().toLowerCase();
    const headlineNorm = m.headline.trim().toLowerCase();
    // Guard mecânico do critério anti-thin-content: summary idêntico (ou um
    // dos dois sendo prefixo do outro) à headline é o sinal mais barato de
    // "isto é a manchete reformulada com sinônimos", não síntese própria.
    // Não pega paráfrase mais sutil (isso é editorial, ver docstring) — só o
    // caso degenerado óbvio.
    if (
      summaryNorm.length > 0 &&
      (summaryNorm === headlineNorm || summaryNorm.startsWith(headlineNorm) || headlineNorm.startsWith(summaryNorm))
    ) {
      errors.push(`mentions[${i}].summary é idêntico ou prefixo/sufixo trivial da headline — não é síntese própria`);
    }
    const MIN_SUMMARY_LENGTH = 60;
    if (m.summary.trim().length < MIN_SUMMARY_LENGTH) {
      errors.push(
        `mentions[${i}].summary tem ${m.summary.trim().length} caracteres — mínimo ${MIN_SUMMARY_LENGTH} (blurb curto demais pra carregar contexto próprio)`,
      );
    }
  });
  if (entity.introParagraph.trim().length === 0) {
    errors.push("introParagraph está vazio");
  }
  if (entity.methodologyNote.trim().length === 0) {
    errors.push("methodologyNote está vazio — página sem a ressalva de procedência");
  }
  const META_DESCRIPTION_MAX_LENGTH = 160;
  if (entity.metaDescription.length > META_DESCRIPTION_MAX_LENGTH) {
    errors.push(
      `metaDescription tem ${entity.metaDescription.length} caracteres — máximo ${META_DESCRIPTION_MAX_LENGTH}`,
    );
  }
  if (entity.updatedDate < entity.publishedDate) {
    errors.push(`updatedDate "${entity.updatedDate}" é anterior a publishedDate "${entity.publishedDate}"`);
  }
  if (
    entity.mentions.length > 0 &&
    entity.updatedDate < entity.mentions[entity.mentions.length - 1].date
  ) {
    errors.push(
      `updatedDate "${entity.updatedDate}" é anterior à menção mais recente ("${entity.mentions[entity.mentions.length - 1].date}")`,
    );
  }
  return errors;
}

/** CSS específico do corpo da página de entidade — timeline de menções.
 * Reusa `.wrap`/header/footer/CTA de `curadoria-page.ts` e `.geo-*` de
 * `geo-faq.ts`; só a lista cronológica é própria daqui. */
function renderEntityBodyStyles(): string {
  const { serif, sans } = FONTS;
  return `  main { padding: 40px 0 64px; }
  .geo-intro-wrap { max-width: 720px; }
  .entity-timeline { max-width: 720px; margin: 48px 0 0; }
  .entity-timeline-heading { font-family: ${serif}; font-size: 15px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--teal); margin: 0 0 24px; }
  .entity-mention { margin: 0 0 32px; padding: 0 0 0 20px; border-left: 2px solid var(--rule); }
  .entity-mention-date { font-family: ${sans}; font-size: 12px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--teal); margin: 0 0 6px; }
  .entity-mention h2 { font-family: ${serif}; font-size: 19px; font-weight: 600; line-height: 1.3;
    margin: 0 0 8px; color: var(--ink); }
  .entity-mention h2 a { text-decoration: none; }
  .entity-mention h2 a:hover { color: var(--teal); }
  .entity-mention p { font-size: 16px; line-height: 1.55; color: var(--ink); margin: 0; }
  .entity-mention p a { color: var(--teal); text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 2px; }
  .entity-mention p a:hover { text-decoration-color: var(--teal); }
  main .geo-faq { max-width: 720px; }
  .entity-methodology { margin: 32px 0 0; padding: 24px 0 0; border-top: 1px solid var(--rule); max-width: 720px; }
  .entity-methodology h2 { font-family: ${serif}; font-size: 13px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--teal); margin: 0 0 10px; }
  .entity-methodology p { font-size: 14px; line-height: 1.6; color: var(--ink); opacity: 0.72; margin: 0; }`;
}

/**
 * Renderiza o HTML completo de uma página de entidade. Pure — sem I/O, sem
 * `Date.now()`. Lança se `validateEntityContent` encontrar violação
 * (fail-fast, mesmo padrão de `renderHubPage`). Chamada por
 * `scripts/build-entity-page.ts` (nunca em runtime — `workers/artigos` é
 * assets-only, serve o HTML já gerado).
 */
export function renderEntityPage(entity: EntityContent): string {
  const violations = validateEntityContent(entity);
  if (violations.length > 0) {
    throw new Error(`renderEntityPage: EntityContent inválido para "${entity.slug}":\n- ${violations.join("\n- ")}`);
  }
  const url = pageUrl(entity.slug);
  const pageTitle = `${entity.name} — tudo que a diar.ia.br já cobriu`;

  const timelineHtml = `    <section class="entity-timeline" aria-labelledby="timeline-heading">
      <h2 class="entity-timeline-heading" id="timeline-heading">Linha do tempo</h2>
${entity.mentions
  .map(
    (m) => `      <article class="entity-mention">
        <p class="entity-mention-date">${esc(formatDateShort(m.date))}</p>
        <h2><a href="${esc(m.editionUrl)}">${esc(m.editionTitle)}</a></h2>
        <p>${renderInlineLinks(m.summary)}</p>
      </article>`,
  )
  .join("\n")}
    </section>`;

  const methodologyHtml = `    <section class="entity-methodology" aria-labelledby="metodologia-heading">
      <h2 id="metodologia-heading">Metodologia</h2>
      <p>${renderInlineLinks(entity.methodologyNote)}</p>
    </section>`;

  const faqHtml =
    entity.faq.length > 0
      ? `\n${renderGeoFaqSection(entity.faq, { sectionId: `faq-${entity.slug}`, heading: "Perguntas rápidas" })}`
      : "";

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
${renderSeoMeta({ title: pageTitle, description: entity.metaDescription, url })}
<meta name="robots" content="index, follow">
<style>
${renderCuradoriaRootStyles()}

${renderCuradoriaHeaderStyles()}

${renderEntityBodyStyles()}

${renderGeoFaqStyles()}

${renderCuradoriaCtaSubscribeStyles()}

${renderCuradoriaFooterStyles()}
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="eyebrow">diar.ia.br · Especial · Entidades</p>
      <hr class="rule">
      <h1>${esc(entity.name)}<span class="dot" aria-hidden="true">.</span></h1>
      <div class="geo-intro-wrap">
        <h2 class="geo-h2">${esc(entity.introHeading)}</h2>
        <p class="geo-intro">${applyBrandWordmark(esc(entity.introParagraph))}</p>
${renderGeoByline(undefined, `atualizado em ${formatMonthYear(entity.updatedDate)}`)}
      </div>
      <p class="tagline">5 minutos diários pra se manter atualizado e usar melhor as IAs</p>
${renderCuradoriaCtaSubscribeForm(
  { id: `entity-${entity.slug}-cta-subscribe`, source: "entity", heading: `Gostou do histórico de ${entity.name}? Assine a diar.ia.br e receba tutoriais e notícias de IA todo dia, sem enrolação.` },
  "hero",
)}
    </div>
  </header>
  <main>
    <div class="wrap">
${timelineHtml}${faqHtml}
${methodologyHtml}
    </div>
  </main>
  ${renderCuradoriaFooter(
    `diar.ia.br — tudo sobre ${entity.name}`,
    `utm_source=${entity.footerNavUtm.source}&utm_medium=${entity.footerNavUtm.medium}`,
  )}
${renderGeoJsonLd({
  pageUrl: url,
  headline: pageTitle,
  description: entity.metaDescription,
  datePublished: entity.publishedDate,
  // NUNCA a data da menção mais recente (diferente de `hubCoverageDate` em
  // `hub-page.ts`): lá o hub é publicado incrementalmente ao longo de meses
  // e a cobertura avança PASSANDO o publishedDate original. Aqui a página
  // nasce de uma vez, com todas as menções já históricas — usar a data da
  // menção mais recente como dateModified produziria `dateModified <
  // datePublished` sempre que a última menção for anterior ao dia de
  // publicação (o caso normal: a entidade não necessariamente foi
  // mencionada HOJE). `updatedDate` (validado por `validateEntityContent`
  // como sempre >= toda data em `mentions`) é o campo correto aqui.
  dateModified: entity.updatedDate,
  faq: entity.faq,
  itemList: {
    name: `Edições da diar.ia.br que mencionam ${entity.name}`,
    items: entity.mentions.map((m) => ({ name: m.editionTitle, url: m.editionUrl })),
  },
})}
${renderCuradoriaCtaSubscribeScript()}
</body>
</html>
`;
}

/** `YYYY-MM-DD` → "DD/MM/AAAA" — mesma função que `hub-page.ts::formatDateShort`
 * (cópia local deliberada: `entity-page.ts` não importa de `hub-page.ts`, os
 * dois módulos são consumidores irmãos de `curadoria-page.ts`/`geo-faq.ts`,
 * não um do outro — importar cruzado criaria um acoplamento sem precedente
 * entre "hub" e "entidade" que nenhum dos dois domínios pede hoje). */
function formatDateShort(dateIso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso);
  if (!m) return dateIso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}
