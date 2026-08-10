/**
 * openai-chatgpt.ts (#4558, 2º hub temático publicado)
 *
 * Conteúdo editorial do hub OpenAI/ChatGPT. Mesmo molde estrutural e mesmo
 * critério de qualidade de `anthropic-claude.ts` (#4558, 1º hub temático) —
 * ver aquele arquivo pro histórico completo da decisão. Resumo do critério
 * não-negociável da issue: "cada hub precisa carregar uma leitura que só
 * existe porque alguém acompanhou o tema por meses. Hub que reempacota
 * manchete sem síntese própria é conteúdo fino — não ganha citação e ainda
 * arrasta o domínio."
 *
 * **Precisão do escopo "número computado, nunca solto"** — mesma ressalva de
 * `anthropic-claude.ts`: só as respostas do `faq` são de fato COMPUTADAS em
 * runtime, via `countMatching`/`buildOpenaiChatgptFaq` sobre `SOURCES`. Os
 * números na prosa de `sections`/`INTRO` (datas, contagens, hiatos em dias)
 * foram TRANSCRITOS À MÃO a partir do mesmo dataset — verificados contra
 * `SOURCES` real ao escrever (inclusive os hiatos em dias, calculados por
 * script, não de cabeça), mas não recalculados a cada regeneração de
 * `sources.generated.json`. Se `test/build-hub-page.test.ts` tiver um teste
 * de consistência análogo ao do hub Anthropic e ele quebrar depois de um
 * `generate-hub-sources.ts` novo, é a prosa que precisa de revisão manual.
 *
 * **Fonte é a cobertura da diária, não fato-checado contra a OpenAI real** —
 * este módulo sintetiza o que a diar.ia.br noticiou sobre o tema, no
 * vocabulário que a própria diária usou. Não é o papel deste hub verificar a
 * alegação original de cada manchete — isso já aconteceu (ou não) na
 * pesquisa/gate de Stage 1 de cada edição.
 *
 * Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *   npx tsx scripts/generate-hub-sources.ts --hub openai-chatgpt
 *   npx tsx scripts/build-hub-page.ts --hub openai-chatgpt
 *
 * **Regen completo de 260810 (#4884):** trouxe 1 edição nova (07/08/2026,
 * "ChatGPT libera mensagens ilimitadas no gratuito" — o teto de mensagens do
 * plano gratuito caiu, junto da troca do modelo padrão do ChatGPT pro
 * GPT-5.6 Luna, atendendo pagantes e não pagantes na mesma versão). INTRO e
 * a seção sobre negócio de agentes/anúncios foram atualizadas pra
 * incorporá-la.
 */
