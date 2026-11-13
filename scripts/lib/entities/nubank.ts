/**
 * nubank.ts (#8350 — 1º lote de entidades brasileiras, Opção A do editor)
 *
 * Ver `tse.ts` para o recorte do lote. Contagem (12/11/2026, texto completo de
 * `workers/site/public/p/*\/index.html`, 306 edições, regex `\bNubank\b`):
 * 9 edições brutas, 7 depois da leitura manual do corpo. Ficaram de fora:
 *
 *   - 29/09/2025 (`openai-cria-assistente-proativo`): o Nubank aparece só como
 *     cliente de uma startup de defesa jurídica e como referência de
 *     investimento do Founders Fund em 2016, sem fato próprio do banco.
 *   - 26/06/2026 (`sabia-4-thinking-brasil-tem-modelo-de-raciocinio`): é a
 *     errata do concurso de erros ("Nubak"), não cobertura.
 *
 * A edição de 25/06/2026 trouxe "Nubak" no corpo como erro intencional; o
 * `summary` usa o nome correto. Cada `summary` foi escrito depois de ler o
 * corpo da edição e a errata da edição seguinte (a de 11/11/2026 foi
 * conferida contra `_internal/intentional-error.json` da edição, porque a
 * errata ainda não tinha saído no arquivo do site). Datas ESTÁTICAS.
 */
import type { EntityContent } from "../shared/entity-page.ts";
import { entityFooterNavUtm } from "../shared/utm-registry.ts";
import { formatMonthYear } from "../shared/geo-faq.ts";

const MENTIONS: EntityContent["mentions"] = [
  {
    date: "2025-12-16",
    headline: "Deixou Stanford e vendeu startup ao Nubank",
    editionUrl: "https://diar.ia.br/p/agora-qualquer-fone-pode-ser-um-tradutor-ao-vivo",
    editionTitle: "Agora qualquer fone pode ser um tradutor ao vivo",
    summary:
      "Felipe Meneses, de Aracaju, primeiro brasileiro selecionado pelo Thiel Fellowship, deixou Stanford em 2022 para tocar a Hyperplane, startup de IA bancária que depois foi comprada pelo Nubank. Ao sair da Hyperplane, ele fundou um novo negócio de IA com Vitor Olivier, ex-CTO do banco.",
  },
  {
    date: "2026-06-18",
    headline: "Nubank prepara assistente financeiro pessoal",
    editionUrl: "https://diar.ia.br/p/sistema-do-google-iguala-m-dicos-em-teste",
    editionTitle: "Sistema do Google iguala médicos em teste",
    summary:
      "O banco confirmou um assistente com recomendações personalizadas de gastos, crédito e investimentos para uma base de mais de 100 milhões de clientes no Brasil. Segundo a edição, modelos de linguagem já participavam da decisão de crédito, classificando o risco com mais detalhe que os métodos tradicionais.",
  },
  {
    date: "2026-06-25",
    headline: 'Nubank exige "mentalidade de IA" para contratar',
    editionUrl: "https://diar.ia.br/p/gemini-3-5-flash-agora-controla-seu-computador",
    editionTitle: "Gemini 3.5 Flash agora controla seu computador",
    summary:
      "Ellen Kiss, diretora do centro de design do banco, disse que o Nubank passou a priorizar candidatos que já usam IA no dia a dia para resolver problemas reais. O volume de vagas não caiu; o que mudou foi o filtro, com as ferramentas generativas tratadas como pré-requisito e não mais como diferencial.",
  },
  {
    date: "2026-07-23",
    headline: "Fundador do Nubank entra para o conselho da OpenAI",
    editionUrl: "https://diar.ia.br/p/ia-agiu-sozinha-e-hackeou-startup-revela-openai",
    editionTitle: "IA agiu sozinha e hackeou startup, revela OpenAI",
    summary:
      "A OpenAI nomeou David Vélez, fundador do Nubank, e Robin Vince, CEO do BNY, para o seu conselho, sem detalhar os critérios da escolha. Segundo a edição, foi a primeira vez que um executivo latino-americano ocupou uma cadeira no conselho da empresa.",
  },
  {
    date: "2026-08-19",
    headline: "Nubank abre 50 vagas de estágio com foco em inteligência artificial",
    editionUrl: "https://diar.ia.br/p/tse-exige-aviso-em-propaganda-eleitoral-com-ia",
    editionTitle: "TSE exige aviso em propaganda eleitoral com IA",
    summary:
      "No Radar: o programa de estágio com foco em IA abriu 50 vagas em Minas Gerais, no Rio de Janeiro e em São Paulo, para estudantes que querem aplicar IA, dados e código em problemas reais.",
  },
  {
    date: "2026-10-22",
    headline: "Nubank dá nota de até mil para sua carteira",
    editionUrl: "https://diar.ia.br/p/claude-projetou-proteinas-contra-veneno-de-escorpiao",
    editionTitle: "Claude projetou proteínas contra veneno de escorpião",
    summary:
      "O Nu Smart Invest avalia a carteira de investimentos em cinco pilares (diversificação, rentabilidade, liquidez, proteção e eficiência), dá uma nota de até mil pontos e explica cada sugestão de ajuste, sem comprar nada sozinho. O recurso é gratuito, exige R$ 1 investido e foi liberado aos poucos, só no Brasil.",
  },
  {
    date: "2026-11-11",
    headline: "Nubank demite time antifraude e põe IA no lugar",
    editionUrl: "https://diar.ia.br/p/nubank-demite-time-antifraude-e-poe-ia-no-lugar",
    editionTitle: "Nubank demite time antifraude e põe IA no lugar",
    summary:
      "O banco demitiu parte da equipe que rastreava contas laranjas depois que ferramentas de IA reduziram em 80% a fila de reclamações sobre golpes, segundo a Folha de S.Paulo. O número de cortes diverge: a Folha fala em pouco mais de 30, ex-funcionários citam cerca de 100, e o Nubank nega esse total e chama o caso de reestruturação natural.",
  },
];

