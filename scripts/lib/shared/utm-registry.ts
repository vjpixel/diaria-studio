/**
 * scripts/lib/shared/utm-registry.ts (#4041)
 *
 * Registry declarativo ÚNICO dos UTMs que o projeto emite. Antes desta fatia
 * os literais (`newsletter`/`eia-arquivo`, `eia-standalone`/`jogar`, …) viviam
 * espalhados por 5+ arquivos, alguns duplicados de propósito (#3524) e sem
 * nenhuma superfície que respondesse "esse UTM ainda existe?" / "quanto ele
 * converteu?". A página `/utms` do Studio renderiza ESTE arquivo e cruza com o
 * que o Beehiiv/Brevo devolvem.
 *
 * **Fronteira `lib/shared/` (#2747, lint-enforced por `test/lib-boundary.test.ts`):**
 * este módulo é consumido por diária, mensal E Workers — não importa NADA de
 * `lib/diaria/` nem de `lib/mensal/`. Só tipos e literais puros aqui (zero I/O,
 * zero dependência de runtime Node) justamente pra poder ser espelhado dentro
 * do bundle do Worker (ver `workers/poll/src/utm-registry.ts`).
 *
 * **O registry é a fonte da verdade dos VALORES.** Os emissores importam daqui;
 * a UI só edita METADADOS (descrição/status) — nunca os valores, que sem uma
 * mudança correspondente no código do emissor sairiam do ar dessincronizados.
 */

/** Ciclo de vida de um emissor, do ponto de vista editorial. */
export type UtmEmitterStatus = "ativo" | "aposentado";

/**
 * Vocabulário FECHADO de posições de link da mensal (#4040). Slug estável e
 * sem acento — precisa comparar mês a mês, então renomear uma entrada aqui
 * quebra a série histórica (preferir adicionar).
 */
export const MENSAL_POSICOES = [
  "wordmark", // wordmark automático `diar.ia`/`diar.ia.br` — sufixado com a seção corrente
  "inline",   // link markdown `[texto](url)` no meio do parágrafo
  "cta",      // botão CTA `→ [texto](url)`
  "titulo",   // título de destaque linkado
  "pill",     // pill link (Radar / Use Melhor / Outras notícias)
] as const;

/** `utm_source` fixo de toda a superfície mensal (base da Clarice). */
export const MENSAL_UTM_SOURCE = "clarice";
/** `utm_medium` fixo de toda a superfície mensal. */
export const MENSAL_UTM_MEDIUM = "email";

/**
 * `utm_source`/`utm_medium` da variante BEEHIIV do digest mensal (#4482) —
 * envio EXTRA pra apoiadores Mantenedor/Patrono via Beehiiv (mesma
 * plataforma da diária), distinto do envio Clarice/Brevo acima. Nunca
 * reusar `MENSAL_UTM_SOURCE` ("clarice") nesta variante: os dois envios têm
 * audiência e plataforma diferentes, e misturar a atribuição refaria o
 * mesmo problema que o #2975 original corrigiu (só que na direção oposta —
 * cliques do canal Beehiiv contaminando a medição do canal Clarice).
 * Consumido por `CLARICE_UTM_PROFILE`/`draftToEmail(..., utmProfile)` em
 * `scripts/lib/mensal/monthly-render.ts` e `BEEHIIV_UTM_PROFILE` em
 * `scripts/lib/mensal/monthly-beehiiv-render.ts`.
 */
export const MENSAL_BEEHIIV_UTM_SOURCE = "mensal-beehiiv";
export const MENSAL_BEEHIIV_UTM_MEDIUM = "email";

/**
 * Slug de seção usado no sufixo do wordmark (`wordmark-{secao}`): minúsculo,
 * sem acento, `[a-z0-9-]`, ≤32 chars. Nunca lança — entrada vazia/ilegível cai
 * em `geral`, que mantém o funil mensurável em vez de emitir um campaign quebrado.
 *
 * @pure
 */
export function slugifySecao(raw: string | null | undefined): string {
  if (!raw) return "geral";
  const slug = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // tira acentos (combining marks do NFD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "geral";
}

/**
 * Compõe o `utm_campaign` da mensal: `clarice-{ciclo}-{posicao}` (#4040).
 *
 * O sufixo de posição nasce AQUI, no render — o A/B de CTA
 * (`scripts/clarice-cta-ab-setup.ts`) compõe o braço EM CIMA dele
 * (`-{posicao}-cta-{arm}`), nunca no lugar dele.
 *
 * @pure
 */
export function buildMensalCampaign(ciclo: string, posicao: string): string {
  const p = slugifySecao(posicao);
  return `${MENSAL_UTM_SOURCE}-${ciclo}-${p}`;
}

/**
 * Compõe o `utm_campaign` da variante Beehiiv do mensal (#4482):
 * `mensal-beehiiv-{ciclo}-{posicao}` — mesmo padrão de `buildMensalCampaign`,
 * `utm_source` distinto.
 *
 * @pure
 */
export function buildMensalBeehiivCampaign(ciclo: string, posicao: string): string {
  const p = slugifySecao(posicao);
  return `${MENSAL_BEEHIIV_UTM_SOURCE}-${ciclo}-${p}`;
}

// ---------------------------------------------------------------------------
// VALORES — fonte única. Todo emissor importa daqui; nenhum call site declara
// literal próprio. As entradas de `UTM_EMITTERS` abaixo DERIVAM destes valores
// (não os repetem), então inventário e emissão não têm como divergir.
// ---------------------------------------------------------------------------

/** `utm_source` de tudo que nasce no jogo standalone "É IA?" (#3518). */
export const EIA_STANDALONE_SOURCE = "eia-standalone";

/** Ponte e-mail diário → arquivo jogável no site (#3524). Duplicado de
 * propósito entre `newsletter-render-html.ts` e `workers/poll/src/lib.ts`. */
export const EIA_ARCHIVE_UTM = {
  source: "newsletter",
  medium: "email",
  campaign: "eia-arquivo",
} as const;

