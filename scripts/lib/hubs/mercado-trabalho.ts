/**
 * mercado-trabalho.ts (#4558, 6º hub temático publicado)
 *
 * ⚠️ EDITOU ESTE ARQUIVO? Rode antes de commitar:
 *   npx tsx scripts/build-hub-page.ts --hub mercado-trabalho
 * Sem isso, `workers/arquivo/src/hubs/mercado-trabalho.generated.ts` fica
 * defasado e `test/hub-page-drift.test.ts` quebra o CI (mesmo aviso que já
 * mordeu os 5 hubs anteriores — ver docstring de `anthropic-claude.ts`).
 *
 * Conteúdo editorial do 2º hub TEMÁTICO transversal — `brasil-regulacao` foi
 * o 1º; os 4 anteriores (`anthropic-claude`, `openai-chatgpt`,
 * `google-gemini`, `meta-ai`) são hubs de EMPRESA. Este cobre o impacto da
 * IA no mercado de trabalho: demissão/corte de equipe atribuído a IA,
 * estudos sobre exposição de emprego à automação, mudança de critério de
 * contratação e o que aconteceu com o primeiro degrau da carreira e a carga
 * de trabalho de quem já está empregado. Mesmo critério de qualidade
 * não-negociável da issue #4558: "cada hub precisa carregar uma leitura que
 * só existe porque alguém acompanhou o tema por meses. Hub que reempacota
 * manchete sem síntese própria é conteúdo fino — não ganha citação e ainda
 * arrasta o domínio."
 *
 * **Por que "mercado-trabalho" e não "empregos" ou "trabalho" genérico** —
 * ver o comentário completo da entrada em
 * `scripts/generate-hub-sources.ts::HUB_KEYWORD_PATTERNS`: o pattern exclui
 * de propósito as formas verbais de "trabalhar" (casavam "Comet consegue
 * TRABALHAR em diversas abas", recurso de navegador) e a 3ª pessoa do
 * singular de "cortar" (casava "DeepSeek CORTA 75% do preço da API", corte
 * de preço, não de emprego).
 *
 * **Overlap deliberado com hubs de EMPRESA.** Várias manchetes daqui também
 * aparecem em `meta-ai.ts` (ex: "Meta demite 8 mil para dobrar em IA") — é
 * o mesmo fato, relevante a dois painéis temáticos diferentes (issue #4558:
 * "um hub pode aparecer em mais de um tema"), não sobre-casamento.
 *
 * **Verificação de fonte primária feita manchete a manchete (achado do
 * #5056, aplicado aqui desde o início).** `generate-hub-sources.ts` resolve
 * `primarySourceUrls` por heurística (âncora de texto idêntico, ou rótulo
 * "Aprofunde"/"Saiba mais" na janela até a próxima manchete) — nem sempre
 * acerta quando a manchete-alvo não tem link próprio no HTML cacheado. Antes
 * de escrever qualquer `[fonte primária](url)` abaixo, cada URL resolvida
 * foi conferida contra o texto-âncora real do `<a>` no HTML da edição
 * (`content.free.web`); 5 das 36 URLs resolvidas automaticamente pegaram o
 * texto-âncora genérico "Aprofunde"/"Saiba mais" de um link ADJACENTE, não
 * da manchete em questão (ex: a URL resolvida para "Salesforce demite quase
 * 50% de atendentes" era, na verdade, o link da matéria sobre o Plano
 * Brasileiro de IA, algumas linhas abaixo na mesma edição). Essas 5 manchetes
 * — "Salesforce demite quase 50% de atendentes", "Após demitir 60% dos
 * funcionários...", "Expectativas de impacto de IA no trabalho em 2026",
 * "OpenAI Frontier: IA que vira colega de trabalho" e "Quando a IA é usada
 * como desculpa para cortar empregos" — aparecem abaixo SEM link de fonte
 * primária, só o link interno pra edição da diar.ia.br.
 *
 * **Fonte é a cobertura da diária, não fato-checado contra as empresas/
 * institutos reais** — este módulo sintetiza o que a diar.ia.br noticiou
 * sobre o tema, no vocabulário que a própria diária usou. Não é o papel
 * deste hub verificar a alegação original de cada manchete — isso já
 * aconteceu (ou não) na pesquisa/gate de Stage 1 de cada edição. Exceção
 * pontual registrada: o corpo da edição de 12/06/2026 identifica Dario
 * Amodei como "CEO da DeepMind" — um erro de atribuição da própria edição
 * (Amodei é CEO da Anthropic, fato bem estabelecido e já usado
 * corretamente em `anthropic-claude.ts`). A prosa abaixo usa "Anthropic",
 * não repete o erro.
 *
 * Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *   npx tsx scripts/generate-hub-sources.ts --hub mercado-trabalho
 *   npx tsx scripts/build-hub-page.ts --hub mercado-trabalho
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
import { HUB_MERCADO_TRABALHO_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import sourcesRaw from "./mercado-trabalho-sources.generated.json" with { type: "json" };
import type { HubSourceEntry } from "../../generate-hub-sources.ts";

const SOURCES = sourcesRaw as HubSourceEntry[];

/** `YYYY-MM-DD` estático — dia em que a página nasceu. Ver nota de
 * `hub-page.ts` sobre por que não pode ser `new Date()`, e sobre por que é
 * campo SEPARADO de `UPDATED_DATE` (#4911). */
