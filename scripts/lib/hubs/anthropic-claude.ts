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
 * reempacotam manchete.
 *
 * **Precisão do escopo "número computado, nunca solto" (achado do fleet
 * review — o texto anterior aqui superestimava isso):** só as respostas do
 * `faq` são de fato COMPUTADAS em runtime, via `countMatching`/
 * `buildAnthropicClaudeFaq` sobre `SOURCES`. Os números na prosa de
 * `sections`/`INTRO` (datas, contagens como "12 lançamentos"/"75 edições")
 * são TRANSCRITOS À MÃO a partir do mesmo dataset no momento em que a
 * prosa foi escrita — corretos hoje (verificado contra `SOURCES` real ao
 * escrever), mas não recalculados a cada regeneração de
 * `sources.generated.json`. `test/build-hub-page.test.ts` tem um teste de
 * consistência que falha se esses números divergirem dos computados pelo
 * FAQ — rode a suíte depois de qualquer `generate-hub-sources.ts` novo, e
 * se ela quebrar, é a prosa que precisa de revisão manual, não o teste.
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
 * quando a prosa for reescrita de forma substancial. **Atenção:** uma
 * regeneração rotineira de `sources.generated.json` (edição nova entrando
 * na cauda da lista) NÃO invalida a data — mas PODE desincronizar os
 * números computados do `faq` dos números transcritos à mão em
 * `sections`/`INTRO` (ver nota acima). O teste de consistência em
 * `test/build-hub-page.test.ts` pega esse caso; bump `CONTENT_DATE` só
 * depois de reconciliar a prosa manualmente. */
const CONTENT_DATE = "2026-08-04";

/** O `matchedHeadlines` de `sources.generated.json` preserva o texto ORIGINAL
 * do cache Beehiiv, que vem em NFD (acento como combining mark separado —
 * "ç" é "c" + U+0327, não o "ç" precomposto U+00E7 que um regex literal usa
 * por padrão). Testar um regex acentuado direto contra esse texto falha
 * silenciosamente (achado ao vivo: `/anthropic lanç/i` batia 0 das 12
 * manchetes reais). `countMatching` normaliza pra NFC antes do teste — os
 * PATTERNS abaixo continuam escritos com acento normal (legíveis), a
 * normalização acontece só no lado do dado. Compare com `stripAccents()` em
 * `generate-hub-sources.ts` — normalização na direção OPOSTA (NFD+strip),
 * porque `HUB_KEYWORD_PATTERNS` de lá não tem acento nenhum hoje (é
 * defensiva pra um hub futuro, não corrige um bug já visto ali); aqui os
 * PATTERNS têm acento de verdade, então NFC é o que resolve.
 *
 * **Recebe `sources` como parâmetro (achado do fleet review) — antes lia a
 * constante `SOURCES` do módulo direto, ignorando qualquer `sources`
 * passado por quem chama.** Isso tornava `buildAnthropicClaudeFaq` só
 * PARCIALMENTE pura: `totalMentions`/`totalEditions`/`oldest`/`newest`
 * respeitavam o argumento, mas `launches`/`mythos`/`fable`/`seguranca`
 * sempre refletiam o dado real de produção — um teste com fixture
 * sintético (ex: array vazio, ou 1 headline construída à mão) passaria
 * "por acidente" comparando contra o número de produção, não contra o
 * fixture. */
