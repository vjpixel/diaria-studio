/**
 * stage4-docs-sync.ts (#9964)
 *
 * Miolo do documento editável do gate do Stage 4 (Claude Docs). Decisão do
 * editor (12/10/2026, registrada na #9964): o documento sai SEMPRE no Stage 4
 * (aditivo aos previews HTML, só para o TEXTO), com sync automático de volta
 * para `02-reviewed.md`/`03-social.md`. Condição: o repo segue fonte de
 * verdade — o sync de volta DETECTA e ACUSA conflito, nunca sobrescreve em
 * silêncio.
 *
 * Scripts TS não chamam o conector Claude Docs (é MCP do top-level). O fluxo é:
 *   1. `render` gera o markdown do doc a partir dos arquivos e grava a BASE
 *      (snapshot do que foi enviado ao doc) em `_internal/04-docs-gate.json`;
 *      o top-level cria/substitui o doc com esse markdown.
 *   2. O top-level exporta o doc (markdown) para um arquivo e chama `apply`,
 *      que faz o merge de 3 vias por arquivo: BASE × DOC × arquivo ATUAL.
 *
 * ── Formato do doc ──────────────────────────────────────────────────────────
 * Cada arquivo vai entre duas linhas-sentinela:
 *
 *   === INÍCIO 02-reviewed (não edite esta linha) ===
 *   ...conteúdo...
 *   === FIM 02-reviewed (não edite esta linha) ===
 *
 * Por que linhas de texto e não comentário HTML: um editor rich-text descarta
 * `<!-- -->` na importação, e o export nunca o devolve. Uma linha de parágrafo
 * comum sobrevive ao round-trip markdown → doc → markdown. O nome do arquivo
 * vai SEM a extensão `.md` de propósito: `.md` é TLD (Moldávia) e um
 * autolinker transformaria `02-reviewed.md` em link. O parser é tolerante ao
 * que um export pode fazer com a linha (escapes `\=`/`\-`/`\_`, ênfase em
 * volta, `#` de heading, acento perdido em INÍCIO/não) — ver
 * `matchSentinel`. Começar com `===` não vira heading setext porque a linha
 * tem texto além dos `=` e é sempre cercada por linhas em branco.
 *
 * ── Normalização (só para COMPARAR) ─────────────────────────────────────────
 * `normalizeLine` neutraliza o que um export markdown tipicamente introduz sem
 * que o editor tenha mexido no texto:
 *   - fim de linha CRLF/LF, espaços finais, espaços repetidos, NBSP;
 *   - escapes de pontuação ASCII do CommonMark (`\*`, `\_`, `\#`, `\[`, `\]`,
 *     `\(`, `\)`, `\-`, `\+`, `\.`, `\!`, `\|`, `\>`, `\<`, `\$`, `\~`, `` \` ``,
 *     `\=`, `\&`, ...);
 *   - entidades HTML `&amp;` `&lt;` `&gt;` `&quot;` `&#39;` `&nbsp;`;
 *   - ênfase `__x__`/`_x_` ≡ `**x**`/`*x*`;
 *   - marcador de lista `*`/`+` ≡ `-`, lista ordenada `1)` ≡ `1.`;
 *   - quebra temática `***`/`___`/`* * *` ≡ `---`;
 *   - link `<url>` ≡ `[url](url)` ≡ `url` (URL nua);
 * e, no nível do bloco, linhas em branco repetidas/no fim e quebra de linha
 * "mole" dentro de um parágrafo (o export pode juntar ou re-quebrar linhas de
 * um mesmo parágrafo) — ver `isCosmeticHunk`.
 *
 * ── Merge sem corromper o arquivo ───────────────────────────────────────────
 * O conteúdo do doc NUNCA é gravado inteiro. `mergeDocOnto` faz um diff por
 * linha (LCS sobre as linhas normalizadas) entre o arquivo-alvo e o doc:
 * trecho igual (ou diferença só cosmética) mantém os bytes ORIGINAIS do
 * arquivo; só os trechos realmente editados no doc são trocados pelo texto do
 * doc, des-escapado de forma conservadora (`unescapeForWrite`). Sem edição, o
 * arquivo fica byte a byte igual. Linha editada que não dá para des-escapar com
 * segurança (`\\`, tag HTML crua, bloco `<?claude ...?>` do Docs) →
 * `unsafe`, que o `apply` trata como CONFLITO em vez de arriscar gravar.
 *
 * Limite conhecido (documentado, não silencioso): diferença SÓ de linhas em
 * branco entre parágrafos é tratada como cosmética. Num editor rich-text,
 * juntar dois parágrafos muda o texto da linha (o que É detectado como
 * edição), então a única fonte prática de diferença só-de-branco é o próprio
 * export.
 *
 * @see .claude/agents/orchestrator-stage-4.md §4b (criação do doc), §4d
 *   (apply antes de cada apresentação), §4e (último apply antes do sentinel)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

// ─── Constantes ──────────────────────────────────────────────────────────────

/** Arquivos sincronizados, na ordem em que aparecem no doc. */
export const SYNC_FILES = ["02-reviewed.md", "03-social.md"] as const;
export type SyncFile = (typeof SYNC_FILES)[number];