const PUBLISHED_DATE = "2026-08-12";

/** `YYYY-MM-DD` estático — dia em que o CORPO (síntese abaixo) foi revisado
 * por último. Bump manual quando a prosa for reescrita de forma
 * substancial — nunca cosmético. Nasce igual a `PUBLISHED_DATE` (hub recém-
 * criado, nunca revisado ainda). */
const UPDATED_DATE = "2026-08-13";

/** `matchedHeadlines` vem em NFD — ver a nota completa em `countMatching`,
 * em `scripts/lib/shared/hub-page.ts` (motor único reusado pelos 6 hubs). */
const DEMISSOES_PATTERN = /demit|cort(ar|am|e|es|ando)|corta 10% da equipe/i;
const CONTRATACAO_PATTERN = /contrat/i;

/**
 * Fatos derivados de `sources` — objeto único que `buildIntro` e
 * `buildMercadoTrabalhoFaq` consomem, nunca recalculado em paralelo (mesma
 * disciplina de `deriveBrasilRegulacaoFacts`).
 */
function deriveMercadoTrabalhoFacts(sources: HubSourceEntry[]) {
  const { totalEditions, totalMentions } = hubTotals(sources);
  const { firstDate: oldest, lastDate: newest } = hubCoverageWindow(sources);
  const cadenceDays = hubMentionCadenceDays(sources);
  const demissoes = countMatching(sources, DEMISSOES_PATTERN);
  const contratacao = countMatching(sources, CONTRATACAO_PATTERN);
  return { totalEditions, totalMentions, oldest, newest, cadenceDays, demissoes, contratacao };
}

/**
 * Monta o FAQ (issue #4558 item 3/6: 6-10 perguntas, números reais). Pure —
 * testável sem IO, opera inteiramente sobre o `sources` recebido (nunca lê
 * `SOURCES` do módulo direto — mesma disciplina dos 5 hubs anteriores).
 *
 * As perguntas abaixo não repetem o texto literal do H2 de nenhuma
 * `section` — onde o tema já tem seção de síntese, a pergunta do FAQ pega
 * um ângulo mais estreito (estatística rápida, recorte específico) e aponta
 * de volta pra seção pro relato completo.
 */
