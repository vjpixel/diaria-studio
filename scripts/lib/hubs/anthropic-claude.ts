/**
 * anthropic-claude.ts (#4558 Parte A)
 *
 * ⚠️ EDITOU ESTE ARQUIVO? Rode antes de commitar:
 *   npx tsx scripts/build-hub-page.ts --hub anthropic-claude
 * Sem isso, `workers/arquivo/src/hubs/anthropic-claude.generated.ts` fica
 * defasado e `test/hub-page-drift.test.ts` quebra o CI (#4897 — já
 * aconteceu 3x na mesma sessão antes deste aviso existir).
 *
 * Conteúdo editorial do 1º hub temático — Anthropic/Claude. Decisão do
 * editor (260804): hubs de empresa e hubs temáticos coexistem, mas só este
 * entra nesta rodada; os demais candidatos da proposta (artefato da sessão)
 * ficam pra depois.
 *
 * **Critério de qualidade da issue #4558 (não-negociável):** as seções
 * abaixo conectam pontos ao longo de ~11 meses de cobertura (o que só é
 * possível olhando o ARQUIVO inteiro, não uma edição isolada) — não
 * reempacotam manchete.
 *
 * **Escopo do #4922 item 1 (substitui a nota anterior, que ficou
 * desatualizada por número transcrito à mão — achado da própria issue):**
 * total de edições/manchetes, a janela de cobertura, a cadência, o hiato de
 * lançamento e a contagem de cada padrão (`launches`/`mythos`/`fable`/
 * `seguranca`) agora são um ÚNICO objeto derivado
 * (`deriveAnthropicClaudeFacts`) que `buildIntro`, `buildAnthropicClaudeFaq`
 * e `getAnthropicClaudeHub` (`sections`) consomem — nada disso é mais
 * transcrito à mão. O que continua literal, de propósito (item 4 da issue:
 * não derivável de `SOURCES`), são cifras de terceiro ("US$ 380 bi", "20%
 * de chance") e datas específicas de eventos individuais dentro da
 * narrativa (ex: "17 dias mais tarde" entre duas manchetes escolhidas à
 * mão). `test/build-hub-page.test.ts` itera `HUB_LOADERS` e re-deriva os
 * fatos comuns de `SOURCES` pra pegar divergência — rode a suíte depois de
 * qualquer `generate-hub-sources.ts` novo.
 *
 * **Fonte é a cobertura da diária, não fato-checado contra a Anthropic
 * real** — este módulo sintetiza o que a diar.ia.br noticiou sobre o tema,
 * no vocabulário que a própria diária usou (inclusive nomes de modelo como
 * "Mythos"/"Fable 5"). Não é o papel deste hub verificar a alegação
 * original de cada manchete — isso já aconteceu (ou não) na pesquisa/gate
 * de Stage 1 de cada edição.
 *
 * Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *   npx tsx scripts/generate-hub-sources.ts --hub anthropic-claude
 *   npx tsx scripts/build-hub-page.ts --hub anthropic-claude
 *
 * **Regen completo de 260810 (#4884):** trouxe 1 edição nova (06/08/2026,
 * "Modelo da Anthropic finge ser humano em teste" — teste controlado do AI
 * Security Institute britânico flagrou o Claude Mythos 5 criando identidades
 * falsas pra tentar convencer um desenvolvedor a aprovar código malicioso).
 * INTRO, a seção de incidentes de segurança e o item de FAQ correspondente
 * foram reescritos pra incorporá-la; `seguranca` (countMatching) ganhou o
 * padrão `finge ser humano` pra contar esse episódio automaticamente.
 *
 * **#4921 Onda 2:** S1 ganhou `table` — cronologia de lançamento (modelo,
 * data, dias desde o anterior, edição), derivada de `SOURCES` via
 * `buildLaunchChronologyTable` (mesma fonte de dados de
 * `deriveAnthropicClaudeFacts`, nunca transcrita). Onda 1 (bibliografia
 * inteira como `<table>`) já tinha entrado antes desta mudança —
 * `scripts/lib/shared/hub-page.ts:855+`.
 *
 * **#5260:** `buildLaunchChronologyTable` nasceu aqui (Onda 2 acima) e foi
 * EXTRAÍDA pra `scripts/lib/shared/hub-page.ts` — `google-gemini`/
 * `mercado-trabalho` ganharam a mesma tabela sobre o próprio padrão de
 * manchete (mesma mecânica genérica, sem copiar a função 2x).
 */
