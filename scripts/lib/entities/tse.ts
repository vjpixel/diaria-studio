/**
 * tse.ts (#8350 — 1º lote de entidades brasileiras, Opção A do editor)
 *
 * Lote de entidades nichadas/brasileiras aprovado no #8350 (comentários de
 * 18/09/2026 e 19/09/2026): as 3 candidatas com mais menções no acervo entre
 * {PL 2338, TSE, Nubank, STF, SUS}, mais Maritaca AI e ReGLab.
 *
 * Contagem (12/11/2026, texto completo de `workers/site/public/p/*\/index.html`,
 * 306 edições, regex `\bTSE\b|Tribunal Superior Eleitoral`): 14 edições
 * brutas, 10 depois da leitura manual do corpo. As 4 descartadas não falam do
 * tribunal: 3 só citam o TSE no bloco de links internos "Mais sobre..." do
 * rodapé (31/08, 17/09 e 05/10/2026) e 1 é a errata do concurso de erros
 * ("no texto sobre o TSE, chamei ele de STF", 30/04/2026).
 *
 * Sobreposição conhecida com os hubs `brasil-regulacao` e `deepfake` (4
 * manchetes de TSE entram nos dois): o hub é a leitura temática; esta página
 * é a linha do tempo de UM órgão nomeado, no molde das 8 entidades
 * internacionais. A metodologia linka os dois hubs.
 *
 * A edição de 29/04/2026 chamou o tribunal de STF por engano (erro
 * intencional, corrigido na errata da edição seguinte); o `summary` usa o
 * nome correto. Cada `summary` foi escrito depois de ler o corpo da edição e
 * a errata publicada na edição seguinte. Datas ESTÁTICAS, mesma disciplina
 * de `perplexity.ts`.
 */
import type { EntityContent } from "../shared/entity-page.ts";
import { entityFooterNavUtm } from "../shared/utm-registry.ts";
import { formatMonthYear } from "../shared/geo-faq.ts";

