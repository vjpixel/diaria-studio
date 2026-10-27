/**
 * non-editorial-paths.ts (#1559)
 *
 * Detecta URLs cujo path indica conteúdo não-editorial: páginas de help/FAQ,
 * about, legal, privacy, terms, careers, jobs. Esses URLs vêm pelo `site:`
 * query no Brave Search mas nunca são artigos editoriais — o agent Haiku
 * filtra via LLM judgment, Brave aceita raw.
 *
 * Caso real (260529 validation): site:openai.com retornou
 * help.openai.com/articles/12677804-what-is-chatgpt-faq como artigo. Não é.
 *
 * Uso em `fetch-websearch-batch.ts:processResult`.
 */

/**
 * Path segments (com slashes) que indicam página não-editorial.
 * Match: URL path comece com `/{segment}` OU contenha `/{segment}/`.
 */
const NON_EDITORIAL_PATH_SEGMENTS = [
  "help",
  "faq",
  "support",
  "about",
  "legal",
  "privacy",
  "terms",
  "tos",
  "careers",
  "jobs",
  "contact",
  "press",
  "newsroom",
  "subscribe",
];

/**
 * Subdomínios inteiros que sempre indicam conteúdo não-editorial.
 * Match: hostname === pattern OU hostname.startsWith(pattern + ".").
 */
const NON_EDITORIAL_HOST_PREFIXES = [
  "help",
  "support",
  "developers",
  "docs",
];

/**
 * Exceções: paths/hosts onde "blog" ou "/blog/" indica conteúdo editorial
 * mesmo quando o subdomínio sugere docs. Match override aplicado ANTES da
 * checagem geral.
 */
const EDITORIAL_OVERRIDE_PATHS = [
  "/blog/",
  "/news/",
  "/research/",
  "/papers/",
  "/announcement",
  "/announcements/",
];

/**
 * Pure: retorna `true` se o URL é página de help/FAQ/about/etc — não-editorial.
 *
 * Algoritmo:
 *  1. Se path bate em algum EDITORIAL_OVERRIDE_PATHS → false (editorial, mantém)
 *  2. Se hostname está em NON_EDITORIAL_HOST_PREFIXES → true (drop)
 *  3. Se path bate em NON_EDITORIAL_PATH_SEGMENTS → true (drop)
 *  4. Else → false (mantém)
 *
 * Retorna `false` em URLs malformadas (defensive — caller decide outras checks).
 */
export function isNonEditorialPath(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  // 1. Editorial overrides (blog, news, research) — mantém mesmo em subdomain docs/support
  for (const override of EDITORIAL_OVERRIDE_PATHS) {
    if (path.includes(override)) return false;
  }

  // 2. Host prefix check (help.openai.com, docs.anthropic.com, etc.)
  for (const prefix of NON_EDITORIAL_HOST_PREFIXES) {
    if (host === prefix || host.startsWith(prefix + ".")) return true;
  }

  // 3. Path segment check (/help/, /faq/, etc.)
  for (const segment of NON_EDITORIAL_PATH_SEGMENTS) {
    if (path === `/${segment}` || path.startsWith(`/${segment}/`)) return true;
  }

  return false;
}

/**
 * Pure (#11338): host do `site:` de uma query de fonte cadastrada
 * (`site:help.openai.com AI OR ...` → `help.openai.com`), sem `www.`,
 * lowercase. `null` quando a query não tem `site:` (discovery).
 */
export function siteQueryHost(query: string | undefined): string | null {
  if (!query) return null;
  const m = query.match(/(?:^|\s)site:(\S+)/i);
  if (!m) return null;
  const host = m[1].split("/")[0].toLowerCase().replace(/^www\./, "");
  return host || null;
}

/**
 * Pure (#11338): `isNonEditorialPath` com a exceção da fonte cadastrada.
 *
 * O filtro #1559 existe pra fonte cujo `site:` é o domínio-mãe
 * (`site:openai.com` trazendo `help.openai.com/articles/...`). Quando o próprio
 * host de ajuda é a fonte cadastrada (`site:help.openai.com`,
 * `site:support.claude.com` — decisão do editor, #11338), o resultado desse
 * host é justamente o que a fonte existe pra trazer, então não é descartado.
 * A exceção vale só pra host IGUAL ao do `site:`: `site:openai.com` continua
 * descartando `help.openai.com` (regressão 260529).
 */
export function isNonEditorialForSource(url: string, siteQuery?: string): boolean {
  if (!isNonEditorialPath(url)) return false;
  const sourceHost = siteQueryHost(siteQuery);
  if (!sourceHost) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return true;
  }
  return host !== sourceHost;
}
