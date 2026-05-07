/**
 * url-verify-cache.ts (#717 hypothesis #2)
 *
 * Cache cross-edição de verdicts do `verify-accessibility.ts`. URLs
 * verificadas como `accessible`, `blocked` ou `paywall` em qualquer edição
 * passada raramente mudam de status — cachear o verdict permite skipar
 * o HEAD+GET completo em runs futuros.
 *
 * Compounds com #835 (intra-edition body cache): #835 evita re-fetch
 * dentro da mesma edição; este lib evita re-fetch entre edições.
 *
 * Estrutura: `Map<canonicalUrl, CacheEntry>`. Persistido em
 * `data/link-verify-cache.json` (gitignored).
 *
 * TTL default: 7 dias. URLs cujo verdict foi cacheado há mais tempo são
 * ignoradas em load-time (e podadas no próximo save).
 *
 * Verdicts cacheáveis (per #717 issue body):
 *   - `accessible` — URL retornou conteúdo (status 200, body > 500 chars)
 *   - `blocked` — URL retornou erro permanente (404, 410, etc.)
 *   - `paywall` — URL identificada como paywall (domínio conhecido ou marker)
 *
 * Verdicts NÃO cacheáveis:
 *   - `uncertain` — body curto, soft-404, possível JS-rendered. Volátil.
 *   - `anti_bot` — possível anti-bot temporário. Volátil.
 *   - `video` — barato detectar (sem fetch), sem benefício de cache.
 *   - `aggregator` — pode resolver pra primary diferente em runs futuros.
 *   - `error` — sempre re-tentar.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type CacheableVerdict = "accessible" | "blocked" | "paywall";

const CACHEABLE_VERDICTS: ReadonlySet<string> = new Set<CacheableVerdict>([
  "accessible",
  "blocked",
  "paywall",
]);

export interface CacheEntry {
  verdict: CacheableVerdict;
  /** ISO timestamp of when this URL was verified. */
  verified_at: string;
  /** Optional note from the original verify (e.g., "known-paywall domain"). */
  note?: string;
  /** Optional final URL after redirects (preserved across cache hits). */
  finalUrl?: string;
  /**
   * Optional body raw HTML — populado quando verdict é `accessible` E body
   * é texto razoável (<= MAX_CACHED_BODY_SIZE). Permite que `verify-dates.ts`
   * em runs futuros extraia `published_at` sem refetch (#866).
   *
   * Cache file size impact: ~10-50KB por entry com body. Com 100 URLs
   * cached → cache JSON pode crescer pra ~5MB. Aceitável dado o ganho
   * de eliminar fetches redundantes em verify-dates.
   *
   * `loadCache` valida tamanho ao deserializar — entries com body acima
   * do limite são truncadas (body removido) defensivamente.
   */
  body?: string;
}

/**
 * Limite máximo de tamanho do body cached em bytes (UTF-8). Acima disso,
 * o body é descartado pra evitar JSON cache file gigante. 50KB cobre a
 * vasta maioria de páginas editoriais (heads, JSON-LD, primeiros parágrafos).
 *
 * Compatível com a truncagem de 50K em `verify-accessibility.ts` antes
 * dos paywall markers — mesmo prefix do body bruto.
 */
export const MAX_CACHED_BODY_SIZE = 50_000;

export interface CacheFile {
  /** Schema version — bump when entry shape changes incompatibly. */
  version: 1;
  entries: Record<string, CacheEntry>;
}

export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Carrega o cache do disco. Retorna estrutura vazia se arquivo ausente,
 * unreadable, ou versão incompatível (defensive — cache é otimização,
 * nunca bloqueia pipeline).
 *
 * Entries com `verified_at` mais antigo que `maxAgeMs` (default 7 dias)
 * são silenciosamente excluídas no load → próxima escrita poda elas
 * naturalmente.
 */