/** Rótulo do arquivo nas linhas-sentinela (sem `.md`, ver docblock). */
export function sentinelLabel(file: SyncFile): string {
  return file.replace(/\.md$/, "");
}

export function beginSentinel(file: SyncFile): string {
  return `=== INÍCIO ${sentinelLabel(file)} (não edite esta linha) ===`;
}

export function endSentinel(file: SyncFile): string {
  return `=== FIM ${sentinelLabel(file)} (não edite esta linha) ===`;
}

export const STATE_FILENAME = "04-docs-gate.json";
export const DOC_MD_FILENAME = "04-docs-gate.md";

export interface BaseEntry {
  sha256: string;
  content: string;
}

export interface DocsGateState {
  doc_url?: string;
  base: Record<SyncFile, BaseEntry>;
  rendered_at: string;
}

/** Erro de formato do export (sentinela ausente/corrompida/duplicada) ou de
 * pré-condição (estado/arquivo ausente) — CLI mapeia para exit 2. */
export class DocsSyncFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsSyncFormatError";
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ─── Render ──────────────────────────────────────────────────────────────────

export interface RenderInput {
  edition: string;
  files: Record<SyncFile, string>;
  /** Resumo curto do gate (opcional) — vai no topo, fora das seções. */
  summary?: string;
}

/** Linha que, depois de normalizada, seria lida como sentinela. */
function looksLikeSentinel(line: string): boolean {
  return matchSentinel(line) !== null;
}

/**
 * Monta o markdown do doc. Lança se algum conteúdo já contiver uma linha que
 * o parser leria como sentinela (o round-trip ficaria ambíguo).
 */
export function renderDocMarkdown(input: RenderInput): string {
  const out: string[] = [];
  out.push(`# Revisão editorial — Edição ${input.edition}`);
  out.push("");
  if (input.summary && input.summary.trim()) {
    for (const line of input.summary.replace(/\r\n?/g, "\n").trimEnd().split("\n")) {
      if (looksLikeSentinel(line)) {
        throw new DocsSyncFormatError("resumo do gate contém linha no formato de sentinela");
      }
      out.push(line);
    }
    out.push("");
  }
  out.push(
    "Edite o texto entre as linhas INÍCIO e FIM de cada arquivo. Não edite nem apague as linhas de marcação: elas delimitam o que volta para os arquivos da edição. O repositório segue como fonte de verdade — se o arquivo mudar dos dois lados, o sync acusa conflito em vez de sobrescrever.",
  );
  out.push("");
  for (const file of SYNC_FILES) {
    const content = input.files[file].replace(/\r\n?/g, "\n");
    for (const line of content.split("\n")) {
      if (looksLikeSentinel(line)) {
        throw new DocsSyncFormatError(`${file} contém linha no formato de sentinela — doc ficaria ambíguo`);
      }
    }
    out.push(beginSentinel(file));
    out.push("");
    out.push(content.replace(/^\n+/, "").trimEnd());
    out.push("");
    out.push(endSentinel(file));
    out.push("");
  }
  return out.join("\n");
}

