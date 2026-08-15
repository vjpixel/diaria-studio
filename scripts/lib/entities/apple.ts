/**
 * apple.ts (#5125 — desbloqueio final do editor, 14/08/2026)
 *
 * 5ª página de entidade publicada (1ª desta unidade). Candidata de CAUDA
 * LONGA já verificada e documentada em `docs/entity-page-candidates.md`
 * (leitura manual, sessão anterior) — 7 menções reais e substanciais no
 * corpus (`data/beehiiv-cache/posts/*.json`, auditado 14-15/08/2026) via
 * regex `\bapple\b|\bsiri\b|tim cook` contra título+subtítulo, acima do
 * piso de `MIN_ENTITY_MENTIONS` (5), abaixo do lastro de qualquer hub
 * existente (12-84 manchetes). Não colide com `HUB_KEYWORD_PATTERNS`
 * (`scripts/generate-hub-sources.ts`) — nenhum termo Apple/Siri aparece
 * nos 6 hubs publicados.
 *
 * **Por que Apple agora, mesmo tendo sido preterida na rodada anterior
 * (#5292, que escolheu Samsung por ter arco mais distintivo):** o dispatch
 * desta unidade (#5125, comentário do editor 14/08/2026, 20:54:37Z) pediu
 * "prova de conceito com UMA página" com condição inegociável de nascer
 * com regeneração automática — Apple já era a "melhor candidata única pra
 * próxima rodada" registrada em `docs/entity-page-candidates.md`, então é
 * a escolha natural desta unidade em vez de reabrir o levantamento.
 *
 * **Achado repetido do candidato anterior, aceito conscientemente:** o
 * arco de Apple É mais repetitivo que o de Samsung ("mais um recurso de IA
 * embarcado" em quase toda entrada — busca no Siri, chip do iPhone, chip
 * M5, MacBook/iPad, foundation models, transcrição no Genius Bar). O
 * `introParagraph` abaixo nomeia esse padrão em vez de fingir uma
 * dramaticidade que as menções não sustentam (mesma disciplina da seção
 * "Honestidade sobre profundidade" no docstring de `entity-page.ts`) — a
 * exceção ao padrão repetitivo é o processo antitruste movido por X/xAI,
 * incluída aqui pela perspectiva de Apple como RÉ (a mesma menção também
 * aparece em `xai.ts` pela perspectiva de xAI como autora — overlap
 * deliberado, mesmo racional já registrado em `mercado-trabalho` no
 * `generate-hub-sources.ts`: "um hub pode aparecer em mais de um painel
 * temático").
 *
 * Cada `summary` foi escrito depois de ler `content.free.web` da edição
 * correspondente. Datas ESTÁTICAS — mesma disciplina de `perplexity.ts`.
 * A data de 2025-08-27 usa o mesmo override de
 * `beehiiv-publish-date-overrides.json` que `xai.ts` já usa para o mesmo
 * slug (`google-lan-a-gemini-2-5-flash-image`) — as 6 primeiras edições da
 * diar.ia.br foram enviadas por e-mail pessoal antes da migração pro
 * Beehiiv, ver comentário do próprio arquivo de overrides.
 */