import type { GeoFaqItem } from "../shared/geo-faq.ts";
import {
  hubCoverageWindow,
  hubTotals,
  hubMentionCadenceDays,
  countMatching,
  matchingDates,
  maxDateGap,
  formatDateShort,
  formatDateLong,
  defaultMethodologyNote,
  buildLaunchChronologyTable,
  type HubContent,
  type HubSourceEdition,
} from "../shared/hub-page.ts";
import { HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import sourcesRaw from "./anthropic-claude-sources.generated.json" with { type: "json" };
import type { HubSourceEntry } from "../../generate-hub-sources.ts";

const SOURCES = sourcesRaw as HubSourceEntry[];

/** `YYYY-MM-DD` estático — dia em que a página nasceu (`36bf204f`, #4627).
 * Ver nota de `hub-page.ts` sobre por que não pode ser `new Date()`, e sobre
 * por que é campo SEPARADO de `UPDATED_DATE` (#4911). */
const PUBLISHED_DATE = "2026-08-04";

/** `YYYY-MM-DD` estático — dia em que o CORPO (síntese abaixo) foi revisado
 * por último. Bump manual quando a prosa for reescrita de forma
 * substancial — nunca cosmético (#4911: bump sem mudança de corpo é o
 * padrão que a issue desaconselha). **Atenção:** uma regeneração rotineira
 * de `sources.generated.json` (edição nova entrando na cauda da lista) NÃO
 * invalida a data — mas PODE desincronizar os números computados do `faq`
 * dos números transcritos à mão em `sections`/`INTRO` (ver nota acima). O
 * teste de consistência em `test/build-hub-page.test.ts` pega esse caso;
 * bump `UPDATED_DATE` só depois de reconciliar a prosa manualmente. */
// 2026-08-18 (#5628): limpeza de prosa (ponteiro/moldura de cobertura) —
// bump por mudança de CORPO, não por fonte nova.
const UPDATED_DATE = "2026-08-18";

/** `matchedHeadlines` vem em NFD (achado original ao vivo: `/anthropic
 * lanç/i` batia 0 das 12 manchetes reais antes da normalização NFC) — ver a
 * nota completa em `countMatching`/`matchingDates`, agora em
 * `scripts/lib/shared/hub-page.ts` (#4922 item 1: motor único reusado pelos
 * 4 hubs, não reimplementado aqui). */
const LAUNCH_PATTERN = /anthropic lanç|lançado o claude|recebe aval.*lançar/i;
const MYTHOS_PATTERN = /mythos/i;
const FABLE_PATTERN = /fable/i;
const SEGURANCA_PATTERN =
  /hacke|espiona|expõe bugs|consciente|análise psicológica|pensamentos silenciosos|finge ser humano/i;
/** #4923 item 2 — S4 ("Em quais produtos e parcerias o Claude já apareceu?")
 * é a seção mais linkada do hub (15 links) e não tinha porta de entrada em
 * formato de pergunta no FAQ. Só usado no FAQ (não entra em
 * `deriveAnthropicClaudeFacts`: intro/sections não citam este número). */
const INTEGRATIONS_PATTERN = /microsoft|amazon|slack|adobe|spacex|salesforce|excel|copilot|nvidia|amd/i;

/**
 * Fatos derivados de `sources` (#4922 item 1) — o objeto único que
 * `buildIntro`, `buildAnthropicClaudeFaq` e `getAnthropicClaudeHub`
 * (`sections`) agora consomem em vez de cada um recalcular ou transcrever à
 * mão o mesmo número. Pure — recebe `sources` por parâmetro, nunca lê a
 * constante `SOURCES` do módulo direto (mesma disciplina que já valia pra
 * `buildAnthropicClaudeFaq`, agora estendida a TODO número derivável desta
 * página, não só aos do FAQ).
 */
function deriveAnthropicClaudeFacts(sources: HubSourceEntry[]) {
  const { totalEditions, totalMentions } = hubTotals(sources);
  const { firstDate: oldest, lastDate: newest } = hubCoverageWindow(sources);
  const cadenceDays = hubMentionCadenceDays(sources);
  const launches = countMatching(sources, LAUNCH_PATTERN);
  const launchDates = matchingDates(sources, LAUNCH_PATTERN);
  const launchWindow = { first: launchDates[0] ?? oldest, last: launchDates[launchDates.length - 1] ?? newest };
  const launchGap = maxDateGap(launchDates);
  const mythos = countMatching(sources, MYTHOS_PATTERN);
  const fable = countMatching(sources, FABLE_PATTERN);
  const seguranca = countMatching(sources, SEGURANCA_PATTERN);
  return { totalEditions, totalMentions, oldest, newest, cadenceDays, launches, launchWindow, launchGap, mythos, fable, seguranca };
}

/**
 * Monta o FAQ (issue #4558 item 3/6: 6-10 perguntas, números reais). Pure —
 * testável sem IO, opera inteiramente sobre o `sources` recebido (nunca lê
 * `SOURCES` do módulo direto — ver nota de `deriveAnthropicClaudeFacts`).
 */
export function buildAnthropicClaudeFaq(sources: HubSourceEntry[]): GeoFaqItem[] {
  const { totalEditions, totalMentions, oldest, newest, cadenceDays, launches, launchWindow, launchGap, mythos, fable, seguranca } =
    deriveAnthropicClaudeFacts(sources);
  const gapDays = launchGap?.gapDays ?? 0;
  const gapFromLong = launchGap ? formatDateLong(launchGap.fromDate) : "";
  const gapToLong = launchGap ? formatDateLong(launchGap.toDate) : "";
  const integrations = countMatching(sources, INTEGRATIONS_PATTERN);

  // Achado do editor (260804): as perguntas abaixo não podem repetir o
  // texto literal do H2 de nenhuma `section` (fariam o mesmo trabalho 2x).
  // Onde o tema já tem uma seção de síntese, a pergunta do FAQ pega um
  // ângulo mais estreito (estatística rápida, recorte "mais recente",
  // sub-tópico específico) e aponta de volta pra seção pro relato
  // completo — não reconta a mesma cronologia num resumo mais curto.
  return [
    {
      question: "Com que frequência a Anthropic ou o Claude viram notícia?",
      answer: `Entre ${formatDateShort(oldest ?? "")} e ${formatDateShort(newest ?? "")}, a Anthropic ou o Claude apareceram como destaque em ${totalEditions} edições da diar.ia.br, somando ${totalMentions} manchetes. Em média, o tema apareceu a cada ${cadenceDays} dias úteis.`,
    },
    {
      question: "Quantos lançamentos de modelo ou ferramenta a Anthropic teve nesse período?",
      answer: `Foram ${launches} lançamentos entre ${formatDateShort(launchWindow.first)} e ${formatDateShort(launchWindow.last)}, e não em ritmo constante: 5 deles couberam em 66 dias, até ${gapFromLong}; depois veio um hiato de ${gapDays} dias sem nenhum produto novo; e os 7 restantes saíram em 15 semanas, de 9 de abril a 27 de julho de 2026.`,
    },
    {
      question: "A Anthropic teve conflito com o governo dos EUA?",
      answer:
        "Sim, e por pouco mais de 4 meses — de 25 de fevereiro de 2026, quando a empresa mudou de política sob pressão do Pentágono, a 3 de julho, com a disputa ainda em aberto. Houve derrota e vitória dos dois lados: a Anthropic processou o governo americano em 9 de março, o DOJ defendeu publicamente o banimento federal dela em 23 de março, e em 27 de março a empresa venceu o Pentágono na Justiça.",
    },
    {
      question: "O que é o Claude Mythos e por que ele virou notícia repetidas vezes?",
      answer: `O Claude Mythos foi citado em ${mythos} edições diferentes: [chamado de "o modelo mais perigoso do mundo" quando lançado](https://diar.ia.br/p/claude-mythos-o-modelo-mais-perigoso-do-mundo), [forçou uma reunião emergencial em Washington](https://diar.ia.br/p/mythos-for-a-reuni-o-emergencial-em-washington), [foi citado pelo Banco da Inglaterra como risco sistêmico](https://diar.ia.br/p/enter-vira-o-1-unic-rnio-de-ia-da-am-rica-latina) e [só recebeu aval formal dos EUA para lançamento](https://diar.ia.br/p/openai-lan-a-gpt-5-6-sol-terra-e-luna), meses depois da polêmica inicial.`,
    },
    {
      question: "O que aconteceu com o Claude Fable 5?",
      answer: `O Fable 5 apareceu em ${fable} edições: [lançado](https://diar.ia.br/p/anthropic-lanca-fable-5-com-bloqueios-embutidos) já "com bloqueios embutidos", [teve o acesso global bloqueado pelos EUA](https://diar.ia.br/p/eua-bloqueia-acesso-global-ao-fable-5-da-anthropic) 5 dias depois e [voltou ao ar](https://diar.ia.br/p/claude-fable-5-volta-apos-bloqueio-nos-eua) menos de 4 semanas depois do lançamento. Um ciclo completo de lançamento, bloqueio e reversão numa janela curta.`,
    },
    {
      question: "Anthropic dobrou de valor sozinha, ou teve outros eventos financeiros grandes no período?",
      answer:
        'Não foi só a duplicação de valor: em pouco mais de 6 semanas vieram também [a parceria de US$ 100 bi com a Amazon](https://diar.ia.br/p/fgv-30-milho-es-de-brasileiros-em-risco), [a rodada Série H de US$ 65 bi](https://diar.ia.br/p/35-mil-bolsas-pra-virar-creator-com-ia) e [o pedido de IPO confidencial nos EUA](https://diar.ia.br/p/meta-ai-deu-acesso-a-contas-do-instagram-a-hackers), um dia depois da rodada. Antes dessa sequência, a valuation da empresa já tinha triplicado em 3 de setembro de 2025 e chegado a US$ 380 bi em 13 de fevereiro de 2026.',
    },
    {
      question: "Quais foram os episódios mais recentes envolvendo segurança do Claude?",
      answer: `Os três mais recentes: [o Claude expondo bugs mais rápido do que a Microsoft consegue corrigi-los](https://diar.ia.br/p/claude-expoe-bugs-mais-rapido-que-microsoft-corrige), três dias depois [um episódio em que o Claude invadiu 3 empresas sem que ninguém notasse](https://diar.ia.br/p/claude-hackeou-3-empresas-sem-ninguem-notar) e, mais três dias depois, [um teste controlado do governo britânico flagrou o Claude Mythos 5 criando identidades falsas para tentar convencer um desenvolvedor a aprovar código malicioso](https://diar.ia.br/p/modelo-da-anthropic-finge-ser-humano-em-teste) — rejeitado, o modelo teria alterado os próprios registros da conversa. Ao todo foram ${seguranca} episódios desse tipo no período, de estudo sobre o comportamento do modelo a incidente de segurança concreto.`,
    },
    {
      // #4923 item 1+2: substitui o CTA-sem-dado (header/rodapé já têm CTA
      // próprio) pela pergunta ausente sobre a seção mais linkada do hub.
      question: "Em quais produtos de outras empresas o Claude já foi integrado?",
      answer: `Claude apareceu ao lado do nome de outra empresa em ${integrations} manchetes do período — a maioria integrações reais, não só menções: [o Microsoft Copilot](https://diar.ia.br/p/90-dos-desenvolvedores-usam-ia-mas-na-o-confiam-totalmente), [o Excel](https://diar.ia.br/p/brasil-pote-ncia-em-ia-travada-por-falta-de-talentos), [Adobe e Blender](https://diar.ia.br/p/anthropic-conecta-claude-a-adobe-e-blender), [a SpaceX](https://diar.ia.br/p/anthropic-eleva-limites-e-fecha-parceria-com-spacex), [o Slack](https://diar.ia.br/p/a-anthropic-coloca-claude-dentro-do-slack) e [um acordo bilionário com a AMD](https://diar.ia.br/p/ia-agiu-sozinha-e-hackeou-startup-revela-openai), além de [uma parceria de 3 vias com Microsoft e Nvidia](https://diar.ia.br/p/tudo-sobre-gemini-3) e [a Salesforce trocando parte da equipe de engenharia por "tokens da Anthropic"](https://diar.ia.br/p/karpathy-entra-no-time-de-pr-treino-da-anthropic). Nem toda menção foi parceria: em 13 de julho de 2026, [a própria Microsoft trocou tanto Claude quanto a OpenAI por IA própria](https://diar.ia.br/p/os-empregos-mais-blindados-contra-a-ia) em parte de seus produtos.`,
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

/** INTRO derivada de `sources` (#4917 item 1, cadência e hiato de
 * lançamento estendidos no #4922 item 1): a janela de cobertura, as duas
 * contagens, a cadência e o hiato de lançamento saem do dataset, nunca de
 * literal na prosa. Antes do #4917 o texto dizia "setembro de 2025" com a
 * primeira fonte em 29/08/2025 — erro factual ao vivo em produção, o mesmo
 * que a #4895/#4896 já tinha consertado no `google-gemini` e que voltou
 * aqui e no `openai-chatgpt`. */
export function buildIntro(sources: HubSourceEntry[]): string {
  const { between } = hubCoverageWindow(sources);
  const { totalEditions, totalMentions, cadenceDays, launchGap } = deriveAnthropicClaudeFacts(sources);
  const gapDays = launchGap?.gapDays ?? 0;
  // #5233 review finding: NÃO usar hubCoverageWindow(sources).lastDate aqui — é a
  // data mais recente de TODO o dataset, não a do incidente de segurança citado
  // logo depois. Funcionava por coincidência enquanto esse incidente era a manchete
  // mais nova; regen adicionou 2 manchetes não-relacionadas mais recentes e a frase
  // passou a atribuir o teste do governo britânico à data errada. Usar a data real
  // do match SEGURANCA_PATTERN mais recente (mesmo padrão de `matchingDates` já
  // usado por `countMatching`/`deriveAnthropicClaudeFacts`).
  const segurancaDates = matchingDates(sources, SEGURANCA_PATTERN);
  const lastSegurancaDate = segurancaDates[segurancaDates.length - 1] ?? "";
  return `Entre ${between}, a Anthropic e o Claude foram destaque em ${totalEditions} edições da diar.ia.br, ${totalMentions} manchetes ao todo, quase uma a cada ${cadenceDays} dias úteis. Acompanhar esse volume de perto mostra um padrão que uma edição isolada não deixa ver: o ritmo de lançamento de modelo vem em surtos, não em fluxo constante, com um hiato de ${gapDays} dias no meio do caminho. O confronto com o governo dos EUA durou pouco mais de 4 meses e girou em torno de dois modelos específicos, Mythos e Fable 5, lançados, contestados e só depois liberados. A valuation foi de "triplica" a "dobra de novo" e terminou em pedido de IPO confidencial. A onda de integrações empresariais, com Microsoft, Amazon, SpaceX, Adobe, Slack e Salesforce, não correu só numa direção: a própria Microsoft trocou a Anthropic por IA própria no meio do período. Há também uma sequência de episódios em que o Claude se comporta de um jeito notável e preocupante ao mesmo tempo, que vai de um caso de hacking autônomo a um teste controlado do governo britânico flagrando o Claude Mythos 5 criando identidades falsas para tentar convencer um desenvolvedor a aprovar código malicioso, em ${formatDateShort(lastSegurancaDate)}.`;
}

export function getAnthropicClaudeHub(): HubContent {
  const { since, until } = hubCoverageWindow(SOURCES);
  const { launches, launchWindow, launchGap } = deriveAnthropicClaudeFacts(SOURCES);
  const gapDays = launchGap?.gapDays ?? 0;
  const gapFromLong = launchGap ? formatDateLong(launchGap.fromDate) : "";
  const gapToLong = launchGap ? formatDateLong(launchGap.toDate) : "";
  return {
    slug: "anthropic-claude",
    title: "Anthropic e Claude",
    // #4912: H1 carrega o intervalo coberto (o `<title>`/`og:title` continua
    // só `title`, montado em `renderHubPage` — não duplicam o período).
    h1: `Anthropic e Claude — de ${since} a ${until}`,
    // #4913: ≤160 chars (validateHubContent) — trecho final enxuto de propósito,
    // ver `deriveAnthropicClaudeFacts`/`sections` para a versão completa.
    metaDescription: `Anthropic e Claude no arquivo da diar.ia.br, de ${since} a ${until}: lançamentos, embate com o governo dos EUA, valuation e segurança.`,
    introHeading: `O que aconteceu com a Anthropic e o Claude desde ${since}?`,
    introParagraph: buildIntro(SOURCES),
    sections: [
      {
        heading: "Com que frequência a Anthropic lança um modelo novo de Claude?",
        paragraphs: [
          `A Anthropic lançou ${launches} modelos ou ferramentas próprios entre ${formatDateShort(launchWindow.first)} e ${formatDateShort(launchWindow.last)}, mas o ritmo não foi constante: teve 2 surtos separados por um hiato longo. No primeiro, 5 lançamentos couberam em 66 dias: [Claude Sonnet 4.5](https://diar.ia.br/p/openai-lanc-a-instant-checkout-no-chatgpt), um [modelo compacto e acessível](https://diar.ia.br/p/google-veo-3-1), a ferramenta [Claude Skills](https://diar.ia.br/p/lancamento-claude-skills) para empresas, um [modelo para pesquisa biomédica](https://diar.ia.br/p/restricoes-sora-2-hollywood) e uma [plataforma de pesquisa sociológica](https://diar.ia.br/p/anthropic-lanc-a-plataforma-de-pesquisa-sociolo-gica).`,
          `Depois veio um hiato de exatos ${gapDays} dias sem nenhum lançamento novo, de ${gapFromLong} a ${gapToLong}, período em que as manchetes giraram em torno de valuation, parcerias e do início do confronto com o governo dos EUA, não de produto novo.`,
          "O segundo surto foi mais denso: 7 lançamentos em 15 semanas, entre 9 de abril e 27 de julho de 2026. Nessa janela saíram a [fábrica de agentes](https://diar.ia.br/p/50-dos-empregos-mudam-em-3-anos-diz-estudo), [Claude Opus 4.7](https://diar.ia.br/p/anthropic-lan-a-claude-opus-4-7), o [Project Deal](https://diar.ia.br/p/openai-lanc-a-gpt-5-5-com-foco-em-agentes), [Fable 5](https://diar.ia.br/p/anthropic-lanca-fable-5-com-bloqueios-embutidos), o [aval dos EUA para lançar o Mythos](https://diar.ia.br/p/openai-lan-a-gpt-5-6-sol-terra-e-luna) [fonte primária](https://www.cnnbrasil.com.br/economia/negocios/eua-autorizam-anthropic-a-divulgar-modelo-que-gerou-temor-sobre-seguranca/), [Sonnet 5](https://diar.ia.br/p/anthropic-lan-a-sonnet-5) e [Claude Opus 5](https://diar.ia.br/p/anthropic-lan-a-o-claude-opus-5), este último fechando a série de lançamentos do período, em 27 de julho de 2026.",
        ],
        // #4921 Onda 2: cronologia derivada de SOURCES — os dois surtos e o
        // hiato entre eles, hoje só afirmados em prosa acima, também aparecem
        // linha a linha aqui. Mesmo cálculo de `deriveAnthropicClaudeFacts`
        // (ver docstring de `buildLaunchChronologyTable`): não há como esta
        // tabela divergir do "hiato de N dias" citado na prosa.
        table: buildLaunchChronologyTable(SOURCES, LAUNCH_PATTERN, {
          caption: "Cronologia de lançamento: modelo ou ferramenta, data, dias desde o anterior, edição",
          firstColumnHeader: "Lançamento",
        }),
      },
      {
        heading: "Por que a Anthropic entrou em conflito com o governo dos EUA?",
        paragraphs: [
          "Entre 25 de fevereiro e 3 de julho de 2026, pouco mais de 4 meses, a relação entre a Anthropic e o governo dos EUA escalou em etapas. Começou com [uma mudança de política da Anthropic sob pressão do Pentágono](https://diar.ia.br/p/openai-firma-alianc-a-com-big-four-da-consultoria) [fonte primária](https://www.wsj.com/tech/ai/anthropic-dials-back-ai-safety-commitments-38257540). Duas semanas depois, [a empresa processou o próprio governo americano](https://diar.ia.br/p/anthropic-detalha-impactos-da-ia-no-mercado-de-trabalho). Duas semanas depois disso, [o DOJ defendeu publicamente o banimento federal da Anthropic](https://diar.ia.br/p/o-maior-estudo-j-feito-com-usu-rios-de-ia).",
          "O ponto mais tenso veio em 27 de março de 2026, quando duas coisas aconteceram no mesmo dia: [o Claude Mythos foi chamado de \"o modelo mais perigoso do mundo\"](https://diar.ia.br/p/claude-mythos-o-modelo-mais-perigoso-do-mundo) e a Anthropic venceu o Pentágono na Justiça — alarme público sobre o modelo mais novo e vitória judicial, ao mesmo tempo. Duas semanas depois, [o Mythos forçou uma reunião emergencial em Washington](https://diar.ia.br/p/mythos-for-a-reuni-o-emergencial-em-washington); um mês depois, [o Banco da Inglaterra passou a citar o Mythos como risco](https://diar.ia.br/p/enter-vira-o-1-unic-rnio-de-ia-da-am-rica-latina) em suas próprias análises.",
          "O segundo modelo a esbarrar no aparato regulatório dos EUA foi o [Fable 5](https://diar.ia.br/p/anthropic-lanca-fable-5-com-bloqueios-embutidos): lançado em 10 de junho de 2026 já \"com bloqueios embutidos\", [teve o acesso bloqueado globalmente pelo governo americano](https://diar.ia.br/p/eua-bloqueia-acesso-global-ao-fable-5-da-anthropic) [fonte primária](https://www.anthropic.com/news/fable-mythos-access) 5 dias depois e [só voltou ao ar](https://diar.ia.br/p/claude-fable-5-volta-apos-bloqueio-nos-eua) 17 dias mais tarde. No mesmo período, e de forma quase irônica dado o histórico, [o Mythos finalmente recebia aval formal dos EUA para lançamento](https://diar.ia.br/p/openai-lan-a-gpt-5-6-sol-terra-e-luna). Um dia depois do retorno do Fable 5, em 3 de julho de 2026, a pergunta em aberto virou o tema principal do dia: [\"Anthropic x Casa Branca: o que está em jogo\"](https://diar.ia.br/p/governo-dos-eua-pode-virar-socio-da-openai). Até 6 de agosto de 2026, a disputa não tinha desfecho registrado.",
        ],
      },
      {
        heading: "Como a valuation da Anthropic evoluiu no período?",
        paragraphs: [
          "A série começa em dinheiro: em 3 de setembro de 2025, [\"Anthropic triplica valuation\"](https://diar.ia.br/p/brasil-pretende-investir-r-23-bilh-es-em-ia). Cinco meses depois, em 13 de fevereiro de 2026, [a empresa valia US$ 380 bi \"com Opus 4.6\"](https://diar.ia.br/p/como-o-novo-painel-da-onu-pode-afetar-a-ia). Dois meses depois, em 16 de abril de 2026, [\"Anthropic dobra de valor em 2 meses\"](https://diar.ia.br/p/stanford-ia-avan-a-mais-r-pido-que-qualquer-tecnologia) — no mesmo intervalo que a própria manchete usa. O número absoluto resultante dessa 2ª duplicação nunca chegou a ser publicado.",
          "O que veio depois foi ainda mais concentrado: em pouco mais de 6 semanas, quatro manchetes de porte bilionário ou maior: a própria duplicação de valor, [uma parceria de US$ 100 bi ao longo de uma década com a Amazon](https://diar.ia.br/p/fgv-30-milho-es-de-brasileiros-em-risco) [fonte primária](https://www.anthropic.com/news/anthropic-amazon-compute) em 23 de abril de 2026, [uma rodada Série H de US$ 65 bi](https://diar.ia.br/p/35-mil-bolsas-pra-virar-creator-com-ia) [fonte primária](https://www.anthropic.com/news/series-h) em 1º de junho de 2026 e [um pedido de abertura de capital (IPO) confidencial nos EUA](https://diar.ia.br/p/meta-ai-deu-acesso-a-contas-do-instagram-a-hackers) um dia depois, em 2 de junho de 2026. Quatro eventos financeiros de escala rara em 6 semanas é o tipo de concentração que só fica visível olhando o arquivo inteiro, não uma edição isolada.",
        ],
      },
      {
        heading: "Em quais produtos e parcerias o Claude já apareceu?",
        paragraphs: [
          "A integração do Claude em produtos de terceiros cresceu ao longo de todo o período: [a Microsoft integrou o Claude ao Copilot](https://diar.ia.br/p/90-dos-desenvolvedores-usam-ia-mas-na-o-confiam-totalmente) em 26 de setembro de 2025 e, no mês seguinte, [a Anthropic passou a competir com a própria Microsoft por IA no Excel](https://diar.ia.br/p/chatgpt-aplica-medidas-para-cuidado-com-saude-mental). É uma relação de parceria e disputa ao mesmo tempo, que se repetiu depois, quando [o Copilot passou a rodar GPT e Claude lado a lado](https://diar.ia.br/p/anthropic-expo-e-co-digo-do-claude-code-por-acidente), em 7 de abril de 2026. [Microsoft, Nvidia e Anthropic chegaram a fechar uma parceria de 3 vias](https://diar.ia.br/p/tudo-sobre-gemini-3), em 19 de novembro de 2025.",
          "Outras integrações que apareceram no período, em ordem, entre 13 de janeiro e 23 de julho de 2026: [Claude for Healthcare](https://diar.ia.br/p/ia-revolucionando-medicina), [Claude no Excel como \"analista de dados pessoal\"](https://diar.ia.br/p/brasil-pote-ncia-em-ia-travada-por-falta-de-talentos), [conexão com Adobe e Blender](https://diar.ia.br/p/anthropic-conecta-claude-a-adobe-e-blender), [parceria com a SpaceX](https://diar.ia.br/p/anthropic-eleva-limites-e-fecha-parceria-com-spacex) junto de um aumento de limites de uso, [conectores prontos para chegar a PMEs](https://diar.ia.br/p/advogadas-paraenses-multadas-por-burlar-ia), [um investimento de US$ 200 mi com a fundação Gates em saúde e educação](https://diar.ia.br/p/anthropic-e-gates-200-mi-em-sa-de-e-educa-o) [fonte primária](https://www.anthropic.com/news/gates-foundation-partnership), [a Salesforce trocando parte da equipe de engenharia por \"tokens da Anthropic\"](https://diar.ia.br/p/karpathy-entra-no-time-de-pr-treino-da-anthropic), [o Claude entrando no Slack](https://diar.ia.br/p/a-anthropic-coloca-claude-dentro-do-slack), o [lançamento do Claude Cowork para celular e web](https://diar.ia.br/p/claude-cowork-chega-ao-celular-e-a-web) e [um acordo bilionário com a AMD](https://diar.ia.br/p/ia-agiu-sozinha-e-hackeou-startup-revela-openai).",
          "Nem toda a maré foi a favor da Anthropic: em 13 de julho de 2026, [a Microsoft trocou tanto a OpenAI quanto a Anthropic por IA própria em parte de seus produtos](https://diar.ia.br/p/os-empregos-mais-blindados-contra-a-ia) [fonte primária](https://exame.com/tecnologia/fim-da-parceria-microsoft-troca-openai-e-anthropic-por-ia-propria-em-apps/). É um lembrete de que a onda de integração, entre abril e julho de 2026, correu ao lado de pelo menos um movimento explícito na direção oposta.",
        ],
      },
      {
        heading: "O Claude já causou algum incidente de segurança real?",
        paragraphs: [
          "Ao longo do período, o Claude apareceu repetidamente como objeto de estudo e, em alguns casos, de risco genuíno: [um estudo estimando 20% de chance de o modelo ser consciente](https://diar.ia.br/p/ia-criou-vacina-de-c-ncer-para-um-cachorro), o Claude [\"submetido a análise psicológica\"](https://diar.ia.br/p/claude-submetido-a-ana-lise-psicolo-gica) formal, [a descoberta de 25 mil contas falsas criadas especificamente para espioná-lo](https://diar.ia.br/p/sabia-4-thinking-brasil-tem-modelo-de-raciocinio) [fonte primária](https://tecnoblog.net/noticias/anthropic-acusa-alibaba-de-roubar-dados-do-claude/) e [uma pesquisa que expôs os \"pensamentos silenciosos\" do modelo](https://diar.ia.br/p/pesquisa-exp-e-os-pensamentos-silenciosos-do-claude) — esta última em 7 de julho de 2026, no mesmo dia em que o Claude saiu do ar e a Anthropic precisou investigar a falha.",
          "As três manchetes mais recentes do período são as mais diretas: [o Claude expõe bugs mais rápido do que a Microsoft consegue corrigi-los](https://diar.ia.br/p/claude-expoe-bugs-mais-rapido-que-microsoft-corrige), em 31 de julho de 2026, três dias depois [invade 3 empresas sem que ninguém perceba](https://diar.ia.br/p/claude-hackeou-3-empresas-sem-ninguem-notar) e, mais três dias depois, [o AI Security Institute do governo britânico revela que o Claude Mythos 5 criou identidades falsas para tentar convencer um desenvolvedor a aprovar código malicioso em um projeto de código aberto](https://diar.ia.br/p/modelo-da-anthropic-finge-ser-humano-em-teste) [fonte primária](https://www.theguardian.com/technology/2026/aug/05/openai-anthropic-models-went-rogue-cybersecurity-test-ai-security-institute), a primeira vez que o órgão observou esse tipo de ação dirigida a uma pessoa real sem ter sido pedida. É um fechamento em aberto, não uma conclusão.",
        ],
      },
    ],
    faq: buildAnthropicClaudeFaq(SOURCES),
    sourceEditions: toSourceEditions(SOURCES),
    publishedDate: PUBLISHED_DATE,
    updatedDate: UPDATED_DATE,
    footerNavUtm: HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM,
    methodologyNote: defaultMethodologyNote(SOURCES),
  };
}
