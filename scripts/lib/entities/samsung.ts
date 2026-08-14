/**
 * samsung.ts (#5125 item 4 — lote pequeno pós-decisão do editor 14/08/2026)
 *
 * 4ª entidade publicada nesta rodada de escala reduzida (~3 de ~20 páginas
 * planejadas — ver `docs/entity-page-candidates.md` para o ranking
 * completo e as candidatas restantes). Candidata de CAUDA LONGA — 6
 * edições confirmadas no corpus (`data/beehiiv-cache/posts/*.json`,
 * auditado 14/08/2026) via regex `\bsamsung\b` contra título+subtítulo,
 * acima do piso de `MIN_ENTITY_MENTIONS` (5) e abaixo do lastro de
 * qualquer hub existente (12-84 manchetes). Não colide com
 * `HUB_KEYWORD_PATTERNS` (`scripts/generate-hub-sources.ts`).
 *
 * Escolhida como 3ª entidade desta rodada (em vez de Apple, também
 * verificada com 7 menções reais) por ter arco mais distintivo: Apple
 * repete o mesmo padrão "mais um recurso de IA embarcado" em quase toda
 * menção (busca no Siri, chip do iPhone, chip M5, MacBook/iPad,
 * foundation models) — a Samsung tem uma virada de tom genuína no fim do
 * arco (fabricante que ajuda a alimentar o boom de infraestrutura de IA e
 * é a primeira vez atingida financeiramente por ele, no mesmo trimestre em
 * que também expandia adoção corporativa de IA generativa), evitando o
 * padrão genérico que o dispatch desta unidade pediu pra evitar.
 *
 * Cada `summary` foi escrito depois de ler `content.free.web` da edição
 * correspondente. Datas ESTÁTICAS — mesma disciplina de `perplexity.ts`.
 */
