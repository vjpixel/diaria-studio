/**
 * mtime.ts (#2048 item 10)
 *
 * Helper para leitura de `mtimeMs` de arquivo com catch→null.
 *
 * Semantica do default:
 *   - `null` = arquivo ausente (ENOENT) ou erro de stat — caller trata como "não existe".
 *   - NÃO usar `catch → 0` (sempre-stale): 0 faz o arquivo parecer stale mesmo quando
 *     ausente, podendo ocultar problemas ou forçar re-processamento desnecessário.
 *     Se o caller precisa "tratar ausente como stale", deve comparar `null` explicitamente.
 *
 * Extraído de `upload-html-public.ts:checkHtmlFreshness` onde existia como closure inline.
 * Migrar outras variantes `catch → 0` só se forem triviais (de/para uso direto do helper).
 */

import { statSync } from "node:fs";

/**
 * Retorna `mtimeMs` do arquivo, ou `null` se ausente/inacessível.
 * TOCTOU-safe: usa try/catch em vez de `existsSync` + `statSync`.
 */
export function mtimeMs(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}
