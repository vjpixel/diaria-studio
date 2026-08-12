/**
 * meta-ai.ts (#4558, 4º hub temático publicado)
 *
 * Conteúdo editorial do hub Meta/Meta AI — primeiro hub temático de uma
 * empresa fora do trio inicial (Anthropic/Claude, OpenAI/ChatGPT,
 * Google/Gemini, #4790). Mesmo molde estrutural e mesmo critério de
 * qualidade dos 3 anteriores — ver `anthropic-claude.ts` pro histórico
 * completo da decisão. Resumo do critério não-negociável da issue: "cada hub
 * precisa carregar uma leitura que só existe porque alguém acompanhou o
 * tema por meses. Hub que reempacota manchete sem síntese própria é
 * conteúdo fino — não ganha citação e ainda arrasta o domínio."
 *
 * **Por que "meta-ai" e não só "meta"** — mesmo padrão de
 * `openai-chatgpt`/`google-gemini`: empresa + produto/marca de IA mais
 * visível. "Meta AI" é o nome que a própria Meta usa pro assistente que
 * está em WhatsApp/Instagram/Facebook e nos óculos Ray-Ban — o produto que
 * a cobertura mais cita ao lado do nome da empresa.
 *
 * **Escopo do #4922 item 1** (substitui a nota anterior, mesma ressalva dos
 * 3 hubs anteriores): total de edições/manchetes, a janela de cobertura e a
 * cadência de menção agora vêm de `hubTotals`/`hubCoverageWindow`/
 * `hubMentionCadenceDays` (`scripts/lib/shared/hub-page.ts`), usados tanto
 * pelo `faq` quanto por `introParagraph`/`metaDescription`/`introHeading` —
 * não mais recalculados em paralelo. Os demais números da prosa de
 * `sections`/`INTRO` deste hub (ex: "quatro rodadas", "duas empresas") são
 * formas POR EXTENSO, não dígitos — interpolar aqui trocaria "quatro" por
 * "4", o que é reescrita de estilo, não substituição de fato (item 4 da
 * issue: fora do escopo "só o número muda"); permanecem TRANSCRITOS À MÃO.
 * Se `test/build-hub-page.test.ts` (bloco genérico que itera `HUB_LOADERS`)
 * quebrar depois de um `generate-hub-sources.ts` novo, é a prosa que
 * precisa de revisão manual.
 *
 * **Fonte é a cobertura da diária, não fato-checado contra a Meta real** —
 * este módulo sintetiza o que a diar.ia.br noticiou sobre o tema, no
 * vocabulário que a própria diária usou. Não é o papel deste hub verificar a
 * alegação original de cada manchete — isso já aconteceu (ou não) na
 * pesquisa/gate de Stage 1 de cada edição.
 *
 * Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *   npx tsx scripts/generate-hub-sources.ts --hub meta-ai
 *   npx tsx scripts/build-hub-page.ts --hub meta-ai
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
import { HUB_META_AI_FOOTER_NAV_UTM } from "../shared/utm-registry.ts";
import sourcesRaw from "./meta-ai-sources.generated.json" with { type: "json" };
import type { HubSourceEntry } from "../../generate-hub-sources.ts";

const SOURCES = sourcesRaw as HubSourceEntry[];

/** `YYYY-MM-DD` estático — dia em que a página nasceu (PR #4926, mesma
 * sessão que introduziu `publishedDate`/`updatedDate` como campos separados,
 * #4911). Ver nota de `hub-page.ts` e `anthropic-claude.ts` sobre por que
 * não pode ser `new Date()` e por que os dois campos existem em separado. */
const PUBLISHED_DATE = "2026-08-10";

/** `YYYY-MM-DD` estático — dia em que o CORPO (síntese abaixo) foi revisado
 * por último. Bump manual quando a prosa for reescrita de forma
 * substancial — nunca cosmético (mesma ressalva de `anthropic-claude.ts`).
 * Nasce igual a `PUBLISHED_DATE` (hub recém-criado, nunca revisado ainda). */
const UPDATED_DATE = "2026-08-10";

