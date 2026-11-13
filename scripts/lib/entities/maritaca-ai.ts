/**
 * maritaca-ai.ts (#8350 — 1º lote de entidades brasileiras, Opção A do editor)
 *
 * Ver `tse.ts` para o recorte do lote. A Maritaca AI entrou no lote ABAIXO do
 * piso de `MIN_ENTITY_MENTIONS` (5) por decisão registrada no #8350
 * (comentário de 18/09/2026): é uma das duas candidatas com impressão medida
 * no GSC (a consulta "sabiá 4 thinking" chegou à posição 8), e o teste é
 * justamente se uma página de entidade nichada ranqueia. A exceção vai no
 * campo `mentionFloorException`, validado contra
 * `MIN_ENTITY_MENTIONS_WITH_EXCEPTION`.
 *
 * Contagem (12/11/2026, texto completo de `workers/site/public/p/*\/index.html`,
 * 306 edições, regex `\bMaritaca\b|\bSabi[áa]-?\s?\d`): 4 edições, todas
 * com conteúdo real. Duas são cobertura direta (o lançamento do Sabiá 4
 * Thinking e o Sabiazinho-4), uma é a retrospectiva mensal de junho e uma é
 * um item do Use Melhor que lista a Maritaca entre assistentes gratuitos.
 * Os demais acertos de "Sabiá" no site são links de navegação
 * ("Anterior"/"Próxima") para a edição do Sabiá 4 Thinking, não menções.
 *
 * Cada `summary` foi escrito depois de ler o corpo da edição e a errata da
 * edição seguinte. Datas ESTÁTICAS.
 *
 * Alarme de staleness (`ENTITY_KEYWORD_PATTERNS["maritaca-ai"]` em
 * `patterns.ts`) NÃO reproduz a regex de contagem acima: acrescenta
 * `sabiazinho`, porque o "Sabiazinho-4" não casa `sabia[- ]?\d` (há letras
 * entre "sabia" e o número) e é justamente o nome de produto que uma manchete
 * nova traria sem citar "Maritaca". E o alarme só vê título+subtítulo do
 * cache, enquanto a contagem foi feita no texto completo — limitação #12958.
 */
import { MIN_ENTITY_MENTIONS, type EntityContent } from "../shared/entity-page.ts";
import { entityFooterNavUtm } from "../shared/utm-registry.ts";
import { formatMonthYear } from "../shared/geo-faq.ts";

const MENTIONS: EntityContent["mentions"] = [
  {
    date: "2026-06-26",
    headline: "Sabiá 4 Thinking: Brasil tem modelo de raciocínio",
    editionUrl: "https://diar.ia.br/p/sabia-4-thinking-brasil-tem-modelo-de-raciocinio",
    editionTitle: "Sabiá 4 Thinking: Brasil tem modelo de raciocínio",
    summary:
      "A startup brasileira lançou um modelo de raciocínio otimizado para o português, disponível em chat e por API. Ele processa a resposta em etapas antes de entregar o resultado, técnica que ajuda em análise jurídica, síntese de documentos e problemas com vários passos lógicos, e chega para disputar com o GPT-5.4 e o Gemini as empresas que lidam com contratos, laudos e atendimento em português.",
  },
  {
    date: "2026-07-12",
    headline: "Entre a dependência e o modelo nacional",
    editionUrl: "https://diar.ia.br/p/a-diar-ia-br-normalmente-te-conta-o-dia-hoje-ela-conta-o-mes",
    editionTitle: "A diar.ia.br normalmente te conta o dia... hoje, ela conta o mês",
    summary:
      "Na retrospectiva de junho, o Sabiá 4 Thinking apareceu como contraponto ao modelo lançado pela Prefeitura do Rio, que horas depois se revelou uma fusão de dois modelos chineses prontos. A leitura do mês: entre o modelo real de uma startup e a fusão desmascarada de uma prefeitura, o gargalo do Brasil na IA era técnico, e não político.",
  },
  {
    date: "2026-09-11",
    headline: "Startups brasileiras criam modelos de IA menores e mais baratos que gigantes globais",
    editionUrl: "https://diar.ia.br/p/10-mil-agentes-da-openai-resolvem-enigma-de-90-anos",
    editionTitle: "10 mil agentes da OpenAI resolvem enigma de 90 anos",
    summary:
      "No Radar: a Maritaca lançou o Sabiazinho-4, modelo especializado em legislação brasileira que chegou a 85% de acurácia em testes baseados no exame da OAB, a um custo bem menor que o de modelos internacionais equivalentes.",
  },
  {
    date: "2026-10-26",
    headline: "Sem pagar nada: 6 IAs que fazem o trabalho do ChatGPT e podem turbinar a sua produtividade",
    editionUrl: "https://diar.ia.br/p/hackers-usam-claude-e-grok-contra-bancos",
    editionTitle: "Hackers usam Claude e Grok contra bancos",
    summary:
      "No Use Melhor, a edição indicou um comparativo de assistentes com versão gratuita que coloca a Maritaca ao lado de Gemini, Copilot, Claude, Perplexity e Meta AI, cobrindo usos que vão da pesquisa à escrita de textos.",
  },
];

