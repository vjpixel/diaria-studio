/**
 * intentional-error-repeat.ts (#9101)
 *
 * Guard contra REPETIR o erro intencional de uma edição recente. Incidente
 * real: o Stage 2 de 260930 declarou "Anthropik" (Anthropic) — exatamente o
 * erro de 260928, que vários leitores já tinham acertado — e o proposer do
 * Stage 4 (`propose-intentional-error-candidate.ts`) sugeriu "Craude"
 * (Claude), já usado 3x em `data/intentional-errors.jsonl`. Repetir o erro
 * esvazia o concurso (leitor já sabe a resposta) e deixa o reveal ambíguo.
 *
 * Funções puras (exceto `checkIntentionalErrorNotRecentRepeat`, que lê o JSON
 * da edição e o jsonl): recebem o histórico já carregado (`loadIntentionalErrors`, fail-soft —
 * arquivo ausente = `[]`) e decide se um valor já foi usado.
 *
 * Premissa (#9101): janela default de 30 dias, injetável.
 */

import { basename, dirname, join, resolve } from "node:path";
import {
  intentionalErrorJsonPath,
  loadIntentionalErrorJson,
  loadIntentionalErrors,
  type IntentionalError,
} from "./intentional-errors.ts";
import type { InvariantViolation } from "./invariant-checks/types.ts";

export const DEFAULT_REPEAT_WINDOW_DAYS = 30;