export function buildState(files: Record<SyncFile, string>, now: Date, docUrl?: string): DocsGateState {
  const base = {} as Record<SyncFile, BaseEntry>;
  for (const file of SYNC_FILES) base[file] = { sha256: sha256(files[file]), content: files[file] };
  const state: DocsGateState = { base, rendered_at: now.toISOString() };
  if (docUrl) state.doc_url = docUrl;
  return state;
}

// ─── Parse do export ─────────────────────────────────────────────────────────

/**
 * Reconhece uma linha-sentinela com a tolerância de um export markdown:
 * escapes, ênfase/heading em volta, link automático no rótulo, acento perdido.
 * Retorna `{kind, file}` ou `null`.
 */
export function matchSentinel(line: string): { kind: "begin" | "end"; file: SyncFile } | null {
  let s = line.replace(/ /g, " ").trim();
  if (!s.includes("=")) return null;
  s = s.replace(/^#{1,6}\s+/, "");
  s = s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  // Link automático `[x](y)` → x.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Ênfase em volta da linha inteira (ex.: `**=== ... ===**`).
  s = s.replace(/^[*_]+/, "").replace(/[*_]+$/, "").trim();
  const m = /^=+\s*(IN[IÍ]CIO|FIM)\s+(02-reviewed|03-social)(?:\.md)?\b.*?=+$/i.exec(s);
  if (!m) return null;
  const kind = /^fim$/i.test(m[1]) ? "end" : "begin";
  const file = `${m[2].toLowerCase()}.md` as SyncFile;
  return { kind, file };
}

/**
 * Extrai as duas seções do export. Exige exatamente 1 INÍCIO e 1 FIM por
 * arquivo, na ordem certa e sem sobreposição — senão `DocsSyncFormatError`
 * (nunca devolve seção parcial).
 */
export function parseDocExport(markdown: string): Record<SyncFile, string> {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const marks: Array<{ idx: number; kind: "begin" | "end"; file: SyncFile }> = [];
  lines.forEach((line, idx) => {
    const m = matchSentinel(line);
    if (m) marks.push({ idx, ...m });
  });
  const result = {} as Record<SyncFile, string>;
  for (const file of SYNC_FILES) {
    const begins = marks.filter((m) => m.file === file && m.kind === "begin");
    const ends = marks.filter((m) => m.file === file && m.kind === "end");
    if (begins.length !== 1 || ends.length !== 1) {
      throw new DocsSyncFormatError(
        `seção ${file}: esperado 1 INÍCIO e 1 FIM, achado ${begins.length} INÍCIO e ${ends.length} FIM (linha de marcação apagada ou corrompida no doc?)`,
      );
    }
    const b = begins[0].idx;
    const e = ends[0].idx;
    if (e <= b) throw new DocsSyncFormatError(`seção ${file}: FIM antes do INÍCIO`);
    const inside = marks.filter((m) => m.idx > b && m.idx < e);
    if (inside.length > 0) {
      throw new DocsSyncFormatError(`seção ${file}: outra linha de marcação dentro dela (seções sobrepostas)`);
    }
    result[file] = trimBlankEdges(lines.slice(b + 1, e)).join("\n");
  }
  return result;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

// ─── Normalização ────────────────────────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => HTML_ENTITIES[m] ?? m);
}

/** Ênfase com sublinhado → asterisco. Não casa `_` precedido de `\`, palavra
 * ou `*` (preserva `snake_case` e URLs com `_`). */
function normalizeEmphasis(s: string): string {
  return s
    .replace(/(?<![\w\\])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, "**$1**")
    .replace(/(?<![\w\\*])_(?=\S)([^_]+?)(?<=\S)_(?![\w])/g, "*$1*");
}

/** Remove escapes de pontuação ASCII do CommonMark. */
function unescapePunct(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function normalizeListAndRule(s: string): string {
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(s)) return "---";
  return s.replace(/^(\s*)[*+](\s+)/, "$1-$2").replace(/^(\s*\d+)\)(\s+)/, "$1.$2");
}