/** CTA de assinatura pós-voto do par único (#3518). */
export const JOGAR_POSVOTO_UTM = {
  source: EIA_STANDALONE_SOURCE,
  medium: "jogar",
  campaign: "eia-jogar-posvoto",
} as const;

/** CTA de assinatura no resultado do quiz relâmpago (#3579). */
export const QUIZ_POSVOTO_UTM = {
  source: EIA_STANDALONE_SOURCE,
  medium: "quiz",
  campaign: "eia-quiz-posvoto",
} as const;

/** Form de cadastro inline na própria página do jogo (#3580). */
export const JOGAR_INLINE_UTM = {
  source: EIA_STANDALONE_SOURCE,
  medium: "jogar-inline",
  campaign: "eia-jogar-inline-signup",
} as const;

/** Funil do embed em site parceiro (#3521) — `campaign` = slug do parceiro. */
export const EMBED_UTM = {
  source: "embed",
  medium: "widget",
  /** Slug default quando `?partner=` está ausente/inválido. */
  defaultPartner: "generico",
} as const;

/** Cartões de compartilhamento (#3978/#3679) — `medium` é dinâmico por canal. */
export const SHARE_UTM_CAMPAIGN = "eia-share";
export const QUIZ_SHARE_UTM_CAMPAIGN = "eia-quiz-share";

/** Cadastro inline nas páginas de livros (#4051) — medium por posição. */
export const LIVROS_INLINE_UTM = {
  source: "livros",
  campaign: "livros-inline-signup",
  hero: { medium: "inline-hero" },
  footer: { medium: "inline-footer" },
} as const;

/** Link "diar.ia.br" no rodapé de navegação cruzada da página de arquivo
 * (`workers/arquivo/src/render-archive.ts`, #4265 item 9) — só source+medium,
 * SEM `utm_campaign` (mesmo padrão do link footer-nav de livros em
 * `build-livros-page.ts:360`, que reusa o `utm_source` de `LIVROS_INLINE_UTM`
 * acima mas nunca ganhou entrada própria no registry — não mexido aqui, fora
 * do escopo do #4312, mas é o mesmo tipo de link). */
export const ARQUIVO_FOOTER_NAV_UTM = {
  source: "arquivo",
  medium: "footer-nav",
} as const;

/** Cadastro inline na tela de resultado do voto do brand clarice (#4065). */
export const VOTE_CLARICE_INLINE_UTM = {
  source: "clarice-email",
  medium: "vote-inline",
  campaign: "eia-vote-clarice-signup",
} as const;

/** Cadastro inline na tela de gate de `/jogar` (#4054) — visitante de fora
 * que cruza o nudge periódico de rodadas (#4253 item 3) e cadastra pra
 * entrar no ranking. UTM próprio (não o `eia-jogar-inline-signup` do #3580)
 * pra medir esta conversão separada do cadastro inline do fim de página do jogo. */
export const JOGAR_GATE_INLINE_UTM = {
  source: EIA_STANDALONE_SOURCE,
  medium: "jogar-gate",
  campaign: "eia-jogar-gate-signup",
} as const;

/** CTA de e-mail injetado em todo post de Facebook no publish (#3991, valor
 * UTM adicionado no #4295) — `injectChannelLine` monta a linha a partir daqui
 * via `scripts/lib/social-cta-lines.ts`. */
export const FACEBOOK_CTA_UTM = {
  source: "facebook",
  medium: "organic_social",
  campaign: "post-cta",
} as const;

/** `utm_campaign` compartilhado por X e Threads no CTA de `{edition_url}` da
 * seção `# Curto` (#4295) — mesmo texto/link, só `utm_source` difere por canal. */
const EDICAO_DIARIA_UTM_CAMPAIGN = "edicao-diaria";

/** X/Twitter — CTA de `{edition_url}` em `# Curto` (#4295, tag aplicada em
 * `scripts/prep-twitter-posts.ts` DEPOIS que `resolve-edition-url.ts` já
 * substituiu o placeholder pela URL base, sem UTM, em 03-social.md). */
export const TWITTER_EDITION_UTM = {
  source: "twitter",
  medium: "organic_social",
  campaign: EDICAO_DIARIA_UTM_CAMPAIGN,
} as const;

/** Threads — mesmo CTA/campanha do X acima, `utm_source` distinto (#4295,
 * tag aplicada em `scripts/publish-threads.ts`). */
export const THREADS_EDITION_UTM = {
  source: "threads",
  medium: "organic_social",
  campaign: EDICAO_DIARIA_UTM_CAMPAIGN,
} as const;

/** LinkedIn — CTA de `{edition_url}` no `## post_pixel` (post pessoal do
 * Pixel, #1690) — distinto do post principal do LinkedIn, que não leva
 * link/UTM no corpo por decisão preservada em #595/#3627 (ver
 * `LINKEDIN_CTA_LINE = null` acima). Tag aplicada em
 * `scripts/resolve-post-pixel.ts` (#4295). */
export const LINKEDIN_POST_PIXEL_UTM = {
  source: "linkedin",
  medium: "organic_social",
  campaign: "post-pixel",
} as const;

/** Rodapé de navegação cruzada da página de Cursos (#4295) — mesmo padrão de
 * `ARQUIVO_FOOTER_NAV_UTM`/`LIVROS_INLINE_UTM` (só source+medium, sem
 * campaign de verdade — link de nav, não funil de conversão). Cursos ficou
 * de fora quando Livros ganhou o parâmetro em #4051 — assimetria pura, não
 * decisão editorial (issue #4295). */
export const CURSOS_FOOTER_NAV_UTM = {
  source: "cursos",
  medium: "footer-nav",
} as const;

/** Cadastro no gate inline do worker `cursos` (`workers/cursos/src/subscribe.ts`,
 * #4052) — fold-in do drift pré-existente apontado pelo #4295: o worker já
 * emitia este triplo com literais locais, ausente do registry/`/utms`. Move
 * pra cá sem mudar o valor emitido (mesmo `source`/`medium`/`campaign`). */
