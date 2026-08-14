/**
 * xai.ts (#5125 item 4 — lote pequeno pós-decisão do editor 14/08/2026)
 *
 * 3ª entidade publicada nesta rodada de escala reduzida (~3 de ~20 páginas
 * planejadas — ver `docs/entity-page-candidates.md` para o ranking
 * completo e as candidatas restantes). Candidata de CAUDA LONGA — 9
 * edições confirmadas no corpus (`data/beehiiv-cache/posts/*.json`,
 * auditado 14/08/2026) via regex `\bxai\b|\bgrok\b` contra
 * título+subtítulo (10 menções — 1 edição, 2026-01-12, teve 2
 * desenvolvimentos genuinamente distintos no mesmo dia, ver abaixo).
 * Acima do piso de `MIN_ENTITY_MENTIONS` (5), abaixo do lastro de
 * qualquer hub existente (12-84 manchetes). Não colide com
 * `HUB_KEYWORD_PATTERNS` (`scripts/generate-hub-sources.ts`) — nenhum
 * termo `xai`/`grok` aparece nos 6 hubs publicados.
 *
 * **2 menções na mesma data (2026-01-12):** a edição daquele dia tinha 2
 * matches de manchete genuinamente independentes — a escalada regulatória
 * global sobre imagens sexualizadas geradas pelo Grok, e o vazamento do
 * quanto a xAI queimou em caixa em 2025. `validateEntityContent` só exige
 * ordem cronológica NÃO decrescente (mesma data é permitida) — usado aqui
 * em vez de forçar as 2 histórias num único `summary` artificialmente
 * longo, ou descartar uma das duas.
 *
 * Cada `summary` foi escrito depois de ler `content.free.web` da edição
 * correspondente. Datas ESTÁTICAS — mesma disciplina de `perplexity.ts`.
 */
