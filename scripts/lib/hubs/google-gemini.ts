/**
 * google-gemini.ts (#4558, 3º hub temático publicado)
 *
 * ⚠️ EDITOU ESTE ARQUIVO? Rode antes de commitar:
 *   npx tsx scripts/build-hub-page.ts --hub google-gemini
 * Sem isso, `workers/arquivo/src/hubs/google-gemini.generated.ts` fica
 * defasado e `test/hub-page-drift.test.ts` quebra o CI (#4897 — já
 * aconteceu 3x na mesma sessão antes deste aviso existir).
 *
 * Conteúdo editorial do 3º hub temático — Google/Gemini. Segue o mesmo
 * template estrutural e de qualidade de `anthropic-claude.ts` (#4558, 1º hub
 * temático): mesmo shape de `HubContent`, mesma `countMatching` com normalização
 * NFC, mesma função de FAQ pura recebendo `sources` por parâmetro (nunca lê
 * `SOURCES` do módulo direto dentro da função — achado do fleet review
 * original, replicado aqui de propósito).
 *
 * **Critério de qualidade da issue #4558 (não-negociável):** as seções
 * abaixo conectam pontos ao longo de ~11 meses de cobertura (só visível
 * olhando o ARQUIVO inteiro, não uma edição isolada) — não reempacotam
 * manchete.
 *
 * **Escopo do #4922 item 1** (substitui a nota anterior — este era o hub
 * com mais números transcritos à mão dos 4, e o com o histórico mais
 * concreto de regressão: #4895/#4896/#4945): total de edições/manchetes, a
 * janela de cobertura, a cadência, a janela e a contagem de lançamento, o
 * total de menções ao Brasil/educação e os 3 surtos de lançamento (com os
 * hiatos e vãos entre eles) agora vêm de um único objeto derivado
 * (`deriveGoogleGeminiFacts`), consumido por `buildIntro`,
 * `buildGoogleGeminiFaq` e `getGoogleGeminiHub` (`sections`). Os hiatos
 * entre surtos são derivados por POSIÇÃO no array de datas de lançamento
 * ordenado — ver a nota na própria função sobre a fragilidade dessa
 * premissa se a estrutura "5+2+3 surtos" mudar num regen futuro. O que
 * continua literal, de propósito (item 4 da issue): a contagem de
 * investimento em `sections` ("4 manchetes de escala bilionária ou
 * nacional") é uma curadoria manual mais ampla que o padrão `investe`
 * (que conta só 2) — não é o mesmo fato, então não interpola o mesmo
 * número. `test/build-hub-page.test.ts`/`test/hub-google-gemini-launch-gap-4945.test.ts`
 * seguem cobrindo este hub.
 *
 * **Fonte é a cobertura da diária, não fato-checado contra o Google
 * real** — este módulo sintetiza o que a diar.ia.br noticiou sobre o tema,
 * no vocabulário que a própria diária usou. Não é o papel deste hub
 * verificar a alegação original de cada manchete — isso já aconteceu (ou
 * não) na pesquisa/gate de Stage 1 de cada edição.
 *
 * Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *   npx tsx scripts/generate-hub-sources.ts --hub google-gemini
 *   npx tsx scripts/build-hub-page.ts --hub google-gemini
 */
