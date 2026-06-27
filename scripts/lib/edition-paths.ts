/**
 * edition-paths.ts (#158)
 *
 * Helper pra resolver paths de outputs JSON da pipeline. A convenção do
 * projeto é manter na raiz de `data/editions/{AAMMDD}/` apenas arquivos
 * gate-facing (revisados pelo editor) e mover internals pra `_internal/`.
 *
 * Outputs JSON (rastreabilidade, não revisados pelo editor) devem morar
 * em `_internal/`. Mas edições antigas (260418→260426) ainda têm na raiz.
 *
 * Esses helpers fazem read com dual-path (prefere `_internal/`, fallback
 * pra root) e write sempre em `_internal/`. Backward-compat sem migração.
 */

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Filenames cobertos pelo move pra _internal/.
 * 01-eia-meta.json e 01-eia-sd-prompt.json já estão em _internal/ (não
 * mudaram convenção). Esses são os outros que precisaram migrar:
 */
export const INTERNAL_JSON_FILES = [
  "04-d1-sd-prompt.json",
  "04-d2-sd-prompt.json",
  "04-d3-sd-prompt.json",
  "05-published.json",
  "05-social-preview.json", // #1739: URL do social preview (persistida no Stage 4)
  "06-social-published.json",
] as const;

export type InternalJsonName = (typeof INTERNAL_JSON_FILES)[number];

/**
 * Resolve path pra LEITURA: prefere `_internal/{name}`, fallback pra
 * `{name}` na raiz. Use isso em todo script que lê esses JSONs.
 *
 * Retorna o path como string. NÃO valida existência — caller deve usar
 * `existsSync` se quer saber se o arquivo está lá.
 */
export function resolveReadPath(
  editionDir: string,
  name: InternalJsonName,
): string {
  const internalPath = resolve(editionDir, "_internal", name);
  if (existsSync(internalPath)) return internalPath;
  // Fallback: raiz (edições antigas)
  return resolve(editionDir, name);
}

/**
 * Resolve path pra ESCRITA: sempre `_internal/{name}`. Use isso em todo
 * script novo. Edições antigas continuam funcionando porque os reads têm
 * fallback.
 *
 * Note: caller é responsável por garantir que o diretório `_internal/`
 * existe antes do `writeFileSync` (mkdirSync com `recursive: true`).
 */
export function resolveWritePath(
  editionDir: string,
  name: InternalJsonName,
): string {
  return resolve(editionDir, "_internal", name);
}

/**
 * Verifica se um arquivo existe em qualquer um dos 2 paths possíveis.
 * Útil pra resume logic onde só importa a presença, não o local.
 */
export function existsInEditionDir(
  editionDir: string,
  name: InternalJsonName,
): boolean {
  return (
    existsSync(resolve(editionDir, "_internal", name)) ||
    existsSync(resolve(editionDir, name))
  );
}

// ─── Construção do path da edição (#2463) ─────────────────────────────────────
//
// Centralização do path `data/editions/{AAMMDD}/` num único ponto. Hoje o
// layout é FLAT; a futura reorg para `data/editions/{AAMM}/{AAMMDD}/` (#2463)
// muda SÓ aqui — os call-sites passam a chamar `editionDir(aammdd)` em vez de
// montar a string à mão. Este PR introduz o helper retornando o layout ATUAL
// (flat); a migração dos call-sites + a troca de layout vêm em PRs seguintes.

/**
 * Raiz das edições, path RELATIVO (`data/editions`). Ponto único pra futura
 * reorg #2463 (ex: `find-current-edition` varre a partir daqui).
 */
export function editionsRoot(): string {
  return join("data", "editions");
}

/**
 * Diretório de uma edição a partir do AAMMDD. Layout ATUAL = flat:
 * `data/editions/{AAMMDD}`. É o ÚNICO ponto de construção desse path — a
 * futura migração para `data/editions/{AAMM}/{AAMMDD}` (#2463) muda só aqui.
 * Retorna path RELATIVO sem barra final, drop-in para os call-sites no padrão
 * `data/editions/${aammdd}`. Valida o formato AAMMDD (exatamente 6 dígitos).
 */
export function editionDir(aammdd: string): string {
  if (!/^\d{6}$/.test(aammdd)) {
    throw new Error(
      `editionDir: AAMMDD inválido: ${JSON.stringify(aammdd)} (esperado exatamente 6 dígitos)`,
    );
  }
  return join(editionsRoot(), aammdd);
}