import type { EntityContent } from "../shared/entity-page.ts";
import { ENTITY_XAI_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import { formatMonthYear } from "../shared/geo-faq.ts";

const MENTIONS: EntityContent["mentions"] = [
  {
    date: "2025-08-27",
    headline: "X e xAI processam Apple e OpenAI por práticas monopolistas",
    editionUrl: "https://diar.ia.br/p/google-lan-a-gemini-2-5-flash-image",
    editionTitle: "Google lança Gemini 2.5 Flash Image",
    summary:
      "Elon Musk e suas empresas X e xAI entraram com ação judicial contra Apple e OpenAI na Justiça Federal do Texas, acusando a Apple de manipular os rankings da App Store para favorecer o ChatGPT em detrimento do Grok — nenhum aplicativo da xAI aparecia na categoria \"Must-Have\", onde o ChatGPT era o único chatbot listado.",
  },
  {
    date: "2025-09-01",
    headline: "xAI processa ex-engenheiro por roubo de segredos comerciais do Grok",
    editionUrl: "https://diar.ia.br/p/xai-processa-ex-engenheiro-por-roubo-de-segredos-comerciais",
    editionTitle: "xAI processa ex-engenheiro por roubo de segredos comerciais",
    summary:
      "A xAI entrou com ação judicial contra o ex-engenheiro Xuechen Li, um dos primeiros 20 funcionários da empresa, acusando-o de roubar segredos comerciais do Grok dias antes de vender US$ 7 milhões em ações e se juntar à OpenAI — a empresa buscou liminar para impedi-lo de trabalhar no rival e cobrar danos.",
  },
  {
    date: "2025-09-24",
    headline: "xAI lança Grok 4 Fast — modelo de raciocínio 98% mais barato",
    editionUrl: "https://diar.ia.br/p/alibaba-lanc-a-tre-s-modelos-de-open-source-e-quebra-32-recordes",
    editionTitle: "Alibaba lança três modelos de open source e quebra 32 recordes",
    summary:
      "A xAI lançou o Grok 4 Fast, com performance próxima ao Grok 4 principal mas 98% mais barato — US$ 0,50 por milhão de tokens de saída contra US$ 15,00 do modelo anterior —, usando em média 40% menos tokens de raciocínio e com janela de contexto de 2 milhões de tokens.",
  },
  {
    date: "2025-11-19",
    headline: "xAI lança Grok 4.1 com inteligência emocional avançada e redução de alucinações",
    editionUrl: "https://diar.ia.br/p/tudo-sobre-gemini-3",
    editionTitle: "Tudo sobre Gemini 3",
    summary:
      "A xAI lançou o Grok 4.1, que reduziu alucinações de 9,89% para menos de 3% e liderou benchmarks de inteligência emocional (1.586 no EQ-Bench3) depois de um teste silencioso em que 65% dos usuários preferiram o modelo novo ao Grok 4.0 — a versão também ganhou acesso em tempo real a dados do X e da web pública.",
  },
  {
    date: "2025-11-20",
    headline: "Humain e xAI firmam parceria para implantar Grok na Arábia Saudita",
    editionUrl: "https://diar.ia.br/p/estudo-revela-falha-em-llms-por-meio-de-poemas",
    editionTitle: "Estudo revela falha em LLMs por meio de poemas",
    summary:
      "A empresa saudita Humain fechou parceria com a xAI para construir data centers de IA de baixa latência na Arábia Saudita e implantar o Grok no país, alinhando-se ao objetivo saudita de virar a nação mais habilitada em IA do mundo — o acordo previu também colaboração em pesquisa e formação de talentos locais.",
  },
  {
    date: "2026-01-08",
    headline: "Grok sob investigação",
    editionUrl: "https://diar.ia.br/p/grok-acusado-de-sexualizar-imagens-de-crianc-as",
    editionTitle: "Grok acusado de sexualizar imagens de crianças",
    summary:
      "O Reino Unido abriu investigação contra X e xAI depois que ativistas documentaram usuários enviando fotos ao Grok pedindo para sexualizar as imagens, incluindo relatos envolvendo menores — o X bloqueou o recurso de geração de imagens do Grok após a denúncia, e o regulador britânico Ofcom cobrou esclarecimentos formais das duas empresas.",
  },
  {
    date: "2026-01-12",
    headline: "Grok sob pressão global por imagens sexualizadas",
    editionUrl: "https://diar.ia.br/p/grok-sendo-investigado-internacionalmente",
    editionTitle: "Grok sendo investigado internacionalmente",
    summary:
      "A investigação sobre o Grok se espalhou: reguladores da União Europeia, França, Índia, Malásia, Indonésia e Austrália abriram apurações depois que o chatbot gerou dezenas de milhares de imagens sexualizadas, incluindo material envolvendo crianças — Musk restringiu a geração de imagens a usuários pagos e atribuiu a culpa aos usuários, não ao Grok.",
  },
  {
    date: "2026-01-12",
    headline: "xAI queimou US$ 7,8 bi em 2025 para dominar infraestrutura",
    editionUrl: "https://diar.ia.br/p/grok-sendo-investigado-internacionalmente",
    editionTitle: "Grok sendo investigado internacionalmente",
    summary:
      "No mesmo dia, vazou que a xAI queimou cerca de US$ 7,8 bilhões em 2025 entre data centers, contratações e desenvolvimento, faturando apenas US$ 200 milhões — prejuízo líquido de US$ 1,46 bilhão só no terceiro trimestre. A empresa já tinha levantado US$ 40 bilhões desde a fundação e operava mais de 1 milhão de GPUs H100, numa estratégia deliberada de aceitar prejuízo para dominar infraestrutura antes da concorrência.",
  },
  {
    date: "2026-01-22",
    headline: "Risco de bloqueio do X por violações da LGPD",
    editionUrl: "https://diar.ia.br/p/brasil-da-30-dias-para-xai-combater-conteu-do-falso",
    editionTitle: "Brasil dá 30 dias para xAI combater conteúdo falso",
    summary:
      "O governo brasileiro recomendou medidas urgentes à X e à xAI para barrar as imagens de nudez digital geradas pelo Grok sem consentimento, sob risco de suspensão da plataforma no país — levantamentos citados na cobertura apontaram 85% das imagens do Grok como sexualizadas, num volume de 6,7 mil por hora, e o Idec pediu banimento imediato por violação à LGPD, ao ECA e ao CDC.",
  },
  {
    date: "2026-07-31",
    headline: "xAI processa Minnesota por lei antinudes",
    editionUrl: "https://diar.ia.br/p/claude-expoe-bugs-mais-rapido-que-microsoft-corrige",
    editionTitle: "Claude expõe bugs mais rápido que Microsoft corrige",
    summary:
      "A xAI entrou com ação judicial contra o estado americano de Minnesota para contestar uma lei que proíbe a geração de nudes sem consentimento — recurso disponível no Grok —, escolhendo brigar na Justiça em vez de ajustar o produto antes mesmo de a norma entrar em vigor; não era a primeira vez que o Grok gerava controvérsia por imagens íntimas não autorizadas.",
  },
];

/** Nota de metodologia DERIVADA de `MENTIONS` — mesma disciplina de
 * `buildMethodologyNote` em `perplexity.ts` (cópia local pequena, não
 * importada — ver nota de fronteira em `entity-page.ts`). */
function buildMethodologyNote(mentions: EntityContent["mentions"]): string {
  const since = formatMonthYear(mentions[0].date);
  const until = formatMonthYear(mentions[mentions.length - 1].date);
  const between = since === until ? since : `${since} e ${until}`;
  return `O levantamento vem de ${mentions.length} menções em edições publicadas entre ${between}; os números saem do arquivo da diar.ia.br, não de verificação independente junto à xAI.`;
}

export function getXaiEntity(): EntityContent {
  return {
    slug: "xai",
    name: "xAI",
    metaDescription:
      "Linha do tempo da xAI na cobertura da diar.ia.br: disputas judiciais, o Grok 4.1 e o escândalo global de imagens sexualizadas geradas pelo Grok.",
    introHeading: "Como o Grok da xAI foi de disputa judicial a escândalo global de segurança?",
    introParagraph:
      "A xAI entrou na cobertura da diar.ia.br em pé de guerra jurídica — processando a Apple e a OpenAI por práticas monopolistas, e um ex-engenheiro por roubo de segredos comerciais — enquanto lançava modelos cada vez mais baratos e capazes (Grok 4 Fast, Grok 4.1) e fechava uma parceria de infraestrutura com a Arábia Saudita. A virada veio em janeiro de 2026: reguladores do Reino Unido, da União Europeia e de mais de meia dúzia de países abriram investigações depois que o Grok gerou dezenas de milhares de imagens sexualizadas, incluindo material envolvendo crianças, e o Brasil deu à empresa um prazo de 30 dias sob ameaça de bloqueio. No mesmo período vazou que a empresa queimava bilhões de dólares construindo infraestrutura própria. Meses depois, a xAI ainda brigava na Justiça — dessa vez contra uma lei estadual americana que restringe a geração de nudes sem consentimento. Esta página reúne, em ordem cronológica, cada vez que a xAI apareceu nas edições da diária.",
    mentions: MENTIONS,
    faq: [
      {
        question: "Quantas vezes a xAI apareceu na diar.ia.br?",
        answer: `${MENTIONS.length} menções, entre ${formatMonthYear(MENTIONS[0].date)} e ${formatMonthYear(MENTIONS[MENTIONS.length - 1].date)} — de processos por práticas monopolistas ao escândalo global de imagens sexualizadas geradas pelo Grok.`,
      },
      {
        question: "A xAI tem um hub temático dedicado na diar.ia.br?",
        answer:
          "Não. Os hubs temáticos (arquivo.diar.ia.br/temas) cobrem só empresas/temas com dezenas de manchetes acumuladas — Anthropic/Claude, OpenAI/ChatGPT, Google/Gemini e Meta, além de 2 temas transversais. A xAI tem cobertura relevante mas ainda de cauda longa; esta página de entidade é o formato adequado a esse volume.",
      },
      {
        question: "Qual foi o maior escândalo envolvendo o Grok coberto pela diária?",
        answer:
          "A denúncia, em janeiro de 2026, de que usuários usaram o Grok para gerar imagens sexualizadas de mulheres e crianças sem consentimento — o caso levou a investigações no Reino Unido, na União Europeia e em mais de meia dúzia de países, e o Brasil deu 30 dias para a xAI combater o problema sob ameaça de bloqueio do X.",
      },
      {
        question: "Quanto a xAI já gastou construindo infraestrutura própria, segundo a cobertura?",
        answer:
          "Cerca de US$ 7,8 bilhões só em 2025 — entre data centers, contratações e desenvolvimento —, faturando apenas US$ 200 milhões no mesmo período. A empresa já tinha levantado US$ 40 bilhões desde a fundação e operava mais de 1 milhão de GPUs H100.",
      },
      {
        question: "O que aconteceu entre a xAI e o Brasil?",
        answer:
          "Em janeiro de 2026, o governo brasileiro recomendou medidas urgentes à X e à xAI para barrar imagens de nudez digital geradas pelo Grok sem consentimento, sob risco de suspensão da plataforma no país — o Idec pediu banimento imediato por violação à LGPD, ao ECA e ao CDC.",
      },
    ],
    publishedDate: "2026-08-14",
    updatedDate: "2026-08-14",
    methodologyNote: buildMethodologyNote(MENTIONS),
    footerNavUtm: ENTITY_XAI_FOOTER_NAV_UTM,
  };
}
