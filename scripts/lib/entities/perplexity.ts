/**
 * perplexity.ts (#5125 item 3 — PoC do formato "página por entidade")
 *
 * Conteúdo da 1ª página de entidade publicada, `especial.diar.ia.br/entidades/perplexity/`.
 *
 * **Por que Perplexity (critério de escolha, registrado no PR conforme
 * pedido no dispatch #5125):** é uma entidade de CAUDA LONGA — aparece 8x
 * no corpus confirmado (`data/beehiiv-cache/posts/*.json`, auditado em
 * 13/08/2026), acima do piso de `MIN_ENTITY_MENTIONS` (5), mas MUITO abaixo
 * do lastro dos 6 hubs temáticos existentes (12-84 manchetes cada). Nunca
 * teria massa crítica pra virar um hub dedicado, e não é nenhuma das
 * empresas já cobertas por hub (Anthropic/Claude, OpenAI/ChatGPT, Google/
 * Gemini, Meta) — checado contra `HUB_KEYWORD_PATTERNS`
 * (`scripts/generate-hub-sources.ts`) antes de escolher: nenhum overlap.
 * Candidatas descartadas na mesma varredura por volume ALTO DEMAIS pra
 * "cauda longa" (arriscariam ler como início de um 7º hub, fora do escopo
 * desta unidade): Microsoft/Copilot (21 edições), Nvidia (19), xAI/Grok (9,
 * borderline — ficou de fora só porque Perplexity tinha o arco narrativo
 * mais completo: funding → infraestrutura → parceria de dado → disputa
 * legal → integração de hardware → produto de plataforma). Candidatas
 * descartadas por volume BAIXO DEMAIS (abaixo do piso, thin content certo):
 * Mistral (1), Manus (2), e uma dúzia de outras (Midjourney, ElevenLabs,
 * Character.AI, Runway, Suno, Cursor, Replit, Hugging Face, Stability AI,
 * Cohere, Ideogram, Luma, Notion, Canva, Adobe Firefly, Genspark) com 0
 * menções confirmadas no corpus atual.
 *
 * Cada `summary` abaixo foi escrito depois de ler `content.free.web` da
 * edição correspondente (não a manchete/subtítulo reformulados) — ver
 * critério anti-thin-content em `scripts/lib/shared/entity-page.ts`. Datas
 * derivadas de `publish_date` (epoch) convertido pra `America/Sao_Paulo`,
 * mesma convenção de `resolvePublishDate` (`scripts/lib/beehiiv-publish-date.ts`).
 *
 * **Excluído de propósito:** os parágrafos de rodapé "Na Diar.ia usamos a
 * Perplexity para automatizar a pesquisa..." que aparecem em 5 das 8
 * edições confirmadas NÃO viraram `EntityMention` — são autopromoção do
 * PRODUTO diar.ia.br usando a Perplexity como ferramenta interna, não
 * cobertura EDITORIAL da Perplexity como notícia (ver docstring do módulo
 * `entity-page.ts`, seção "Critério anti-thin-content").
 *
 * Data ESTÁTICA, não `new Date()` — mesma disciplina de `scripts/lib/hubs/*.ts`
 * (o HTML é gerado e COMMITADO; `test/build-entity-page.test.ts` compara o
 * asset committed contra um render fresco, um valor dinâmico quebraria isso).
 */