/** Forma de COMPARAÇÃO de uma linha (nunca gravada). */
export function normalizeLine(line: string): string {
  let s = line.replace(/ /g, " ");
  s = normalizeEmphasis(s);
  s = unescapePunct(s);
  s = decodeEntities(s);
  // `[url](url)` e `<url>` → url nua.
  s = s.replace(/\[(https?:\/\/[^\]\s]+)\]\(\1\)/g, "$1");
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, "$1");
  s = normalizeListAndRule(s);
  return s.replace(/[ \t]+/g, " ").trim();
}

export interface UnescapeResult {
  ok: boolean;
  text: string;
  reason?: string;
}

/**
 * Des-escapa uma linha EDITADA no doc para gravar no arquivo. Conservador:
 * recusa (`ok: false`) o que não dá para reverter com segurança, e o `apply`
 * trata isso como conflito em vez de arriscar corromper o arquivo.
 */
export function unescapeForWrite(line: string): UnescapeResult {
  if (line.includes("\\\\")) {
    return { ok: false, text: line, reason: "barra invertida literal (`\\\\`) — des-escape ambíguo" };
  }
  if (/<\?claude\b/.test(line)) {
    return { ok: false, text: line, reason: "bloco especial do Claude Docs (`<?claude ...?>`) no meio do texto" };
  }
  // Tag HTML crua (não autolink `<https://...>`) — o editor rich-text pode ter
  // aplicado formatação sem equivalente markdown (sublinhado, cor).
  if (/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?\/?>/.test(line.replace(/<https?:\/\/[^>\s]+>/g, ""))) {
    return { ok: false, text: line, reason: "tag HTML no texto exportado" };
  }
  let s = line.replace(/ /g, " ").replace(/[ \t]+$/, "");
  s = normalizeEmphasis(s);
  s = unescapePunct(s);
  s = decodeEntities(s);
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, "[$1]($1)");
  s = normalizeListAndRule(s);
  return { ok: true, text: s };
}

// ─── Diff por linha ──────────────────────────────────────────────────────────

/** Unidade do diff: uma linha não-branca, ou uma sequência de linhas em
 * branco colapsada (norm = ""). `raw` guarda as linhas originais. */
interface Unit {
  norm: string;
  raw: string[];
}

function toUnits(text: string): Unit[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const units: Unit[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      const last = units[units.length - 1];
      if (last && last.norm === "") last.raw.push(line);
      else units.push({ norm: "", raw: [line] });
    } else {
      units.push({ norm: normalizeLine(line), raw: [line] });
    }
  }
  return units;
}

type Op = { kind: "eq"; a: Unit; b: Unit } | { kind: "del"; a: Unit } | { kind: "ins"; b: Unit };

function diffUnits(a: Unit[], b: Unit[]): Op[] {
  const n = a.length;
  const m = b.length;
  // Tabela LCS (sufixos). Arquivos da edição têm centenas de linhas — O(n·m) ok.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].norm === b[j].norm ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].norm === b[j].norm) {
      ops.push({ kind: "eq", a: a[i], b: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", a: a[i++] });
    } else {
      ops.push({ kind: "ins", b: b[j++] });
    }
  }
  while (i < n) ops.push({ kind: "del", a: a[i++] });
  while (j < m) ops.push({ kind: "ins", b: b[j++] });
  return ops;
}

/** Texto do trecho com quebra de parágrafo explícita e quebra "mole" virando
 * espaço — dois trechos iguais aqui só diferem em layout de linha. */
function paragraphText(units: Unit[]): string {
  return units
    .map((u) => (u.norm === "" ? "\n" : u.norm))
    .join(" ")
    .replace(/[ \t]*\n[ \t\n]*/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/^\n+|\n+$/g, "")
    .trim();
}

function isCosmeticHunk(aSide: Unit[], bSide: Unit[]): boolean {
  return paragraphText(aSide) === paragraphText(bSide);
}

export interface MergeResult {
  /** Houve ao menos um trecho realmente editado no doc. */
  changed: boolean;
  /** Conteúdo resultante (== alvo, byte a byte, quando `changed` é false). */
  content: string;
  /** Linhas editadas que não deu para des-escapar com segurança. */
  unsafe: Array<{ line: string; reason: string }>;
  /** Linhas do alvo removidas / linhas do doc inseridas, nos trechos editados. */
  removed: string[];
  added: string[];
}