export function buildMercadoTrabalhoFaq(sources: HubSourceEntry[]): GeoFaqItem[] {
  const { totalEditions, totalMentions, oldest, newest, cadenceDays, demissoes, contratacao } =
    deriveMercadoTrabalhoFacts(sources);

  return [
    {
      question: "Com que frequência o mercado de trabalho aparece como destaque da cobertura de IA?",
      answer: `Entre ${formatDateShort(oldest ?? "")} e ${formatDateShort(newest ?? "")}, o tema apareceu como destaque em ${totalEditions} edições da diar.ia.br, somando ${totalMentions} manchetes. Em média, uma edição a cada ${cadenceDays} dias corridos.`,
    },
    {
      question: "Quantas vezes a cobertura registrou demissão ou corte de equipe atribuído à IA?",
      answer: `${demissoes} manchetes diferentes, de [600 funcionários da divisão de IA da Meta](https://diar.ia.br/p/microsoft-edge-agora-concorre-com-comet-e-atlas) em outubro de 2025 a [1/3 da equipe do BuzzFeed](https://diar.ia.br/p/claude-hackeou-3-empresas-sem-ninguem-notar) em agosto de 2026, passando por um mês só (março de 2026) em que [9 mil demissões de tecnologia foram atribuídas à IA](https://diar.ia.br/p/copilot-e-gemini-chegam-juntos-coincid-ncia).`,
    },
    {
      question: "O que os grandes estudos dizem sobre quantos empregos estão em risco?",
      answer:
        '[Um estudo de Harvard projeta 92 milhões de empregos em risco de deslocamento até o fim da década, contra 170 milhões de empregos novos criados pela adoção de IA no mesmo período](https://diar.ia.br/p/estudo-de-harvard-estima-92-mi-de-empregos-esta-o-em-risco), com redução de 22% nas contratações de início de carreira nas empresas que já adotam IA. A Boston Consulting Group foi na mesma direção: [entre 50% e 55% dos empregos nos EUA vão sofrer transformação significativa em três anos](https://diar.ia.br/p/50-dos-empregos-mudam-em-3-anos-diz-estudo), com 10% a 15% completamente substituídos em cinco.',
    },
    {
      question: "A IA já mudou como as empresas contratam gente?",
      answer: `Sim, em ${contratacao} manchetes diferentes: [o Sebrae encontrou triagem de currículo automatizada em 44% das PMEs brasileiras](https://diar.ia.br/p/rh-usa-automa-o-para-contratar-e-demitir), [a Nubank passou a exigir "mentalidade de IA" de quem contrata](https://diar.ia.br/p/gemini-3-5-flash-agora-controla-seu-computador), e [um estudo mostrou que modelos superam humanos em viés de seleção de candidato](https://diar.ia.br/p/anthropic-lan-a-o-claude-opus-5).`,
    },
    {
      question: "O emprego de entrada é mesmo o mais vulnerável à automação?",
      answer:
        '[O estudo de Harvard mediu 22% de queda nas contratações de início de carreira](https://diar.ia.br/p/estudo-de-harvard-estima-92-mi-de-empregos-esta-o-em-risco), e dez meses depois [uma reportagem descreveu a IA esvaziando o primeiro degrau da carreira](https://diar.ia.br/p/openai-lanca-gpt-live-para-voz-natural): tarefas de analista júnior e trainee, historicamente onde se aprende o ofício, hoje saem mais rápido de um modelo que de quem está começando.',
    },
    {
      question: "Os dados confirmam a narrativa do apocalipse do emprego, ou a contrariam?",
      answer:
        '[Um levantamento do TechCrunch mediu crescimento de 10,2% na força de trabalho de empresas que adotam IA de forma intensa](https://diar.ia.br/p/claude-fable-5-volta-apos-bloqueio-nos-eua) [fonte primária](https://techcrunch.com/2026/06/29/the-ai-jobs-debate-just-got-messier/), sinal contrário ao discurso de corte generalizado de vaga, mas os ganhos se concentram em empresas já bem-financiadas. [Um mês antes, a MIT Technology Review Brasil já tinha separado o que é dado do que é pânico](https://diar.ia.br/p/empregos-e-automa-o-p-nico-vs-dados): a IA tira tarefas dentro de uma função, não a função inteira, e a velocidade real da disrupção segue abaixo do alarme público.',
    },
    {
      question: "Que caso mostra uma empresa recuando de uma decisão de automação?",
      answer:
        "[A Ford recontratou cerca de 350 inspetores de qualidade veteranos depois que as ferramentas automatizadas não deram conta do padrão de inspeção humana](https://diar.ia.br/p/anthropic-lan-a-sonnet-5) — o caso mais concreto do período de automação revertida por resultado abaixo do esperado.",
    },
    {
      question: "O que a Justiça já decidiu sobre demissão por substituição direta de IA?",
      answer:
        "[Um tribunal de Hangzhou, na China, condenou uma empresa a indenizar um supervisor de qualidade demitido e substituído por um modelo de linguagem](https://diar.ia.br/p/advogadas-paraenses-multadas-por-burlar-ia) [fonte primária](https://www.theguardian.com/world/2026/may/13/china-court-awards-compensation-sacked-worker-replaced-by-ai) — a empresa tinha declarado abertamente a substituição, o que permitiu à corte enquadrar o caso como demissão direta, sem discutir se a automação reorganizou ou eliminou o cargo.",
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
 * `buildIntro` nos 5 hubs anteriores). */
function buildIntro(sources: HubSourceEntry[]): string {
  const { between } = hubCoverageWindow(sources);
  const { totalEditions, totalMentions, cadenceDays, demissoes } = deriveMercadoTrabalhoFacts(sources);
  return `Entre ${between}, o impacto da IA sobre emprego e carreira apareceu como destaque em ${totalEditions} edições da diar.ia.br, ${totalMentions} manchetes ao todo, uma a cada ${cadenceDays} dias corridos, em média. ${demissoes} dessas manchetes registraram demissão ou corte de equipe atribuído diretamente à IA — de 600 funcionários da própria divisão de IA da Meta, em outubro de 2025, a um único mês, março de 2026, em que 9 mil demissões de tecnologia foram atribuídas à automação, e a um corte de até 20% do quadro da Meta cinco meses depois, para financiar a mesma aposta em infraestrutura que motivou os cortes anteriores. Do lado dos estudos de longo prazo, Harvard projetou 92 milhões de empregos em risco e 170 milhões criados até o fim da década, o FMI tratou o tema como problema de política pública, e a Boston Consulting Group estimou que entre 50% e 55% dos empregos nos EUA vão mudar de forma significativa em três anos. A contratação também mudou de critério: quase metade das PMEs brasileiras já filtra currículo por algoritmo, a Nubank passou a exigir "mentalidade de IA" de quem contrata, e um estudo mostrou que modelos superam humanos em viés de seleção. Nem toda a narrativa aponta na mesma direção — um levantamento mediu crescimento de força de trabalho em empresas que adotam IA de forma intensa, e a Ford recontratou veteranos depois que a automação falhou em inspeções de qualidade. Cada um desses pontos aparece detalhado adiante, com data e link para a edição que o registrou.`;
}

export function getMercadoTrabalhoHub(): HubContent {
  const { since, until } = hubCoverageWindow(SOURCES);
  return {
    slug: "mercado-trabalho",
    title: "Mercado de trabalho e IA",
    // H1 carrega o intervalo coberto (o `<title>`/`og:title` continua só
    // `title`, montado em `renderHubPage` — não duplicam o período).
    h1: `Mercado de trabalho e IA — de ${since} a ${until}`,
    // ≤160 chars (validateHubContent) — trecho final enxuto de propósito.
    metaDescription: `Mercado de trabalho e IA no arquivo da diar.ia.br, de ${since} a ${until}: demissões atribuídas à IA, risco de emprego e mudança na contratação.`,
    introHeading: `O que aconteceu com o mercado de trabalho e a IA desde ${since}?`,
    introParagraph: buildIntro(SOURCES),
    sections: [
      {
        heading: "Quantas demissões a cobertura atribuiu diretamente à IA, e em que ritmo elas vieram?",
        paragraphs: [
          'O primeiro corte do período veio em 3 de setembro de 2025, com uma menção rápida: [a Salesforce demitiu quase 50% dos atendentes](https://diar.ia.br/p/brasil-pretende-investir-r-23-bilh-es-em-ia). 40 dias depois, em 13 de outubro de 2025, [uma pesquisa da TALK Digital registrou o caso de um CEO que demitiu 60% dos funcionários, aumentou a receita em 38% e afirmou que outras empresas fariam o mesmo](https://diar.ia.br/p/uso-de-ia-como-terapia-aumenta-5x-no-brasil). 11 dias depois, veio o primeiro corte de uma grande empresa de IA na própria área de IA: em 24 de outubro de 2025, [a Meta confirmou a demissão de cerca de 600 funcionários da sua unidade de IA](https://diar.ia.br/p/microsoft-edge-agora-concorre-com-comet-e-atlas), atribuída a uma reestruturação para eliminar "inchaço organizacional". O TBD Labs, time de elite recém-formado, ficou de fora do corte. 137 dias depois, em 10 de março de 2026, [o setor de tecnologia inteiro somou 9 mil demissões atribuídas à IA só naquele mês](https://diar.ia.br/p/copilot-e-gemini-chegam-juntos-coincid-ncia) [fonte primária](https://opentools.ai/news/2026-tech-layoffs-hit-45000-in-march-ai-and-automation-take-the-lead). Três dias depois, [a Atlassian cortou 10% da equipe para financiar investimento em IA](https://diar.ia.br/p/ia-guia-ataques-dos-eua-no-ira), e mais três dias depois, em 16 de março, [a Meta passou a estudar um corte de até 20% dos seus 79 mil funcionários, cerca de 16 mil pessoas](https://diar.ia.br/p/ia-escreveu-ao-pesquisador-que-estuda-ias-conscientes), pelo mesmo motivo. Amazon, Block e Oracle citaram a mesma justificativa na mesma janela.',
          '25 dias depois desse pico de março, em 10 de abril de 2026, [uma análise da RationalFX publicada pelo Nikkei Asia atribuiu à automação por IA quase metade das 80 mil demissões do setor de tecnologia no primeiro trimestre de 2026](https://diar.ia.br/p/mythos-for-a-reuni-o-emergencial-em-washington) — cerca de 38 mil vagas, 76% delas nos Estados Unidos, concentradas em desenvolvimento de software básico, análise de dados e suporte técnico. 34 dias depois, em 14 de maio, veio o primeiro caso de responsabilização judicial: [um tribunal de Hangzhou condenou uma empresa a indenizar um supervisor de qualidade demitido e substituído por um modelo de linguagem](https://diar.ia.br/p/advogadas-paraenses-multadas-por-burlar-ia) [fonte primária](https://www.theguardian.com/world/2026/may/13/china-court-awards-compensation-sacked-worker-replaced-by-ai), porque a própria empresa tinha declarado abertamente a substituição. Sete dias depois, em 21 de maio, [a Meta demitiu 8 mil pessoas "para dobrar em IA"](https://diar.ia.br/p/google-lan-a-gemini-omni-no-google-i-o), corte e expansão andando juntos. Oito dias depois, [uma pesquisa global mediu que 99% dos CEOs já contam com corte de equipe como parte do planejamento](https://diar.ia.br/p/opus-4-8-mais-racioc-nio-mesmo-pre-o), com back-office, atendimento e suporte como os setores mais citados. 48 dias depois, em 16 de julho, [a Meta foi acusada de usar dados de licença médica para decidir quem demitir](https://diar.ia.br/p/ibm-admite-atraso-em-ia-e-acao-despenca-25). 18 dias depois, em 3 de agosto, [o BuzzFeed demitiu 1/3 da equipe depois de uma aposta em IA que não sustentou a receita esperada](https://diar.ia.br/p/claude-hackeou-3-empresas-sem-ninguem-notar), a manchete mais recente deste arco.',
        ],
      },
      {
        heading: "O que os grandes estudos dizem sobre quantos empregos estão em risco?",
        paragraphs: [
          'O primeiro grande estudo do período saiu em 10 de setembro de 2025: [Harvard projetou 92 milhões de empregos atuais em risco de deslocamento até o fim da década, contra 170 milhões de empregos novos criados pela adoção de IA no mesmo período](https://diar.ia.br/p/estudo-de-harvard-estima-92-mi-de-empregos-esta-o-em-risco) — representante de vendas (67% de risco de substituição) e analista de pesquisa de mercado (53%) lideraram a lista de funções vulneráveis, e as contratações de início de carreira já tinham caído 22% nas empresas que adotam IA. 78 dias depois, em 27 de novembro, [um novo estudo sobre adoção de IA no mercado de trabalho foi publicado](https://diar.ia.br/p/alibaba-entra-no-mercado-de-wereables), e 49 dias depois disso, em 15 de janeiro de 2026, [o FMI tratou o assunto como problema de política pública, não só de mercado — com o Brasil citado como caso de demanda urgente e infraestrutura educacional deficiente](https://diar.ia.br/p/mckinsey-candidatos-devem-dominar-prompts).',
          '53 dias depois, em 9 de março de 2026, [a própria Anthropic apresentou uma métrica de "exposição observada" para medir o risco de substituição de tarefa por IA](https://diar.ia.br/p/anthropic-detalha-impactos-da-ia-no-mercado-de-trabalho), combinando o que os modelos conseguem fazer em teoria com o uso real em ambiente de trabalho, sem aumento claro de desemprego nas profissões mais expostas até aquele momento, mas com desaceleração visível na contratação de jovens de 22 a 25 anos. Dez dias depois, [o CEO da ServiceNow disse à CNBC que o desemprego entre recém-formados pode chegar a 30%](https://diar.ia.br/p/rob-humanoide-escoltado-por-policiais-em-macau) [fonte primária](https://www.theregister.com/2026/03/16/servicenow_grad_jobs_ai/), citando os 5,7% de desemprego e 42,5% de subemprego que o Federal Reserve já media entre recém-formados. 21 dias depois, [a Boston Consulting Group estimou que entre 50% e 55% dos empregos nos EUA vão sofrer transformação significativa em três anos, com 10% a 15% completamente substituídos em cinco: operador de call center no topo do risco](https://diar.ia.br/p/50-dos-empregos-mudam-em-3-anos-diz-estudo). 21 dias depois, em 30 de abril, [o Goldman Sachs estimou 300 milhões de empregos globais expostos à automação, e uma reportagem mostrou o Brasil batendo recorde de emprego formal ao mesmo tempo em que a maioria das admissões de jovens de 18 a 24 anos se concentra em funções de alta exposição: operador de caixa, atendente, auxiliar administrativo](https://diar.ia.br/p/brasil-emprega-mais-em-cargos-que-somem), justamente o primeiro degrau da carreira que a IA já executa a custo marginal zero. 76 dias depois, em 15 de julho, [a OCDE mediu emprego em nível recorde nos países-membros, mas com jovens sem conseguir entrar no mercado](https://diar.ia.br/p/terroristas-driblam-chatbots-para-montar-armas) [fonte primária](https://canaltech.com.br/mercado/paradoxo-da-ia-emprego-bate-recorde-mas-jovens-nao-conseguem-entrar-no-mercado/), o mesmo paradoxo que o caso brasileiro já tinha mostrado meses antes.',
        ],
      },
      {
        heading: "Como a IA já mudou quem contrata e quem é demitido?",
        paragraphs: [
          'Em 28 de maio de 2026, [o Sebrae encontrou triagem de currículo automatizada em 44% das PMEs brasileiras](https://diar.ia.br/p/rh-usa-automa-o-para-contratar-e-demitir) [fonte primária](https://exame.com/tecnologia/examelab/como-os-rhs-estao-usando-ia-para-contratar-monitorar-e-ate-demitir/): a plataforma ranqueia candidato e descarta perfil sem que o recrutador abra o documento, e em alguns setores o próprio desligamento passa por recomendação automatizada, sem regulação específica brasileira para decisão de RH tomada por algoritmo. 22 dias depois, em 19 de junho, [a Serasa revelou 47,7% de adesão ao próprio RH algorítmico](https://diar.ia.br/p/alexa-chega-ao-brasil-por-r-100-ao-mes), um benchmark de adoção em empresa de grande porte. Seis dias depois, [a Nubank passou a exigir "mentalidade de IA" de quem contrata](https://diar.ia.br/p/gemini-3-5-flash-agora-controla-seu-computador) — o volume de vagas não caiu, mas quem ainda trata IA generativa como novidade perde espaço no processo seletivo.',
          '15 dias depois, em 10 de julho, [um episódio de podcast do Canaltech descreveu o domínio de assistentes de IA deixando de ser diferencial e virando pré-requisito de contratação em vagas de tecnologia](https://diar.ia.br/p/openai-lanca-gpt-5-6-mais-rapido-e-barato): recrutador já filtra currículo pela familiaridade com IA antes da entrevista técnica. Seis dias depois, [o Google passou a permitir uso de ferramentas generativas durante entrevista técnica de engenharia de software](https://diar.ia.br/p/ibm-admite-atraso-em-ia-e-acao-despenca-25), reconhecendo que o assistente já faz parte do trabalho diário. Corrigir código gerado automaticamente virou parte do teste. 11 dias depois, [uma reportagem da MIT Technology Review Brasil mostrou modelos usados em contratação mais propensos que humanos a desenvolver viés de seleção](https://diar.ia.br/p/anthropic-lan-a-o-claude-opus-5) [fonte primária](https://mittechreview.com.br/ia-vieses-contratacao-humanos/): o sistema cria associação discriminatória nova, que não estava nos dados de treinamento original. 14 dias depois, em 10 de agosto, [levantamento do Pandapé com a Adecco mostrou 70% das empresas brasileiras já usando IA em alguma etapa do recrutamento, e candidatos respondendo com prompt escondido no próprio currículo pra tentar manipular a triagem](https://diar.ia.br/p/ia-de-stanford-cria-virus-funcional-em-lab). Um dia depois, [recrutadores passaram a relatar candidato representado por avatar sintético em entrevista de emprego, com voz e expressão facial simuladas, em vez de aparecer pessoalmente por vídeo](https://diar.ia.br/p/medicina-teme-formar-medicos-sem-raciocinio), com recrutador do outro lado às vezes usando a mesma tecnologia pra conduzir a triagem.',
        ],
      },
      {
        heading: "O primeiro degrau da carreira sumiu, ou só a carga de trabalho de quem já está empregado aumentou?",
        paragraphs: [
          'Em 11 de setembro de 2025, [uma pesquisa da Michael Page mostrou profissionais brasileiros de TI como os menos preocupados do mundo com o impacto da IA na própria carreira](https://diar.ia.br/p/profissionais-brasileiros-de-ti-s-o-os-menos-preocupados-com-impacto-da-ia-na-carreira) — 54% acham que a IA vai afetar a trajetória profissional, contra 63% da média global, mesmo sendo o grupo que mais usa IA no trabalho (68% de uso regular). Um dia depois, o mesmo levantamento mediu o outro lado: [77% dos profissionais afirmaram que a IA aumentou a carga de trabalho em vez de reduzi-la](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-fe0ef8033adea), com 64% relatando prejuízo à própria produtividade por causa da curva de aprendizado e de integração entre sistemas. 153 dias depois, em 12 de fevereiro de 2026, [a Harvard Business Review analisou oito meses de adoção de IA numa empresa de tecnologia com 200 funcionários e confirmou o padrão: o trabalho quase não diminui, ele acelera e se espalha](https://diar.ia.br/p/ia-na-o-reduz-trabalho-ela-acelera-o-burnout) — mais tarefas simultâneas, expediente estendido, fadiga cognitiva e risco de burnout como efeito colateral do ganho inicial de produtividade.',
          '111 dias depois, em 3 de junho de 2026, [a OpenAI ampliou o escopo do Codex de acelerador de código para copiloto de trabalho analítico e de conhecimento em geral](https://diar.ia.br/p/github-copilot-cre-ditos-mensais-acabam-em-horas), mirando analista e consultor como público-alvo direto. A disputa por ocupar o centro do trabalho intelectual nas empresas foi além da engenharia. Cinco dias depois, [uma reportagem descreveu o dano ainda por vir aos empregos de entrada](https://diar.ia.br/p/a-ia-se-reescreve-e-a-anthropic-pede-um-freio). Oito dias depois, [uma pesquisa da Glean com profissionais do Reino Unido mediu 6,3 horas por semana gastas supervisionando e corrigindo erro de ferramenta de IA](https://diar.ia.br/p/sp-vai-mapear-surtos-de-dengue-por-bairro) [fonte primária](https://canaltech.com.br/inteligencia-artificial/funcionarios-perdem-mais-de-6-horas-por-semana-corrigindo-erros-de-ia/), tempo suficiente pra deixar o ganho líquido de produtividade perto de zero em função sem verificação integrada ao fluxo, e 77% dos respondentes disseram que erro de IA já prejudicou a própria reputação profissional. Oito dias depois, [a Tigre revelou que a EducaTigre, sua plataforma de capacitação, já emitiu 200 mil certificados pra driblar o que a empresa chama de "apagão de competências"](https://diar.ia.br/p/a-anthropic-coloca-claude-dentro-do-slack) [fonte primária](https://exame.com/carreira/tigre-aposta-em-capacitacao-e-ia-para-driblar-o-apagao-de-competencias-e-transformar-carreiras/), mão de obra qualificada faltando num ambiente cada vez mais automatizado. 14 dias depois, em 8 de julho, [um podcast da MIT Technology Review Brasil questionou chamar agente autônomo de "colega de trabalho"](https://diar.ia.br/p/claude-cowork-chega-ao-celular-e-a-web): a metáfora carrega expectativa de julgamento e responsabilidade que nenhum sistema atual sustenta. Um dia depois, [a mesma publicação descreveu a IA esvaziando o primeiro degrau da carreira](https://diar.ia.br/p/openai-lanca-gpt-live-para-voz-natural), fechando o arco aberto pelo estudo de Harvard dez meses antes.',
        ],
      },
      {
        heading: "A narrativa do apocalipse do emprego se sustenta, ou os dados a contrariam?",
        paragraphs: [
          'Em 5 de novembro de 2025, [o próprio LinkedIn registrou alta em vagas relacionadas a IA](https://diar.ia.br/p/data-centers-no-espaco) — o contraponto de criação de emprego que a narrativa de substituição tende a ofuscar. 47 dias depois, em 22 de dezembro, [uma edição levantou expectativas de impacto da IA no trabalho para 2026](https://diar.ia.br/p/bootcamp-5-mil-bolsas-para-curso-de-ia), e sete dias depois, [outra descreveu a IA transformando o trabalho rapidamente](https://diar.ia.br/p/manoel-de-no-brega-volta-a-tv). 38 dias depois, em 5 de fevereiro de 2026, [a OpenAI apresentou o Frontier posicionando a própria IA como "colega de trabalho"](https://diar.ia.br/p/a-escolha-da-anthropic-por-um-claude-sem-anu-ncios) — a moldura otimista do lado das empresas de IA. Cinco dias depois, veio o contraponto cético: [uma edição questionou quando a IA é usada como desculpa pra cortar emprego que seria cortado de qualquer forma](https://diar.ia.br/p/openai-vs-anthropic-a-batalha-de-ia-no-super-bowl), sem atribuir a automação sozinha à decisão.',
          '115 dias depois, em 5 de junho de 2026, [a MIT Technology Review Brasil separou pânico de dado real no mercado americano](https://diar.ia.br/p/empregos-e-automa-o-p-nico-vs-dados): a IA tira tarefa dentro de uma função, raramente a função inteira, e a velocidade real da disrupção segue abaixo do alarme público. Outras revoluções tecnológicas já mostraram novo emprego surgindo em setor diferente, com atraso. Sete dias depois, veio a voz mais dura do período: [Dario Amodei, CEO da Anthropic, disse que a perda de emprego causada por IA pode ser permanente, não uma fase de transição](https://diar.ia.br/p/amodei-desemprego-pode-ser-permanente) [fonte primária](https://exame.com/inteligencia-artificial/ia-pode-acabar-com-empregos-de-forma-permanente-e-isso-pode-ser-inevitavel-diz-ceo-da-anthropic/), recusando a promessa padrão do setor de que emprego novo compensa o posto eliminado, e defendendo redistribuição de renda em vez de aposta só na tecnologia. 19 dias depois, veio o caso mais concreto de recuo: [a Ford recontratou cerca de 350 inspetores de qualidade veteranos depois que a automação não deu conta do padrão de inspeção humana](https://diar.ia.br/p/anthropic-lan-a-sonnet-5). Um dia depois, [um levantamento do TechCrunch mediu crescimento de 10,2% na força de trabalho de empresas que adotam IA de forma intensa](https://diar.ia.br/p/claude-fable-5-volta-apos-bloqueio-nos-eua) [fonte primária](https://techcrunch.com/2026/06/29/the-ai-jobs-debate-just-got-messier/), contrariando a narrativa de extinção em massa — com a ressalva de que o ganho se concentra em quem já tinha caixa pra investir. 11 dias depois, [o Guardian mapeou os empregos mais blindados contra a IA em seis setores](https://diar.ia.br/p/os-empregos-mais-blindados-contra-a-ia): tarefa administrativa repetitiva concentra o risco, julgamento clínico, jurídico e financeiro segue resistente. 11 dias depois, [uma edição registrou empresa cortando vaga porque cliente já prefere IA no atendimento](https://diar.ia.br/p/reddit-e-jornais-cogitam-banir-o-google). 12 dias depois, em 5 de agosto, [câmeras com visão computacional assumiram a gestão e o faturamento de tarifa operacional em dois aeroportos brasileiros](https://diar.ia.br/p/ia-por-tras-de-50-dos-cibercrimes-africanos), tarefa administrativa de retaguarda que raramente entra na discussão sobre IA e emprego, mais focada no atendimento ao público. Oito dias depois, em 13 de agosto, o arco fechou onde começou: [uma reportagem revisitou a previsão de Amodei, de maio de 2025, de que "metade" das vagas de nível de entrada em escritórios desapareceria — e a de Sam Altman, um mês depois, sobre o fim de "certas categorias" inteiras de profissão — e concluiu que a devastação não apareceu na escala prometida](https://diar.ia.br/p/amodei-previu-colapso-do-emprego-nao-veio) [fonte primária](https://www.theguardian.com/technology/2026/aug/12/ai-job-destruction). O mercado muda, mas mais devagar do que os CEOs anteciparam, e economistas ainda esperam mais transformação adiante, só que sem prazo definido — a manchete mais recente do arco, e a que mais diretamente testa a previsão que abriu essa discussão.',
        ],
      },
    ],
    faq: buildMercadoTrabalhoFaq(SOURCES),
    sourceEditions: toSourceEditions(SOURCES),
    publishedDate: PUBLISHED_DATE,
    updatedDate: UPDATED_DATE,
    footerNavUtm: HUB_MERCADO_TRABALHO_FOOTER_NAV_UTM,
    methodologyNote: defaultMethodologyNote(SOURCES),
  };
}
