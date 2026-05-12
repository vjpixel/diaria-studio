/**
 * line-endings.ts (#1132 P3.6)
 *
 * Helpers pra normalização de line endings. Eliminam classe de bugs flaky
 * entre Windows (CRLF) e Linux (LF). Pattern documentado em .gitattributes.
 *
 * Padrão consistente: TUDO em LF no nosso domínio. Ao ler arquivos cuja
 * origem é externa (network, user upload, MD do editor pelo Drive web),
 * normalizar antes de processar via `normalizeLF`.
 *
 * Antes desta lib, scripts faziam `.replace(/\r\n/g, "\n")` ad-hoc em
 * vários lugares — busca por essa string mostra ~340 referências
 * espalhadas. Centralizar evita drift.
 */

/**
 * Normaliza line endings pra LF (`\n`). Trata:
 * - CRLF (`\r\n`) → LF (`\n`)
 * - CR isolado (`\r`, raro em macOS clássico) → LF
 *
 * Idempotente: aplicar 2× tem o mesmo resultado.
 *
 * Pure helper.
 */
export function normalizeLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Variante que normaliza pra CRLF (raro — só se interagindo com formato
 * Windows-only, ex: alguns CSV legacy). Não usar em texto editorial.
 */
export function toCRLF(text: string): string {
  return normalizeLF(text).replace(/\n/g, "\r\n");
}

/**
 * Detecta line ending style do texto. Útil pra logs/debug, NÃO pra branching
 * lógica (normaliza sempre).
 *
 * Retorna `"lf"`, `"crlf"`, `"mixed"`, ou `"none"` (sem newlines).
 */
export function detectLineEnding(text: string): "lf" | "crlf" | "mixed" | "none" {
  const hasCRLF = /\r\n/.test(text);
  const hasLoneLF = /[^\r]\n/.test(text) || /^\n/.test(text);
  if (hasCRLF && hasLoneLF) return "mixed";
  if (hasCRLF) return "crlf";
  if (hasLoneLF) return "lf";
  return "none";
}

/**
 * Helper pra escrita: se conteúdo tem CRLF, normaliza pra LF antes de
 * escrever. Útil em writers que recebem texto de fontes externas.
 *
 * Combina com `writeFileAtomic` (#1132 P2.3):
 * ```ts
 * import { writeFileAtomic } from "./atomic-write.ts";
 * import { ensureLF } from "./line-endings.ts";
 * writeFileAtomic(path, ensureLF(content));
 * ```
 */
export function ensureLF(text: string): string {
  return normalizeLF(text);
}