/** `matchedHeadlines` vem em NFD ("óculos" tem acento; sem a normalização o
 * pattern de óculos abaixo bateria 0 contra o dado real, mesma classe de bug
 * documentada no hub Anthropic) — ver a nota completa em `countMatching`,
 * agora em `scripts/lib/shared/hub-page.ts` (#4922 item 1: motor único
 * reusado pelos 4 hubs, não reimplementado aqui). */

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
export function buildMetaAiFaq(sources: HubSourceEntry[]): GeoFaqItem[] {
  const { totalEditions, totalMentions } = hubTotals(sources);
  const { firstDate: oldest, lastDate: newest } = hubCoverageWindow(sources);
  const cadenceDays = hubMentionCadenceDays(sources);
  const cortes = countMatching(sources, /demit|cortar/i);
  const china = countMatching(sources, /pequim|ordem da china/i);
  const seguranca = countMatching(sources, /hackers|invas|abuso infantil/i);
  const oculos = countMatching(sources, /óculos|ray-ban/i);
  // Âncora em "^Meta compra" (início da manchete), não `/compra/i` solto: a
  // manchete "Meta desfaz compra de US$ 2 bi por ordem da China" também
  // contém a substring "compra" (é a REVERSÃO de uma aquisição, não uma
  // aquisição nova) — sem a âncora, `aquisicoes` contava 3 em vez de 2,
  // incluindo por engano o negócio desfeito na contagem de compras
  // genuínas (achado ao escrever este hub, verificado contra o dataset
  // real antes do merge).
  const aquisicoes = countMatching(sources, /^Meta compra/i);
  // #4923 item 1: substitui o CTA-sem-dado por uma pergunta factual. A
  // Seção 6 ("Além dos óculos, como a Meta AI chegou ao dia a dia de quem
  // usa WhatsApp e Instagram?") já narra estes lançamentos sem porta de
  // entrada no FAQ.
  const alcanceConsumo = countMatching(sources, /óculos|ray-ban|meta ai chega|business agent/i);

  return [
    {
      question: "Com que frequência a Meta vira notícia por causa de IA?",
      answer: `Entre ${formatDateShort(oldest ?? "")} e ${formatDateShort(newest ?? "")}, a Meta apareceu como destaque em ${totalEditions} edições da diar.ia.br, somando ${totalMentions} manchetes — uma a cada ${cadenceDays} dias corridos, em média.`,
    },
    {
      question: "Quantas vezes a Meta cortou ou demitiu equipe de IA nesse período?",
      answer: `Foram ${cortes} rodadas de corte ou demissão ligadas à área de IA da Meta entre outubro de 2025 e julho de 2026, culminando, em 16/07/2026, num processo de 26 ex-funcionários acusando a empresa de usar dados de licença médica pra montar a lista de demitidos.`,
    },
    {
      question: "Por que o governo chinês obrigou a Meta a desfazer negócios com startups chinesas?",
      answer: `Em ${china} manchetes diferentes: [a Meta perdeu a startup de agentes Manus por ordem de Pequim](https://diar.ia.br/p/meta-perde-manus-por-ordem-de-pequim), invocando segurança nacional, e 45 dias depois [a diar.ia.br confirmou que a compra de US$ 2 bi tinha mesmo sido desfeita](https://diar.ia.br/p/amodei-desemprego-pode-ser-permanente). Pequim aplicou contra a Meta o mesmo instrumento — bloqueio regulatório de investimento estrangeiro em ativo de tecnologia sensível — que Washington usa contra empresas chinesas, só que na direção oposta.`,
    },
    {
      question: "Que falhas de segurança ou moderação a Meta teve com produtos de IA?",
      answer: `${seguranca} episódios cobertos pela diar.ia.br: [o bot de suporte do Meta AI deu acesso a uma conta do Instagram a um hacker sem checar identidade](https://diar.ia.br/p/meta-ai-deu-acesso-a-contas-do-instagram-a-hackers), [a Meta lucrou com anúncios de abuso sexual infantil gerado por IA que passaram pela revisão automática](https://diar.ia.br/p/meta-lucrou-com-anuncios-de-abuso-infantil-por-ia), e [um modelo da Meta invadiu os sistemas de outra empresa durante um teste de segurança mal escopado](https://diar.ia.br/p/ia-de-stanford-cria-virus-funcional-em-lab), esta última a manchete mais recente do período. Antes delas, em 02/10/2025, já tinha vindo o uso de conversas com a IA da Meta para personalizar anúncios.`,
    },
    {
      question: "O que é o Muse Spark e por que ele marca uma virada na estratégia da Meta?",
      answer:
        "É o primeiro modelo da Meta Superintelligence Labs, liderada por Alexandr Wang — e é proprietário, rompendo com a estratégia open source que definiu o Llama até então. O lançamento veio em 09/04/2026, depois de meses de crise de liderança — incluindo a crítica pública de Yann LeCun ao novo chefe de IA da empresa.",
    },
    {
      question: "A Meta ainda aposta em óculos inteligentes com IA?",
      answer: `Sim — ${oculos} manchetes cobrem só o lançamento inicial: [o anúncio do Meta Connect 2025](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-42c8c67e9a29a) e [a edição especial sobre o Ray-Ban Display](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-cc179f705a79d), escrita em primeira pessoa por quem já usava o produto. Depois do lançamento vieram a expansão para o Brasil e o resto da linha de produtos de consumo.`,
    },
    {
      question: "Quantas empresas de IA a Meta comprou?",
      answer: `${aquisicoes} aquisições diretas de empresas de IA: [a Moltbook, rede social feita só pra agentes de IA interagirem entre si](https://diar.ia.br/p/meta-compra-rede-social-feita-s-para-agentes-de-ia), e [a Assured Robot Intelligence, pra reforçar os modelos que vão operar os robôs humanoides da Meta](https://diar.ia.br/p/meta-compra-startup-para-construir-rob-humanoide). Um terceiro negócio, a compra da Manus por US\$ 2 bilhões, também apareceu na cobertura — mas por um motivo diferente: o governo chinês obrigou a Meta a desfazer o negócio, em abril de 2026.`,
    },
    {
      question: "Em quantos produtos de consumo a Meta AI já apareceu, dos óculos ao WhatsApp corporativo?",
      answer: `${alcanceConsumo} lançamentos e mudanças de produto levaram a Meta AI ao dia a dia de quem usa os produtos da empresa: [os óculos com AR anunciados no Meta Connect 2025](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-42c8c67e9a29a), [o Ray-Ban Display detalhado em edição especial](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-cc179f705a79d), [o Meta AI chegando ao Brasil](https://diar.ia.br/p/openai-lanc-a-instant-checkout-no-chatgpt) e, quase 10 meses depois, [a cobrança por uso do Meta Business Agent no WhatsApp](https://diar.ia.br/p/governo-dos-eua-pode-virar-socio-da-openai).`,
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
      editionTitle: s.editionTitle,
    }));
}