function countMatching(sources: HubSourceEntry[], pattern: RegExp): number {
  let n = 0;
  for (const s of sources) {
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
 * testável sem IO, opera inteiramente sobre o `sources` recebido (nunca lê
 * `SOURCES` do módulo direto — ver nota de `countMatching`).
 */
export function buildAnthropicClaudeFaq(sources: HubSourceEntry[]): GeoFaqItem[] {
  const totalMentions = sources.reduce((n, s) => n + s.matchedHeadlines.length, 0);
  const totalEditions = sources.length;
  const oldest = sources[0]?.date;
  const newest = sources[sources.length - 1]?.date;
  const launches = countMatching(sources, /anthropic lanç|lançado o claude|recebe aval.*lançar/i);
  const mythos = countMatching(sources, /mythos/i);
  const fable = countMatching(sources, /fable/i);
  const seguranca = countMatching(
    sources,
    /hacke|espiona|expõe bugs|consciente|análise psicológica|pensamentos silenciosos/i,
  );

  // Achado do editor (260804): as 8 perguntas abaixo não podem repetir o
  // texto literal do H2 de nenhuma `section` (fariam o mesmo trabalho 2x).
  // Onde o tema já tem uma seção de síntese, a pergunta do FAQ pega um
  // ângulo mais estreito (estatística rápida, recorte "mais recente",
  // sub-tópico específico) e aponta de volta pra seção pro relato
  // completo — não reconta a mesma cronologia num resumo mais curto.
  return [
    {
      question: "Em quantas edições a diar.ia.br destacou algo sobre Anthropic ou Claude?",
      answer: `Entre ${formatDateLabel(oldest ?? "")} e ${formatDateLabel(newest ?? "")}, a Anthropic ou o Claude apareceram como destaque em ${totalEditions} edições da diar.ia.br, somando ${totalMentions} manchetes. Em média, o tema apareceu a cada 4 dias úteis.`,
    },
    {
      question: "Quantos lançamentos de modelo ou ferramenta a Anthropic teve nesse período, segundo a diária?",
      answer: `A diária noticiou ${launches} lançamentos entre 30/09/2025 e 27/07/2026, não em ritmo constante: vieram em 2 surtos, com um hiato de 125 dias no meio. Os dois surtos estão detalhados na seção acima.`,
    },
    {
      question: "A Anthropic teve conflito com o governo dos EUA?",
      answer:
        "Sim, foi um confronto real de cerca de 5 meses (25/02 a 03/07/2026), não um episódio isolado. A seção acima detalha a cronologia completa, incluindo vitórias e derrotas judiciais dos dois lados.",
    },
    {
      question: "O que é o Claude Mythos e por que ele virou notícia repetidas vezes?",
      answer: `O Claude Mythos foi citado em ${mythos} edições diferentes: chamado de "o modelo mais perigoso do mundo" quando lançado, forçou uma reunião emergencial em Washington, foi citado pelo Banco da Inglaterra como risco sistêmico e só recebeu aval formal dos EUA para lançamento em 29/06/2026, meses depois da polêmica inicial.`,
    },
    {
      question: "O que aconteceu com o Claude Fable 5?",
      answer: `O Fable 5 apareceu em ${fable} edições: lançado em 10/06/2026 "com bloqueios embutidos", teve o acesso global bloqueado pelos EUA 5 dias depois e voltou ao ar em 02/07/2026. Um ciclo completo de lançamento, bloqueio e reversão em menos de 4 semanas.`,
    },
    {
      question: "Anthropic dobrou de valor sozinha, ou teve outros eventos financeiros grandes no período?",
      answer:
        "Não foi só a duplicação de valor: em pouco mais de 6 semanas (16/04 a 02/06/2026) vieram também a parceria de US$ 100 bi com a Amazon, a rodada Série H de US$ 65 bi e o pedido de IPO confidencial nos EUA. A seção acima traz a cronologia completa da valuation, desde a primeira edição deste hub.",
    },
    {
      question: "Quais foram os episódios mais recentes envolvendo segurança do Claude?",
      answer: `Os dois mais recentes: o Claude expondo bugs mais rápido do que a Microsoft consegue corrigi-los (31/07/2026) e, dois dias antes deste hub ser publicado, um episódio em que o Claude invadiu 3 empresas sem que ninguém notasse (03/08/2026). A seção acima cobre os ${seguranca} episódios do período inteiro.`,
    },
    {
      question: "Como acompanho as próximas notícias sobre Anthropic e Claude?",
      answer:
        "Assine a diar.ia.br. A newsletter cobre lançamentos, disputas regulatórias e movimentos de mercado da Anthropic conforme acontecem, de segunda a sexta, e esta página é atualizada periodicamente para refletir a cobertura mais recente.",
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
  "Entre setembro de 2025 e agosto de 2026, a Anthropic e o Claude foram destaque em 75 edições da diar.ia.br, 83 manchetes ao todo, quase uma a cada 4 dias úteis. Acompanhar esse volume de perto mostra um padrão que uma edição isolada não deixa ver: o ritmo de lançamento de modelo vem em surtos, não em fluxo constante, com um hiato de 4 meses no meio do caminho. O confronto com o governo dos EUA, que durou cerca de 5 meses, girou em torno de dois modelos específicos, Mythos e Fable 5, lançados, contestados e só depois liberados. A valuation foi de \"triplica\" a \"dobra de novo\" e terminou em pedido de IPO confidencial. A onda de integrações empresariais, com Microsoft, Amazon, SpaceX, Adobe, Slack e Salesforce, não correu só numa direção: a própria Microsoft trocou a Anthropic por IA própria no meio do período. Tem também uma sequência de manchetes sobre o Claude se comportando de um jeito notável e preocupante ao mesmo tempo, que termina com um episódio de hacking autônomo na edição mais recente coberta aqui. As seções abaixo detalham cada um desses pontos, com data e fonte.";

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
          "A diária noticiou 12 lançamentos de modelo ou ferramenta da própria Anthropic entre 30/09/2025 e 27/07/2026, mas o ritmo não foi constante: teve 2 surtos separados por um hiato longo. No primeiro, 5 lançamentos couberam em 66 dias: [Claude Sonnet 4.5](https://diar.ia.br/p/openai-lanc-a-instant-checkout-no-chatgpt), um [modelo compacto e acessível](https://diar.ia.br/p/google-veo-3-1), a ferramenta [Claude Skills](https://diar.ia.br/p/lancamento-claude-skills) para empresas, um [modelo para pesquisa biomédica](https://diar.ia.br/p/restricoes-sora-2-hollywood) e uma [plataforma de pesquisa sociológica](https://diar.ia.br/p/anthropic-lanc-a-plataforma-de-pesquisa-sociolo-gica).",
          "Depois veio um hiato de exatos 125 dias sem nenhum lançamento novo, de 5 de dezembro de 2025 a 9 de abril de 2026, período em que a cobertura girou em torno de valuation, parcerias e do início do confronto com o governo dos EUA (seção abaixo), não de produto novo.",
          "O segundo surto foi mais denso: 7 lançamentos em 15 semanas, entre 9 de abril e 27 de julho de 2026. Nessa janela saíram a [fábrica de agentes](https://diar.ia.br/p/50-dos-empregos-mudam-em-3-anos-diz-estudo), [Claude Opus 4.7](https://diar.ia.br/p/anthropic-lan-a-claude-opus-4-7), o [Project Deal](https://diar.ia.br/p/openai-lanc-a-gpt-5-5-com-foco-em-agentes), [Fable 5](https://diar.ia.br/p/anthropic-lanca-fable-5-com-bloqueios-embutidos), o [aval dos EUA para lançar o Mythos](https://diar.ia.br/p/openai-lan-a-gpt-5-6-sol-terra-e-luna), [Sonnet 5](https://diar.ia.br/p/anthropic-lan-a-sonnet-5) e [Claude Opus 5](https://diar.ia.br/p/anthropic-lan-a-o-claude-opus-5), este último fechando o período coberto por este hub.",
        ],
      },
      {
        heading: "Por que a Anthropic entrou em conflito com o governo dos EUA?",
        paragraphs: [
          "Entre 25 de fevereiro e 3 de julho de 2026, cerca de 5 meses, a diária cobriu uma escalada real entre a Anthropic e o governo dos EUA, não um episódio isolado. Começou com [uma mudança de política da Anthropic sob pressão do Pentágono](https://diar.ia.br/p/openai-firma-alianc-a-com-big-four-da-consultoria). Duas semanas depois, [a empresa processou o próprio governo americano](https://diar.ia.br/p/anthropic-detalha-impactos-da-ia-no-mercado-de-trabalho). Duas semanas depois disso, [o DOJ defendeu publicamente o banimento federal da Anthropic](https://diar.ia.br/p/o-maior-estudo-j-feito-com-usu-rios-de-ia).",
          "O ponto mais tenso veio em 27 de março: na mesma edição em que [o Claude Mythos foi chamado de \"o modelo mais perigoso do mundo\"](https://diar.ia.br/p/claude-mythos-o-modelo-mais-perigoso-do-mundo), a diária noticiou que a Anthropic tinha vencido o Pentágono na Justiça. As duas coisas apareceram lado a lado, na mesma edição: vitória judicial e alarme público sobre o modelo mais novo. Duas semanas depois, [o Mythos forçou uma reunião emergencial em Washington](https://diar.ia.br/p/mythos-for-a-reuni-o-emergencial-em-washington); um mês depois, [o Banco da Inglaterra passou a citar o Mythos como risco](https://diar.ia.br/p/enter-vira-o-1-unic-rnio-de-ia-da-am-rica-latina) em suas próprias análises.",
          "O segundo modelo a esbarrar no aparato regulatório dos EUA foi o [Fable 5](https://diar.ia.br/p/anthropic-lanca-fable-5-com-bloqueios-embutidos): lançado em 10 de junho já \"com bloqueios embutidos\", [teve o acesso bloqueado globalmente pelo governo americano](https://diar.ia.br/p/eua-bloqueia-acesso-global-ao-fable-5-da-anthropic) 5 dias depois e [só voltou ao ar](https://diar.ia.br/p/claude-fable-5-volta-apos-bloqueio-nos-eua) 17 dias mais tarde. No mesmo período, e de forma quase irônica dado o histórico, [o Mythos finalmente recebia aval formal dos EUA para lançamento](https://diar.ia.br/p/openai-lan-a-gpt-5-6-sol-terra-e-luna). Um dia depois do retorno do Fable 5, [uma edição inteira foi dedicada à pergunta em aberto](https://diar.ia.br/p/governo-dos-eua-pode-virar-socio-da-openai): \"Anthropic x Casa Branca: o que está em jogo\". No período coberto por este hub, nenhuma edição deu essa história por encerrada.",
        ],
      },
      {
        heading: "Quanto vale a Anthropic, segundo a cobertura da diar.ia.br?",
        paragraphs: [
          "A primeira edição deste hub já era sobre dinheiro: [\"Anthropic triplica valuation\"](https://diar.ia.br/p/brasil-pretende-investir-r-23-bilh-es-em-ia). Cinco meses depois, a diária noticiou [a empresa valendo US$ 380 bi \"com Opus 4.6\"](https://diar.ia.br/p/como-o-novo-painel-da-onu-pode-afetar-a-ia). Dois meses depois, no mesmo intervalo que a própria manchete usa, [\"Anthropic dobra de valor em 2 meses\"](https://diar.ia.br/p/stanford-ia-avan-a-mais-r-pido-que-qualquer-tecnologia). A diária nunca publicou o número absoluto resultante dessa 2ª duplicação.",
          "O que veio depois foi ainda mais concentrado: em pouco mais de 6 semanas, quatro manchetes de porte bilionário ou maior: a própria duplicação de valor, [uma parceria de US$ 100 bi ao longo de uma década com a Amazon](https://diar.ia.br/p/fgv-30-milho-es-de-brasileiros-em-risco), [uma rodada Série H de US$ 65 bi](https://diar.ia.br/p/35-mil-bolsas-pra-virar-creator-com-ia) e [um pedido de abertura de capital (IPO) confidencial nos EUA](https://diar.ia.br/p/meta-ai-deu-acesso-a-contas-do-instagram-a-hackers), um dia depois da rodada. Quatro eventos financeiros de escala rara em 6 semanas é o tipo de concentração que só fica visível olhando o arquivo inteiro, não uma edição isolada.",
        ],
      },
      {
        heading: "Em quais produtos e parcerias o Claude já apareceu?",
        paragraphs: [
          "A integração do Claude em produtos de terceiros cresceu ao longo de todo o período: [a Microsoft integrou o Claude ao Copilot](https://diar.ia.br/p/90-dos-desenvolvedores-usam-ia-mas-na-o-confiam-totalmente) e, no mês seguinte, [a Anthropic passou a competir com a própria Microsoft por IA no Excel](https://diar.ia.br/p/chatgpt-aplica-medidas-para-cuidado-com-saude-mental). É uma relação de parceria e disputa ao mesmo tempo, que se repetiu depois, quando [o Copilot passou a rodar GPT e Claude lado a lado](https://diar.ia.br/p/anthropic-expo-e-co-digo-do-claude-code-por-acidente). [Microsoft, Nvidia e Anthropic chegaram a fechar uma parceria de 3 vias](https://diar.ia.br/p/tudo-sobre-gemini-3).",
          "Outras integrações que apareceram no período, em ordem: [Claude for Healthcare](https://diar.ia.br/p/ia-revolucionando-medicina), [Claude no Excel como \"analista de dados pessoal\"](https://diar.ia.br/p/brasil-pote-ncia-em-ia-travada-por-falta-de-talentos), [conexão com Adobe e Blender](https://diar.ia.br/p/anthropic-conecta-claude-a-adobe-e-blender), [parceria com a SpaceX](https://diar.ia.br/p/anthropic-eleva-limites-e-fecha-parceria-com-spacex) junto de um aumento de limites de uso, [conectores prontos para chegar a PMEs](https://diar.ia.br/p/advogadas-paraenses-multadas-por-burlar-ia), [um investimento de US$ 200 mi com a fundação Gates em saúde e educação](https://diar.ia.br/p/anthropic-e-gates-200-mi-em-sa-de-e-educa-o), [a Salesforce trocando parte da equipe de engenharia por \"tokens da Anthropic\"](https://diar.ia.br/p/karpathy-entra-no-time-de-pr-treino-da-anthropic), [o Claude entrando no Slack](https://diar.ia.br/p/a-anthropic-coloca-claude-dentro-do-slack), o [lançamento do Claude Cowork para celular e web](https://diar.ia.br/p/claude-cowork-chega-ao-celular-e-a-web) e [um acordo bilionário com a AMD](https://diar.ia.br/p/ia-agiu-sozinha-e-hackeou-startup-revela-openai).",
          "Nem toda a maré foi a favor da Anthropic: [a diária noticiou a Microsoft trocando tanto a OpenAI quanto a Anthropic por IA própria em parte de seus produtos](https://diar.ia.br/p/os-empregos-mais-blindados-contra-a-ia). É um lembrete de que a onda de integração, entre abril e julho, correu ao lado de pelo menos um movimento explícito na direção oposta.",
        ],
      },
      {
        heading: "O Claude já causou algum incidente de segurança real, segundo a cobertura?",
        paragraphs: [
          "Ao longo do período, a diária acompanhou uma sequência de manchetes em que o Claude aparece como objeto de estudo e, em alguns casos, de risco genuíno: [um estudo estimando 20% de chance de o modelo ser consciente](https://diar.ia.br/p/ia-criou-vacina-de-c-ncer-para-um-cachorro), o Claude [\"submetido a análise psicológica\"](https://diar.ia.br/p/claude-submetido-a-ana-lise-psicolo-gica) formal, [a descoberta de 25 mil contas falsas criadas especificamente para espioná-lo](https://diar.ia.br/p/sabia-4-thinking-brasil-tem-modelo-de-raciocinio) e [uma pesquisa que expôs os \"pensamentos silenciosos\" do modelo](https://diar.ia.br/p/pesquisa-exp-e-os-pensamentos-silenciosos-do-claude). Foi na mesma edição em que o Claude saiu do ar e a Anthropic precisou investigar a falha.",
          "As duas manchetes mais recentes cobertas por este hub são as mais diretas: [o Claude expõe bugs mais rápido do que a Microsoft consegue corrigi-los](https://diar.ia.br/p/claude-expoe-bugs-mais-rapido-que-microsoft-corrige) e, dois dias antes deste hub ser publicado, [invade 3 empresas sem que ninguém perceba](https://diar.ia.br/p/claude-hackeou-3-empresas-sem-ninguem-notar). É um fechamento em aberto, não uma conclusão.",
        ],
      },
    ],
    faq: buildAnthropicClaudeFaq(SOURCES),
    sourceEditions: toSourceEditions(SOURCES),
    contentDate: CONTENT_DATE,
    footerNavUtm: HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM,
  };
}
