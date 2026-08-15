/**
 * deepseek.ts (#5125 item 4 — desbloqueio da candidata mais fraca do
 * levantamento anterior, `docs/entity-page-candidates.md`)
 *
 * A rodada anterior (#5292/apple.ts) tinha verificado DeepSeek no piso
 * exato de `MIN_ENTITY_MENTIONS` (5), com 2 das 5 menções cobrindo o MESMO
 * desenvolvimento — "DeepSeek desenvolve chip próprio" via Reuters
 * (2026-07-08) e CNN (2026-07-09) em dias consecutivos — e registrou:
 * "seria a próxima com +1 pesquisa (achar mais 1-2 menções em edições fora
 * da janela já auditada, ou aceitar a redundância) esclareceria se vale a
 * pena". Esta unidade fez essa pesquisa: releu `content.free.web` (corpo
 * completo, não só título+subtítulo) de TODAS as ~251 edições confirmadas
 * do corpus (`data/beehiiv-cache/posts/*.json`, auditado 15/08/2026) por
 * "deepseek" — a auditoria anterior só regexava título+subtítulo, o que
 * pode perder menções em que DeepSeek é um destaque secundário (D2/D3) cuja
 * manchete não aparece no título/subtítulo do POST inteiro, só no `<h1>` da
 * seção dentro do corpo.
 *
 * **Achado da pesquisa adicional:** 1 menção nova e distinta — 2026-06-18,
 * "Microsoft avalia trocar IA estadunidense por chinesa" (Copilot Cowork →
 * DeepSeek V4) — não capturada pela auditoria anterior porque a manchete
 * do destaque não usa a palavra "DeepSeek" na forma que o regex de
 * título+subtítulo testava sozinho (a menção está no SUBTÍTULO do post,
 * mas o regex da rodada anterior parou de escanear assim que bateu o piso
 * nas outras candidatas do lote). Esta menção NÃO é redundante com a
 * dupla Reuters/CNN sobre chip próprio: é sobre um CLIENTE corporativo
 * americano cogitando adotar o modelo, não sobre a estratégia de hardware
 * da própria DeepSeek.
 *
 * **Decisão editorial sobre a dupla redundante:** mantida apenas a versão
 * mais completa (CNN, 2026-07-09 — inclui o dado de market-share da
 * Huawei no mercado doméstico chinês de chips, ausente na versão Reuters
 * de 07-08); a edição de 07-08 foi excluída de `mentions` e registrada em
 * `ENTITY_EXCLUDED_EDITIONS.deepseek` (`scripts/lib/entities/patterns.ts`)
 * pelo mesmo motivo já documentado no achado original — 2 fontes
 * diferentes noticiando o MESMO fato do lado da DeepSeek, sem
 * desenvolvimento distinto entre uma e outra.
 *
 * **Resultado: 5 menções, TODAS distintas** (nenhuma redundância) — melhor
 * que o estado anterior (5 menções, 2 delas cobrindo o mesmo fato). O arco
 * resultante tem progressão genuína: guerra de preço (corte de 75% na
 * API) → avanço técnico com independência de hardware ocidental (modelo
 * treinado com chips da Huawei) → validação de mercado (cliente
 * corporativo americano cogitando adotar) → resposta geopolítica (chip
 * próprio pra reduzir dependência das sanções dos EUA) → efeito colateral
 * de segurança (o mesmo modelo usado por um hacker chinês em ataques
 * autônomos). Não colide com `HUB_KEYWORD_PATTERNS`
 * (`scripts/generate-hub-sources.ts`) nem com nenhuma outra entidade já
 * publicada.
 *
 * Cada `summary` foi escrito depois de ler `content.free.web` da edição
 * correspondente — nunca reformulação da manchete (mesma disciplina de
 * `perplexity.ts`/`apple.ts`, ver docstring de `entity-page.ts` seção
 * "Critério anti-thin-content"). Datas ESTÁTICAS — mesma disciplina das
 * demais entidades.
 */