const MENTIONS: EntityContent["mentions"] = [
  {
    date: "2026-01-07",
    headline: "IA nas eleições 2026 - risco à desinformação",
    editionUrl: "https://diar.ia.br/p/ia-nas-eleicoes-prepare-se-para-os-deepfakes",
    editionTitle: "IA nas eleições: prepare-se para os deepfakes",
    summary:
      "Heloisa Massaro, diretora do InternetLab, previu que a IA generativa agravaria a desinformação na eleição de 2026 ao chegar a buscadores, redes sociais e ao WhatsApp. O TSE já tinha regras de rotulagem, remoção de conteúdo falso e uso de IA em campanha, mas elas não alcançavam as redes informais de apoio nem a velocidade com que os boatos circulam.",
  },
  {
    date: "2026-02-04",
    headline: "Gilmar Mendes quer força-tarefa contra deepfakes",
    editionUrl: "https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes",
    editionTitle: "TSE avalia força-tarefa para coibir deepfakes",
    summary:
      "Gilmar Mendes, ministro do STF e substituto no TSE, propôs uma força-tarefa técnico-pericial com especialistas e universidades para identificar conteúdo sintético na eleição, sobretudo deepfakes de áudio, vídeo e imagem. Ele também defendeu reforçar a equipe técnica do tribunal e fechar acordos com empresas de IA para rastrear e rotular esse material, enquanto audiências públicas revisavam as normas eleitorais até 5 de março.",
  },
  {
    date: "2026-02-06",
    headline: "Lula propõe regras mais rigorosas para redes nas eleições",
    editionUrl: "https://diar.ia.br/p/li-deres-militares-evitam-regras-para-ia-em-guerras",
    editionTitle: "Líderes militares evitam regras para IA em guerras",
    summary:
      "O governo federal pediu ao TSE que ampliasse a remoção de perfis durante a campanha, sem se limitar a contas falsas e robôs. Entre as propostas estavam proibir chatbots de recomendar candidatos, obrigar provedores de IA a indicar as fontes oficiais da Justiça Eleitoral e multar em até R$ 30 mil quem divulgasse desinformação gerada por IA.",
  },
  {
    date: "2026-04-22",
    headline: "Brasil regula IA eleitoral antes do pleito 2026",
    editionUrl: "https://diar.ia.br/p/brasil-regula-ia-eleitoral-antes-do-pleito-2026",
    editionTitle: "Brasil regula IA eleitoral antes do pleito 2026",
    summary:
      "A resolução do TSE vetou conteúdo sintético nas 72 horas anteriores à votação e nas 24 horas seguintes, exigiu rótulo em todo material gerado ou alterado por IA e proibiu plataformas de recomendar candidaturas por algoritmo, chatbot ou agente. O tribunal não detalhou como fiscalizaria, mas sinalizou que denúncias poderiam ser processadas como propaganda irregular.",
  },
  {
    date: "2026-04-29",
    headline: "Dona Maria, criada por IA, vai a julgamento",
    editionUrl: "https://diar.ia.br/p/anthropic-conecta-claude-a-adobe-e-blender",
    editionTitle: "Anthropic conecta Claude a Adobe e Blender",
    summary:
      "O TSE começou a julgar o caso de Dona Maria, personagem inteiramente sintética usada em conteúdo de campanha. Como não havia uma pessoa real por trás da imagem, o tribunal precisava decidir como enquadrar como propaganda enganosa um material sem original, que as regras pensadas para deepfakes de políticos não cobriam.",
  },
  {
    date: "2026-08-19",
    headline: "TSE exige aviso em propaganda eleitoral com IA",
    editionUrl: "https://diar.ia.br/p/tse-exige-aviso-em-propaganda-eleitoral-com-ia",
    editionTitle: "TSE exige aviso em propaganda eleitoral com IA",
    summary:
      "Nova resolução obrigou candidatos, partidos, federações e coligações a informar de forma explícita o uso de IA em peças de propaganda, e ministros indicaram que deepfakes de candidatos tendiam a ser proibidas. A medida veio depois que a convenção de Flávio Bolsonaro exibiu um avatar de Jair Bolsonaro criado por IA, vídeo que o PT questionou no tribunal.",
  },
  {
    date: "2026-08-21",
    headline: 'TSE diz que reunião sobre IA foi "produtiva" e que casos irão a plenário',
    editionUrl: "https://diar.ia.br/p/marca-d-agua-do-claude-cai-em-horas",
    editionTitle: "Marca d'água do Claude cai em horas",
    summary:
      "No Radar: a corte discutiu o uso de deepfakes na propaganda antes de julgar os casos concretos, entre eles o vídeo de Bolsonaro produzido com IA, e anunciou que esses processos seriam decididos em plenário.",
  },
  {
    date: "2026-09-03",
    headline: "TSE julga caso que define regra para deepfake",
    editionUrl: "https://diar.ia.br/p/google-lanca-dois-modelos-gemini-de-uma-vez",
    editionTitle: "Google lança dois modelos Gemini de uma vez",
    summary:
      "No Radar: o julgamento deveria firmar o entendimento do tribunal sobre IA em campanha, com reflexo em mais de 50 ações que já tramitavam na Justiça Eleitoral sobre apoios falsos, pesquisas inexistentes e diálogos simulados.",
  },
  {
    date: "2026-10-02",
    headline: "Você viu Bonner anunciar pesquisa? Era deepfake",
    editionUrl: "https://diar.ia.br/p/voce-viu-bonner-anunciar-pesquisa-era-deepfake",
    editionTitle: "Você viu Bonner anunciar pesquisa? Era deepfake",
    summary:
      "O VigIA, monitor da Agência Lupa, contou 920 publicações eleitorais feitas ou alteradas com IA entre 16 de agosto e 28 de setembro, 554 delas deepfakes. A edição apontou o limite da regra do TSE: ela alcança a propaganda das campanhas, mas quase metade das peças veio de eleitores e militantes, e seis em cada dez circularam sem aviso de IA.",
  },
  {
    date: "2026-10-15",
    headline: 'Meta AI gera "Flávio 22" e trava com Lula?',
    editionUrl: "https://diar.ia.br/p/meta-ai-gera-flavio-22-e-trava-com-lula",
    editionTitle: 'Meta AI gera "Flávio 22" e trava com Lula?',
    summary:
      'A coligação de Lula acionou o TSE por "tratamento desigual": a Meta AI desenhava bandeiras com "Flávio 22", mas respondia que não conseguia gerar a imagem quando o pedido trazia o nome de Lula. A Meta disse ter suspendido a geração de imagens de candidatos, e um novo teste da CNN Brasil, quatro minutos depois, ainda produziu o slogan com o número de urna.',
  },
];