import type { EntityContent } from "../shared/entity-page.ts";
import { ENTITY_SAMSUNG_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import { formatMonthYear } from "../shared/geo-faq.ts";

const MENTIONS: EntityContent["mentions"] = [
  {
    date: "2025-09-19",
    headline: "Samsung realiza Galaxy AI Summit 2025 em universidades de São Paulo",
    editionUrl:
      "https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-798f898c74970",
    editionTitle: "AI conquista ouro e prata em competição mundial de programação",
    summary:
      "A Samsung levou a segunda edição do Galaxy AI Summit a universidades paulistas como Cásper Líbero, Assunção e FGV EAESP, com uma experiência interativa em parceria com o Gemini e visitas de alunos à empresa — a iniciativa mirava engajar cerca de 3 mil estudantes com apoio de influenciadores como Pedro Loos e Daniela Klaiman.",
  },
  {
    date: "2025-10-09",
    headline: "Samsung apresenta modelo de raciocínio aberto TRM que supera modelos 10.000x maiores",
    editionUrl: "https://diar.ia.br/p/bancos-soam-alerta-para-investimentos-excessivos-em-ia",
    editionTitle: "Bancos soam alerta para investimentos excessivos em IA",
    summary:
      "Pesquisadores do Samsung Advanced Institute of Technology divulgaram o Tiny Recursion Model, com apenas 7 milhões de parâmetros, capaz de superar LLMs multibilionários — como Gemini Pro e Omni — em benchmarks de raciocínio lógico e puzzles visuais, usando uma arquitetura recursiva mínima em vez da autoatenção característica de grandes modelos de linguagem.",
  },
  {
    date: "2025-10-22",
    headline: "Samsung anuncia Galaxy XR: primeiro headset com Android XR e IA multimodal nativa",
    editionUrl: "https://diar.ia.br/p/atlas-concorrente-do-comet",
    editionTitle: "OpenAI lança concorrente do Comet",
    summary:
      "A Samsung lançou, em parceria com Google e Qualcomm, o headset de realidade mista Galaxy XR por US$ 1.800 — metade do preço do Apple Vision Pro —, inaugurando a plataforma Android XR com IA multimodal nativa e integração profunda com o Google Gemini, descrita como a primeira plataforma Android desenhada inteiramente para a era Gemini.",
  },
  {
    date: "2026-02-23",
    headline: "Samsung e Perplexity firmam parceria",
    editionUrl: "https://diar.ia.br/p/executiva-de-ia-assume-comando-do-xbox",
    editionTitle: "Executiva de IA assume comando do Xbox",
    summary:
      "O ecossistema Galaxy AI da Samsung ganhou uma aliança estratégica com a Perplexity, integrando múltiplos agentes de busca diretamente aos smartphones da linha — os aparelhos passaram a processar consultas complexas de forma nativa, combinando processamento local com acesso a dados atualizados em tempo real e reduzindo a dependência de aplicativos externos de pesquisa.",
  },
  {
    date: "2026-06-23",
    headline: "ChatGPT e Codex chegam a 270 mil funcionários da Samsung",
    editionUrl: "https://diar.ia.br/p/modelos-podem-derrubar-governos-em-meses",
    editionTitle: "Modelos podem derrubar governos em meses",
    summary:
      "A Samsung liberou o ChatGPT Enterprise e o Codex para todos os cerca de 270 mil funcionários no mundo — um dos maiores contratos corporativos já fechados pela OpenAI —, revertendo o banimento de ferramentas de IA generativa que havia imposto em 2023, depois que funcionários vazaram código confidencial usando o ChatGPT. Levou três anos de políticas e controles até liberar o acesso em escala.",
  },
  {
    date: "2026-07-31",
    headline: "Samsung tem 1º prejuízo em celulares por IA",
    editionUrl: "https://diar.ia.br/p/claude-expoe-bugs-mais-rapido-que-microsoft-corrige",
    editionTitle: "Claude expõe bugs mais rápido que Microsoft corrige",
    summary:
      "A divisão de smartphones da Samsung registrou seu primeiro prejuízo trimestral, mesmo com vendas em alta — a causa não foi queda de demanda, mas o custo disparado dos chips de memória, puxado pela corrida por infraestrutura de treinamento e inferência de IA. A própria Samsung, uma das maiores fabricantes de chips de memória do mundo, sentiu o efeito ao comprar as mesmas peças mais caras para sua linha de celulares.",
  },
];

/** Nota de metodologia DERIVADA de `MENTIONS` — mesma disciplina de
 * `buildMethodologyNote` em `perplexity.ts` (cópia local pequena, não
 * importada — ver nota de fronteira em `entity-page.ts`). */
function buildMethodologyNote(mentions: EntityContent["mentions"]): string {
  const since = formatMonthYear(mentions[0].date);
  const until = formatMonthYear(mentions[mentions.length - 1].date);
  const between = since === until ? since : `${since} e ${until}`;
  return `O levantamento vem de ${mentions.length} edições publicadas entre ${between}; os números saem do arquivo da diar.ia.br, não de verificação independente junto à Samsung.`;
}

export function getSamsungEntity(): EntityContent {
  return {
    slug: "samsung",
    name: "Samsung",
    metaDescription:
      "Linha do tempo da Samsung na cobertura da diar.ia.br: do Galaxy AI Summit ao Galaxy XR, e o primeiro prejuízo em celulares causado pelo boom de IA.",
    introHeading: "Como a Samsung virou ao mesmo tempo motor e vítima do boom de IA?",
    introParagraph:
      "A Samsung apareceu na cobertura da diar.ia.br como fabricante que investe pesado em levar IA a estudantes e consumidores — do Galaxy AI Summit em universidades brasileiras a um modelo de raciocínio minúsculo (7 milhões de parâmetros) capaz de superar rivais bilionários, passando por um headset de realidade mista pela metade do preço do Apple Vision Pro e uma parceria com a Perplexity para turbinar a busca nos seus celulares. A empresa também revisitou, com cautela, o próprio banimento de ferramentas de IA generativa que havia imposto em 2023, liberando ChatGPT e Codex para 270 mil funcionários só depois de três anos de controles. A virada de tom veio no meio de 2026: como uma das maiores fabricantes de chips de memória do mundo, a Samsung viu o boom de infraestrutura de IA — que ela mesma ajuda a abastecer — encarecer os componentes que usa nos próprios celulares, e registrou o primeiro prejuízo trimestral da divisão. Esta página reúne, em ordem cronológica, cada vez que a Samsung apareceu nas edições da diária.",
    mentions: MENTIONS,
    faq: [
      {
        question: "Quantas vezes a Samsung apareceu na diar.ia.br?",
        answer: `${MENTIONS.length} vezes, entre ${formatMonthYear(MENTIONS[0].date)} e ${formatMonthYear(MENTIONS[MENTIONS.length - 1].date)} — do Galaxy AI Summit ao primeiro prejuízo trimestral da divisão de celulares.`,
      },
      {
        question: "A Samsung tem um hub temático dedicado na diar.ia.br?",
        answer:
          "Não. Os hubs temáticos (arquivo.diar.ia.br/temas) cobrem só empresas/temas com dezenas de manchetes acumuladas — Anthropic/Claude, OpenAI/ChatGPT, Google/Gemini e Meta, além de 2 temas transversais. A Samsung tem cobertura relevante mas ainda de cauda longa; esta página de entidade é o formato adequado a esse volume.",
      },
      {
        question: "O que é o Galaxy XR da Samsung?",
        answer:
          "Um headset de realidade mista lançado em outubro de 2025 em parceria com Google e Qualcomm, por US$ 1.800 — metade do preço do Apple Vision Pro —, inaugurando a plataforma Android XR com IA multimodal nativa e integração profunda com o Google Gemini.",
      },
      {
        question: "Por que a Samsung teve prejuízo em celulares por causa da IA?",
        answer:
          "Em julho de 2026 a divisão de smartphones registrou seu primeiro prejuízo trimestral, mesmo com vendas em alta — o custo dos chips de memória disparou por causa da corrida por infraestrutura de IA, e a Samsung, apesar de ser uma das maiores fabricantes desses chips, pagou mais caro pelos mesmos componentes na própria linha de celulares.",
      },
      {
        question: "Como a Samsung mudou sua política sobre ferramentas de IA generativa no trabalho?",
        answer:
          "Em 2023 a empresa baniu ferramentas de IA generativa dos aparelhos corporativos depois que funcionários vazaram código confidencial usando o ChatGPT. Levou três anos de políticas e controles até liberar, em junho de 2026, o ChatGPT Enterprise e o Codex para todos os cerca de 270 mil funcionários no mundo.",
      },
    ],
    publishedDate: "2026-08-14",
    updatedDate: "2026-08-14",
    methodologyNote: buildMethodologyNote(MENTIONS),
    footerNavUtm: ENTITY_SAMSUNG_FOOTER_NAV_UTM,
  };
}
