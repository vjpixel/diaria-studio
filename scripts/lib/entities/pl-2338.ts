/**
 * pl-2338.ts (#8350 — 1º lote de entidades brasileiras, Opção A do editor)
 *
 * Ver `tse.ts` para o recorte do lote. Contagem (12/11/2026, texto completo de
 * `workers/site/public/p/*\/index.html`, 306 edições): 10 edições pela regex
 * estreita `\bPL\s*2\.?338\b|marco legal da (inteligência artificial|IA)`, a
 * mesma família de termo da tabela do #8350; 15 pela regex ampla
 * `marco legal|PL da IA|2\.?338|Aguinaldo Ribeiro`, que pega também as
 * edições que chamam o projeto só de "lei de regulação da IA" com o relator
 * nomeado. 12 entraram depois da leitura manual. Ficaram de fora:
 *
 *   - 22/05/2026 ("Senado aprova marco legal da IA no Brasil",
 *     `soberania-ia-pu-blica-nacional`): a edição tratou como notícia do mês
 *     uma aprovação que, pela tramitação oficial (senado.leg.br, matéria
 *     157233), ocorreu em 10/12/2024. A mesma correção já está documentada no
 *     hub `brasil-regulacao` (#5060). Registrada em `ENTITY_EXCLUDED_EDITIONS`.
 *   - 14/05/2026 e 26/05/2026: o projeto aparece só de passagem, numa frase
 *     de contexto ("tramitando na Câmara", "tramita no Congresso") dentro de
 *     notícias sobre outro assunto.
 *
 * Fronteira com hub (#8350, comentário de 18/09/2026): "PL 2338 / marco legal
 * da IA" era a candidata mais perto de virar hub temático. Esta página fica
 * no formato de entidade: a linha do tempo de UM projeto de lei nomeado, sem
 * seções temáticas nem síntese de regulação em geral. A leitura temática é o
 * hub `brasil-regulacao`, linkado na metodologia e no FAQ.
 *
 * Datas das menções = `published_time` do arquivo do site. Cada `summary` foi
 * escrito depois de ler o corpo da edição e a errata da edição seguinte
 * (01/06/2026 chamou Hugo Motta de presidente do Senado; a errata corrigiu
 * para presidente da Câmara, e o `summary` usa o cargo correto).
 */
import type { EntityContent } from "../shared/entity-page.ts";
import { entityFooterNavUtm } from "../shared/utm-registry.ts";
import { formatMonthYear } from "../shared/geo-faq.ts";

