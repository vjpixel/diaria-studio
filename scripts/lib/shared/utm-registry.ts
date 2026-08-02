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
] as const;

/** Busca uma entrada do inventário por id. `undefined` se não existe. @pure */
export function findUtmEmitter(id: string): UtmEmitter | undefined {
  return UTM_EMITTERS.find((e) => e.id === id);
}

/**
 * `utm_source` distintos que o CÓDIGO emite hoje, normalizados (lowercase).
 * Usado pelo detector de drift da página `/utms`: um `utm_source` que aparece
 * no Beehiiv e NÃO está aqui é origem não-catalogada ou auto-tag de plataforma
 * (`sendinblue`, o problema original do #2975).
 *
 * @pure
 */
export function knownUtmSources(): string[] {
  return [...new Set(UTM_EMITTERS.map((e) => e.source.toLowerCase()))].sort();
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
