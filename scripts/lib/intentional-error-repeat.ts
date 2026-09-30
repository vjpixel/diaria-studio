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

/** Valores que significam "sem valor" (placeholder/"não há erro") — nunca comparados. */
const PLACEHOLDER_RE = /^\s*(?:\{PREENCHER\}|n\/?a|-+|não há erro.*|nao ha erro.*)?\s*$/i;

/**
 * Núcleo comparável de um valor: remove parênteses e a cauda "não X"
 * (`"Anthropic (não \"Anthropik\")"`, `"SpaceX (não Microsoft)…"`, `"é da Meta, não do Google"`),
 * porque ali a entidade citada é o lado ERRADO. Null para placeholder.
 */
export function valueCore(value: string | null | undefined): string | null {
  if (!value || PLACEHOLDER_RE.test(value) || value.includes("{PREENCHER}")) return null;
  const core = value
    .replace(/\([^)]*\)/g, " ")
    .replace(/[,;—–-]?\s*\bn[ãa]o\b.*$/i, " ")
    .trim();
  return core && !PLACEHOLDER_RE.test(core) ? core : null;
}

/** Limite de tokens pra aceitar match por contenção (acima disso é frase, só igualdade). */
const MAX_CONTAINMENT_TOKENS = 4;

/**
 * Extrai a grafia ERRADA de uma entry do histórico: `wrong_value` quando
 * presente (#7243); senão, deriva do `reveal` ("escrevi X onde/em vez de/no …")
 * — a maioria das entries antigas não tem `wrong_value`. Captura sem aspas que
 * vira frase (`escrevi que …`, > 4 palavras) é descartada: não é uma grafia.
 */
export function extractWrongValue(entry: Pick<IntentionalError, "wrong_value" | "reveal">): string | null {
  if (entry.wrong_value && entry.wrong_value.trim()) return entry.wrong_value.trim();
  const reveal = entry.reveal;
  if (!reveal) return null;
  const quoted = reveal.match(/escrevi\s+[*_]*["“'‘«]([^"”'’»]+)["”'’»]/i);
  if (quoted) return quoted[1].trim();
  const bare = reveal.match(
    /escrevi\s+(.+?)(?:\s+(?:onde|em vez de|no|na|nos|nas|em)\s|\s*,\s|\s*\.\s*$|$)/i,
  );
  const value = bare?.[1]?.replace(/[*_]/g, "").trim();
  if (!value || /^que\s/i.test(value)) return null;
  if (normalizeErrorValue(value).split(" ").length > MAX_CONTAINMENT_TOKENS) return null;
  return value;
}

/** AAMMDD → Date (UTC). Retorna null em input malformado. */
export function editionToDate(edition: string): Date | null {
  if (!/^\d{6}$/.test(edition)) return null;
  const y = 2000 + Number(edition.slice(0, 2));
  const m = Number(edition.slice(2, 4));
  const d = Number(edition.slice(4, 6));
  const date = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Match por palavra inteira em qualquer direção ("Craude" casa "Craude Opus 4.8"),
 * só quando os dois lados são curtos (≤ 4 palavras); frase longa exige igualdade.
 */
function valuesOverlap(a: string, b: string): boolean {
  const ca = valueCore(a);
  const cb = valueCore(b);
  if (!ca || !cb) return false;
  const na = normalizeErrorValue(ca);
  const nb = normalizeErrorValue(cb);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const longest = Math.max(na.split(" ").length, nb.split(" ").length);
  if (longest > MAX_CONTAINMENT_TOKENS) return false;
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
  const rule = opts.ruleId ?? "intentional-error-not-recent-repeat";
  const jsonPath = intentionalErrorJsonPath(editionDir);
  const record = loadIntentionalErrorJson(jsonPath);
  if (!record || record.no_error === true) return [];
  const correct_value = valueCore(record.correct_value) ? record.correct_value : undefined;
  const wrongRaw = record.wrong_value ?? extractWrongValue(record) ?? undefined;
  const wrong_value = valueCore(wrongRaw) ? wrongRaw : undefined;
  if (!correct_value && !wrong_value) return [];

  let history = opts.history;
  if (!history) {
    const jsonlPath = intentionalErrorsJsonlPathForEditionDir(resolve(editionDir));
    history = jsonlPath ? loadIntentionalErrors(jsonlPath) : [];
  }
  if (history.length === 0) return [];
  const windowDays = opts.windowDays ?? DEFAULT_REPEAT_WINDOW_DAYS;
  const edition = basename(resolve(editionDir));
  if (!editionToDate(edition)) {
    return [
      {
        rule,
        message: `não foi possível checar repetição do erro intencional: diretório "${edition}" não é AAMMDD (#9101)`,
        source_issue: "#9101",
        severity: "warning",
        file: jsonPath,
      },
    ];
  }
  const matches = findRecentRepeats({ wrong_value, correct_value }, history, edition, { windowDays });
  const out: InvariantViolation[] = [];
  for (const field of ["wrong_value", "correct_value"] as const) {
    const hits = matches.filter((m) => m.field === field);
    if (hits.length === 0) continue;
    const refs = hits.map((m) => `${m.edition} ("${m.past_value}")`).join(", ");
    // Grafia errada repetida = leitor já sabe a resposta → bloqueia. Mesma entidade
    // com grafia NOVA é mais fraco (e comum no histórico) → aviso pro gate.
    const blocking = field === "wrong_value";
    out.push({
      rule,
      message:
        `erro intencional repete ${field}="${hits[0].value}" já usado em ${refs} (janela de ` +
        `${windowDays} dias) — ${blocking ? "leitores já sabem a resposta; troque a grafia/entidade" : "mesma entidade de um erro recente; prefira outra"} (#9101)`,
      source_issue: "#9101",
      severity: blocking ? "error" : "warning",
      file: jsonPath,
    });
  }
  return out;
}