const MENTIONS: EntityContent["mentions"] = [
  {
    date: "2025-09-10",
    headline: "Congresso brasileiro debate IA generativa e direitos autorais",
    editionUrl: "https://diar.ia.br/p/estudo-de-harvard-estima-92-mi-de-empregos-esta-o-em-risco",
    editionTitle: "Estudo de Harvard estima: 92 mi de empregos estão em risco",
    summary:
      "A Comissão Especial de IA da Câmara fez audiência pública em 9 de setembro de 2025 sobre o capítulo de direitos autorais do projeto. Pelo texto em discussão, só instituições de pesquisa, jornalismo, museus, bibliotecas e organizações educacionais poderiam usar obras protegidas livremente no treino de modelos; nos demais casos, seria preciso autorização dos titulares.",
  },
  {
    date: "2025-12-08",
    headline: 'Brasileiros querem regras para IA, mas rejeitam "freios" à inovação, revela pesquisa',
    editionUrl: "https://diar.ia.br/p/como-os-brasileiros-veem-a-ia",
    editionTitle: "Como os brasileiros veem a IA?",
    summary:
      "Pesquisa do Instituto Locomotiva com a OpenAI, com 1.000 entrevistados, mostrou que 68% consideravam a regulação necessária desde que não travasse a inovação, e que 64% temiam que regras rígidas afastassem empresas estrangeiras. A edição publicou o levantamento como pano de fundo da votação do projeto, então dada como próxima.",
  },
  {
    date: "2025-12-18",
    headline: "Acordo adia votação da IA para 2026",
    editionUrl: "https://diar.ia.br/p/conhe-a-slop-a-palavra-do-ano",
    editionTitle: 'Conheça "slop", a palavra do ano',
    summary:
      "Hugo Motta, presidente da Câmara, Luísa Canziani, presidente da comissão especial de IA, e o relator Aguinaldo Ribeiro fecharam um acordo para votar o texto nas primeiras semanas de fevereiro de 2026, depois do recesso. O calendário apertado tinha impedido a análise em 2025, e a meta passou a ser aprovar na comissão e no plenário antes do Carnaval.",
  },
  {
    date: "2026-01-02",
    headline: "Regulação no Brasil",
    editionUrl: "https://diar.ia.br/p/tend-ncias-2026",
    editionTitle: "Tendências 2026",
    summary:
      "Na edição de tendências do ano, a diar.ia.br apontou 2026 como o ano da votação do Marco Legal da IA, que estabeleceria para o país uma governança de sistemas de IA baseada em risco.",
  },
  {
    date: "2026-02-04",
    headline: "Marco Legal da IA: decisões que moldarão o Brasil",
    editionUrl: "https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes",
    editionTitle: "TSE avalia força-tarefa para coibir deepfakes",
    summary:
      "Com votação prevista na Câmara, o texto previa classificação de sistemas por risco, mineração de dados com opção de recusa (opt-out), multas de até 2% do faturamento com teto de R$ 50 milhões, responsabilidade objetiva para sistemas de alto risco e limites ao reconhecimento facial. A criação de um Sistema Nacional de IA ainda estava em disputa quanto à autonomia do órgão.",
  },
  {
    date: "2026-04-28",
    headline: "PL 2338/23 IA: O Que a Regulamentação Significa para Sua Empresa em 2026",
    editionUrl: "https://diar.ia.br/p/meta-perde-manus-por-ordem-de-pequim",
    editionTitle: "Meta perde Manus por ordem de Pequim",
    summary:
      "Em Outras Notícias, a edição indicou uma análise sobre o efeito do projeto nas empresas, com foco nas exigências de transparência e responsabilidade para quem opera chatbots e automação pelo WhatsApp.",
  },
  {
    date: "2026-05-06",
    headline: "Câmara vota marco legal da IA em 27 de maio",
    editionUrl: "https://diar.ia.br/p/gpt-5-5-instant-chega-como-padr-o-do-chatgpt",
    editionTitle: "GPT-5.5 Instant chega como padrão do ChatGPT",
    summary:
      "A Câmara marcou a votação para 27 de maio, com o relatório final previsto para o dia 19. A edição lembrou que a eleição de outubro pressionava contra um novo adiamento e que, aprovado pelos deputados, o texto seguiria para o Senado.",
  },
  {
    date: "2026-05-12",
    headline: "Regulação da IA no Brasil: o que fazer antes da nova lei",
    editionUrl: "https://diar.ia.br/p/brasil-70-da-geracao-z-usa-chatgpt-todo-mes",
    editionTitle: "Brasil: 70% da Geração Z usa ChatGPT todo mês",
    summary:
      "Em Outras Notícias, um guia prático das medidas de compliance e de gestão de risco que as empresas deveriam adotar antes da aprovação esperada do marco legal.",
  },
  {
    date: "2026-05-18",
    headline: "Direitos autorais ameaçados no marco da IA",
    editionUrl: "https://diar.ia.br/p/chatgpt-ganha-recurso-de-finan-as-pessoais",
    editionTitle: "ChatGPT ganha recurso de finanças pessoais",
    summary:
      "Mais de 50 entidades do setor cultural, lideradas por ABRA, API e GEDAR, protestaram contra a retirada do capítulo de direitos autorais do projeto, que deixaria sem regra o uso de obras protegidas no treino de modelos. A votação estava marcada para maio, mas o texto voltou para revisão.",
  },
  {
    date: "2026-06-01",
    headline: "Marco de IA vai a voto na Câmara em junho",
    editionUrl: "https://diar.ia.br/p/35-mil-bolsas-pra-virar-creator-com-ia",
    editionTitle: "Santander abre 35 mil vagas grátis para creators",
    summary:
      "Hugo Motta, presidente da Câmara, quis levar o texto a voto em junho, e o relator Aguinaldo Ribeiro (PP-PB) passou a negociar a redação com senadores antes do plenário, para reduzir a chance de divergência entre as duas Casas.",
  },
  {
    date: "2026-06-16",
    headline: "Padrões internacionais de IA moldam o marco regulatório brasileiro antes de sua aprovação",
    editionUrl: "https://diar.ia.br/p/sp-vai-mapear-surtos-de-dengue-por-bairro",
    editionTitle: "SP vai mapear surtos de dengue por bairro",
    summary:
      "No Radar, uma análise da convergência do projeto com o AI Act europeu em classificação por risco, lista de práticas proibidas e obrigações de transparência.",
  },
  {
    date: "2026-08-25",
    headline: "Sem Marco Legal, ANPD e setores avançam na regulação da IA",
    editionUrl: "https://diar.ia.br/p/brasil-investe-r-2-3-bi-em-infraestrutura-de-ia",
    editionTitle: "Brasil investe R$ 2,3 bi em infraestrutura de IA",
    summary:
      "Com o projeto ainda sem aprovação, a ANPD abriu um sandbox regulatório com três empresas selecionadas e reguladores setoriais passaram a editar normas próprias, num arcabouço que a análise citada pela edição descreveu como fragmentado.",
  },
];

