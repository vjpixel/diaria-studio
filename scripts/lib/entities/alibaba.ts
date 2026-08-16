/**
 * alibaba.ts (#5125 item 4 — 8ª página de entidade, sessão `/diaria-continuo`
 * de 16/08/2026)
 *
 * `docs/entity-page-candidates.md` tinha registrado Alibaba com contagem
 * bruta de 3 (regex `\balibaba\b` contra título+subtítulo) — abaixo do
 * piso de `MIN_ENTITY_MENTIONS` (5), não verificada manualmente. Esta
 * unidade aplicou a MESMA técnica que desbloqueou DeepSeek e Oracle na
 * mesma rodada: grep de "corpo completo" (`content.free.web`) em vez de só
 * título+subtítulo, contra TODAS as ~251 edições confirmadas do corpus
 * (`data/beehiiv-cache/posts/*.json`, auditado 16/08/2026). Resultado: 21
 * edições casam a regex no corpo, das quais 6 têm parágrafo/seção PRÓPRIA
 * com desenvolvimento real sobre a Alibaba.
 *
 * **As 6 menções mantidas formam um arco de ambição tecnológica seguida de
 * controvérsia — a laboratório chinesa que mais tentou provar independência
 * de hardware e liderança em open source, até ser flagrada usando o
 * concorrente americano de forma antiética:**
 *   1. Setembro/2025 — independência de hardware: chip próprio de IA, numa
 *      resposta direta às sanções americanas, com a receita de nuvem
 *      crescendo 26% no trimestre.
 *   2. Setembro/2025 (mesmo mês, fato distinto) — liderança em open source:
 *      3 modelos lançados simultaneamente, 32 recordes de benchmark
 *      quebrados, posicionando a Alibaba como referência em IA multimodal
 *      aberta.
 *   3. Novembro/2025 — diversificação de produto: entrada no mercado de
 *      wearables com os óculos de IA Quark, competindo em ecossistema
 *      chinês integrado (compras, pagamentos, navegação).
 *   4. Dezembro/2025 — evolução contínua do modelo: atualização Qwen 3,
 *      com foco em edição visual e pesquisa profunda autônoma.
 *   5. Junho/2026 — a virada de tom: acusada pela Anthropic, em carta ao
 *      Congresso dos EUA, de operar 25 mil contas falsas para extrair
 *      dados do Claude em escala.
 *   6. Agosto/2026 — de volta à corrida de modelos, já sob a sombra da
 *      controvérsia: lançamento do Qwen 3.8-Max (2,4 trilhões de
 *      parâmetros), ação sobe, mas o item de RADAR reforça a disputa
 *      chinesa pela liderança em IA, não mais só a ambição isolada da
 *      Alibaba.
 *
 * **Descartadas por thin content (bullet sem parágrafo, mesmo padrão do
 * achado original de `deepseek.ts`/`oracle.ts`):** 2025-09-09 ("Alibaba
 * lança Qwen-3-Max-Preview com 1 trilhão de parâmetros"), 2025-09-12
 * ("Alibaba e Baidu começam a usar seus próprios chips"), 2025-09-25
 * ("Alibaba anuncia investimento de US$ 50 bilhões em IA"), 2025-09-26
 * ("Alibaba anuncia parceria com Nvidia e expansão global de data
 * centers"), 2025-10-24 ("Alibaba lança rival do ChatGPT e óculos
 * inteligentes por US$ 660"), 2026-02-13 ("Alibaba revela modelo de IA
 * física, RynnBrain"), 2026-07-06 ("Alibaba proíbe funcionários de usar
 * ferramenta de IA da Anthropic") — todas apareceram só como título de
 * bullet dentro de uma lista "OUTRAS NOTÍCIAS"/RADAR sem desenvolvimento
 * de parágrafo, ou (2026-02-18, 2026-04-07) como item de seção "Mapa de
 * lançamentos" com descrição técnica genérica sem fato jornalístico novo.
 *
 * **Descartadas por serem menção de passagem dentro de texto sobre outra
 * empresa, sem desenvolvimento específico sobre a Alibaba:** 2025-11-07
 * (Alibaba citada só como uma das apoiadoras do Kimi K2 da Moonshot, que é
 * quem desenvolveu o modelo), 2026-02-02 (bullet de "Mapa de lançamentos"
 * sem corpo), 2026-04-06 (Alibaba citada ao lado de Moonshot e Z.AI como
 * pressão competitiva genérica sobre o Google, sem fato específico da
 * Alibaba — mesmo falso-positivo já documentado em `deepseek.ts` pra essa
 * mesma edição), 2026-06-10 (Alibaba citada de passagem numa lista de
 * modelos chineses/ocidentais dentro de uma fala sobre a estratégia do
 * Brasil em IA), 2026-07-12 (menção vem do resumo mensal, que reformula o
 * fato já coberto — e melhor detalhado — na edição diária de 2026-06-26,
 * mantida como a fonte primária).
 *
 * Não colide com `HUB_KEYWORD_PATTERNS` (`scripts/generate-hub-sources.ts`)
 * nem com nenhuma outra entidade já publicada.
 *
 * Cada `summary` foi escrito depois de ler `content.free.web` da edição
 * correspondente — nunca reformulação da manchete (mesma disciplina de
 * `perplexity.ts`/`apple.ts`/`deepseek.ts`/`oracle.ts`, ver docstring de
 * `entity-page.ts` seção "Critério anti-thin-content"). Datas ESTÁTICAS —
 * mesma disciplina das demais entidades.
 */