import type { EntityContent } from "../shared/entity-page.ts";
import { ENTITY_PERPLEXITY_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import { formatMonthYear } from "../shared/geo-faq.ts";

const MENTIONS: EntityContent["mentions"] = [
  {
    date: "2025-09-11",
    headline: "Perplexity levanta US$ 200 mi com avaliação de US$ 20 bi",
    editionUrl: "https://diar.ia.br/p/profissionais-brasileiros-de-ti-s-o-os-menos-preocupados-com-impacto-da-ia-na-carreira",
    editionTitle: "Profissionais brasileiros de TI são os menos preocupados com impacto da IA na carreira",
    summary:
      "A Perplexity captou US$ 200 milhões numa rodada que avaliou a empresa em US$ 20 bilhões — dois meses depois de levantar US$ 100 milhões a US$ 18 bilhões em julho, e a 3ª rodada em pouco mais de um ano, somando US$ 1,5 bilhão desde a fundação em 2022. A receita recorrente anual já se aproximava de US$ 200 milhões, e a empresa vinha de oferecer US$ 34,5 bilhões pelo navegador Chrome do Google, em meio ao processo antitruste americano contra a gigante de buscas.",
  },
  {
    date: "2025-09-29",
    headline: "Perplexity lança API de buscas",
    editionUrl: "https://diar.ia.br/p/openai-cria-assistente-proativo",
    editionTitle: "OpenAI cria assistente proativo",
    summary:
      "A empresa abriu a Search API, dando a desenvolvedores acesso direto à infraestrutura que indexa centenas de bilhões de páginas e atualiza resultados quase em tempo real, com SDK completo e um framework open-source de avaliação (\"search_evals\"). O lançamento a posiciona como concorrente direta da API de busca do Google — infraestrutura própria para quem quiser construir aplicações de IA sem depender do buscador tradicional.",
  },
  {
    date: "2025-10-31",
    headline: "Perplexity vai pagar para usar imagens da Getty",
    editionUrl: "https://diar.ia.br/p/nvidia-e-a-primeira-empresa-a-valer-us-5-tri",
    editionTitle: "Nvidia é a primeira empresa a valer US$ 5 tri",
    summary:
      "A Perplexity fechou um acordo de licenciamento multianual com a Getty Images para usar o acervo editorial e criativo da agência nas respostas de busca, com créditos de imagem linkando a fonte. A empresa afirmou responder mais de 150 milhões de perguntas por semana no mundo todo — a escala que justificou pagar por um banco de imagens em vez de usar conteúdo sem licença.",
  },
  {
    date: "2025-11-05",
    headline: "Perplexity acusa Amazon de bullying",
    editionUrl: "https://diar.ia.br/p/data-centers-no-espaco",
    editionTitle: "Projeto quer lançar data centers de no espaço",
    summary:
      "A Perplexity denunciou publicamente ter recebido uma ameaça legal da Amazon para impedir que usuários do seu assistente agêntico Comet fizessem compras na Amazon usando login próprio guardado localmente no dispositivo. A empresa chamou a postura de \"bullying corporativo\" — o primeiro confronto jurídico direto entre uma varejista grande e uma empresa de IA agêntica, num momento em que agentes autônomos começam a competir com o próprio checkout das lojas que eles navegam.",
  },
  {
    date: "2025-12-26",
    headline: "Compare ChatGPT, Gemini e Perplexity",
    editionUrl: "https://diar.ia.br/p/o-gemini-venceu-o-chatgpt",
    editionTitle: "O Gemini venceu o ChatGPT?",
    summary:
      "Num teste comparativo publicado pela própria diária (pedindo aos 3 assistentes que resumissem uma edição em 5 tópicos), o Gemini alucinou, o ChatGPT respondeu corretamente mas com generalizações, e a Perplexity foi avaliada como redundante — um retrato pontual de como as 3 ferramentas se saíam na mesma tarefa naquele momento, não um benchmark formal.",
  },
  {
    date: "2026-02-23",
    headline: "Samsung e Perplexity firmam parceria",
    editionUrl: "https://diar.ia.br/p/executiva-de-ia-assume-comando-do-xbox",
    editionTitle: "Executiva de IA assume comando do Xbox",
    summary:
      "A Samsung expandiu o Galaxy AI com uma aliança com a Perplexity, integrando múltiplos agentes de busca direto aos smartphones da linha — os aparelhos passam a processar consultas complexas nativamente, reduzindo a dependência de apps externos pra pesquisar na internet.",
  },
  {
    date: "2026-02-27",
    headline: "Perplexity Computer",
    editionUrl: "https://diar.ia.br/p/claude-opus-3-se-aposenta-e-vira-blogueiro",
    editionTitle: "Claude Opus 3 se aposenta e vira blogueiro",
    summary:
      "A Perplexity lançou o Computer, um \"trabalhador digital\" que orquestra vários modelos de terceiros (Opus, Gemini, Grok, ChatGPT) pra transformar objetivos em fluxos de trabalho completos — pesquisar, escrever, programar, operar navegador e sistema de arquivos, de forma assíncrona e por horas ou meses seguidos — acessível via o plano Perplexity Max. É a virada de buscador pra plataforma que orquestra IA de outras empresas.",
  },
  {
    date: "2026-03-12",
    headline: "Personal Computer: agente autônomo da Perplexity",
    editionUrl: "https://diar.ia.br/p/perplexity-transforma-mac-mini-em-agente-de-ia-24-7",
    editionTitle: "Perplexity transforma Mac mini em agente de IA 24/7",
    summary:
      "Na 1ª conferência de desenvolvedores da empresa (Ask 2026), a Perplexity anunciou o Personal Computer — uma versão do Computer que roda continuamente num Mac mini dedicado, funcionando como \"proxy digital\" do usuário 24 horas por dia, com salvaguardas explícitas (aprovação pra ações sensíveis, trilha de auditoria, kill switch). Disponível só pra assinantes do Perplexity Max (US$ 200/mês), via lista de espera — o CEO Aravind Srinivas descreveu o produto como a virada de um sistema operacional que recebe instruções pra um que recebe objetivos.",
  },
];

/** Nota de metodologia DERIVADA de `MENTIONS` (mesma disciplina de
 * `defaultMethodologyNote` em `hub-page.ts`) — nunca um texto solto com
 * contagem/janela transcritas à mão, pra não driftar se `MENTIONS` mudar
 * numa revisão futura. Cópia local pequena (não importa de `hub-page.ts`,
 * ver nota de fronteira em `entity-page.ts`). */
function buildMethodologyNote(mentions: EntityContent["mentions"]): string {
  const since = formatMonthYear(mentions[0].date);
  const until = formatMonthYear(mentions[mentions.length - 1].date);
  const between = since === until ? since : `${since} e ${until}`;
  return `O levantamento vem de ${mentions.length} edições publicadas entre ${between}; os números saem do arquivo da diar.ia.br, não de verificação independente junto à Perplexity.`;
}

export function getPerplexityEntity(): EntityContent {
  return {
    slug: "perplexity",
    name: "Perplexity",
    metaDescription:
      "Linha do tempo da Perplexity na cobertura da diar.ia.br: captações bilionárias, disputa com a Amazon e o salto de buscador a agente autônomo.",
    introHeading: "Como a Perplexity foi de buscador desafiante a plataforma de agentes?",
    introParagraph:
      "A Perplexity entrou na cobertura da diar.ia.br como um buscador desafiante, levantando centenas de milhões de dólares numa sucessão de rodadas de captação. De lá pra cá, a empresa abriu infraestrutura própria pra desenvolvedores (Search API), fechou um acordo de licenciamento de imagens com a Getty, e entrou num confronto público com a Amazon sobre até onde um assistente agêntico pode ir dentro do site de outra empresa. Mais recentemente, o produto mudou de escopo: de responder perguntas pra orquestrar outros modelos de IA num \"trabalhador digital\" (Computer) que roda tarefas por horas seguidas, e depois num agente que fica ativo 24 horas por dia num computador dedicado (Personal Computer). Esta página reúne, em ordem cronológica, cada vez que a Perplexity apareceu nas edições da diária.",
    mentions: MENTIONS,
    faq: [
      {
        question: "Quantas vezes a Perplexity apareceu na diar.ia.br?",
        answer: `${MENTIONS.length} vezes, entre ${formatMonthYear(MENTIONS[0].date)} e ${formatMonthYear(MENTIONS[MENTIONS.length - 1].date)} — de uma rodada de captação a US$ 20 bilhões de avaliação até o lançamento do Personal Computer.`,
      },
      {
        question: "A Perplexity tem um hub temático dedicado na diar.ia.br?",
        answer:
          "Não. Os hubs temáticos (arquivo.diar.ia.br/temas) cobrem só empresas/temas com dezenas de manchetes acumuladas — Anthropic/Claude, OpenAI/ChatGPT, Google/Gemini e Meta, além de 2 temas transversais. A Perplexity tem cobertura relevante mas ainda de cauda longa; esta página de entidade é o formato adequado a esse volume.",
      },
      {
        question: "Qual foi a maior polêmica envolvendo a Perplexity coberta pela diária?",
        answer:
          "A disputa com a Amazon em novembro de 2025, quando a Perplexity denunciou ter recebido uma ameaça legal para impedir que usuários do seu assistente Comet fizessem compras no site da Amazon — o primeiro confronto jurídico direto entre uma varejista grande e uma empresa de IA agêntica.",
      },
      {
        question: "O que é o Perplexity Computer?",
        answer:
          "Um produto lançado em fevereiro de 2026 que orquestra vários modelos de terceiros (Opus, Gemini, Grok, ChatGPT) para transformar um objetivo em um fluxo de trabalho completo — pesquisar, programar, operar navegador e arquivos — rodando de forma assíncrona por horas ou meses, acessível via o plano Perplexity Max.",
      },
      {
        question: "Como a Perplexity se compara a ChatGPT e Gemini na prática?",
        answer:
          "Num teste pontual publicado pela diária em dezembro de 2025 (resumir uma edição em 5 tópicos), o Gemini alucinou, o ChatGPT acertou mas generalizou, e a Perplexity foi avaliada como redundante — não é um benchmark formal, só um retrato de um teste específico num momento específico.",
      },
    ],
    publishedDate: "2026-08-13",
    updatedDate: "2026-08-13",
    methodologyNote: buildMethodologyNote(MENTIONS),
    footerNavUtm: ENTITY_PERPLEXITY_FOOTER_NAV_UTM,
  };
}
