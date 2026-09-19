/**
 * deepfake.ts (#8391, 8º hub temático publicado)
 *
 * ⚠️ EDITOU ESTE ARQUIVO? Rode antes de commitar:
 *   npx tsx scripts/build-hub-page.ts --hub deepfake
 * Sem isso, `workers/arquivo/src/hubs/deepfake.generated.ts` fica defasado e
 * `test/hub-page-drift.test.ts` quebra o CI (mesmo aviso que já mordeu os 7
 * hubs anteriores — ver docstring de `anthropic-claude.ts`).
 *
 * ## Por que este hub existe apesar da pausa de produção
 *
 * `docs/geo-hub-experiment.md` registra, em 18/09/2026, a decisão do editor
 * de **parar de criar hub novo**. Esta página é a **EXCEÇÃO ÚNICA** a essa
 * pausa, autorizada pelo editor em 19/09/2026 (#8391). Ela não reabre a
 * produção: qualquer hub seguinte precisa de decisão explícita e nova. O
 * registro canônico da exceção — data, motivo e escopo — vive naquele
 * documento, não aqui; quem chegar a este arquivo procurando "então a
 * produção voltou?" deve ler a seção "Exceção única de 19/09/2026" de lá
 * antes de concluir qualquer coisa.
 *
 * O motivo é um eixo que a pausa não considerou porque o dado ainda não
 * existia quando ela foi tomada: **demanda de busca**. O Google Ads Keyword
 * Planner (Brasil/pt) mede `deepfake` em **33.100 buscas/mês com competição
 * LOW** — a melhor relação volume×alcançabilidade da auditoria de 18/09.
 * O acervo cobre o assunto, o GSC registrava 0 impressão em qualquer
 * consulta com "deepfake", e não havia nenhuma URL cujo ASSUNTO fosse esse.
 *
 * ## Escrito PARA O TERMO, não para a manchete
 *
 * `title`, `h1`, `introHeading`, `sections[].heading` e o FAQ usam o
 * fraseado de BUSCA ("deepfake", "o que é deepfake", "como identificar
 * deepfake", "deepfake é crime"), não o fraseado de manchete dos 7 hubs
 * anteriores ("O que aconteceu com X desde Y?"). É deliberado e é o ponto
 * do experimento: se cobrir o que tem volume, com vocabulário de busca e
 * material próprio, não produzir impressão em 8 semanas, a tese não se
 * sustenta em lugar nenhum (critério pré-registrado na #8391).
 *
 * **As variantes finas do termo NÃO foram puxadas do Keyword Planner.** O
 * comentário de decisão pedia isso; o MCP do Google Ads (#8366) não conecta
 * na máquina onde esta página foi escrita (`pipx` ausente) e ligar o Keyword
 * Planner é tarefa de sessão `develop`. O fraseado abaixo usa o único volume
 * MEDIDO que existe (o termo-raiz, 33.100/LOW, registrado na #8391/#8350) e
 * as variantes de pergunta que o próprio corpus sustenta — nenhum número de
 * variante foi inventado. Refinar o fraseado com os volumes por variante
 * continua em aberto e depende da #8366.
 *
 * ## Lastro: 10 edições, não as 27 da contagem bruta
 *
 * A #8391 cita "27 edições" — contagem BRUTA por regex sobre o CORPO
 * completo dos posts. Aplicada a leitura manual que
 * `docs/entity-page-candidates.md` §Metodologia item 5 exige, a maioria cai:
 * são bullets de OUTRAS NOTÍCIAS/RADAR sem parágrafo próprio (FTC aplicando
 * o Take It Down Act, Oversight Board cobrando a Meta, Hany Farid usando
 * física para detectar imagem sintética, crianças do Reino Unido, OpenAI
 * apoiando leis eleitorais), menção de passagem numa matéria sobre outro
 * assunto (o Iconic Marketplace da ElevenLabs cita deepfake só como o risco
 * que o produto diz endereçar; "Marca d'água do Claude cai em horas" só traz
 * deepfake num item de RADAR) ou entrada de glossário. Restam **10 edições
 * com parágrafo próprio e desenvolvimento real**, que são as listadas em
 * `deepfake-sources.generated.json` — acima do hub mais magro já publicado
 * em contagem de manchete (`brasil-regulacao`), dentro do contrato do #4899
 * ("hub com poucas fontes é pior que hub nenhum").
 *
 * **Verificação de fonte primária feita manchete a manchete.**
 * `generate-hub-sources.ts` resolveu `primarySourceUrls` heuristicamente
 * errados em 4 das 11 manchetes — pegou o link da matéria ADJACENTE, não o
 * da manchete casada ("Deepfake de ministro viraliza" → link do ChatGPT
 * Atlas; "Novo detector de deepfake..." → link do estudo sobre robôs;
 * "Epidemia de deepfakes em escolas" → link do estudo do FLI; "Conteúdos
 * falsos com IA triplicam no Brasil" → link da Reuters sobre IA militar).
 * Nenhum dos 4 é usado abaixo; os links de fonte primária da prosa foram
 * lidos do corpo de cada edição. Mesmo padrão de exclusão já documentado em
 * `mercado-trabalho.ts` e `medicina-saude.ts`.
 *
 * **Fonte é a cobertura da diária, não fato-checado contra tribunais,
 * plataformas ou estudos originais** — este módulo sintetiza o que a
 * diar.ia.br noticiou sobre o tema, no vocabulário que a própria edição
 * usou.
 *
 * Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *   npx tsx scripts/generate-hub-sources.ts --hub deepfake
 *   npx tsx scripts/build-hub-page.ts --hub deepfake
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
import { hubFooterNavUtm } from "../shared/utm-registry.ts";
import sourcesRaw from "./deepfake-sources.generated.json" with { type: "json" };
import type { HubSourceEntry } from "../../generate-hub-sources.ts";

const SOURCES = sourcesRaw as HubSourceEntry[];

/** `YYYY-MM-DD` estático — dia em que a página nasceu. */
const PUBLISHED_DATE = "2026-09-19";