export const CURSOS_GATE_INLINE_UTM = {
  source: "cursos",
  medium: "gate-inline",
  campaign: "cursos-gate-signup",
} as const;

/** Opt-in de newsletter embutido no form de IDENTIDADE (#3975 — nome/e-mail
 * pra entrar no leaderboard, `renderIdentityFormBlock`/`identityFormScript`
 * em `workers/poll/src/jogar.ts`, `POST /jogar/identify`). #4125 (item 4):
 * antes deste UTM, `identify.ts` chamava `subscribeToBeehiiv` sem 4º
 * argumento e caía no default `JOGAR_INLINE_UTM` — colidindo com o form
 * standalone do #3580 (que só sobrevive em `/jogar/quiz` desde o #3975
 * substituir sua contraparte em `/jogar`/sequência por ESTE form de
 * identidade), tornando as duas conversões indistinguíveis na atribuição. */
export const JOGAR_IDENTIFY_INLINE_UTM = {
  source: EIA_STANDALONE_SOURCE,
  medium: "jogar-identify",
  campaign: "eia-jogar-identify-signup",
} as const;

/** Bloco encaminhável por WhatsApp no fim de cada edição diária (#4486) —
 * `utm_campaign` traz o AAMMDD da edição que gerou o encaminhamento (o
 * Beehiiv grava a UTM no momento da inscrição, então dá pra atribuir
 * assinante novo à edição específica). Fonte dos valores:
 * `scripts/lib/newsletter-render-html.ts::buildWhatsappSubscribeUrl`. */
export const WHATSAPP_SHARE_UTM = {
  source: "whatsapp",
  medium: "share",
  campaignPattern: "{edition}",
} as const;

/** Newsletter semanal do LinkedIn (#4456) — `utm_campaign` traz o ciclo `{YY}w{WW}`
 * (ex: `ln-26w31`), `utm_content` varia por posição (`mencao-abertura`/`cta-abertura`/
 * `lista`/`cta-usemelhor`/`cta-fim` — `item-01`/`02`/`03` SAÍRAM quando o link por
 * destaque foi removido, comentário 260802 3º do #4456; `cta-abertura` e
 * `mencao-abertura` ENTRARAM em 260803, o 1º com o 3º CTA de assinatura, o 2º ao
 * descobrir ao vivo que o LinkedIn auto-linka o wordmark em prosa pra home CRUA
 * e come a UTM — pré-linkar com âncora estendida além do domínio recupera esse
 * clique, ver `linkifyWordmark`).
 * Fonte dos valores: `scripts/lib/weekly-linkedin-render.ts`. */
export const LINKEDIN_WEEKLY_UTM = {
  source: "linkedin",
  medium: "newsletter",
  campaignPattern: "ln-{cycle}",
} as const;

/** Uma entrada do inventário: um ponto do código que emite UTM. */
export interface UtmEmitter {
  /** Identificador estável — chave de join com os metadados editáveis da UI. */
  id: string;
  /** Rótulo humano curto (aparece na tabela do Studio). */
  label: string;
  /** `utm_source` literal emitido. */
  source: string;
  /** `utm_medium` literal, ou o padrão quando é dinâmico (ex: `{medium}`). */
  medium: string;
  /**
   * Padrão do `utm_campaign`. Placeholders entre chaves marcam a parte
   * dinâmica: `{ciclo}`, `{posicao}`, `{partner}`, `{arm}`.
   */
  campaignPattern: string;
  /** Arquivo (path relativo à raiz do repo) onde o UTM é montado. */
  originFile: string;
  /** Descrição humana da POSIÇÃO do link — onde o leitor clica. */
  description: string;
  /** Status editorial default (a UI pode sobrescrever via metadados). */
  status: UtmEmitterStatus;
}

/**
 * Inventário completo (levantado no #4041, atualizado no #4040/#4059).
 *
 * Regra de manutenção: emissor novo entra AQUI e importa daqui — nunca um
 * literal solto no call site. `test/utm-registry.test.ts` trava a coerência
 * entre este arquivo e os valores realmente exportados pelos emissores.
 */