/**
 * Aplica sobre `target` (conteúdo cru de um arquivo) as edições que o doc tem
 * em relação a ele. Trechos iguais ou cosméticos mantêm os bytes do alvo.
 */
export function mergeDocOnto(target: string, docSection: string): MergeResult {
  const eol = target.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /\r?\n$/.test(target);
  const targetBody = hadTrailingNewline ? target.replace(/\r?\n$/, "") : target;
  const a = toUnits(targetBody);
  const b = toUnits(docSection);
  // Linhas em branco nas bordas não contam (o doc é trimado no parse).
  const trimUnits = (u: Unit[]) => {
    let s = 0;
    let e = u.length;
    while (s < e && u[s].norm === "") s++;
    while (e > s && u[e - 1].norm === "") e--;
    return { lead: u.slice(0, s), mid: u.slice(s, e), tail: u.slice(e) };
  };
  const ta = trimUnits(a);
  const tb = trimUnits(b);
  const ops = diffUnits(ta.mid, tb.mid);

  const outUnits: Array<{ lines: string[]; blank: boolean }> = [];
  const unsafe: MergeResult["unsafe"] = [];
  const removed: string[] = [];
  const added: string[] = [];
  let changed = false;

  const pushUnit = (lines: string[], blank: boolean) => {
    const last = outUnits[outUnits.length - 1];
    if (blank && last && last.blank) return; // nunca 2 blocos de branco seguidos
    outUnits.push({ lines, blank });
  };

  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.kind === "eq") {
      pushUnit(op.a.raw, op.a.norm === "");
      k++;
      continue;
    }
    const aSide: Unit[] = [];
    const bSide: Unit[] = [];
    while (k < ops.length && ops[k].kind !== "eq") {
      const o = ops[k];
      if (o.kind === "del") aSide.push(o.a);
      else if (o.kind === "ins") bSide.push(o.b);
      k++;
    }
    if (isCosmeticHunk(aSide, bSide)) {
      for (const u of aSide) pushUnit(u.raw, u.norm === "");
      continue;
    }
    changed = true;
    for (const u of aSide) if (u.norm !== "") removed.push(...u.raw);
    for (const u of bSide) {
      if (u.norm === "") {
        pushUnit([""], true);
        continue;
      }
      const r = unescapeForWrite(u.raw[0]);
      if (!r.ok) unsafe.push({ line: u.raw[0], reason: r.reason ?? "des-escape não confiável" });
      added.push(r.text);
      pushUnit([r.text], false);
    }
  }

  if (!changed) return { changed: false, content: target, unsafe: [], removed: [], added: [] };

  const lines = [
    ...ta.lead.flatMap((u) => u.raw),
    ...outUnits.flatMap((u) => u.lines),
    ...ta.tail.flatMap((u) => u.raw),
  ];
  let content = lines.join(eol);
  if (hadTrailingNewline) content += eol;
  return { changed, content, unsafe, removed, added };
}

/** Doc e texto equivalentes a menos de diferenças cosméticas de export. */
export function docEquivalent(target: string, docSection: string): boolean {
  return !mergeDocOnto(target, docSection).changed;
}

// ─── Resumo de diff (para o relatório de conflito) ───────────────────────────

const DIFF_SUMMARY_MAX_LINES = 20;

/** Resumo `- linha`/`+ linha` dos trechos que diferem (cosméticos ignorados). */
export function diffSummary(from: string, to: string): { lines: string[]; truncated: number } {
  const r = mergeDocOnto(from, to);
  const all = [...r.removed.map((l) => `- ${l}`), ...r.added.map((l) => `+ ${l}`)];
  return {
    lines: all.slice(0, DIFF_SUMMARY_MAX_LINES),
    truncated: Math.max(0, all.length - DIFF_SUMMARY_MAX_LINES),
  };
}

// ─── Decisão de 3 vias ───────────────────────────────────────────────────────