export function loadCache(
  cachePath: string,
  maxAgeMs: number = DEFAULT_TTL_MS,
  now: Date = new Date(),
): Map<string, CacheEntry> {
  const map = new Map<string, CacheEntry>();
  if (!existsSync(cachePath)) return map;
  let raw: CacheFile;
  try {
    raw = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return map;
  }
  if (!raw || raw.version !== 1 || !raw.entries || typeof raw.entries !== "object") {
    return map;
  }
  const cutoff = now.getTime() - maxAgeMs;
  for (const [url, entry] of Object.entries(raw.entries)) {
    if (!entry || typeof entry !== "object") continue;
    if (!CACHEABLE_VERDICTS.has(entry.verdict)) continue;
    const at = Date.parse(entry.verified_at);
    if (Number.isNaN(at) || at < cutoff) continue;
    // #866: defensive — drop body if exceeds limit (file foi tamperado ou
    // limite foi reduzido entre versions). Preserva o resto da entry.
    const sanitized: CacheEntry = { ...(entry as CacheEntry) };
    if (sanitized.body && sanitized.body.length > MAX_CACHED_BODY_SIZE) {
      delete sanitized.body;
    }
    map.set(url, sanitized);
  }
  return map;
}

/**
 * Lookup do body cached pra uma URL (#866). Usado por `verify-dates.ts`
 * como fallback após o body cache intra-edição (`bodies-dir`). Compounds
 * com #835 e #841 — quando verify cache hit cross-edição, body também vem
 * de graça (sem refetch).
 *
 * Retorna null se URL não está no cache OU entry não tem body persistido
 * (ex: entry de versão anterior, ou body excedeu MAX_CACHED_BODY_SIZE
 * no save).
 */
export function getCachedBody(
  map: Map<string, CacheEntry>,
  canonicalUrl: string,
): string | null {
  const entry = map.get(canonicalUrl);
  if (!entry) return null;
  return entry.body ?? null;
}

/**
 * Salva o cache no disco. Atomic write via `.tmp` + rename.
 * Falha de write é silenciosa (cache é best-effort).
 *
 * Aplica poda implícita: só persiste entries que `loadCache` aceitaria
 * de volta (verdict cacheável, verified_at presente).
 */
export function saveCache(cachePath: string, map: Map<string, CacheEntry>): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const entries: Record<string, CacheEntry> = {};
    for (const [url, entry] of map.entries()) {
      if (!CACHEABLE_VERDICTS.has(entry.verdict)) continue;
      if (!entry.verified_at) continue;
      // #866: drop body if exceeds limit pra evitar cache file gigante.
      // Preserva resto da entry (verdict, finalUrl, note). Defensive twin
      // do check em loadCache — guarda contra body adicionado externamente.
      const sanitized: CacheEntry = { ...entry };
      if (sanitized.body && sanitized.body.length > MAX_CACHED_BODY_SIZE) {
        delete sanitized.body;
      }
      entries[url] = sanitized;
    }
    const file: CacheFile = { version: 1, entries };
    const tmpPath = cachePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(file, null, 2) + "\n", "utf8");
    renameSync(tmpPath, cachePath);
  } catch {
    // Best-effort. Cache failure does not block pipeline.
  }
}

/**
 * Lookup com TTL check. Retorna a entry se URL está cached e dentro do TTL,
 * ou null caso contrário.
 *
 * O caller deve passar a URL já canonicalizada (`canonicalize(url)`) — cache
 * é keyed por URL exata pra evitar mismatches.
 */
export function getCached(
  map: Map<string, CacheEntry>,
  canonicalUrl: string,
  maxAgeMs: number = DEFAULT_TTL_MS,
  now: Date = new Date(),
): CacheEntry | null {
  const entry = map.get(canonicalUrl);
  if (!entry) return null;
  const at = Date.parse(entry.verified_at);
  if (Number.isNaN(at)) return null;
  if (at < now.getTime() - maxAgeMs) return null;
  return entry;
}

/**
 * Adiciona/atualiza entry no cache. Caller responsável por garantir que
 * `verdict` é cacheável — entries com verdict não-cacheável são ignoradas.
 */
export function setCached(
  map: Map<string, CacheEntry>,
  canonicalUrl: string,
  entry: Omit<CacheEntry, "verified_at"> & { verified_at?: string },
  now: Date = new Date(),
): void {
  if (!CACHEABLE_VERDICTS.has(entry.verdict)) return;
  map.set(canonicalUrl, {
    ...entry,
    verified_at: entry.verified_at ?? now.toISOString(),
  });
}

export function isCacheableVerdict(verdict: string): verdict is CacheableVerdict {
  return CACHEABLE_VERDICTS.has(verdict);
}
