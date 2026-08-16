/**
 * oracle.ts (#5125 item 4 — 7ª página de entidade, sessão `/diaria-continuo`
 * de 16/08/2026)
 *
 * `docs/entity-page-candidates.md` tinha registrado Oracle com contagem
 * bruta de 3 (regex `\boracle\b` contra título+subtítulo) — abaixo do piso
 * de `MIN_ENTITY_MENTIONS` (5), não verificada manualmente. Esta unidade
 * aplicou a MESMA técnica que desbloqueou DeepSeek na rodada anterior: grep
 * de "corpo completo" (`content.free.web`) em vez de só título+subtítulo,
 * contra TODAS as ~251 edições confirmadas do corpus
 * (`data/beehiiv-cache/posts/*.json`, auditado 15-16/08/2026). Resultado:
 * 20 edições casam a regex no corpo, das quais 5 têm parágrafo PRÓPRIO com
 * desenvolvimento real sobre a Oracle (as outras 15 são bullets de
 * "OUTRAS NOTÍCIAS" sem corpo — mesmo padrão de thin content já descartado
 * na auditoria de `deepseek.ts`/`apple.ts` — ou menções de passagem dentro
 * de listas maiores, ex: "Amazon, Alphabet, Microsoft, Meta e Oracle devem
 * investir mais de US$ 600 bi", sem desenvolvimento específico sobre a
 * Oracle).
 *
 * **As 5 menções mantidas formam um arco cronológico genuíno e raro entre
 * as entidades já publicadas — a mesma empresa muda de protagonista do
 * boom pra símbolo do risco do boom, sem que nenhuma menção seja
 * redundante com outra:**
 *   1. Setembro/2025 — o auge: contrato de US$ 300 bi com a OpenAI (o maior
 *      contrato de computação em nuvem já registrado), ação sobe 40% num
 *      único dia.
 *   2. Novembro/2025 — a 1ª rachadura: investidores vendem títulos da
 *      Oracle depois do anúncio de mais US$ 38 bi em dívida pra financiar
 *      essa mesma expansão.
 *   3. Dezembro/2025 — a dúvida version: resultados trimestrais reacendem
 *      o debate de bolha (previsão de gasto US$ 15 bi acima do esperado,
 *      ação cai até 16,5%).
 *   4. Março/2026 — dobra a aposta mesmo assim: planos de captar "dezenas
 *      de bilhões" via combinação de dívida e ações pra sustentar o
 *      crescimento dos data centers de IA.
 *   5. Agosto/2026 — o desfecho pessoal: item de RADAR sobre Larry Ellison,
 *      que "apostou a Oracle inteira" na infraestrutura de IA financiada
 *      por uma montanha de dívida, e por isso deixou de ser o homem mais
 *      rico do mundo pra virar o mais vulnerável do setor.
 *
 * O item 5 vem de uma seção RADAR (link curado com headline + 1 frase de
 * síntese própria da diária, não um bullet de "OUTRAS NOTÍCIAS" sem
 * desenvolvimento) — mesmo padrão de conteúdo que os demais formatos já
 * aceitos em `mentions` de outras entidades (a distinção que importa pro
 * critério anti-thin-content é "tem síntese própria com fato novo",
 * não "em que seção do template a menção apareceu").
 *
 * **Descartadas por thin content (bullet sem parágrafo, mesmo padrão do
 * achado original de `deepseek.ts`):** 2025-09-12 ("Oracle corta mais de
 * 3.000 empregos"), 2025-09-22 ("Parceria Oracle-Meta avalia nuvem de US$20
 * bi"), 2025-12-19 ("Por trás da ascensão e queda das ações da Oracle"),
 * 2026-01-15 ("Oracle é processada por detentores de títulos"), 2026-03-12
 * ("Oracle projeta receita de US$ 90 bilhões até 2027"), 2026-04-07
 * ("Oracle demite até 30 mil funcionários") — todas apareceram só como
 * título de bullet dentro de uma lista "OUTRAS NOTÍCIAS", sem corpo de
 * parágrafo próprio.
 *
 * **Descartadas por serem menção de passagem dentro de lista maior, sem
 * desenvolvimento específico sobre a Oracle:** 2025-12-01 (Oracle citada
 * entre "Microsoft, SoftBank, Oracle e CoreWeave" como parte do
 * ecossistema de interdependência da OpenAI), 2026-02-05 (Oracle citada
 * entre clientes do Claude Enterprise: "HP, Intuit, Oracle, State Farm,
 * Thermo Fisher e Uber"), 2026-02-09 (Oracle citada entre "Amazon,
 * Alphabet, Microsoft, Meta e Oracle" no gasto agregado de infraestrutura
 * de IA em 2026), 2026-03-17 (Oracle citada ao lado de Amazon e Block como
 * exemplo de demissão atribuída a IA, sem detalhe próprio), 2026-04-06
 * (Oracle citada entre os parceiros da iniciativa Stargate em Abu Dhabi,
 * ameaçada por drones), 2026-05-19 e 2026-07-22 (Oracle Cloud
 * Infrastructure citada como 1 de vários provedores recebendo hardware da
 * NVIDIA, sem fato específico sobre a Oracle), 2025-10-31 (Oracle citada
 * como parceira de UM supercomputador do Departamento de Energia dos EUA
 * dentro de uma matéria sobre a Nvidia atingir US$ 5 tri — Oracle é
 * coadjuvante de uma notícia que não é sobre ela).
 *
 * Não colide com `HUB_KEYWORD_PATTERNS` (`scripts/generate-hub-sources.ts`)
 * nem com nenhuma outra entidade já publicada.
 *
 * Cada `summary` foi escrito depois de ler `content.free.web` da edição
 * correspondente — nunca reformulação da manchete (mesma disciplina de
 * `perplexity.ts`/`apple.ts`/`deepseek.ts`, ver docstring de
 * `entity-page.ts` seção "Critério anti-thin-content"). Datas ESTÁTICAS —
 * mesma disciplina das demais entidades.
 */
