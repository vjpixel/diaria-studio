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
 * **Fonte é a cobertura da diária, fato-checada contra o processo
 * legislativo oficial onde há contradição (#5060)** — este módulo sintetiza
 * o que a diar.ia.br noticiou sobre o tema, no vocabulário que a própria
 * diária usou, exceto num ponto: duas edições do corpus relataram ordens
 * opostas de tramitação do Marco Legal entre Câmara e Senado (a de
 * 06/05/2026 dizia que a Câmara votaria primeiro e "então seguiria ao
 * Senado"; a de 22/05/2026 dizia que o Senado tinha acabado de aprovar e
 * mandado o texto pra Câmara). Verificação em `senado.leg.br` (matéria
 * 157233) + CNN Brasil (01/06/2026) resolveu a contradição: o Senado é a
 * Casa Iniciadora do PL 2338/23 e já tinha aprovado o texto em 10/12/2024,
 * remetendo-o à Câmara em 17/03/2025 — a manchete de 22/05/2026 ("Senado
 * aprova marco legal da IA no Brasil") está incorreta: leu uma página de
 * status estático ("Aprovada pelo Plenário") como evento do dia, quando
 * essa aprovação já era passado havia mais de um ano. A tramitação real,
 * desde então, é NA Câmara (relator Aguinaldo Ribeiro, PP-PB), que só
 * devolve o texto ao Senado se o emendar. A prosa do hub abaixo — intro,
 * seção 1, seção 2 e FAQ — narra essa cronologia corrigida, com as fontes
 * oficiais linkadas.
 *
 * **#5630 — este hub NÃO ganhou a tabela de cronologia derivada (Onda 2/
 * #5260).** O padrão de maior volume, `MARCO_LEGAL_PATTERN`, tem 4
 * ocorrências no dataset — abaixo do piso de ≥6 documentado em
 * `buildLaunchChronologyTable` (`scripts/lib/shared/hub-page.ts`); os demais
 * padrões (`eleitoral`, `cfm`, `anatel`, `pbia`, `riscoLei`) têm ainda menos.
 * Tabela de 2-4 linhas não sustenta a mecânica — decisão registrada, não
 * esquecimento.
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
 * criado, nunca revisado ainda).
 *
 * 2026-08-13 (#5124 item 5): busca manual ampliada no corpo de todas as 36
 * edições entre 25/06 e 13/08 (a `checkUpdatedDateCeiling` já tinha
 * sinalizado 48 dias de defasagem) achou 2 desenvolvimentos genuínos de
 * regulação — óculos inteligentes no trânsito e a Matriz de Competências em
 * IA do MGI, ambos de itens de RADAR fora do scan automático título/
 * subtítulo (ver comentário em `generate-hub-sources.ts`) — mas NENHUM
 * evento no nível de Marco Legal/TSE/CFM. A leitura de que a defasagem
 * remanescente reflete cobertura real mais rala do tema nesse intervalo
 * (a alternativa que a issue #5124 tinha levantado, mas o editor não
 * escolheu) fica parcialmente corroborada pelos dados: havia conteúdo pra
 * adicionar, mas não o bastante pra fechar os 21 dias do limiar.
 *
 * 2026-08-18 (#5627): reescrita substancial da errata do Marco Legal —
 * intro/seção 1/FAQ paravam de narrar a manchete errada 4x e passaram a
 * afirmar a cronologia corrigida direto, com a ressalva de procedência
 * movida pra `methodologyNote`. Bump por mudança de CORPO, não por fonte
 * nova — `sourceEditions[0].date` continua 2026-07-03, então o warning de
 * `checkUpdatedDateCeiling` (#5124) só cresce; é esperado até o #5632
 * regenerar `brasil-regulacao-sources.generated.json` com fontes mais
 * recentes. */
const UPDATED_DATE = "2026-08-18";

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
      answer: `Foram ${marcoLegal} manchetes só sobre a tramitação do Marco Legal (PL 2338/23) entre fevereiro e junho de 2026: [Hugo Motta priorizando o texto](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes), [a Câmara agendando voto para 27 de maio](https://diar.ia.br/p/gpt-5-5-instant-chega-como-padr-o-do-chatgpt), [uma manchete sobre a aprovação do Senado no Marco Legal](https://diar.ia.br/p/soberania-ia-pu-blica-nacional) e [a Câmara buscando nova data em junho, articulada com o Redata no Senado](https://diar.ia.br/p/35-mil-bolsas-pra-virar-creator-com-ia).`,
    },
    {
      question: "O Marco Legal da IA já tem autoridade reguladora definida?",
      answer:
        'Ainda não claramente: [o texto em tramitação previa um Sistema Nacional de IA "ainda em disputa quanto à autonomia"](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes), e [o texto que o Senado aprovou em dezembro de 2024](https://diar.ia.br/p/soberania-ia-pu-blica-nacional) [fonte primária](https://www25.senado.leg.br/web/atividade/materias/-/materia/157233) já cria "a autoridade reguladora que vai fiscalizar" sem detalhar o desenho institucional. A definição final dependia da revisão em curso na Câmara, que só devolve o texto ao Senado se o emendar.',
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
    {
      question: "O Congresso já regulamentou o uso de óculos inteligentes com IA no trânsito?",
      answer:
        "Sim: a Comissão de Viação e Transportes da Câmara dos Deputados aprovou, em 25 de junho de 2026, [o PL 19/2026, que cria um \"modo de condução\" obrigatório para óculos inteligentes ao volante — restrito a navegação, assistência de direção e tecnologia assistiva](https://diar.ia.br/p/como-ter-acesso-alexa) [fonte primária](https://www.camara.leg.br/noticias/1285676-comissao-aprova-regras-para-o-uso-de-oculos-inteligentes-no-transito). Usar o dispositivo pra gravar, se comunicar ou se entreter no trânsito vira infração gravíssima, com suspensão da CNH e multa triplicada; fabricantes precisam sinalizar quando o dispositivo está gravando, bloquear reconhecimento facial de terceiros por padrão e avaliar o impacto à proteção de dados antes de vender o produto no Brasil. O texto, do deputado Carlos Zarattini (PT-SP), ainda depende das comissões de Ciência, Tecnologia e Inovação e de Constituição e Justiça, do Plenário da Câmara e do Senado.",
    },
    {
      question: "Que passo concreto o governo federal deu para colocar o PBIA em prática dentro da própria administração pública?",
      answer:
        "Em 3 de julho de 2026, o Ministério da Gestão e da Inovação em Serviços Públicos (MGI), pela Secretaria de Governo Digital (SGD), [divulgou a Matriz de Competências em Inteligência Artificial do governo federal](https://diar.ia.br/p/governo-dos-eua-pode-virar-socio-da-openai) [fonte primária](https://www.gov.br/gestao/pt-br/assuntos/noticias/2026/julho/gestao-lanca-matriz-de-competencias-em-inteligencia-artificial), referência alinhada ao PBIA 2024-2028 que orienta o desenvolvimento de competências em IA na administração federal com ênfase em ética, transparência, não-discriminação, segurança e soberania. A matriz define 6 perfis de servidor — de agente público a alta liderança — e alimenta 11 trilhas de formação gratuitas na Enap e no Serpro, cobrindo IA generativa, ética em IA, LGPD, automação de processos e governança de dados. (Não confundir com a Portaria MGI nº 3.485, de 24 de abril de 2026, que institui a Política de Governança de IA do próprio ministério — ato distinto, anterior e mais restrito, que trata das regras internas do MGI, não da matriz de competências pra toda a administração federal.)",
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
function buildIntro(sources: HubSourceEntry[]): [string, string] {
  const { between } = hubCoverageWindow(sources);
  const { totalEditions, totalMentions, cadenceDays } = deriveBrasilRegulacaoFacts(sources);
  // #5259: array de 2 elementos (orçamento não cabia numa unidade só) + a
  // correção do erro do Senado deixa de repetir o parágrafo inteiro que
  // também aparece em sections[0]/FAQ — vira 1 frase com ponteiro ("mais
  // adiante", não "seção acima/abaixo": HUB_PROSE_RULES id
  // prosa-sem-ponteiro-de-secao proíbe especificamente essa segunda forma).
  // O relato completo, com fonte oficial, mora só em sections[0].paragraphs[2].
  return [
    `Entre ${between}, a regulação de inteligência artificial no Brasil apareceu como destaque em ${totalEditions} edições da diar.ia.br, ${totalMentions} manchetes ao todo, uma a cada ${cadenceDays} dias corridos, em média. O fio mais longo é o Marco Legal da IA, o PL 2338/23: aprovado pelo Plenário do Senado em dezembro de 2024 e remetido à Câmara dos Deputados em março de 2025, o texto seguiu em revisão na Câmara ao longo de todo o período coberto aqui — uma audiência pública sobre direitos autorais em setembro de 2025, um voto agendado para 27 de maio de 2026 que a Câmara adiou, e o relator articulando o texto com o Senado, em junho, pra tentar votar antes do recesso de julho sem precisar de uma segunda rodada de emendas.`,
    `Fora do Marco Legal, uma lei distinta de classificação de sistemas por risco entrou em circulação em maio de 2026 exigindo auditoria obrigatória para sistemas de alto risco e responsabilidade solidária de quem desenvolve ou só implanta o modelo, o Conselho Federal de Medicina normatizou o uso de IA como apoio à decisão clínica, a Anatel contratou nuvem soberana para dados sob sigilo fiscal e bancário, e o TSE limitou conteúdo sintético nas 72 horas antes e nas 24 horas depois do voto de outubro de 2026. Já em junho e julho de 2026, a regulação girou em torno de aplicações mais pontuais: a Câmara avançou com regras de trânsito específicas para óculos inteligentes com IA, e o governo federal publicou a primeira matriz de competências em IA para o funcionalismo público, amarrada ao PBIA.`,
  ];
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
          "Em 6 de maio de 2026, [a Câmara agendou para 27 de maio a votação do marco legal, com o relatório final saindo em 19 de maio](https://diar.ia.br/p/gpt-5-5-instant-chega-como-padr-o-do-chatgpt). O Senado não estava esperando esse resultado para votar — ele já tinha votado: o Plenário aprovou o PL 2338/23 em 10 de dezembro de 2024, com a consulta pública fechada em 35.806 votos a favor e 31.547 contra, e remeteu o texto à Câmara dos Deputados em 17 de março de 2025, com o desenho de uma autoridade reguladora para fiscalizar a lei [fonte primária](https://www25.senado.leg.br/web/atividade/materias/-/materia/157233).",
          "Cinco dias depois da data que a Câmara tinha marcado, em 1º de junho, [o texto ainda buscava nova data de votação, agora articulado com o Redata, a lei de proteção de dados que avança em paralelo no Senado](https://diar.ia.br/p/35-mil-bolsas-pra-virar-creator-com-ia): o relator Aguinaldo Ribeiro (PP-PB) buscava um texto já negociado com os senadores porque, segundo ele, qualquer emenda da Câmara obriga o projeto a voltar ao Senado antes da sanção.",
        ],
      },
      {
        heading: "O que muda com a lei brasileira que classifica sistemas de IA por risco?",
        paragraphs: [
          "Em 25 de maio de 2026, [uma lei brasileira de regulação de sistemas automatizados passou a classificar aplicações por nível de risco — baixo, médio ou alto — com obrigações proporcionais a cada faixa](https://diar.ia.br/p/deepseek-corta-75-do-pre-o-da-api) [fonte primária](https://exame.com/internacional/regulacao-da-ia-no-brasil-o-que-a-nova-lei-muda-para-sua-empresa/). Sistemas de alto risco — crédito, saúde, segurança pública e processos seletivos — ficam sujeitos a auditorias obrigatórias, registro e canais de contestação para quem for afetado, e tanto quem desenvolve quanto quem apenas implanta ou compra um modelo de terceiro responde solidariamente pelo cumprimento das exigências.",
          "A vigência dessa lei, aprovada em 25 de maio de 2026, porém não tinha data certa: quem usa modelo de terceiro em crédito, RH ou saúde precisava revisar contratos e fluxos de auditoria antes de a lei entrar em vigor, não depois. Essa lei é distinta do Marco Legal da IA (PL 2338/23) em si, que seguia em revisão na Câmara na mesma data — a classificação de risco entrou em circulação por conta própria, sem esperar o desfecho do PL 2338/23.",
          'O desenho de fiscalização do Marco Legal já aparecia delineado desde 3 de fevereiro: [o texto então em tramitação previa multas de até 2% do faturamento, teto de R$ 50 milhões, responsabilidade objetiva para sistemas de alto risco, limites ao reconhecimento facial e restrições ao uso de IA no Judiciário](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes). Um Sistema Nacional de IA também estava previsto, mas seguia "em disputa quanto à autonomia" — e a versão que o Senado aprovou em dezembro de 2024 já trazia esse desenho de autoridade reguladora, sem que a Câmara tivesse, até junho de 2026, concluído sua revisão do texto.',
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
    // #5627: ressalva de procedência da errata do Marco Legal — o único
    // lugar do hub que ainda menciona a manchete de 22/05/2026 que tratou a
    // aprovação do Senado como evento daquele mês (`prosa-sem-deixis` isenta
    // este campo, ver docstring de HUB_PROSE_RULES). Uma linha, não quatro —
    // a prosa de intro/seção/FAQ acima já narra só a cronologia corrigida.
    methodologyNote: `${defaultMethodologyNote(SOURCES)} Uma manchete de 22/05/2026 tratou a aprovação do Marco Legal da IA pelo Senado como evento daquele mês; o rastreamento oficial (senado.leg.br, matéria 157233) mostra que essa aprovação ocorreu em 10/12/2024, com remessa à Câmara em 17/03/2025 — a prosa acima usa a cronologia corrigida.`,
  };
}
