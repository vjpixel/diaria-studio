/**
 * scripts/lib/diaria/premiere-bruto-root.ts (#13229)
 *
 * Validador ÚNICO de `publishing.video.premiere_bruto_root`, a pasta local do
 * Mac (fora do Drive) com a cópia do bruto. Usado pelo build
 * (`premiereBrutoRootFrom` em `video-montage.ts`) e pelo script do Mac
 * (`scripts/video/prepara-bruto-mac.ts`), para os dois aceitarem e recusarem
 * os mesmos valores.
 *
 * Sem import nenhum, de propósito: o script do Mac roda solto, só com o Node.
 */

/** Caminho absoluto: `/…` (Mac) ou `X:/…` / `X:\…` (Windows, para teste e para o `--local-root` no Neo). */
export function isAbsoluteRootPath(p: string): boolean {
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p);
}

/** Barras para `/`, sem barra final (a raiz `/` fica `/`). */
export function normalizeRootPath(p: string): string {
  const t = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return t || "/";
}

/**
 * `premiere_bruto_root`: `null` = ausente, `null`/vazio (o build de sempre).
 * Erro (`{ error }`) = presente e não texto, ou relativo. `ok` = absoluto,
 * normalizado.
 */
export function parsePremiereBrutoRoot(value: unknown, label = "publishing.video.premiere_bruto_root"): { ok: string | null } | { error: string } {
  if (value === undefined || value === null) return { ok: null };
  if (typeof value !== "string") return { error: `${label} precisa ser texto (veio ${JSON.stringify(value)}) (#13229)` };
  const v = value.trim();
  if (!v) return { ok: null };
  if (!isAbsoluteRootPath(v)) return { error: `${label} precisa ser um caminho absoluto (veio "${value}") (#13229)` };
  return { ok: normalizeRootPath(v) };
}