/** Nota de metodologia DERIVADA de `MENTIONS` — mesma disciplina de
 * `buildMethodologyNote` em `perplexity.ts`. */
function buildMethodologyNote(mentions: EntityContent["mentions"]): string {
  const since = formatMonthYear(mentions[0].date);
  const until = formatMonthYear(mentions[mentions.length - 1].date);
  const between = since === until ? since : `${since} e ${until}`;
  return `O levantamento vem de ${mentions.length} edições publicadas entre ${between}; os números saem do arquivo da diar.ia.br, não de verificação independente junto ao Nubank.`;
}

export function getNubankEntity(): EntityContent {
  return {
    slug: "nubank",
    name: "Nubank",
    metaDescription:
      "O Nubank na cobertura da diar.ia.br: da compra da Hyperplane ao assistente financeiro, ao Nu Smart Invest e aos cortes no time antifraude.",
    introHeading: "Como o Nubank está usando IA?",
    introParagraph:
      "O Nubank aparece na cobertura da diar.ia.br em várias frentes de IA. A primeira menção é uma aquisição: a Hyperplane, startup de IA bancária criada por um brasileiro que largou Stanford. Depois vieram os produtos, um assistente financeiro pessoal para mais de 100 milhões de clientes e o Nu Smart Invest, que dá nota de até mil pontos à carteira de investimentos. O banco também mudou a forma de contratar, com a exigência de \"mentalidade de IA\" e um programa de estágio na área, e em julho de 2026 o fundador David Vélez entrou para o conselho da OpenAI. A menção mais recente é a menos confortável: a demissão de parte do time antifraude depois que a IA encolheu a fila de reclamações sobre golpes. Esta página reúne, em ordem cronológica, cada vez que o Nubank apareceu nas edições da diária.",
    mentions: MENTIONS,
    faq: [
      {
        question: "Quantas vezes o Nubank apareceu na diar.ia.br?",
        answer: `${MENTIONS.length} vezes, entre ${formatMonthYear(MENTIONS[0].date)} e ${formatMonthYear(MENTIONS[MENTIONS.length - 1].date)}, da compra da Hyperplane aos cortes no time antifraude.`,
      },
      {
        question: "O que é o Nu Smart Invest?",
        answer:
          "Uma ferramenta gratuita do Nubank, lançada em outubro de 2026, que avalia a carteira de investimentos do cliente em cinco pilares, dá uma nota de até mil pontos e sugere ajustes explicados ativo por ativo. Ela não faz compras sozinha e exige só R$ 1 investido.",
      },
      {
        question: "O Nubank demitiu funcionários por causa da IA?",
        answer:
          "Segundo a Folha de S.Paulo, citada pela edição de 11 de novembro de 2026, o banco demitiu parte do time que investigava fraudes depois que ferramentas de IA reduziram em 80% a fila de reclamações sobre golpes. O número de cortes é disputado, e o Nubank chama o caso de reestruturação natural.",
      },
      {
        question: "Quem do Nubank entrou para o conselho da OpenAI?",
        answer:
          "David Vélez, fundador do banco, nomeado em julho de 2026 junto com Robin Vince, CEO do BNY.",
      },
      {
        question: "O que o Nubank exige de quem quer trabalhar lá?",
        answer:
          "Além das competências de cada área, o banco passou a priorizar candidatos com \"mentalidade de IA\", gente que já usa modelos no dia a dia para resolver problemas, segundo Ellen Kiss, diretora do centro de design, em junho de 2026.",
      },
    ],
    publishedDate: "2026-11-12",
    updatedDate: "2026-11-12",
    methodologyNote: buildMethodologyNote(MENTIONS),
    footerNavUtm: entityFooterNavUtm("nubank"),
  };
}
