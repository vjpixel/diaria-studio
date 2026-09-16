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
// #8152: headers REAIS de seção secundária levam um emoji na frente
// (`📡 RADAR`, `🛠️ USE MELHOR`, `🚀 LANÇAMENTOS` — ver
// `context/templates/newsletter.md`). A versão anterior desta regex
// (`/^[A-ZÇÃÕÁÉÍÓÚÊÔ ]{5,}$/`) não tinha o emoji na character class e por
// isso NUNCA batia com um header de produção — `extractAllTitles`
// (title-normalization.ts) nunca coletava título nenhum de RADAR/USE
// MELHOR/LANÇAMENTOS, deixando `checkTitlePublisherSuffix` (#2664) e
// `checkTitleTrailingPeriod` (#2672) mudos pra essas 3 seções desde que
// foram escritos. `\p{Extended_Pictographic}` (Unicode, precisa da flag
// `u`) cobre qualquer emoji atual ou futuro no prefixo — não é uma
// allowlist de 3 emojis específicos; `️?` cobre o variation selector
// que alguns emoji (ex: 🛠️) carregam. Depois do prefixo opcional, o resto
// da linha ainda precisa ser só maiúsculas+espaço (5+ chars) — o guard que
// rejeita corpo de texto comum não mudou.
export const SECTION_HEADER_LINE_RE =
  /^(?:\p{Extended_Pictographic}️?\s*)?[A-ZÇÃÕÁÉÍÓÚÊÔ ]{5,}$/u;
export const WHY_MATTERS_LINE_RE = /^Por que isso importa:/i;
