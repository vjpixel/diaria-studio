/**
 * lint-checks/highlight-parsing.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Regexes de linha compartilhadas pelos checks que percorrem os blocos
 * DESTAQUE do `02-reviewed.md` (`titles-per-highlight` + `title-length`).
 * Antes eram constantes module-level únicas no lint-newsletter-md; agora vivem
 * aqui pra os 2 módulos por-check importarem a MESMA definição (sem drift).
 */

// Header de destaque — plain ou em **negrito** (#590). O `**` final é
// stripado da capture group 2 (`(.+?)(?:\*\*)?$`) se presente. Grupo 1 = N,
// grupo 2 = categoria.
export const HIGHLIGHT_HEADER_RE = /^(?:\*\*)?DESTAQUE\s+(\d+)\s*\|\s*(.+?)(?:\*\*)?$/;
export const URL_LINE_RE = /^https?:\/\//;
export const SECTION_BREAK_LINE_RE = /^---\s*$/;
export const SECTION_HEADER_LINE_RE = /^[A-ZÇÃÕÁÉÍÓÚÊÔ ]{5,}$/;
export const WHY_MATTERS_LINE_RE = /^Por que isso importa:/i;
