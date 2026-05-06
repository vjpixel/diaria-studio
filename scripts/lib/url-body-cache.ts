/**
 * url-body-cache.ts (#717 hypothesis #1)
 *
 * Cache intra-edição de corpos HTML fetched de URLs externas. Compartilhado
 * entre `verify-accessibility.ts` (que faz GET pra checar paywall/soft-404) e
 * `verify-dates.ts` (que faz outro GET na mesma URL pra extrair `published_at`).
 *
 * Sem o cache, edição com 300+ URLs duplica ~3-4min de fetches. Cache reduz
 * verify-dates pra ~zero fetches em URLs que verify-accessibility já leu.
 *
 * Escopo: por edição. Diretório criado em
 * `data/editions/{AAMMDD}/_internal/link-verify-bodies/` (gitignored via
 * `_internal/`). Cache cross-edição com TTL é hypothesis #2 do mesmo issue —
 * fora do escopo desta lib.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * Filename derivado da URL (sha1 truncado pra evitar paths gigantes).
 * 16 hex chars = 64 bits — colisão prática zero pra edições com <10k URLs.
 */
export function bodyCacheFilename(url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
  return `${hash}.html`;
}

export function bodyCachePath(cacheDir: string, url: string): string {
  return resolve(cacheDir, bodyCacheFilename(url));
}

/**
 * Lê o body cached pra `url` em `cacheDir`. Retorna null se ausente,
 * unreadable ou se `cacheDir` é null/undefined (cache desabilitado).
 */
export function loadCachedBody(
  cacheDir: string | null | undefined,
  url: string,
): string | null {
  if (!cacheDir) return null;
  const path = bodyCachePath(cacheDir, url);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Salva `body` no cache pra `url` em `cacheDir`. No-op se `cacheDir` é
 * null/undefined ou se o write falha (cache é otimização, não fonte de
 * verdade — falha de write não deve quebrar o pipeline).
 *
 * Cria `cacheDir` se ainda não existir.
 */
export function saveCachedBody(
  cacheDir: string | null | undefined,
  url: string,
  body: string,
): void {
  if (!cacheDir) return;
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(bodyCachePath(cacheDir, url), body, "utf8");
  } catch {
    // Cache é best-effort; falha não bloqueia.
  }
}
