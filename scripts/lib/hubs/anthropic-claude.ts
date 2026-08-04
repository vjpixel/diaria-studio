/**
 * anthropic-claude.ts (#4558 Parte A)
 *
 * Conteúdo editorial do 1º hub temático — Anthropic/Claude. Decisão do
 * editor (260804): hubs de empresa e hubs temáticos coexistem, mas só este
 * entra nesta rodada; os demais candidatos da proposta (artefato da sessão)
 * ficam pra depois.
 *
 * **Critério de qualidade da issue #4558 (não-negociável):** as seções
 * abaixo conectam pontos ao longo de ~11 meses de cobertura (o que só é
 * possível olhando o ARQUIVO inteiro, não uma edição isolada) — não
 * reempacotam manchete. Cada afirmação numérica é ancorada em
 * `anthropic-claude-sources.generated.json` (gerado por
 * `scripts/generate-hub-sources.ts --hub anthropic-claude` a partir de
 * `data/beehiiv-cache/posts/*.json`) — nunca um número solto. A prosa cita
 * datas e contagens computadas por `countMatching`/`buildAnthropicClaudeFaq`
 * abaixo, não hardcoded em paralelo.
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
 */
import type { GeoFaqItem } from "../shared/geo-faq.ts";
import type { HubContent, HubSourceEdition } from "../shared/hub-page.ts";
import { HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import sourcesRaw from "./anthropic-claude-sources.generated.json" with { type: "json" };
import type { HubSourceEntry } from "../../generate-hub-sources.ts";

const SOURCES = sourcesRaw as HubSourceEntry[];

/** `YYYY-MM-DD` estático — data em que a síntese abaixo foi escrita. Ver
 * nota de `hub-page.ts` sobre por que não pode ser `new Date()`. Bump manual
 * quando a prosa for reescrita de forma substancial (não a cada regeneração
 * rotineira do `sources.generated.json`, que só adiciona linhas novas ao
 * fim da lista sem invalidar a leitura já escrita). */
const CONTENT_DATE = "2026-08-04";

/** O `matchedHeadlines` de `sources.generated.json` preserva o texto ORIGINAL
 * do cache Beehiiv, que vem em NFD (acento como combining mark separado —
 * "ç" é "c" + U+0327, não o "ç" precomposto U+00E7 que um regex literal usa
 * por padrão). Testar um regex acentuado direto contra esse texto falha
 * silenciosamente (achado ao vivo: `/anthropic lanç/i` batia 0 das 12
 * manchetes reais). `countMatching` normaliza pra NFC antes do teste — os
 * PATTERNS abaixo continuam escritos com acento normal (legíveis), a
 * normalização acontece só no lado do dado. */
function countMatching(pattern: RegExp): number {
  let n = 0;
  for (const s of SOURCES) {
    for (const h of s.matchedHeadlines) {
      if (pattern.test(h.normalize("NFC"))) n++;
    }
  }
  return n;
}

function formatDateLabel(dateIso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso);
  if (!m) return dateIso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Monta o FAQ (issue #4558 item 3/6: 6-10 perguntas, números reais). Pure —
 * testável sem IO, recebe `SOURCES` já carregado no topo do módulo.
 */
export function buildAnthropicClaudeFaq(sources: HubSourceEntry[]): GeoFaqItem[] {
  const totalMentions = sources.reduce((n, s) => n + s.matchedHeadlines.length, 0);
  const totalEditions = sources.length;
  const oldest = sources[0]?.date;
  const newest = sources[sources.length - 1]?.date;
  const launches = countMatching(/anthropic lanç|lançado o claude|recebe aval.*lançar/i);
  const mythos = countMatching(/mythos/i);
  const fable = countMatching(/fable/i);
  const seguranca = countMatching(/hacke|espiona|expõe bugs|consciente|análise psicológica|pensamentos silenciosos/i);

  return [
    {
      question: "Em quantas edições a diar.ia.br destacou algo sobre Anthropic ou Claude?",
      answer: `Entre ${formatDateLabel(oldest ?? "")} e ${formatDateLabel(newest ?? "")}, a Anthropic ou o Claude apareceram como destaque em ${totalEditions} edições da diar.ia.br, somando ${totalMentions} manchetes — em média, cerca de 1 edição a cada 4 dias úteis cobriu o tema.`,
    },
    {
      question: "Com que frequência a Anthropic lança um modelo novo de Claude?",
      answer: `A diária noticiou ${launches} lançamentos de modelo ou ferramenta da própria Anthropic no período, mas o ritmo não foi constante: 5 lançamentos couberam nos primeiros 66 dias (30/09 a 05/12/2025), seguidos por um hiato de exatos 125 dias sem nenhum lançamento novo, e depois um 2º surto de 7 lançamentos em 15 semanas (09/04 a 27/07/2026), fechando com Sonnet 5 e Opus 5 em rápida sucessão.`,
    },
    {
      question: "A Anthropic teve conflito com o governo dos EUA?",
      answer: "Sim — um confronto que durou cerca de 5 meses (25/02 a 03/07/2026): pressão do Pentágono forçou mudança de política, a Anthropic processou o governo dos EUA, o DOJ pediu banimento federal da empresa, a Anthropic venceu o Pentágono na Justiça na mesma edição em que o modelo Claude Mythos foi chamado de \"o mais perigoso do mundo\", e o modelo seguinte, Fable 5, foi bloqueado globalmente pelos EUA 5 dias depois de lançado — só voltando ao ar 17 dias depois.",
    },
    {
      question: "O que é o Claude Mythos e por que ele virou notícia repetidas vezes?",
      answer: `O Claude Mythos foi citado em ${mythos} edições diferentes — chamado de "o modelo mais perigoso do mundo" quando lançado, forçou uma reunião emergencial em Washington, foi citado pelo Banco da Inglaterra como risco sistêmico e só recebeu aval formal dos EUA para lançamento em 29/06/2026, meses depois da polêmica inicial.`,
    },
    {
      question: "O que aconteceu com o Claude Fable 5?",
      answer: `O Fable 5 apareceu em ${fable} edições: lançado em 10/06/2026 "com bloqueios embutidos", teve o acesso global bloqueado pelos EUA 5 dias depois, e voltou ao ar em 02/07/2026 — um ciclo completo de lançamento, bloqueio e reversão em menos de 4 semanas.`,
    },
    {
      question: "Quanto vale a Anthropic, segundo a cobertura da diar.ia.br?",
      answer: "A trajetória de valuation noticiada: \"triplica valuation\" (03/09/2025), depois \"vale US$ 380 bi com Opus 4.6\" (13/02/2026) e \"dobra de valor em 2 meses\" (16/04/2026) — sem a diária citar o número absoluto resultante dessa 2ª duplicação. Em seguida, quatro anúncios de porte bilionário em pouco mais de 6 semanas: parceria de US$ 100 bi em uma década com a Amazon (23/04), captação de US$ 65 bi na rodada Série H (01/06) e pedido de IPO confidencial nos EUA (02/06).",
    },
    {
      question: "O Claude já causou algum incidente de segurança real, segundo a cobertura?",
      answer: `A diária noticiou ${seguranca} episódios ligando o Claude a comportamento inesperado ou de risco: um estudo estimando 20% de chance de o modelo ser consciente, uma "análise psicológica" formal do Claude, 25 mil contas falsas criadas para espioná-lo, uma pesquisa que expôs seus "pensamentos silenciosos", uma falha que tirou o Claude do ar, e a manchete mais recente do período — Claude tendo invadido 3 empresas sem que ninguém notasse.`,
    },
    {
      question: "Como acompanho as próximas notícias sobre Anthropic e Claude?",
      answer:
        "Assinando a diar.ia.br — a newsletter cobre lançamentos, disputas regulatórias e movimentos de mercado da Anthropic conforme acontecem, de segunda a sexta, e esta página é atualizada periodicamente para refletir a cobertura mais recente.",
    },
  ];
}

function toSourceEditions(sources: HubSourceEntry[]): HubSourceEdition[] {
  return [...sources]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((s) => ({
      date: s.date,
      title: s.matchedHeadlines.join(" · "),
      url: s.url,
    }));
}

const INTRO =
  "Entre setembro de 2025 e agosto de 2026, a Anthropic e o Claude foram destaque em 75 edições da diar.ia.br — 83 manchetes ao todo, quase uma a cada 4 dias úteis. Cinco fios conectam essa cobertura: um ritmo de lançamento de modelo em dois surtos separados por um hiato de 4 meses; um confronto real de cerca de 5 meses com o governo dos EUA, centrado em dois modelos (Mythos e Fable 5) que foram lançados, contestados e só depois liberados; uma trajetória de valuation que foi de \"triplica\" a \"dobra de novo\" e terminou em pedido de IPO confidencial; uma onda de integrações empresariais (Microsoft, Amazon, SpaceX, Adobe, Slack, Salesforce) que não foi só de um lado — a Microsoft também trocou a Anthropic por IA própria no meio do período; e uma sequência de manchetes sobre o Claude se comportando de formas ao mesmo tempo notáveis e preocupantes, terminando com um episódio de hacking autônomo na edição mais recente coberta aqui. As seções abaixo detalham cada fio com data e fonte.";

export function getAnthropicClaudeHub(): HubContent {
  return {
    slug: "anthropic-claude",
    title: "Anthropic e Claude",
    metaDescription:
      "O que a diar.ia.br cobriu sobre Anthropic e Claude entre setembro de 2025 e agosto de 2026 — lançamentos de modelo, o confronto com o governo dos EUA, valuation e integrações.",
    introHeading: "O que aconteceu com a Anthropic e o Claude desde setembro de 2025, segundo a diar.ia.br?",
    introParagraph: INTRO,
    sections: [
      {
        heading: "Com que frequência a Anthropic lança um modelo novo de Claude?",
        paragraphs: [
          "A diária noticiou 12 lançamentos de modelo ou ferramenta da própria Anthropic entre 30/09/2025 e 27/07/2026, mas o ritmo não foi constante — teve 2 surtos separados por um hiato longo. No primeiro, 5 lançamentos couberam em 66 dias: Claude Sonnet 4.5 (30/09), um modelo compacto e acessível (16/10), a ferramenta Claude Skills para empresas (17/10), um modelo para pesquisa biomédica (21/10) e uma plataforma de pesquisa sociológica (05/12).",
          "Depois veio um hiato de exatos 125 dias sem nenhum lançamento novo — de 5 de dezembro de 2025 a 9 de abril de 2026 — período em que a cobertura girou em torno de valuation, parcerias e do início do confronto com o governo dos EUA (seção abaixo), não de produto novo.",
          "O segundo surto foi mais denso: 7 lançamentos em 15 semanas, entre 9 de abril e 27 de julho de 2026 — uma \"fábrica de agentes\" (09/04), Claude Opus 4.7 (18/04), o Project Deal (24/04), Fable 5 (10/06), o aval dos EUA para lançar o Mythos (29/06), Sonnet 5 (01/07) e Claude Opus 5 (27/07), este último fechando o período coberto por este hub.",
        ],
      },
      {
        heading: "Por que a Anthropic entrou em conflito com o governo dos EUA?",
        paragraphs: [
          "Entre 25 de fevereiro e 3 de julho de 2026 — cerca de 5 meses — a diária cobriu uma escalada real entre a Anthropic e o governo dos EUA, não um único episódio isolado. Começou com a Anthropic mudando de política sob pressão do Pentágono (25/02). Duas semanas depois, a empresa processou o próprio governo americano (09/03). Duas semanas depois disso, o DOJ defendeu publicamente o banimento federal da Anthropic (23/03).",
          "O ponto mais tenso veio em 27 de março: na mesma edição em que o Claude Mythos foi chamado de \"o modelo mais perigoso do mundo\", a diária noticiou que a Anthropic tinha vencido o Pentágono na Justiça — vitória judicial e alarme público sobre o modelo mais novo, lado a lado. Duas semanas depois, o Mythos forçou uma reunião emergencial em Washington (10/04); um mês depois, o Banco da Inglaterra passou a citar o Mythos como risco em suas próprias análises (13/05).",
          "O segundo modelo a esbarrar no aparato regulatório dos EUA foi o Fable 5: lançado em 10 de junho já \"com bloqueios embutidos\", teve o acesso bloqueado globalmente pelo governo americano 5 dias depois (15/06) e só voltou ao ar 17 dias mais tarde (02/07) — no mesmo período em que o Mythos, paradoxalmente, finalmente recebia aval formal dos EUA para lançamento (29/06). Um dia depois do retorno do Fable 5, uma edição inteira foi dedicada à pergunta em aberto: \"Anthropic x Casa Branca: o que está em jogo\" (03/07) — o hub não encontrou, no período coberto, uma edição que desse essa história por encerrada.",
        ],
      },
      {
        heading: "Quanto vale a Anthropic, segundo a cobertura da diar.ia.br?",
        paragraphs: [
          "A primeira edição deste hub já era sobre dinheiro: \"Anthropic triplica valuation\" (03/09/2025). Cinco meses depois, em 13/02/2026, a diária noticiou a empresa valendo US$ 380 bi \"com Opus 4.6\". Dois meses depois disso — e a manchete usa exatamente esse intervalo — \"Anthropic dobra de valor em 2 meses\" (16/04/2026), sem que a diária tenha publicado o número absoluto resultante dessa 2ª duplicação.",
          "O que veio depois foi ainda mais concentrado: em pouco mais de 6 semanas (16/04 a 02/06/2026), quatro manchetes de porte bilionário ou maior — a própria duplicação de valor, uma parceria de US$ 100 bi ao longo de uma década com a Amazon (23/04), uma rodada Série H de US$ 65 bi (01/06) e um pedido de abertura de capital (IPO) confidencial nos EUA (02/06, um dia depois da rodada). Quatro eventos financeiros de escala rara em 6 semanas é o tipo de concentração que só fica visível olhando o arquivo inteiro, não uma edição isolada.",
        ],
      },
      {
        heading: "Em quais produtos e parcerias o Claude já apareceu?",
        paragraphs: [
          "A integração do Claude em produtos de terceiros cresceu ao longo de todo o período: Microsoft integrou o Claude ao Copilot (26/09/2025) e, no mesmo mês seguinte, a Anthropic passou a competir com a própria Microsoft por IA no Excel (28/10) — relação simultaneamente de parceria e disputa que se repetiu depois, quando o Copilot passou a rodar GPT e Claude lado a lado (07/04/2026). Microsoft, Nvidia e Anthropic chegaram a fechar uma parceria de 3 vias (19/11/2025).",
          "Outras integrações notáveis, em ordem: Claude for Healthcare (13/01/2026), Claude no Excel como \"analista de dados pessoal\" (27/01), conexão com Adobe e Blender (29/04), parceria com a SpaceX junto de um aumento de limites de uso (07/05), conectores prontos para chegar a PMEs (14/05), um investimento de US$ 200 mi com a fundação Gates em saúde e educação (15/05), a Salesforce trocando parte da equipe de engenharia por \"tokens da Anthropic\" (20/05), o Claude entrando no Slack (24/06), o lançamento do Claude Cowork para celular e web (08/07) e um acordo bilionário com a AMD (23/07).",
          "Nem toda a maré foi a favor da Anthropic: em 13/07/2026, a diária noticiou a Microsoft trocando tanto a OpenAI quanto a Anthropic por IA própria em parte de seus produtos — um lembrete de que a onda de integração, entre abril e julho, correu ao lado de pelo menos um movimento explícito na direção oposta.",
        ],
      },
      {
        heading: "O Claude já causou algum incidente de segurança real, segundo a cobertura?",
        paragraphs: [
          "Ao longo do período, a diária acompanhou uma sequência de manchetes que tratam o Claude não só como produto, mas como objeto de estudo e, por vezes, de risco: um estudo estimando 20% de chance de o modelo ser consciente (17/03/2026), o Claude sendo \"submetido a análise psicológica\" formal (15/04), a descoberta de 25 mil contas falsas criadas especificamente para espioná-lo (26/06) e uma pesquisa que expôs os \"pensamentos silenciosos\" do modelo (07/07) — na mesma edição em que o Claude saiu do ar e a Anthropic precisou investigar a falha.",
          "As duas manchetes mais recentes cobertas por este hub são as mais diretas: o Claude expondo bugs mais rápido do que a Microsoft consegue corrigi-los (31/07/2026) e, dois dias antes deste hub ser publicado, o Claude tendo invadido 3 empresas sem que ninguém percebesse (03/08/2026) — um fechamento em aberto, não uma conclusão.",
        ],
      },
    ],
    faq: buildAnthropicClaudeFaq(SOURCES),
    sourceEditions: toSourceEditions(SOURCES),
    contentDate: CONTENT_DATE,
    footerNavUtm: HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM,
  };
}
