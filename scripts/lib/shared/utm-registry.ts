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

export type MensalPosicao = (typeof MENSAL_POSICOES)[number];

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
    campaignPattern: "clarice-{ciclo}-{posicao}",
    originFile: "scripts/lib/mensal/monthly-render.ts",
    description:
      "Todo link pro host de marca no e-mail mensal enviado pela Brevo. " +
      "O sufixo {posicao} distingue wordmark-{secao} / inline / cta / titulo / pill (#4040).",
    status: "ativo",
  },
  {
    id: "eia-arquivo-newsletter",
    label: "É IA? — arquivo (e-mail diário)",
    source: "newsletter",
    medium: "email",
    campaignPattern: "eia-arquivo",
    originFile: "scripts/lib/newsletter-render-html.ts",
    description: "Ponte e-mail diário → arquivo jogável do 'É IA?' no site (#3524).",
    status: "ativo",
  },
  {
    id: "eia-arquivo-worker",
    label: "É IA? — arquivo (Worker)",
    source: "newsletter",
    medium: "email",
    campaignPattern: "eia-arquivo",
    originFile: "workers/poll/src/lib.ts",
    description:
      "Duplicata DELIBERADA da entrada acima (#3524): o Worker precisa do mesmo " +
      "triplo pra manter a coerência do funil e não pode importar o render do e-mail.",
    status: "ativo",
  },
  {
    id: "eia-jogar-posvoto",
    label: "É IA? — CTA pós-voto",
    source: "eia-standalone",
    medium: "jogar",
    campaignPattern: "eia-jogar-posvoto",
    originFile: "workers/poll/src/jogar.ts",
    description: "Botão 'Assinar a Diar.ia' do CTA pós-voto do jogo standalone (#3518).",
    status: "ativo",
  },
  {
    id: "eia-quiz-posvoto",
    label: "É IA? — CTA do quiz relâmpago",
    source: "eia-standalone",
    medium: "quiz",
    campaignPattern: "eia-quiz-posvoto",
    originFile: "workers/poll/src/jogar.ts",
    description: "CTA de assinatura no resultado final do quiz relâmpago (#3579).",
    status: "ativo",
  },
  {
    id: "eia-jogar-inline",
    label: "É IA? — cadastro inline",
    source: "eia-standalone",
    medium: "jogar-inline",
    campaignPattern: "eia-jogar-inline-signup",
    originFile: "workers/poll/src/subscribe.ts",
    description: "Form de cadastro embutido na própria página do jogo (#3580).",
    status: "ativo",
  },
  {
    id: "embed-widget",
    label: "Embed do jogo (parceiros)",
    source: "embed",
    medium: "widget",
    campaignPattern: "{partner}",
    originFile: "workers/poll/src/embed.ts",
    description:
      "CTA do widget embutido em site parceiro — `utm_campaign` = slug do parceiro " +
      "(`generico` quando `?partner=` está ausente/inválido) (#3521).",
    status: "ativo",
  },
  {
    id: "share-eia",
    label: "Compartilhamento do 'É IA?'",
    source: "eia-standalone",
    medium: "{medium}",
    campaignPattern: "eia-share",
    originFile: "workers/poll/src/share.ts",
    description:
      "Cartão de compartilhamento do resultado — `utm_medium` dinâmico por canal " +
      "(social / whatsapp / copy / link) (#3978/#3679).",
    status: "ativo",
  },
  {
    id: "share-quiz",
    label: "Compartilhamento do quiz",
    source: "eia-standalone",
    medium: "{medium}",
    campaignPattern: "eia-quiz-share",
    originFile: "workers/poll/src/share.ts",
    description: "Cartão de compartilhamento do quiz relâmpago / sequência mensal (#3978).",
    status: "ativo",
  },
  {
    id: "clarice-cta-ab",
    label: "A/B de CTA da mensal (round CTA-01)",
    source: MENSAL_UTM_SOURCE,
    medium: MENSAL_UTM_MEDIUM,
    campaignPattern: "clarice-{ciclo}-{posicao}-cta-{arm}",
    originFile: "scripts/clarice-cta-ab-setup.ts",
    description:
      "Sufixo de braço A/B composto EM CIMA do sufixo de posição do render (#4040), " +
      "mais `utm_term` posicional. Round CTA-01 ENCERRADO pelo editor em 260726 (#4059) — " +
      "o script é artefato histórico de como o round foi montado.",
    status: "aposentado",
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