export const UTM_EMITTERS: readonly UtmEmitter[] = [
  {
    id: "mensal-clarice",
    label: "Digest mensal (Clarice)",
    source: MENSAL_UTM_SOURCE,
    medium: MENSAL_UTM_MEDIUM,
    campaignPattern: `${MENSAL_UTM_SOURCE}-{ciclo}-{posicao}`,
    originFile: "scripts/lib/mensal/monthly-render.ts",
    description:
      "Todo link pro host de marca no e-mail mensal enviado pela Brevo. " +
      `O sufixo {posicao} vem do vocabulário fechado ${MENSAL_POSICOES.join(" / ")} ` +
      "— `wordmark` ainda ganha a seção corrente como sufixo (#4040).",
    status: "ativo",
  },
  {
    id: "mensal-beehiiv",
    label: "Digest mensal (Beehiiv, apoiadores)",
    source: MENSAL_BEEHIIV_UTM_SOURCE,
    medium: MENSAL_BEEHIIV_UTM_MEDIUM,
    campaignPattern: `${MENSAL_BEEHIIV_UTM_SOURCE}-{ciclo}-{posicao}`,
    originFile: "scripts/lib/mensal/monthly-beehiiv-render.ts",
    description:
      "Envio EXTRA do digest mensal pra apoiadores Mantenedor/Patrono via Beehiiv (#4482) — " +
      "mesmo conteúdo/posições da entrada 'mensal-clarice' acima, `utm_source` distinto pra " +
      "não misturar a atribuição dos 2 canais (audiência e plataforma diferentes).",
    status: "ativo",
  },
  {
    id: "eia-arquivo-newsletter",
    label: "É IA? — arquivo (e-mail diário)",
    source: EIA_ARCHIVE_UTM.source,
    medium: EIA_ARCHIVE_UTM.medium,
    campaignPattern: EIA_ARCHIVE_UTM.campaign,
    originFile: "scripts/lib/newsletter-render-html.ts",
    description: "Ponte e-mail diário → arquivo jogável do 'É IA?' no site (#3524).",
    status: "ativo",
  },
  {
    id: "eia-arquivo-worker",
    label: "É IA? — arquivo (Worker)",
    source: EIA_ARCHIVE_UTM.source,
    medium: EIA_ARCHIVE_UTM.medium,
    campaignPattern: EIA_ARCHIVE_UTM.campaign,
    originFile: "workers/poll/src/lib.ts",
    description:
      "Duplicata DELIBERADA da entrada acima (#3524): o Worker precisa do mesmo " +
      "triplo pra manter a coerência do funil e não pode importar o render do e-mail.",
    status: "ativo",
  },
  {
    id: "eia-jogar-posvoto",
    label: "É IA? — CTA pós-voto",
    source: JOGAR_POSVOTO_UTM.source,
    medium: JOGAR_POSVOTO_UTM.medium,
    campaignPattern: JOGAR_POSVOTO_UTM.campaign,
    originFile: "workers/poll/src/jogar.ts",
    description: "Botão 'Assinar a diar.ia.br' do CTA pós-voto do jogo standalone (#3518).",
    status: "ativo",
  },
  {
    id: "eia-quiz-posvoto",
    label: "É IA? — CTA do quiz relâmpago",
    source: QUIZ_POSVOTO_UTM.source,
    medium: QUIZ_POSVOTO_UTM.medium,
    campaignPattern: QUIZ_POSVOTO_UTM.campaign,
    originFile: "workers/poll/src/jogar.ts",
    description: "CTA de assinatura no resultado final do quiz relâmpago (#3579).",
    status: "ativo",
  },
  {
    id: "eia-jogar-inline",
    label: "É IA? — cadastro inline (quiz)",
    source: JOGAR_INLINE_UTM.source,
    medium: JOGAR_INLINE_UTM.medium,
    campaignPattern: JOGAR_INLINE_UTM.campaign,
    originFile: "workers/poll/src/subscribe.ts",
    description:
      "Form de cadastro standalone do #3580 (`renderInlineSignupFormBlock`/" +
      "`inlineSignupScript`) — hoje só em `/jogar/quiz`; `/jogar` e a sequência " +
      "usam o form de IDENTIDADE (#3975, ver `jogar-identify-inline` abaixo) desde " +
      "que o #4125 (item 4) parou de deixar as duas conversões colidirem no default.",
    status: "ativo",
  },
  {
    id: "jogar-identify-inline",
    label: "É IA? — cadastro via form de identidade",
    source: JOGAR_IDENTIFY_INLINE_UTM.source,
    medium: JOGAR_IDENTIFY_INLINE_UTM.medium,
    campaignPattern: JOGAR_IDENTIFY_INLINE_UTM.campaign,
    originFile: "workers/poll/src/identify.ts",
    description:
      "Opt-in de newsletter embutido no form de identidade (#3975, nome+e-mail pra " +
      "entrar no leaderboard) de `/jogar` e da sequência — UTM próprio desde o #4125 " +
      "(item 4), antes colidia com `eia-jogar-inline` (form standalone do #3580).",
    status: "ativo",
  },
  {
    id: "vote-clarice-inline",
    label: "Voto (brand clarice) — cadastro inline",
    source: VOTE_CLARICE_INLINE_UTM.source,
    medium: VOTE_CLARICE_INLINE_UTM.medium,
    campaignPattern: VOTE_CLARICE_INLINE_UTM.campaign,
    originFile: "workers/poll/src/subscribe.ts",
    description:
      "Cadastro na tela de resultado do voto em /vote?brand=clarice (#4065) — " +
      "utm_source próprio pra não poluir o funil web com conversões vindas do e-mail mensal.",
    status: "ativo",
  },
  {
    id: "jogar-gate-inline",
    label: "É IA? — cadastro na tela de gate",
    source: JOGAR_GATE_INLINE_UTM.source,
    medium: JOGAR_GATE_INLINE_UTM.medium,
    campaignPattern: JOGAR_GATE_INLINE_UTM.campaign,
    originFile: "workers/poll/src/web-gate.ts",
    description:
      "Cadastro na tela de gate de /jogar (#4054) — visitante de fora que " +
      "cruzou o nudge periódico de rodadas (#4253 item 3) e se identifica/cadastra.",
    status: "ativo",
  },
  {
    id: "livros-inline-hero",
    label: "Livros — cadastro inline (hero)",
    source: LIVROS_INLINE_UTM.source,
    medium: LIVROS_INLINE_UTM.hero.medium,
    campaignPattern: LIVROS_INLINE_UTM.campaign,
    originFile: "workers/poll/src/subscribe.ts",
    description: "CTA de cadastro no topo de livros.diar.ia.br (#4051).",
    status: "ativo",
  },
  {
    id: "livros-inline-footer",
    label: "Livros — cadastro inline (fim da lista)",
    source: LIVROS_INLINE_UTM.source,
    medium: LIVROS_INLINE_UTM.footer.medium,
    campaignPattern: LIVROS_INLINE_UTM.campaign,
    originFile: "workers/poll/src/subscribe.ts",
    description: "CTA de cadastro no fim da lista de cards de livros.diar.ia.br (#4051).",
    status: "ativo",
  },
  {
    id: "arquivo-footer-nav",
    label: "Arquivo — link de rodapé pra diar.ia.br",
    source: ARQUIVO_FOOTER_NAV_UTM.source,
    medium: ARQUIVO_FOOTER_NAV_UTM.medium,
    // #4312: sem utm_campaign de verdade (link de nav, só source+medium) —
    // padrão-placeholder que nunca casa contra dado real, só pra satisfazer o
    // schema (campaignPattern não-vazio, `test/utm-registry-4041.test.ts`).
    campaignPattern: "arquivo-footer-nav",
    originFile: "workers/arquivo/src/render-archive.ts",
    description:
      'Link "diar.ia.br" no rodapé de navegação cruzada da página de arquivo — ' +
      "sem utm_campaign, só source+medium (#4265 item 9, gap fechado no #4312).",
    status: "ativo",
  },
  {
    id: "embed-widget",
    label: "Embed do jogo (parceiros)",
    source: EMBED_UTM.source,
    medium: EMBED_UTM.medium,
    campaignPattern: "{partner}",
    originFile: "workers/poll/src/embed.ts",
    description:
      "CTA do widget embutido em site parceiro — `utm_campaign` = slug do parceiro " +
      `(\`${EMBED_UTM.defaultPartner}\` quando \`?partner=\` está ausente/inválido) (#3521).`,
    status: "ativo",
  },
  {
    id: "share-eia",
    label: "Compartilhamento do 'É IA?'",
    source: EIA_STANDALONE_SOURCE,
    medium: "{medium}",
    campaignPattern: SHARE_UTM_CAMPAIGN,
    originFile: "workers/poll/src/share.ts",
    description:
      "Cartão de compartilhamento do resultado — `utm_medium` dinâmico por canal " +
      "(social / whatsapp / copy / link) (#3978/#3679).",
    status: "ativo",
  },
  {
    id: "share-quiz",
    label: "Compartilhamento do quiz",
    source: EIA_STANDALONE_SOURCE,
    medium: "{medium}",
    campaignPattern: QUIZ_SHARE_UTM_CAMPAIGN,
    originFile: "workers/poll/src/share.ts",
    description: "Cartão de compartilhamento do quiz relâmpago / sequência mensal (#3978).",
    status: "ativo",
  },
  {
    id: "facebook-post-cta",
    label: "Facebook — CTA de e-mail em todo post",
    source: FACEBOOK_CTA_UTM.source,
    medium: FACEBOOK_CTA_UTM.medium,
    campaignPattern: FACEBOOK_CTA_UTM.campaign,
    originFile: "scripts/lib/social-cta-lines.ts",
    description:
      "Linha de CTA (e-mail + link) injetada em TODO post de Facebook no publish " +
      "(~3 posts/dia) — antes sem UTM, virava `direct` no Beehiiv (#4295).",
    status: "ativo",
  },
  {
    id: "twitter-edicao",
    label: "X — CTA da edição em '# Curto'",
    source: TWITTER_EDITION_UTM.source,
    medium: TWITTER_EDITION_UTM.medium,
    campaignPattern: TWITTER_EDITION_UTM.campaign,
    originFile: "scripts/prep-twitter-posts.ts",
    description:
      "`{edition_url}` do texto curto compartilhado X/Threads — tag aplicada por " +
      "canal no publish, depois que resolve-edition-url.ts já gravou a URL base " +
      "sem UTM em 03-social.md (#4295).",
    status: "ativo",
  },
  {
    id: "threads-edicao",
    label: "Threads — CTA da edição em '# Curto'",
    source: THREADS_EDITION_UTM.source,
    medium: THREADS_EDITION_UTM.medium,
    campaignPattern: THREADS_EDITION_UTM.campaign,
    originFile: "scripts/publish-threads.ts",
    description: "Mesmo CTA do X acima (twitter-edicao) — só `utm_source` distinto (#4295).",
    status: "ativo",
  },
  {
    id: "linkedin-post-pixel",
    label: "LinkedIn — CTA do post pessoal (post_pixel)",
    source: LINKEDIN_POST_PIXEL_UTM.source,
    medium: LINKEDIN_POST_PIXEL_UTM.medium,
    campaignPattern: LINKEDIN_POST_PIXEL_UTM.campaign,
    originFile: "scripts/resolve-post-pixel.ts",
    description:
      "`{edition_url}` do `## post_pixel` (post pessoal do Pixel, #1690) — " +
      "publicado 100% manual (Claude in Chrome), tag aplicada na resolução que " +
      "alimenta o copy-paste do editor (#4295). Distinto do post PRINCIPAL do " +
      "LinkedIn, que não leva link no corpo (#595/#3627, ver LINKEDIN_CTA_LINE).",
    status: "ativo",
  },
  {
    id: "cursos-footer-nav",
    label: "Cursos — link de rodapé pra diar.ia.br",
    source: CURSOS_FOOTER_NAV_UTM.source,
    medium: CURSOS_FOOTER_NAV_UTM.medium,
    campaignPattern: "cursos-footer-nav",
    originFile: "scripts/build-cursos-page.ts",
    description:
      'Link "diar.ia.br" no rodapé de navegação cruzada da página de Cursos — ' +
      "faltava o 2º parâmetro de renderCuradoriaFooter que Livros já tinha desde " +
      "#4051 (assimetria pura, fechada no #4295). Sem utm_campaign de verdade " +
      "(mesmo padrão de arquivo-footer-nav), placeholder só pra satisfazer o schema.",
    status: "ativo",
  },
  {
    id: "cursos-gate-inline",
    label: "Cursos — cadastro no gate inline",
    source: CURSOS_GATE_INLINE_UTM.source,
    medium: CURSOS_GATE_INLINE_UTM.medium,
    campaignPattern: CURSOS_GATE_INLINE_UTM.campaign,
    originFile: "workers/cursos/src/subscribe.ts",
    description:
      "Cadastro no banner de gate inline da página de Cursos (#4052) — fold-in " +
      "do drift pré-existente apontado pelo #4295 (literais locais, ausente do " +
      "registry/`/utms` antes desta entry).",
    status: "ativo",
  },
  {
    id: "whatsapp-share-block",
    label: "Bloco encaminhável por WhatsApp (e-mail diário)",
    source: WHATSAPP_SHARE_UTM.source,
    medium: WHATSAPP_SHARE_UTM.medium,
    campaignPattern: WHATSAPP_SHARE_UTM.campaignPattern,
    originFile: "scripts/lib/newsletter-render-html.ts",
    description:
      "Link de assinatura dentro do bloco fixo pré-'Para encerrar', pensado " +
      "pra colar/encaminhar no WhatsApp (#4486) — utm_campaign = AAMMDD da " +
      "edição que gerou o encaminhamento.",
    status: "ativo",
  },
  {
    id: "linkedin-weekly-newsletter",
    label: "LinkedIn — newsletter semanal",
    source: LINKEDIN_WEEKLY_UTM.source,
    medium: LINKEDIN_WEEKLY_UTM.medium,
    campaignPattern: LINKEDIN_WEEKLY_UTM.campaignPattern,
    originFile: "scripts/lib/weekly-linkedin-render.ts",
    description:
      "Lista de Edições da semana + os 3 CTAs de assinatura (abertura/meio/fim) da " +
      "newsletter semanal do LinkedIn (`/diaria-linkedin-semanal`, #4456) — artigo " +
      "colável manualmente, sem API de publicação. `utm_content` = " +
      "mencao-abertura/cta-abertura/lista/cta-usemelhor/cta-fim, um por posição, para " +
      "dar pra medir qual terço da peça converte. `mencao-abertura` não é CTA: é o " +
      "clique no nome da marca em prosa, separado pra não inflar o CTA da abertura.",
    status: "ativo",
  },
] as const;