import type { EntityContent } from "../shared/entity-page.ts";
import { ENTITY_APPLE_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import { formatMonthYear } from "../shared/geo-faq.ts";

const MENTIONS: EntityContent["mentions"] = [
  {
    date: "2025-08-27",
    headline: "X e xAI processam Apple e OpenAI",
    editionUrl: "https://diar.ia.br/p/google-lan-a-gemini-2-5-flash-image",
    editionTitle: "Google lança Gemini 2.5 Flash Image",
    summary:
      "Elon Musk e as empresas X e xAI processaram a Apple e a OpenAI na Justiça Federal do Texas, acusando a Apple de manipular os rankings da App Store para favorecer o ChatGPT — o processo alega que nenhum app da xAI (X, Grok) aparecia na categoria \"Must-Have\", onde o ChatGPT era o único chatbot listado, o que constituiria uma violação antitruste.",
  },
  {
    date: "2025-09-04",
    headline: "Apple planeja lançar ferramenta de busca com IA",
    editionUrl: "https://diar.ia.br/p/openai-anuncia-controles-parentais-para-chatgpt",
    editionTitle: "OpenAI anuncia controles parentais para ChatGPT",
    summary:
      "A Apple está desenvolvendo uma ferramenta de busca web com IA batizada internamente de \"World Knowledge Answers\", prevista para chegar ao Siri no início de 2026 como um \"motor de respostas\" nos moldes do ChatGPT e do Google AI Overviews — a empresa também avalia usar uma versão customizada do Gemini para funcionalidades de resumo.",
  },
  {
    date: "2025-09-10",
    headline: "Apple revela iPhone 17 Air com IA",
    editionUrl: "https://diar.ia.br/p/estudo-de-harvard-estima-92-mi-de-empregos-esta-o-em-risco",
    editionTitle: "Estudo de Harvard estima: 92 mi de empregos estão em risco",
    summary:
      "No evento anual, a Apple apresentou o iPhone 17 Air, o redesign mais fino de sua história (5,6mm), equipado com o chip A19 Pro e aceleradores neurais dedicados que rodam modelos de linguagem localmente com o triplo do desempenho da geração anterior — a 1ª grande aposta da empresa em IA embarcada nos próprios dispositivos.",
  },
  {
    date: "2025-10-15",
    headline: "Apple anuncia novo chip M5 com desempenho de IA 4x maior",
    editionUrl: "https://diar.ia.br/p/novo-estudo-revela-vulnerabilidade-de-modelos-a-envenenamento-de-dados",
    editionTitle: 'Novo estudo revela vulnerabilidade de modelos a "Envenenamento de Dados"',
    summary:
      "A Apple anunciou o chip M5, fabricado em processo de 3 nanômetros de 3ª geração, com desempenho de GPU para IA até 4x superior ao M4 — equipa os novos MacBook Pro de 14 polegadas, iPad Pro e Vision Pro, todos com Acelerador Neural em cada núcleo para executar modelos de linguagem localmente com mais velocidade.",
  },
  {
    date: "2026-03-12",
    headline: "Apple lança MacBook Air e iPad Air com IA expandida",
    editionUrl: "https://diar.ia.br/p/perplexity-transforma-mac-mini-em-agente-de-ia-24-7",
    editionTitle: "Perplexity transforma Mac mini em agente de IA 24/7",
    summary:
      "A Apple lançou o MacBook Air com o novo chip M5 (CPU e GPU mais rápidas, com Acelerador Neural em cada núcleo) e o iPad Air com o chip M4, ampliando a estratégia de processamento de IA on-device sem depender da nuvem — parte de um esforço mais amplo da empresa de consolidar privacidade e portabilidade como diferenciais competitivos.",
  },
  {
    date: "2026-06-09",
    headline: "Apple revela a 3ª geração dos seus modelos base",
    editionUrl: "https://diar.ia.br/p/chatgpt-deixa-de-ser-chatbot-vira-agente",
    editionTitle: "ChatGPT deixa de ser chatbot, vira agente",
    summary:
      "A Apple apresentou a 3ª geração dos Apple Foundation Models, núcleo do Apple Intelligence — 5 modelos feitos em parceria com o Google, uns rodando direto no aparelho e outros via Private Cloud Compute (infraestrutura de nuvem privada mantida pela própria Apple), cobrindo escrita, resumo, análise de imagem e ações dentro de apps no iOS, iPadOS e macOS.",
  },
  {
    date: "2026-07-21",
    headline: "Apple grava atendimentos do Genius Bar com IA",
    editionUrl: "https://diar.ia.br/p/10-startups-do-brasil-miram-us-100-mi-em-2026",
    editionTitle: "10 startups do Brasil miram US$ 100 mi em 2026",
    summary:
      "A Apple começou a testar em lojas selecionadas o sistema interno Live Notes, que transcreve e resume automaticamente os atendimentos do Genius Bar (o balcão de suporte técnico da marca) para ajudar a equipe a documentar o atendimento — uso opcional, com autorização explícita de funcionário e cliente antes de qualquer gravação.",
  },
];

/** Nota de metodologia DERIVADA de `MENTIONS` — mesma disciplina de
 * `buildMethodologyNote` em `perplexity.ts`/`samsung.ts` (cópia local
 * pequena, não importada — ver nota de fronteira em `entity-page.ts`). */
function buildMethodologyNote(mentions: EntityContent["mentions"]): string {
  const since = formatMonthYear(mentions[0].date);
  const until = formatMonthYear(mentions[mentions.length - 1].date);
  const between = since === until ? since : `${since} e ${until}`;
  return `O levantamento vem de ${mentions.length} edições publicadas entre ${between}; os números saem do arquivo da diar.ia.br, não de verificação independente junto à Apple.`;
}

export function getAppleEntity(): EntityContent {
  return {
    slug: "apple",
    name: "Apple",
    metaDescription:
      "Linha do tempo da Apple na cobertura da diar.ia.br: do chip A19 Pro ao processo movido por X e xAI, passando pela 3ª geração dos Apple Foundation Models.",
    introHeading: "Como a Apple foi incorporando IA a cada camada dos seus produtos?",
    introParagraph:
      "A Apple apareceu na cobertura da diar.ia.br sobretudo como uma incumbente cautelosa incorporando IA camada por camada, produto por produto: um chip novo com aceleradores neurais mais rápidos (A19 Pro, depois M5), um assistente de busca próprio em desenvolvimento para o Siri, uma nova geração dos Apple Foundation Models rodando em parte no aparelho e em parte numa nuvem privada da própria empresa, e até um piloto discreto de transcrição por IA no atendimento do Genius Bar. É um padrão mais repetitivo que dramático — cada edição soma mais um recurso de IA embarcado, não uma virada de estratégia — com uma exceção clara: em agosto de 2025 a Apple entrou como ré num processo movido por Elon Musk, X e xAI, acusada de manipular os rankings da App Store em favor do ChatGPT. Esta página reúne, em ordem cronológica, cada vez que a Apple apareceu nas edições da diária.",
    mentions: MENTIONS,
    faq: [
      {
        question: "Quantas vezes a Apple apareceu na diar.ia.br?",
        answer: `${MENTIONS.length} vezes, entre ${formatMonthYear(MENTIONS[0].date)} e ${formatMonthYear(MENTIONS[MENTIONS.length - 1].date)} — do processo movido por X e xAI ao piloto de transcrição por IA no Genius Bar.`,
      },
      {
        question: "A Apple tem um hub temático dedicado na diar.ia.br?",
        answer:
          "Não. Os hubs temáticos (arquivo.diar.ia.br/temas) cobrem só empresas/temas com dezenas de manchetes acumuladas — Anthropic/Claude, OpenAI/ChatGPT, Google/Gemini e Meta, além de 2 temas transversais. A Apple tem cobertura relevante mas ainda de cauda longa; esta página de entidade é o formato adequado a esse volume.",
      },
      {
        question: "O que são os Apple Foundation Models?",
        answer:
          "O núcleo do Apple Intelligence: uma família de 5 modelos de IA feitos em parceria com o Google, cobrindo escrita, resumo, análise de imagem e ações dentro de apps no iOS, iPadOS e macOS. Alguns rodam direto no aparelho; os que exigem mais poder de processamento passam pelo Private Cloud Compute, infraestrutura de nuvem privada que a própria Apple administra.",
      },
      {
        question: "Por que X e xAI processaram a Apple?",
        answer:
          "Em agosto de 2025, Elon Musk e as empresas X e xAI entraram com uma ação na Justiça Federal do Texas acusando a Apple de manipular os rankings da App Store para favorecer o ChatGPT da OpenAI em detrimento de concorrentes como o Grok — o processo alega que nenhum app da xAI aparecia na categoria \"Must-Have\", onde o ChatGPT era o único chatbot listado.",
      },
      {
        question: "O que o chip M5 da Apple traz de novo para IA?",
        answer:
          "Lançado em outubro de 2025, o M5 é fabricado em processo de 3 nanômetros de 3ª geração e oferece desempenho de GPU para IA até 4x superior ao chip anterior (M4), com um Acelerador Neural em cada núcleo — equipa MacBook Pro, iPad Pro, Vision Pro e, na versão adaptada, o MacBook Air lançado em março de 2026.",
      },
    ],
    publishedDate: "2026-08-15",
    updatedDate: "2026-08-15",
    methodologyNote: buildMethodologyNote(MENTIONS),
    footerNavUtm: ENTITY_APPLE_FOOTER_NAV_UTM,
  };
}