/** Normaliza um valor pra comparação: sem aspas/pontuação, sem acento, minúsculo, espaços colapsados. */
export function normalizeErrorValue(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Extrai a grafia ERRADA de uma entry do histórico: `wrong_value` quando
 * presente (#7243); senão, deriva do `reveal` ("escrevi X onde/em vez de/no …")
 * — a maioria das entries antigas não tem `wrong_value`.
 */
export function extractWrongValue(entry: Pick<IntentionalError, "wrong_value" | "reveal">): string | null {
  if (entry.wrong_value && entry.wrong_value.trim()) return entry.wrong_value.trim();
  const reveal = entry.reveal;
  if (!reveal) return null;
  const quoted = reveal.match(/escrevi\s+["“]([^"”]+)["”]/i);
  if (quoted) return quoted[1].trim();
  const bare = reveal.match(
    /escrevi\s+(.+?)(?:\s+(?:onde|em vez de|no|na|nos|nas|em)\s|\s*,|\s*\.\s*$|$)/i,
  );
  return bare && bare[1].trim() ? bare[1].trim() : null;
}

/** AAMMDD → Date (UTC). Retorna null em input malformado. */
function editionToDate(edition: string): Date | null {
  if (!/^\d{6}$/.test(edition)) return null;
  const y = 2000 + Number(edition.slice(0, 2));
  const m = Number(edition.slice(2, 4));
  const d = Number(edition.slice(4, 6));
  const date = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Match por palavra inteira em qualquer direção ("Craude" casa "Craude Opus 4.8"). */
function valuesOverlap(a: string, b: string): boolean {
  const na = normalizeErrorValue(a);
  const nb = normalizeErrorValue(b);
  if (!na || !nb) return false;
  return ` ${na} `.includes(` ${nb} `) || ` ${nb} `.includes(` ${na} `);
}

export interface RepeatMatch {
  field: "wrong_value" | "correct_value";
  value: string;
  edition: string;
  past_value: string;
}

export interface FindRepeatOptions {
  /** Janela em dias antes da edição de referência (default 30). `Infinity` = histórico inteiro. */
  windowDays?: number;
}

/**
 * Pure: entries do histórico que reusam `wrong_value` ou `correct_value` dentro
 * da janela ANTERIOR a `refEdition` (a própria edição é excluída — resume após
 * sync não pode acusar a si mesma). Entries `no_error` são ignoradas.
 */
export function findRecentRepeats(
  candidate: { wrong_value?: string | null; correct_value?: string | null },
  history: IntentionalError[],
  refEdition: string,
  opts: FindRepeatOptions = {},
): RepeatMatch[] {
  const windowDays = opts.windowDays ?? DEFAULT_REPEAT_WINDOW_DAYS;
  const ref = editionToDate(refEdition);
  const out: RepeatMatch[] = [];
  for (const entry of history) {
    if (entry.no_error || entry.edition === refEdition) continue;
    const when = editionToDate(entry.edition);
    if (ref && when) {
      const ageDays = (ref.getTime() - when.getTime()) / 86_400_000;
      if (ageDays < 0 || ageDays > windowDays) continue;
    } else if (Number.isFinite(windowDays)) {
      continue; // sem data comparável não dá pra afirmar que está na janela
    }
    const pastWrong = extractWrongValue(entry);
    if (candidate.wrong_value && pastWrong && valuesOverlap(candidate.wrong_value, pastWrong)) {
      out.push({ field: "wrong_value", value: candidate.wrong_value, edition: entry.edition, past_value: pastWrong });
    }
    if (candidate.correct_value && entry.correct_value && valuesOverlap(candidate.correct_value, entry.correct_value)) {
      out.push({ field: "correct_value", value: candidate.correct_value, edition: entry.edition, past_value: entry.correct_value });
    }
  }
  return out;
}

/**
 * Deriva `data/intentional-errors.jsonl` a partir do diretório da edição
 * (flat `data/editions/AAMMDD` ou nested `data/editions/AAMM/AAMMDD`): sobe até
 * o ancestral `editions` e usa o irmão dele. Null quando não há `editions` no path.
 */
export function intentionalErrorsJsonlPathForEditionDir(editionDir: string): string | null {
  let dir = editionDir;
  for (let i = 0; i < 4; i++) {
    const parent = dirname(dir);
    if (basename(dir) === "editions") return join(parent, "intentional-errors.jsonl");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * #9101: o erro intencional declarado em `_internal/intentional-error.json` não
 * pode reusar `wrong_value`/`correct_value` (normalizado) de uma edição dos
 * últimos 30 dias em `data/intentional-errors.jsonl` — incidente 260930 repetiu
 * "Anthropik" de 260928. Fail-soft: JSON ausente/placeholder, jsonl ausente ou
 * `no_error` → sem violação (outros checks cobrem ausência).
 * `history`/`windowDays` injetáveis pra teste. Registrado no Stage 2 e no
 * Stage 4 (o erro pode ser preenchido só no gate, via proposer).
 */
export function checkIntentionalErrorNotRecentRepeat(
  editionDir: string,
  opts: { history?: IntentionalError[]; windowDays?: number; ruleId?: string } = {},
): InvariantViolation[] {
  const jsonPath = intentionalErrorJsonPath(editionDir);
  const record = loadIntentionalErrorJson(jsonPath);
  if (!record || record.no_error === true) return [];
  const clean = (v: string | undefined): string | undefined =>
    v && v.trim() && !v.includes("{PREENCHER}") ? v : undefined;
  const correct_value = clean(record.correct_value);
  const wrong_value = clean(record.wrong_value) ?? clean(extractWrongValue(record) ?? undefined);
  if (!correct_value && !wrong_value) return [];

  let history = opts.history;
  if (!history) {
    const jsonlPath = intentionalErrorsJsonlPathForEditionDir(resolve(editionDir));
    history = jsonlPath ? loadIntentionalErrors(jsonlPath) : [];
  }
  const windowDays = opts.windowDays ?? DEFAULT_REPEAT_WINDOW_DAYS;
  const edition = basename(resolve(editionDir));
  const matches = findRecentRepeats({ wrong_value, correct_value }, history, edition, { windowDays });
  return matches.map((m) => ({
    rule: opts.ruleId ?? "intentional-error-not-recent-repeat",
    message:
      `erro intencional repete ${m.field}="${m.value}" já usado na edição ${m.edition} ` +
      `("${m.past_value}", janela de ${windowDays} dias) — leitores já sabem a resposta; ` +
      `escolha outra entidade/grafia (#9101)`,
    source_issue: "#9101",
    severity: "error" as const,
    file: jsonPath,
  }));
}
