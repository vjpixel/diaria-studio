/**
 * intentional-error-scrub.ts (#13051)
 *
 * Regra do editor (13/11/2026): **o erro intencional da newsletter diária
 * nunca sai da edição em que foi plantado.** Ele existe só para o concurso
 * "ache o erro" daquela edição; todo produto que reaproveita o texto de uma
 * edição passada (Stack, retro semanal, LinkedIn semanal, seleção
 * compartilhada, mensal, anual) tem de usar a grafia correta.
 *
 * Caso real: a edição 261111 plantou "Appel" no lugar de "Apple" num título
 * do RADAR; o título com o erro foi copiado para a seleção da Stack, o
 * payload do post, o e-mail Kit e as prévias, e ia sair publicado na segunda.
 *
 * Duas peças:
 *   1. **Scrub** — `readReviewedMdScrubbed` / `scrubIntentionalError` trocam
 *      `wrong_value` por `correct_value` no texto lido da edição de origem.
 *      Todo consumidor que lê `02-reviewed.md` de edição passada passa por aqui.
 *   2. **Guard** — `findIntentionalErrorLeaks` acusa o `wrong_value` de
 *      qualquer edição da janela que ainda apareça no texto FINAL de um
 *      produto. Pega o consumidor novo que esquecer o helper (ou um texto que
 *      não vem do `02-reviewed.md`, como o copy de um agente).
 *
 * Fonte do gabarito: `_internal/intentional-error.json` da edição, com o
 * fallback de `data/intentional-errors.jsonl` (mesma ordem do
 * `/diaria-mes-erros`, `list-month-errors.ts`) para edições anteriores ao #3222.
 *
 * Casamento: palavra inteira (não troca "Large 3" dentro de "Large 30"),
 * sensível a maiúsculas (o erro plantado é uma grafia exata), e NUNCA dentro
 * de URL — um `wrong_value` numérico ("2025") não pode quebrar um link.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  intentionalErrorJsonPath,
  isIntentionalErrorPlaceholder,
  loadIntentionalErrorJson,
  loadIntentionalErrors,
  type IntentionalError,
} from "./intentional-errors.ts";
import { resolveEditionDir } from "./find-current-edition.ts";

/** Gabarito do erro intencional de UMA edição, já validado (não vazio, não placeholder). */
export interface IntentionalErrorPair {
  edition: string;
  wrong: string;
  correct: string;
}

/** Valor utilizável: string, não vazia, não placeholder `{PREENCHER...}`. */
function usable(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || isIntentionalErrorPlaceholder(t)) return null;
  return t;
}

/**
 * Pure: monta o par a partir de um registro (JSON da edição ou linha do JSONL).
 * `null` quando não há o que trocar: `no_error`, campo ausente/placeholder, ou
 * `wrong` igual a `correct`.
 */
export function pairFromRecord(
  edition: string,
  rec: { wrong_value?: unknown; correct_value?: unknown; no_error?: unknown } | null | undefined,
): IntentionalErrorPair | null {
  if (!rec || rec.no_error === true) return null;
  const wrong = usable(rec.wrong_value);
  const correct = usable(rec.correct_value);
  if (!wrong || !correct || wrong === correct) return null;
  return { edition, wrong, correct };
}

/**
 * Caminho de `data/intentional-errors.jsonl` a partir de um diretório de
 * edição (`data/editions/{AAMMDD}` ou `data/editions/{AAMM}/{AAMMDD}`): sobe
 * até o diretório `editions` e pega o irmão. `null` quando a edição não vive
 * sob um `editions/` (fixture solta) — aí não há fallback.
 */