import type { EntityContent } from "../shared/entity-page.ts";
import { ENTITY_ORACLE_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import { formatMonthYear } from "../shared/geo-faq.ts";

const MENTIONS: EntityContent["mentions"] = [
  {
    date: "2025-09-11",
    headline: "Oracle e OpenAI assinam o maior contrato de computação em nuvem da história",
    editionUrl:
      "https://diar.ia.br/p/profissionais-brasileiros-de-ti-s-o-os-menos-preocupados-com-impacto-da-ia-na-carreira",
    editionTitle:
      "Profissionais brasileiros de TI são os menos preocupados com impacto da IA na carreira",
    summary:
      "A Oracle fechou com a OpenAI um acordo de US$ 300 bilhões por cinco anos, o maior contrato de computação em nuvem já registrado — parte do projeto Stargate, para construir infraestrutura de IA com mais de 4,5 gigawatts de capacidade. A empresa revelou ainda ter assinado quatro contratos multibilionários no trimestre, e o mercado reagiu na hora: as ações da Oracle subiram 40% num único dia, o maior ganho desde 1992, somando US$ 244 bilhões ao valor de mercado da empresa.",
  },
  {
    date: "2025-11-18",
    headline: "Oracle anuncia dívida para investir em IA",
    editionUrl:
      "https://diar.ia.br/p/estudo-revela-que-ia-nao-e-segura-para-robos-pessoais-7c1465a99a9d1198",
    editionTitle: "Especial: Bolha",
    summary:
      "Dois meses depois do contrato recorde com a OpenAI, a Oracle enfrentou um sell-off em seus títulos: reportagens indicaram que a empresa planeja assumir mais US$ 38 bilhões em dívida para financiar a expansão da própria infraestrutura de nuvem e IA, e investidores reagiram vendendo os papéis por preocupação com a sustentabilidade do endividamento.",
  },
  {
    date: "2025-12-15",
    headline: "Resultados da Oracle sinalizam bolha da IA?",
    editionUrl: "https://diar.ia.br/p/revista-time-elege-pessoa-do-ano-2025",
    editionTitle: "Revista Time elege Pessoa do Ano 2025",
    summary:
      "Os resultados trimestrais da Oracle reacenderam o debate sobre bolha de IA: a empresa previu para 2026 despesas cerca de US$ 15 bilhões acima do estimado pelo mercado, o que derrubou as próprias ações em até 16,5% e contaminou outras big techs ligadas a IA — investidores passaram a questionar o descompasso entre o gasto agressivo em infraestrutura e a geração de receita capaz de sustentá-lo.",
  },
  {
    date: "2026-03-13",
    headline: "Oracle planeja captar dezenas de bilhões em dívida e ações",
    editionUrl: "https://diar.ia.br/p/perplexity-transforma-mac-mini-em-agente-de-ia-24-7",
    editionTitle: "Perplexity transforma Mac mini em agente de IA 24/7",
    summary:
      "Mesmo após o sell-off de novembro e a reação negativa a seus resultados em dezembro, a Oracle manteve o rumo: traçou planos para captar dezenas de bilhões de dólares por meio de uma combinação de dívida e emissão de ações, destinados a sustentar o crescimento dos data centers vinculados a cargas de trabalho de IA — parte de uma onda maior de emissão de dívida entre big techs (a Alphabet, no mesmo período, levantou um título com vencimento em 100 anos).",
  },
  {
    date: "2026-08-05",
    headline: "Ele foi o homem mais rico do mundo há dez meses; agora é o personagem mais vulnerável do setor de IA",
    editionUrl: "https://diar.ia.br/p/ia-por-tras-de-50-dos-cibercrimes-africanos",
    editionTitle: "IA por trás de +50% dos cibercrimes africanos",
    summary:
      "Larry Ellison, fundador da Oracle, apostou a empresa inteira na infraestrutura de inteligência artificial, financiada por uma montanha de dívida — a mesma aposta que elevou seu patrimônio pessoal ao topo do ranking mundial dez meses antes hoje o torna o bilionário mais exposto do setor, refém da volatilidade das ações da própria Oracle.",
  },
];

/** Nota de metodologia DERIVADA de `MENTIONS` — mesma disciplina de
 * `buildMethodologyNote` em `perplexity.ts`/`samsung.ts`/`apple.ts`/
 * `deepseek.ts` (cópia local pequena, não importada — ver nota de fronteira
 * em `entity-page.ts`). */
function buildMethodologyNote(mentions: EntityContent["mentions"]): string {
  const since = formatMonthYear(mentions[0].date);
  const until = formatMonthYear(mentions[mentions.length - 1].date);
  const between = since === until ? since : `${since} e ${until}`;
  return `O levantamento vem de ${mentions.length} edições publicadas entre ${between}; os números saem do arquivo da diar.ia.br, não de verificação independente junto à Oracle.`;
}

export function getOracleEntity(): EntityContent {
  return {
    slug: "oracle",
    name: "Oracle",
    metaDescription:
      "Linha do tempo da Oracle na cobertura da diar.ia.br: do contrato de US$ 300 bi com a OpenAI ao tombo nas ações que expôs Larry Ellison ao risco da bolha de IA.",
    introHeading: "Como a Oracle virou ao mesmo tempo símbolo e vítima da corrida por infraestrutura de IA?",
    introParagraph:
      "A Oracle apareceu na cobertura da diar.ia.br num arco quase didático sobre o próprio risco da bolha de IA: em setembro de 2025, o maior contrato de computação em nuvem já registrado (US$ 300 bilhões com a OpenAI, via projeto Stargate) fez as ações da empresa subirem 40% num único dia. Dois meses depois, o mesmo apetite por crescimento virou motivo de desconfiança — mais US$ 38 bilhões em dívida nova provocaram um sell-off nos títulos da companhia, e em dezembro os resultados trimestrais confirmaram o temor do mercado, derrubando as ações em até 16,5%. A Oracle respondeu dobrando a aposta, não recuando: em março de 2026 anunciou planos para captar ainda mais dezenas de bilhões via dívida e ações. O desfecho, em agosto, é pessoal — Larry Ellison, que chegou a ser o homem mais rico do mundo às custas dessa mesma aposta, passou a ser descrito como o bilionário mais vulnerável do setor, com seu patrimônio amarrado à volatilidade das próprias ações da Oracle. Esta página reúne, em ordem cronológica, cada vez que a Oracle apareceu nas edições da diária.",
    mentions: MENTIONS,
    faq: [
      {
        question: "Quantas vezes a Oracle apareceu na diar.ia.br?",
        answer: `${MENTIONS.length} vezes, entre ${formatMonthYear(MENTIONS[0].date)} e ${formatMonthYear(MENTIONS[MENTIONS.length - 1].date)} — do contrato recorde de US$ 300 bi com a OpenAI ao tombo nas ações que expôs Larry Ellison ao risco da bolha de IA.`,
      },
      {
        question: "A Oracle tem um hub temático dedicado na diar.ia.br?",
        answer:
          "Não. Os hubs temáticos (arquivo.diar.ia.br/temas) cobrem só empresas/temas com dezenas de manchetes acumuladas — Anthropic/Claude, OpenAI/ChatGPT, Google/Gemini e Meta, além de 2 temas transversais. A Oracle tem cobertura relevante mas ainda de cauda longa; esta página de entidade é o formato adequado a esse volume.",
      },
      {
        question: "Qual foi o contrato entre Oracle e OpenAI?",
        answer:
          "Em setembro de 2025, Oracle e OpenAI assinaram um acordo de US$ 300 bilhões por cinco anos — o maior contrato de computação em nuvem já registrado, parte do projeto Stargate, voltado a construir infraestrutura de IA com mais de 4,5 gigawatts de capacidade. O anúncio fez as ações da Oracle subirem 40% num único dia, o maior ganho desde 1992.",
      },
      {
        question: "Por que os investidores ficaram preocupados com a dívida da Oracle?",
        answer:
          "Em novembro de 2025, a Oracle anunciou planos de assumir mais US$ 38 bilhões em dívida para financiar a própria expansão de infraestrutura de nuvem e IA — o mercado reagiu vendendo os títulos da empresa, preocupado com a sustentabilidade desse endividamento crescente logo após o contrato recorde com a OpenAI.",
      },
      {
        question: "Como a aposta da Oracle em IA afetou Larry Ellison?",
        answer:
          "Larry Ellison, fundador da Oracle, apostou a empresa inteira na infraestrutura de inteligência artificial, financiada por uma montanha de dívida — a mesma aposta que o levou ao topo do ranking mundial de bilionários chegou a torná-lo, dez meses depois, o mais exposto do setor de IA, com o patrimônio pessoal amarrado à volatilidade das ações da Oracle.",
      },
    ],
    publishedDate: "2026-08-16",
    updatedDate: "2026-08-16",
    methodologyNote: buildMethodologyNote(MENTIONS),
    footerNavUtm: ENTITY_ORACLE_FOOTER_NAV_UTM,
  };
}