/** Busca uma entrada do inventário por id. `undefined` se não existe. @pure */
export function findUtmEmitter(id: string): UtmEmitter | undefined {
  return UTM_EMITTERS.find((e) => e.id === id);
}

// ---------------------------------------------------------------------------
// SUPERFÍCIES EXTERNAS (#4525) — o link não nasce de código, nasce de um campo
// de perfil que uma pessoa preenche no painel da plataforma.
// ---------------------------------------------------------------------------

/**
 * `utm_medium` de toda superfície externa. Existe pra separar o link PARADO no
 * perfil (permanente) do CTA do post do dia, que usa `organic_social` com o
 * MESMO `utm_source` — sem essa distinção as duas conversões colapsam na mesma
 * linha do `/utms`, que é a classe de erro do #4125 item 4.
 */
export const EXTERNAL_SURFACE_MEDIUM = "bio";

/**
 * Prefixo do `utm_campaign` das superfícies externas. O valor final é
 * `perfil-{source}` — **um por superfície**, via `buildExternalSurfaceCampaign`.
 *
 * A 1ª versão desta fatia usava um `utm_campaign` ÚNICO (`perfil`) pras cinco,
 * argumentando que a pergunta respondida é a mesma em todas. Estava errado, e
 * de um jeito silencioso: o drift de superfície externa é checado por campaign
 * (ver `computeDrift`), e o Beehiiv só devolve duas agregações PLANAS —
 * `counts` por `utm_source` e `campaignCounts` por `utm_campaign`, sem
 * dimensão de `utm_medium` e sem cruzamento (`aggregateByUtmSource` /
 * `aggregateByUtmCampaign` em `scripts/count-subscriptions-by-utm.ts`). Com o
 * campaign compartilhado, bastava UMA das cinco converter pra que
 * `campaignCounts["perfil"] > 0` mascarasse as outras quatro pra sempre — um
 * link de bio que a plataforma quebrasse depois de aplicado nunca mais seria
 * flagrado. Achado no review do PR #4526.
 *
 * O `utm_source` sozinho também não resolve: `facebook`/`twitter`/`threads` são
 * compartilhados com o CTA dos posts (`FACEBOOK_CTA_UTM`, `TWITTER_EDITION_UTM`,
 * `THREADS_EDITION_UTM`), então o sinal por source vem positivo pelo tráfego do
 * post mesmo com a bio morta. Sobra o campaign — daí a redundância aparente
 * entre `utm_source=instagram` e `utm_campaign=perfil-instagram` ser deliberada,
 * não descuido.
 */