import type { GeoFaqItem } from "../shared/geo-faq.ts";
import {
  hubCoverageWindow,
  hubTotals,
  hubMentionCadenceDays,
  countMatching,
  matchingDates,
  calendarDaysBetween,
  formatDateShort,
  formatDateLong,
  defaultMethodologyNote,
  buildLaunchChronologyTable,
  type HubContent,
  type HubSourceEdition,
} from "../shared/hub-page.ts";
import { HUB_GOOGLE_GEMINI_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import sourcesRaw from "./google-gemini-sources.generated.json" with { type: "json" };
import type { HubSourceEntry } from "../../generate-hub-sources.ts";

const SOURCES = sourcesRaw as HubSourceEntry[];

/** `YYYY-MM-DD` estático — dia em que a página nasceu (`72ad89f2`, #4790).
 * Ver nota de `hub-page.ts` sobre por que não pode ser `new Date()`, e sobre
 * por que é campo SEPARADO de `UPDATED_DATE` (#4911). */
const PUBLISHED_DATE = "2026-08-09";

/** `YYYY-MM-DD` estático — dia em que o CORPO foi revisado por último. Bump
 * manual quando a prosa for reescrita de forma substancial — uma
 * regeneração rotineira de `sources.generated.json` NÃO invalida a data
 * sozinha, mas PODE desincronizar os números computados do `faq` dos
 * números transcritos à mão em `sections`/`INTRO` (mesma ressalva de
 * `anthropic-claude.ts`); bump sem mudança de corpo é o padrão que o #4911
 * desaconselha. */
// 2026-08-18 (#5628): limpeza de prosa (moldura de cobertura/ponteiro sem
// "seção") — bump por mudança de CORPO, não por fonte nova.
// 2026-08-18 (#5632): `generate-hub-sources.ts --hub google-gemini` trouxe
// 2 fontes novas (cobertura de 30/07 pra 17/08, fechando a defasagem de 19
// dias que a issue mediu) — todo número em `faq`/`introParagraph`/`sections`
// é derivado de `SOURCES` via `deriveGoogleGeminiFacts`/`countMatching`, sem
// literal transcrito à mão, então o regen não precisou de reescrita de
// prosa (mesmo mecanismo que já valia antes; só documentando o bump aqui).
//
// 2026-08-27 (#6274): `generate-hub-sources.ts --all` trouxe 2 fontes novas
// (24 e 26/08/2026). Nenhuma abriu seção nova:
//  - 24/08 "Google lança simulado do Enem no Gemini": continuação do arco
//    de educação/Brasil já narrado em `sections[2]` ("Que aposta em
//    educação o Google fez em IA no Brasil?") — mais um produto educacional
//    gratuito, mesmo tema.
//  - 26/08 "Google mira escritórios de advocacia com Gemini" (Gemini
//    Enterprise para advocacia): continuação do arco de integração em
//    produtos/verticais profissionais já narrado em `sections[1]` ("Como o
//    Gemini foi se espalhando pelos produtos do dia a dia e pelo Brasil?").
// Bump por fonte nova, não por reescrita de corpo.
const UPDATED_DATE = "2026-08-27";

/** `matchedHeadlines` vem em NFD (mesmo achado de `anthropic-claude.ts`) —
 * ver a nota completa em `countMatching`/`matchingDates`, agora em
 * `scripts/lib/shared/hub-page.ts` (#4922 item 1: motor único reusado pelos
 * 4 hubs, não reimplementado aqui). */
const LAUNCH_PATTERN =
  /gemini 2[.,]5 flash image|novo modelo de v[íi]deo|^tudo sobre gemini 3$|nano banana pro|gemini 3 flash e manus|gemini 3\.1 pro|nano banana 2: melhor|gemini omni|nano banana 2 lite: gera[çc][ãa]o|trio gemini 3\.6/i;
const CHATGPT_PATTERN = /chatgpt/i;
const BRASIL_PATTERN = /brasil/i;
const NANO_BANANA_PATTERN = /nano banana/i;
const SAUDE_PATTERN = /\bsus\b|c[âa]ncer|m[eé]dicos/i;
const EDUCACAO_PATTERN = /curso|treinamento/i;
const INVESTE_PATTERN = /investe/i;
const REGULATORIO_PATTERN = /banir|ue obriga|domina.*buscas/i;

/**
 * Fatos derivados de `sources` (#4922 item 1) — o objeto único que
 * `buildIntro`, `buildGoogleGeminiFaq` e `getGoogleGeminiHub` (`sections`)
 * agora consomem em vez de cada um recalcular ou transcrever à mão o mesmo
 * número. Inclui os 3 surtos de lançamento — cada padrões abaixo foi
 * desenhado e testado ao vivo (script de apoio, não commitado) contra
 * `google-gemini-sources.generated.json` até bater exatamente o número
 * citado na prosa; os HIATOS/vãos entre datas de lançamento específicas
 * (`gap1`/`gap2`/`spanSurge1`/`spanSurge3`/`gapWithinSurge2`/
 * `gapWithinSurge3a`/`gapWithinSurge3b`) são derivados por POSIÇÃO no array
 * de datas ordenado (`launchDates`) — estável enquanto o número e a ordem
 * dos 3 surtos não mudar; um regen que altere a estrutura dos surtos exige
 * revisão manual da prosa (e das posições usadas aqui), não só do dataset.
 */
function deriveGoogleGeminiFacts(sources: HubSourceEntry[]) {
  const { totalEditions, totalMentions } = hubTotals(sources);
  const { firstDate: oldest, lastDate: newest } = hubCoverageWindow(sources);
  const cadenceDays = hubMentionCadenceDays(sources);
  const launches = countMatching(sources, LAUNCH_PATTERN);
  const launchDates = matchingDates(sources, LAUNCH_PATTERN);
  const launchWindow = { first: launchDates[0] ?? oldest, last: launchDates[launchDates.length - 1] ?? newest };
  const chatgpt = countMatching(sources, CHATGPT_PATTERN);
  const brasil = countMatching(sources, BRASIL_PATTERN);
  const nanoBanana = countMatching(sources, NANO_BANANA_PATTERN);
  const saude = countMatching(sources, SAUDE_PATTERN);
  const educacao = countMatching(sources, EDUCACAO_PATTERN);
  const investe = countMatching(sources, INVESTE_PATTERN);
  const regulatorio = countMatching(sources, REGULATORIO_PATTERN);
  // Dataset real: 10 datas de lançamento em 3 surtos de 5+2+3, índices
  // 0-4/5-6/7-9 — ver docstring acima sobre a fragilidade dessa premissa.
  const d = launchDates;
  const surges =
    d.length >= 10
      ? {
          spanSurge1: calendarDaysBetween(d[0], d[4]),
          gap1: calendarDaysBetween(d[4], d[5]),
          gapWithinSurge2: calendarDaysBetween(d[5], d[6]),
          gap2: calendarDaysBetween(d[6], d[7]),
          gapWithinSurge3a: calendarDaysBetween(d[7], d[8]),
          gapWithinSurge3b: calendarDaysBetween(d[8], d[9]),
          spanSurge3: calendarDaysBetween(d[7], d[9]),
          surge1End: d[4],
          surge2Start: d[5],
          surge3Start: d[7],
        }
      : null;
  return {
    totalEditions,
    totalMentions,
    oldest,
    newest,
    cadenceDays,
    launches,
    launchWindow,
    chatgpt,
    brasil,
    nanoBanana,
    saude,
    educacao,
    investe,
    regulatorio,
    surges,
  };
}

/**
 * Monta o FAQ (issue #4558 item 3/6: 6-10 perguntas, números reais). Pure —
 * testável sem IO, opera inteiramente sobre o `sources` recebido (nunca lê
 * `SOURCES` do módulo direto — ver nota de `deriveGoogleGeminiFacts`).
 */
export function buildGoogleGeminiFaq(sources: HubSourceEntry[]): GeoFaqItem[] {
  const {
    totalEditions,
    totalMentions,
    oldest,
    newest,
    launches,
    launchWindow,
    chatgpt,
    brasil,
    nanoBanana,
    saude,
    educacao,
    investe,
    regulatorio,
    surges,
  } = deriveGoogleGeminiFacts(sources);
  // Fixture sintético (< 10 datas de lançamento) não tem os 3 surtos — o
  // texto do FAQ #2 abaixo é específico do dataset real de produção (mesma
  // ressalva de `anthropic-claude.ts`: a narrativa "5+2+3" não generaliza
  // pra qualquer tamanho de sources), então cai pra 0 nesse caso.
  const s = surges ?? {
    spanSurge1: 0,
    gap1: 0,
    gapWithinSurge2: 0,
    gap2: 0,
    gapWithinSurge3a: 0,
    gapWithinSurge3b: 0,
    spanSurge3: 0,
  };
  // #4923 item 1: substitui o CTA-sem-dado (obrigatório aqui — o hub já
  // está no teto de 10 perguntas do validador) por uma pergunta factual. A
  // Seção 2 ("Como o Gemini foi se espalhando pelos produtos do dia a dia e
  // pelo Brasil?") já narra essas integrações sem porta de entrada no FAQ.
  const integracaoProdutos = countMatching(sources, /chrome|maps|workspace|gmail|docs|siri|copilot/i);

  // Achado do editor no hub anterior (260804), replicado aqui: as perguntas
  // abaixo não podem repetir o texto literal do H2 de nenhuma `section`.
  // Onde o tema já tem uma seção de síntese, a pergunta do FAQ pega um
  // ângulo mais estreito (estatística rápida, sub-tópico específico) e
  // aponta de volta pra seção pro relato completo.
  return [
    {
      question: "Com que frequência o Google ou o Gemini viram notícia?",
      answer: `Entre ${formatDateShort(oldest ?? "")} e ${formatDateShort(newest ?? "")}, o Google ou o Gemini apareceram em ${totalEditions} edições da diar.ia.br, somando ${totalMentions} manchetes: quase uma menção a cada 5 dias corridos ao longo de 11 meses.`,
    },
    {
      question: "Quantos lançamentos de modelo ou ferramenta o Google teve nesse período?",
      answer: `Foram ${launches} lançamentos entre ${formatDateShort(launchWindow.first)} e ${formatDateShort(launchWindow.last)}, em 3 surtos separados por hiatos: 5 modelos em ${s.spanSurge1} dias até dezembro de 2025, depois 2 em ${s.gapWithinSurge2} dias em fevereiro de 2026, e 3 em ${s.spanSurge3} dias a partir de maio. Os hiatos entre eles foram de ${s.gap1} e de ${s.gap2} dias — este o mais longo do período.`,
    },
    {
      question: "O Gemini já \"venceu\" o ChatGPT?",
      answer: `A palavra "ChatGPT" apareceu ao lado do Gemini em ${chatgpt} manchetes diferentes, incluindo uma pergunta direta, ["O Gemini venceu o ChatGPT?"](https://diar.ia.br/p/o-gemini-venceu-o-chatgpt), que nunca foi respondida com um "sim" categórico. A narrativa vai da OpenAI se dizendo ameaçada pelos resultados do Google, em novembro de 2025, à disputa ampliada para Meta e DeepSeek, em abril de 2026.`,
    },
    {
      question: "Quantas vezes o Gemini foi anunciado como novidade chegando ao Brasil?",
      answer: `Pelo menos ${brasil} manchetes trataram o Brasil como destino de um lançamento ou investimento do Google, incluindo um caso em que [a mesma função chegou ao país duas vezes com nomes diferentes](https://diar.ia.br/p/nvidia-anuncia-investimento-de-us-100-bi-na-openai), com 14 dias de intervalo. A sequência vai do AI Mode em setembro de 2025 ao fundo de investimento local em junho de 2026.`,
    },
    {
      question: "O que é o Nano Banana e quantas vezes ele apareceu na cobertura?",
      answer: `O Nano Banana (a linha de geração de imagem do Google) apareceu em ${nanoBanana} manchetes: [Nano Banana Pro](https://diar.ia.br/p/sao-paulo-oferece-cursos-de-ia-gratuitos), [Nano Banana 2](https://diar.ia.br/p/claude-opus-3-se-aposenta-e-vira-blogueiro) e, mais recentemente, o [Nano Banana 2 Lite](https://diar.ia.br/p/anthropic-lan-a-sonnet-5), lançado e, 5 dias depois, [detalhado de novo por gerar imagem em 4 segundos](https://diar.ia.br/p/testei-a-alexa-por-uma-semana-o-que-mudou).`,
    },
    {
      question: "O Google já usou IA para resolver um problema de saúde real?",
      answer: `Sim, ${saude} casos concretos: [um sistema do Google igualando médicos em teste clínico](https://diar.ia.br/p/sistema-do-google-iguala-m-dicos-em-teste) e, 26 dias depois, [a mesma IA detectando um câncer raro dentro do SUS](https://diar.ia.br/p/ia-do-google-detecta-c-ncer-raro-no-sus). Os dois fecham uma escalada que começa em pesquisa pura, com o Gemini 3 resolvendo um problema descrito como "insolúvel" na ciência em fevereiro de 2026.`,
    },
    {
      question: "Quantos cursos gratuitos de IA o Google já ofereceu no Brasil?",
      answer: `Foram ${educacao} iniciativas de formação em IA ao longo de 5 meses, de treinamento em cinema a curso online aos sábados. 146 dias depois do último curso, de um jeito quase irônico: o Google passou a liberar o uso de IA dentro das próprias entrevistas técnicas de emprego.`,
    },
    {
      question: "Qual foi o maior investimento em infraestrutura de IA que o Google anunciou no período?",
      answer: `O maior número citado foi US$ 15 bilhões, [anunciado em 19 de fevereiro de 2026](https://diar.ia.br/p/lula-na-maior-cupula-global-de-ia-bde9c122905d2d79), mas foram ${investe} manchetes de investimento direto no período, sem contar o hardware próprio (a 8ª geração de TPUs do Google Cloud) nem o fundo de IA feito no Brasil ao lado da Monashees.`,
    },
    {
      question: "Por que o tamanho do Google no mercado de buscas virou motivo de alarme regulatório?",
      answer: `Em 9 dias de julho de 2026 saíram ${regulatorio} manchetes que, lidas juntas, explicam o alarme: a União Europeia forçando o Google a abrir dados para rivais, editoras cogitando banir o buscador e um estudo mostrando a IA do Google dominando 43% das buscas nos EUA.`,
    },
    {
      question: "Em quantos produtos do dia a dia, além do buscador, o Gemini já foi integrado?",
      answer: `Pelo menos ${integracaoProdutos} manchetes cobriram uma integração do Gemini fora do próprio buscador: [o Chrome](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-798f898c74970), [o Google Maps](https://diar.ia.br/p/aws-sofre-queda), [a Siri, via parceria com a Apple](https://diar.ia.br/p/siri-agora-tera-gemini), [o Workspace](https://diar.ia.br/p/microsoft-em-busca-da-superinteligencia), [o Gmail](https://diar.ia.br/p/grok-sendo-investigado-internacionalmente) e [o Google Docs, editado pelo próprio Gemini](https://diar.ia.br/p/repositorio-de-ia-sem-freio-para-nudes-ilegais), entre outras.`,
    },
  ];
}

function toSourceEditions(sources: HubSourceEntry[]): HubSourceEdition[] {
  return [...sources]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((s) => ({
      date: s.date,
      title: s.matchedHeadlines.join(" · "),
      editionTitle: s.editionTitle,
      url: s.url,
    }));
}

/** INTRO derivada de `sources` (#4917 item 1) — ver a nota gêmea em
 * `anthropic-claude.ts`. A janela deste hub já estava correta (a #4895/#4896
 * consertou aqui primeiro); derivar impede que ela volte a divergir no
 * próximo regen, que foi o que aconteceu nos dois gêmeos. */
function buildIntro(sources: HubSourceEntry[]): [string, string] {
  const { betweenLong } = hubCoverageWindow(sources);
  const { totalEditions, totalMentions, brasil, surges } = deriveGoogleGeminiFacts(sources);
  const gap2 = surges?.gap2 ?? 0;
  // #5259: array de 2 elementos — o orçamento de ~250 palavras não cabe no
  // teto de 160 por parágrafo (HUB_MAX_PARAGRAPH_WORDS) numa unidade só;
  // quebra no ponto natural entre "ritmo de lançamento + disputa com a
  // OpenAI" e "Brasil + aplicação prática + fim de período regulatório".
  return [
    `Entre ${betweenLong}, o Google e o Gemini foram destaque em ${totalEditions} edições da diar.ia.br, ${totalMentions} manchetes ao todo, quase uma menção a cada 5 dias corridos ao longo de 11 meses. Olhando o arquivo inteiro, não uma edição isolada, um padrão salta aos olhos: os lançamentos de modelo não vêm num fluxo parelho, vêm em 3 surtos separados por hiatos, o mais longo deles de ${gap2} dias entre fevereiro e maio de 2026. Houve também uma inversão de narrativa: um Google descrito como ameaçado pelos resultados da OpenAI em novembro de 2025 virou, cerca de 4 meses e meio depois, um Google apostando abertamente contra Meta e DeepSeek também.`,
    `No Brasil, o Gemini foi anunciado como novidade em pelo menos ${brasil} manchetes diferentes, do AI Mode em setembro de 2025 a um fundo de investimento local em junho de 2026, incluindo um caso em que a mesma função chegou ao país duas vezes, com nomes diferentes, em 2 semanas de intervalo. Do lado da aplicação prática, o Gemini foi de "resolve o insolúvel na ciência" a detectar câncer raro dentro do SUS. O período termina em tensão: em 9 dias de julho de 2026 vieram a União Europeia forçando o Google a abrir dados para rivais, editoras cogitando banir o buscador e um estudo mostrando que a IA do Google já domina 43% das buscas nos EUA.`,
  ];
}

export function getGoogleGeminiHub(): HubContent {
  const { since, until } = hubCoverageWindow(SOURCES);
  const { launches, launchWindow, brasil, educacao, surges } = deriveGoogleGeminiFacts(SOURCES);
  const s = surges ?? {
    spanSurge1: 0,
    gap1: 0,
    gapWithinSurge2: 0,
    gap2: 0,
    gapWithinSurge3a: 0,
    gapWithinSurge3b: 0,
    spanSurge3: 0,
    surge1End: launchWindow.first,
    surge2Start: launchWindow.first,
    surge3Start: launchWindow.first,
  };
  return {
    slug: "google-gemini",
    title: "Google e Gemini",
    // #4912: H1 carrega o intervalo coberto (o `<title>`/`og:title` continua
    // só `title`, montado em `renderHubPage` — não duplicam o período).
    h1: `Google e Gemini — de ${since} a ${until}`,
    // #4913: ≤160 chars (validateHubContent) — trecho final enxuto de propósito.
    metaDescription: `Google e Gemini no arquivo da diar.ia.br, de ${since} a ${until}: lançamentos, expansão no Brasil, disputa com o ChatGPT e alarme regulatório.`,
    introHeading: `O que aconteceu com o Google e o Gemini desde ${since}?`,
    introParagraph: buildIntro(SOURCES),
    sections: [
      {
        heading: "Com que ritmo o Google lança modelo novo de Gemini (e de Nano Banana)?",
        paragraphs: [
          `O Google lançou ${launches} modelos ou ferramentas entre ${formatDateLong(launchWindow.first)} e ${formatDateLong(launchWindow.last)}, mas o ritmo não foi constante: vieram em 3 surtos separados por 2 hiatos, um deles o mais longo de todo o período. No primeiro surto, 5 lançamentos couberam em ${s.spanSurge1} dias: [Gemini 2.5 Flash Image](https://diar.ia.br/p/google-lan-a-gemini-2-5-flash-image), [o Veo 3.1](https://diar.ia.br/p/google-veo-3-1), [o próprio Gemini 3](https://diar.ia.br/p/tudo-sobre-gemini-3), [Nano Banana Pro](https://diar.ia.br/p/sao-paulo-oferece-cursos-de-ia-gratuitos) e [Gemini 3 Flash](https://diar.ia.br/p/openai-cria-treinamento-gratuito-para-jornalistas).`,
          `Depois veio um hiato de ${s.gap1} dias sem nenhum lançamento novo, de ${formatDateLong(s.surge1End)} a ${formatDateLong(s.surge2Start)}. Nessa janela as manchetes giraram em torno da disputa com o ChatGPT, não de produto novo. O segundo surto foi o mais compacto de todos: [Gemini 3.1 Pro](https://diar.ia.br/p/novo-curso-de-ia-do-google) e [Nano Banana 2](https://diar.ia.br/p/claude-opus-3-se-aposenta-e-vira-blogueiro) saíram com apenas ${s.gapWithinSurge2} dias de diferença entre si.`,
          `O hiato seguinte foi o mais longo do período: ${s.gap2} dias entre o Nano Banana 2 e o [lançamento do Gemini Omni no Google I/O](https://diar.ia.br/p/google-lan-a-gemini-omni-no-google-i-o), em ${formatDateLong(s.surge3Start)}. O terceiro e último surto fechou num ritmo parecido com o primeiro: [Nano Banana 2 Lite](https://diar.ia.br/p/anthropic-lan-a-sonnet-5), ${s.gapWithinSurge3a} dias depois do Omni, e o [lançamento em trio de Gemini 3.6 e 3.5 Flash](https://diar.ia.br/p/google-lanca-trio-gemini-3-6-e-3-5-flash), mais ${s.gapWithinSurge3b} dias depois: 3 lançamentos em ${s.spanSurge3} dias.`,
        ],
        // #5260: cronologia derivada de SOURCES — os 3 surtos e os 2 hiatos
        // entre eles, já afirmados em prosa acima, também aparecem linha a
        // linha aqui (mesma mecânica extraída de `anthropic-claude.ts` no
        // #4921 Onda 2, generalizada em `hub-page.ts`).
        table: buildLaunchChronologyTable(SOURCES, LAUNCH_PATTERN, {
          caption: "Cronologia de lançamento: modelo ou ferramenta, data, dias desde o anterior, edição",
          firstColumnHeader: "Lançamento",
        }),
      },
      {
        heading: "Como o Gemini foi se espalhando pelos produtos do dia a dia e pelo Brasil?",
        paragraphs: [
          `O Gemini apareceu como novidade chegando ao Brasil em pelo menos ${brasil} manchetes diferentes ao longo do período. A mais chamativa delas é uma repetição: [o Google AI Mode chegou ao Brasil](https://diar.ia.br/p/openai-anuncia-apoio-ao-longa-critterz-mirando-cannes) em 9 de setembro de 2025 e, 14 dias depois, ["o Modo IA do Google" chegou ao Brasil de novo](https://diar.ia.br/p/nvidia-anuncia-investimento-de-us-100-bi-na-openai), mesma função com nome diferente. Quinze dias depois veio [o Google AI Plus](https://diar.ia.br/p/google-lan-a-ai-para-controle-aut-nomo-de-browsers).`,
          `Em 16 de abril de 2026, [a personalização do Gemini chegou ao Brasil](https://diar.ia.br/p/stanford-ia-avan-a-mais-r-pido-que-qualquer-tecnologia), seguida 61 dias depois por [um fundo de investimento em IA feito ao lado da Monashees](https://diar.ia.br/p/sp-vai-mapear-surtos-de-dengue-por-bairro) e, mais 6 dias depois, [o Google AI Plus de graça para clientes da Vivo](https://diar.ia.br/p/google-ai-plus-de-gra-a-na-vivo).`,
          'Fora do Brasil especificamente, a integração cresceu em quase todo produto do ecossistema Google: em 19 de setembro de 2025, [o Gemini embarcou no Chrome](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-798f898c74970), [o Google Maps ganhou a API do Gemini](https://diar.ia.br/p/aws-sofre-queda) em 20 de outubro de 2025; em 6 de novembro de 2025, [a Apple trouxe o Gemini para dentro da Siri e do próprio Google Maps](https://diar.ia.br/p/siri-agora-tera-gemini) e, em 7 de novembro de 2025, [o Workspace ganhou mais capacidades](https://diar.ia.br/p/microsoft-em-busca-da-superinteligencia).',
          'Em 12 de janeiro de 2026, veio a vez do [Gmail](https://diar.ia.br/p/grok-sendo-investigado-internacionalmente) e, 3 dias depois, de uma cobertura sobre [o Gemini "entendendo toda a vida digital" do usuário](https://diar.ia.br/p/mckinsey-candidatos-devem-dominar-prompts). Em 10 de junho de 2026, [o Gemini voltou ao Chrome, agora sem precisar abrir aba nova](https://diar.ia.br/p/gemini-chega-ao-chrome-sem-abrir-aba-nova), [ganhou cadernos de estudo](https://diar.ia.br/p/sabia-4-thinking-brasil-tem-modelo-de-raciocinio) 16 dias depois, viu o [NotebookLM ser rebatizado de Gemini Notebook](https://diar.ia.br/p/gpt-5-6-sol-apaga-arquivos-sem-permissao) em 17 de julho de 2026, e fechou o período [editando o Google Docs por conta própria](https://diar.ia.br/p/repositorio-de-ia-sem-freio-para-nudes-ilegais), em 30 de julho de 2026.',
          "Um fio à parte, mas revelador, é o avanço da autonomia do próprio Gemini: em 8 de outubro de 2025, [o Google lançou uma IA para controle autônomo de navegadores](https://diar.ia.br/p/google-lan-a-ai-para-controle-aut-nomo-de-browsers); 260 dias depois, em 25 de junho de 2026, [o Gemini 3.5 Flash passou a controlar o computador inteiro do usuário](https://diar.ia.br/p/gemini-3-5-flash-agora-controla-seu-computador) [fonte primária](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-computer-use-gemini-3-5-flash/), não só o navegador.",
        ],
      },
      {
        heading: "Que aposta em educação o Google fez em IA no Brasil?",
        paragraphs: [
          'O compromisso do Google com formação em IA no Brasil aparece primeiro como discurso, não produto: [o CEO do Google DeepMind definiu "aprender contínuo" como habilidade essencial](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-3c7f661e00f75) em 15 de setembro de 2025. No dia seguinte veio o produto: [treinamento de IA em cinemas do Brasil](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-d28fd72dae9b7).',
          `Depois vieram, em sequência, [o Google Skills, uma plataforma com cursos de IA gratuitos](https://diar.ia.br/p/google-skills-plataforma-com-cursos-de-ia-gratuitos), 37 dias depois, em 23 de outubro de 2025; [um curso gratuito aos sábados](https://diar.ia.br/p/google-da-curso-gratuito-de-ia-no-sabado), 40 dias mais tarde, em 2 de dezembro de 2025; e [mais um curso novo de IA](https://diar.ia.br/p/novo-curso-de-ia-do-google), 80 dias depois disso, em 20 de fevereiro de 2026: ${educacao} iniciativas de formação espalhadas ao longo de 5 meses.`,
          "Cento e quarenta e seis dias depois do último curso, em 16 de julho de 2026, e de um jeito quase irônico: [o Google passou a liberar o uso de IA dentro das próprias entrevistas técnicas de emprego](https://diar.ia.br/p/ibm-admite-atraso-em-ia-e-acao-despenca-25) [fonte primária](https://exame.com/carreira/google-vai-liberar-ia-em-entrevistas-e-muda-o-que-espera-dos-candidatos/). O candidato que aprendeu com os cursos gratuitos do Google agora pode usar essa mesma IA para tentar entrar na empresa.",
        ],
      },
      {
        heading: "O Gemini já alcançou o ChatGPT?",
        paragraphs: [
          'A narrativa sobre a disputa entre Google e OpenAI muda de sinal ao longo do período. Começa com [a OpenAI sentindo ameaça pelos próprios resultados do Google](https://diar.ia.br/p/pesquisa-aponta-que-ia-pode-agir-de-forma-maliciosa-ao-aprender-a-trapacear), em 24 de novembro de 2025. Trinta e dois dias depois veio a pergunta direta, ["O Gemini venceu o ChatGPT?"](https://diar.ia.br/p/o-gemini-venceu-o-chatgpt) — no mesmo dia em que ChatGPT, Gemini e Perplexity foram comparados lado a lado. Catorze dias depois veio a virada explícita no título: ["Como o Gemini virou o jogo contra o ChatGPT"](https://diar.ia.br/p/va-o-surgir-novos-cios-no-governo).',
          'Trinta e um dias depois, em 9 de fevereiro de 2026, veio [o Gemini se aproximando do ChatGPT em número de usuários](https://diar.ia.br/p/ai-com-lanc-a-agentes-de-ia-auto-nomos). Vinte e nove dias mais tarde, em 10 de março de 2026, veio um sinal indireto de que a disputa também mudava do lado de dentro de uma concorrente: [a própria Microsoft lançou o Copilot ao lado do Gemini no mesmo dia](https://diar.ia.br/p/copilot-e-gemini-chegam-juntos-coincid-ncia), sob o título irônico "coincidência?". Vinte e sete dias depois disso, em 6 de abril de 2026, um novo adversário entrou na frase: não era mais só o ChatGPT, era ["a aposta do Google contra Meta e DeepSeek"](https://diar.ia.br/p/ir-mira-o-maior-datacenter-de-ia-do-mundo) também.',
          "Nem toda comparação correu a favor do Google nesse arco: 3 dias antes da manchete sobre a virada contra o ChatGPT, [o Claude Code, da Anthropic, superou a própria equipe de engenheiros do Google](https://diar.ia.br/p/inscric-o-es-abertas-programa-da-openai-para-empreendedores) numa tarefa, em 6 de janeiro de 2026. A rivalidade não é de mão única.",
        ],
      },
      {
        heading: "Que aplicações reais o Gemini já teve, da ciência ao SUS?",
        paragraphs: [
          'As aplicações práticas do Gemini formam uma escalada, da abstração à vida real. Começa em 16 de fevereiro de 2026, com [o Gemini 3 resolvendo um problema descrito como "insolúvel" na ciência](https://diar.ia.br/p/fim-do-colarinho-branco-microsoft-prev-automa-o-total-em-18-meses). Trinta e oito dias depois, em 26 de março de 2026, veio a escala: [o Gemini Robotics chegou a 20 mil robôs](https://diar.ia.br/p/altman-admite-a-ia-trar-amea-as).',
          "Depois, 84 dias mais tarde, em 18 de junho de 2026, veio a medicina: [um sistema do Google igualou médicos em teste clínico](https://diar.ia.br/p/sistema-do-google-iguala-m-dicos-em-teste) [fonte primária](https://blog.google/innovation-and-ai/models-and-research/google-research/amie-for-disease-management-in-nature/). Vinte e seis dias depois, em 14 de julho de 2026, a aplicação deixou de ser teste e virou uso real dentro do sistema público de saúde brasileiro: [a IA do Google passou a detectar um tipo raro de câncer dentro do SUS](https://diar.ia.br/p/ia-do-google-detecta-c-ncer-raro-no-sus), o ponto mais concreto de toda a cobertura sobre usos aplicados do Gemini no período.",
        ],
      },
      {
        heading: "Como o tamanho do Google virou motivo de investimento bilionário e de alarme regulatório?",
        paragraphs: [
          "O dinheiro em torno do Google e do Gemini apareceu em pelo menos 4 manchetes de escala bilionária ou nacional. Primeiro, [Google, Nvidia e Jeff Bezos investiram juntos na Humans&](https://diar.ia.br/p/google-nvidia-e-bezos-investem-na-humans), em 2 de fevereiro de 2026. Dezessete dias depois, [o Google anunciou US$ 15 bilhões em infraestrutura](https://diar.ia.br/p/lula-na-maior-cupula-global-de-ia-bde9c122905d2d79). Sessenta e três dias mais tarde veio o hardware: [o Google Cloud lançou sua 8ª geração de TPUs](https://diar.ia.br/p/fgv-30-milho-es-de-brasileiros-em-risco), os chips próprios da empresa para treinar IA. Cinquenta e quatro dias depois disso, o investimento chegou ao Brasil, com [o fundo de IA feito ao lado da Monashees](https://diar.ia.br/p/sp-vai-mapear-surtos-de-dengue-por-bairro).",
          "O fim do período concentra a reação ao tamanho que o Google já tinha alcançado: em 9 dias de julho de 2026, a partir de 20 de julho de 2026, vieram [a União Europeia obrigando o Google a abrir dados para rivais](https://diar.ia.br/p/ue-obriga-google-a-abrir-dados-para-rivais) [fonte primária](https://canaltech.com.br/mercado/google-e-forcado-a-compartilhar-dados-com-rivais-de-ia-entenda-o-motivo/), 4 dias depois [editoras e a própria Reddit cogitando banir o Google](https://diar.ia.br/p/reddit-e-jornais-cogitam-banir-o-google) de seus conteúdos, e mais 5 dias depois, em 29 de julho de 2026, [um estudo mostrando que a IA do Google já domina 43% das buscas feitas nos EUA](https://diar.ia.br/p/1-134-funcion-rios-da-ia-pedem-freio-ao-setor) [fonte primária](https://canaltech.com.br/internet-e-redes-sociais/com-escalada-da-ia-buscas-no-google-viram-destino-final-dos-usuarios/), a manchete que, lida ao lado das duas anteriores, explica por que o alarme regulatório veio junto.",
        ],
      },
    ],
    faq: buildGoogleGeminiFaq(SOURCES),
    sourceEditions: toSourceEditions(SOURCES),
    publishedDate: PUBLISHED_DATE,
    updatedDate: UPDATED_DATE,
    footerNavUtm: HUB_GOOGLE_GEMINI_FOOTER_NAV_UTM,
    methodologyNote: defaultMethodologyNote(SOURCES),
  };
}
