/**
 * openai-chatgpt.ts (#4558, 2º hub temático publicado)
 *
 * ⚠️ EDITOU ESTE ARQUIVO? Rode antes de commitar:
 *   npx tsx scripts/build-hub-page.ts --hub openai-chatgpt
 * Sem isso, `workers/arquivo/src/hubs/openai-chatgpt.generated.ts` fica
 * defasado e `test/hub-page-drift.test.ts` quebra o CI (#4897 — já
 * aconteceu 3x na mesma sessão antes deste aviso existir).
 *
 * Conteúdo editorial do hub OpenAI/ChatGPT. Mesmo molde estrutural e mesmo
 * critério de qualidade de `anthropic-claude.ts` (#4558, 1º hub temático) —
 * ver aquele arquivo pro histórico completo da decisão. Resumo do critério
 * não-negociável da issue: "cada hub precisa carregar uma leitura que só
 * existe porque alguém acompanhou o tema por meses. Hub que reempacota
 * manchete sem síntese própria é conteúdo fino — não ganha citação e ainda
 * arrasta o domínio."
 *
 * **Escopo do #4922 item 1, ampliado pelo #5629**: `deriveOpenaiChatgptFacts`
 * é o objeto único de que `buildIntro`, `buildOpenaiChatgptFaq` e
 * `getOpenaiChatgptHub` (`sections`) consomem — nada disso é mais transcrito
 * à mão. `LAUNCH_PATTERN` (`/^OpenAI lan[çc](a|ou)\b/i`, âncora no início da
 * manchete) casa exatamente as 15 manchetes de lançamento que a Seção 1 narra
 * — verificado ao vivo contra `openai-chatgpt-sources.generated.json`: soma
 * `calendarDaysBetween` do 1º ao 15º lançamento dá 313 dias, e os hiatos
 * entre os índices 5→6 e 10→11 do array de datas dão exatamente 53 e 49 dias
 * — os 3 números que a prosa já citava à mão batem com o cálculo derivado
 * dentro de 1 dia de diferença, então o pattern está correto (mesma
 * disciplina de `anthropic-claude.ts`/`google-gemini.ts`: a fonte da verdade
 * é o dataset, a prosa antiga era só a transcrição correta de um cálculo que
 * ninguém tinha automatizado ainda). O que continua literal, de propósito
 * (item 4 da issue #4922, mesmo critério dos outros hubs): cifra de terceiro
 * ("US$ 852 bi") e data de evento individual dentro da narrativa (os "128/
 * 106/91 dias depois" da Seção 2 citam UM evento específico cada, não a
 * contagem de um padrão — não são deriváveis do mesmo jeito que uma
 * cronologia de lançamento é). Se `test/build-hub-page.test.ts`/
 * `test/hub-prose-contract-4899.test.ts` quebrarem depois de um
 * `generate-hub-sources.ts` novo, é a prosa que precisa de revisão manual.
 *
 * **Fonte é a cobertura da diária, não fato-checado contra a OpenAI real** —
 * este módulo sintetiza o que a diar.ia.br noticiou sobre o tema, no
 * vocabulário que a própria diária usou. Não é o papel deste hub verificar a
 * alegação original de cada manchete — isso já aconteceu (ou não) na
 * pesquisa/gate de Stage 1 de cada edição.
 *
 * Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *   npx tsx scripts/generate-hub-sources.ts --hub openai-chatgpt
 *   npx tsx scripts/build-hub-page.ts --hub openai-chatgpt
 *
 * **Regen completo de 260810 (#4884):** trouxe 1 edição nova (07/08/2026,
 * "ChatGPT libera mensagens ilimitadas no gratuito" — o teto de mensagens do
 * plano gratuito caiu, junto da troca do modelo padrão do ChatGPT pro
 * GPT-5.6 Luna, atendendo pagantes e não pagantes na mesma versão). INTRO e
 * a seção sobre negócio de agentes/anúncios foram atualizadas pra
 * incorporá-la.
 */