export const EXTERNAL_SURFACE_CAMPAIGN_PREFIX = "perfil";

/**
 * `utm_campaign` de uma superfície externa: `perfil-{source}[-{variant}]`.
 * Derivado, nunca digitado — é o que garante a unicidade de que o drift depende.
 *
 * `variant` existe pra quando a MESMA plataforma hospeda mais de uma superfície
 * (os dois repositórios no GitHub; o perfil da marca e o pessoal no Instagram).
 * Sem ele, essas superfícies voltariam a compartilhar campaign e a primeira a
 * converter mascararia as outras — o bug que o review do PR #4526 pegou.
 *
 * @pure
 */
export function buildExternalSurfaceCampaign(source: string, variant?: string): string {
  const base = `${EXTERNAL_SURFACE_CAMPAIGN_PREFIX}-${source.toLowerCase()}`;
  return variant ? `${base}-${variant.toLowerCase()}` : base;
}

/** URL base que toda superfície externa aponta. */
export const EXTERNAL_SURFACE_BASE_URL = "https://diar.ia.br/";

/**
 * Uma superfície EXTERNA: campo de bio/site num painel de terceiro, preenchido
 * à mão. Deliberadamente NÃO é um `UtmEmitter` — aquele tipo exige
 * `originFile` (path do repo, travado por `test/utm-registry-4041.test.ts`), e
 * aqui não existe arquivo de origem. Forçar a entrada lá faria o inventário
 * mentir sobre onde o valor nasce.
 */
export interface ExternalUtmSurface {
  /** Identificador estável — mesma função do `id` de `UtmEmitter`. */
  id: string;
  /** Rótulo humano curto. */
  label: string;
  /** `utm_source` — nome NU da plataforma (ver nota de `instagram-diaria` abaixo). */
  source: string;
  /** `utm_medium` — sempre `EXTERNAL_SURFACE_MEDIUM`. */
  medium: string;
  /** `utm_campaign` — `perfil-{source}`, sempre via `buildExternalSurfaceCampaign`.
   * ÚNICO por superfície: é a única dimensão que o Beehiiv devolve capaz de
   * isolar esta bio (ver o comentário de `EXTERNAL_SURFACE_CAMPAIGN_PREFIX`). */
  campaign: string;
  /** URL do painel onde ESTE campo se edita (o runbook da Fase 3/reconferência). */
  panelUrl: string;
  /** Onde exatamente no painel — o campo tem nome diferente em cada plataforma. */
  field: string;
  /** Descrição da posição do link do ponto de vista do leitor. */
  description: string;
  status: UtmEmitterStatus;
  /**
   * Data (YYYY-MM-DD) em que o valor foi de fato aplicado no painel. AUSENTE =
   * declarado aqui mas ainda não aplicado ao vivo — e nesse estado a ausência
   * de conversão é ESPERADA, não drift (ver `computeDrift`).
   */
  appliedAt?: string;
  /**
   * Qual dimensão o drift observa. `campaign` (default) é a correta em quase
   * tudo: isola esta superfície mesmo quando o `utm_source` é compartilhado com
   * o CTA dos posts.
   *
   * `source` existe pra plataforma que TRUNCA a URL e só deixa passar um
   * parâmetro (Apoia.se). Só é legítimo quando o `utm_source` é EXCLUSIVO desta
   * superfície — se fosse compartilhado, o check viria positivo pelo tráfego
   * alheio e não mediria nada. `test/utm-externas-4525.test.ts` trava essa
   * exclusividade.
   */
  driftKey?: "campaign" | "source";
}