/** Nota de metodologia DERIVADA de `MENTIONS` — mesma disciplina de
 * `buildMethodologyNote` em `perplexity.ts`. */
function buildMethodologyNote(mentions: EntityContent["mentions"]): string {
  const since = formatMonthYear(mentions[0].date);
  const until = formatMonthYear(mentions[mentions.length - 1].date);
  const between = since === until ? since : `${since} e ${until}`;
  return `O levantamento vem de ${mentions.length} edições publicadas entre ${between}; os números saem do arquivo da diar.ia.br, não de verificação independente junto à Maritaca AI.`;
}

export function getMaritacaAiEntity(): EntityContent {
  return {
    slug: "maritaca-ai",
    name: "Maritaca AI",
    metaDescription:
      "A Maritaca AI na cobertura da diar.ia.br: o Sabiá 4 Thinking, modelo de raciocínio em português, e o Sabiazinho-4, treinado em legislação brasileira.",
    introHeading: "O que a Maritaca AI lançou?",
    introParagraph:
      "A Maritaca AI é uma startup brasileira que desenvolve modelos de linguagem próprios, treinados para o português. Na diar.ia.br ela aparece quase sempre como exemplo de modelo desenvolvido no Brasil. O Sabiá 4 Thinking, lançado em junho de 2026, levou o raciocínio em etapas a um modelo otimizado para o português e serviu, na retrospectiva do mês, de contraponto ao modelo da Prefeitura do Rio desmascarado como fusão de dois modelos chineses. Em setembro veio o Sabiazinho-4, menor e especializado em legislação brasileira, que acertou 85% em testes baseados no exame da OAB. Esta página reúne, em ordem cronológica, cada vez que a Maritaca apareceu nas edições da diária.",
    mentions: MENTIONS,
    faq: [
      {
        question: "O que é o Sabiá 4 Thinking?",
        answer:
          "Um modelo de linguagem com raciocínio em etapas, otimizado para o português brasileiro, lançado pela Maritaca AI em junho de 2026. Está disponível em chat e por API e mira tarefas como análise jurídica, síntese de documentos e atendimento em português.",
      },
      {
        question: "O que é o Sabiazinho-4?",
        answer:
          "Um modelo menor da Maritaca AI, especializado em legislação brasileira, que chegou a 85% de acurácia em testes baseados no exame da OAB, a um custo bem menor que o de modelos internacionais equivalentes.",
      },
      {
        question: "A Maritaca AI tem versão gratuita?",
        answer:
          "Sim. Um comparativo indicado pela diar.ia.br em outubro de 2026 lista a Maritaca entre seis assistentes de IA com versão gratuita, ao lado de Gemini, Copilot, Claude, Perplexity e Meta AI.",
      },
      {
        question: "Quantas vezes a Maritaca AI apareceu na diar.ia.br?",
        answer: `${MENTIONS.length} vezes, entre ${formatMonthYear(MENTIONS[0].date)} e ${formatMonthYear(MENTIONS[MENTIONS.length - 1].date)}.`,
      },
    ],
    publishedDate: "2026-11-12",
    updatedDate: "2026-11-12",
    methodologyNote: buildMethodologyNote(MENTIONS),
    footerNavUtm: entityFooterNavUtm("maritaca-ai"),
    mentionFloorException: `Teste de entidade nichada brasileira aprovado no #8350 (18/09/2026): a Maritaca AI tem impressão medida no GSC e entra com ${MENTIONS.length} menções, abaixo do piso de ${MIN_ENTITY_MENTIONS}.`,
  };
}
