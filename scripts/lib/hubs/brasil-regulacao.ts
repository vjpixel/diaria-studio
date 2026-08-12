/**
 * brasil-regulacao.ts (#4558, 5º hub temático publicado)
 *
 * ⚠️ EDITOU ESTE ARQUIVO? Rode antes de commitar:
 *   npx tsx scripts/build-hub-page.ts --hub brasil-regulacao
 * Sem isso, `workers/arquivo/src/hubs/brasil-regulacao.generated.ts` fica
 * defasado e `test/hub-page-drift.test.ts` quebra o CI (mesmo aviso que já
 * mordeu os 4 hubs anteriores — ver docstring de `anthropic-claude.ts`).
 *
 * Conteúdo editorial do 1º hub TEMÁTICO transversal — os 4 anteriores
 * (`anthropic-claude`, `openai-chatgpt`, `google-gemini`, `meta-ai`) são
 * hubs de EMPRESA. Este cobre regulação e política pública de IA NO BRASIL:
 * o trâmite do Marco Legal da IA (PL 2338/23) entre Câmara e Senado, a lei
 * de classificação de sistemas por risco, as regras do TSE para a eleição
 * de 2026 e as normas setoriais do CFM (medicina) e da Anatel (nuvem
 * soberana). Mesmo critério de qualidade não-negociável da issue #4558: "cada
 * hub precisa carregar uma leitura que só existe porque alguém acompanhou o
 * tema por meses. Hub que reempacota manchete sem síntese própria é conteúdo
 * fino — não ganha citação e ainda arrasta o domínio."
 *
 * **Por que "brasil-regulacao" e não "brasil" genérico** — o candidato de
 * tema original (artefato da sessão 260804/260808) media "Brasil" como
 * substantivo solto, e uma sonda contra esse padrão estourou muito além do
 * lastro real do tema: casava estatística de adoção de mercado ("Brasil
 * potência em IA travada por falta de talentos"), investimento público em
 * infraestrutura sem caráter regulatório ("Brasil pretende investir R$ 23
 * bi") e cobertura de produto chegando ao país — nada disso é regulação. O
 * `HUB_KEYWORD_PATTERNS["brasil-regulacao"]` em
 * `scripts/generate-hub-sources.ts` é deliberadamente estreito: nomeia
 * órgão/mecanismo regulatório brasileiro específico (ANPD, Marco Legal,
 * STF, Congresso, CFM, Anatel, TSE), não o substantivo "Brasil"/"brasileiro"
 * isolado — ver o comentário completo da entrada no registry, incluindo a
 * verificação manchete a manchete contra o corpo de cada post antes de cada
 * uma entrar no pattern.
 *
 * **Fonte é a cobertura da diária, não fato-checado contra o processo
 * legislativo real** — este módulo sintetiza o que a diar.ia.br noticiou
 * sobre o tema, no vocabulário que a própria diária usou. Duas edições do
 * próprio corpus relatam ordens contraditórias de tramitação do Marco Legal
 * entre Câmara e Senado (ver Seção 1) — não é papel deste hub reconciliar
 * essa contradição, só relatar as duas versões como publicadas, com data.
 *
 * Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *   npx tsx scripts/generate-hub-sources.ts --hub brasil-regulacao
 *   npx tsx scripts/build-hub-page.ts --hub brasil-regulacao
 */