import type { EntityContent } from "../shared/entity-page.ts";
import { ENTITY_DEEPSEEK_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import { formatMonthYear } from "../shared/geo-faq.ts";

const MENTIONS: EntityContent["mentions"] = [
  {
    date: "2026-05-05",
    headline: "V4 da DeepSeek muda o jogo dos chips chineses",
    editionUrl: "https://diar.ia.br/p/falha-na-lovable-atinge-spotify-uber-e-outros",
    editionTitle: "Falha na Lovable atinge Spotify, Uber e outros",
    summary:
      "Uma nova versão da DeepSeek superou as anteriores em benchmarks de raciocínio e código, mas a notícia geopolítica foi outra: o modelo foi treinado com chips da Huawei, não com GPUs da Nvidia — o sinal mais forte até então de que a China consegue avançar em IA sem depender de hardware americano, pressionando ainda mais os preços das APIs ocidentais.",
  },
  {
    date: "2026-05-25",
    headline: "DeepSeek corta 75% do preço da API",
    editionUrl: "https://diar.ia.br/p/deepseek-corta-75-do-pre-o-da-api",
    editionTitle: "DeepSeek corta 75% do preço da API",
    summary:
      "A DeepSeek cortou em 75% as tarifas de acesso à sua API — o maior corte de preço da linha de uma vez só — pressionando OpenAI, Anthropic e Google a revisarem suas próprias tabelas, num mercado em que o custo por token de modelos de fronteira já havia caído mais de 40% desde o início de 2026.",
  },
  {
    date: "2026-06-18",
    headline: "Microsoft avalia trocar IA estadunidense por chinesa",
    editionUrl: "https://diar.ia.br/p/sistema-do-google-iguala-m-dicos-em-teste",
    editionTitle: "Sistema do Google iguala médicos em teste",
    summary:
      "A Microsoft passou a avaliar trocar os modelos americanos que usa no Copilot Cowork pelo DeepSeek V4, rodando em servidores próprios — um movimento que contraria a pressão do governo dos EUA para que empresas americanas evitem tecnologia chinesa, motivado pelo desempenho competitivo do modelo a um custo bem menor que o dos líderes ocidentais.",
  },
  {
    date: "2026-07-09",
    headline: "Chip próprio: DeepSeek reduz dependência dos EUA",
    editionUrl: "https://diar.ia.br/p/openai-lanca-gpt-live-para-voz-natural",
    editionTitle: "OpenAI lança GPT-Live para voz natural",
    summary:
      "A DeepSeek estaria desenvolvendo o próprio chip de processamento para treinar e rodar seus modelos, segundo apuração da CNN — mais um passo da China rumo à independência em hardware de ponta, na esteira das restrições americanas à exportação de GPUs avançadas que hoje a obrigam a depender da Nvidia e de fornecedoras locais como a Huawei.",
  },
  {
    date: "2026-08-04",
    headline: "Hacker chinês usa DeepSeek em ataques autônomos",
    editionUrl: "https://diar.ia.br/p/hacker-chines-usa-deepseek-em-ataques-autonomos",
    editionTitle: "Hacker chinês usa DeepSeek em ataques autônomos",
    summary:
      "Um agente de ameaça chinês usou o modelo DeepSeek acoplado à ferramenta Hermes Agent para atacar servidores expostos na internet com pouca intervenção humana, segundo a Unit 42 da Palo Alto Networks — buscando alvos e disparando tentativas de exploração sozinho, ainda que nenhum dos ataques autônomos tenha tido sucesso desta vez.",
  },
];

/** Nota de metodologia DERIVADA de `MENTIONS` — mesma disciplina de
 * `buildMethodologyNote` em `perplexity.ts`/`samsung.ts`/`apple.ts` (cópia
 * local pequena, não importada — ver nota de fronteira em
 * `entity-page.ts`). */
function buildMethodologyNote(mentions: EntityContent["mentions"]): string {
  const since = formatMonthYear(mentions[0].date);
  const until = formatMonthYear(mentions[mentions.length - 1].date);
  const between = since === until ? since : `${since} e ${until}`;
  return `O levantamento vem de ${mentions.length} edições publicadas entre ${between}; os números saem do arquivo da diar.ia.br, não de verificação independente junto à DeepSeek.`;
}

export function getDeepseekEntity(): EntityContent {
  return {
    slug: "deepseek",
    name: "DeepSeek",
    metaDescription:
      "Linha do tempo da DeepSeek na cobertura da diar.ia.br: do corte de 75% no preço da API ao chip próprio, passando pelo interesse da Microsoft.",
    introHeading: "Como a DeepSeek forçou o resto do mercado de IA a reagir?",
    introParagraph:
      "A DeepSeek apareceu na cobertura da diar.ia.br como a laboratório chinesa que mais vezes forçou concorrentes ocidentais a reagir: um corte de 75% no preço da própria API que pressionou OpenAI, Anthropic e Google a revisarem tabelas, um modelo novo treinado com chips da Huawei em vez de GPUs da Nvidia — sinal de que a China consegue avançar em IA mesmo sob sanção de hardware —, e um chip de processamento próprio em desenvolvimento para reduzir ainda mais essa dependência. O efeito passou dos concorrentes para os clientes: a Microsoft chegou a avaliar trocar os modelos americanos do Copilot Cowork pelo DeepSeek V4 por causa do custo. A mesma acessibilidade teve um lado sombrio: um hacker chinês usou o modelo, acoplado a uma ferramenta de automação, para tentar ataques autônomos contra servidores expostos na internet. Esta página reúne, em ordem cronológica, cada vez que a DeepSeek apareceu nas edições da diária.",
    mentions: MENTIONS,
    faq: [
      {
        question: "Quantas vezes a DeepSeek apareceu na diar.ia.br?",
        answer: `${MENTIONS.length} vezes, entre ${formatMonthYear(MENTIONS[0].date)} e ${formatMonthYear(MENTIONS[MENTIONS.length - 1].date)} — do corte de 75% no preço da API ao uso do modelo por um hacker chinês em ataques autônomos.`,
      },
      {
        question: "A DeepSeek tem um hub temático dedicado na diar.ia.br?",
        answer:
          "Não. Os hubs temáticos (arquivo.diar.ia.br/temas) cobrem só empresas/temas com dezenas de manchetes acumuladas — Anthropic/Claude, OpenAI/ChatGPT, Google/Gemini e Meta, além de 2 temas transversais. A DeepSeek tem cobertura relevante mas ainda de cauda longa; esta página de entidade é o formato adequado a esse volume.",
      },
      {
        question: "Por que a DeepSeek cortou o preço da própria API?",
        answer:
          "Em maio de 2026 a DeepSeek cortou em 75% as tarifas de acesso à sua API, o maior corte de preço da linha até então — parte de uma compressão maior no mercado, em que o custo por token de modelos de fronteira já havia caído mais de 40% desde o início do ano, pressionando OpenAI, Anthropic e Google a revisarem suas próprias tabelas.",
      },
      {
        question: "A DeepSeek está desenvolvendo um chip próprio?",
        answer:
          "Segundo apuração da CNN (julho de 2026), sim — a empresa estaria desenvolvendo um processador próprio para treinar e rodar seus modelos, reduzindo a exposição às restrições americanas de exportação de GPUs avançadas que hoje a obrigam a depender da Nvidia e de fornecedoras locais como a Huawei.",
      },
      {
        question: "Um hacker já usou a DeepSeek para atacar sistemas?",
        answer:
          "Sim. Em agosto de 2026, a Unit 42 (Palo Alto Networks) identificou um agente de ameaça chinês usando o modelo DeepSeek, acoplado à ferramenta Hermes Agent, para buscar alvos e disparar tentativas de ataque contra servidores expostos na internet com pouca intervenção humana — nenhuma das tentativas autônomas teve sucesso nesse episódio.",
      },
    ],
    publishedDate: "2026-08-15",
    updatedDate: "2026-08-15",
    methodologyNote: buildMethodologyNote(MENTIONS),
    footerNavUtm: ENTITY_DEEPSEEK_FOOTER_NAV_UTM,
  };
}
