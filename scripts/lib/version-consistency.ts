/**
 * version-consistency.ts (#630, #603)
 *
 * Detecta inconsistência de versão DENTRO de um destaque — caso recorrente é
 * título "DeepSeek V4" mas corpo menciona "V5", "V6", "V7" (incidente edição
 * 260505 detectado por leitor → virou erro intencional de maio).
 *
 * Lógica determinística (substitui check 8 do prompt do review-test-email,
 * que dependia do Haiku seguir instrução textual — ver #588, #602).
 */

export interface VersionMention {
  /** Identifier do destaque (ex: "DESTAQUE 1", "DESTAQUE 2"). Vazio = fora de
   *  destaque (lançamentos, pesquisas, intro). */
  destaque: string;
  /** Versão mencionada — preserva case original (V4, GPT-5, Opus 4.7). */
  version: string;
  /** Versão normalizada (lowercase) pra agrupamento. */
  versionKey: string;
  /** Linha do source (1-indexed). */
  line: number;
  /** Snippet de contexto (até 80 chars antes/depois). */
  snippet: string;
}

export interface InconsistencyGroup {
  destaque: string;
  /** Mentions com `versionKey` distintos no mesmo destaque. */
  mentions: VersionMention[];
}

/**
 * Regex específico para versionamento V<digit> (caso primário do incidente
 * 260505 — Joshu detectou V4/V5/V6/V7 misturados no mesmo destaque).
 *
 * Match em V\d+ com possível decimal (V4, V12, V4.5). Lookbehind \b evita
 * match em "4 GB" ou "ano 2026". Case-sensitive (V maiúsculo) pra evitar
 * matches em URLs ou palavras como "interview".
 *
 * Brand context (DeepSeek V4) não é usado pra agrupar — destaque já agrupa.
 * Isso introduz risco baixo de FP (2 brands diferentes com V no mesmo
 * destaque) mas é raro em prática (destaque = 1 tópico, normalmente 1 brand).
 *
 * Issue #630 explicitamente menciona /V\d+/g como pattern do check 8.
 */
const VERSION_PATTERN = /\bV(\d+(?:\.\d+)?)\b/g;

/**
 * Pure: detecta o destaque corrente baseado em headers `DESTAQUE N`.
 * Retorna o último header visto (ou string vazia se não dentro de destaque).
 */
export function destaqueHeaderAt(line: string, current: string): string {
  // "DESTAQUE 1 | 🔒 SEGURANÇA" → "DESTAQUE 1" (plain ou **negrito** #590)
  const m = line.match(/^(?:\*\*)?DESTAQUE\s+(\d+)\b/i);
  if (m) return `DESTAQUE ${m[1]}`;
  // Sections que terminam um destaque: outras seções top-level (plain ou bold)
  if (/^(?:\*\*)?(LANÇAMENTOS|PESQUISAS|TUTORIAIS|OUTRAS NOTÍCIAS|É IA\?|---)/i.test(line.trim())) {
    return "";
  }
  return current;
}

/**
 * Pure: extrai todas as menções de versão por linha + destaque.
 */
export function extractVersionMentions(md: string): VersionMention[] {
  const mentions: VersionMention[] = [];
  const lines = md.split("\n");
  let currentDestaque = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentDestaque = destaqueHeaderAt(line, currentDestaque);

    // Reset regex state (g flag persiste entre exec calls)
    VERSION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = VERSION_PATTERN.exec(line)) !== null) {
      const version = match[0]; // ex: "V4", "V12.5"
      const versionKey = version.toLowerCase();
      const start = Math.max(0, match.index - 40);
      const end = Math.min(line.length, match.index + version.length + 40);
      const snippet = line.slice(start, end);
      mentions.push({
        destaque: currentDestaque,
        version,
        versionKey,
        line: i + 1,
        snippet,
      });
    }
  }

  return mentions;
}

/**
 * Pure: identifica inconsistências — grupos de menções no mesmo destaque com
 * `versionKey` distintos. Cada grupo retornado tem 2+ mentions.
 *
 * Mentions fora de destaque (destaque="") são ignoradas — diferentes versões
 * em LANÇAMENTOS é normal (cada lançamento é tópico independente).
 */
export function detectInconsistencies(mentions: VersionMention[]): InconsistencyGroup[] {
  const byDestaque = new Map<string, VersionMention[]>();
  for (const m of mentions) {
    if (!m.destaque) continue;
    const arr = byDestaque.get(m.destaque) ?? [];
    arr.push(m);
    byDestaque.set(m.destaque, arr);
  }

  const groups: InconsistencyGroup[] = [];
  for (const [destaque, group] of byDestaque) {
    // Identifica brand+series: "DeepSeek V4" e "V5" são inconsistentes (mesma
    // família). Já "GPT-5" e "Opus 4.7" no mesmo destaque é OK (brands
    // distintas). Heurística: agrupar por "primeira palavra após o número".
    //
    // Simplificação inicial: se há 2+ versionKey distintos, flag.
    // Refinamento depois se necessário (alguns FPs OK pra defense-in-depth).
    const distinct = new Set(group.map((m) => m.versionKey));
    if (distinct.size > 1) {
      groups.push({ destaque, mentions: group });
    }
  }
  return groups;
}