/** INTRO derivada de `sources` (#4917 item 1) — ver a nota gêmea em
 * `anthropic-claude.ts`. A janela deste hub estava correta ao nascer; derivar
 * é o que impede que ela pare de estar no próximo regen. */
function buildIntro(sources: HubSourceEntry[]): string {
  const { between } = hubCoverageWindow(sources);
  const { totalEditions, totalMentions } = hubTotals(sources);
  const cadenceDays = hubMentionCadenceDays(sources);
  return `Entre ${between}, a Meta foi destaque em ${totalEditions} edições da diar.ia.br, ${totalMentions} manchetes ao todo, em média uma a cada ${cadenceDays} dias. Acompanhar esse volume de perto mostra uma empresa em crise de identidade sobre a própria estratégia de IA: a liderança técnica virou um caos público, com o ex-chefe de IA Yann LeCun chamando o sucessor de 29 anos, Alexandr Wang, de "jovem" e "inexperiente" logo depois de uma polêmica de manipulação de benchmark do Llama 4, num período que também trouxe quatro rodadas de corte ou demissão ligadas à área de IA, incluindo um processo judicial recente. Meses depois, sob a liderança de Wang, a Meta lançou o Muse Spark — seu primeiro modelo proprietário, abandonando a estratégia open source que definiu o Llama. A Meta também comprou pelo menos duas empresas de IA (uma rede social só para agentes, uma startup de robótica humanoide) e teve um terceiro negócio, avaliado em US$ 2 bilhões, desfeito à força pelo governo chinês — o mesmo tipo de bloqueio regulatório que Washington aplica contra empresas chinesas, na direção oposta. Uma sequência de falhas de segurança e moderação, da conta do Instagram invadida via bot de suporte a anúncios de abuso infantil que passaram pela revisão automática, termina em episódio ainda mais recente: o próprio modelo da Meta invadindo os sistemas de outra empresa. Cada um desses pontos aparece detalhado adiante, com data e link para a edição que o registrou.`;
}

