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
 * sem distinguir maiúsculas para grafia errada de nome ("APPEL" num título em
 * caixa alta também é o erro, #13105 item 4; o scrub devolve o correto na
 * caixa da ocorrência), sensível a maiúsculas para valor ambíguo, e NUNCA
 * dentro de URL — um `wrong_value` numérico ("2025") não pode quebrar um link.
 *
 * Valor AMBÍGUO (#13105): número ou palavra curta (`isAmbiguousWrongValue`)
 * pode aparecer de forma legítima em outro item ("2025" numa data). Para ele o
 * scrub só troca a ocorrência que dá pra atribuir ao erro (única no texto, ou
 * única na seção de `location`), e o guard escopado só AVISA, nunca recusa.
 *
 * #13223: quem decide se o valor é ambíguo é a `category` do registro, não só
 * a forma da string (`isAmbiguousPair`). Só grafia (`ortografico`/`spelling`)
 * é "nome escrito errado, que nunca aparece de forma legítima". Erro de
 * `attribution`/`factual`/… troca um nome REAL e bem escrito por outro
 * ("Sonnet" no lugar de "Haiku", 261008): o nome plantado aparece de forma
 * legítima no resto do texto e é tratado como ambíguo.
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
import { sectionKeyFromLocation, sectionKeyPerLine } from "./intentional-error-sections.ts";

/** Gabarito do erro intencional de UMA edição, já validado (não vazio, não placeholder). */
export interface IntentionalErrorPair {
  edition: string;
  wrong: string;
  correct: string;
  /**
   * #13105: onde o erro foi plantado, em texto livre ("RADAR, item …",
   * "DESTAQUE 2"). Vem de `location` (JSON da edição), do `destaque` numérico
   * ou do `detail`/`description`. Escopa o scrub de valor ambíguo à seção.
   */
  location?: string;
  /**
   * #13223: `category` (JSON da edição) ou `error_type` (JSONL). Decide se o
   * `wrong` é grafia errada (troca em qualquer caixa, guard recusa) ou nome
   * real trocado (ambíguo). Ausente = registro sem categoria: vale só a forma
   * da string, como antes do #13223.
   */
  category?: string;
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
  rec:
    | {
        wrong_value?: unknown;
        correct_value?: unknown;
        no_error?: unknown;
        location?: unknown;
        category?: unknown;
        error_type?: unknown;
        destaque?: unknown;
        detail?: unknown;
        description?: unknown;
      }
    | null
    | undefined,
): IntentionalErrorPair | null {
  if (!rec || rec.no_error === true) return null;
  const wrong = usable(rec.wrong_value);
  const correct = usable(rec.correct_value);
  if (!wrong || !correct || wrong === correct) return null;
  const location =
    usable(rec.location) ??
    (typeof rec.destaque === "number" ? `DESTAQUE ${rec.destaque}` : null) ??
    usable(rec.detail) ??
    usable(rec.description);
  const category = usable(rec.category) ?? usable(rec.error_type);
  return { edition, wrong, correct, ...(location ? { location } : {}), ...(category ? { category } : {}) };
}

/**
 * Pure (#13105): o `wrong_value` pode aparecer de forma legítima em outro
 * trecho? Número (tem dígito: ano, cifra, versão) ou palavra curta (até 3
 * caracteres). Grafia errada de nome ("Appel", "Gemeni", "MTER") não é.
 */
export function isAmbiguousWrongValue(wrong: string): boolean {
  const w = wrong.trim();
  return /\p{N}/u.test(w) || [...w].length <= 3;
}

/** Categorias de grafia errada (#13223), já sem acento e em minúsculas. */
const SPELLING_CATEGORIES = new Set(["ortografico", "ortografia", "spelling", "grafia", "typo"]);

/** Categoria sem acento, minúsculas; `null` para ausente ou `unknown` (registro sem categoria). */
function normalizedCategory(category: string | undefined): string | null {
  if (!category) return null;
  const c = category.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
  return c && c !== "unknown" ? c : null;
}

/**
 * Pure (#13223): o par é ambíguo (o `wrong` pode aparecer de forma legítima no
 * texto)? Número ou palavra curta sempre é (`isAmbiguousWrongValue`). Com
 * categoria declarada, só grafia (`ortografico`/`spelling`) deixa de ser:
 * `attribution`/`factual`/… trocam um nome real por outro, e o nome plantado
 * existe de forma legítima no resto da edição. Sem categoria, vale só a forma
 * da string.
 */
export function isAmbiguousPair(pair: Pick<IntentionalErrorPair, "wrong" | "category">): boolean {
  if (isAmbiguousWrongValue(pair.wrong)) return true;
  const cat = normalizedCategory(pair.category);
  return cat !== null && !SPELLING_CATEGORIES.has(cat);
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

/**
 * Palavra inteira (vizinhos não podem ser letra/dígito).
 *
 * #13105 item 4: grafia errada de nome ("Appel") casa também em outra caixa
 * ("APPEL" num título em caixa alta, "appel" num slug de texto) — senão a
 * variante escapa do scrub e do guard. Valor AMBÍGUO (número, palavra curta)
 * segue sensível a maiúsculas: "Mau" no começo de frase não é o "mau" plantado.
 * #13223: nome real trocado (`attribution`…) também é ambíguo e sensível a
 * maiúsculas.
 */
function wholeWordRe(pair: Pick<IntentionalErrorPair, "wrong" | "category">): RegExp {
  const flags = isAmbiguousPair(pair) ? "gu" : "giu";
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(pair.wrong)}(?![\\p{L}\\p{N}])`, flags);
}

/**
 * Pure (#13105 item 4): o `correct` na caixa da ocorrência casada. Igual ao
 * `wrong` → `correct` como declarado; toda em maiúsculas → `correct` em
 * maiúsculas; toda em minúsculas → em minúsculas; só a inicial maiúscula →
 * inicial maiúscula. Caixa mista que não é nenhuma dessas → `correct` como
 * declarado.
 */
export function correctInMatchCase(match: string, wrong: string, correct: string): string {
  if (match === wrong) return correct;
  const hasLetter = /\p{L}/u.test(match);
  if (hasLetter && match === match.toUpperCase()) return correct.toUpperCase();
  if (hasLetter && match === match.toLowerCase()) return correct.toLowerCase();
  const [first = "", ...rest] = [...match];
  const restStr = rest.join("");
  if (first === first.toUpperCase() && restStr === restStr.toLowerCase()) {
    const [cf = "", ...cr] = [...correct.toLowerCase()];
    return cf.toUpperCase() + cr.join("");
  }
  return correct;
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

/** Nº de ocorrências do `wrong` do par em `text` (palavra inteira, fora de URL). */
export function countIntentionalErrorOccurrences(
  text: string,
  pair: Pick<IntentionalErrorPair, "wrong" | "category">,
): number {
  let count = 0;
  mapOutsideUrls(text, (chunk) => {
    count += [...chunk.matchAll(wholeWordRe(pair))].length;
    return chunk;
  });
  return count;
}

const countOutsideUrls = countIntentionalErrorOccurrences;

/**
 * Pure: troca o `wrong` do par pelo `correct` (palavra inteira, fora de URL).
 *
 * #13105: o erro foi plantado UMA vez, mas o mesmo valor pode existir de forma
 * legítima em outro item. Regra:
 *   - 1 ocorrência no texto → troca (é o erro);
 *   - várias, valor não ambíguo ("Appel", grafia) → troca todas (grafia
 *     errada não aparece de forma legítima);
 *   - várias, valor ambíguo ("2025", ou nome real trocado como "Sonnet" no
 *     lugar de "Haiku", #13223 — `isAmbiguousPair`) → troca só se a seção de `location`
 *     (`sectionKeyFromLocation`) tem exatamente 1 ocorrência; senão deixa o
 *     texto como está — melhor o guard avisar do que corromper a data certa
 *     de outro item.
 */
export function scrubIntentionalError(text: string, pair: IntentionalErrorPair | null | undefined): string {
  if (!pair || !text) return text;
  const re = wholeWordRe(pair);
  const replaceAll = (t: string) =>
    mapOutsideUrls(t, (chunk) => chunk.replace(re, (m) => correctInMatchCase(m, pair.wrong, pair.correct)));
  const total = countOutsideUrls(text, pair);
  if (total === 0) return text;
  if (total === 1 || !isAmbiguousPair(pair)) return replaceAll(text);
  const key = sectionKeyFromLocation(pair.location);
  if (!key) return text;
  const lines = text.split("\n");
  const keys = sectionKeyPerLine(text);
  const inSection = lines.reduce((n, line, i) => (keys[i] === key ? n + countOutsideUrls(line, pair) : n), 0);
  if (inSection !== 1) return text;
  return lines.map((line, i) => (keys[i] === key ? replaceAll(line) : line)).join("\n");
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
    const count = countOutsideUrls(text, p);
    if (count > 0) leaks.push({ ...p, count });
  }
  return leaks;
}

/** Trecho do texto final de um produto, com a edição de origem (`null` = sem origem: abertura, fecho, copy). */
export interface EditionTextSegment {
  edition: string | null;
  text: string;
}

/** Textos de um item do produto que vieram de uma edição (`edition` ausente = sem origem conhecida). */
export interface AttributedTexts {
  edition: string | null | undefined;
  texts: ReadonlyArray<string | null | undefined>;
}

function htmlEscaped(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Pure (#13105): parte o texto final de um produto em trechos por edição. Cada
 * texto de item vira um trecho da edição dele; o resto do texto final (com os
 * textos de item tirados, crus ou com escape HTML) vira o trecho sem origem.
 * Texto de item que o render reescreveu e não dá para tirar fica no resto —
 * aí o guard o trata como sem origem (mais rígido, nunca mais frouxo).
 *
 * #13112: só vira trecho o texto de item que APARECE no texto final (cru ou
 * com escape HTML; inteiro, ou as linhas dele que o render manteve). Campo
 * da seleção que o render não publica (`why` de Lançamentos/Use melhor/Radar,
 * item excluído, corpo trocado pelo `stackNote`) não conta: o erro ali não
 * sai para o leitor e não pode recusar o envio.
 */
export function segmentTextByEdition(fullText: string, items: readonly AttributedTexts[]): EditionTextSegment[] {
  const segments: EditionTextSegment[] = [];
  let rest = fullText;
  const attributed = items.flatMap((it) =>
    it.texts
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      .map((text) => ({ edition: it.edition ? it.edition : null, text })),
  );
  const rendered = (f: string) => fullText.includes(f) || fullText.includes(htmlEscaped(f));
  // O render costuma partir o corpo em parágrafos ou juntar as linhas: tira
  // também cada linha e a versão com espaços colapsados.
  const variants = new Set<string>();
  for (const a of attributed) {
    // Linha curta solta ("2025") não sai do resto: tiraria o mesmo valor do
    // texto sem origem (a abertura), onde ele é vazamento de verdade.
    const collapsed = a.text.replace(/\s+/g, " ").trim();
    const lines = a.text.split("\n").map((l) => l.trim()).filter((f) => f.length >= 12);
    const parts = [collapsed, ...lines].filter((f) => f.length >= 12);
    if (rendered(a.text)) segments.push({ edition: a.edition, text: a.text });
    else if (collapsed.length >= 12 && rendered(collapsed)) segments.push({ edition: a.edition, text: collapsed });
    else {
      const kept = lines.filter(rendered);
      if (kept.length > 0) segments.push({ edition: a.edition, text: kept.join("\n") });
    }
    for (const f of [a.text, ...parts]) {
      if (!f) continue;
      variants.add(f);
      variants.add(htmlEscaped(f));
    }
  }
  // Mais longos primeiro: um título contido no corpo de outro item não pode
  // quebrar a remoção do corpo.
  for (const v of [...variants].sort((x, y) => y.length - x.length)) rest = rest.split(v).join("\n");
  segments.push({ edition: null, text: rest });
  return segments;
}

/** Resultado do guard escopado: `blocking` recusa o envio; `advisory` só avisa. */
export interface ScopedIntentionalErrorLeaks {
  blocking: IntentionalErrorLeak[];
  advisory: IntentionalErrorLeak[];
}

/**
 * Pure (#13105): o guard escopado. O `wrong` de cada edição só é procurado nos
 * trechos DAQUELA edição e nos sem origem — nunca no item de outra edição, onde
 * o mesmo valor pode ser legítimo ("2025" no título de outro dia). Valor
 * ambíguo (`isAmbiguousPair`: número, palavra curta, ou nome real trocado,
 * #13223) vai para `advisory`: a Stack de segunda
 * 06:00 roda sem ninguém olhando e não pode travar por um falso positivo.
 */
export function findScopedIntentionalErrorLeaks(
  segments: readonly EditionTextSegment[],
  pairs: readonly IntentionalErrorPair[],
): ScopedIntentionalErrorLeaks {
  const out: ScopedIntentionalErrorLeaks = { blocking: [], advisory: [] };
  const seen = new Set<string>();
  for (const p of pairs) {
    const key = `${p.edition}\u0000${p.wrong}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const count = segments
      .filter((s) => s.edition === null || s.edition === p.edition)
      .reduce((n, s) => n + (s.text ? countOutsideUrls(s.text, p) : 0), 0);
    if (count === 0) continue;
    (isAmbiguousPair(p) ? out.advisory : out.blocking).push({ ...p, count });
  }
  return out;
}

