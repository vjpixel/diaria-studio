/**
 * lint-checks/eai-section.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Verifica que a seção É IA? está presente no MD da newsletter (#588).
 *
 * Writer agent (Sonnet) tem instrução explícita pra emitir bloco É IA? entre
 * D2 e D3 (ver writer.md step 2b). Mas tem ignorado silenciosamente.
 * Este check determinístico bloqueia o gate quando a seção falta.
 *
 * Aceita as 3 formas de marcação:
 *   - "**É IA?**" como linha solo (formato preferido #1100, em negrito como
 *     os outros headers de seção)
 *   - "É IA?" como linha solo (formato legacy, pré-#1100)
 *   - "## É IA?" (formato categorized embedded #371)
 *
 * #908: quando o frontmatter contém `eia_answer` (gabarito A/B), a seção
 * deve incluir uma linha "Gabarito: **A = ..., B = ..." pro editor revisar
 * o draft no Drive sem ter que abrir frontmatter ou 01-eia.md em paralelo.
 * Stage 4 (publish-newsletter) lê 01-eia.md direto pro HTML — gabarito
 * fica em 02-reviewed.md, não bleeds pra newsletter publicada.
 */
export function checkEaiSection(md: string): { ok: boolean; error?: string } {
  // Normalizar CRLF
  const normalized = md.replace(/\r\n/g, "\n");
  const hasEia =
    /^\*\*É IA\?\*\*\s*$/m.test(normalized) ||
    /^É IA\?\s*$/m.test(normalized) ||
    /^##\s+É IA\?\s*$/m.test(normalized);
  if (!hasEia) {
    return {
      ok: false,
      error:
        "Seção É IA? ausente. Writer deveria inserir entre DESTAQUE 2 e DESTAQUE 3 (writer.md step 2b). " +
        "Inserir bloco lendo de 01-eia.md ou 01-categorized.md.",
    };
  }

  // #908: se frontmatter tem eia_answer, body deve ter linha de gabarito.
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const hasEiaAnswer = /eia_answer\s*:/.test(fm);
    if (hasEiaAnswer) {
      // Aceitar formato novo (#957): "Gabarito: **A é a IA**" (1 lado só).
      // Aceitar formato legacy: "Gabarito: A = ia, B = real" (ambos os lados).
      // Ambos com ou sem negrito, com ou sem prefixo `>` (blockquote).
      const hasGabaritoNew = /Gabarito\s*:\s*\*{0,2}[AB]\s+é\s+a\s+IA\*{0,2}/i.test(
        normalized,
      );
      const hasGabaritoLegacy = /Gabarito\s*:\s*\*{0,2}A\s*=\s*(ia|real)\*{0,2}\s*,\s*\*{0,2}B\s*=\s*(ia|real)\*{0,2}/i.test(
        normalized,
      );
      if (!hasGabaritoNew && !hasGabaritoLegacy) {
        return {
          ok: false,
          error:
            "Seção É IA? sem linha de gabarito no body (#908/#957). Frontmatter tem `eia_answer` mas falta " +
            "linha `> Gabarito: **{A|B} é a IA**` no body — editor não consegue ver " +
            "qual imagem é a IA no Drive review sem abrir frontmatter ou 01-eia.md em paralelo.",
        };
      }
    }
  }

  return { ok: true };
}
