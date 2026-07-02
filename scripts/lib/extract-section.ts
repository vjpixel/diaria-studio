/**
 * extract-section.ts (#2834 — EPIC #2808, enxugar scripts/lib/)
 *
 * `extractSection` estava duplicada byte-a-byte (a menos de comentários) em
 * `lint-social-md.ts`, `publish-instagram.ts` e `publish-threads.ts` — todas
 * extraindo a seção genérica `# {Título}` de `03-social.md`, normalizando
 * CRLF → LF (#2486: sem isso, arquivos Windows com CRLF não casam o `\n` da
 * regex e a seção não é encontrada).
 */

/** Extrai a seção `# {sectionTitle}` de um markdown multi-seção (ex: 03-social.md). */
export function extractSection(md: string, sectionTitle: string): string | null {
  const normalized = md.replace(/\r\n/g, "\n");
  const re = new RegExp(`(?:^|\\n)# ${sectionTitle}\\n([\\s\\S]*?)(?=\\n# |$)`, "i");
  const m = normalized.match(re);
  return m ? m[1] : null;
}