export type FileAction =
  | "unchanged" // doc == base e arquivo == base
  | "doc_stale" // doc == base, arquivo mudou (pipeline) — re-render do doc
  | "pulled" // arquivo == base, doc editado — edição puxada para o arquivo
  | "base_updated" // arquivo != base mas doc == arquivo — só a base avança
  | "conflict" // arquivo e doc mudaram, de forma diferente — nada gravado
  | "resolved_keep_file" // conflito resolvido pelo editor: manter arquivo
  | "resolved_apply_doc"; // conflito resolvido pelo editor: aplicar doc

export type Resolution = "arquivo" | "doc";

export interface FileOutcome {
  file: SyncFile;
  action: FileAction;
  /** Conteúdo a gravar no arquivo (só em `pulled`/`resolved_apply_doc`). */
  write?: string;
  /** Nova base (quando avança). */
  newBase?: string;
  reason?: string;
  /** Em conflito: o que o editor mudou no doc e o que o pipeline mudou no arquivo. */
  editor_changes?: { lines: string[]; truncated: number };
  pipeline_changes?: { lines: string[]; truncated: number };
  unsafe?: MergeResult["unsafe"];
}

export function decideFile(
  file: SyncFile,
  base: string,
  current: string,
  doc: string,
  resolution?: Resolution,
): FileOutcome {
  const fileEqBase = current === base;
  const docEqBase = docEquivalent(base, doc);

  if (docEqBase) {
    return fileEqBase ? { file, action: "unchanged" } : { file, action: "doc_stale" };
  }
  if (fileEqBase) {
    const merged = mergeDocOnto(current, doc);
    if (merged.unsafe.length > 0) {
      return {
        file,
        action: "conflict",
        reason: "edição do doc não pôde ser des-escapada com segurança — nada gravado",
        unsafe: merged.unsafe,
        editor_changes: diffSummary(base, doc),
        pipeline_changes: { lines: [], truncated: 0 },
      };
    }
    return { file, action: "pulled", write: merged.content, newBase: merged.content };
  }
  if (docEquivalent(current, doc)) {
    return { file, action: "base_updated", newBase: current };
  }

  // Conflito real: arquivo e doc mudaram, e de forma diferente.
  if (resolution === "arquivo") {
    return { file, action: "resolved_keep_file", newBase: current };
  }
  if (resolution === "doc") {
    const merged = mergeDocOnto(current, doc);
    if (merged.unsafe.length === 0) {
      return { file, action: "resolved_apply_doc", write: merged.content, newBase: merged.content };
    }
    return {
      file,
      action: "conflict",
      reason: "resolução 'doc' pedida, mas a edição do doc não pôde ser des-escapada com segurança — nada gravado",
      unsafe: merged.unsafe,
      editor_changes: diffSummary(base, doc),
      pipeline_changes: diffSummary(base, current),
    };
  }
  return {
    file,
    action: "conflict",
    reason: "arquivo mudou no repositório E no doc desde o último render — nada gravado",
    editor_changes: diffSummary(base, doc),
    pipeline_changes: diffSummary(base, current),
  };
}

// ─── Runners com I/O (usados pela CLI) ───────────────────────────────────────

export function statePath(editionDir: string): string {
  return resolve(editionDir, "_internal", STATE_FILENAME);
}

function readSyncFiles(editionDir: string): Record<SyncFile, string> {
  const files = {} as Record<SyncFile, string>;
  for (const file of SYNC_FILES) {
    const p = resolve(editionDir, file);
    if (!existsSync(p)) throw new DocsSyncFormatError(`${file} ausente em ${editionDir}`);
    files[file] = readFileSync(p, "utf8");
  }
  return files;
}

export function readState(editionDir: string): DocsGateState | null {
  const p = statePath(editionDir);
  if (!existsSync(p)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new DocsSyncFormatError(`${STATE_FILENAME} ilegível: ${(e as Error).message}`);
  }
  const st = parsed as Partial<DocsGateState>;
  for (const file of SYNC_FILES) {
    const entry = st.base?.[file];
    if (!entry || typeof entry.content !== "string") {
      throw new DocsSyncFormatError(`${STATE_FILENAME} sem base de ${file}`);
    }
  }
  return st as DocsGateState;
}

