/**
 * scripts/lib/shared/retrospectiva-seo.ts (#7720)
 *
 * `retrospectiva.diar.ia.br/{AAMM,AAAA,aniversarioAAAA}` serve, pra quem NÃO
 * passou no gate, o mesmo HTML gerado pro e-mail (`wrapEmail`/`annual-render`)
 * — funciona bem como e-mail, mas e-mail não carrega `<meta name="description">`,
 * `<link rel="canonical">` nem structured data, então nada disso existia na
 * página pública (medido nas 5 edições publicadas, ver #7720). Este módulo
 * injeta os três no `<head>` do HTML já pronto, sem reescrever o shell.
 *
 * PURO e compartilhado (mensal e anual/aniversário consomem os mesmos
 * helpers) — mesma convenção de `retrospectiva-path.ts`: publisher e Worker
 * não podem divergir sobre o que "description"/"canonical" significam.
 *
 * ## Os dois produtos NÃO levam o mesmo JSON-LD (#7658/#7715)
 *
 * `/AAMM` é pago (apoio Mantenedor R$25+) — `isAccessibleForFree: false`,
 * com `hasPart` marcando onde o conteúdo restrito começa. `/AAAA` e
 * `/aniversarioAAAA` são gate de CADASTRO grátis, não paywall — `isAccessibleForFree: true`,
 * sem `hasPart` (não há nada "pago" a declarar).
 *
 * ## Por que `hasPart.cssSelector` aponta pro bloco de conversão, não pro texto pago
 *
 * O corte do trecho é feito NO SERVIDOR (`cutDraftAfterFirstDestaque`) — o
 * texto pago nunca chega no HTML servido a quem não passou no gate, então não
 * existe elemento na página pra marcar como "escondido". O padrão do
 * Google para paywalled content pressupõe o oposto (texto presente, oculto por
 * CSS) — aqui a aproximação fiel é apontar pro elemento que sinaliza ao
 * leitor (e ao rastreador) ONDE o conteúdo restrito começaria: o próprio
 * bloco de conversão injetado por `renderTeaserWithPaywall`. `isAccessibleForFree: false`
 * no nível do artigo já é o sinal principal e não depende dessa aproximação.
 */

/** Tamanho alvo do snippet de `description` — igual ao teto usual de SERP (~155-160c). */
const DESCRIPTION_MAX_LEN = 155;

/** Texto genérico usado só quando a extração não encontra nada aproveitável
 *  (teaser vazio/malformado) — nunca bloqueia o render por falta de description. */
const FALLBACK_DESCRIPTION = "Retrospectiva da diar.ia.br — o resumo do período em notícias e tutoriais de IA.";

/** Extrai o texto de `<title>...</title>`. `null` se ausente/vazio. @pure */
export function extractTitleText(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const text = decodeHtmlEntities(stripTags(m[1])).trim();
  return text.length > 0 ? text : null;
}

/** Decodifica as entidades HTML mais comuns — suficiente para texto de
 *  title/parágrafo, sem puxar dependência externa. @pure */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
}

/** Remove tags HTML, preservando só o texto. @pure */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

/**
 * Deriva um `description` mecânico a partir do BODY do teaser: tira
 * `<head>`/`<style>`/`<script>`, extrai texto corrido, e trunca no limite de
 * palavra mais próximo de `DESCRIPTION_MAX_LEN`. Cai no fallback genérico
 * (nunca lança) quando o teaser não tem texto aproveitável — SEO incompleto é
 * aceitável, quebrar o render por causa de description não é.
 *
 * Não tenta ler o `<title>` como description: o título já vai em `<title>`/
 * `og:title` — description precisa ser outra frase, senão o snippet repete o
 * título do resultado de busca.
 *
 * @pure
 */
export function deriveDescription(html: string): string {
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const scope = bodyMatch ? bodyMatch[1] : html;
  const withoutStyleScript = scope.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const text = decodeHtmlEntities(stripTags(withoutStyleScript)).replace(/\s+/g, " ").trim();
  if (text.length === 0) return FALLBACK_DESCRIPTION;
  if (text.length <= DESCRIPTION_MAX_LEN) return text;
  const cut = text.slice(0, DESCRIPTION_MAX_LEN);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.trimEnd()}…`;
}

export interface RetrospectivaJsonLdInput {
  headline: string;
  description: string;
  url: string;
  /** `false` para `/AAMM` (paywall Mantenedor); `true` para `/AAAA` e `/aniversarioAAAA` (cadastro grátis). */
  isAccessibleForFree: boolean;
  /** Selector CSS do elemento que marca onde o conteúdo restrito começa — só para paywall (`isAccessibleForFree: false`). */
  paywallCssSelector?: string;
}

/**
 * Monta o objeto JSON-LD (`Article`) como STRING já pronta pra ir dentro de
 * `<script type="application/ld+json">`. `hasPart` só entra quando
 * `isAccessibleForFree` é `false` E `paywallCssSelector` foi passado — os dois
 * juntos são o caso `/AAMM`; qualquer outra combinação omite `hasPart`.
 *
 * @pure
 */
export function buildRetrospectivaJsonLd(input: RetrospectivaJsonLdInput): string {
  const base: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.headline,
    description: input.description,
    url: input.url,
    isAccessibleForFree: input.isAccessibleForFree,
  };
  if (!input.isAccessibleForFree && input.paywallCssSelector) {
    base.hasPart = {
      "@type": "WebPageElement",
      isAccessibleForFree: false,
      cssSelector: input.paywallCssSelector,
    };
  }
  return JSON.stringify(base);
}

/**
 * Injeta `<meta name="description">`, `<link rel="canonical">` e o
 * `<script type="application/ld+json">` logo antes do ÚLTIMO `</head>` do
 * HTML (mesma defesa de `renderTeaserWithPaywall`/`renderTeaserWithSignup`
 * contra HTML que cita `</head>` como texto/exemplo em algum lugar do corpo).
 *
 * **Fail-soft, de propósito** — diferente da injeção do bloco de conversão
 * (que falha alto porque publicar sem ele entrega conteúdo de graça sem
 * pedir nada em troca): aqui, na ausência de `</head>`, a pior consequência
 * de pular a injeção é a página ficar sem os 3 sinais de SEO — SEO faltando é
 * o estado ATUAL (é o que a #7720 corrige), nunca motivo pra derrubar uma
 * página que já funciona. `console.error` registra o caso pra investigação,
 * nunca lança.
 *
 * @pure exceto pelo `console.error` de diagnóstico no caminho de erro.
 */
export function injectRetrospectivaHeadMeta(
  html: string,
  opts: { description: string; canonical: string; jsonLd: string },
): string {
  const ocorrencias = [...html.matchAll(/<\/head\s*>/gi)];
  const ultima = ocorrencias.at(-1);
  if (ultima?.index === undefined) {
    console.error("[retrospectiva-seo] HTML sem </head> — pulando injeção de description/canonical/JSON-LD (#7720)");
    return html;
  }
  // `</script` dentro do JSON-LD (title/description com esse texto literal,
  // improvável mas não impossível) fecharia o `<script>` mais cedo — escapar
  // a barra evita que o navegador interprete a tag antes do fim do JSON.
  const safeJsonLd = opts.jsonLd.replace(/<\/script/gi, "<\\/script");
  const tags = `  <meta name="description" content="${escAttr(opts.description)}" />
  <link rel="canonical" href="${escAttr(opts.canonical)}" />
  <script type="application/ld+json">${safeJsonLd}</script>
`;
  return `${html.slice(0, ultima.index)}${tags}${html.slice(ultima.index)}`;
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
