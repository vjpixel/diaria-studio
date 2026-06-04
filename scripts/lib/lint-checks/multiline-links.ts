/**
 * lint-checks/multiline-links.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Detecta links markdown quebrados em múltiplas linhas (#1213).
 *
 * Writer agent às vezes emite:
 *
 *   - [Label](
 *   https://example.com
 *   )
 *
 * O renderer não parseia esses links (regex linha-a-linha), produzindo
 * texto bruto `[Label](` + URL + `)` órfão no HTML final. Caso real
 * 260517: Pixel viu no test email.
 *
 * Lint detecta `\\](` no fim de linha (com whitespace). Re-disparar o
 * writer ou auto-fix via `joinMultilineLinks` no renderer.
 *
 * Retorna `{ ok, matches }` onde `matches[]` traz linha + contexto.
 */

export interface MultilineLinkMatch {
  line: number;
  context: string;
}
export interface MultilineLinkResult {
  ok: boolean;
  matches: MultilineLinkMatch[];
}

export function lintMultilineLinks(md: string): MultilineLinkResult {
  const normalized = md.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const matches: MultilineLinkMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Linha termina com `](` (com whitespace antes do final) e a próxima
    // linha não-vazia começa com `http(s)://` — assinatura inequívoca.
    if (/\]\(\s*$/.test(lines[i])) {
      // Lookahead: próxima linha não-vazia começa com URL?
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && /^\s*https?:\/\//.test(lines[j])) {
        matches.push({
          line: i + 1,
          context: `${lines[i].slice(-40)} ↵ ${lines[j].slice(0, 40)}`,
        });
      }
    }
  }
  return { ok: matches.length === 0, matches };
}