/**
 * Inventário das superfícies externas (varredura ao vivo de 260803, #4525).
 *
 * Antes desta lista, as 5 estavam invisíveis pro `/utms` e para o detector de
 * drift — e a varredura achou três convenções incompatíveis vivas ao mesmo
 * tempo: `utm_source=instagram-diaria`/`facebook-diaria` (sufixo que fatia o
 * mesmo canal em duas linhas que nunca somam), `utm_campaign=lancamento-2607`
 * (campanha encerrada em ago/2026, atribuindo cadastro novo a ela pra sempre) e
 * `utm_campaign=profile` só no X. A unificação aqui é o que torna as 5
 * comparáveis entre si e contra os emissores de código.
 */
export const EXTERNAL_UTM_SURFACES: readonly ExternalUtmSurface[] = [
  {
    id: "perfil-instagram",
    label: "Instagram — link da bio",
    source: "instagram",
    medium: EXTERNAL_SURFACE_MEDIUM,
    campaign: buildExternalSurfaceCampaign("instagram"),
    panelUrl: "https://www.instagram.com/diar.ia.br",
    field: "app mobile → Editar perfil → Site (NÃO editável na web)",
    description:
      "Link da bio do perfil — a única saída clicável do Instagram, onde o app " +
      "suprime o Referer. Substitui `instagram-diaria`/`lancamento-2607` (#4525). " +
      "BLOQUEADO na web: o campo Website de `instagram.com/accounts/edit/` vem " +
      "desabilitado com o aviso 'Editing your links is only available on mobile' " +
      "(verificado ao vivo em 260803) — só o editor aplica, pelo app, e foi assim " +
      "que entrou. Conferido pelo href da bio depois.",
    status: "ativo",
    appliedAt: "2026-08-03",
  },
  {
    id: "perfil-facebook",
    label: "Facebook — campo Site da página",
    source: "facebook",
    medium: EXTERNAL_SURFACE_MEDIUM,
    campaign: buildExternalSurfaceCampaign("facebook"),
    panelUrl: "https://www.facebook.com/diar.ia.br",
    field: "Trocar agora (identidade → Página) → Sobre → Links",
    description:
      "Campo Site da página, exibido na seção Links do perfil. O #4295 supunha " +
      "vazio; a varredura do #4525 achou preenchido com `facebook-diaria`/" +
      "`lancamento-2607`. Editar exige TROCAR a identidade da sessão pra Página " +
      "— pelo perfil pessoal a seção Links é read-only.",
    status: "ativo",
    appliedAt: "2026-08-03",
  },
  {
    id: "perfil-threads",
    label: "Threads — link da bio",
    source: "threads",
    medium: EXTERNAL_SURFACE_MEDIUM,
    campaign: buildExternalSurfaceCampaign("threads"),
    panelUrl: "https://www.threads.com/@diar.ia.br",
    field: "Edit profile → Links → Add link",
    description:
      "Único link clicável do perfil do Threads. Estava VAZIO na varredura do " +
      "#4525 — aqui a ação não foi taggear, foi criar. O Threads ACRESCENTA " +
      "`utm_content=link_in_bio` + um `utm_id` próprio ao redirecionar; os 3 " +
      "parâmetros nossos sobrevivem intactos (verificado ao vivo).",
    status: "ativo",
    appliedAt: "2026-08-03",
  },
  {
    id: "perfil-twitter",
    label: "X — campo Website do perfil",
    source: "twitter",
    medium: EXTERNAL_SURFACE_MEDIUM,
    campaign: buildExternalSurfaceCampaign("twitter"),
    panelUrl: "https://x.com/settings/profile",
    field: "Edit profile → Website",
    description:
      "Campo Website do perfil. Já tinha UTM antes do #4525 " +
      "(`medium=social`/`campaign=profile`) — normalizado pra convenção única; " +
      "a série perdida tinha 4 seguidores de audiência.",
    status: "ativo",
    appliedAt: "2026-08-03",
  },
  {
    id: "perfil-apoiase",
    label: "Apoia.se — site da campanha",
    source: "apoiase",
    medium: EXTERNAL_SURFACE_MEDIUM,
    campaign: buildExternalSurfaceCampaign("apoiase"),
    panelUrl: "https://apoia.se/diaria",
    field: "Editar campanha → Identificação → Redes sociais → 1º campo",
    description:
      "Ícone de globo da seção 'Redes Sociais' da página de apoio — era " +
      "`https://diar.ia.br` cru (#4525). Único `utm_source` novo do lote, e " +
      "portanto o que exigia a união em `knownUtmSources()`. A plataforma TRUNCA " +
      "no `&`: a URL de 3 parâmetros é descartada em silêncio (o link some da " +
      "página em vez de dar erro), mas `?utm_source=apoiase` sozinho salva e " +
      "persiste. Por isso `driftKey: 'source'` — só o `utm_source` chega, e ele " +
      "é exclusivo desta superfície, então mede sozinho. Valor ao vivo: " +
      "`https://diar.ia.br/?utm_source=apoiase`.",
    status: "ativo",
    appliedAt: "2026-08-03",
    driftKey: "source",
  },
  {
    id: "perfil-linkedin",
    label: "LinkedIn — CTA e site da company page",
    source: "linkedin",
    // EXCEÇÃO DELIBERADA à convenção `bio`/`perfil-{source}`: esta superfície já
    // estava taggeada antes de a convenção existir (é dela que o #4295 tirou o
    // padrão), o LinkedIn é canal com conversão real, e o `campaign` já é único.
    // Renomear só custaria a série histórica sem ganhar medição nenhuma. O
    // `medium` fora de `EXTERNAL_SURFACE_MEDIUM` é o marcador visível de que a
    // entrada é exceção — `test/utm-externas-4525.test.ts` só cobra derivação de
    // campaign das superfícies que usam o medium da convenção.
    medium: "organic_social",
    campaign: "company_page_cta",
    panelUrl: "https://www.linkedin.com/company/110742958/admin/dashboard/",
    field: "Editar página → Botão personalizado + Site",
    description:
      "O MESMO valor cobre dois pontos da company page: o botão de CTA ('Sign " +
      "up') e o campo Site da aba Sobre — confirmado ao vivo em 260803, os dois " +
      "hrefs idênticos. Não foi tocado nesta rodada: já estava correto.",
    status: "ativo",
    appliedAt: "2026-07-31",
  },
  {
    id: "perfil-youtube",
    label: "YouTube — link do canal",
    source: "youtube",
    medium: EXTERNAL_SURFACE_MEDIUM,
    campaign: buildExternalSurfaceCampaign("youtube"),
    panelUrl: "https://studio.youtube.com",
    field: "Personalização → Perfil → Links → URL",
    description:
      "Link 'Newsletter' do cabeçalho do canal e da aba Sobre. Apontava pro " +
      "domínio ANTIGO (`diaria.beehiiv.com`) até 260803 — a varredura do #4059 " +
      "cobriu o repo, não superfície de plataforma. Salvar exige blur do campo " +
      "antes do Publicar, senão o botão fica inerte e a edição se perde.",
    status: "ativo",
    appliedAt: "2026-08-03",
  },
  {
    id: "perfil-github-studio",
    label: "GitHub — repo diaria-studio",
    source: "github",
    medium: EXTERNAL_SURFACE_MEDIUM,
    campaign: buildExternalSurfaceCampaign("github", "studio"),
    panelUrl: "https://github.com/vjpixel/diaria-studio",
    field: "gh repo edit --homepage (ou Settings → Website)",
    description:
      "Campo Website do repositório público, exibido no topo da sidebar. Estava " +
      "VAZIO (#4525). Aplicável por CLI — não precisa de browser.",
    status: "ativo",
    appliedAt: "2026-08-03",
  },
  {
    id: "perfil-github-design",
    label: "GitHub — repo diaria-design",
    source: "github",
    medium: EXTERNAL_SURFACE_MEDIUM,
    campaign: buildExternalSurfaceCampaign("github", "design"),
    panelUrl: "https://github.com/vjpixel/diaria-design",
    field: "gh repo edit --homepage (ou Settings → Website)",
    description:
      "Idem `perfil-github-studio`, outro repositório. Os dois compartilham " +
      "`utm_source=github`, e é o sufixo de variante do `utm_campaign` que os " +
      "mantém mensuráveis em separado.",
    status: "ativo",
    appliedAt: "2026-08-03",
  },
] as const;