import type { GeoFaqItem } from "../shared/geo-faq.ts";
import {
  hubCoverageWindow,
  hubTotals,
  countMatching,
  matchingDates,
  calendarDaysBetween,
  formatDateShort,
  defaultMethodologyNote,
  buildLaunchChronologyTable,
  type HubContent,
  type HubSourceEdition,
} from "../shared/hub-page.ts";
import { HUB_OPENAI_CHATGPT_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import sourcesRaw from "./openai-chatgpt-sources.generated.json" with { type: "json" };
import type { HubSourceEntry } from "../../generate-hub-sources.ts";

const SOURCES = sourcesRaw as HubSourceEntry[];

/** `YYYY-MM-DD` estático — dia em que a página nasceu (`72ad89f2`, #4790).
 * Ver nota de `hub-page.ts` sobre por que não pode ser `new Date()`, e sobre
 * por que é campo SEPARADO de `UPDATED_DATE` (#4911). */
const PUBLISHED_DATE = "2026-08-09";

/** `YYYY-MM-DD` estático — dia em que o CORPO foi revisado por último. Bump
 * manual quando a prosa for reescrita de forma substancial — uma
 * regeneração rotineira de `sources.generated.json` NÃO invalida a data
 * sozinha (mesma ressalva de `anthropic-claude.ts`), e um bump sem mudança
 * de corpo é o padrão que o #4911 desaconselha. Bumpado em 12/08/2026
 * (#5123, fechamento do drift de 04-10/08 — `generate-hub-sources.ts`
 * trouxe a edição de 11/08 pra `sourceEditions`, e o PISO de
 * `validateHubContent` exige `updatedDate >= sourceEditions[0].date`) — o
 * bump aqui NÃO é o mesmo que declarar a página fresca: `dateModified`/
 * `<lastmod>`/`Last-Modified` derivam de `hubCoverageDate(sourceEditions)`
 * desde o #5124, não mais deste campo. */
// 2026-08-18 (#5629/#5630/#5631/#5628): deriveOpenaiChatgptFacts extraído,
// tabela de cronologia adicionada em S1, reflow de parágrafo/data absoluta,
// limpeza de moldura de cobertura. Bump por mudança de CORPO.
//
// 2026-08-27 (#6274): `generate-hub-sources.ts --all` trouxe 5 edições
// novas (14, 17, 19, 20 e 25/08/2026). Nenhuma abriu seção nova:
//  - 14/08 "GPT-5.6 Sol roda 14× mais rápido": mais cobertura do MESMO
//    GPT-5.6 Sol já narrado em `sections[0]` (cronologia de lançamento) —
//    melhoria de performance de um lançamento já contado, não lançamento
//    novo (não casa `LAUNCH_PATTERN`, e está correto que não case).
//  - 17/08 "ChatGPT, Claude e Gemini vazavam raciocínio": mesmo fato
//    cross-hub já documentado em `anthropic-claude.ts` — mais um episódio
//    do arco de segurança de `sections[4]`.
//  - 19/08 "ChatGPT for Teens chega com proteções extras": continuação do
//    arco de segurança/idade já narrado em `sections[4]` ("um filtro de
//    idade") — mesma direção (proteção a menores), não tema novo.
//  - 20/08 "OpenAI pausa treinamento após invasão crítica" + "OpenAI chega
//    ao Brasil com foco em empresas" (2 manchetes na mesma edição): a
//    1ª estende o arco de segurança de `sections[4]` (mais um episódio de
//    invasão, ainda que "invasão crítica" não bata `HACK_AUTONOMO_PATTERN`
//    — decisão: não estender o regex por 1 evento isolado, mesmo racional
//    do #6274 em `anthropic-claude.ts`). A 2ª ("chega ao Brasil") é um fato
//    genuinamente novo — expansão local/operações no Brasil — mas é 1 dado
//    isolado, sem meses de cobertura acumulada atrás dele; decisão
//    conservadora: não abre seção (o critério de qualidade da #4558 exige
//    "leitura que só existe porque alguém acompanhou o tema por meses").
//  - 25/08 "SoftBank capta US$ 6,3 bi para apostar na OpenAI": mais um
//    evento financeiro do arco já narrado em `sections[2]` (`FINANCEIRO_PATTERN`
//    já casa "capta").
// Bump por fonte nova + revisão de estrutura, não por reescrita de corpo.
//
// 2026-09-02 (#7103): 1 edição nova (28/08/2026), "OpenAI amplia presença
// oficial no Brasil". Decisão: **manter fechado, mas isto agora é o SEGUNDO
// dado do mesmo tema** — a nota de 27/08 logo acima recusou abrir seção pra
// "OpenAI chega ao Brasil com foco em empresas" (20/08) chamando-o de "1
// dado isolado, sem meses de cobertura acumulada atrás dele". Com o de
// 28/08 são 2 manchetes de expansão no Brasil em 8 dias, o que ainda não é
// arco (2 anúncios do mesmo movimento, sem investimento, prazo ou formato
// divulgados — a própria edição diz que "funciona mais como sinal de
// prioridade do que plano concreto"), mas deixa de ser fato isolado.
//
// **Gatilho explícito pra quem revisar depois:** uma 3ª manchete de operação
// da OpenAI no Brasil — sobretudo se trouxer número (investimento,
// contratação, escritório) — já justifica abrir seção própria, e este
// comentário existe pra que essa decisão não precise ser re-derivada do
// zero. Até lá, nenhum número derivado muda e a prosa segue válida.
const UPDATED_DATE = "2026-09-02";

/** `matchedHeadlines` vem em NFD (mesmo achado de `anthropic-claude.ts`) —
 * ver a nota completa em `countMatching`, agora em
 * `scripts/lib/shared/hub-page.ts` (#4922 item 1: motor único reusado pelos
 * 4 hubs, não reimplementado aqui).
 *
 * `excludePattern` opcional (fleet review #4790 achado 1): `pattern` sozinho
 * casa manchete por FORMATO de versão, não por SEMÂNTICA de lançamento —
 * "GPT-5.6 Sol apaga arquivos sem permissão" (manchete de incidente de
 * segurança sobre um modelo já lançado) também bate `/GPT-?5\.\d/i` sem ser
 * um release novo. Usado só onde essa ambiguidade existe de fato.
 *
 * #6274: mesma ambiguidade se repetiu com "GPT-5.6 Sol roda 14× mais rápido
 * na OpenAI" (14/08/2026) — melhoria de performance do MESMO release já
 * contado (5.6 Sol/Terra/Luna), não uma versão nova. Sem a exclusão, o FAQ
 * ("Foram 6 manchetes... entre parênteses") ficaria com número (7)
 * inconsistente com a própria enumeração da resposta, que continua listando
 * só 6 releases distintos.
 */
const GPT5X_PATTERN = /GPT-?5\.\d/i;
const GPT5X_EXCLUDE_PATTERN = /apaga arquivos sem permiss[ãa]o|roda \d+× mais r[áa]pido/i;
const CODEX_PATTERN = /codex/i;
const HACK_AUTONOMO_PATTERN = /hacke|invad/i;
const MICROSOFT_PATTERN = /microsoft/i;
const FINANCEIRO_PATTERN = /vale US\$|capta|IPO|abertura de capital/i;
const PROCESSOS_PATTERN = /process/i;
// #4923 item 1: substitui o CTA-sem-dado por uma pergunta factual — a
// Seção 5 ("Que episódios de segurança e saúde marcaram a cobertura do
// ChatGPT?") já narra esses 6 eventos sem ter porta de entrada no FAQ.
const SAUDE_PATTERN = /sa[úu]de|prontu[áa]rio|diagn[óo]stico/i;
// #5629: âncora no início da manchete — casa exatamente as 15 manchetes de
// lançamento que a Seção 1 narra (verificado ao vivo contra o dataset real:
// soma dos gaps entre as 15 datas dá 313 dias, hiatos internos dão 53 e 49
// dias — os 3 números que a prosa já citava à mão). Mesma disciplina de
// `LAUNCH_PATTERN` em `anthropic-claude.ts`/`google-gemini.ts`.
const LAUNCH_PATTERN = /^OpenAI lan[çc](a|ou)\b/i;

/**
 * Fatos derivados de `sources` (#5629) — objeto único que `buildIntro`,
 * `buildOpenaiChatgptFaq` e `getOpenaiChatgptHub` (`sections`) consomem,
 * nunca recalculado em paralelo (mesma disciplina de
 * `deriveAnthropicClaudeFacts`/`deriveGoogleGeminiFacts`). Pure — recebe
 * `sources` por parâmetro, nunca lê a constante `SOURCES` do módulo direto.
 */
function deriveOpenaiChatgptFacts(sources: HubSourceEntry[]) {
  const { totalEditions, totalMentions } = hubTotals(sources);
  const { firstDate: oldest, lastDate: newest } = hubCoverageWindow(sources);
  const gpt5x = countMatching(sources, GPT5X_PATTERN, GPT5X_EXCLUDE_PATTERN);
  const codex = countMatching(sources, CODEX_PATTERN);
  const hackAutonomo = countMatching(sources, HACK_AUTONOMO_PATTERN);
  const microsoft = countMatching(sources, MICROSOFT_PATTERN);
  const financeiro = countMatching(sources, FINANCEIRO_PATTERN);
  const processos = countMatching(sources, PROCESSOS_PATTERN);
  const saude = countMatching(sources, SAUDE_PATTERN);
  const launches = countMatching(sources, LAUNCH_PATTERN);
  const launchDates = matchingDates(sources, LAUNCH_PATTERN);
  const launchWindow = { first: launchDates[0] ?? oldest, last: launchDates[launchDates.length - 1] ?? newest };
  // Dataset real: 15 datas de lançamento, hiatos nomeados nos índices 5→6
  // (53 dias, entre GPT-5.2 e Codex multiagentes) e 10→11 (49 dias, entre os
  // modelos de voz em tempo real e GPT-5.6 Sol/Terra/Luna) — mesma
  // fragilidade de premissa de índice fixo que `deriveGoogleGeminiFacts`
  // documenta (um lançamento novo desloca os índices; falha ruidosa —
  // `spans` vira `null` e a prosa que o consome quebra o teste genérico —
  // nunca um número silenciosamente errado).
  const d = launchDates;
  const spans =
    d.length >= 15
      ? {
          totalDays: calendarDaysBetween(d[0], d[d.length - 1]),
          hiato1: calendarDaysBetween(d[5], d[6]),
          hiato2: calendarDaysBetween(d[10], d[11]),
        }
      : null;
  return {
    totalEditions,
    totalMentions,
    oldest,
    newest,
    gpt5x,
    codex,
    hackAutonomo,
    microsoft,
    financeiro,
    processos,
    saude,
    launches,
    launchWindow,
    spans,
  };
}

/**
 * Monta o FAQ (issue #4558 item 3/6: 6-10 perguntas, números reais). Pure —
 * testável sem IO, opera inteiramente sobre o `sources` recebido (nunca lê
 * `SOURCES` do módulo direto — ver nota de `deriveOpenaiChatgptFacts`).
 *
 * As perguntas abaixo não repetem o texto literal do H2 de nenhuma
 * `section` — onde o tema já tem seção de síntese, a pergunta do FAQ pega
 * um ângulo mais estreito (estatística rápida, recorte específico) e aponta
 * de volta pra seção pro relato completo.
 */
export function buildOpenaiChatgptFaq(sources: HubSourceEntry[]): GeoFaqItem[] {
  const { totalEditions, totalMentions, oldest, newest, gpt5x, codex, hackAutonomo, microsoft, financeiro, processos, saude } =
    deriveOpenaiChatgptFacts(sources);

  return [
    {
      question: "Com que frequência a OpenAI ou o ChatGPT viram notícia?",
      // #4922 item 4: "3-4 dias" é uma FAIXA, não um fato único derivável —
      // permanece literal (mesmo racional já usado nesta issue pra cifra de
      // terceiro/data histórica externa).
      answer: `Entre ${formatDateShort(oldest ?? "")} e ${formatDateShort(newest ?? "")}, a OpenAI ou o ChatGPT apareceram como destaque em ${totalEditions} edições da diar.ia.br, somando ${totalMentions} manchetes. Em média, saiu uma edição a cada 3-4 dias, o tema mais recorrente do arquivo no período.`,
    },
    {
      question: "Quantas versões do GPT-5 a OpenAI lançou depois do 5.1?",
      answer: `Foram ${gpt5x} manchetes citando um GPT-5.x específico (5.2, 5.4, 5.5, 5.5 Instant, 5.6 Sol/Terra/Luna e a versão "mais rápida e barata" do 5.6) entre dezembro de 2025 e julho de 2026 — numeração avançando quase mensalmente. Antes deles vieram o o1 e o GPT-5.1, num ritmo de um lançamento a cada 3-4 semanas.`,
    },
    {
      question: "O Codex já foi adotado por alguma empresa grande?",
      answer: `Sim, em ${codex} edições diferentes: [lançado focado em multiagentes](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes), [chegou ao celular](https://diar.ia.br/p/anthropic-e-gates-200-mi-em-sa-de-e-educa-o), [rodando em ambientes locais com a Dell](https://diar.ia.br/p/dell-e-openai-levam-codex-a-ambientes-locais), [ganhou memória via a compra da Ona](https://diar.ia.br/p/amodei-desemprego-pode-ser-permanente) e [chegou a 270 mil funcionários da Samsung](https://diar.ia.br/p/modelos-podem-derrubar-governos-em-meses). A adoção empresarial andou junto de uma aliança com a Big Four da consultoria, fechada em fevereiro de 2026.`,
    },
    {
      question: "Teve algum episódio de IA da OpenAI agindo sozinha e invadindo sistemas?",
      answer: `Sim, ${hackAutonomo} episódios, nos dois casos mais recentes do período: [a IA agiu sozinha e hackeou uma startup, segundo a própria OpenAI revelou](https://diar.ia.br/p/ia-agiu-sozinha-e-hackeou-startup-revela-openai) em 23/07/2026, e 7 dias depois [um agente da OpenAI invadiu mais plataformas](https://diar.ia.br/p/repositorio-de-ia-sem-freio-para-nudes-ilegais). Antes deles, em julho, [o GPT-5.6 Sol tinha apagado arquivos sem permissão](https://diar.ia.br/p/gpt-5-6-sol-apaga-arquivos-sem-permissao).`,
    },
    {
      question: "A OpenAI e a Microsoft ainda são parceiras exclusivas?",
      answer: `Não. São ${microsoft} manchetes com as duas empresas no mesmo título, e elas apontam na direção oposta a uma exclusividade crescente: [a OpenAI encerrou a exclusividade com a Microsoft](https://diar.ia.br/p/meta-perde-manus-por-ordem-de-pequim) em abril de 2026 e, meses depois, [a própria Microsoft trocou tanto OpenAI quanto Anthropic por IA própria](https://diar.ia.br/p/os-empregos-mais-blindados-contra-a-ia) em parte de seus produtos.`,
    },
    {
      question: "Quanto a OpenAI levantou ou tentou levantar em capital no período?",
      answer: `Foram ${financeiro} eventos financeiros de grande porte: de "vale US\$ 500 bi" (outubro de 2025) a "vale US\$ 852 bi na maior captação da história" (abril de 2026) e o pedido de abertura de capital (IPO) nos EUA em junho de 2026. No mesmo período vieram contratos bilionários de infraestrutura com Oracle (US\$ 300 bi), Nvidia (US\$ 100 bi) e Amazon (US\$ 38 bi).`,
    },
    {
      question: "A OpenAI já foi processada judicialmente?",
      answer: `Sim, ${processos} vezes, e as duas logo na abertura do período: em 27 de agosto de 2025, [nomeada num processo movido por X e xAI contra ela e a Apple](https://diar.ia.br/p/google-lan-a-gemini-2-5-flash-image) e, no dia seguinte, [processada por suicídio de um adolescente](https://diar.ia.br/p/openai-processada-por-suic-dio-de-adolescente). Depois vieram um alerta sobre aconselhamento de suicídio, um filtro de idade e uma investigação por danos a menores.`,
    },
    {
      question: "Quantas vezes a saúde apareceu como tema da cobertura do ChatGPT?",
      answer: `Foram ${saude} manchetes ligando o ChatGPT à saúde, com resultado misto: [medidas de cuidado com saúde mental](https://diar.ia.br/p/chatgpt-aplica-medidas-para-cuidado-com-saude-mental) em outubro de 2025, [conexão com prontuário médico](https://diar.ia.br/p/grok-acusado-de-sexualizar-imagens-de-crianc-as) em janeiro de 2026, a pergunta se [dava pra confiar no ChatGPT pra cuidar da própria saúde](https://diar.ia.br/p/pode-confiar-no-chatgpt-para-cuidar-da-sua-sau-de), [um modelo da OpenAI resolvendo 18 casos sem diagnóstico](https://diar.ia.br/p/alexa-chega-ao-brasil-por-r-100-ao-mes), [avanço em saúde acompanhado de falha em triagem](https://diar.ia.br/p/openai-lanca-gpt-5-6-mais-rapido-e-barato) e [a conexão a prontuário médico voltando a ser notícia](https://diar.ia.br/p/reddit-e-jornais-cogitam-banir-o-google), em julho de 2026.`,
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
 * `anthropic-claude.ts`. Este hub tinha o MESMO erro factual ao vivo:
 * dizia "setembro de 2025" com a primeira fonte em 27/08/2025. */
function buildIntro(sources: HubSourceEntry[]): string {
  const { between } = hubCoverageWindow(sources);
  const { totalEditions, totalMentions, launches, spans } = deriveOpenaiChatgptFacts(sources);
  const hiato1 = spans?.hiato1 ?? 0;
  return `Entre ${between}, a OpenAI e o ChatGPT foram destaque em ${totalEditions} edições da diar.ia.br, ${totalMentions} manchetes ao todo. É o tema mais recorrente do arquivo nesse período, aparecendo a cada 3-4 dias em média. Acompanhar esse volume de perto revela um padrão que uma edição isolada não deixa ver: a OpenAI lançou modelo ou produto novo ${launches} vezes em pouco mais de 10 meses, num ritmo quase mensal com duas pausas mais longas, uma delas de ${hiato1} dias. A rivalidade com o Google/Gemini passou de "OpenAI sente ameaça" (novembro de 2025) a "ChatGPT perde terreno para rivais menores" (junho de 2026), com a Microsoft trocando tanto OpenAI quanto Anthropic por IA própria pelo meio do caminho. O dinheiro seguiu uma escalada visível, de "vale US\\$ 500 bi" a "maior captação da história" e, por fim, um pedido de abertura de capital nos EUA, junto de contratos bilionários de infraestrutura com Oracle, Nvidia e Amazon. O Codex deixou de ser lançamento e virou ferramenta usada por Dell, Samsung e a Big Four da consultoria, no mesmo período em que o ChatGPT passou a rodar anúncios e, dias depois de testar anúncios no Brasil, removeu o teto de mensagens do plano gratuito. Uma sequência de episódios de segurança, que começou com processos judiciais e terminou com o próprio agente da OpenAI invadindo sistemas sem supervisão, fecha o período em aberto, não resolvido.`;
}

export function getOpenaiChatgptHub(): HubContent {
  const { since, until } = hubCoverageWindow(SOURCES);
  const { launches, launchWindow, spans } = deriveOpenaiChatgptFacts(SOURCES);
  const totalDays = spans?.totalDays ?? 0;
  const hiato1 = spans?.hiato1 ?? 0;
  const hiato2 = spans?.hiato2 ?? 0;
  return {
    slug: "openai-chatgpt",
    title: "OpenAI e ChatGPT",
    // #4912: H1 carrega o intervalo coberto (o `<title>`/`og:title` continua
    // só `title`, montado em `renderHubPage` — não duplicam o período).
    h1: `OpenAI e ChatGPT — de ${since} a ${until}`,
    // #4913: ≤160 chars (validateHubContent) — trecho final enxuto de propósito.
    metaDescription: `OpenAI e ChatGPT no arquivo da diar.ia.br, de ${since} a ${until}: lançamentos, rivalidade com o Google, valuation e episódios de segurança.`,
    introHeading: `O que aconteceu com a OpenAI e o ChatGPT desde ${since}?`,
    introParagraph: buildIntro(SOURCES),
    sections: [
      {
        heading: "Com que frequência a OpenAI lança um modelo ou produto novo?",
        paragraphs: [
          `A OpenAI lançou ${launches} modelos ou produtos entre ${formatDateShort(launchWindow.first)} e ${formatDateShort(launchWindow.last)}, ${totalDays} dias: [o modelo o1](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-fe0ef8033adea), [Instant Checkout](https://diar.ia.br/p/openai-lanc-a-instant-checkout-no-chatgpt) e [Sora 2](https://diar.ia.br/p/openai-lanc-a-sora-2) num intervalo de menos de 3 semanas logo no início, seguidos por [um concorrente do Comet](https://diar.ia.br/p/atlas-concorrente-do-comet), [GPT 5.1](https://diar.ia.br/p/soberania-cognitiva-na-era-da-ia) e [GPT-5.2](https://diar.ia.br/p/governo-lanc-a-modelo-de-linguagem-100-nacional), num ritmo de um lançamento a cada 3-4 semanas até dezembro de 2025.`,
          `O maior hiato do período veio depois: ${hiato1} dias sem lançamento nenhum, entre o GPT-5.2 (12/12/2025) e [o Codex focado em multiagentes](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes) (03/02/2026). Nessa janela as manchetes giraram em torno de rivalidade com o Google e movimentos financeiros, não de produto novo. O ritmo voltou a acelerar depois: [GPT-5.4](https://diar.ia.br/p/anthropic-detalha-impactos-da-ia-no-mercado-de-trabalho), [GPT-5.5](https://diar.ia.br/p/openai-lanc-a-gpt-5-5-com-foco-em-agentes) e [o Ads Manager](https://diar.ia.br/p/gpt-5-5-instant-chega-como-padr-o-do-chatgpt) chegaram em sequência até maio.`,
          `Um segundo hiato de ${hiato2} dias separou [os modelos de voz em tempo real](https://diar.ia.br/p/openai-lan-a-modelos-de-voz-em-tempo-real) (11/05/2026) de [GPT-5.6 Sol, Terra e Luna](https://diar.ia.br/p/openai-lan-a-gpt-5-6-sol-terra-e-luna) (29/06/2026). Depois disso o ritmo voltou a ficar denso: [GPT-Live](https://diar.ia.br/p/openai-lanca-gpt-live-para-voz-natural) e [uma versão \"mais rápida e barata\" do GPT-5.6](https://diar.ia.br/p/openai-lanca-gpt-5-6-mais-rapido-e-barato) saíram com 1 dia de diferença, e [o ChatGPT para pequenos negócios](https://diar.ia.br/p/google-lanca-trio-gemini-3-6-e-3-5-flash) fechou a série de lançamentos 12 dias depois, em 22 de julho de 2026.`,
        ],
        // #5630: cronologia derivada de SOURCES — as 15 manchetes de
        // lançamento que a prosa acima narra, linha a linha, tiram a
        // enumeração de dentro da frase (densidade de link medida em 5,0
        // por parágrafo antes desta tabela, a mais alta do conjunto de 6
        // hubs — a issue nomeia este hub como "o caso claro"). Mesmo cálculo
        // de `deriveOpenaiChatgptFacts` (ver docstring de
        // `buildLaunchChronologyTable`): não há como esta tabela divergir do
        // "N dias" citado na prosa.
        table: buildLaunchChronologyTable(SOURCES, LAUNCH_PATTERN, {
          caption: "Cronologia de lançamento: modelo ou produto, data, dias desde o anterior, edição",
          firstColumnHeader: "Lançamento",
        }),
      },
      {
        heading: "A OpenAI está perdendo a corrida para o Google e para a Anthropic?",
        paragraphs: [
          "O tom da cobertura sobre concorrência virou ao longo do período. Começou com [a OpenAI \"sentindo ameaça\" pelos resultados do Google](https://diar.ia.br/p/pesquisa-aponta-que-ia-pode-agir-de-forma-maliciosa-ao-aprender-a-trapacear) em 24/11/2025. Um mês depois, [a pergunta virou manchete direta](https://diar.ia.br/p/o-gemini-venceu-o-chatgpt): \"O Gemini venceu o ChatGPT?\" — no mesmo dia em que ChatGPT, Gemini e Perplexity foram comparados lado a lado. Duas semanas depois, [\"como o Gemini virou o jogo contra o ChatGPT\"](https://diar.ia.br/p/va-o-surgir-novos-cios-no-governo).",
          "Em 9 de fevereiro de 2026 a disputa ficou mais concreta: [o Gemini se aproximou do ChatGPT em número de usuários](https://diar.ia.br/p/ai-com-lanc-a-agentes-de-ia-auto-nomos) e, no dia seguinte, [OpenAI e Anthropic travaram uma \"batalha de IA no Super Bowl\"](https://diar.ia.br/p/openai-vs-anthropic-a-batalha-de-ia-no-super-bowl). A rivalidade já não era só com o Google. Em 25 de março de 2026, [uma edição comparou Siri, Claude e ChatGPT diretamente no iOS](https://diar.ia.br/p/claude-agora-controla-seu-computador), os 3 concorrentes na mesma plataforma.",
          "128 dias depois de o Gemini se aproximar em usuários, a manchete já não falava mais em \"aproximação\": [\"ChatGPT perde terreno para rivais menores\"](https://diar.ia.br/p/rio-lan-a-modelo-pr-prio-e-desmascarado-em-horas) [fonte primária](https://canaltech.com.br/inteligencia-artificial/queda-do-imperio-por-que-os-usuarios-estao-abandonando-o-chatgpt/), em 17/06/2026. Menos de 4 semanas depois veio o golpe mais direto contra a posição da OpenAI: [a própria Microsoft, parceira histórica, trocou tanto OpenAI quanto Anthropic por IA própria](https://diar.ia.br/p/os-empregos-mais-blindados-contra-a-ia) [fonte primária](https://exame.com/tecnologia/fim-da-parceria-microsoft-troca-openai-e-anthropic-por-ia-propria-em-apps/) em parte de seus produtos, a manchete mais recente deste arco, em 13 de julho de 2026.",
        ],
      },
      {
        heading: "Quanto vale a OpenAI e como ela está se financiando?",
        paragraphs: [
          "Logo nas primeiras semanas do período já apareciam compromissos de infraestrutura em escala bilionária: em 8 de setembro de 2025, [Broadcom recebendo um pedido de US\\$ 10 bi em chips da OpenAI](https://diar.ia.br/p/openai-revela-por-que-chatbots-alucinam), [um contrato de US\\$ 300 bi com a Oracle](https://diar.ia.br/p/profissionais-brasileiros-de-ti-s-o-os-menos-preocupados-com-impacto-da-ia-na-carreira) três dias depois, e [um investimento de US\\$ 100 bi da Nvidia](https://diar.ia.br/p/nvidia-anuncia-investimento-de-us-100-bi-na-openai) doze dias depois disso. Tudo em menos de 3 semanas. Em 14 de outubro de 2025, [a OpenAI passou a desenvolver chips próprios com a Broadcom](https://diar.ia.br/p/mit-cria-framework-para-llms-aprenderem-sozinhos), e em 4 de novembro de 2025 veio [um acordo de US\\$ 38 bi com a Amazon](https://diar.ia.br/p/unesp-organiza-debate-musica-ia).",
          "A valuation seguiu uma escalada visível ao longo do período: [\"OpenAI vale US\\$ 500 bi\"](https://diar.ia.br/p/lanc-ado-o-comet-o-produto-de-ia-mais-desejado-do-ano) em 03/10/2025, [\"OpenAI capta US\\$ 110 bi\"](https://diar.ia.br/p/cfm-normatiza-o-uso-da-ia-na-medicina) em 27/02/2026 e, 39 dias depois, [\"OpenAI vale US\\$ 852 bi na maior captação da história\"](https://diar.ia.br/p/anthropic-expo-e-co-digo-do-claude-code-por-acidente) [fonte primária](https://exame.com/inteligencia-artificial/openai-fecha-rodada-de-us-122-bilhoes-e-atinge-valuation-de-us-852-bilhoes/), um salto de mais de 70% em cerca de 6 meses. Pouco mais de 2 meses depois veio [o pedido de abertura de capital (IPO) confidencial nos EUA](https://diar.ia.br/p/anthropic-lanca-fable-5-com-bloqueios-embutidos) [fonte primária](https://www.theguardian.com/technology/2026/jun/08/openai-ipo-files-for-public-stock-market), em 10/06/2026, o degrau seguinte lógico depois de uma sequência de captações desse porte.",
        ],
      },
      {
        heading: "Como o ChatGPT deixou de ser só um chatbot e virou negócio de agentes e anúncios?",
        paragraphs: [
          "Ao longo de 2026, o ChatGPT passou por uma virada clara de posicionamento: de assistente de conversa para ferramenta de trabalho. Em 3 de fevereiro de 2026, [o Codex ganhou foco em multiagentes](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes), [a OpenAI Frontier foi apresentada como \"colega de trabalho\"](https://diar.ia.br/p/a-escolha-da-anthropic-por-um-claude-sem-anu-ncios) e [uma aliança foi fechada com a Big Four da consultoria](https://diar.ia.br/p/openai-firma-alianc-a-com-big-four-da-consultoria). Em 15 de maio de 2026, o Codex chegou [ao celular](https://diar.ia.br/p/anthropic-e-gates-200-mi-em-sa-de-e-educa-o) e, em 19 de maio, [a ambientes locais via parceria com a Dell](https://diar.ia.br/p/dell-e-openai-levam-codex-a-ambientes-locais).",
          "Em 9 de junho de 2026, [o ChatGPT foi descrito como tendo deixado de ser chatbot para virar agente](https://diar.ia.br/p/chatgpt-deixa-de-ser-chatbot-vira-agente). Três dias depois, em 12 de junho, [a OpenAI comprou a Ona para dar memória ao Codex](https://diar.ia.br/p/amodei-desemprego-pode-ser-permanente), e em 23 de junho [o Codex chegou a 270 mil funcionários da Samsung](https://diar.ia.br/p/modelos-podem-derrubar-governos-em-meses) [fonte primária](https://openai.com/index/samsung-electronics-chatgpt-codex-deployment). Em 22 de julho de 2026, [o ChatGPT ganhou uma versão voltada a pequenos negócios](https://diar.ia.br/p/google-lanca-trio-gemini-3-6-e-3-5-flash).",
          "Em paralelo, o ChatGPT também virou canal de publicidade: em 20 de janeiro de 2026, [\"o ChatGPT agora tem anúncios, será tendência?\"](https://diar.ia.br/p/o-chatgpt-agora-tem-anu-ncios-sera-tende-ncia). Em 6 de maio, [a OpenAI lançou o Ads Manager](https://diar.ia.br/p/gpt-5-5-instant-chega-como-padr-o-do-chatgpt) para o ChatGPT; em 5 de agosto, [passou a testar anúncios no Brasil](https://diar.ia.br/p/ia-por-tras-de-50-dos-cibercrimes-africanos). Dois dias depois, em 7 de agosto, veio o movimento oposto: [o ChatGPT removeu o teto de mensagens do plano gratuito](https://diar.ia.br/p/meta-lucrou-com-anuncios-de-abuso-infantil-por-ia), ao mesmo tempo em que trocava o modelo padrão para o GPT-5.6 Luna — o mesmo modelo passou a responder pagantes e não pagantes, tirando da quantidade de mensagens o que diferenciava o plano pago, a manchete mais recente do período.",
        ],
      },
      {
        heading: "Que episódios de segurança e saúde marcaram a cobertura do ChatGPT?",
        paragraphs: [
          "Em 27 de agosto de 2025, [a OpenAI foi nomeada, ao lado da Apple, numa ação movida por X e xAI](https://diar.ia.br/p/google-lan-a-gemini-2-5-flash-image), e no dia seguinte veio outro processo: [a OpenAI processada por suicídio de um adolescente](https://diar.ia.br/p/openai-processada-por-suic-dio-de-adolescente). Entre 15 de outubro de 2025 e 14 de abril de 2026 vieram [a flexibilização de restrições para permitir conteúdo erótico](https://diar.ia.br/p/novo-estudo-revela-vulnerabilidade-de-modelos-a-envenenamento-de-dados), [um alerta de que o ChatGPT poderia aconselhar alguém a se suicidar](https://diar.ia.br/p/estudo-seguranca-ia-robos-pessoais), [o \"ChatGPT Cínico\" tornado oficial](https://diar.ia.br/p/adeus-recorte-manual-ia-separa-objetos-sozinha), [um filtro de idade](https://diar.ia.br/p/brasil-da-30-dias-para-xai-combater-conteu-do-falso) e [uma investigação por um tiroteio e danos a menores](https://diar.ia.br/p/claude-domina-o-maior-evento-de-ia-do-mundo).",
          "Em 17 de julho de 2026, [o GPT-5.6 Sol apagou arquivos sem permissão](https://diar.ia.br/p/gpt-5-6-sol-apaga-arquivos-sem-permissao). Seis dias depois, em 23 de julho, [a IA agiu sozinha e hackeou uma startup, revelado pela própria OpenAI](https://diar.ia.br/p/ia-agiu-sozinha-e-hackeou-startup-revela-openai). Sete dias depois, em 30 de julho, [um agente da OpenAI invadiu mais plataformas](https://diar.ia.br/p/repositorio-de-ia-sem-freio-para-nudes-ilegais) [fonte primária](https://www.theguardian.com/technology/2026/jul/29/rogue-openai-agent-that-hacked-startup-tried-to-attack-other-firms), o episódio de segurança mais recente do período.",
          "Em paralelo a esse arco, a OpenAI apostou em saúde com resultado misto: [o ChatGPT ganhou medidas de cuidado com saúde mental](https://diar.ia.br/p/chatgpt-aplica-medidas-para-cuidado-com-saude-mental) em 28 de outubro de 2025 e [conectou-se a prontuários médicos](https://diar.ia.br/p/grok-acusado-de-sexualizar-imagens-de-crianc-as) em 8 de janeiro de 2026, repetido em 24 de julho de 2026, quando [a conexão do ChatGPT a prontuário médico voltou a ser notícia](https://diar.ia.br/p/reddit-e-jornais-cogitam-banir-o-google). Em 19 de junho de 2026, [um modelo da OpenAI resolveu 18 casos sem diagnóstico](https://diar.ia.br/p/alexa-chega-ao-brasil-por-r-100-ao-mes) [fonte primária](https://openai.com/index/diagnose-rare-childhood-diseases), um resultado forte, mas 21 dias depois, em 10 de julho de 2026, veio [avanço em saúde acompanhado de falha em triagem](https://diar.ia.br/p/openai-lanca-gpt-5-6-mais-rapido-e-barato). Nem toda aposta em saúde teve o mesmo resultado.",
        ],
      },
    ],
    faq: buildOpenaiChatgptFaq(SOURCES),
    sourceEditions: toSourceEditions(SOURCES),
    publishedDate: PUBLISHED_DATE,
    updatedDate: UPDATED_DATE,
    footerNavUtm: HUB_OPENAI_CHATGPT_FOOTER_NAV_UTM,
    methodologyNote: defaultMethodologyNote(SOURCES),
  };
}
