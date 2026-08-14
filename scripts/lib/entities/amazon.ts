/**
 * amazon.ts (#5125 item 4 — lote pequeno pós-decisão do editor 14/08/2026)
 *
 * 2ª entidade publicada nesta rodada de escala reduzida (~3 de ~20 páginas
 * planejadas — ver `docs/entity-page-candidates.md` para o ranking completo
 * e as candidatas restantes). Mesma disciplina do PoC de Perplexity
 * (`scripts/lib/entities/perplexity.ts`): candidata de CAUDA LONGA — 8
 * menções confirmadas no corpus (`data/beehiiv-cache/posts/*.json`,
 * auditado 14/08/2026) via regex `\bamazon\b|\baws\b|jeff bezos|andy
 * jassy` contra título+subtítulo, acima do piso de `MIN_ENTITY_MENTIONS`
 * (5) e abaixo do lastro de qualquer hub temático existente (12-84
 * manchetes cada). Não colide com nenhum `HUB_KEYWORD_PATTERNS`
 * (`scripts/generate-hub-sources.ts`) — Amazon/AWS/Bezos não aparecem em
 * nenhum dos 6 hubs publicados.
 *
 * **Achado de verificação (mesma disciplina "leia o corpo, não confie no
 * título" da docstring de `perplexity.ts`):** o candidato inicial tinha 8
 * matches por regex, mas 1 deles ("OpenAI pode desenvolver rival do Amazon
 * Echo", edição de 2025-09-22) nunca ganhou parágrafo próprio no corpo —
 * era só um item de manchete secundária sem desenvolvimento. A MESMA
 * edição, porém, tinha um parágrafo real e substantivo sobre a Amazon (um
 * estudo da AWS sobre adoção de IA no Brasil) que a regex também casava
 * (via `\baws\b`) — usado no lugar, preservando as 8 menções sem violar o
 * critério anti-thin-content (`summary` sempre lido do corpo real, nunca
 * do título).
 *
 * Cada `summary` foi escrito depois de ler `content.free.web` da edição
 * correspondente. Datas ESTÁTICAS — mesma disciplina de `perplexity.ts`.
 */
