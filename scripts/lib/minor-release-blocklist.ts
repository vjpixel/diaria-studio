/**
 * minor-release-blocklist.ts (#12933)
 *
 * Blacklist EDITORIAL de releases MENORES de repositórios GitHub cujo ritmo de
 * release é quase diário. Pedido do editor na revisão da edição 261113: o item
 * `v2.1.323` do Claude Code (página `github.com/anthropics/claude-code/releases/tag/v2.1.323`)
 * entrou em LANÇAMENTOS e foi removido à mão no gate 4 — "só atualizações
 * maiores". Distinta de `editorial-blocklist.ts` (domínio inteiro, #1760) e de
 * `url-blocklist.ts` (URL exata, #4340): aqui o corte é pelo PADRÃO de URL +
 * número da versão, porque `github.com` e o próprio repo seguem fontes válidas.
 *
 * Aplicada no `dedup.ts` (pass 0), mesmo ponto das outras blacklists.
 *
 * Regra do que conta como "maior" (premissa registrada no PR da #12933 — a
 * issue pedia decisão do editor e o default adotado é o menos restritivo que
 * ainda corta o caso real): uma release passa se a tag é `X.0.0` (major) ou
 * `X.Y.0` (minor, recurso novo); é BLOQUEADA se é patch (`X.Y.Z` com Z > 0) ou
 * pré-release (`-beta`, `-rc.1`, ...). Medido em 13/11/2026 nas edições 2611*:
 * todas as tags do Claude Code vistas no pool são `v2.1.3NN` — patch. Tag sem
 * versão numérica (`nightly`, `latest`) fica: nunca bloquear o que não sabe
 * classificar.
 *
 * MANTER CURADA — um repo por linha, com motivo + data da decisão.
 */
export const MINOR_RELEASE_BLOCKED_REPOS: ReadonlySet<string> = new Set<string>([
  "anthropics/claude-code", // editor 261113 (#12933) — release de patch quase diário; só versão maior entra
]);

const GITHUB_RELEASE_TAG_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/releases\/tag\/([^/?#]+)/i;

export interface ParsedReleaseTag {
  major: number;
  minor: number;
  patch: number;
  /** Sufixo de pré-release/build (`-beta.1`, `+abc`), vazio quando não há. */
  suffix: string;
}

/**
 * Lê `X[.Y[.Z]][sufixo]` (com `v` opcional) de uma tag. `null` quando a tag não
 * começa por número. `%` malformado não lança (cai na tag crua, como em
 * `categorize.ts`/#11116). @pure
 */
export function parseReleaseTag(tag: string): ParsedReleaseTag | null {
  let decoded = tag;
  try {
    decoded = decodeURIComponent(tag);
  } catch {
    /* tag não decodificável: segue com a string crua */
  }
  const m = decoded.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+].*)?$/i);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    suffix: m[4] ?? "",
  };
}

/**
 * #12933: true se a URL é a página de UMA release menor (patch ou pré-release)
 * de um repo em `MINOR_RELEASE_BLOCKED_REPOS`. Release `X.Y.0`/`X.0.0`, outro
 * repo, outra página do repo (raiz, `/releases`, issues) e URL inválida → false.
 */
export function isMinorRelease(url: string): boolean {
  if (typeof url !== "string") return false;
  const m = url.match(GITHUB_RELEASE_TAG_RE);
  if (!m) return false;
  const repo = `${m[1]}/${m[2]}`.toLowerCase();
  if (!MINOR_RELEASE_BLOCKED_REPOS.has(repo)) return false;
  const v = parseReleaseTag(m[3]);
  if (!v) return false;
  return v.patch > 0 || v.suffix !== "";
}