/** Nota de metodologia DERIVADA de `MENTIONS` — mesma disciplina de
 * `buildMethodologyNote` em `perplexity.ts` (cópia local pequena, ver nota de
 * fronteira em `entity-page.ts`). */
function buildMethodologyNote(mentions: EntityContent["mentions"]): string {
  const since = formatMonthYear(mentions[0].date);
  const until = formatMonthYear(mentions[mentions.length - 1].date);
  const between = since === until ? since : `${since} e ${until}`;
  return `O levantamento vem de ${mentions.length} edições publicadas entre ${between}; os fatos saem do arquivo da diar.ia.br, não de verificação independente junto ao TSE. A leitura temática do assunto está nos hubs de [regulação de IA no Brasil](https://arquivo.diar.ia.br/temas/brasil-regulacao) e de [deepfake](https://arquivo.diar.ia.br/temas/deepfake).`;
}

export function getTseEntity(): EntityContent {
  return {
    slug: "tse",
    name: "TSE",
    metaDescription:
      "O TSE na cobertura da diar.ia.br: as resoluções sobre IA e deepfakes na eleição de 2026, o rótulo obrigatório e os casos que chegaram ao tribunal.",
    introHeading: "O que o TSE decidiu sobre IA e deepfakes na eleição de 2026?",
    introParagraph:
      "O Tribunal Superior Eleitoral foi quem mais decidiu sobre IA na política brasileira durante a preparação para a eleição de 2026. A diar.ia.br acompanhou o tribunal desde a proposta de uma força-tarefa contra deepfakes, em fevereiro. Vieram depois duas resoluções: a de abril proibiu conteúdo sintético nas 72 horas antes da votação e vetou a recomendação de candidatos por algoritmo, e a de agosto obrigou as campanhas a avisar quando usam IA. Os casos concretos começaram com Dona Maria, uma personagem fabricada do zero, e passaram pelo avatar de Jair Bolsonaro e pela queixa contra a Meta AI. O limite da regra volta em várias menções: ela alcança a propaganda das campanhas, e quase metade das peças com IA do primeiro turno veio de eleitores e militantes. Esta página reúne, em ordem cronológica, cada vez que o TSE apareceu nas edições da diária.",
    mentions: MENTIONS,
    faq: [
      {
        question: "Quantas vezes o TSE apareceu na diar.ia.br?",
        answer: `${MENTIONS.length} vezes, entre ${formatMonthYear(MENTIONS[0].date)} e ${formatMonthYear(MENTIONS[MENTIONS.length - 1].date)}, da proposta de força-tarefa contra deepfakes à disputa sobre a Meta AI na campanha.`,
      },
      {
        question: "O que a resolução do TSE de abril de 2026 proíbe?",
        answer:
          "Conteúdo sintético nas 72 horas anteriores à eleição e nas 24 horas seguintes, além da recomendação algorítmica de candidaturas por plataformas, chatbots ou agentes. A resolução também exige rótulo em todo conteúdo gerado ou alterado por IA.",
      },
      {
        question: "A campanha precisa avisar quando usa IA na propaganda?",
        answer:
          "Sim. A resolução publicada em agosto de 2026 obriga candidatos, partidos, federações e coligações a informar de forma explícita e acessível o uso de IA na criação ou na alteração significativa de peças de propaganda. Usar IA para analisar o eleitorado ou produzir material mais rápido não foi vedado.",
      },
      {
        question: "A regra do TSE alcança deepfakes postados por eleitores?",
        answer:
          "Com dificuldade. O monitoramento do VigIA, da Agência Lupa, mostrou que quase metade das 920 publicações eleitorais com IA do primeiro turno veio de eleitores e militantes, fora dos perfis oficiais, e que seis em cada dez circularam sem aviso de IA. A norma mira a propaganda das campanhas.",
      },
      {
        question: "Onde está a cobertura mais ampla sobre regulação de IA no Brasil?",
        answer:
          "No hub temático de [regulação de IA no Brasil](https://arquivo.diar.ia.br/temas/brasil-regulacao), que reúne também o Marco Legal da IA e as normas setoriais. Esta página acompanha só o tribunal eleitoral.",
      },
    ],
    publishedDate: "2026-11-12",
    updatedDate: "2026-11-12",
    methodologyNote: buildMethodologyNote(MENTIONS),
    footerNavUtm: entityFooterNavUtm("tse"),
  };
}
