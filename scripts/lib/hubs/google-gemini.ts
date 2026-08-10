/**
 * google-gemini.ts (#4558, 3º hub temático publicado)
 *
 * ⚠️ EDITOU ESTE ARQUIVO? Rode antes de commitar:
 *   npx tsx scripts/build-hub-page.ts --hub google-gemini
 * Sem isso, `workers/arquivo/src/hubs/google-gemini.generated.ts` fica
 * defasado e `test/hub-page-drift.test.ts` quebra o CI (#4897 — já
 * aconteceu 3x na mesma sessão antes deste aviso existir).
 *
 * Conteúdo editorial do 3º hub temático — Google/Gemini. Segue o mesmo
 * template estrutural e de qualidade de `anthropic-claude.ts` (#4558, 1º hub
 * temático): mesmo shape de `HubContent`, mesma `countMatching` com normalização
 * NFC, mesma função de FAQ pura recebendo `sources` por parâmetro (nunca lê
 * `SOURCES` do módulo direto dentro da função — achado do fleet review
 * original, replicado aqui de propósito).
 *
 * **Critério de qualidade da issue #4558 (não-negociável):** as seções
 * abaixo conectam pontos ao longo de ~11 meses de cobertura (só visível
 * olhando o ARQUIVO inteiro, não uma edição isolada) — não reempacotam
 * manchete.
 *
 * **Precisão do escopo "número computado, nunca solto":** só as respostas
 * do `faq` são de fato COMPUTADAS em runtime, via `countMatching`/
 * `buildGoogleGeminiFaq` sobre `SOURCES`. Os números na prosa de
 * `sections`/`INTRO` (datas, contagens, hiatos em dias) são TRANSCRITOS À
 * MÃO a partir do mesmo dataset no momento em que a prosa foi escrita —
 * corretos hoje (verificado ao vivo contra `SOURCES`, um a um, com script
 * de apoio antes de escrever qualquer frase), mas não recalculados a cada
 * regeneração de `sources.generated.json`. Ver a nota equivalente em
 * `anthropic-claude.ts` sobre o teste de consistência de
 * `test/build-hub-page.test.ts` — mesma disciplina se aplica aqui.
 *
 * **Fonte é a cobertura da diária, não fato-checado contra o Google
 * real** — este módulo sintetiza o que a diar.ia.br noticiou sobre o tema,
 * no vocabulário que a própria diária usou. Não é o papel deste hub
 * verificar a alegação original de cada manchete — isso já aconteceu (ou
 * não) na pesquisa/gate de Stage 1 de cada edição.
 *
 * Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *   npx tsx scripts/generate-hub-sources.ts --hub google-gemini
 *   npx tsx scripts/build-hub-page.ts --hub google-gemini
 */