import type { EntityContent } from "../shared/entity-page.ts";
import { ENTITY_ALIBABA_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import { formatMonthYear } from "../shared/geo-faq.ts";

const MENTIONS: EntityContent["mentions"] = [
  {
    date: "2025-09-04",
    headline: "Alibaba Desenvolve Chip Próprio de IA",
    editionUrl: "https://diar.ia.br/p/xai-processa-ex-engenheiro-por-roubo-de-segredos-comerciais",
    editionTitle: "xAI processa ex-engenheiro por roubo de segredos comerciais",
    summary:
      "A Alibaba desenvolveu um novo chip próprio de IA, sinalizando a estratégia chinesa de autoconfiança tecnológica diante das sanções americanas a semicondutores avançados — o movimento aconteceu no mesmo trimestre em que a receita de computação em nuvem da empresa cresceu 26%, fragmentando ainda mais a cadeia de suprimentos global de semicondutores.",
  },
  {
    date: "2025-09-24",
    headline: "Alibaba lança três modelos de open source e quebra 32 recordes",
    editionUrl: "https://diar.ia.br/p/alibaba-lanc-a-tre-s-modelos-de-open-source-e-quebra-32-recordes",
    editionTitle: "Alibaba lança três modelos de open source e quebra 32 recordes",
    summary:
      "A Alibaba liberou simultaneamente três modelos de IA em código aberto, superando referências como Gemini-2.5-Pro e GPT-4o-Transcribe em benchmarks — um lançamento triplo que posicionou a empresa como líder em IA multimodal open source, democratizando acesso a tecnologia até então concentrada em modelos proprietários ocidentais.",
  },
  {
    date: "2025-11-27",
    headline: "Alibaba entra na corrida global de wearables com lançamento dos óculos Quark AI",
    editionUrl: "https://diar.ia.br/p/alibaba-entra-no-mercado-de-wereables",
    editionTitle: "Alibaba entra no mercado de wereables",
    summary:
      "A Alibaba lançou os óculos de IA Quark, entrando na corrida global de wearables com uma proposta distinta da dos concorrentes ocidentais: uma alternativa mais acessível, profundamente integrada ao ecossistema digital chinês (compras, pagamentos, navegação) e alimentada pelo modelo Qwen, pensada mais como assistente de vida do que como gadget isolado.",
  },
  {
    date: "2025-12-23",
    headline: "Qwen 3: IA multimodal",
    editionUrl: "https://diar.ia.br/p/o-dia-em-que-claude-virou-dono-de-loja",
    editionTitle: "O dia em que Claude virou dono de loja",
    summary:
      "A Alibaba Cloud atualizou o ecossistema Qwen 3 com novas ferramentas de edição visual e pesquisa profunda, transformando o assistente numa central de criatividade e análise capaz de \"desmontar\" imagens em camadas editáveis e realizar pesquisas complexas na web de forma autônoma.",
  },
  {
    date: "2026-06-26",
    headline: "25 mil contas falsas para espionar o Claude",
    editionUrl: "https://diar.ia.br/p/sabia-4-thinking-brasil-tem-modelo-de-raciocinio",
    editionTitle: "Sabiá 4 Thinking: Brasil tem modelo de raciocínio",
    summary:
      "A Anthropic enviou uma carta ao Congresso dos EUA acusando a Alibaba de montar uma operação com 25 mil contas falsas para extrair dados do Claude em larga escala, criadas especificamente para contornar os limites de uso da plataforma — a 1ª controvérsia de conduta a marcar a cobertura da empresa na diária, depois de uma sequência de menções só sobre lançamento de produto.",
  },
  {
    date: "2026-08-04",
    headline: "Qwen 3.8-Max: Alibaba lança modelo de IA mais avançado até o momento",
    editionUrl: "https://diar.ia.br/p/hacker-chines-usa-deepseek-em-ataques-autonomos",
    editionTitle: "Hacker chinês usa DeepSeek em ataques autônomos",
    summary:
      "A Alibaba lançou o Qwen 3.8-Max, com 2,4 trilhões de parâmetros, o modelo mais avançado da linha até então — as ações da empresa subiram na notícia, e a cobertura volta a enquadrar o lançamento como parte da corrida mais ampla da China pela liderança em inteligência artificial, não mais como uma conquista isolada da Alibaba.",
  },
];

/** Nota de metodologia DERIVADA de `MENTIONS` — mesma disciplina de
 * `buildMethodologyNote` em `perplexity.ts`/`samsung.ts`/`apple.ts`/
 * `deepseek.ts`/`oracle.ts` (cópia local pequena, não importada — ver nota
 * de fronteira em `entity-page.ts`). */
function buildMethodologyNote(mentions: EntityContent["mentions"]): string {
  const since = formatMonthYear(mentions[0].date);
  const until = formatMonthYear(mentions[mentions.length - 1].date);
  const between = since === until ? since : `${since} e ${until}`;
  return `O levantamento vem de ${mentions.length} edições publicadas entre ${between}; os números saem do arquivo da diar.ia.br, não de verificação independente junto à Alibaba.`;
}

export function getAlibabaEntity(): EntityContent {
  return {
    slug: "alibaba",
    name: "Alibaba",
    metaDescription:
      "Linha do tempo da Alibaba na cobertura da diar.ia.br: do chip próprio de IA e da liderança em open source à acusação de 25 mil contas falsas contra o Claude.",
    introHeading: "Como a Alibaba passou de líder em IA aberta a alvo de uma acusação de conduta antiética?",
    introParagraph:
      "A Alibaba apareceu na cobertura da diar.ia.br sobretudo como a laboratório chinesa mais empenhada em provar independência tecnológica: um chip próprio de IA em resposta às sanções americanas, três modelos de código aberto lançados de uma vez batendo 32 recordes de benchmark, uma entrada na corrida global de wearables com óculos de IA integrados ao ecossistema chinês, e atualizações contínuas da linha Qwen. Esse arco de ambição tecnológica mudou de tom em junho de 2026: a Anthropic acusou publicamente a empresa, em carta ao Congresso dos EUA, de operar 25 mil contas falsas para extrair dados do Claude em larga escala — a 1ª controvérsia de conduta a marcar a cobertura da Alibaba, depois de uma sequência de menções só sobre lançamento de produto. Mesmo assim, a corrida por modelos continuou: em agosto, o lançamento do Qwen 3.8-Max (2,4 trilhões de parâmetros) voltou a colocar a empresa na cobertura, já enquadrada como parte da disputa chinesa mais ampla pela liderança em IA, não mais como conquista isolada. Esta página reúne, em ordem cronológica, cada vez que a Alibaba apareceu nas edições da diária.",
    mentions: MENTIONS,
    faq: [
      {
        question: "Quantas vezes a Alibaba apareceu na diar.ia.br?",
        answer: `${MENTIONS.length} vezes, entre ${formatMonthYear(MENTIONS[0].date)} e ${formatMonthYear(MENTIONS[MENTIONS.length - 1].date)} — do chip próprio de IA à acusação de 25 mil contas falsas usadas para extrair dados do Claude.`,
      },
      {
        question: "A Alibaba tem um hub temático dedicado na diar.ia.br?",
        answer:
          "Não. Os hubs temáticos (arquivo.diar.ia.br/temas) cobrem só empresas/temas com dezenas de manchetes acumuladas — Anthropic/Claude, OpenAI/ChatGPT, Google/Gemini e Meta, além de 2 temas transversais. A Alibaba tem cobertura relevante mas ainda de cauda longa; esta página de entidade é o formato adequado a esse volume.",
      },
      {
        question: "Por que a Anthropic acusou a Alibaba de usar contas falsas?",
        answer:
          "Em junho de 2026, a Anthropic enviou uma carta ao Congresso dos EUA acusando a Alibaba de montar uma operação com 25 mil contas falsas, criadas especificamente para contornar os limites de uso do Claude e extrair dados da plataforma em larga escala — a 1ª controvérsia de conduta registrada na cobertura da empresa pela diar.ia.br.",
      },
      {
        question: "O que é o Qwen, da Alibaba?",
        answer:
          "Qwen é a linha de modelos de IA da Alibaba Cloud, atualizada continuamente — de lançamentos de código aberto que quebraram 32 recordes de benchmark em setembro de 2025 até o Qwen 3.8-Max, com 2,4 trilhões de parâmetros, lançado em agosto de 2026 como o modelo mais avançado da linha até então.",
      },
      {
        question: "A Alibaba desenvolveu um chip próprio de IA?",
        answer:
          "Sim. Em setembro de 2025 a Alibaba revelou um novo chip próprio de processamento de IA, parte da estratégia chinesa de reduzir a dependência de semicondutores americanos diante das sanções de exportação — o anúncio aconteceu no mesmo trimestre em que a receita de computação em nuvem da empresa cresceu 26%.",
      },
    ],
    publishedDate: "2026-08-16",
    updatedDate: "2026-08-16",
    methodologyNote: buildMethodologyNote(MENTIONS),
    footerNavUtm: ENTITY_ALIBABA_FOOTER_NAV_UTM,
  };
}