/** `YYYY-MM-DD` estático — dia em que o CORPO foi revisado por último. Nasce
 * igual a `PUBLISHED_DATE` (hub recém-criado, nunca revisado ainda). */
const UPDATED_DATE = "2026-09-19";

/** `matchedHeadlines` vem em NFD antes de normalizar — `countMatching`/
 * `buildLaunchChronologyTable` normalizam pra NFC antes de testar (ver
 * `hub-page.ts`), então os patterns abaixo usam forma acentuada normal. */

/** Manchetes cujo eixo é FRAUDE financeira com identidade sintética —
 * clonagem de rosto/voz usada para tirar dinheiro de alguém. */
const GOLPE_PATTERN = /fraude|golpe/iu;

/** Manchetes cujo eixo é ELEIÇÃO — Justiça Eleitoral, propaganda, remoção
 * de perfil, desinformação política. */
const ELEITORAL_PATTERN = /elei[çc]|eleitoral|\bTSE\b|perfis/iu;

/** Cronologia completa do tema — casa TODAS as manchetes do dataset (as 7
 * que usam a palavra "deepfake" no título mais as 4 que tratam do assunto
 * com outro vocabulário). Serve à tabela da seção 1: 11 eventos datados do
 * mesmo tipo é exatamente a faixa em que `buildLaunchChronologyTable`
 * substitui a prosa-cadeia (regra registrada na docstring daquele helper). */
const CRONOLOGIA_PATTERN = /deep\s?fake|rotulagem|conteúdos falsos|remoção de perfis|propaganda eleitoral/iu;

/**
 * Fatos derivados de `sources` — objeto único que `buildIntro` e
 * `buildDeepfakeFaq` consomem, nunca recalculado em paralelo (mesma
 * disciplina de `deriveMedicinaSaudeFacts`/`deriveMercadoTrabalhoFacts`).
 */
function deriveDeepfakeFacts(sources: HubSourceEntry[]) {
  const { totalEditions, totalMentions } = hubTotals(sources);
  const { firstDate: oldest, lastDate: newest } = hubCoverageWindow(sources);
  const cadenceDays = hubMentionCadenceDays(sources);
  const golpe = countMatching(sources, GOLPE_PATTERN);
  const eleitoral = countMatching(sources, ELEITORAL_PATTERN);
  return { totalEditions, totalMentions, oldest, newest, cadenceDays, golpe, eleitoral };
}