function writeState(editionDir: string, state: DocsGateState): void {
  const p = statePath(editionDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify(state, null, 2) + "\n");
}

export interface RenderOptions {
  editionDir: string;
  edition: string;
  out?: string;
  docUrl?: string;
  summary?: string;
  now?: Date;
}

export function runRender(opts: RenderOptions): { out: string; state: DocsGateState } {
  const files = readSyncFiles(opts.editionDir);
  const markdown = renderDocMarkdown({ edition: opts.edition, files, summary: opts.summary });
  const out = opts.out ?? resolve(opts.editionDir, "_internal", DOC_MD_FILENAME);
  mkdirSync(dirname(out), { recursive: true });
  writeFileAtomic(out, markdown);
  // Preserva o doc_url de um render anterior quando --doc-url não é passado.
  let previousUrl: string | undefined;
  try {
    previousUrl = readState(opts.editionDir)?.doc_url;
  } catch {
    previousUrl = undefined;
  }
  const state = buildState(files, opts.now ?? new Date(), opts.docUrl ?? previousUrl);
  writeState(opts.editionDir, state);
  return { out, state };
}

export interface ApplyReport {
  ok: boolean;
  doc_url?: string;
  files: Array<Omit<FileOutcome, "write" | "newBase">>;
  pulled: SyncFile[];
  doc_stale: SyncFile[];
  conflicts: Array<Omit<FileOutcome, "write" | "newBase">>;
}

export interface ApplyOptions {
  editionDir: string;
  docExport: string;
  resolutions?: Partial<Record<SyncFile, Resolution>>;
}

/**
 * Lê o export, decide por arquivo e só então grava (nunca parcial: um erro de
 * formato aborta antes de qualquer escrita). Conflito não grava aquele arquivo
 * mas não impede de puxar o outro.
 */
export function runApply(opts: ApplyOptions): ApplyReport {
  const state = readState(opts.editionDir);
  if (!state) {
    throw new DocsSyncFormatError(`${STATE_FILENAME} ausente — rode \`render\` antes de \`apply\``);
  }
  if (!existsSync(opts.docExport)) throw new DocsSyncFormatError(`export do doc não encontrado: ${opts.docExport}`);
  const sections = parseDocExport(readFileSync(opts.docExport, "utf8"));
  const current = readSyncFiles(opts.editionDir);

  const outcomes = SYNC_FILES.map((file) =>
    decideFile(file, state.base[file].content, current[file], sections[file], opts.resolutions?.[file]),
  );

  let stateChanged = false;
  for (const o of outcomes) {
    if (o.write !== undefined) writeFileAtomic(resolve(opts.editionDir, o.file), o.write);
    if (o.newBase !== undefined) {
      state.base[o.file] = { sha256: sha256(o.newBase), content: o.newBase };
      stateChanged = true;
    }
  }
  if (stateChanged) writeState(opts.editionDir, state);

  const strip = (o: FileOutcome) => {
    const { write: _w, newBase: _n, ...rest } = o;
    return rest;
  };
  const conflicts = outcomes.filter((o) => o.action === "conflict").map(strip);
  return {
    ok: conflicts.length === 0,
    ...(state.doc_url ? { doc_url: state.doc_url } : {}),
    files: outcomes.map(strip),
    pulled: outcomes.filter((o) => o.action === "pulled" || o.action === "resolved_apply_doc").map((o) => o.file),
    doc_stale: outcomes
      .filter((o) => o.action === "doc_stale" || o.action === "resolved_keep_file")
      .map((o) => o.file),
    conflicts,
  };
}

/** `02-reviewed.md=arquivo,03-social.md=doc` (aceita também `02-reviewed`). */
export function parseResolutions(spec: string): Partial<Record<SyncFile, Resolution>> {
  const out: Partial<Record<SyncFile, Resolution>> = {};
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(02-reviewed|03-social)(?:\.md)?=(arquivo|doc)$/.exec(part);
    if (!m) throw new DocsSyncFormatError(`--resolve inválido: "${part}" (esperado 02-reviewed.md=arquivo|doc)`);
    out[`${m[1]}.md` as SyncFile] = m[2] as Resolution;
  }
  return out;
}
