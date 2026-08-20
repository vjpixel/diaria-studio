/**
 * medicina-saude.ts (#5741, 7º hub temático publicado)
 *
 * ⚠️ EDITOU ESTE ARQUIVO? Rode antes de commitar:
 *   npx tsx scripts/build-hub-page.ts --hub medicina-saude
 * Sem isso, `workers/arquivo/src/hubs/medicina-saude.generated.ts` fica
 * defasado e `test/hub-page-drift.test.ts` quebra o CI (mesmo aviso que já
 * mordeu os 6 hubs anteriores — ver docstring de `anthropic-claude.ts`).
 *
 * Conteúdo editorial do 3º hub TEMÁTICO transversal — `brasil-regulacao` foi
 * o 1º, `mercado-trabalho` o 2º. Os 4 hubs de EMPRESA (`anthropic-claude`,
 * `openai-chatgpt`, `google-gemini`, `meta-ai`) continuam à parte. Este é o
 * 1º hub por SETOR DE APLICAÇÃO (issue #5741: "/temas/ hoje só organiza por
 * ator ou eixo regulatório, nunca por onde a IA é aplicada") — cobre IA
 * aplicada a medicina e saúde: diagnóstico assistido, normatização
 * profissional (CFM), aposta bilionária dos grandes laboratórios de IA em
 * saúde global, e pesquisa oncológica, incluindo os riscos de segurança e
 * responsabilidade clínica que o uso não-supervisionado carrega. Mesmo
 * critério de qualidade não-negociável da issue #4558, reafirmado na #5741:
 * "cada hub precisa carregar uma leitura que só existe porque alguém
 * acompanhou o tema por meses. Hub que reempacota manchete sem síntese
 * própria é conteúdo fino."
 *
 * **Candidato irmão `direito-juridico` NÃO foi publicado (#5741).** Medido
 * contra o mesmo corpus com pattern generoso, achou só 6-7 edições — bem
 * abaixo do hub mais magro já publicado (`brasil-regulacao`, 14). Ver a
 * nota completa em `scripts/generate-hub-sources.ts::HUB_KEYWORD_PATTERNS`
 * (entrada `medicina-saude`) e o PR/comentário da issue #5741 pra números.
 *
 * **Verificação de fonte primária feita manchete a manchete.** Duas
 * manchetes não têm link de fonte externa citado abaixo, de propósito:
 * "Harvard desenvolve modelo para detectar doenças genéticas" (25/11/2025)
 * — a edição só menciona o achado na linha de assunto/preview, sem
 * parágrafo próprio nem link no corpo (a única matéria expandida daquela
 * edição, com link, é a de AVC, tratada à parte) — e "IA revolucionando
 * medicina" (13/01/2026), que é o TÍTULO da própria edição, não uma
 * manchete individual com matéria própria (a edição cobre 3 itens de
 * saúde diferentes sob esse título-guarda-chuva: laboratório Nvidia/Lilly,
 * SleepFM de Stanford e Claude for Healthcare, cada um com o link correto
 * junto do fato, na seção que trata dele). `generate-hub-sources.ts`
 * resolveu `primarySourceUrls: [null, "https://www.anthropic.com/news/claude-opus-4-5"]`
 * pra Harvard/AVC automaticamente — a 2ª URL é heurística errada (pega o
 * link do PRÓPRIO lançamento do Opus 4.5, matéria adjacente, não da
 * pesquisa de Harvard); não usada abaixo, mesmo padrão de exclusão já
 * documentado em `mercado-trabalho.ts`.
 *
 * **Fonte é a cobertura da diária, não fato-checado contra hospitais/
 * empresas/estudos reais** — este módulo sintetiza o que a diar.ia.br
 * noticiou sobre o tema, no vocabulário que a própria edição usou. Não é
 * papel deste hub reverificar o achado clínico original de cada manchete.
 *
 * Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *   npx tsx scripts/generate-hub-sources.ts --hub medicina-saude
 *   npx tsx scripts/build-hub-page.ts --hub medicina-saude
 */