/**
 * Monta o FAQ (mesmo molde da issue #4558 item 3/6: 6-10 perguntas, números
 * reais) — mas com o fraseado de BUSCA que a #8391 pede, não o de manchete.
 * Pure — opera inteiramente sobre `sources` recebido, nunca lê `SOURCES` do
 * módulo direto.
 */
export function buildDeepfakeFaq(sources: HubSourceEntry[]): GeoFaqItem[] {
  const { totalEditions, totalMentions, oldest, newest, cadenceDays, golpe, eleitoral } =
    deriveDeepfakeFacts(sources);

  return [
    {
      question: "O que é um deepfake?",
      answer:
        'Deepfake é conteúdo sintético criado por IA que substitui o rosto ou a voz de uma pessoa real, de forma convincente o bastante para passar por gravação autêntica. A definição aparece em 2 de setembro de 2025 no glossário da edição sobre [a lei chinesa de rotulagem obrigatória de conteúdo gerado por IA](https://diar.ia.br/p/china-implementa-lei-obrigat-ria-de-rotulagem-de-conte-do-gerado-por-ia) [fonte primária](https://news.cgtn.com/news/2025-09-01/China-enforces-new-rules-on-labeling-AI-generated-content-1Gj1GWXQeJi/p.html) — "conteúdo sintético criado por IA que substitui rostos ou vozes". O que separa um deepfake de qualquer outra imagem gerada por IA é a intenção de imitar alguém ou algum fato real, não a técnica.',
    },
    {
      question: "Como identificar um deepfake?",
      answer:
        'Por verificação técnica, não a olho nu. Em 22 de outubro de 2025, [um áudio atribuído ao ministro da Fazenda, Fernando Haddad, foi submetido à plataforma Hiya pela equipe do G1 Fato ou Fake](https://diar.ia.br/p/atlas-concorrente-do-comet) [fonte primária](https://g1.globo.com/fato-ou-fake/noticia/2025/10/21/e-fake-audio-em-que-haddad-diz-que-governo-vai-taxar-tudo-para-comprar-apoio-nas-eleicoes-gravacao-foi-criada-com-ia.ghtml) e marcou 22 pontos numa escala de autenticidade que vai a 100 — inconsistência prosódica, artefato de síntese de voz e padrão espectral não natural. Para quem não tem ferramenta forense à mão, a orientação registrada em 19 de agosto de 2026, na cobertura [da resolução do TSE sobre propaganda eleitoral](https://diar.ia.br/p/tse-exige-aviso-em-propaganda-eleitoral-com-ia) [fonte primária](https://g1.globo.com/jornal-hoje/noticia/2026/08/17/eleicoes-2026-entenda-riscos-do-uso-de-inteligencia-artificial-nas-campanhas-veja-como-identificar-conteudos-criados-por-ia.ghtml), é procedimental: checar a origem do conteúdo, buscar a publicação original e confirmar com veículo confiável antes de acreditar ou compartilhar.',
    },
    {
      question: "Existe detector de deepfake que funciona?",
      answer:
        'Existe, com ressalva de maturidade. Em 17 de novembro de 2025, [pesquisadores da Universidade da Califórnia em Riverside e do Google apresentaram o UNITE](https://diar.ia.br/p/estudo-seguranca-ia-robos-pessoais) [fonte primária](https://gd.eurisko.com.br/2025/11/15/google-e-universidade-da-california-criam-detector-de-deepfakes-que-enxerga-o-que-o-olho-humano-nao-ve), detector que analisa o quadro inteiro do vídeo — fundo e padrão de movimento, não só o rosto — e alcançou precisão entre 95% e 99% em quatro categorias de vídeo testadas. Os próprios autores descreveram a tecnologia como ainda em desenvolvimento, com aplicação prevista em plataforma de rede social, agência de checagem e redação.',
    },
    {
      question: "Quanto dinheiro os golpes com deepfake movimentam no Brasil?",
      answer: `${golpe} manchetes do período trataram de fraude financeira com identidade sintética. Em 14 de julho de 2026, [fraudes com deepfake foram medidas subindo 126% no Brasil em 2025, com fintechs entre os alvos principais](https://diar.ia.br/p/ia-do-google-detecta-c-ncer-raro-no-sus) [fonte primária](https://finsidersbrasil.com.br/noticias-sobre-fintechs/fraudes/deepfake-fraudes-inteligencia-artificial-fintechs-brasil/) — criminosos usam voz e rosto sintéticos para furar a verificação de identidade no cadastro e aprovar transação em nome de cliente real. Em 3 de agosto de 2026, [um vídeo falso do cantor Roberto Carlos expôs um esquema que movimentou R$ 1,8 bilhão em golpes contra bancos brasileiros entre julho de 2025 e abril de 2026](https://diar.ia.br/p/claude-hackeou-3-empresas-sem-ninguem-notar) [fonte primária](https://exame.com/inteligencia-artificial/por-tras-de-um-deepfake-de-roberto-carlos-um-esquema-que-move-r-18-bilhao-em-golpes/), com pacotes de clonagem facial e vocal alugados a partir de US$ 5.`,
    },
    {
      question: "Deepfake é proibido nas eleições de 2026 no Brasil?",
      answer:
        'A obrigação já publicada é de AVISO, e a proibição estava em construção. Em 19 de agosto de 2026, [o TSE publicou resolução obrigando candidatos, partidos, federações e coligações a informar de forma explícita o uso de IA na criação ou alteração significativa de peça de propaganda](https://diar.ia.br/p/tse-exige-aviso-em-propaganda-eleitoral-com-ia) [fonte primária](https://g1.globo.com/jornal-hoje/noticia/2026/08/17/eleicoes-2026-entenda-riscos-do-uso-de-inteligencia-artificial-nas-campanhas-veja-como-identificar-conteudos-criados-por-ia.ghtml). A mesma matéria registra ministros sinalizando a tendência de proibir o uso da tecnologia para criar conteúdo falso de candidato, sem a extensão da proibição definida — e a medida veio depois de a campanha de Flávio Bolsonaro apresentar, na convenção que confirmou a candidatura, um vídeo com avatar de Jair Bolsonaro criado por IA.',
    },
    {
      question: "Quanto cresceu a desinformação com deepfake no Brasil?",
      answer:
        'Mais que triplicou em um ano. Em 6 de fevereiro de 2026, [o primeiro Panorama da Desinformação no Brasil, do Observatório Lupa, mediu alta de 308% em conteúdo falso gerado por IA entre 2024 e 2025](https://diar.ia.br/p/li-deres-militares-evitam-regras-para-ia-em-guerras) [fonte primária](https://agenciabrasil.ebc.com.br/geral/noticia/2026-02/conteudos-falsos-criados-com-ia-mais-que-triplicam-entre-2024-e-2025) — de 39 para 159 casos, saltando de 4,6% para 25% do total de checagens. A mudança de uso é a parte mais dura do estudo: antes a IA servia sobretudo a golpe digital; em 2025 virou arma política, com quase 45% do conteúdo carregando viés ideológico e mais de três quartos explorando imagem ou voz de figura conhecida.',
    },
    {
      question: "O que são os aplicativos de nudify e por que atingem escolas?",
      answer:
        'São aplicativos de IA que geram imagem pornográfica falsa a partir da foto de uma pessoa real. Em 4 de dezembro de 2025, [uma reportagem do Guardian descreveu a disseminação desse uso em escolas do Reino Unido e dos Estados Unidos](https://diar.ia.br/p/estudo-alerta-falhas-de-seguranc-a-em-empresas-de-ia) [fonte primária](https://www.theguardian.com/society/ng-interactive/2025/dec/02/the-rise-of-deepfake-pornography-in-schools): 75% das vítimas têm 14 anos ou menos, há casos com crianças de 11 anos, e a estimativa citada é de quatro alunos por sala de aula no Reino Unido já expostos a imagem de nudez falsa. A assimetria legal é o centro da reportagem — a posse de imagem indecente de criança é crime, mas as ferramentas que a produzem operam livremente.',
    },
    {
      question: "Que medidas o Brasil discutiu para coibir deepfake?",
      answer: `${eleitoral} manchetes do período trataram do eixo eleitoral. Em 3 de fevereiro de 2026, [o ministro Gilmar Mendes propôs uma força-tarefa técnico-pericial, com especialistas e universidades, para identificar rapidamente conteúdo sintético nas eleições](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes) [fonte primária](https://agenciabrasil.ebc.com.br/justica/noticia/2026-02/ministro-propoe-forca-tarefa-para-identificar-deep-fake-nas-eleicoes), junto de acordos com empresas de IA para rastreabilidade e rotulagem. Três dias depois, em 6 de fevereiro, [o governo pediu ao TSE que ampliasse a remoção de perfil durante o período eleitoral](https://diar.ia.br/p/li-deres-militares-evitam-regras-para-ia-em-guerras) [fonte primária](https://www.gazetadopovo.com.br/eleicoes/2026/governo-lula-tse-ampliar-remocao-perfis-limitar-retirada-conteudos-oficiais/), com multa de até R$ 30 mil para quem divulgar desinformação gerada por IA e proibição de chatbot recomendar candidato.`,
    },
    {
      question: "Com que frequência o tema deepfake apareceu como destaque na cobertura de IA?",
      answer: `Entre ${formatDateShort(oldest ?? "")} e ${formatDateShort(newest ?? "")}, o tema apareceu como destaque em ${totalEditions} edições da diar.ia.br, somando ${totalMentions} manchetes. Em média, uma edição a cada ${cadenceDays} dias corridos.`,
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
 * saem do dataset, nunca de literal na prosa (mesma disciplina dos 7 hubs
 * anteriores). Array de 2 elementos (#5259): a quebra natural fica entre
 * "o que é / quem já foi vítima" e "o que a lei e a técnica fizeram". */
function buildIntro(sources: HubSourceEntry[]): [string, string] {
  const { between } = hubCoverageWindow(sources);
  const { totalEditions, totalMentions, cadenceDays, golpe, eleitoral } = deriveDeepfakeFacts(sources);
  return [
    `Deepfake é conteúdo sintético gerado por IA que imita o rosto ou a voz de uma pessoa real com qualidade suficiente para passar por gravação autêntica. Entre ${between}, o assunto apareceu como destaque em ${totalEditions} edições da diar.ia.br, ${totalMentions} manchetes ao todo, uma a cada ${cadenceDays} dias corridos, em média. ${golpe} dessas manchetes tratam de fraude financeira com identidade sintética — fraudes com deepfake subiram 126% no Brasil em 2025 e um único esquema, o do vídeo falso do cantor Roberto Carlos, movimentou R$ 1,8 bilhão contra bancos brasileiros. ${eleitoral} tratam de eleição: um áudio falso do ministro da Fazenda em outubro de 2025, um crescimento de 308% em conteúdo falso gerado por IA entre 2024 e 2025 e uma resolução do TSE de agosto de 2026 obrigando campanha a avisar quando usa IA.`,
    `Do lado das vítimas que não são políticos nem celebridades, a reportagem mais dura do período é de 4 de dezembro de 2025: aplicativos de "nudify" gerando pornografia falsa de colegas em escolas do Reino Unido e dos Estados Unidos, 75% das vítimas com 14 anos ou menos. Do lado das respostas, três frentes apareceram e nenhuma resolveu o problema sozinha — detecção automática (o UNITE, de novembro de 2025, com precisão entre 95% e 99%, descrito pelos próprios autores como ainda em desenvolvimento), rotulagem obrigatória (a China ligou a sua em 1º de setembro de 2025) e norma eleitoral (a força-tarefa pericial proposta em fevereiro de 2026 e a resolução publicada em agosto). Como identificar um deepfake continua sendo, na prática, verificar a origem do conteúdo antes de acreditar nele.`,
  ];
}

export function getDeepfakeHub(): HubContent {
  const { since, until } = hubCoverageWindow(SOURCES);
  return {
    slug: "deepfake",
    title: "Deepfake: o que é e como identificar",
    h1: `Deepfake: o que é, como identificar e o que mudou de ${since} a ${until}`,
    // ≤160 chars (validateHubContent).
    metaDescription: `O que é deepfake, como identificar e o que mudou de ${since} a ${until}: golpes, eleições, pornografia falsa em escolas e detecção.`,
    // Fraseado de busca primeiro ("o que é deepfake", "como identificar"),
    // janela depois — a janela é exigida pelo guard do #4917
    // (`test/hub-prose-contract-4899.test.ts`), que pede a data da primeira
    // fonte no papel de "de/desde/entre" em introHeading/metaDescription/
    // introParagraph. Os dois requisitos coexistem: a pergunta de busca abre
    // o heading e a cobertura fecha.
    introHeading: `O que é um deepfake, como identificar um, e o que mudou de ${since} a ${until}?`,
    introParagraph: buildIntro(SOURCES),
    sections: [
      {
        heading: "O que é um deepfake, e quem já foi vítima de um no Brasil?",
        paragraphs: [
          'A definição operacional apareceu em 2 de setembro de 2025, num glossário: conteúdo sintético criado por IA que substitui rostos ou vozes. Ela veio junto da [lei chinesa que passou a exigir rotulagem explícita e implícita de todo conteúdo gerado por IA online](https://diar.ia.br/p/china-implementa-lei-obrigat-ria-de-rotulagem-de-conte-do-gerado-por-ia) [fonte primária](https://news.cgtn.com/news/2025-09-01/China-enforces-new-rules-on-labeling-AI-generated-content-1Gj1GWXQeJi/p.html), em vigor desde 1º de setembro daquele ano — primeiro grande mercado a tratar transparência de mídia sintética como obrigação legal, e não como boa prática de plataforma. O que distingue um deepfake de qualquer outra imagem gerada por IA não é a técnica, é o alvo: imitar alguém ou algum fato real.',
          'O primeiro caso brasileiro do período é de 22 de outubro de 2025, e é de áudio, não de vídeo: [uma gravação atribuída ao ministro da Fazenda, Fernando Haddad, com declarações falsas sobre aumento de impostos, circulou em redes sociais dentro de um vídeo em que um homem reproduz o áudio pelo celular](https://diar.ia.br/p/atlas-concorrente-do-comet) [fonte primária](https://g1.globo.com/fato-ou-fake/noticia/2025/10/21/e-fake-audio-em-que-haddad-diz-que-governo-vai-taxar-tudo-para-comprar-apoio-nas-eleicoes-gravacao-foi-criada-com-ia.ghtml). O formato importa: áudio dispensa a sincronia labial que ainda denuncia vídeo mal feito, e circula em aplicativo de mensagem sem os metadados que uma plataforma de vídeo preservaria.',
          'Dez meses depois, em 3 de agosto de 2026, [um vídeo com rosto e voz sintetizados do cantor Roberto Carlos promovendo tratamentos milagrosos obrigou a equipe jurídica do artista a se manifestar](https://diar.ia.br/p/claude-hackeou-3-empresas-sem-ninguem-notar) [fonte primária](https://exame.com/inteligencia-artificial/por-tras-de-um-deepfake-de-roberto-carlos-um-esquema-que-move-r-18-bilhao-em-golpes/) — e revelou uma indústria organizada por trás dele. O modelo descrito é de "deepfake as a service": desenvolvedores alugam ferramenta de clonagem facial e vocal, com pacotes a partir de US$ 5, para quadrilhas usarem rostos de celebridade como isca contra idosos. Golpes com deepfake contra bancos brasileiros somaram R$ 1,8 bilhão entre julho de 2025 e abril de 2026, e 42,5% das fraudes financeiras do país em 2025 já envolviam a técnica.',
        ],
        table: buildLaunchChronologyTable(SOURCES, CRONOLOGIA_PATTERN, {
          caption: "Cronologia das manchetes sobre deepfake: manchete, data, dias desde a anterior, edição",
          firstColumnHeader: "Manchete",
        }),
      },
      {
        heading: "Como identificar um deepfake, e a detecção automática já funciona?",
        paragraphs: [
          'O caso do áudio de Fernando Haddad, de 22 de outubro de 2025, mostra o procedimento que funcionou: [a equipe do G1 Fato ou Fake submeteu a gravação à plataforma Hiya, especializada em identificar fala criada ou manipulada por IA](https://diar.ia.br/p/atlas-concorrente-do-comet) [fonte primária](https://g1.globo.com/fato-ou-fake/noticia/2025/10/21/e-fake-audio-em-que-haddad-diz-que-governo-vai-taxar-tudo-para-comprar-apoio-nas-eleicoes-gravacao-foi-criada-com-ia.ghtml), que devolveu 22 pontos numa escala de autenticidade de 0 a 100. A pontuação baixa correspondeu a marcadores técnicos concretos — inconsistência prosódica, artefato de síntese de voz e padrão espectral não natural típico de modelo generativo de áudio —, nenhum deles audível para quem só escuta o arquivo.',
          'A detecção automática deu o salto mais visível do período em 17 de novembro de 2025, quando [pesquisadores da Universidade da Califórnia em Riverside, com cientistas do Google, apresentaram o UNITE](https://diar.ia.br/p/estudo-seguranca-ia-robos-pessoais) [fonte primária](https://gd.eurisko.com.br/2025/11/15/google-e-universidade-da-california-criam-detector-de-deepfakes-que-enxerga-o-que-o-olho-humano-nao-ve). A diferença em relação aos detectores anteriores é onde o sistema olha: em vez de se fixar em característica facial, analisa o quadro inteiro — fundo e padrão de movimento —, procurando inconsistência espacial e temporal. A precisão relatada ficou entre 95% e 99% em quatro categorias de vídeo, com os próprios autores descrevendo a tecnologia como ainda em desenvolvimento.',
          'Para quem não tem ferramenta forense, a orientação prática registrada em 19 de agosto de 2026, junto [da resolução do TSE sobre propaganda eleitoral](https://diar.ia.br/p/tse-exige-aviso-em-propaganda-eleitoral-com-ia) [fonte primária](https://g1.globo.com/jornal-hoje/noticia/2026/08/17/eleicoes-2026-entenda-riscos-do-uso-de-inteligencia-artificial-nas-campanhas-veja-como-identificar-conteudos-criados-por-ia.ghtml), não é visual e sim procedimental: diante de vídeo impactante que aparece pouco antes de um evento decisivo, checar a origem, buscar a publicação original e confirmar com veículo confiável ou com as partes envolvidas. O motivo de a regra ser procedimental está no dado de 7 de janeiro de 2026: [num cenário de excesso de informação e desconfiança generalizada, o usuário tem dificuldade de reconhecer conteúdo sintético a olho nu](https://diar.ia.br/p/ia-nas-eleic-o-es-prepare-se-para-os-deepfakes) [fonte primária](https://apublica.org/2026/01/inteligencia-artificial-e-desinformacao-nas-eleicoes-de-2026/).',
        ],
      },
      {
        heading: "Deepfake é proibido nas eleições? O que a Justiça Eleitoral brasileira já decidiu",
        paragraphs: [
          'O alerta chegou antes da norma. Em 7 de janeiro de 2026, [a diretora do InternetLab, Heloisa Massaro, apontou a IA generativa agravando a desinformação eleitoral ao se integrar a buscador, rede social e sobretudo ao WhatsApp](https://diar.ia.br/p/ia-nas-eleic-o-es-prepare-se-para-os-deepfakes) [fonte primária](https://apublica.org/2026/01/inteligencia-artificial-e-desinformacao-nas-eleicoes-de-2026/). O efeito descrito ali tem duas pontas, e a segunda é menos óbvia: além do conteúdo falso que passa por verdadeiro, existe a estratégia de político que passa a dizer que "tudo é IA" para desacreditar prova real. Regras de rotulagem e remoção já existiam, mas com brecha para rede informal de apoio e para a velocidade de circulação de boato.',
          'Em 3 de fevereiro de 2026, [o ministro Gilmar Mendes propôs uma força-tarefa técnico-pericial, formada por especialistas e universidades, para identificar rapidamente conteúdo sintético em áudio, vídeo e imagem durante as eleições](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes) [fonte primária](https://agenciabrasil.ebc.com.br/justica/noticia/2026-02/ministro-propoe-forca-tarefa-para-identificar-deep-fake-nas-eleicoes), com acordos com empresas de IA para rastreabilidade e rotulagem. Três dias depois, em 6 de fevereiro, [o governo federal pediu ao TSE que ampliasse a remoção de perfil no período eleitoral, sem limitar a ação a conta falsa ou robô](https://diar.ia.br/p/li-deres-militares-evitam-regras-para-ia-em-guerras) [fonte primária](https://www.gazetadopovo.com.br/eleicoes/2026/governo-lula-tse-ampliar-remocao-perfis-limitar-retirada-conteudos-oficiais/), propondo multa de até R$ 30 mil por desinformação gerada por IA e proibição de chatbot recomendar candidato.',
          'A norma saiu em 19 de agosto de 2026: [o TSE publicou resolução obrigando candidatos, partidos, federações e coligações a informar de forma explícita e acessível o uso de IA na criação ou alteração significativa de peça de propaganda](https://diar.ia.br/p/tse-exige-aviso-em-propaganda-eleitoral-com-ia) [fonte primária](https://g1.globo.com/jornal-hoje/noticia/2026/08/17/eleicoes-2026-entenda-riscos-do-uso-de-inteligencia-artificial-nas-campanhas-veja-como-identificar-conteudos-criados-por-ia.ghtml). A proibição de criar conteúdo falso de candidato aparece como tendência sinalizada por ministros, não como regra fechada, e a resolução não veda o uso legítimo da ferramenta para analisar eleitorado ou produzir material. A medida veio depois de a campanha de Flávio Bolsonaro exibir, na convenção que confirmou a candidatura, um vídeo com avatar de Jair Bolsonaro criado por IA, questionado pelo PT no tribunal.',
        ],
      },
      {
        heading: "Quem são as vítimas de deepfake além de políticos e celebridades?",
        paragraphs: [
          'A resposta mais dura do período é sobre crianças. Em 4 de dezembro de 2025, [uma reportagem do Guardian descreveu aplicativos de "nudify" sendo usados por alunos para criar pornografia falsa de colegas e professores em escolas do Reino Unido e dos Estados Unidos](https://diar.ia.br/p/estudo-alerta-falhas-de-seguranc-a-em-empresas-de-ia) [fonte primária](https://www.theguardian.com/society/ng-interactive/2025/dec/02/the-rise-of-deepfake-pornography-in-schools): 75% das vítimas têm 14 anos ou menos, com casos envolvendo crianças de 11, e a estimativa citada é de quatro alunos por sala de aula no Reino Unido já expostos a imagem de nudez falsa. A reportagem registra vítimas que passaram mal em sala ao descobrir as imagens circulando.',
          'A assimetria legal descrita nessa mesma reportagem de 4 de dezembro de 2025 é o que trava a resposta: a posse de imagem indecente de criança é crime, mas as ferramentas que produzem essas imagens operam livremente, acessíveis e fáceis de usar, o que facilita sextorsão e abuso sexual infantil digital. O pedido de especialistas e famílias citado ali é duplo — proibição imediata dos aplicativos de nudificação e reforma de currículo escolar para incluir letramento midiático —, com a observação de que a maioria de pais e professores desconhece a extensão e a mecânica da ameaça.',
          'A vítima seguinte em volume é anônima e não sabe que foi imitada: o cliente de banco. Em 14 de julho de 2026, [fraudes com deepfake foram medidas crescendo 126% no Brasil em 2025, com o país virando o maior alvo da América Latina nesse tipo de golpe](https://diar.ia.br/p/ia-do-google-detecta-c-ncer-raro-no-sus) [fonte primária](https://finsidersbrasil.com.br/noticias-sobre-fintechs/fraudes/deepfake-fraudes-inteligencia-artificial-fintechs-brasil/). O mecanismo descrito não depende de enganar um humano: voz e rosto sintéticos furam a verificação de identidade automatizada no cadastro, driblam a biometria e aprovam transação em nome de cliente real — o que a onda testa é o modelo de verificação que sustenta o sistema financeiro digital.',
        ],
      },
    ],
    faq: buildDeepfakeFaq(SOURCES),
    sourceEditions: toSourceEditions(SOURCES),
    publishedDate: PUBLISHED_DATE,
    updatedDate: UPDATED_DATE,
    footerNavUtm: hubFooterNavUtm("deepfake"),
    methodologyNote: defaultMethodologyNote(SOURCES),
  };
}
