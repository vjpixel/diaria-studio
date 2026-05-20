/**
 * social-source-hash.ts (#1413)
 *
 * Computa hash determinístico dos highlights aprovados em
 * `_internal/01-approved.json` pra detectar staleness de `03-social.md`
 * após reestrutura de destaques pós-Stage 2.
 *
 * Por que hash, não comparação de URL:
 *   - Tentativa anterior (PR #1429, revert em #1431): checava cada
 *     highlight.url aparecer em 03-social.md. Falhou porque posts sociais
 *     por design (#595) NÃO incluem URL do artigo (LinkedIn main é thread
 *     textual; Facebook linka homepage; comments usam {edition_url}).
 *   - Hash captura "qual conjunto de destaques estava no approved quando
 *     o social.md foi gerado", sem precisar que o social.md cite URLs.
 *
 * Caso real 260520: D1 mudou de Karpathy → Google I/O pós-Stage 2.
 * social.md continuou com hook Karpathy. Hash do approved (com Google I/O
 * D1) não bate com hash gravado quando merge-social-md.ts rodou
 * (com Karpathy D1).
 *
 * Fluxo:
 *   1. merge-social-md.ts (Stage 2) computa hash do approved + grava em
 *      `_internal/.social-source-hash.json`.
 *   2. Invariant rule stage-4 (`scripts/lib/invariant-checks/stage-4.ts`)
 *      recomputa hash atual e compara contra cached. Mismatch = social
 *      stale, bloquear dispatch.
 *
 * Hash é stable shape: ordered URLs+titles dos highlights[]. Pequeno
 * (~200 bytes), determinístico, sem dependência de bibliotecas externas.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface HighlightForHash {
  url?: string;
  title_options?: string[];
}

interface ApprovedJson {
  highlights?: HighlightForHash[];
}

/**
 * Pure: deriva hash hex sha256 de uma lista de highlights. Ordem preservada
 * (D1, D2, D3). Cada highlight contribui `url|title` (primeiro title_option).
 * Highlights sem URL contribuem `(no-url)|title`.
 *
 * Empty array → hash de string vazia (raro mas válido).
 */
export function hashHighlights(highlights: HighlightForHash[]): string {
  const canonical = highlights
    .map((h) => {
      const url = h.url?.trim() ?? "(no-url)";
      const title = h.title_options?.[0]?.trim() ?? "(no-title)";
      return `${url}|${title}`;
    })
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Lê 01-approved.json e retorna hash dos highlights. Throws se file
 * ausente ou parse falhar — caller decide skip vs fail.
 */
export function hashFromApprovedFile(approvedPath: string): string {
  const data = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
  const highlights = Array.isArray(data.highlights) ? data.highlights : [];
  return hashHighlights(highlights);
}