export function jsonlPathForEditionDir(editionDir: string): string | null {
  let dir = editionDir;
  for (let i = 0; i < 4; i++) {
    if (basename(dir) === "editions") return join(dirname(dir), "intentional-errors.jsonl");
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Lê o gabarito de UMA edição. JSON da edição primeiro; se ele declara
 * `no_error`, vale (nada a trocar). Sem JSON utilizável, cai na entrada mais
 * recente da edição no JSONL (`jsonlEntries` injetável, para quem itera muitas
 * edições não reler o arquivo a cada uma). Nunca lança.
 */
export function loadIntentionalErrorPair(
  editionDir: string,
  edition: string,
  opts: { jsonlEntries?: readonly IntentionalError[]; jsonlPath?: string | null } = {},
): IntentionalErrorPair | null {
  const rec = loadIntentionalErrorJson(intentionalErrorJsonPath(editionDir));
  if (rec?.no_error === true) return null;
  const fromJson = pairFromRecord(edition, rec);
  if (fromJson) return fromJson;
  const entries =
    opts.jsonlEntries ??
    (() => {
      const p = opts.jsonlPath === undefined ? jsonlPathForEditionDir(editionDir) : opts.jsonlPath;
      return p ? loadIntentionalErrors(p) : [];
    })();
  const forEdition = entries.filter((e) => e.edition === edition);
  for (let i = forEdition.length - 1; i >= 0; i--) {
    const p = pairFromRecord(edition, forEdition[i]);
    if (p) return p;
  }
  return null;
}

/** URL crua (`https://…`) — trecho que o scrub e o guard pulam. */
const URL_RE = /https?:\/\/[^\s)<>\]"'`]+/gu;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Palavra inteira (vizinhos não podem ser letra/dígito), sensível a maiúsculas. */
function wholeWordRe(wrong: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(wrong)}(?![\\p{L}\\p{N}])`, "gu");
}

/** Aplica `fn` só aos trechos de `text` que não são URL. */
function mapOutsideUrls(text: string, fn: (chunk: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    out += fn(text.slice(last, start)) + m[0];
    last = start + m[0].length;
  }
  return out + fn(text.slice(last));
}

/** Pure: troca o `wrong` do par pelo `correct` (palavra inteira, fora de URL). */
export function scrubIntentionalError(text: string, pair: IntentionalErrorPair | null | undefined): string {
  if (!pair || !text) return text;
  const re = wholeWordRe(pair.wrong);
  return mapOutsideUrls(text, (chunk) => chunk.replace(re, () => pair.correct));
}

/**
 * Lê o `02-reviewed.md` de uma edição já sem o erro intencional dela.
 * Lança o mesmo erro de leitura do `readFileSync` (o chamador já trata
 * arquivo ausente antes). `read` é injetável para os chamadores que já
 * embrulham a leitura (`readUtf8WithContext`).
 */
export function readReviewedMdScrubbed(
  editionDir: string,
  edition: string,
  opts: { read?: (p: string, enc: "utf8") => string; jsonlEntries?: readonly IntentionalError[]; jsonlPath?: string | null } = {},
): string {
  const read = opts.read ?? ((p: string, enc: "utf8") => readFileSync(p, enc));
  const md = read(join(editionDir, "02-reviewed.md"), "utf8");
  return scrubIntentionalError(md, loadIntentionalErrorPair(editionDir, edition, opts));
}

/**
 * Entradas do `data/intentional-errors.jsonl` irmão de `editionsRootDir`
 * (`data/editions` → `data/intentional-errors.jsonl`), para quem itera muitas
 * edições ler o JSONL uma vez só. Ausente = `[]`. Só vale para uma raiz de
 * nome `editions` (o layout real): numa raiz de fixture qualquer
 * (`/tmp/xyz`), o "irmão" seria um arquivo alheio.
 */
export function loadJsonlForEditionsRoot(editionsRootDir: string): IntentionalError[] {
  if (basename(editionsRootDir) !== "editions") return [];
  const jsonlPath = join(dirname(editionsRootDir), "intentional-errors.jsonl");
  return existsSync(jsonlPath) ? loadIntentionalErrors(jsonlPath) : [];
}

/**
 * Gabaritos das edições de uma janela (`dates` em AAMMDD), para o guard.
 * Edição sem diretório ou sem erro declarado fica de fora. O JSONL é lido uma
 * vez só (`<editionsRoot>/../intentional-errors.jsonl`).
 */
export function loadWindowIntentionalErrors(
  editionsRootDir: string,
  dates: readonly string[],
): IntentionalErrorPair[] {
  const jsonlEntries = loadJsonlForEditionsRoot(editionsRootDir);
  const out: IntentionalErrorPair[] = [];
  for (const date of dates) {
    const pair = loadIntentionalErrorPair(resolveEditionDir(editionsRootDir, date), date, { jsonlEntries });
    if (pair) out.push(pair);
  }
  return out;
}

/** Ocorrência do erro intencional de uma edição no texto final de um produto. */
export interface IntentionalErrorLeak extends IntentionalErrorPair {
  count: number;
}

/**
 * Pure: o guard. Devolve cada par cujo `wrong` ainda aparece em `text`
 * (palavra inteira, fora de URL). Lista vazia = texto limpo.
 */
export function findIntentionalErrorLeaks(
  text: string,
  pairs: readonly IntentionalErrorPair[],
): IntentionalErrorLeak[] {
  if (!text) return [];
  const leaks: IntentionalErrorLeak[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    const key = `${p.edition}\u0000${p.wrong}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let count = 0;
    mapOutsideUrls(text, (chunk) => {
      count += [...chunk.matchAll(wholeWordRe(p.wrong))].length;
      return chunk;
    });
    if (count > 0) leaks.push({ ...p, count });
  }
  return leaks;
}

/** Pure: mensagem única para avisos/recusas do guard. */
export function formatIntentionalErrorLeaks(leaks: readonly IntentionalErrorLeak[], where: string): string {
  const parts = leaks.map((l) => `"${l.wrong}" (erro intencional da ${l.edition}; o correto é "${l.correct}", ${l.count}x)`);
  return (
    `${where}: erro intencional da diária vazou para o produto derivado — ${parts.join("; ")}. ` +
    "O erro só existe na edição em que foi plantado (#13051): corrija o texto (ou refaça a seleção) antes de publicar."
  );
}

/** Lança `Error` com a mensagem do guard quando há vazamento. */
export function assertNoIntentionalErrorLeak(
  text: string,
  pairs: readonly IntentionalErrorPair[],
  where: string,
): void {
  const leaks = findIntentionalErrorLeaks(text, pairs);
  if (leaks.length > 0) throw new Error(formatIntentionalErrorLeaks(leaks, where));
}