/** Nota de metodologia DERIVADA de `MENTIONS` — mesma disciplina de
 * `buildMethodologyNote` em `perplexity.ts`. Carrega a ressalva da edição de
 * 22/05/2026 (fora da linha do tempo, ver docstring do módulo). */
function buildMethodologyNote(mentions: EntityContent["mentions"]): string {
  const since = formatMonthYear(mentions[0].date);
  const until = formatMonthYear(mentions[mentions.length - 1].date);
  const between = since === until ? since : `${since} e ${until}`;
  return `O levantamento vem de ${mentions.length} edições publicadas entre ${between}; os fatos saem do arquivo da diar.ia.br. A edição de 22/05/2026 tratou como notícia daquele mês a aprovação do texto pelo Senado, que segundo a tramitação oficial ([senado.leg.br](https://www25.senado.leg.br/web/atividade/materias/-/materia/157233)) ocorreu em 10/12/2024, e por isso ficou fora desta linha do tempo. A leitura temática da regulação de IA no Brasil está no [hub de regulação](https://arquivo.diar.ia.br/temas/brasil-regulacao).`;
}

export function getPl2338Entity(): EntityContent {
  return {
    slug: "pl-2338",
    name: "Marco Legal da IA (PL 2338)",
    metaDescription:
      "O PL 2338/2023, o Marco Legal da IA, na cobertura da diar.ia.br: direitos autorais, votações adiadas na Câmara e o que o texto prevê.",
    introHeading: "Em que pé está o Marco Legal da IA, o PL 2338?",
    introParagraph:
      "O PL 2338/2023, conhecido como Marco Legal da IA, é o projeto que define regras para sistemas de inteligência artificial no Brasil. O Senado o aprovou em dezembro de 2024, e desde então o texto está na Câmara dos Deputados. A diar.ia.br acompanhou essa etapa a partir da audiência sobre direitos autorais de setembro de 2025. A votação foi marcada para fevereiro de 2026, remarcada para 27 de maio e depois para junho, sem acontecer. Em maio, mais de 50 entidades culturais protestaram contra a retirada do capítulo de direitos autorais, e o relator passou a negociar o texto com os senadores. A versão em discussão classifica sistemas por risco e prevê multas de até 2% do faturamento. Em agosto de 2026 o projeto seguia parado, e a ANPD e os reguladores setoriais começaram a criar regras por conta própria. Esta página reúne, em ordem cronológica, cada vez que o projeto apareceu nas edições da diária.",
    mentions: MENTIONS,
    faq: [
      {
        question: "O que é o PL 2338?",
        answer:
          "É o projeto de lei 2338/2023, chamado de Marco Legal da IA, que regulamenta o uso de sistemas de inteligência artificial no Brasil. A versão em tramitação em 2026 previa classificação por risco, responsabilidade objetiva para sistemas de alto risco, limites ao reconhecimento facial e multas de até 2% do faturamento, com teto de R$ 50 milhões.",
      },
      {
        question: "Em que fase está o Marco Legal da IA?",
        answer:
          "O Senado aprovou o texto em dezembro de 2024 e o enviou à Câmara dos Deputados. Lá, a votação foi marcada para fevereiro de 2026, depois para 27 de maio e então para junho, sem se concretizar. Na menção mais recente desta página, em agosto de 2026, o projeto seguia sem aprovação.",
      },
      {
        question: "O que o projeto diz sobre direitos autorais no treino de IA?",
        answer:
          "O texto discutido na Câmara em setembro de 2025 liberava o uso de obras protegidas só para pesquisa, jornalismo, museus, bibliotecas e educação, exigindo autorização dos titulares nos demais casos. Em maio de 2026, mais de 50 entidades culturais protestaram contra a retirada desse capítulo do projeto.",
      },
      {
        question: "Quantas vezes o Marco Legal da IA apareceu na diar.ia.br?",
        answer: `${MENTIONS.length} vezes nesta linha do tempo, entre ${formatMonthYear(MENTIONS[0].date)} e ${formatMonthYear(MENTIONS[MENTIONS.length - 1].date)}.`,
      },
      {
        question: "Onde está a cobertura mais ampla sobre regulação de IA no Brasil?",
        answer:
          "No hub temático de [regulação de IA no Brasil](https://arquivo.diar.ia.br/temas/brasil-regulacao), que reúne o Marco Legal, as regras do TSE para a eleição e as normas setoriais. Esta página acompanha só o projeto de lei.",
      },
    ],
    publishedDate: "2026-11-12",
    updatedDate: "2026-11-12",
    methodologyNote: buildMethodologyNote(MENTIONS),
    footerNavUtm: entityFooterNavUtm("pl-2338"),
  };
}
