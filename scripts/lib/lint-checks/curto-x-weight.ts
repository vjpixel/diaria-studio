/**
 * lint-checks/curto-x-weight.ts (#10180)
 *
 * Confere, antes do gate, que cada post da seção `# Curto` de `03-social.md`
 * (`## d1`/`## d2`/`## d3` e o 4º post `## um`, USE MELHOR) cabe nos 280
 * caracteres do X, pelo MESMO peso que `scripts/prep-twitter-posts.ts` aplica
 * no Stage 5 (`computeTwitterWeightedLength`, `lib/twitter-weight.ts`: cada
 * URL conta 23, quebras de linha e hashtags contam como caractere).
 *
 * Caso real (edição 261014): o `## um` saiu do `social-curto` com 283 de peso
 * X. Nenhum check do Stage 2 nem do gate do Stage 4 acusou; só o Stage 5
 * recusou o post (`skipped`, "sem truncagem silenciosa"), e ele teria ficado
 * de fora do X sem aviso.
 *
 * Reproduz as transformações do Stage 5 que mudam o peso:
 *   - `{edition_url}` ainda literal (estado normal até o Stage 5 resolver a
 *     URL) conta como uma URL, ou seja 23, e não como os 13 caracteres do
 *     placeholder;
 *   - no `## um`, a linha-marcador `{quebra}` vira linha em branco
 *     (`resolveUseMelhorCardBreaks`, o que `finalizeUseMelhorPostText` faz);
 *   - comentários HTML somem (`extractDestaqueBlock`) e o texto é aparado.
 * A UTM acrescentada no Stage 5 não muda o peso, porque a URL conta 23 com ou
 * sem query string.
 *
 * Seção `# Curto` ausente = nada a checar (ok). Outros checks cobrem a
 * ausência; este só mede o que existe.
 */

import { extractSection, extractDestaqueBlock } from "../extract-section.ts";
import { TWITTER_CHAR_LIMIT, computeTwitterWeightedLength } from "../twitter-weight.ts";
import { resolveUseMelhorCardBreaks } from "../use-melhor-card-break.ts";

/** URL qualquer pra fazer `{edition_url}` pesar como URL (23). */
const EDITION_URL_STAND_IN = "https://diar.ia.br/p/edicao";

export interface CurtoXWeightPost {
  /** `d1`, `d2`, `d3` ou `um`. */
  destaque: string;
  /** Peso X do texto como o Stage 5 o enviaria. */
  weighted: number;
}

export interface CurtoXWeightError extends CurtoXWeightPost {
  limit: number;
  /** Quantos caracteres cortar para caber. */
  excess: number;
  message: string;
}

export interface CurtoXWeightReport {
  ok: boolean;
  limit: number;
  posts: CurtoXWeightPost[];
  errors: CurtoXWeightError[];
}

/** Pure: texto do post como o Stage 5 o pesaria (sem a UTM, que não muda o peso). */
export function curtoPostTextForWeight(rawBlock: string, destaque: string): string {
  let text = rawBlock.trim().replaceAll("{edition_url}", EDITION_URL_STAND_IN);
  if (destaque === "um") text = resolveUseMelhorCardBreaks(text);
  return text;
}

export function checkCurtoXWeight(md: string): CurtoXWeightReport {
  const normalized = md.replace(/\r\n/g, "\n");
  const section = extractSection(normalized, "Curto");
  const posts: CurtoXWeightPost[] = [];
  const errors: CurtoXWeightError[] = [];
  if (section === null) return { ok: true, limit: TWITTER_CHAR_LIMIT, posts, errors };

  const seen = new Set<string>();
  for (const m of section.matchAll(/(?:^|\n)## (d\d+|um)[ \t]*(?=\n|$)/gi)) {
    const destaque = m[1].toLowerCase();
    if (seen.has(destaque)) continue;
    seen.add(destaque);
    const block = extractDestaqueBlock(section, destaque);
    if (block === null) continue;
    const text = curtoPostTextForWeight(block, destaque);
    if (text === "") continue;
    const weighted = computeTwitterWeightedLength(text);
    posts.push({ destaque, weighted });
    if (weighted > TWITTER_CHAR_LIMIT) {
      const excess = weighted - TWITTER_CHAR_LIMIT;
      errors.push({
        destaque,
        weighted,
        limit: TWITTER_CHAR_LIMIT,
        excess,
        message: `# Curto / ## ${destaque}: ${weighted} caracteres no peso do X (URL = 23), limite ${TWITTER_CHAR_LIMIT}. Corte ${excess} caractere(s); senão o Stage 5 pula o post no X.`,
      });
    }
  }
  return { ok: errors.length === 0, limit: TWITTER_CHAR_LIMIT, posts, errors };
}