import type { EntityContent } from "../shared/entity-page.ts";
import { ENTITY_AMAZON_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import { formatMonthYear } from "../shared/geo-faq.ts";

const MENTIONS: EntityContent["mentions"] = [
  {
    date: "2025-09-22",
    headline: "Como está a adoção de IA no Brasil?",
    editionUrl: "https://diar.ia.br/p/ai-conquista-ouro-e-prata-em-competicao-mundial-de-programacao-527a9d74fc6e833e",
    editionTitle: "Pesquisa mostra: IA pode mentir de propósito",
    summary:
      "Um estudo encomendado pela AWS mediu a adoção de IA nas empresas brasileiras: 40% já integravam a tecnologia nas operações, alta de 29% sobre o ano anterior, com 95% relatando aumento médio de receita de 31% e 96% citando ganhos de produtividade — embora a maioria ainda usasse a IA só em funções básicas, como automação de processos e atendimento ao cliente.",
  },
  {
    date: "2025-10-20",
    headline: "AWS sofre queda que paralisa inúmeros serviços online",
    editionUrl: "https://diar.ia.br/p/aws-sofre-queda",
    editionTitle: "AWS sofre queda que paralisa inúmeros serviços online",
    summary:
      "Uma falha de resolução DNS no endpoint do DynamoDB, na região US-EAST-1, tirou do ar 28 serviços da AWS e paralisou por horas grandes plataformas que dependem da nuvem da Amazon — OpenAI, Perplexity e Character.AI entre as afetadas. Mais de 1.000 empresas reportaram 6,5 milhões de relatos de interrupção, expondo o quanto da internet global depende de poucos provedores gigantes de nuvem.",
  },
  {
    date: "2025-10-23",
    headline: "Amazon desenvolve óculos inteligentes com IA para entregadores",
    editionUrl: "https://diar.ia.br/p/google-skills-plataforma-com-cursos-de-ia-gratuitos",
    editionTitle: "Google Skills: plataforma com cursos de IA gratuitos",
    summary:
      "A Amazon anunciou o desenvolvimento de óculos inteligentes por visão computacional para os Delivery Associates que fazem suas entregas — o dispositivo permite escanear pacotes, seguir rotas passo a passo e registrar prova de entrega sem precisar do celular, desenhado com feedback de entregadores que testaram versões iniciais.",
  },
  {
    date: "2025-11-04",
    headline: "OpenAI assina acordo de US$ 38 bilhões com Amazon AWS",
    editionUrl: "https://diar.ia.br/p/unesp-organiza-debate-musica-ia",
    editionTitle: "Unesp organiza debate sobre IA na música nesta semana",
    summary:
      "A OpenAI firmou um contrato de sete anos, avaliado em US$ 38 bilhões, com a AWS — a maior diversificação de provedor de nuvem da empresa além da Microsoft, dando acesso a milhares de GPUs Nvidia via infraestrutura da Amazon. As ações da Amazon subiram 4% após o anúncio, seu melhor desempenho em dois dias desde novembro de 2022.",
  },
  {
    date: "2025-11-05",
    headline: "Perplexity desafia Amazon: ameaça legal sobre IA agêntica versus direitos do usuário",
    editionUrl: "https://diar.ia.br/p/data-centers-no-espaco",
    editionTitle: "Projeto quer lançar data centers de no espaço",
    summary:
      "A Amazon ameaçou legalmente a Perplexity para impedir que usuários do assistente agêntico Comet fizessem compras na Amazon usando login próprio guardado localmente no dispositivo — a Perplexity chamou a postura de bullying corporativo, no que descreveu como o primeiro confronto jurídico direto entre uma varejista grande e uma empresa de IA agêntica.",
  },
  {
    date: "2025-11-27",
    headline: "Amazon investirá até US$ 50 bilhões em supercomputação de IA para o governo dos EUA",
    editionUrl: "https://diar.ia.br/p/alibaba-entra-no-mercado-de-wereables",
    editionTitle: "Alibaba entra no mercado de wereables",
    summary:
      "A AWS anunciou plano de investir até US$ 50 bilhões para expandir a infraestrutura de supercomputação de IA dedicada ao governo dos Estados Unidos, adicionando cerca de 1,3 gigawatt de capacidade para agências civis e de defesa — a empresa já atendia mais de 11 mil clientes governamentais e buscava blindar essa liderança frente à concorrência da Microsoft Azure e do Google Cloud.",
  },
  {
    date: "2026-03-02",
    headline: "Bezos e o Projeto Prometheus",
    editionUrl: "https://diar.ia.br/p/banimento-de-trump-tem-efeito-inverso",
    editionTitle: "Banimento de Trump tem efeito inverso",
    summary:
      "Jeff Bezos, fundador da Amazon, começou a estruturar em silêncio uma nova empreitada separada da Amazon — batizada Projeto Prometheus — levantando bilhões de dólares para automatizar operações de indústrias e manufaturas tradicionais com IA, indo além do software de escritório e mirando cadeias produtivas e logística pesada.",
  },
  {
    date: "2026-04-23",
    headline: "Amazon e Anthropic: US$ 100 bilhões em uma década",
    editionUrl: "https://diar.ia.br/p/fgv-30-milho-es-de-brasileiros-em-risco",
    editionTitle: "FGV: 30 milhões de brasileiros em risco",
    summary:
      "A Amazon anunciou investimento adicional de US$ 5 bilhões na Anthropic e compromisso de mais de US$ 100 bilhões em despesas de AWS ao longo de uma década, incluindo acesso a múltiplos gigawatts de TPUs de próxima geração — a Anthropic ancora sua expansão de infraestrutura na nuvem da Amazon em vez de construir data centers próprios, reforçando o bloco Amazon-Anthropic frente à aliança Microsoft-OpenAI.",
  },
];

/** Nota de metodologia DERIVADA de `MENTIONS` — mesma disciplina de
 * `buildMethodologyNote` em `perplexity.ts` (cópia local pequena, não
 * importada — ver nota de fronteira em `entity-page.ts`). */
function buildMethodologyNote(mentions: EntityContent["mentions"]): string {
  const since = formatMonthYear(mentions[0].date);
  const until = formatMonthYear(mentions[mentions.length - 1].date);
  const between = since === until ? since : `${since} e ${until}`;
  return `O levantamento vem de ${mentions.length} edições publicadas entre ${between}; os números saem do arquivo da diar.ia.br, não de verificação independente junto à Amazon.`;
}

export function getAmazonEntity(): EntityContent {
  return {
    slug: "amazon",
    name: "Amazon",
    metaDescription:
      "Linha do tempo da Amazon na cobertura da diar.ia.br: a queda da AWS, os acordos bilionários com OpenAI e Anthropic e o confronto com a Perplexity.",
    introHeading: "Como a Amazon virou peça central da corrida de infraestrutura de IA?",
    introParagraph:
      "A Amazon entrou na cobertura da diar.ia.br como fornecedora silenciosa de nuvem — um estudo sobre a adoção de IA nas empresas brasileiras via AWS — antes de uma falha na própria AWS derrubar parte da internet global e expor o quanto a rede depende de poucos provedores gigantes. De lá em diante, a empresa apareceu tanto como fornecedora de infraestrutura para outras gigantes de IA (o acordo de US$ 38 bilhões com a OpenAI, o compromisso de US$ 100 bilhões com a Anthropic, os US$ 50 bilhões em supercomputação para o governo americano) quanto como parte interessada numa disputa sobre até onde um assistente agêntico pode ir dentro do próprio site da Amazon — o confronto com a Perplexity. No meio do caminho, o fundador Jeff Bezos apareceu levantando capital para uma aposta pessoal, separada da empresa, em automação industrial. Esta página reúne, em ordem cronológica, cada vez que a Amazon apareceu nas edições da diária.",
    mentions: MENTIONS,
    faq: [
      {
        question: "Quantas vezes a Amazon apareceu na diar.ia.br?",
        answer: `${MENTIONS.length} vezes, entre ${formatMonthYear(MENTIONS[0].date)} e ${formatMonthYear(MENTIONS[MENTIONS.length - 1].date)} — de um estudo sobre adoção de IA no Brasil até o compromisso de US$ 100 bilhões com a Anthropic.`,
      },
      {
        question: "A Amazon tem um hub temático dedicado na diar.ia.br?",
        answer:
          "Não. Os hubs temáticos (arquivo.diar.ia.br/temas) cobrem só empresas/temas com dezenas de manchetes acumuladas — Anthropic/Claude, OpenAI/ChatGPT, Google/Gemini e Meta, além de 2 temas transversais. A Amazon tem cobertura relevante mas ainda de cauda longa; esta página de entidade é o formato adequado a esse volume.",
      },
      {
        question: "Qual foi a maior polêmica envolvendo a Amazon coberta pela diária?",
        answer:
          "O confronto com a Perplexity em novembro de 2025, quando a Amazon ameaçou legalmente impedir que usuários do assistente agêntico Comet fizessem compras no site da Amazon usando login próprio guardado localmente — a Perplexity chamou a postura de bullying corporativo.",
      },
      {
        question: "Quanto a Amazon já comprometeu em outras empresas de IA, segundo a cobertura?",
        answer:
          "Pelo menos US$ 138 bilhões em compromissos anunciados: US$ 38 bilhões num acordo de nuvem de sete anos com a OpenAI (novembro de 2025) e mais de US$ 100 bilhões em despesas de AWS ao longo de uma década com a Anthropic (abril de 2026), fora os US$ 50 bilhões em supercomputação prometidos ao governo americano.",
      },
      {
        question: "O que é o Projeto Prometheus de Jeff Bezos?",
        answer:
          "Uma empreitada separada da Amazon que Jeff Bezos começou a estruturar em março de 2026, levantando bilhões de dólares para automatizar operações de indústrias e manufaturas tradicionais com IA — foco em cadeias produtivas e logística pesada, não em software de escritório.",
      },
    ],
    publishedDate: "2026-08-14",
    updatedDate: "2026-08-14",
    methodologyNote: buildMethodologyNote(MENTIONS),
    footerNavUtm: ENTITY_AMAZON_FOOTER_NAV_UTM,
  };
}