export function getMetaAiHub(): HubContent {
  const { since, until } = hubCoverageWindow(SOURCES);
  return {
    slug: "meta-ai",
    title: "Meta e Meta AI",
    // #4912: H1 carrega o intervalo coberto (o `<title>`/`og:title` continua
    // só `title`, montado em `renderHubPage` — não duplicam o período).
    h1: `Meta e Meta AI — de ${since} a ${until}`,
    // #4913: ≤160 chars (validateHubContent) — trecho final enxuto de propósito.
    metaDescription: `Meta e Meta AI no arquivo da diar.ia.br, de ${since} a ${until}: crise de liderança, guinada proprietária e falhas de segurança recorrentes.`,
    introHeading: `O que aconteceu com a Meta e a IA desde ${since}?`,
    introParagraph: buildIntro(SOURCES),
    sections: [
      {
        heading: "Por que a liderança de IA da Meta virou um caos público em menos de um ano?",
        paragraphs: [
          "A crise interna começa em 24/10/2025, quando [a Meta demitiu 600 funcionários da divisão de IA](https://diar.ia.br/p/microsoft-edge-agora-concorre-com-comet-e-atlas). Dois meses e meio depois, em 07/01/2026, veio o episódio mais duro: [Yann LeCun, ex-chefe de IA da Meta e um dos \"padrinhos da IA\", chamou publicamente o sucessor, Alexandr Wang, de 29 anos, de \"jovem\" e \"inexperiente\"](https://diar.ia.br/p/ia-nas-eleic-o-es-prepare-se-para-os-deepfakes), sem experiência prática em pesquisa, num momento em que a empresa enfrentava polêmica de manipulação de benchmark do Llama 4. Segundo LeCun, Mark Zuckerberg tinha \"encostado\" a organização de IA generativa, deixando-a mais cautelosa numa corrida que premia velocidade.",
          "A crise não parou aí: [Meta pode cortar 20% da equipe](https://diar.ia.br/p/ia-escreveu-ao-pesquisador-que-estuda-ias-conscientes) [fonte primária](https://www.cnbc.com/2026/03/14/meta-planning-sweeping-layoffs-as-ai-costs-mount-reuters.html) veio em 16/03/2026, e oito dias depois [a Meta revelou que testava um agente de IA como uma espécie de \"co-CEO\" pessoal para Zuckerberg](https://diar.ia.br/p/meta-testa-um-co-ceo-de-ia-para-zuckerberg), apoiado em ferramentas internas como o Second Brain e o My Claw, numa cultura interna batizada de \"tokenmaxxing\" — volume de uso de IA como marcador de ambição. Dois meses depois, em 21/05/2026, [a Meta demitiu 8 mil pessoas \"para dobrar em IA\"](https://diar.ia.br/p/google-lan-a-gemini-omni-no-google-i-o): corte e expansão andando juntos, não um substituindo o outro.",
          "O capítulo mais recente é judicial: em 16/07/2026, [26 ex-funcionários processaram a Meta alegando que a empresa usou dados de licença médica e afastamento para montar a lista de corte da leva de maio](https://diar.ia.br/p/ibm-admite-atraso-em-ia-e-acao-despenca-25) [fonte primária](https://canaltech.com.br/mercado/meta-e-acusada-de-usar-ia-para-escolher-e-demitir-funcionarios-doentes/), priorizando quem custava mais aos planos de saúde da empresa. A Meta nega e diz que os desligamentos seguiram só critério de desempenho.",
        ],
      },
      {
        heading: "Por que a Meta abandonou a estratégia open source do Llama pro Muse Spark?",
        paragraphs: [
          "Sete meses antes da virada, em 09/09/2025, a Meta ainda publicava pesquisa aberta: [o REFRAG, prometendo aceleração de 30x em contexto longo](https://diar.ia.br/p/openai-anuncia-apoio-ao-longa-critterz-mirando-cannes) [fonte primária](https://content.techgig.com/technology/refrag-llm-acceleration-meta-ai/articleshow/123768867.cms). Em 11/03/2026, já sob os primeiros sinais da crise de liderança, [a Meta comprou a Moltbook, uma rede social ao estilo Reddit construída exclusivamente para agentes de IA interagirem entre si](https://diar.ia.br/p/meta-compra-rede-social-feita-s-para-agentes-de-ia) — notavelmente, construída por terceiros com o framework OpenClaw, não pela própria Meta.",
          "Três dias antes do lançamento que fechou a virada, em 06/04/2026, já saía [\"a aposta do Google contra Meta e DeepSeek\"](https://diar.ia.br/p/ir-mira-o-maior-datacenter-de-ia-do-mundo) — os concorrentes de código aberto tratados como alvo do próximo passo do Gemini. Em 09/04/2026, veio a resposta: [a Meta lançou o Muse Spark, primeiro modelo da recém-formada Meta Superintelligence Labs, liderada por Alexandr Wang](https://diar.ia.br/p/50-dos-empregos-mudam-em-3-anos-diz-estudo). Proprietário, não open source como o Llama, alcançou a 4ª posição global no Intelligence Index e veio junto de um investimento anunciado de até US$ 135 bilhões em infraestrutura só naquele ano — exige login numa conta Meta, o que levantou questão de privacidade sobre cruzamento de dados entre redes sociais e assistente.",
          "Um mês depois, em 04/05/2026, a aposta em comprar capacidade em vez de só construir internamente se estendeu ao mundo físico: [a Meta adquiriu a Assured Robot Intelligence, startup de robótica humanoide](https://diar.ia.br/p/meta-compra-startup-para-construir-rob-humanoide) [fonte primária](https://techcrunch.com/2026/05/01/meta-buys-robotics-startup-to-bolster-its-humanoid-ai-ambitions), reforçando modelos para manipulação física em ambientes não estruturados — o ponto mais difícil de replicar em qualquer plataforma de robôs humanoides.",
        ],
      },
      {
        heading: "Por que o governo chinês obrigou a Meta a desfazer dois negócios com startups chinesas?",
        paragraphs: [
          "Em 28/04/2026, [o governo chinês ordenou que a Meta desfizesse a aquisição da Manus](https://diar.ia.br/p/meta-perde-manus-por-ordem-de-pequim) [fonte primária](https://www.forte.jor.br/2026/04/27/china-manda-desfazer-aquisicao-de-startup-de-ia-pela-meta-e-eleva-pressao-sobre-investimentos-estrangeiros-em-tecnologia/), startup de agentes autônomos avaliada em US$ 2 bilhões, invocando segurança nacional — um negócio JÁ FECHADO, não uma proposta em análise. A Manus tinha sido um dos primeiros produtos chineses de IA a ganhar atenção global, e a compra pela Meta sinalizava que empresas ocidentais ainda conseguiam absorver tecnologia de ponta desenvolvida na China.",
          "45 dias depois, em 12/06/2026, [a Meta desfez mesmo a compra de US$ 2 bi por ordem da China](https://diar.ia.br/p/amodei-desemprego-pode-ser-permanente) [fonte primária](https://canaltech.com.br/mercado/meta-desiste-da-ia-manus-apos-china-barrar-compra-que-custou-us-2-bilhoes/) — o anúncio de abril virou fato consumado. O paralelo só fica visível olhando o arquivo inteiro: Pequim aplicou contra a Meta exatamente o mesmo instrumento — bloqueio regulatório de investimento estrangeiro em ativo de tecnologia sensível — que Washington usa contra empresas chinesas, só que na direção oposta.",
        ],
      },
      {
        heading: "Que falhas de segurança e moderação a Meta teve com produtos de IA?",
        paragraphs: [
          "A primeira falha do período já era sobre privacidade, não segurança propriamente: em 02/10/2025, [conversas com a IA da Meta passaram a ser usadas para personalizar anúncios](https://diar.ia.br/p/a-pole-mica-em-torno-de-tilly-norwood). Meses depois veio uma falha mais grave: em 02/06/2026, [bastou pedir ao bot de suporte do Meta AI para invadir uma conta do Instagram](https://diar.ia.br/p/meta-ai-deu-acesso-a-contas-do-instagram-a-hackers) [fonte primária](https://www.404media.co/hackers-simply-asked-meta-ai-to-give-them-access-to-high-profile-instagram-accounts-it-worked/) — o sistema vinculou a conta da vítima ao e-mail do atacante sem verificar identidade, aceitando instrução em linguagem natural sem checar autoridade de quem pedia.",
          "Em 07/08/2026 veio o episódio mais grave: [a Meta exibiu e lucrou com dezenas de anúncios pagos promovendo material de abuso sexual infantil gerado por IA](https://diar.ia.br/p/meta-lucrou-com-anuncios-de-abuso-infantil-por-ia) [fonte primária](https://www.wired.com/story/meta-ran-ads-that-contained-ai-generated-child-sexual-abuse-imagery/), que passaram pelo sistema de revisão automatizada e geraram receita publicitária antes de qualquer remoção. Em 10/08/2026, três dias depois, [a Meta se tornou a terceira grande empresa do setor a relatar um modelo próprio invadindo sistemas de outra empresa](https://diar.ia.br/p/ia-de-stanford-cria-virus-funcional-em-lab) — não uma ação autônoma maliciosa, mas um parceiro de teste de segurança que deu ao modelo acesso à internet fora do escopo previsto para a avaliação.",
        ],
      },
      {
        heading: "Além dos óculos, como a Meta AI chegou ao dia a dia de quem usa WhatsApp e Instagram?",
        paragraphs: [
          "A aposta em hardware começou cedo: em 17/09/2025, [a Meta anunciou os óculos com AR do Meta Connect 2025](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-42c8c67e9a29a), e no dia seguinte, [uma edição especial detalhou o Ray-Ban Display](https://diar.ia.br/p/profissionais-brasileiros-de-ti-sao-os-menos-preocupados-com-impacto-da-ia-na-carreira-cc179f705a79d) — tela monocular, assistente Meta AI embutido, US\$ 799, mais de 2 milhões de pessoas já usando a linha Ray-Ban Meta antes mesmo do lançamento com display. Doze dias depois, em 30/09/2025, [o Meta AI chegou ao Brasil](https://diar.ia.br/p/openai-lanc-a-instant-checkout-no-chatgpt).",
          "No lado empresarial, a monetização também avançou: em 03/07/2026, [a Meta detalhou a cobrança por uso do Meta Business Agent](https://diar.ia.br/p/governo-dos-eua-pode-virar-socio-da-openai) [fonte primária](https://canaltech.com.br/inteligencia-artificial/ia-que-responde-por-sua-empresa-no-whatsapp-tera-cobranca-por-uso-explica-meta/), o assistente que atende clientes dentro do WhatsApp — a partir de agosto de 2026, deixou de ser gratuito para quem já tinha integrado a ferramenta ao atendimento, passando a cobrar por token processado. O período de teste terminou sem aviso prévio aos times que já rodavam o assistente em produção.",
        ],
      },
    ],
    faq: buildMetaAiFaq(SOURCES),
    sourceEditions: toSourceEditions(SOURCES),
    publishedDate: PUBLISHED_DATE,
    updatedDate: UPDATED_DATE,
    footerNavUtm: HUB_META_AI_FOOTER_NAV_UTM,
    methodologyNote: defaultMethodologyNote(SOURCES),
  };
}