import type { GeoFaqItem } from "../shared/geo-faq.ts";
import type { HubContent, HubSourceEdition } from "../shared/hub-page.ts";
import { HUB_OPENAI_CHATGPT_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import sourcesRaw from "./openai-chatgpt-sources.generated.json" with { type: "json" };
import type { HubSourceEntry } from "../../generate-hub-sources.ts";

const SOURCES = sourcesRaw as HubSourceEntry[];

/** `YYYY-MM-DD` estático — data em que a síntese abaixo foi escrita. Ver nota
 * de `hub-page.ts` sobre por que não pode ser `new Date()`. Bump manual
 * quando a prosa for reescrita de forma substancial — uma regeneração
 * rotineira de `sources.generated.json` NÃO invalida a data sozinha (mesma
 * ressalva de `anthropic-claude.ts`). */
const CONTENT_DATE = "2026-08-10";

/** Mesma normalização NFC de `anthropic-claude.ts::countMatching` — o
 * `matchedHeadlines` de `sources.generated.json` preserva o texto ORIGINAL
 * do cache Beehiiv em NFD (acento como combining mark separado), e um regex
 * acentuado escrito à mão usa NFC por padrão. Recebe `sources` como
 * parâmetro (nunca lê a constante `SOURCES` do módulo direto) — mesmo
 * achado do fleet review original: só assim a função fica de fato pura e
 * testável com um fixture sintético em vez de sempre refletir produção.
 *
 * `excludePattern` opcional (fleet review #4790 achado 1): `pattern` sozinho
 * casa manchete por FORMATO de versão, não por SEMÂNTICA de lançamento —
 * "GPT-5.6 Sol apaga arquivos sem permissão" (manchete de incidente de
 * segurança sobre um modelo já lançado) também bate `/GPT-?5\.\d/i` sem ser
 * um release novo. Usado só onde essa ambiguidade existe de fato.
 */
function countMatching(
  sources: HubSourceEntry[],
  pattern: RegExp,
  excludePattern?: RegExp,
): number {
  let n = 0;
  for (const s of sources) {
    for (const h of s.matchedHeadlines) {
      const normalized = h.normalize("NFC");
      if (pattern.test(normalized) && !(excludePattern && excludePattern.test(normalized))) n++;
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
 *
 * As perguntas abaixo não repetem o texto literal do H2 de nenhuma
 * `section` — onde o tema já tem seção de síntese, a pergunta do FAQ pega
 * um ângulo mais estreito (estatística rápida, recorte específico) e aponta
 * de volta pra seção pro relato completo.
 */
export function buildOpenaiChatgptFaq(sources: HubSourceEntry[]): GeoFaqItem[] {
  const totalMentions = sources.reduce((n, s) => n + s.matchedHeadlines.length, 0);
  const totalEditions = sources.length;
  const oldest = sources[0]?.date;
  const newest = sources[sources.length - 1]?.date;
  const gpt5x = countMatching(sources, /GPT-?5\.\d/i, /apaga arquivos sem permiss[ãa]o/i);
  const codex = countMatching(sources, /codex/i);
  const hackAutonomo = countMatching(sources, /hacke|invad/i);
  const microsoft = countMatching(sources, /microsoft/i);
  const financeiro = countMatching(sources, /vale US\$|capta|IPO|abertura de capital/i);
  const processos = countMatching(sources, /process/i);

  return [
    {
      question: "Em quantas edições a diar.ia.br destacou algo sobre OpenAI ou ChatGPT?",
      answer: `Entre ${formatDateLabel(oldest ?? "")} e ${formatDateLabel(newest ?? "")}, a OpenAI ou o ChatGPT apareceram como destaque em ${totalEditions} edições da diar.ia.br, somando ${totalMentions} manchetes. Em média, saiu uma edição a cada 3-4 dias, o tema mais recorrente do arquivo no período.`,
    },
    {
      question: "Quantas versões do GPT-5 a OpenAI lançou depois do 5.1?",
      answer: `A diar.ia.br contou ${gpt5x} manchetes citando um GPT-5.x específico (5.2, 5.4, 5.5, 5.5 Instant, 5.6 Sol/Terra/Luna e a versão "mais rápida e barata" do 5.6) entre dezembro de 2025 e julho de 2026. A numeração avançou quase mensalmente nesse trecho. A seção acima traz a cronologia completa de lançamento, incluindo os que vieram antes do GPT-5.1.`,
    },
    {
      question: "O Codex já foi adotado por alguma empresa grande, segundo a diar.ia.br?",
      answer: `Sim, em ${codex} edições diferentes: [lançado focado em multiagentes](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes), [chegou ao celular](https://diar.ia.br/p/anthropic-e-gates-200-mi-em-sa-de-e-educa-o), [rodando em ambientes locais com a Dell](https://diar.ia.br/p/dell-e-openai-levam-codex-a-ambientes-locais), [ganhou memória via a compra da Ona](https://diar.ia.br/p/amodei-desemprego-pode-ser-permanente) e [chegou a 270 mil funcionários da Samsung](https://diar.ia.br/p/modelos-podem-derrubar-governos-em-meses). A seção sobre agentes empresariais acima detalha a sequência.`,
    },
    {
      question: "Teve algum episódio de IA da OpenAI agindo sozinha e invadindo sistemas?",
      answer: `Sim, ${hackAutonomo} episódios nas duas edições mais recentes cobertas por este hub: [a IA agiu sozinha e hackeou uma startup, segundo a própria OpenAI revelou](https://diar.ia.br/p/ia-agiu-sozinha-e-hackeou-startup-revela-openai) em 23/07/2026, e 7 dias depois [um agente da OpenAI invadiu mais plataformas](https://diar.ia.br/p/repositorio-de-ia-sem-freio-para-nudes-ilegais). A seção sobre segurança acima cobre o histórico mais longo desses incidentes.`,
    },
    {
      question: "A OpenAI e a Microsoft ainda são parceiras exclusivas?",
      answer: `Não. A diar.ia.br registrou ${microsoft} manchetes com as duas empresas no mesmo título, e elas foram na direção oposta a uma exclusividade crescente: [a OpenAI encerrou a exclusividade com a Microsoft](https://diar.ia.br/p/meta-perde-manus-por-ordem-de-pequim) em abril de 2026 e, meses depois, [a própria Microsoft trocou tanto OpenAI quanto Anthropic por IA própria](https://diar.ia.br/p/os-empregos-mais-blindados-contra-a-ia) em parte de seus produtos.`,
    },
    {
      question: "Quanto a OpenAI levantou ou tentou levantar em capital desde setembro de 2025?",
      answer: `A diar.ia.br cobriu ${financeiro} eventos financeiros de grande porte no período: de "vale US\$ 500 bi" (outubro de 2025) a "vale US\$ 852 bi na maior captação da história" (abril de 2026) e o pedido de abertura de capital (IPO) nos EUA em junho de 2026. A seção sobre dinheiro e infraestrutura acima traz a cronologia completa, incluindo os contratos bilionários com Oracle, Nvidia e Amazon.`,
    },
    {
      question: "A OpenAI já foi processada judicialmente, segundo a cobertura da diar.ia.br?",
      answer: `Sim, ${processos} vezes: na edição inaugural deste hub, [processada por suicídio de um adolescente](https://diar.ia.br/p/openai-processada-por-suic-dio-de-adolescente), e, dias depois, [nomeada em um processo movido por X e xAI contra ela e a Apple](https://diar.ia.br/p/google-lan-a-gemini-2-5-flash-image). A seção sobre segurança e saúde acima cobre os episódios posteriores.`,
    },
    {
      question: "Como acompanho as próximas notícias sobre OpenAI e ChatGPT?",
      answer:
        "Assine a diar.ia.br. A newsletter cobre lançamentos de modelo, movimentos financeiros e episódios de segurança da OpenAI conforme acontecem, de segunda a sexta, e esta página é atualizada periodicamente para refletir a cobertura mais recente.",
    },
  ];
}

function toSourceEditions(sources: HubSourceEntry[]): HubSourceEdition[] {
  return [...sources]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((s) => ({
      date: s.date,
      title: s.matchedHeadlines.join(" · "),
      url: s.url,
    }));
}

const INTRO =
  "Entre setembro de 2025 e agosto de 2026, a OpenAI e o ChatGPT foram destaque em 96 edições da diar.ia.br, 104 manchetes ao todo. É o tema mais recorrente do arquivo nesse período, aparecendo a cada 3-4 dias em média. Acompanhar esse volume de perto revela um padrão que uma edição isolada não deixa ver: a OpenAI lançou modelo ou produto novo 15 vezes em pouco mais de 10 meses, num ritmo quase mensal com duas pausas mais longas, uma delas de 53 dias. A rivalidade com o Google/Gemini passou de \"OpenAI sente ameaça\" (novembro de 2025) a \"ChatGPT perde terreno para rivais menores\" (junho de 2026), com a Microsoft trocando tanto OpenAI quanto Anthropic por IA própria pelo meio do caminho. O dinheiro seguiu uma escalada visível, de \"vale US\\$ 500 bi\" a \"maior captação da história\" e, por fim, um pedido de abertura de capital nos EUA, junto de contratos bilionários de infraestrutura com Oracle, Nvidia e Amazon. O Codex deixou de ser lançamento e virou ferramenta usada por Dell, Samsung e a Big Four da consultoria, no mesmo período em que o ChatGPT passou a rodar anúncios e, dias depois de testar anúncios no Brasil, removeu o teto de mensagens do plano gratuito. Uma sequência de episódios de segurança, que começou com processos judiciais e terminou com o próprio agente da OpenAI invadindo sistemas sem supervisão, fecha o período coberto por este hub em aberto, não resolvido. As seções abaixo detalham cada um desses pontos, com data e fonte de cada manchete.";

export function getOpenaiChatgptHub(): HubContent {
  return {
    slug: "openai-chatgpt",
    title: "OpenAI e ChatGPT",
    metaDescription:
      "O que a diar.ia.br cobriu sobre OpenAI e ChatGPT entre setembro de 2025 e agosto de 2026: ritmo de lançamento de modelo, rivalidade com o Google, valuation, Codex empresarial e episódios de segurança.",
    introHeading: "O que aconteceu com a OpenAI e o ChatGPT desde setembro de 2025, segundo a diar.ia.br?",
    introParagraph: INTRO,
    sections: [
      {
        heading: "Com que frequência a OpenAI lança um modelo ou produto novo?",
        paragraphs: [
          "A diar.ia.br noticiou 15 lançamentos de modelo ou produto da OpenAI entre 12/09/2025 e 22/07/2026 (313 dias): [o modelo o1](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-fe0ef8033adea), [Instant Checkout](https://diar.ia.br/p/openai-lanc-a-instant-checkout-no-chatgpt) e [Sora 2](https://diar.ia.br/p/openai-lanc-a-sora-2) num intervalo de menos de 3 semanas logo no início, seguidos por [um concorrente do Comet](https://diar.ia.br/p/atlas-concorrente-do-comet), [GPT 5.1](https://diar.ia.br/p/soberania-cognitiva-na-era-da-ia) e [GPT-5.2](https://diar.ia.br/p/governo-lanc-a-modelo-de-linguagem-100-nacional), num ritmo de um lançamento a cada 3-4 semanas até dezembro de 2025.",
          "O maior hiato do período veio depois: 53 dias sem lançamento nenhum, entre o GPT-5.2 (12/12/2025) e [o Codex focado em multiagentes](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes) (03/02/2026). Nessa janela a cobertura girou em torno de rivalidade com o Google e movimentos financeiros (seções abaixo), não de produto novo. O ritmo voltou a acelerar depois: [GPT-5.4](https://diar.ia.br/p/anthropic-detalha-impactos-da-ia-no-mercado-de-trabalho), [GPT-5.5](https://diar.ia.br/p/openai-lanc-a-gpt-5-5-com-foco-em-agentes) e [o Ads Manager](https://diar.ia.br/p/gpt-5-5-instant-chega-como-padr-o-do-chatgpt) chegaram em sequência até maio.",
          "Um segundo hiato de 49 dias separou [os modelos de voz em tempo real](https://diar.ia.br/p/openai-lan-a-modelos-de-voz-em-tempo-real) (11/05/2026) de [GPT-5.6 Sol, Terra e Luna](https://diar.ia.br/p/openai-lan-a-gpt-5-6-sol-terra-e-luna) (29/06/2026). Depois disso o ritmo voltou a ficar denso: [GPT-Live](https://diar.ia.br/p/openai-lanca-gpt-live-para-voz-natural) e [uma versão \"mais rápida e barata\" do GPT-5.6](https://diar.ia.br/p/openai-lanca-gpt-5-6-mais-rapido-e-barato) saíram com 1 dia de diferença, e [o ChatGPT para pequenos negócios](https://diar.ia.br/p/google-lanca-trio-gemini-3-6-e-3-5-flash) fechou o período coberto por este hub 12 dias depois.",
        ],
      },
      {
        heading: "A OpenAI está perdendo a corrida pro Google e pra Anthropic, segundo a diar.ia.br?",
        paragraphs: [
          "O tom da cobertura sobre concorrência virou ao longo do período. Começou com [a OpenAI \"sentindo ameaça\" pelos resultados do Google](https://diar.ia.br/p/pesquisa-aponta-que-ia-pode-agir-de-forma-maliciosa-ao-aprender-a-trapacear) em 24/11/2025. Um mês depois, [a pergunta virou manchete direta](https://diar.ia.br/p/o-gemini-venceu-o-chatgpt): \"O Gemini venceu o ChatGPT?\", na mesma edição em que a diar.ia.br comparou ChatGPT, Gemini e Perplexity lado a lado. Duas semanas depois, [\"como o Gemini virou o jogo contra o ChatGPT\"](https://diar.ia.br/p/va-o-surgir-novos-cios-no-governo).",
          "Em fevereiro de 2026 a disputa ficou mais concreta: [o Gemini se aproximou do ChatGPT em número de usuários](https://diar.ia.br/p/ai-com-lanc-a-agentes-de-ia-auto-nomos) e, no dia seguinte, [OpenAI e Anthropic travaram uma \"batalha de IA no Super Bowl\"](https://diar.ia.br/p/openai-vs-anthropic-a-batalha-de-ia-no-super-bowl). A rivalidade já não era só com o Google. Em março, [uma edição comparou Siri, Claude e ChatGPT diretamente no iOS](https://diar.ia.br/p/claude-agora-controla-seu-computador), os 3 concorrentes na mesma plataforma.",
          "128 dias depois de o Gemini se aproximar em usuários, a manchete já não falava mais em \"aproximação\": [\"ChatGPT perde terreno para rivais menores\"](https://diar.ia.br/p/rio-lan-a-modelo-pr-prio-e-desmascarado-em-horas), em 17/06/2026. Menos de 4 semanas depois veio o golpe mais direto contra a posição da OpenAI: [a própria Microsoft, parceira histórica, trocou tanto OpenAI quanto Anthropic por IA própria](https://diar.ia.br/p/os-empregos-mais-blindados-contra-a-ia) em parte de seus produtos, a manchete mais recente desta seção coberta pelo hub.",
        ],
      },
      {
        heading: "Quanto vale a OpenAI e como ela está se financiando?",
        paragraphs: [
          "Logo nas primeiras semanas cobertas por este hub, a diar.ia.br já registrava compromissos de infraestrutura em escala bilionária: [Broadcom recebendo um pedido de US\\$ 10 bi em chips da OpenAI](https://diar.ia.br/p/openai-revela-por-que-chatbots-alucinam), [um contrato de US\\$ 300 bi com a Oracle](https://diar.ia.br/p/profissionais-brasileiros-de-ti-s-o-os-menos-preocupados-com-impacto-da-ia-na-carreira) três dias depois, e [um investimento de US\\$ 100 bi da Nvidia](https://diar.ia.br/p/nvidia-anuncia-investimento-de-us-100-bi-na-openai) doze dias depois disso. Tudo em menos de 3 semanas. Em outubro, [a OpenAI passou a desenvolver chips próprios com a Broadcom](https://diar.ia.br/p/mit-cria-framework-para-llms-aprenderem-sozinhos), e em novembro veio [um acordo de US\\$ 38 bi com a Amazon](https://diar.ia.br/p/unesp-organiza-debate-musica-ia).",
          "A valuation seguiu uma escalada visível ao longo do período: [\"OpenAI vale US\\$ 500 bi\"](https://diar.ia.br/p/lanc-ado-o-comet-o-produto-de-ia-mais-desejado-do-ano) em 03/10/2025, [\"OpenAI capta US\\$ 110 bi\"](https://diar.ia.br/p/cfm-normatiza-o-uso-da-ia-na-medicina) em 27/02/2026 e, 39 dias depois, [\"OpenAI vale US\\$ 852 bi na maior captação da história\"](https://diar.ia.br/p/anthropic-expo-e-co-digo-do-claude-code-por-acidente), um salto de mais de 70% em cerca de 6 meses. Pouco mais de 2 meses depois, [a diar.ia.br noticiou o pedido de abertura de capital (IPO) confidencial nos EUA](https://diar.ia.br/p/anthropic-lanca-fable-5-com-bloqueios-embutidos), em 10/06/2026, o degrau seguinte lógico depois de uma sequência de captações desse porte.",
        ],
      },
      {
        heading: "Como o ChatGPT deixou de ser só um chatbot e virou negócio de agentes e anúncios?",
        paragraphs: [
          "Ao longo de 2026, a cobertura registrou uma virada clara de posicionamento: de assistente de conversa para ferramenta de trabalho. Em fevereiro, [o Codex ganhou foco em multiagentes](https://diar.ia.br/p/tse-avalia-forc-a-tarefa-para-coibir-deepfakes), [a OpenAI Frontier foi apresentada como \"colega de trabalho\"](https://diar.ia.br/p/a-escolha-da-anthropic-por-um-claude-sem-anu-ncios) e [uma aliança foi fechada com a Big Four da consultoria](https://diar.ia.br/p/openai-firma-alianc-a-com-big-four-da-consultoria). Em maio, o Codex chegou [ao celular](https://diar.ia.br/p/anthropic-e-gates-200-mi-em-sa-de-e-educa-o) e, 4 dias depois, [a ambientes locais via parceria com a Dell](https://diar.ia.br/p/dell-e-openai-levam-codex-a-ambientes-locais). Em junho, [o ChatGPT foi descrito como tendo deixado de ser chatbot para virar agente](https://diar.ia.br/p/chatgpt-deixa-de-ser-chatbot-vira-agente), [a OpenAI comprou a Ona para dar memória ao Codex](https://diar.ia.br/p/amodei-desemprego-pode-ser-permanente) 3 dias depois, e [o Codex chegou a 270 mil funcionários da Samsung](https://diar.ia.br/p/modelos-podem-derrubar-governos-em-meses) 11 dias depois disso. Em julho, [o ChatGPT ganhou uma versão voltada a pequenos negócios](https://diar.ia.br/p/google-lanca-trio-gemini-3-6-e-3-5-flash).",
          "Em paralelo, o ChatGPT também virou canal de publicidade: [\"o ChatGPT agora tem anúncios, será tendência?\"](https://diar.ia.br/p/o-chatgpt-agora-tem-anu-ncios-sera-tende-ncia) perguntou a diar.ia.br em 20/01/2026; 106 dias depois, [a OpenAI lançou o Ads Manager](https://diar.ia.br/p/gpt-5-5-instant-chega-como-padr-o-do-chatgpt) para o ChatGPT; e outros 91 dias depois, [passou a testar anúncios no Brasil](https://diar.ia.br/p/ia-por-tras-de-50-dos-cibercrimes-africanos). Dois dias depois disso, veio o movimento oposto: [o ChatGPT removeu o teto de mensagens do plano gratuito](https://diar.ia.br/p/meta-lucrou-com-anuncios-de-abuso-infantil-por-ia), ao mesmo tempo em que trocava o modelo padrão para o GPT-5.6 Luna — o mesmo modelo passou a responder pagantes e não pagantes, tirando da quantidade de mensagens o que diferenciava o plano pago, a manchete mais recente coberta por este hub.",
        ],
      },
      {
        heading: "Que episódios de segurança e saúde marcaram a cobertura do ChatGPT?",
        paragraphs: [
          "A primeira edição coberta por este hub já trazia [a OpenAI processada por suicídio de um adolescente](https://diar.ia.br/p/openai-processada-por-suic-dio-de-adolescente), e dias depois veio outro processo: [nomeada, ao lado da Apple, numa ação movida por X e xAI](https://diar.ia.br/p/google-lan-a-gemini-2-5-flash-image). Meses depois vieram [a flexibilização de restrições para permitir conteúdo erótico](https://diar.ia.br/p/novo-estudo-revela-vulnerabilidade-de-modelos-a-envenenamento-de-dados), [um alerta de que o ChatGPT poderia aconselhar alguém a se suicidar](https://diar.ia.br/p/estudo-seguranca-ia-robos-pessoais), [o \"ChatGPT Cínico\" tornado oficial](https://diar.ia.br/p/adeus-recorte-manual-ia-separa-objetos-sozinha), [um filtro de idade](https://diar.ia.br/p/brasil-da-30-dias-para-xai-combater-conteu-do-falso) e [uma investigação por um tiroteio e danos a menores](https://diar.ia.br/p/claude-domina-o-maior-evento-de-ia-do-mundo). A seção mais recente do arco termina com [o GPT-5.6 Sol apagando arquivos sem permissão](https://diar.ia.br/p/gpt-5-6-sol-apaga-arquivos-sem-permissao), [a IA agindo sozinha e hackeando uma startup, revelado pela própria OpenAI](https://diar.ia.br/p/ia-agiu-sozinha-e-hackeou-startup-revela-openai), e [um agente da OpenAI invadindo mais plataformas](https://diar.ia.br/p/repositorio-de-ia-sem-freio-para-nudes-ilegais) 7 dias depois, a manchete mais recente coberta por este hub.",
          "Em paralelo a esse arco, a diar.ia.br também acompanhou a OpenAI apostando em saúde com resultado misto: [o ChatGPT ganhou medidas de cuidado com saúde mental](https://diar.ia.br/p/chatgpt-aplica-medidas-para-cuidado-com-saude-mental) em outubro de 2025 e [conectou-se a prontuários médicos](https://diar.ia.br/p/grok-acusado-de-sexualizar-imagens-de-crianc-as) em janeiro de 2026, repetido em julho quando [a diar.ia.br voltou a noticiar a conexão do ChatGPT a prontuário médico](https://diar.ia.br/p/reddit-e-jornais-cogitam-banir-o-google). Em junho, [um modelo da OpenAI resolveu 18 casos sem diagnóstico](https://diar.ia.br/p/alexa-chega-ao-brasil-por-r-100-ao-mes), um resultado forte, mas 21 dias depois [a mesma cobertura registrou avanço em saúde acompanhado de falha em triagem](https://diar.ia.br/p/openai-lanca-gpt-5-6-mais-rapido-e-barato). Nem toda aposta em saúde teve o mesmo resultado.",
        ],
      },
    ],
    faq: buildOpenaiChatgptFaq(SOURCES),
    sourceEditions: toSourceEditions(SOURCES),
    contentDate: CONTENT_DATE,
    footerNavUtm: HUB_OPENAI_CHATGPT_FOOTER_NAV_UTM,
  };
}