import type { GeoFaqItem } from "../shared/geo-faq.ts";
import { hubCoverageWindow, type HubContent, type HubSourceEdition } from "../shared/hub-page.ts";
import { HUB_GOOGLE_GEMINI_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import sourcesRaw from "./google-gemini-sources.generated.json" with { type: "json" };
import type { HubSourceEntry } from "../../generate-hub-sources.ts";

const SOURCES = sourcesRaw as HubSourceEntry[];

/** `YYYY-MM-DD` estático — dia em que a página nasceu (`72ad89f2`, #4790).
 * Ver nota de `hub-page.ts` sobre por que não pode ser `new Date()`, e sobre
 * por que é campo SEPARADO de `UPDATED_DATE` (#4911). */
const PUBLISHED_DATE = "2026-08-09";

/** `YYYY-MM-DD` estático — dia em que o CORPO foi revisado por último. Bump
 * manual quando a prosa for reescrita de forma substancial — uma
 * regeneração rotineira de `sources.generated.json` NÃO invalida a data
 * sozinha, mas PODE desincronizar os números computados do `faq` dos
 * números transcritos à mão em `sections`/`INTRO` (mesma ressalva de
 * `anthropic-claude.ts`); bump sem mudança de corpo é o padrão que o #4911
 * desaconselha. */
const UPDATED_DATE = "2026-08-10";

/** Mesma normalização NFC de `anthropic-claude.ts` — o `matchedHeadlines`
 * de `sources.generated.json` vem em NFD (acento como combining mark
 * separado). Recebe `sources` como parâmetro (não lê `SOURCES` do módulo
 * direto) para que `buildGoogleGeminiFaq` continue inteiramente pura e
 * testável com fixture sintético. */
function countMatching(sources: HubSourceEntry[], pattern: RegExp): number {
  let n = 0;
  for (const s of sources) {
    for (const h of s.matchedHeadlines) {
      if (pattern.test(h.normalize("NFC"))) n++;
    }
  }
  return n;
}

function formatDateLabel(dateIso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso);
  if (!m) return dateIso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Monta o FAQ (issue #4558 item 3/6: 6-10 perguntas, números reais). Pure —
 * testável sem IO, opera inteiramente sobre o `sources` recebido (nunca lê
 * `SOURCES` do módulo direto — ver nota de `countMatching`).
 */
export function buildGoogleGeminiFaq(sources: HubSourceEntry[]): GeoFaqItem[] {
  const totalMentions = sources.reduce((n, s) => n + s.matchedHeadlines.length, 0);
  const totalEditions = sources.length;
  const oldest = sources[0]?.date;
  const newest = sources[sources.length - 1]?.date;

  // Cada padrão abaixo foi desenhado e testado ao vivo (script de apoio,
  // não commitado) contra `google-gemini-sources.generated.json` até bater
  // exatamente o número citado na prosa da `section` correspondente — a
  // mesma disciplina do `anthropic-claude.ts` original.
  const launches = countMatching(
    sources,
    /gemini 2[.,]5 flash image|novo modelo de v[íi]deo|^tudo sobre gemini 3$|nano banana pro|gemini 3 flash e manus|gemini 3\.1 pro|nano banana 2: melhor|gemini omni|nano banana 2 lite: gera[çc][ãa]o|trio gemini 3\.6/i,
  );
  const chatgpt = countMatching(sources, /chatgpt/i);
  const brasil = countMatching(sources, /brasil/i);
  const nanoBanana = countMatching(sources, /nano banana/i);
  const saude = countMatching(sources, /\bsus\b|c[âa]ncer|m[eé]dicos/i);
  const educacao = countMatching(sources, /curso|treinamento/i);
  const investe = countMatching(sources, /investe/i);
  const regulatorio = countMatching(sources, /banir|ue obriga|domina.*buscas/i);

  // Achado do editor no hub anterior (260804), replicado aqui: as perguntas
  // abaixo não podem repetir o texto literal do H2 de nenhuma `section`.
  // Onde o tema já tem uma seção de síntese, a pergunta do FAQ pega um
  // ângulo mais estreito (estatística rápida, sub-tópico específico) e
  // aponta de volta pra seção pro relato completo.
  return [
    {
      question: "Com que frequência o Google ou o Gemini viram notícia?",
      answer: `Entre ${formatDateLabel(oldest ?? "")} e ${formatDateLabel(newest ?? "")}, o Google ou o Gemini apareceram em ${totalEditions} edições da diar.ia.br, somando ${totalMentions} manchetes: quase uma menção a cada 5 dias corridos ao longo de 11 meses.`,
    },
    {
      question: "Quantos lançamentos de modelo ou ferramenta o Google teve nesse período?",
      answer: `Foram ${launches} lançamentos entre 27/08/2025 e 22/07/2026, em 3 surtos separados por hiatos: 5 modelos em 107 dias até dezembro de 2025, depois 2 em 6 dias em fevereiro de 2026, e 3 em 62 dias a partir de maio. Os hiatos entre eles foram de 63 e de 84 dias — este o mais longo do período.`,
    },
    {
      question: "O Gemini já \"venceu\" o ChatGPT?",
      answer: `A palavra "ChatGPT" apareceu ao lado do Gemini em ${chatgpt} manchetes diferentes, incluindo uma pergunta direta, ["O Gemini venceu o ChatGPT?"](https://diar.ia.br/p/o-gemini-venceu-o-chatgpt), que nunca foi respondida com um "sim" categórico. A narrativa vai da OpenAI se dizendo ameaçada pelos resultados do Google, em novembro de 2025, à disputa ampliada para Meta e DeepSeek, em abril de 2026.`,
    },
    {
      question: "Quantas vezes o Gemini foi anunciado como novidade chegando ao Brasil?",
      answer: `Pelo menos ${brasil} manchetes trataram o Brasil como destino de um lançamento ou investimento do Google, incluindo um caso em que [a mesma função chegou ao país duas vezes com nomes diferentes](https://diar.ia.br/p/nvidia-anuncia-investimento-de-us-100-bi-na-openai), com 14 dias de intervalo. A sequência vai do AI Mode em setembro de 2025 ao fundo de investimento local em junho de 2026.`,
    },
    {
      question: "O que é o Nano Banana e quantas vezes ele apareceu na cobertura?",
      answer: `O Nano Banana (a linha de geração de imagem do Google) apareceu em ${nanoBanana} manchetes: [Nano Banana Pro](https://diar.ia.br/p/sao-paulo-oferece-cursos-de-ia-gratuitos), [Nano Banana 2](https://diar.ia.br/p/claude-opus-3-se-aposenta-e-vira-blogueiro) e, mais recentemente, o [Nano Banana 2 Lite](https://diar.ia.br/p/anthropic-lan-a-sonnet-5), lançado e, 5 dias depois, [detalhado de novo por gerar imagem em 4 segundos](https://diar.ia.br/p/testei-a-alexa-por-uma-semana-o-que-mudou).`,
    },
    {
      question: "O Google já usou IA para resolver um problema de saúde real?",
      answer: `Sim, ${saude} casos concretos: [um sistema do Google igualando médicos em teste clínico](https://diar.ia.br/p/sistema-do-google-iguala-m-dicos-em-teste) e, 26 dias depois, [a mesma IA detectando um câncer raro dentro do SUS](https://diar.ia.br/p/ia-do-google-detecta-c-ncer-raro-no-sus). Os dois fecham uma escalada que começa em pesquisa pura, com o Gemini 3 resolvendo um problema descrito como "insolúvel" na ciência em fevereiro de 2026.`,
    },
    {
      question: "Quantos cursos gratuitos de IA o Google já ofereceu no Brasil?",
      answer: `Foram ${educacao} iniciativas de formação em IA ao longo de 5 meses, de treinamento em cinema a curso online aos sábados. O arco fecha 146 dias depois do último curso, de um jeito quase irônico: o Google passou a liberar o uso de IA dentro das próprias entrevistas técnicas de emprego.`,
    },
    {
      question: "Qual foi o maior investimento em infraestrutura de IA que o Google anunciou no período?",
      answer: `O maior número citado foi US$ 15 bilhões, [anunciado em 19 de fevereiro de 2026](https://diar.ia.br/p/lula-na-maior-cupula-global-de-ia-bde9c122905d2d79), mas foram ${investe} manchetes de investimento direto no período, sem contar o hardware próprio (a 8ª geração de TPUs do Google Cloud) nem o fundo de IA feito no Brasil ao lado da Monashees.`,
    },
    {
      question: "Por que o tamanho do Google no mercado de buscas virou motivo de alarme regulatório?",
      answer: `Em 9 dias de julho de 2026 saíram ${regulatorio} manchetes que, lidas juntas, explicam o alarme: a União Europeia forçando o Google a abrir dados para rivais, editoras cogitando banir o buscador e um estudo mostrando a IA do Google dominando 43% das buscas nos EUA.`,
    },
    {
      question: "Como acompanho as próximas notícias sobre Google e Gemini?",
      answer:
        "Assine a diar.ia.br. A newsletter cobre lançamentos, expansão de produto e movimentos regulatórios do Google conforme acontecem, de segunda a sexta, e o arquivo temático é atualizado periodicamente para refletir a cobertura mais recente.",
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

/** INTRO derivada de `sources` (#4917 item 1) — ver a nota gêmea em
 * `anthropic-claude.ts`. A janela deste hub já estava correta (a #4895/#4896
 * consertou aqui primeiro); derivar impede que ela volte a divergir no
 * próximo regen, que foi o que aconteceu nos dois gêmeos. */
function buildIntro(sources: HubSourceEntry[]): string {
  const { betweenLong } = hubCoverageWindow(sources);
  const totalEditions = sources.length;
  const totalMentions = sources.reduce((n, s) => n + s.matchedHeadlines.length, 0);
  return `Entre ${betweenLong}, o Google e o Gemini foram destaque em ${totalEditions} edições da diar.ia.br, ${totalMentions} manchetes ao todo, quase uma menção a cada 5 dias corridos ao longo de 11 meses. Olhando o arquivo inteiro, não uma edição isolada, um padrão salta aos olhos: os lançamentos de modelo não vêm num fluxo parelho, vêm em 3 surtos separados por hiatos, o mais longo deles de 84 dias entre fevereiro e maio de 2026. Houve também uma inversão de narrativa: um Google descrito como ameaçado pelos resultados da OpenAI em novembro de 2025 virou, cerca de 4 meses e meio depois, um Google apostando abertamente contra Meta e DeepSeek também. No Brasil, o Gemini foi anunciado como novidade em pelo menos 6 manchetes diferentes, do AI Mode em setembro de 2025 a um fundo de investimento local em junho de 2026, incluindo um caso em que a mesma função chegou ao país duas vezes, com nomes diferentes, em 2 semanas de intervalo. Do lado da aplicação prática, o Gemini foi de "resolve o insolúvel na ciência" a detectar câncer raro dentro do SUS. O período termina em tensão: em 9 dias de julho de 2026 vieram a União Europeia forçando o Google a abrir dados para rivais, editoras cogitando banir o buscador e um estudo mostrando que a IA do Google já domina 43% das buscas nos EUA. Cada um desses pontos aparece detalhado adiante, com data e link para a edição que o registrou.`;
}

export function getGoogleGeminiHub(): HubContent {
  return {
    slug: "google-gemini",
    title: "Google e Gemini",
    metaDescription:
      "Google e Gemini no arquivo da diar.ia.br, de agosto de 2025 a julho de 2026: ritmo de lançamento de modelo, expansão pelo Brasil, a disputa com o ChatGPT, usos em saúde e o início do alarme regulatório.",
    introHeading: "O que aconteceu com o Google e o Gemini desde agosto de 2025?",
    introParagraph: buildIntro(SOURCES),
    sections: [
      {
        heading: "Com que ritmo o Google lança modelo novo de Gemini (e de Nano Banana)?",
        paragraphs: [
          "O Google lançou 10 modelos ou ferramentas entre 27 de agosto de 2025 e 22 de julho de 2026, mas o ritmo não foi constante: vieram em 3 surtos separados por 2 hiatos, um deles o mais longo de todo o período. No primeiro surto, 5 lançamentos couberam em 107 dias: [Gemini 2.5 Flash Image](https://diar.ia.br/p/google-lan-a-gemini-2-5-flash-image), [o Veo 3.1](https://diar.ia.br/p/google-veo-3-1), [o próprio Gemini 3](https://diar.ia.br/p/tudo-sobre-gemini-3), [Nano Banana Pro](https://diar.ia.br/p/sao-paulo-oferece-cursos-de-ia-gratuitos) e [Gemini 3 Flash](https://diar.ia.br/p/openai-cria-treinamento-gratuito-para-jornalistas).",
          "Depois veio um hiato de 63 dias sem nenhum lançamento novo, de 19 de dezembro de 2025 a 20 de fevereiro de 2026. Nessa janela as manchetes giraram em torno da disputa com o ChatGPT, não de produto novo. O segundo surto foi o mais compacto de todos: [Gemini 3.1 Pro](https://diar.ia.br/p/novo-curso-de-ia-do-google) e [Nano Banana 2](https://diar.ia.br/p/claude-opus-3-se-aposenta-e-vira-blogueiro) saíram com apenas 6 dias de diferença entre si.",
          "O hiato seguinte foi o mais longo do período: 84 dias entre o Nano Banana 2 e o [lançamento do Gemini Omni no Google I/O](https://diar.ia.br/p/google-lan-a-gemini-omni-no-google-i-o), em 21 de maio de 2026. O terceiro e último surto fechou num ritmo parecido com o primeiro: [Nano Banana 2 Lite](https://diar.ia.br/p/anthropic-lan-a-sonnet-5), 41 dias depois do Omni, e o [lançamento em trio de Gemini 3.6 e 3.5 Flash](https://diar.ia.br/p/google-lanca-trio-gemini-3-6-e-3-5-flash), mais 21 dias depois: 3 lançamentos em 62 dias.",
        ],
      },
      {
        heading: "Como o Gemini foi se espalhando pelos produtos do dia a dia e pelo Brasil?",
        paragraphs: [
          'O Gemini apareceu como novidade chegando ao Brasil em pelo menos 6 manchetes diferentes ao longo do período. A mais chamativa delas é uma repetição: [o Google AI Mode chegou ao Brasil](https://diar.ia.br/p/openai-anuncia-apoio-ao-longa-critterz-mirando-cannes) em 9 de setembro de 2025 e, 14 dias depois, ["o Modo IA do Google" chegou ao Brasil de novo](https://diar.ia.br/p/nvidia-anuncia-investimento-de-us-100-bi-na-openai), mesma função com nome diferente. Quinze dias depois veio [o Google AI Plus](https://diar.ia.br/p/google-lan-a-ai-para-controle-aut-nomo-de-browsers); já em 2026, 190 dias mais tarde, [a personalização do Gemini chegou ao Brasil](https://diar.ia.br/p/stanford-ia-avan-a-mais-r-pido-que-qualquer-tecnologia), seguida 61 dias depois por [um fundo de investimento em IA feito ao lado da Monashees](https://diar.ia.br/p/sp-vai-mapear-surtos-de-dengue-por-bairro) e, mais 6 dias depois, [o Google AI Plus de graça para clientes da Vivo](https://diar.ia.br/p/google-ai-plus-de-gra-a-na-vivo).',
          'Fora do Brasil especificamente, a integração cresceu em quase todo produto do ecossistema Google: [o Gemini embarcou no Chrome](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-798f898c74970), [o Google Maps ganhou a API do Gemini](https://diar.ia.br/p/aws-sofre-queda) e, um dia depois de [a Apple trazer o Gemini para dentro da Siri e do próprio Google Maps](https://diar.ia.br/p/siri-agora-tera-gemini), [o Workspace ganhou mais capacidades](https://diar.ia.br/p/microsoft-em-busca-da-superinteligencia). Já em 2026, veio a vez do [Gmail](https://diar.ia.br/p/grok-sendo-investigado-internacionalmente) e, 3 dias depois, de uma cobertura sobre [o Gemini "entendendo toda a vida digital" do usuário](https://diar.ia.br/p/mckinsey-candidatos-devem-dominar-prompts). Mais recentemente, [o Gemini voltou ao Chrome, agora sem precisar abrir aba nova](https://diar.ia.br/p/gemini-chega-ao-chrome-sem-abrir-aba-nova), [ganhou cadernos de estudo](https://diar.ia.br/p/sabia-4-thinking-brasil-tem-modelo-de-raciocinio) 16 dias depois, viu o [NotebookLM ser rebatizado de Gemini Notebook](https://diar.ia.br/p/gpt-5-6-sol-apaga-arquivos-sem-permissao) 21 dias mais tarde, e fechou o período [editando o Google Docs por conta própria](https://diar.ia.br/p/repositorio-de-ia-sem-freio-para-nudes-ilegais), 13 dias depois disso.',
          "Um fio à parte, mas revelador, é o avanço da autonomia do próprio Gemini: em outubro de 2025, [o Google lançou uma IA para controle autônomo de navegadores](https://diar.ia.br/p/google-lan-a-ai-para-controle-aut-nomo-de-browsers); 260 dias depois, [o Gemini 3.5 Flash passou a controlar o computador inteiro do usuário](https://diar.ia.br/p/gemini-3-5-flash-agora-controla-seu-computador), não só o navegador.",
        ],
      },
      {
        heading: "Que aposta em educação o Google fez em IA no Brasil?",
        paragraphs: [
          'O compromisso do Google com formação em IA no Brasil aparece primeiro como discurso, não produto: [o CEO do Google DeepMind definiu "aprender contínuo" como habilidade essencial](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-3c7f661e00f75) em 15 de setembro de 2025. No dia seguinte veio o produto: [treinamento de IA em cinemas do Brasil](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-d28fd72dae9b7).',
          "Depois vieram, em sequência, [o Google Skills, uma plataforma com cursos de IA gratuitos](https://diar.ia.br/p/google-skills-plataforma-com-cursos-de-ia-gratuitos), 37 dias depois; [um curso gratuito aos sábados](https://diar.ia.br/p/google-da-curso-gratuito-de-ia-no-sabado), 40 dias mais tarde; e [mais um curso novo de IA](https://diar.ia.br/p/novo-curso-de-ia-do-google), 80 dias depois disso: 4 iniciativas de formação espalhadas ao longo de 5 meses.",
          "O arco fecha 146 dias depois do último curso, e de um jeito quase irônico: [o Google passou a liberar o uso de IA dentro das próprias entrevistas técnicas de emprego](https://diar.ia.br/p/ibm-admite-atraso-em-ia-e-acao-despenca-25). O candidato que aprendeu com os cursos gratuitos do Google agora pode usar essa mesma IA para tentar entrar na empresa.",
        ],
      },
      {
        heading: "O Gemini já alcançou o ChatGPT?",
        paragraphs: [
          'A narrativa sobre a disputa entre Google e OpenAI muda de sinal ao longo do período. Começa com [a OpenAI sentindo ameaça pelos próprios resultados do Google](https://diar.ia.br/p/pesquisa-aponta-que-ia-pode-agir-de-forma-maliciosa-ao-aprender-a-trapacear), em 24 de novembro de 2025. Trinta e dois dias depois veio a pergunta direta, ["O Gemini venceu o ChatGPT?"](https://diar.ia.br/p/o-gemini-venceu-o-chatgpt) — no mesmo dia em que ChatGPT, Gemini e Perplexity foram comparados lado a lado. Catorze dias depois veio a virada explícita no título: ["Como o Gemini virou o jogo contra o ChatGPT"](https://diar.ia.br/p/va-o-surgir-novos-cios-no-governo).',
          'Trinta e um dias depois veio [o Gemini se aproximando do ChatGPT em número de usuários](https://diar.ia.br/p/ai-com-lanc-a-agentes-de-ia-auto-nomos). Vinte e nove dias mais tarde veio um sinal indireto de que a disputa também mudava do lado de dentro de uma concorrente: [a própria Microsoft lançou o Copilot ao lado do Gemini no mesmo dia](https://diar.ia.br/p/copilot-e-gemini-chegam-juntos-coincid-ncia), sob o título irônico "coincidência?". Vinte e sete dias depois disso, a cobertura ampliou o adversário: não era mais só o ChatGPT, era ["a aposta do Google contra Meta e DeepSeek"](https://diar.ia.br/p/ir-mira-o-maior-datacenter-de-ia-do-mundo) também.',
          "Nem toda comparação correu a favor do Google nesse arco: 3 dias antes da manchete sobre a virada contra o ChatGPT, [o Claude Code, da Anthropic, superou a própria equipe de engenheiros do Google](https://diar.ia.br/p/inscric-o-es-abertas-programa-da-openai-para-empreendedores) numa tarefa, em 6 de janeiro de 2026. A rivalidade que a cobertura descreve não é de mão única.",
        ],
      },
      {
        heading: "Que aplicações reais o Gemini já teve, da ciência ao SUS?",
        paragraphs: [
          'As aplicações práticas do Gemini formam uma escalada, da abstração à vida real. Começa em fevereiro de 2026, com [o Gemini 3 resolvendo um problema descrito como "insolúvel" na ciência](https://diar.ia.br/p/fim-do-colarinho-branco-microsoft-prev-automa-o-total-em-18-meses). Trinta e oito dias depois veio a escala: [o Gemini Robotics chegou a 20 mil robôs](https://diar.ia.br/p/altman-admite-a-ia-trar-amea-as).',
          "Depois, 84 dias mais tarde, veio a medicina: [um sistema do Google igualou médicos em teste clínico](https://diar.ia.br/p/sistema-do-google-iguala-m-dicos-em-teste). Vinte e seis dias depois, a aplicação deixou de ser teste e virou uso real dentro do sistema público de saúde brasileiro: [a IA do Google passou a detectar um tipo raro de câncer dentro do SUS](https://diar.ia.br/p/ia-do-google-detecta-c-ncer-raro-no-sus), o ponto mais concreto de toda a cobertura sobre usos aplicados do Gemini no período.",
        ],
      },
      {
        heading: "Como o tamanho do Google virou motivo de investimento bilionário e de alarme regulatório?",
        paragraphs: [
          "O dinheiro em torno do Google e do Gemini apareceu em pelo menos 4 manchetes de escala bilionária ou nacional. Primeiro, [Google, Nvidia e Jeff Bezos investiram juntos na Humans&](https://diar.ia.br/p/google-nvidia-e-bezos-investem-na-humans), em 2 de fevereiro de 2026. Dezessete dias depois, [o Google anunciou US$ 15 bilhões em infraestrutura](https://diar.ia.br/p/lula-na-maior-cupula-global-de-ia-bde9c122905d2d79). Sessenta e três dias mais tarde veio o hardware: [o Google Cloud lançou sua 8ª geração de TPUs](https://diar.ia.br/p/fgv-30-milho-es-de-brasileiros-em-risco), os chips próprios da empresa para treinar IA. Cinquenta e quatro dias depois disso, o investimento chegou ao Brasil, com [o fundo de IA feito ao lado da Monashees](https://diar.ia.br/p/sp-vai-mapear-surtos-de-dengue-por-bairro).",
          "O fim do período concentra a reação ao tamanho que o Google já tinha alcançado: em 9 dias de julho de 2026 vieram [a União Europeia obrigando o Google a abrir dados para rivais](https://diar.ia.br/p/ue-obriga-google-a-abrir-dados-para-rivais), 4 dias depois [editoras e a própria Reddit cogitando banir o Google](https://diar.ia.br/p/reddit-e-jornais-cogitam-banir-o-google) de seus conteúdos, e mais 5 dias depois [um estudo mostrando que a IA do Google já domina 43% das buscas feitas nos EUA](https://diar.ia.br/p/1-134-funcion-rios-da-ia-pedem-freio-ao-setor), a manchete que, lida ao lado das duas anteriores, explica por que o alarme regulatório veio junto.",
        ],
      },
    ],
    faq: buildGoogleGeminiFaq(SOURCES),
    sourceEditions: toSourceEditions(SOURCES),
    publishedDate: PUBLISHED_DATE,
    updatedDate: UPDATED_DATE,
    footerNavUtm: HUB_GOOGLE_GEMINI_FOOTER_NAV_UTM,
  };
}