import type { GeoFaqItem } from "../shared/geo-faq.ts";
import {
  hubCoverageWindow,
  hubTotals,
  hubMentionCadenceDays,
  countMatching,
  formatDateShort,
  defaultMethodologyNote,
  buildLaunchChronologyTable,
  type HubContent,
  type HubSourceEdition,
} from "../shared/hub-page.ts";
import { HUB_MEDICINA_SAUDE_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import sourcesRaw from "./medicina-saude-sources.generated.json" with { type: "json" };
import type { HubSourceEntry } from "../../generate-hub-sources.ts";

const SOURCES = sourcesRaw as HubSourceEntry[];

/** `YYYY-MM-DD` estático — dia em que a página nasceu. */
const PUBLISHED_DATE = "2026-08-20";

/** `YYYY-MM-DD` estático — dia em que o CORPO foi revisado por último. Nasce
 * igual a `PUBLISHED_DATE` (hub recém-criado, nunca revisado ainda). */
const UPDATED_DATE = "2026-08-20";

/** `matchedHeadlines` vem em NFD antes de normalizar — `countMatching`/
 * `buildLaunchChronologyTable` normalizam pra NFC antes de testar (ver
 * `hub-page.ts`), então os patterns abaixo usam forma acentuada normal. */
const CANCER_PATTERN = /c[aâ]ncer/iu;
/** Cluster de diagnóstico/triagem/detecção assistida por IA — a âncora da
 * tabela de cronologia da seção 1. Inclui a falha de triagem do ChatGPT
 * Health ("falha em triagem") de propósito: é o mesmo eixo (a ferramenta
 * decidindo se um caso precisa de atendimento), só que do lado do erro. */
const DIAGNOSTICO_PATTERN = /diagn[oó]stic|detec[cç][aã]o|detecta|iguala m[eé]dicos|falha em triagem/iu;

/**
 * Fatos derivados de `sources` — objeto único que `buildIntro` e
 * `buildMedicinaSaudeFaq` consomem, nunca recalculado em paralelo (mesma
 * disciplina de `deriveMercadoTrabalhoFacts`/`deriveBrasilRegulacaoFacts`).
 */
function deriveMedicinaSaudeFacts(sources: HubSourceEntry[]) {
  const { totalEditions, totalMentions } = hubTotals(sources);
  const { firstDate: oldest, lastDate: newest } = hubCoverageWindow(sources);
  const cadenceDays = hubMentionCadenceDays(sources);
  const cancer = countMatching(sources, CANCER_PATTERN);
  const diagnostico = countMatching(sources, DIAGNOSTICO_PATTERN);
  return { totalEditions, totalMentions, oldest, newest, cadenceDays, cancer, diagnostico };
}

/**
 * Monta o FAQ (mesmo molde da issue #4558 item 3/6: 6-10 perguntas, números
 * reais). Pure — opera inteiramente sobre `sources` recebido, nunca lê
 * `SOURCES` do módulo direto.
 */
export function buildMedicinaSaudeFaq(sources: HubSourceEntry[]): GeoFaqItem[] {
  const { totalEditions, totalMentions, oldest, newest, cadenceDays, cancer, diagnostico } =
    deriveMedicinaSaudeFacts(sources);

  return [
    {
      question: "Com que frequência a medicina e a saúde aparecem como destaque da cobertura de IA?",
      answer: `Entre ${formatDateShort(oldest ?? "")} e ${formatDateShort(newest ?? "")}, o tema apareceu como destaque em ${totalEditions} edições da diar.ia.br, somando ${totalMentions} manchetes. Em média, uma edição a cada ${cadenceDays} dias corridos.`,
    },
    {
      question: "O CFM já regulamentou o uso de IA na prática médica no Brasil?",
      answer:
        "Sim. Em 27 de fevereiro de 2026, [o Conselho Federal de Medicina publicou a Resolução nº 2.454/2026](https://diar.ia.br/p/cfm-normatiza-o-uso-da-ia-na-medicina) [fonte primária](https://portal.cfm.org.br/noticias/cfm-normatiza-uso-da-ia-na-medicina), determinando que a IA é estritamente ferramenta de apoio à decisão clínica: a palavra final em diagnóstico e tratamento continua sempre do médico, o paciente tem direito de ser informado sempre que uma IA participar do próprio atendimento, e o profissional tem respaldo ético para recusar tecnologia sem validação científica.",
    },
    {
      question: "Sistemas de IA já empataram com médicos em teste clínico controlado?",
      answer:
        "Sim, um caso publicado com revisão de pares. Em 18 de junho de 2026, [o AMIE, sistema conversacional do Google, empatou com médicos de atenção primária no manejo de pacientes com múltiplas condições crônicas simultâneas](https://diar.ia.br/p/sistema-do-google-iguala-m-dicos-em-teste) [fonte primária](https://blog.google/innovation-and-ai/models-and-research/google-research/amie-for-disease-management-in-nature/), segundo estudo na Nature: avaliadores clínicos, sem saber a origem das respostas, classificaram o sistema como comparável ao médico humano em empatia, raciocínio clínico e clareza de recomendação.",
    },
    {
      question: "Quantas manchetes diferentes trataram de câncer especificamente?",
      answer: `${cancer} manchetes diferentes, cobrindo desde pesquisa básica — [o modelo Gemma do Google gerou uma hipótese original sobre o comportamento imunológico do tumor, depois validada em laboratório](https://diar.ia.br/p/google-veo-3-1) [fonte primária](https://blog.google/technology/ai/google-gemma-ai-cancer-therapy-discovery) — até uma vacina personalizada de mRNA criada com apoio de IA [para tratar o câncer de uma cadela chamada Rosie](https://diar.ia.br/p/ia-criou-vacina-de-c-ncer-para-um-cachorro) [fonte primária](https://awesomeagents.ai/news/ai-mrna-vaccine-dog-cancer-rosie/), passando por [um hospital público do interior do Paraná que usou um sistema do Google como apoio de decisão para localizar um câncer raro dentro do SUS](https://diar.ia.br/p/ia-do-google-detecta-c-ncer-raro-no-sus) [fonte primária](https://saudedigitalnews.com.br/13/07/2026/ia-do-google-atua-como-segundo-cerebro-no-sus-para-desvendar-tumores-raros-no-interior-do-parana/).`,
    },
    {
      question: "Um sistema de IA para saúde já falhou de forma documentada em triagem médica?",
      answer:
        'Sim. Em 10 de julho de 2026, [um estudo da Nature Medicine encontrou falha relevante no ChatGPT Health da OpenAI](https://diar.ia.br/p/openai-lanca-gpt-5-6-mais-rapido-e-barato) [fonte primária](https://www.forbes.com/sites/amyfeldman/2026/07/07/how-openai-plans-to-win-over-doctors-patients-and-hospitals/): o sistema deixou de recomendar visita ao hospital em mais da metade dos casos que precisavam, e direcionou 65% dos casos não urgentes para atendimento desnecessário — mesmo depois de a empresa recrutar mais de 260 médicos para revisar as respostas.',
    },
    {
      question: "Que grandes apostas financeiras os laboratórios de IA já fizeram em saúde?",
      answer:
        'Três, na mesma janela de 12 meses: [a Anthropic fechou uma parceria de US$ 200 milhões em 4 anos com a Gates Foundation](https://diar.ia.br/p/anthropic-e-gates-200-mi-em-sa-de-e-educa-o) [fonte primária](https://www.anthropic.com/news/gates-foundation-partnership), com foco em saúde global e doenças negligenciadas como poliomielite, HPV e pré-eclâmpsia; [a Nvidia investiu até US$ 1 bilhão num laboratório conjunto com a Eli Lilly para automatizar descoberta de medicamentos](https://diar.ia.br/p/ia-revolucionando-medicina) [fonte primária](https://exame.com/inteligencia-artificial/nvidia-vai-investir-us-1-bi-em-um-laboratorio-de-medicamentos-com-ia-em-parceria-com-a-eli-lilly/); e a OpenAI lançou três produtos de saúde em seis meses, incluindo o Health in ChatGPT.',
    },
    {
      question: "Existe preocupação documentada sobre IA prejudicar a formação de novos médicos?",
      answer:
        'Sim. Em 11 de agosto de 2026, [um artigo de opinião do Guardian alertou que estudantes de medicina que recorrem a modelos de linguagem antes de examinar o paciente podem nunca desenvolver o próprio raciocínio clínico](https://diar.ia.br/p/medicina-teme-formar-medicos-sem-raciocinio) [fonte primária](https://www.theguardian.com/commentisfree/2026/aug/10/ai-medical-students-judgment) — diferente do médico já formado, que usa a IA sobre uma base de raciocínio que já existe, o estudante que nunca chegou a formar essa base não tem o que recuperar depois.',
    },
    {
      question: "O que a própria indústria de IA diz sobre a lacuna entre promessa e entrega em saúde?",
      answer:
        'Em 18 de agosto de 2026, [o presidente-executivo da Anthropic admitiu que o setor de IA não entregou o que prometeu, e que só algo como "curar o câncer" convenceria o público cético](https://diar.ia.br/p/anthropic-so-curar-cancer-convence-publico) [fonte primária](https://exame.com/inteligencia-artificial/para-criador-do-claude-unico-jeito-de-a-ia-convencer-o-publico-e-curar-o-cancer/) — a manchete mais recente do arco, fechando o ciclo aberto pelo primeiro grande investimento em saúde da própria empresa, dez meses antes.',
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

/** INTRO derivada de `sources` — janela de cobertura, contagens e cadência
 * saem do dataset, nunca de literal na prosa (mesma disciplina dos 6 hubs
 * anteriores). Array de 2 elementos (#5259): o orçamento de ~250 palavras
 * quebra no ponto natural entre "o que já funciona/foi regulado" e "o que
 * a indústria apostou/os limites que apareceram". */
function buildIntro(sources: HubSourceEntry[]): [string, string] {
  const { between } = hubCoverageWindow(sources);
  const { totalEditions, totalMentions, cadenceDays, diagnostico } = deriveMedicinaSaudeFacts(sources);
  return [
    `Entre ${between}, o uso de IA em medicina e saúde apareceu como destaque em ${totalEditions} edições da diar.ia.br, ${totalMentions} manchetes ao todo, uma a cada ${cadenceDays} dias corridos, em média. ${diagnostico} dessas manchetes tratam de diagnóstico, triagem ou detecção assistida por IA já testados em paciente ou em estudo clínico — de um sistema que empata com médico de atenção primária em condição crônica múltipla, publicado na Nature, a um modelo que resolveu quase 20 casos pediátricos que ficavam anos sem diagnóstico. Em 27 de fevereiro de 2026, o Conselho Federal de Medicina publicou a primeira norma brasileira sobre o tema, a Resolução nº 2.454/2026: IA é ferramenta de apoio, a decisão final é sempre do médico, e o paciente tem direito de saber quando uma IA participou do próprio atendimento.`,
    `Do lado do investimento, Anthropic, Nvidia e OpenAI fecharam apostas bilionárias em saúde na mesma janela de 12 meses — parceria de US$ 200 milhões com a Gates Foundation, laboratório de US$ 1 bilhão com a Eli Lilly para descoberta de medicamentos, e três produtos de saúde lançados pela OpenAI em seis meses. O lado do risco chegou documentado: um estudo da Nature Medicine encontrou o ChatGPT Health falhando em recomendar hospital em mais da metade dos casos urgentes testados, um artigo do Guardian levantou o risco de estudantes de medicina nunca desenvolverem raciocínio clínico próprio, e o presidente-executivo da Anthropic admitiu publicamente que só "curar o câncer" convenceria o público cético — a manchete mais recente do arco.`,
  ];
}

export function getMedicinaSaudeHub(): HubContent {
  const { since, until } = hubCoverageWindow(SOURCES);
  return {
    slug: "medicina-saude",
    title: "Medicina e saúde",
    h1: `Medicina e saúde e IA — de ${since} a ${until}`,
    // ≤160 chars (validateHubContent).
    metaDescription: `Medicina e saúde e IA, de ${since} a ${until}: diagnóstico assistido, normatização do CFM, investimento bilionário e pesquisa contra o câncer.`,
    introHeading: `O que aconteceu com a medicina, a saúde e a IA desde ${since}?`,
    introParagraph: buildIntro(SOURCES),
    sections: [
      {
        heading: "Que ferramentas de diagnóstico assistido por IA já chegaram a hospitais e pacientes reais?",
        paragraphs: [
          'O primeiro caso do período veio em 25 de setembro de 2025, ainda em fase de dispositivo: [o estado indiano de Punjab lançou os primeiros aparelhos de triagem com IA para detecção precoce de câncer de mama](https://diar.ia.br/p/ia-cria-vi-rus-funcional-em-laborato-rio) [fonte primária](https://timesofindia.indiatimes.com/city/chandigarh/punjab-launches-ai-enabled-screening-devices-for-early-detection-of-cancer/articleshow/124078199.cms), mirando acesso mais amplo à triagem em área rural. Dois meses depois, em 25 de novembro, [uma reportagem descreveu IA acelerando o diagnóstico de AVC em hospitais brasileiros](https://diar.ia.br/p/claude-opus-4-5-novo-carro-chefe-da-antropic) [fonte primária](https://www.cnnbrasil.com.br/saude/ia-pode-ajudar-no-diagnostico-de-avc-entenda-possiveis-usos): algoritmos treinados com milhares de imagens identificam coágulo ou sangramento cerebral em tomografia e ressonância, sem substituir o olhar médico, funcionando como suporte que reduz o tempo de análise em unidades sem neurologista 24 horas.',
          'Em 13 de janeiro de 2026, [pesquisadores de Stanford apresentaram o SleepFM, modelo que prevê o risco de mais de 130 doenças a partir de uma única noite de sono monitorado](https://diar.ia.br/p/ia-revolucionando-medicina) [fonte primária](https://med.stanford.edu/news/all-news/2026/01/ai-sleep-disease.html), treinado em 585 mil horas de dados de 65 mil participantes com até 25 anos de acompanhamento — precisão de 0,89 para Parkinson, 0,87 para câncer de mama e 0,84 para risco de morte, com a promessa de rodar em wearable de consumo em vez de exame de laboratório. Cinco meses depois, em 18 de junho, [o AMIE do Google empatou com médicos de atenção primária no manejo de pacientes com múltiplas doenças crônicas simultâneas em avaliação às cegas publicada na Nature](https://diar.ia.br/p/sistema-do-google-iguala-m-dicos-em-teste) [fonte primária](https://blog.google/innovation-and-ai/models-and-research/google-research/amie-for-disease-management-in-nature/). Um dia depois, [pesquisadores aplicaram um modelo de raciocínio da OpenAI a casos pediátricos de doença genética rara que permaneciam sem diagnóstico havia anos, e o sistema chegou a uma hipótese correta em 19 dos casos examinados](https://diar.ia.br/p/alexa-chega-ao-brasil-por-r-100-ao-mes) [fonte primária](https://openai.com/index/diagnose-rare-childhood-diseases).',
          'Em 14 de julho de 2026, [um hospital público do interior do Paraná recorreu a um sistema do Google como segundo parecer para localizar um Carcinoma de Sítio Primário Oculto, tumor raro que se espalha sem origem identificável, dentro do SUS](https://diar.ia.br/p/ia-do-google-detecta-c-ncer-raro-no-sus) [fonte primária](https://saudedigitalnews.com.br/13/07/2026/ia-do-google-atua-como-segundo-cerebro-no-sus-para-desvendar-tumores-raros-no-interior-do-parana/), sem substituir a decisão final da equipe oncológica — sinal de que a ferramenta já chega a hospital fora dos grandes centros, exatamente onde a fila por especialista costuma ser mais longa. Mas nem todo teste de triagem saiu limpo: quatro dias antes, em 10 de julho, [um estudo da Nature Medicine encontrou o ChatGPT Health deixando de recomendar visita ao hospital em mais da metade dos casos urgentes testados, e direcionando 65% dos casos não urgentes para atendimento desnecessário](https://diar.ia.br/p/openai-lanca-gpt-5-6-mais-rapido-e-barato) [fonte primária](https://www.forbes.com/sites/amyfeldman/2026/07/07/how-openai-plans-to-win-over-doctors-patients-and-hospitals/), mesmo com mais de 260 médicos recrutados pela OpenAI para revisar as respostas do sistema.',
        ],
        table: buildLaunchChronologyTable(SOURCES, DIAGNOSTICO_PATTERN, {
          caption: "Cronologia de diagnóstico, triagem e detecção assistida por IA: manchete, data, dias desde a anterior, edição",
          firstColumnHeader: "Diagnóstico ou triagem",
        }),
      },
      {
        heading: "Que responsabilidade e risco clínico a IA em saúde já expôs, e como reguladores e médicos reagiram?",
        paragraphs: [
          'A resposta regulatória mais concreta do período veio do Brasil. Em 27 de fevereiro de 2026, [o Conselho Federal de Medicina publicou a Resolução nº 2.454/2026, primeira norma brasileira sobre IA como apoio à decisão clínica](https://diar.ia.br/p/cfm-normatiza-o-uso-da-ia-na-medicina) [fonte primária](https://portal.cfm.org.br/noticias/cfm-normatiza-uso-da-ia-na-medicina): a IA é estritamente ferramenta de apoio, a palavra final em diagnóstico e tratamento continua sempre do médico, o paciente tem direito de ser informado sempre que uma IA participar do próprio atendimento, e o profissional tem respaldo ético para recusar tecnologia sem validação científica ou certificação regulatória adequada.',
          'Do lado do paciente que usa IA por conta própria, em 27 de abril de 2026 [uma reportagem do G1 questionou se dá para confiar em conselho de saúde de chatbot](https://diar.ia.br/p/pode-confiar-no-chatgpt-para-cuidar-da-sua-sau-de) [fonte primária](https://g1.globo.com/saude/noticia/2026/04/25/voce-deve-confiar-em-conselhos-de-saude-de-um-chatbot-de-ia.ghtml): modelos alucinam, erram dose e não têm acesso ao histórico do paciente nem conseguem examinar, mas o tom seguro que transmitem não reflete a taxa real de erro — a linha entre ferramenta clínica supervisionada e oráculo pessoal sem filtro está evaporando, segundo a matéria. Seis meses antes, em 28 de outubro de 2025, [a OpenAI já tinha reforçado como o ChatGPT reconhece sinais de sofrimento emocional](https://diar.ia.br/p/chatgpt-aplica-medidas-para-cuidado-com-saude-mental) [fonte primária](http://openai.com/index/strengthening-chatgpt-responses-in-sensitive-conversations/), treinado com mais de 170 especialistas em saúde mental depois de reduzir em até 65% as respostas inadequadas sobre o tema — mudança que chegou junto de uma pesquisa que mediu o uso de IA como "terapia" crescendo cinco vezes no Brasil entre 2024 e 2025, [de 13% para 58% dos usuários de IA do país](https://diar.ia.br/p/uso-de-ia-como-terapia-aumenta-5x-no-brasil) [fonte primária](https://talkdigital.co/assets/pesquisas/IA-na-Vida-Real-TALK-Report-25.pdf).',
          'O risco mais recente do arco é sobre formação, não sobre atendimento. Em 11 de agosto de 2026, [um artigo de opinião do Guardian alertou que estudante de medicina que recorre a modelo de linguagem antes de examinar o paciente pode nunca desenvolver o próprio raciocínio clínico](https://diar.ia.br/p/medicina-teme-formar-medicos-sem-raciocinio) [fonte primária](https://www.theguardian.com/commentisfree/2026/aug/10/ai-medical-students-judgment) — a diferença é assimétrica: o médico já formado que usa IA tem uma base de raciocínio pra checar contra o que a ferramenta responde; o estudante que nunca formou essa base não tem o que recuperar depois, segundo o artigo.',
        ],
      },
      {
        heading: "Que apostas bilionárias os grandes laboratórios de IA já fizeram no setor de saúde?",
        paragraphs: [
          'A 1ª aposta do arco veio de uma parceria improvável entre big tech e fabricante de hardware. Em 13 de janeiro de 2026, [a Nvidia anunciou até US$ 1 bilhão de investimento num laboratório conjunto com a farmacêutica Eli Lilly, no Vale do Silício, para automatizar a descoberta de medicamentos](https://diar.ia.br/p/ia-revolucionando-medicina) [fonte primária](https://exame.com/inteligencia-artificial/nvidia-vai-investir-us-1-bi-em-um-laboratorio-de-medicamentos-com-ia-em-parceria-com-a-eli-lilly/), com robôs executando experimento físico sob controle computacional via supercomputador DGX Spark. No mesmo dia, [a Anthropic ampliou o Claude for Healthcare e o Claude for Life Sciences](https://diar.ia.br/p/ia-revolucionando-medicina) [fonte primária](https://www.anthropic.com/news/healthcare-life-sciences), com infraestrutura para proteger dado sensível de paciente, agentes especializados em prontuário eletrônico e conectores para dado de ensaio clínico, cobrindo do laboratório até a submissão a órgão regulador.',
          'Quatro meses depois, em 15 de maio de 2026, [a Anthropic fechou uma parceria de US$ 200 milhões em quatro anos com a Gates Foundation](https://diar.ia.br/p/anthropic-e-gates-200-mi-em-sa-de-e-educa-o) [fonte primária](https://www.anthropic.com/news/gates-foundation-partnership), com foco em saúde global, educação e doença negligenciada — poliomielite, HPV e pré-eclâmpsia nomeadas explicitamente —, com metas verificáveis de resultado em vez de só repasse de recurso. Nove meses antes, em 28 de agosto de 2025, [a Fujitsu já tinha lançado uma plataforma de agentes de IA para o setor de saúde japonês](https://diar.ia.br/p/openai-processada-por-suic-dio-de-adolescente) [fonte primária](https://global.fujitsu/en-global/newsroom/gl/2025/08/27-01), desenvolvida com apoio da Nvidia para coordenar dado clínico entre instituições parceiras — o 1º movimento corporativo do arco, quase um ano antes da aposta da Gates Foundation.',
          'A OpenAI fechou o trio investindo em produto de consumo em vez de parceria institucional. Em 24 de julho de 2026, [a empresa lançou nacionalmente o Health in ChatGPT para usuário adulto dos EUA](https://diar.ia.br/p/reddit-e-jornais-cogitam-banir-o-google) [fonte primária](https://openai.com/index/health-in-chatgpt/), conectando dado do Apple Health, prontuário hospitalar e histórico de exame direto na janela de chat — a empresa diz ter trabalhado com centenas de médicos pra calibrar a resposta, e que prontuário e conversa não entram em treinamento nem anúncio. Em 10 de julho, uma reportagem já tinha contado que [a OpenAI lançou três produtos de saúde em seis meses, recrutando mais de 260 médicos para revisar resposta do sistema](https://diar.ia.br/p/openai-lanca-gpt-5-6-mais-rapido-e-barato) [fonte primária](https://www.forbes.com/sites/amyfeldman/2026/07/07/how-openai-plans-to-win-over-doctors-patients-and-hospitals/) — a mesma matéria que revelou a falha de triagem do ChatGPT Health, tratada na seção anterior.',
        ],
      },
      {
        heading: "Que pesquisas de ponta usam IA no combate ao câncer, e o que revelam sobre os limites da própria tecnologia?",
        paragraphs: [
          'A pesquisa básica abriu o arco em 16 de outubro de 2025: [o modelo Gemma do Google, em colaboração com Yale, gerou uma hipótese original sobre como transformar tumor "frio" — invisível ao sistema imunológico — em tumor "quente", mais receptivo a tratamento, hipótese depois validada em célula viva](https://diar.ia.br/p/google-veo-3-1) [fonte primária](https://blog.google/technology/ai/google-gemma-ai-cancer-therapy-discovery), simulando mais de 4 mil medicamento em amostra de paciente real. Dois meses depois, em 11 de dezembro, [a Microsoft Research apresentou o GigaTIME, modelo que traduz lâmina de patologia comum em mapa de proteína imunológica, aplicado a 14.256 pacientes de 51 hospitais e liberado como código aberto](https://diar.ia.br/p/pesquisa-contra-cancer) [fonte primária](https://www.microsoft.com/en-us/research/blog/gigatime-scaling-tumor-microenvironment-modeling-using-virtual-population-generated-by-multimodal-ai), revelando 1.234 associações clínicas inéditas entre proteína imunológica e biomarcador de câncer.',
          'O lado do risco apareceu logo no início do arco. Em 25 de setembro de 2025, [uma IA conseguiu criar um vírus completamente funcional em laboratório pela primeira vez](https://diar.ia.br/p/ia-cria-vi-rus-funcional-em-laborato-rio) [fonte primária](https://www.washingtonpost.com/opinions/2025/09/25/artificial-intelligence-advance-virus-created/) — avanço que promete acelerar o desenvolvimento de vacina e tratamento, mas que especialistas citados na mesma matéria alertaram poder ser explorado para criar patógeno perigoso, levantando questão de regulamentação que a mesma tecnologia usada contra o câncer também carrega.',
          'A pesquisa mais concreta em aplicação chegou pela veterinária. Em 17 de março de 2026, [pesquisadores da Universidade de Nova Gales do Sul criaram, com apoio de IA, uma vacina personalizada de mRNA para tratar o câncer da cadela Rosie, mapeando as mutações tumorais específicas do animal em tempo recorde](https://diar.ia.br/p/ia-criou-vacina-de-c-ncer-para-um-cachorro) [fonte primária](https://awesomeagents.ai/news/ai-mrna-vaccine-dog-cancer-rosie/) — caso ainda experimental, descrito como abrindo caminho para protocolo semelhante em medicina humana. A manchete mais recente do arco fecha o ciclo com uma nota de ceticismo vinda de dentro do próprio setor: em 18 de agosto de 2026, [o presidente-executivo da Anthropic admitiu que a indústria de IA não entregou o que prometeu, e que só algo como "curar o câncer" convenceria o público cético](https://diar.ia.br/p/anthropic-so-curar-cancer-convence-publico) [fonte primária](https://exame.com/inteligencia-artificial/para-criador-do-claude-unico-jeito-de-a-ia-convencer-o-publico-e-curar-o-cancer/).',
        ],
      },
    ],
    faq: buildMedicinaSaudeFaq(SOURCES),
    sourceEditions: toSourceEditions(SOURCES),
    publishedDate: PUBLISHED_DATE,
    updatedDate: UPDATED_DATE,
    footerNavUtm: HUB_MEDICINA_SAUDE_FOOTER_NAV_UTM,
    methodologyNote: defaultMethodologyNote(SOURCES),
  };
}