/**
 * Pure (#13105): aviso do guard escopado para valor ambíguo — não recusa,
 * só pede conferência (o número/palavra pode ser legítimo no texto).
 */
export function formatIntentionalErrorAdvisory(leaks: readonly IntentionalErrorLeak[], where: string): string {
  const parts = leaks.map((l) => `"${l.wrong}" (erro intencional da ${l.edition}; o correto é "${l.correct}", ${l.count}x)`);
  return (
    `${where}: o valor do erro intencional aparece no texto — ${parts.join("; ")}. ` +
    "O valor pode aparecer de forma legítima (número, palavra curta ou nome real trocado por outro), então não recusa o envio (#13105, #13223): confira se não é o erro da edição."
  );
}

/**
 * Edições (AAMMDD) de um `raw-destaques.json` (mensal ou anual: `destaques[].edition`).
 * Arquivo ausente ou ilegível = `[]` (o guard do texto final fica sem gabarito,
 * e quem chama avisa). Nunca lança.
 */
export function editionsFromRawDestaques(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { destaques?: Array<{ edition?: unknown }> };
    const set = new Set<string>();
    for (const d of parsed.destaques ?? []) {
      if (typeof d?.edition === "string" && /^\d{6}$/.test(d.edition)) set.add(d.edition);
    }
    return [...set].sort();
  } catch {
    return [];
  }
}

/**
 * Pure (#13105 item 3): guard do texto FINAL de um produto que reescreve as
 * edições (mensal, mensal-apoiadores, anual). O writer funde vários itens num
 * texto só, então não há como atribuir trecho a edição: o texto inteiro conta
 * como sem origem. Grafia errada de nome (`blocking`) não aparece de forma
 * legítima; valor ambíguo (`advisory`) só avisa, como no guard escopado.
 */
export function findDraftIntentionalErrorLeaks(
  text: string,
  pairs: readonly IntentionalErrorPair[],
): ScopedIntentionalErrorLeaks {
  return findScopedIntentionalErrorLeaks([{ edition: null, text }], pairs);
}

/** Pure: mensagem única para avisos/recusas do guard. */
export function formatIntentionalErrorLeaks(leaks: readonly IntentionalErrorLeak[], where: string): string {
  const parts = leaks.map((l) => `"${l.wrong}" (erro intencional da ${l.edition}; o correto é "${l.correct}", ${l.count}x)`);
  return (
    `${where}: erro intencional da diária vazou para o produto derivado — ${parts.join("; ")}. ` +
    "O erro só existe na edição em que foi plantado (#13051): corrija o texto (ou refaça a seleção) antes de publicar."
  );
}