import type { GeoFaqItem } from "../shared/geo-faq.ts";
import {
  hubCoverageWindow,
  hubTotals,
  hubMentionCadenceDays,
  countMatching,
  formatDateShort,
  defaultMethodologyNote,
  type HubContent,
  type HubSourceEdition,
} from "../shared/hub-page.ts";
import { HUB_BRASIL_REGULACAO_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import sourcesRaw from "./brasil-regulacao-sources.generated.json" with { type: "json" };
import type { HubSourceEntry } from "../../generate-hub-sources.ts";

const SOURCES = sourcesRaw as HubSourceEntry[];

/** `YYYY-MM-DD` estático — dia em que a página nasceu. Ver nota de
 * `hub-page.ts` sobre por que não pode ser `new Date()`, e sobre por que é
 * campo SEPARADO de `UPDATED_DATE` (#4911). */
const PUBLISHED_DATE = "2026-08-11";

/** `YYYY-MM-DD` estático — dia em que o CORPO (síntese abaixo) foi revisado
 * por último. Bump manual quando a prosa for reescrita de forma
 * substancial — nunca cosmético. Nasce igual a `PUBLISHED_DATE` (hub recém-
 * criado, nunca revisado ainda). */
const UPDATED_DATE = "2026-08-11";

/** `matchedHeadlines` vem em NFD — ver a nota completa em `countMatching`,
 * em `scripts/lib/shared/hub-page.ts` (motor único reusado pelos 5 hubs). */
const MARCO_LEGAL_PATTERN = /marco (legal|de) (da )?ia\b/i;
const ELEITORAL_PATTERN = /\btse\b|eleitor|deepfake/i;
const CFM_PATTERN = /\bcfm\b|medicina/i;
const ANATEL_PATTERN = /\banatel\b/i;
const PBIA_PATTERN = /plano nacional|\bpbia\b/i;
const RISCO_LEI_PATTERN = /classifica.*risco|por risco/i;

/**
 * Fatos derivados de `sources` — objeto único que `buildIntro` e
 * `buildBrasilRegulacaoFaq` consomem, nunca recalculado em paralelo (mesma
 * disciplina de `deriveAnthropicClaudeFacts`).
 */
function deriveBrasilRegulacaoFacts(sources: HubSourceEntry[]) {
  const { totalEditions, totalMentions } = hubTotals(sources);
  const { firstDate: oldest, lastDate: newest } = hubCoverageWindow(sources);
  const cadenceDays = hubMentionCadenceDays(sources);
  const marcoLegal = countMatching(sources, MARCO_LEGAL_PATTERN);
  const eleitoral = countMatching(sources, ELEITORAL_PATTERN);
  const cfm = countMatching(sources, CFM_PATTERN);
  const anatel = countMatching(sources, ANATEL_PATTERN);
  const pbia = countMatching(sources, PBIA_PATTERN);
  const riscoLei = countMatching(sources, RISCO_LEI_PATTERN);
  return { totalEditions, totalMentions, oldest, newest, cadenceDays, marcoLegal, eleitoral, cfm, anatel, pbia, riscoLei };
}

/**
 * Monta o FAQ (issue #4558 item 3/6: 6-10 perguntas, números reais). Pure —
 * testável sem IO, opera inteiramente sobre o `sources` recebido (nunca lê
 * `SOURCES` do módulo direto — mesma disciplina dos 4 hubs anteriores).
 *
 * As perguntas abaixo não repetem o texto literal do H2 de nenhuma
 * `section` — onde o tema já tem seção de síntese, a pergunta do FAQ pega
 * um ângulo mais estreito (estatística rápida, recorte específico) e aponta
 * de volta pra seção pro relato completo.
 */
export function buildBrasilRegulacaoFaq(sources: HubSourceEntry[]): GeoFaqItem[] {
  const { totalEditions, totalMentions, oldest, newest, cadenceDays, marcoLegal } = deriveBrasilRegulacaoFacts(sources);

  return [
    {
      question: "Com que frequência a regulação de IA no Brasil aparece como destaque?",
      answer: `Entre ${formatDateShort(oldest ?? "")} e ${formatDateShort(newest ?? "")}, o tema apareceu como destaque em ${totalEditions} edições da diar.ia.br, somando ${totalMentions} manchetes. Em média, uma edição a cada ${cadenceDays} dias corridos.`,
    },
    {
      question: "Quantas manchetes acompanharam o trâmite do Marco Legal da IA entre a Câmara e o Senado?",
      answer: `Foram ${marcoLegal} manchetes só sobre a tramitação do Marco Legal (PL 2338/23) entre fevereiro e junho de 2026: [Hugo Motta priorizando o texto](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes), [a Câmara agendando voto para 27 de maio](https://diar.ia.br/p/gpt-5-5-instant-chega-como-padr-o-do-chatgpt), [o Senado aprovando e mandando o texto pra Câmara em 22 de maio](https://diar.ia.br/p/soberania-ia-pu-blica-nacional), e [a Câmara buscando nova data em junho, articulada com o Redata no Senado](https://diar.ia.br/p/35-mil-bolsas-pra-virar-creator-com-ia). A ordem de tramitação mudou de sentido entre a segunda e a terceira manchete: a Câmara anunciou voto próprio primeiro, mas foi o Senado quem aprovou e remeteu o texto antes.`,
    },
    {
      question: "O Marco Legal da IA já tem autoridade reguladora definida?",
      answer:
        'Ainda não claramente: [o texto em tramitação em fevereiro de 2026 previa um Sistema Nacional de IA "ainda em disputa quanto à autonomia"](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes), e [a versão aprovada pelo Senado em maio cria "a autoridade reguladora que vai fiscalizar" sem detalhar o desenho institucional](https://diar.ia.br/p/soberania-ia-pu-blica-nacional). A definição final dependia do texto que ainda tramitava na Câmara.',
    },
    {
      question: "Que multas ou sanções o texto do Marco Legal da IA previa para quem descumprisse as regras?",
      answer:
        "O texto em tramitação previa [multas de até 2% do faturamento da empresa, com teto de R$ 50 milhões, responsabilidade objetiva para sistemas de alto risco, limites ao reconhecimento facial e restrições ao uso de IA no Judiciário](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes).",
    },
    {
      question: "O que muda para quem terceiriza um modelo de IA de risco alto no Brasil?",
      answer:
        "Pela lei de classificação por risco que passou a circular em 25 de maio de 2026, [sistemas de alto risco — crédito, saúde, segurança pública e processos seletivos — ficam sujeitos a auditorias obrigatórias, registro e canais de contestação](https://diar.ia.br/p/deepseek-corta-75-do-pre-o-da-api) [fonte primária](https://exame.com/internacional/regulacao-da-ia-no-brasil-o-que-a-nova-lei-muda-para-sua-empresa/), e tanto quem desenvolve quanto quem apenas compra um modelo de terceiro e coloca em produção responde solidariamente pelo cumprimento das exigências.",
    },
    {
      question: "Que prazo o TSE deu para conteúdo gerado por IA nas eleições de 2026?",
      answer:
        "[Setenta e duas horas antes da eleição e vinte e quatro horas depois é a janela de silêncio que o TSE definiu para conteúdo sintético em vídeo, áudio ou imagem criado ou alterado por IA em campanha](https://diar.ia.br/p/brasil-regula-ia-eleitoral-antes-do-pleito-2026) [fonte primária](https://www.correio24horas.com.br/politica/eleicoes-2026-veja-como-o-tse-limitara-a-inteligencia-artificial-no-pleito-0426), com rotulagem obrigatória do que for gerado por síntese e proibição de recomendação algorítmica personalizada de candidatura via agente ou chatbot.",
    },
    {
      question: "O que é o Plano Brasileiro de Inteligência Artificial (PBIA) e quem o elaborou?",
      answer:
        "[O Ministério da Ciência, Tecnologia e Inovação (MCTI), em parceria com o Centro de Gestão e Estudos Estratégicos (CGEE), elaborou o PBIA](https://diar.ia.br/p/restricoes-sora-2-hollywood), a política pública que a Comissão de Ciência, Tecnologia, Inovação e Informática do Senado Federal debateu em audiência pública em 22 de outubro de 2025, para avaliar o impacto de políticas públicas de IA no país.",
    },
    {
      question: "O que a Resolução do CFM exige de médicos que usam IA no atendimento?",
      answer:
        "[A Resolução nº 2.454/2026 do Conselho Federal de Medicina trata a IA estritamente como ferramenta de apoio: a palavra final em diagnóstico e tratamento é sempre do médico, e o paciente tem direito de ser informado sempre que uma IA for usada em seu atendimento](https://diar.ia.br/p/cfm-normatiza-o-uso-da-ia-na-medicina).",
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

/** INTRO derivada de `sources` — a janela de cobertura, as duas contagens e
 * a cadência saem do dataset, nunca de literal na prosa (mesma disciplina de
 * `buildIntro` nos 4 hubs anteriores, que corrigiu o mesmo erro de janela
 * "digitada" em produção mais de uma vez). */
function buildIntro(sources: HubSourceEntry[]): string {
  const { between } = hubCoverageWindow(sources);
  const { totalEditions, totalMentions, cadenceDays } = deriveBrasilRegulacaoFacts(sources);
  return `Entre ${between}, a regulação de inteligência artificial no Brasil apareceu como destaque em ${totalEditions} edições da diar.ia.br, ${totalMentions} manchetes ao todo, uma a cada ${cadenceDays} dias corridos, em média. O fio mais longo é o Marco Legal da IA, o PL 2338/23: uma audiência pública na Câmara dos Deputados sobre direitos autorais em setembro de 2025, uma resolução do TSE contra deepfakes eleitorais meses depois, um voto agendado na Câmara para 27 de maio de 2026 que previa seguir depois para o Senado em caso de aprovação. Dezesseis dias antes desse voto acontecer, porém, foi o próprio Senado quem aprovou o texto e mandou para a Câmara, na ordem oposta à anunciada. Três dias depois da aprovação no Senado, uma lei de classificação de risco começou a circular tratando esse mesmo episódio como fato consumado: exige auditoria obrigatória para sistemas de alto risco e impõe responsabilidade solidária a quem desenvolve ou só implanta o modelo. Fora do Marco Legal, o período também trouxe o Conselho Federal de Medicina normatizando o uso de IA como apoio à decisão clínica, a Anatel contratando nuvem soberana para dados sob sigilo fiscal e bancário, e o TSE limitando conteúdo sintético nas 72 horas antes e nas 24 horas depois do voto de outubro de 2026. Cada um desses pontos aparece detalhado adiante, com data e link para a edição que o registrou.`;
}

export function getBrasilRegulacaoHub(): HubContent {
  const { since, until } = hubCoverageWindow(SOURCES);
  return {
    slug: "brasil-regulacao",
    title: "Regulação de IA no Brasil",
    // H1 carrega o intervalo coberto (o `<title>`/`og:title` continua só
    // `title`, montado em `renderHubPage` — não duplicam o período).
    h1: `Regulação de IA no Brasil — de ${since} a ${until}`,
    // ≤160 chars (validateHubContent) — trecho final enxuto de propósito.
    metaDescription: `Regulação de IA no Brasil no arquivo da diar.ia.br, de ${since} a ${until}: Marco Legal, eleições, saúde e classificação de risco.`,
    introHeading: `O que aconteceu com a regulação de IA no Brasil desde ${since}?`,
    introParagraph: buildIntro(SOURCES),
    sections: [
      {
        heading: "Como o Marco Legal da IA (PL 2338/23) andou entre a Câmara e o Senado desde setembro de 2025?",
        paragraphs: [
          "Em 10 de setembro de 2025, [a Comissão Especial de IA da Câmara dos Deputados realizou uma audiência pública sobre o PL 2338/23, que regulamenta o uso ético da IA generativa e os direitos autorais](https://diar.ia.br/p/estudo-de-harvard-estima-92-mi-de-empregos-esta-o-em-risco). O texto já classificava os sistemas de IA por risco e limitava o uso de conteúdo protegido por direitos autorais no treinamento de modelos a instituições de pesquisa, jornalismo, museus, bibliotecas e organizações educacionais. Qualquer outro uso passaria a exigir autorização dos titulares.",
          "146 dias depois, em 3 de fevereiro de 2026, [o projeto entrou na fase final do Congresso, com votação prevista na Câmara e sanção presidencial ainda em 2026](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes), servindo de base para o Plano Brasileiro de Inteligência Artificial. O texto previa multas de até 2% do faturamento (teto de R$ 50 milhões), responsabilidade objetiva para sistemas de alto risco e restrições ao uso de IA no Judiciário. No mesmo dia, Hugo Motta passou a priorizar o Marco Legal.",
          "92 dias depois, a ordem de votação virou notícia duas vezes, com versões diferentes. Em 6 de maio de 2026, [a Câmara agendou para 27 de maio a votação do marco legal, com o relatório final saindo em 19 de maio, para então seguir ao Senado em caso de aprovação](https://diar.ia.br/p/gpt-5-5-instant-chega-como-padr-o-do-chatgpt). Dezesseis dias depois, em 22 de maio, veio a versão oposta: [o Plenário do Senado aprovou o PL 2338/23, com a consulta pública fechada em 35.806 votos a favor e 31.547 contra, e mandou o texto para a Câmara](https://diar.ia.br/p/soberania-ia-pu-blica-nacional) [fonte primária](https://www25.senado.leg.br/web/atividade/materias/-/materia/157233), criando a autoridade reguladora que vai fiscalizar a lei. Dez dias depois, em 1º de junho, [o texto ainda buscava data de votação na Câmara, agora articulado com o Redata, a lei de proteção de dados que avança em paralelo no Senado](https://diar.ia.br/p/35-mil-bolsas-pra-virar-creator-com-ia), com o relator Aguinaldo Ribeiro (PP-PB) ajustando o texto com senadores antes do plenário.",
        ],
      },
      {
        heading: "O que muda com a lei brasileira que classifica sistemas de IA por risco?",
        paragraphs: [
          "Três dias depois de o Senado aprovar o marco legal, em 25 de maio de 2026, [uma lei brasileira de regulação de sistemas automatizados passou a classificar aplicações por nível de risco — baixo, médio ou alto — com obrigações proporcionais a cada faixa](https://diar.ia.br/p/deepseek-corta-75-do-pre-o-da-api) [fonte primária](https://exame.com/internacional/regulacao-da-ia-no-brasil-o-que-a-nova-lei-muda-para-sua-empresa/). Sistemas de alto risco — crédito, saúde, segurança pública e processos seletivos — ficam sujeitos a auditorias obrigatórias, registro e canais de contestação para quem for afetado, e tanto quem desenvolve quanto quem apenas implanta ou compra um modelo de terceiro responde solidariamente pelo cumprimento das exigências. A vigência, porém, não tinha data certa: quem usa modelo de terceiro em crédito, RH ou saúde precisava revisar contratos e fluxos de auditoria antes de a lei entrar em vigor, não depois. O texto tratava a aprovação do Senado como fato consumado três dias antes de a Câmara sequer ter votado de novo.",
          'O desenho de fiscalização já aparecia delineado desde 3 de fevereiro: [o texto então em tramitação previa multas de até 2% do faturamento, teto de R$ 50 milhões, responsabilidade objetiva para sistemas de alto risco, limites ao reconhecimento facial e restrições ao uso de IA no Judiciário](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes). Um Sistema Nacional de IA também estava previsto, mas seguia "em disputa quanto à autonomia". A pergunta de quem, na prática, vai fiscalizar essas regras continuava aberta na aprovação do Senado em maio.',
        ],
      },
      {
        heading: "Como o Brasil tentou blindar a eleição de 2026 contra deepfakes gerados por IA?",
        paragraphs: [
          "Em 3 de fevereiro de 2026, [o ministro do STF e ministro substituto do TSE, Gilmar Mendes, propôs a criação de uma força-tarefa técnico-pericial com especialistas e universidades para identificar rapidamente conteúdo sintético produzido com IA nas eleições, sobretudo deepfake em áudio, vídeo e imagem](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes), defendendo também acordos com empresas de IA para rastreabilidade e rotulagem, em paralelo a audiências públicas que atualizariam as normas eleitorais até 5 de março de 2026. Três dias depois, em 6 de fevereiro, [o governo pediu ao TSE que endurecesse a remoção de perfis falsos](https://diar.ia.br/p/li-deres-militares-evitam-regras-para-ia-em-guerras).",
          "75 dias depois, em 22 de abril de 2026, [o TSE publicou a resolução final: proibição de conteúdo sintético gerado por IA nas 72 horas antes da eleição e nas 24 horas seguintes, cobrindo vídeo, áudio e imagem criados ou alterados por modelos generativos em campanha](https://diar.ia.br/p/brasil-regula-ia-eleitoral-antes-do-pleito-2026) [fonte primária](https://www.correio24horas.com.br/politica/eleicoes-2026-veja-como-o-tse-limitara-a-inteligencia-artificial-no-pleito-0426). A resolução também passou a exigir rotulagem de todo conteúdo gerado ou alterado por síntese e proibiu qualquer recomendação algorítmica personalizada de candidatura via agente ou chatbot. As eleições de outubro de 2026 seriam o primeiro teste real dessas normas.",
        ],
      },
      {
        heading: "Que regras específicas de IA já valem para medicina e infraestrutura de telecom no Brasil?",
        paragraphs: [
          "No mesmo dia, 27 de fevereiro de 2026, duas agências reguladoras publicaram normas específicas para IA. [O Conselho Federal de Medicina publicou a Resolução nº 2.454/2026](https://diar.ia.br/p/cfm-normatiza-o-uso-da-ia-na-medicina): a IA é estritamente uma ferramenta de apoio à decisão clínica no Brasil. A palavra final em diagnóstico e tratamento continua sempre do médico, e o paciente tem direito a ser informado sempre que uma IA for usada em seu atendimento. [A Anatel, por sua vez, assinou com o Serpro um contrato de R$ 42,8 milhões para adotar um modelo de Broker MultiCloud focado em nuvem de governo](https://diar.ia.br/p/cfm-normatiza-o-uso-da-ia-na-medicina), infraestrutura dedicada a dar suporte a soluções de dados e aplicações de IA da agência para que cargas de trabalho sob sigilo fiscal, bancário e regulatório operem em conformidade legal.",
        ],
      },
    ],
    faq: buildBrasilRegulacaoFaq(SOURCES),
    sourceEditions: toSourceEditions(SOURCES),
    publishedDate: PUBLISHED_DATE,
    updatedDate: UPDATED_DATE,
    footerNavUtm: HUB_BRASIL_REGULACAO_FOOTER_NAV_UTM,
    methodologyNote: defaultMethodologyNote(SOURCES),
  };
}
