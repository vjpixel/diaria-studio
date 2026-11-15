/**
 * intentional-error-sections.ts (#10234, movido do `replant-intentional-error.ts` no #13105)
 *
 * Seções do `02-reviewed.md` (DESTAQUE N, LANÇAMENTOS, RADAR, USE MELHOR,
 * VÍDEOS) e a seção declarada no texto livre de `location` do erro
 * intencional. Usado pelo replantio (`findOldErrorStillPresent`) e pelo scrub
 * dos produtos derivados (`scrubIntentionalError`, #13105), que precisam
 * escopar o `wrong_value` ao trecho onde ele foi plantado.
 */

/** Seções nomeadas reconhecidas em `location` e nos headers do MD (#10234). */
const NAMED_SECTIONS: ReadonlyArray<{ key: string; re: RegExp }> = [
  { key: "LANÇAMENTOS", re: /LAN[ÇC]AMENTOS?/iu },
  { key: "RADAR", re: /RADAR|OUTRAS?\s+NOT[ÍI]CIAS?/iu },
  { key: "USE MELHOR", re: /USE\s+MELHOR/iu },
  { key: "VÍDEOS", re: /V[ÍI]DEOS?/iu },
];

/**
 * (#10234) Seção declarada no texto livre de `location`/`description`
 * ("DESTAQUE 2, parágrafo 3", "RADAR (menção a …)", "D3"). `null` quando não
 * dá pra resolver uma única seção — aí o chamador cai no comportamento
 * conservador (texto inteiro).
 */
export function sectionKeyFromLocation(text: string | undefined): string | null {
  if (!text) return null;
  const keys = new Set<string>();
  for (const m of text.matchAll(/\bDESTAQUE\s*(\d)\b|\bD([1-9])\b/giu)) keys.add(`DESTAQUE ${m[1] ?? m[2]}`);
  for (const { key, re } of NAMED_SECTIONS) if (re.test(text)) keys.add(key);
  return keys.size === 1 ? [...keys][0] : null;
}

/** Chave de seção de uma linha de header do MD, ou `null` se a linha não é header. */
export function sectionHeaderKey(line: string): string | null {
  const stripped = line
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  const d = /^DESTAQUE\s+(\d)\b/iu.exec(stripped);
  if (d) return `DESTAQUE ${d[1]}`;
  for (const { key, re } of NAMED_SECTIONS) if (new RegExp(`^(?:${re.source})$`, "iu").test(stripped)) return key;
  // Outros headers em caixa alta (ERRO INTENCIONAL, É IA?, SORTEIO…) só encerram a seção anterior.
  const isBoldOrHeading = /^\s*(?:\*\*[^*]+\*\*|#+\s+\S.*)\s*$/u.test(line);
  if (isBoldOrHeading && /\p{Lu}/u.test(stripped) && !/\p{Ll}/u.test(stripped)) return `OUTRA:${stripped}`;
  return null;
}

/**
 * Seção de cada linha do MD, na ordem (`""` = antes do 1º header). Linha de
 * header recebe `null`: não pertence a seção nenhuma.
 */
export function sectionKeyPerLine(md: string): Array<string | null> {
  let current = "";
  return md.split("\n").map((line) => {
    const key = sectionHeaderKey(line);
    if (key) {
      current = key;
      return null;
    }
    return current;
  });
}

/** Texto de cada seção do MD, por chave (seção repetida concatena). */
export function sectionTexts(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const keys = sectionKeyPerLine(md);
  md.split("\n").forEach((line, i) => {
    const key = keys[i];
    if (key === null) return;
    out.set(key, (out.get(key) ?? "") + line + "\n");
  });
  return out;
}
