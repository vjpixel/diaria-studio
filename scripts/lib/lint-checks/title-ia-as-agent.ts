/**
 * lint-checks/title-ia-as-agent.ts (#12106)
 *
 * Backstop editorial para a regra "quem age é o humano, a IA é o
 * instrumento" (`context/editorial-rules.md` §3). Caso que motivou: edição
 * 261104, D1 sobre o golpe da selfie saiu do writer como "IA usa seu
 * rosto..."; quem age são os criminosos, e o título final virou "Golpe da
 * selfie: criminosos usam IA para copiar seu rosto".
 *
 * ## Heurística
 *
 * Flagra um título de DESTAQUE quando as duas coisas acontecem juntas:
 *
 *   1. **"IA" em posição de sujeito**: o título (ou o trecho depois de `:`,
 *      `—` ou `–`) começa com `IA`, `A IA`, `Uma IA`, `Nova IA` ou
 *      `inteligência artificial`, seguido de uma palavra minúscula (o verbo
 *      candidato: "usa", "copia", "clona"). Adjetivos comuns logo depois da
 *      sigla ("IA generativa usa...") são pulados antes de olhar o verbo.
 *   2. **O corpo do destaque descreve ator humano**: cita criminosos,
 *      golpistas, fraudadores, estelionatários, quadrilha, bandidos, hackers
 *      ou golpe.
 *
 * Só (1) não basta: "IA da Meta lê seus e-mails" pode ser o produto agindo
 * de fato. Só (2) também não: o título pode já pôr o humano como sujeito.
 *
 * **WARN-ONLY**, mesmo molde de `ia-in-title.ts` (#4825) e do aviso de
 * título que diverge do corpo (#9383): é heurística léxica, não entende a
 * frase. O editor decide no gate da Etapa 4.
 */

import { HIGHLIGHT_HEADER_RE, SECTION_BREAK_LINE_RE, SECTION_HEADER_LINE_RE } from "./highlight-parsing.ts";
import { walkDestaqueTitles } from "./destaque-title-walk.ts";
import { looksLikeTitleOption } from "../title-heuristic.ts";

export interface TitleIaAsAgentError {
  /** Número do destaque (1/2/3). */
  destaque: number;
  /** Categoria do destaque (grupo 2 do header). */
  category: string;
  /** Número de linha no markdown (1-based). */
  line: number;
  /** Título flagrado. */
  title: string;
  /** Verbo candidato logo depois de "IA" (ex: "usa"). */
  verb: string;
  /** Termo de ator humano encontrado no corpo (ex: "criminosos"). */
  humanActor: string;
}

export interface TitleIaAsAgentReport {
  ok: boolean;
  errors: TitleIaAsAgentError[];
}

// Início de trecho com "IA" como sujeito. "IA" é case-sensitive (sigla), o
// determinante inicial aceita maiúscula ou minúscula.
const IA_SUBJECT_RE =
  /^(?:(?:[Aa]|[Uu]ma|[Nn]ova|[Ss]ua)\s+)?(?:IA|[Ii]ntelig(?:ê|e)ncia [Aa]rtificial)\s+(.+)$/u;

// Adjetivos que costumam vir colados à sigla e não são o verbo.
const ADJECTIVES_AFTER_IA = new Set([
  "generativa",
  "generativas",
  "agêntica",
  "agênticas",
  "chinesa",
  "americana",
  "nova",
  "própria",
  "aberta",
]);

const HUMAN_ACTOR_RE =
  /\b(criminos[oa]s?|golpistas?|fraudador(?:es|as?)?|estelionat[áa]ri[oa]s?|quadrilhas?|bandid[oa]s?|hackers?|golpes?)\b/iu;

/** Devolve o verbo candidato se o trecho começa com "IA" como sujeito. */
function iaSubjectVerb(segment: string): string | null {
  const m = segment.trim().match(IA_SUBJECT_RE);
  if (!m) return null;
  const words = m[1].split(/\s+/);
  for (const raw of words) {
    const word = raw.replace(/[^\p{L}-]/gu, "");
    if (word === "") return null;
    if (ADJECTIVES_AFTER_IA.has(word.toLowerCase())) continue;
    // Verbo candidato: palavra minúscula. Maiúscula = nome próprio
    // ("IA Gemini"), preposição "da/do/de" = complemento ("IA da Meta").
    if (!/^\p{Ll}/u.test(word)) return null;
    if (/^(?:da|do|de|das|dos|no|na|em|para|pra|e|ou)$/u.test(word)) return null;
    return word;
  }
  return null;
}

/** Testa o título inteiro e cada trecho depois de `:`, `—` ou `–`. */
export function findIaSubjectVerb(title: string): string | null {
  const segments = [title, ...title.split(/\s*[:—–]\s*/u).slice(1)];
  for (const seg of segments) {
    const verb = iaSubjectVerb(seg);
    if (verb) return verb;
  }
  return null;
}

/** Corpo do destaque: da linha `startIndex` até o próximo header/separador. */
function collectBody(lines: string[], startIndex: number, category: string): string {
  const body: string[] = [];
  for (let j = startIndex; j < lines.length; j++) {
    const t = lines[j].trim();
    if (HIGHLIGHT_HEADER_RE.test(t)) break;
    if (SECTION_BREAK_LINE_RE.test(t)) break;
    if (SECTION_HEADER_LINE_RE.test(t) && t !== category) break;
    body.push(t);
  }
  return body.join("\n");
}

/**
 * Flagra títulos de DESTAQUE com "IA" como sujeito que age quando o corpo
 * descreve um ator humano. WARN-ONLY (#12106): `ok: false` nunca deve virar
 * bloqueio de gate.
 */
export function checkTitleIaAsAgent(md: string): TitleIaAsAgentReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: TitleIaAsAgentError[] = [];

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(HIGHLIGHT_HEADER_RE);
    if (!m) {
      i++;
      continue;
    }
    const destaqueNum = parseInt(m[1], 10);
    const category = m[2].trim();
    const { titles, nextIndex } = walkDestaqueTitles(lines, i + 1, category, looksLikeTitleOption);
    const body = collectBody(lines, nextIndex, category);
    const actor = body.match(HUMAN_ACTOR_RE);
    if (actor) {
      for (const { title, line } of titles) {
        if (SECTION_HEADER_LINE_RE.test(title.trim())) continue;
        const verb = findIaSubjectVerb(title);
        if (verb) {
          errors.push({ destaque: destaqueNum, category, line, title, verb, humanActor: actor[1] });
        }
      }
    }
    i = Math.max(nextIndex, i + 1);
  }

  return { ok: errors.length === 0, errors };
}