/** Busca uma superfície externa por id. `undefined` se não existe. @pure */
export function findExternalUtmSurface(id: string): ExternalUtmSurface | undefined {
  return EXTERNAL_UTM_SURFACES.find((s) => s.id === id);
}

/**
 * Monta a URL exata a colar no painel da plataforma. `new URL` +
 * `searchParams.set` (nunca concatenação) pela mesma razão documentada em
 * `buildBrandSiteUrl` (`workers/poll/src/lib.ts`) e exigida pelo #4295.
 *
 * É esta função — não um valor copiado à mão — que a Fase 3 do #4525 usa e que
 * `docs/utm-superficies-externas.md` reproduz, pra que painel e registry não
 * possam divergir por erro de digitação.
 *
 * @pure
 */
export function buildExternalSurfaceUrl(
  surface: ExternalUtmSurface,
  baseUrl: string = EXTERNAL_SURFACE_BASE_URL,
): string {
  const url = new URL(baseUrl);
  url.searchParams.set("utm_source", surface.source);
  url.searchParams.set("utm_medium", surface.medium);
  url.searchParams.set("utm_campaign", surface.campaign);
  return url.toString();
}

/**
 * `utm_source` distintos que o projeto emite hoje, normalizados (lowercase) —
 * pelo CÓDIGO (`UTM_EMITTERS`) **e** pelas superfícies externas preenchidas à
 * mão (`EXTERNAL_UTM_SURFACES`, #4525). Usado pelo detector de drift da página
 * `/utms`: um `utm_source` que aparece no Beehiiv e NÃO está aqui é origem não
 * catalogada ou auto-tag de plataforma (`sendinblue`, o problema original do
 * #2975).
 *
 * As duas listas entram juntas de propósito: `apoiase` só existe do lado
 * externo, e sem a união ele seria acusado de "não catalogado" no exato momento
 * em que passasse a converter — o mesmo falso positivo que o #4312 corrigiu, na
 * direção oposta.
 *
 * @pure
 */
export function knownUtmSources(): string[] {
  return [
    ...new Set([
      ...UTM_EMITTERS.map((e) => e.source.toLowerCase()),
      ...EXTERNAL_UTM_SURFACES.map((s) => s.source.toLowerCase()),
    ]),
  ].sort();
}

/**
 * Converte o padrão de campanha num RegExp que casa os valores concretos —
 * cada `{placeholder}` vira `[a-z0-9_-]+`. Usado pra cruzar o inventário com
 * as campanhas que de fato chegaram do Beehiiv/Brevo.
 *
 * @pure
 */
export function campaignPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `\{` / `\}` porque o escape acima já escapou as chaves do placeholder.
  const body = escaped.replace(/\\\{[a-z]+\\\}/g, "[a-z0-9_-]+");
  return new RegExp(`^${body}$`, "i");
}
