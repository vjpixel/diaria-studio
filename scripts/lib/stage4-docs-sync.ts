/**
 * stage4-docs-sync.ts (#9964)
 *
 * Miolo do documento editável do gate do Stage 4 (Claude Docs). Decisão do
 * editor (12/10/2026, registrada na #9964): o documento sai SEMPRE no Stage 4
 * (aditivo aos previews HTML, só para o TEXTO), com sync automático de volta
 * para `02-reviewed.md`/`03-social.md`. Condição: o repo segue fonte de
 * verdade — o sync de volta DETECTA e ACUSA conflito, nunca sobrescreve em
 * silêncio (nem a edição do editor, nem a do pipeline).
 *
 * Scripts TS não chamam o conector Claude Docs (é MCP do top-level). O fluxo é:
 *   1. `render` gera o markdown do doc a partir dos arquivos. Sem doc ainda
 *      (`doc_url` ausente), grava a BASE (snapshot do que vai para o doc) em
 *      `_internal/04-docs-gate.json`. Com doc existente, exige o export atual
 *      do doc, recusa se ele tiver edição não puxada, e grava a base nova como
 *      PENDENTE — só `confirm` (depois que o top-level substituiu o doc com
 *      sucesso, contra a `container.version` do export) a efetiva. Falhou a
 *      substituição → a base antiga segue valendo.
 *   2. `set-url` grava o `doc_url` (sem mexer na base); `check-roundtrip`
 *      (opcional desde #10078) confere que o export do doc intocado volta
 *      equivalente — senão desativa o sync daquele doc (`sync_disabled`);
 *      `enable` religa o sync com o mesmo critério.
 *   3. `apply` faz o merge de 3 vias por arquivo: BASE × DOC × arquivo ATUAL.
 *      Fluxo padrão desde #10078 (decisão do editor, 13/10/2026): o editor
 *      edita no doc durante o gate e o export chega ao disco UMA vez, na
 *      finalização (`apply --final` do ramo `sim`) — o conector só devolve o
 *      export inline no resultado da tool, e cada ida ao disco custa a
 *      retranscrição do doc inteiro. Durante o gate, `status` (sem export)
 *      informa o que o pipeline mudou desde o conteúdo do doc.
 *   4. `check` confere mecanicamente, antes do sentinel do Stage 4, que o
 *      último `apply` foi o `apply --final` do ramo `sim`, sem conflito, e que
 *      os arquivos não mudaram desde.
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
 * Heading setext acidental: nos arquivos reais (261001, 261008) há parágrafo
 * seguido de `---` SEM linha em branco — em CommonMark isso é um H2 setext, e
 * o doc devolveria `## parágrafo` sem a quebra temática. O render insere uma
 * linha em branco antes de todo `---`/`***`/`___` precedido de texto; a
 * comparação trata essa linha em branco extra como cosmética.
 *
 * ── Normalização (só para COMPARAR) ─────────────────────────────────────────
 * `normalizeLine` neutraliza o que um export markdown tipicamente introduz sem
 * que o editor tenha mexido no texto:
 *   - fim de linha CRLF/LF, espaços finais, espaços repetidos, NBSP, quebra
 *     dura com barra invertida final;
 *   - escapes de pontuação ASCII do CommonMark (fora de code span);
 *   - entidades HTML `&amp;` `&lt;` `&gt;` `&quot;` `&#39;` `&nbsp;`;
 *   - ênfase `__x__`/`_x_` ≡ `**x**`/`*x*` — NUNCA dentro de destino de link,
 *     URL crua ou code span (`/__init__.py` não vira `**init**`);
 *   - marcador de lista `*`/`+` ≡ `-`, lista ordenada `1)` ≡ `1.`;
 *   - quebra temática `***`/`___`/`* * *` ≡ `---`;
 *   - link `<url>` ≡ `[url](url)` ≡ `url` (URL nua);
 * e, no nível do bloco, linhas em branco repetidas/no fim e quebra de linha
 * "mole" dentro de um parágrafo — ver `isCosmeticHunk`.
 *
 * ── Merge de 3 vias ─────────────────────────────────────────────────────────
 * `merge3(base, atual, doc)` calcula os trechos (hunks) base→doc e base→atual
 * (diff por linha, LCS sobre as linhas normalizadas). Hunks cosméticos do lado
 * do doc são descartados. Os hunks do doc são aplicados SOBRE o arquivo atual;
 * trechos que não mudaram mantêm os bytes do arquivo atual. Hunk do doc que se
 * sobrepõe (ou encosta) num hunk do pipeline é CONFLITO — exceto quando os
 * dois lados fizeram a mesma mudança. Mudanças em trechos disjuntos são
 * puxadas automaticamente.
 *
 * O conteúdo do doc NUNCA é gravado inteiro. Só as linhas dos hunks do doc
 * são escritas, des-escapadas de forma conservadora (`unescapeForWrite`),
 * preservando marcador de lista, estilo de ênfase e espaços finais da linha
 * substituída. Linha que não dá para des-escapar com segurança (`\\`, tag HTML,
 * bloco `<?claude ...?>`), remoção de linha com HTML/comentário, seção vazia
 * ou remoção em massa (>50% das linhas) → CONFLITO, nunca gravação.
 *
 * Limite conhecido (documentado, não silencioso): diferença SÓ de linhas em
 * branco entre parágrafos é tratada como cosmética. Num editor rich-text,
 * juntar dois parágrafos muda o texto da linha (o que É detectado como
 * edição), então a única fonte prática de diferença só-de-branco é o próprio
 * export.
 *
 * @see .claude/agents/orchestrator-stage-4.md §4b step 3b (criação do doc e
 *   check-roundtrip), §4d (apply antes de cada apresentação + manter o doc
 *   atualizado; o ÚLTIMO apply roda no ramo `sim`), §4e (`check` antes do
 *   sentinel — só confere, não puxa)
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

/** Título do doc — o MESMO texto do H1 do markdown (o conector usa o título
 * como nome; os dois alinhados evitam um doc "Revisão X" com H1 diferente). */
export function docTitle(edition: string): string {
  return `Revisão editorial — Edição ${edition}`;
}

export interface BaseEntry {
  sha256: string;
  content: string;
}

export interface DocsGateState {
  doc_url?: string;
  base: Record<SyncFile, BaseEntry>;
  rendered_at: string;
  /** Base de um re-render ainda não efetivado (doc ainda não substituído).
   * `doc_version` = `container.version` do export validado pelo render — o
   * replace tem de ser feito contra ela e o `confirm` a exige. */
  pending?: { base: Record<SyncFile, BaseEntry>; rendered_at: string; doc_version?: string };
  /** Sync desligado para este doc (round-trip inicial falhou, auto_approve,
   * ou editor aprovou sem as edições do doc). Nunca puxa. */
  sync_disabled?: { reason: string; at: string };
  /** Último `apply` (qualquer um). */
  last_apply_at?: string;
  /** `apply --final` sem conflito (ramo `sim`): quando, sha do export e dos
   * arquivos logo depois. Qualquer `apply` não-final posterior APAGA isto —
   * então o `check` só passa se o apply final foi o último. */
  final_apply?: { at: string; export_sha256: string; files_sha: Record<SyncFile, string> };
  /** Arquivos em conflito no último `apply` (ausente = nenhum). */
  pending_conflict?: SyncFile[];
}

/** Erro de formato do export (sentinela ausente/corrompida/duplicada) ou de
 * pré-condição (estado/arquivo ausente) — CLI mapeia para exit 2. Lançado
 * sempre ANTES de qualquer escrita. */
export class DocsSyncFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsSyncFormatError";
  }
}

/** Falha inesperada (I/O etc.) — carrega o que já tinha sido gravado. CLI → exit 3. */
export class DocsSyncUnexpectedError extends Error {
  readonly written: string[];
  constructor(message: string, written: string[]) {
    super(message);
    this.name = "DocsSyncUnexpectedError";
    this.written = written;
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

const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
/** Sublinhado setext (`---`, `--`, `===`, `=`) — viraria heading se colado em texto. */
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
/** Linha que abre bloco próprio (não continua o parágrafo anterior). */
const BLOCK_START_RE = /^\s*([-*+]\s|\d+[.)]\s|#{1,6}(\s|$)|>|\||```|~~~)/;

/**
 * Prepara o conteúdo de um arquivo para o doc (só o doc — nunca gravado):
 *  1. linha em branco antes de quebra temática / sublinhado setext colado em
 *     texto (evita heading setext — ver docblock);
 *  2. quebra de linha "mole" dentro de parágrafo (ex.: `Por que isso
 *     importa:` + texto, `Mais em <url>` + `#hashtags`) vira quebra DURA no
 *     doc (`\` final, ou 2 espaços depois de URL) — senão o markdown junta as
 *     linhas num parágrafo só e o export devolve uma linha única. Na volta,
 *     `unescapeForWrite` desfaz a quebra dura (a linha volta a ser "mole").
 * Blocos cercados (```) passam intactos.
 */
export function docifyLines(lines: string[]): string[] {
  const sep: Array<{ line: string; fence: boolean }> = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      sep.push({ line, fence: true });
      inFence = !inFence;
      continue;
    }
    const prev = sep[sep.length - 1];
    if (!inFence && (SETEXT_UNDERLINE_RE.test(line) || THEMATIC_BREAK_RE.test(line))) {
      if (prev && prev.line.trim() !== "" && !prev.fence) sep.push({ line: "", fence: false });
    }
    sep.push({ line, fence: inFence });
  }
  const isPlain = (l: string) =>
    l.trim() !== "" && !SETEXT_UNDERLINE_RE.test(l) && !THEMATIC_BREAK_RE.test(l) && !hasHtml(l);
  return sep.map(({ line, fence }, i) => {
    const next = sep[i + 1];
    if (fence || !next || next.fence) return line;
    if (!isPlain(line) || !isPlain(next.line) || BLOCK_START_RE.test(next.line)) return line;
    if (/^\s*(#{1,6}\s|\|)/.test(line)) return line;
    if (/( {2,}|\\)$/.test(line)) return line; // já é quebra dura
    return /(https?:\/\/|www\.)\S+$/.test(line) ? `${line}  ` : `${line}\\`;
  });
}

/**
 * Monta o markdown do doc. Lança se algum conteúdo já contiver uma linha que
 * o parser leria como sentinela (o round-trip ficaria ambíguo).
 */
export function renderDocMarkdown(input: RenderInput): string {
  const out: string[] = [];
  out.push(`# ${docTitle(input.edition)}`);
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
    out.push(docifyLines(content.replace(/^\n+/, "").trimEnd().split("\n")).join("\n"));
    out.push("");
    out.push(endSentinel(file));
    out.push("");
  }
  return out.join("\n");
}

function baseOf(files: Record<SyncFile, string>): Record<SyncFile, BaseEntry> {
  const base = {} as Record<SyncFile, BaseEntry>;
  for (const file of SYNC_FILES) base[file] = { sha256: sha256(files[file]), content: files[file] };
  return base;
}

// ─── Parse do export ─────────────────────────────────────────────────────────

/**
 * Reconhece uma linha-sentinela com a tolerância de um export markdown:
 * escapes, ênfase/heading em volta, link automático no rótulo, acento perdido.
 * Retorna `{kind, file}` ou `null`.
 */
export function matchSentinel(line: string): { kind: "begin" | "end"; file: SyncFile } | null {
  let s = line.replace(/ /g, " ").trim();
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

/** Trechos onde ênfase NUNCA é normalizada: code span, destino de link,
 * autolink e URL crua. */
const EMPHASIS_PROTECTED_RE =
  /`[^`]*`|\]\([^)]*\)|<https?:\/\/[^>\s]+>|(?:https?:\/\/|www\.)[^\s<>()\]]+|\b[\w-]+(?:\.[\w-]+)+\/[^\s<>()\]]*/g;
/** Trechos onde escapes NÃO são removidos: code span (barra é literal ali). */
const UNESCAPE_PROTECTED_RE = /`[^`]*`/g;

/** Aplica `fn` só aos trechos fora de `protectedRe`. */
function mapUnprotected(s: string, protectedRe: RegExp, fn: (part: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(new RegExp(protectedRe.source, "g"))) {
    out += fn(s.slice(last, m.index)) + m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  return out + fn(s.slice(last));
}

const DOUBLE_UNDERSCORE_RE = /(?<![\w\\])__(?=\S)(.+?)(?<=\S)__(?!\w)/g;
const SINGLE_UNDERSCORE_RE = /(?<![\w\\*])_(?=\S)([^_]+?)(?<=\S)_(?![\w])/g;

/** Ênfase com sublinhado → asterisco, fora de URL/link/code. Não casa `_`
 * precedido de `\`, palavra ou `*` (preserva `snake_case`). */
function normalizeEmphasis(s: string, opts: { double?: boolean; single?: boolean } = {}): string {
  const { double = true, single = true } = opts;
  return mapUnprotected(s, EMPHASIS_PROTECTED_RE, (part) => {
    let p = part;
    if (double) p = p.replace(DOUBLE_UNDERSCORE_RE, "**$1**");
    if (single) p = p.replace(SINGLE_UNDERSCORE_RE, "*$1*");
    return p;
  });
}

/** Remove escapes de pontuação ASCII do CommonMark (fora de code span). */
function unescapePunct(s: string): string {
  return mapUnprotected(s, UNESCAPE_PROTECTED_RE, (part) => part.replace(/\\([!-/:-@[-`{-~])/g, "$1"));
}

function normalizeListAndRule(s: string): string {
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(s)) return "---";
  return s.replace(/^(\s*)[*+](\s+)/, "$1-$2").replace(/^(\s*\d+)\)(\s+)/, "$1.$2");
}

/** Quebra dura no fim da linha: `\` final (não escapada). */
function stripHardBreak(s: string): string {
  return s.replace(/[ \t]+$/, "").replace(/(?<!\\)\\$/, "");
}

/** Forma de COMPARAÇÃO de uma linha (nunca gravada). */
export function normalizeLine(line: string): string {
  let s = stripHardBreak(line.replace(/ /g, " "));
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

const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?\/?>/;

/** Linha com HTML cru ou comentário (fora de autolink). */
function hasHtml(line: string): boolean {
  const s = line.replace(/<https?:\/\/[^>\s]+>/g, "");
  return s.includes("<!--") || HTML_TAG_RE.test(s);
}

/**
 * Des-escapa uma linha EDITADA no doc para gravar no arquivo. Conservador:
 * recusa (`ok: false`) o que não dá para reverter com segurança, e o `apply`
 * trata isso como conflito em vez de arriscar corromper o arquivo.
 *
 * `original` (opcional) = linha do arquivo que esta substitui: preserva o
 * estilo dela (marcador de lista `*`/`+`/`1)`, ênfase com `_`, espaços finais
 * de quebra dura) em vez de reescrever no estilo do export.
 */
export function unescapeForWrite(line: string, original?: string): UnescapeResult {
  if (line.includes("\\\\")) {
    return { ok: false, text: line, reason: "barra invertida literal (`\\\\`) — des-escape ambíguo" };
  }
  if (/<\?claude\b/.test(line)) {
    return { ok: false, text: line, reason: "bloco especial do Claude Docs (`<?claude ...?>`) no meio do texto" };
  }
  // Tag HTML crua (não autolink `<https://...>`) — o editor rich-text pode ter
  // aplicado formatação sem equivalente markdown (sublinhado, cor).
  if (hasHtml(line)) {
    return { ok: false, text: line, reason: "tag HTML no texto exportado" };
  }
  let s = line.replace(/ /g, " ").replace(/[ \t]+$/, "");
  const hardBreak = /(?<!\\)\\$/.test(s);
  if (hardBreak) s = s.slice(0, -1).replace(/[ \t]+$/, "");
  const origUsesDouble = original !== undefined && new RegExp(DOUBLE_UNDERSCORE_RE.source).test(original);
  const origUsesSingle = original !== undefined && new RegExp(SINGLE_UNDERSCORE_RE.source).test(original);
  s = normalizeEmphasis(s, { double: !origUsesDouble, single: !origUsesSingle });
  s = unescapePunct(s);
  s = decodeEntities(s);
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, "[$1]($1)");
  s = normalizeListAndRule(s);
  if (original !== undefined) s = transferLineStyle(original, s);
  // Quebra dura no doc é como o render representa a quebra "mole" do arquivo
  // (`docifyLines`): reconstrói o que a linha original tinha — 2+ espaços,
  // `\` ou nada (linha nova também volta sem quebra dura).
  const origTrailing = original !== undefined ? /[ \t]+$/.exec(original)?.[0] : undefined;
  if (origTrailing && origTrailing.length >= 2) s += origTrailing;
  else if (hardBreak && original !== undefined && /(?<!\\)\\$/.test(original)) s += "\\";
  return { ok: true, text: s };
}

/** Restaura o marcador de lista da linha original (`*`/`+`/`1)`). */
function transferLineStyle(original: string, s: string): string {
  const om = /^(\s*)([*+]|\d+\))(\s+)/.exec(original);
  if (!om) return s;
  if (/[*+]/.test(om[2])) return s.replace(/^(\s*)-(\s+)/, `$1${om[2]}$2`);
  return s.replace(/^(\s*\d+)\.(\s+)/, "$1)$2");
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

/** Trecho base[bs,be) → x[xs,xe). Inserção pura: bs === be. */
interface Hunk {
  bs: number;
  be: number;
  xs: number;
  xe: number;
  cosmetic: boolean;
}

function diffHunks(a: Unit[], b: Unit[]): Hunk[] {
  const n = a.length;
  const m = b.length;
  // Tabela LCS (sufixos). Arquivos da edição têm centenas de linhas — O(n·m) ok.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].norm === b[j].norm ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: { bs: number; xs: number } | null = null;
  const close = () => {
    if (!open) return;
    const h = { bs: open.bs, be: i, xs: open.xs, xe: j };
    hunks.push({ ...h, cosmetic: isCosmeticHunk(a.slice(h.bs, h.be), b.slice(h.xs, h.xe)) });
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i].norm === b[j].norm) {
      close();
      i++;
      j++;
      continue;
    }
    if (!open) open = { bs: i, xs: j };
    if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) i++;
    else j++;
  }
  close();
  return hunks;
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

/** Índice em X da posição-base `s`, ANTES de inserções em `s`. */
function mapStart(hunks: Hunk[], s: number): number {
  let delta = 0;
  for (const h of hunks) if (h.be < s || (h.be === s && h.bs < s)) delta += h.xe - h.xs - (h.be - h.bs);
  return s + delta;
}

/** Índice em X da posição-base `e`, DEPOIS de inserções em `e`. */
function mapEnd(hunks: Hunk[], e: number): number {
  let delta = 0;
  for (const h of hunks) if (h.be <= e) delta += h.xe - h.xs - (h.be - h.bs);
  return e + delta;
}

function trimUnits(u: Unit[]) {
  let s = 0;
  let e = u.length;
  while (s < e && u[s].norm === "") s++;
  while (e > s && u[e - 1].norm === "") e--;
  return { lead: u.slice(0, s), mid: u.slice(s, e), tail: u.slice(e) };
}

const nonblank = (units: Unit[]) => units.filter((u) => u.norm !== "");

export interface MergeConflict {
  base: string[];
  doc: string[];
  current: string[];
}

export interface Merge3Result {
  /** O doc tem ao menos um trecho realmente editado em relação à base. */
  docChanged: boolean;
  /** Conteúdo resultante (== atual, byte a byte, quando nada foi aplicado). */
  content: string;
  /** Trechos onde doc e pipeline mexeram no mesmo lugar, de forma diferente. */
  conflicts: MergeConflict[];
  /** Linhas aplicadas que não deu para des-escapar com segurança. */
  unsafe: Array<{ line: string; reason: string }>;
  /** Trechos do doc aplicados (para o resumo de diff), na ordem do arquivo. */
  applied: Array<{ removed: string[]; added: string[] }>;
  /** Linhas não-brancas removidas/adicionadas pelos trechos aplicados. */
  removedCount: number;
  addedCount: number;
  /** Linhas não-brancas do arquivo atual (para o guard de remoção em massa). */
  currentCount: number;
  /** Algum trecho só cosmético do doc juntou ou partiu linhas (o conector não
   * preserva a quebra de linha) — usado pelo `check-roundtrip`. */
  layoutChanged: boolean;
}

/**
 * Merge de 3 vias por linha. `onConflict`: o que emitir nos trechos em
 * conflito — `"arquivo"` (default: mantém o atual) ou `"doc"` (o doc vence
 * SÓ nesses trechos; o resto do pipeline é preservado).
 */
export function merge3(
  base: string,
  current: string,
  doc: string,
  onConflict: "arquivo" | "doc" = "arquivo",
): Merge3Result {
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /\r?\n$/.test(current);
  const currentBody = hadTrailingNewline ? current.replace(/\r?\n$/, "") : current;
  const B = trimUnits(toUnits(base)).mid;
  const tc = trimUnits(toUnits(currentBody));
  const C = tc.mid;
  const D = trimUnits(toUnits(doc)).mid;

  const dAll = diffHunks(B, D);
  const dHunks = dAll.filter((h) => !h.cosmetic);
  const cHunks = diffHunks(B, C);
  const currentCount = nonblank(C).length;
  const layoutChanged = dAll.some(
    (h) => h.cosmetic && nonblank(B.slice(h.bs, h.be)).length !== nonblank(D.slice(h.xs, h.xe)).length,
  );
  const empty: Merge3Result = {
    docChanged: false,
    content: current,
    conflicts: [],
    unsafe: [],
    applied: [],
    removedCount: 0,
    addedCount: 0,
    currentCount,
    layoutChanged,
  };
  if (dHunks.length === 0) return empty;

  // Agrupa hunks que se sobrepõem OU encostam (conservador) em clusters.
  type Tagged = Hunk & { side: "d" | "c" };
  // Hunks cosméticos do doc entram no agrupamento (para o mapeamento de
  // posições do doc nunca cortar um deles ao meio), mas sozinhos não contam
  // como edição: cluster sem hunk real do doc emite o arquivo atual.
  const all: Tagged[] = [
    ...dAll.map((h) => ({ ...h, side: "d" as const })),
    ...cHunks.map((h) => ({ ...h, side: "c" as const })),
  ].sort((x, y) => x.bs - y.bs || x.be - y.be);
  const clusters: Array<{ s: number; e: number; d: Tagged[]; c: Tagged[] }> = [];
  for (const h of all) {
    const last = clusters[clusters.length - 1];
    if (last && h.bs <= last.e) {
      last.e = Math.max(last.e, h.be);
      (h.side === "d" ? last.d : last.c).push(h);
    } else {
      clusters.push({ s: h.bs, e: h.be, d: h.side === "d" ? [h] : [], c: h.side === "c" ? [h] : [] });
    }
  }

  const out: Unit[] = [];
  const push = (units: Unit[]) => {
    for (const u of units) {
      const last = out[out.length - 1];
      if (u.norm === "" && last && last.norm === "") continue; // nunca 2 brancos seguidos
      out.push(u);
    }
  };
  const unsafe: Merge3Result["unsafe"] = [];
  const applied: Merge3Result["applied"] = [];
  const conflicts: MergeConflict[] = [];
  let removedCount = 0;
  let addedCount = 0;

  /** Emite o trecho do doc no lugar de `orig` (unidades do atual). */
  const emitDoc = (orig: Unit[], docSlice: Unit[], baseSlice: Unit[]) => {
    const origNb = nonblank(orig);
    const docNb = nonblank(docSlice);
    const pairStyle = origNb.length === docNb.length;
    // Linhas consecutivas do arquivo (quebra "mole": `Por que isso importa:` +
    // texto, `Mais em <url>` + `#hashtags`) que o doc devolve juntas: gravar
    // apagaria a quebra exigida pela regra editorial — nunca grava.
    const hasSoftPair = orig.some((u, i) => u.norm !== "" && orig[i + 1] !== undefined && orig[i + 1].norm !== "");
    if (hasSoftPair && docNb.length < origNb.length) {
      unsafe.push({
        line: docNb.map((u) => u.raw[0]).join(" / ") || "(vazio)",
        reason: "o doc juntou linhas que no arquivo são separadas (quebra de linha perdida)",
      });
    }
    // Linha com HTML/comentário removida no doc: o rich-text descarta HTML na
    // importação — a "remoção" pode não ter sido do editor.
    const docNorms = new Set(docNb.map((u) => u.norm));
    for (const u of nonblank(baseSlice)) {
      if (hasHtml(u.raw[0]) && !docNorms.has(u.norm)) {
        unsafe.push({ line: u.raw[0], reason: "linha com HTML/comentário removida no doc (o editor rich-text descarta HTML)" });
      }
    }
    let k = 0;
    const added: string[] = [];
    const emitted: Unit[] = [];
    for (const u of docSlice) {
      if (u.norm === "") {
        emitted.push({ norm: "", raw: [""] });
        continue;
      }
      const original = pairStyle ? origNb[k]?.raw[0] : undefined;
      k++;
      const r = unescapeForWrite(u.raw[0], original);
      if (!r.ok) unsafe.push({ line: u.raw[0], reason: r.reason ?? "des-escape não confiável" });
      added.push(r.text);
      emitted.push({ norm: u.norm, raw: [r.text] });
    }
    push(emitted);
    const removed = origNb.map((u) => u.raw[0]);
    applied.push({ removed, added });
    removedCount += removed.length;
    addedCount += added.length;
  };

  let curPos = 0;
  for (const cl of clusters) {
    const cs = mapStart(cHunks, cl.s);
    const ce = mapEnd(cHunks, cl.e);
    push(C.slice(curPos, cs));
    curPos = ce;
    const curSlice = C.slice(cs, ce);
    if (!cl.d.some((h) => !h.cosmetic)) {
      push(curSlice);
      continue;
    }
    const docSlice = D.slice(mapStart(dAll, cl.s), mapEnd(dAll, cl.e));
    const baseSlice = B.slice(cl.s, cl.e);
    if (cl.c.length === 0) {
      emitDoc(curSlice, docSlice, baseSlice);
      continue;
    }
    // Doc e pipeline mexeram no mesmo trecho: igual dos dois lados = ok.
    if (paragraphText(docSlice) === paragraphText(curSlice)) {
      push(curSlice);
      continue;
    }
    conflicts.push({
      base: nonblank(baseSlice).map((u) => u.raw[0]),
      doc: nonblank(docSlice).map((u) => u.raw[0]),
      current: nonblank(curSlice).map((u) => u.raw[0]),
    });
    if (onConflict === "doc") emitDoc(curSlice, docSlice, baseSlice);
    else push(curSlice);
  }
  push(C.slice(curPos));

  const lines = [...tc.lead.flatMap((u) => u.raw), ...out.flatMap((u) => u.raw), ...tc.tail.flatMap((u) => u.raw)];
  let content = lines.join(eol);
  if (hadTrailingNewline) content += eol;
  return { docChanged: true, content, conflicts, unsafe, applied, removedCount, addedCount, currentCount, layoutChanged };
}

export interface MergeResult {
  changed: boolean;
  content: string;
  unsafe: Array<{ line: string; reason: string }>;
  removed: string[];
  added: string[];
}

/**
 * Aplica sobre `target` as edições que o doc tem em relação a ele (merge de 3
 * vias com base == atual). Trechos iguais ou cosméticos mantêm os bytes do alvo.
 */
export function mergeDocOnto(target: string, docSection: string): MergeResult {
  const r = merge3(target, target, docSection);
  if (!r.docChanged) return { changed: false, content: target, unsafe: [], removed: [], added: [] };
  return {
    changed: true,
    content: r.content,
    unsafe: r.unsafe,
    removed: r.applied.flatMap((h) => h.removed),
    added: r.applied.flatMap((h) => h.added),
  };
}

/** Doc e texto equivalentes a menos de diferenças cosméticas de export. */
export function docEquivalent(target: string, docSection: string): boolean {
  return !merge3(target, target, docSection).docChanged;
}

// ─── Resumo de diff (para o relatório) ───────────────────────────────────────

const DIFF_SUMMARY_MAX_LINES = 20;

export interface DiffSummary {
  lines: string[];
  truncated: number;
}

/** Resumo `- linha`/`+ linha` intercalado POR TRECHO (cosméticos ignorados). */
export function summarizeHunks(hunks: Array<{ removed: string[]; added: string[] }>): DiffSummary {
  const all = hunks.flatMap((h) => [...h.removed.map((l) => `- ${l}`), ...h.added.map((l) => `+ ${l}`)]);
  return { lines: all.slice(0, DIFF_SUMMARY_MAX_LINES), truncated: Math.max(0, all.length - DIFF_SUMMARY_MAX_LINES) };
}

export function diffSummary(from: string, to: string): DiffSummary {
  return summarizeHunks(merge3(from, from, to).applied);
}

// ─── Decisão de 3 vias ───────────────────────────────────────────────────────

export type Resolution = "arquivo" | "doc";

export interface ResolutionSpec {
  choice: Resolution;
  /** `resolve_token` do conflito que o editor viu — amarra a decisão a ele. */
  token: string;
}

/** Token que amarra uma resolução ao conflito exato que o editor viu. */
export function resolveToken(current: string, docSection: string): string {
  return sha256(`${sha256(current)}:${sha256(docSection)}`).slice(0, 12);
}

interface OutcomeCommon {
  file: SyncFile;
}

export type FileOutcome =
  | (OutcomeCommon & { action: "unchanged" })
  /** doc == base, arquivo mudou (pipeline) — re-render do doc. */
  | (OutcomeCommon & { action: "doc_stale" })
  /** Edição do doc puxada. `three_way`: o pipeline também mudou o arquivo em
   * trechos disjuntos (o doc fica para trás — re-render). */
  | (OutcomeCommon & {
      action: "pulled";
      write: string;
      newBase: string;
      three_way: boolean;
      changes: DiffSummary;
    })
  /** arquivo != base mas doc ≡ arquivo — só a base avança. */
  | (OutcomeCommon & { action: "base_updated"; newBase: string })
  /** Nada gravado. */
  | (OutcomeCommon & {
      action: "conflict";
      reason: string;
      editor_changes: DiffSummary;
      pipeline_changes: DiffSummary;
      overlaps: MergeConflict[];
      unsafe: Merge3Result["unsafe"];
      current_sha256: string;
      doc_sha256: string;
      resolve_token: string;
    })
  /** Conflito resolvido pelo editor: manter arquivo NOS TRECHOS EM CONFLITO —
   * as edições do doc em trechos disjuntos são aplicadas (`write`/`changes`;
   * `write` == atual quando não há nenhuma ou quando são inseguras). A base
   * vira o conteúdo do doc (a edição rejeitada) — o próximo apply dá
   * `doc_stale`, nunca `pulled`. */
  | (OutcomeCommon & { action: "resolved_keep_file"; write: string; newBase: string; changes: DiffSummary })
  /** Conflito resolvido pelo editor: doc vence nos trechos em conflito. */
  | (OutcomeCommon & { action: "resolved_apply_doc"; write: string; newBase: string; changes: DiffSummary });

/** Remoção em massa: seção vazia ou o merge remove (líquido) >50% das linhas. */
function massRemovalReason(m: Merge3Result, docSection: string): string | null {
  if (docSection.trim() === "") return "remoção em massa: seção do doc vazia";
  const net = m.removedCount - m.addedCount;
  if (m.currentCount > 0 && net > m.currentCount / 2) {
    return `remoção em massa: o doc remove ${net} de ${m.currentCount} linhas (>50%)`;
  }
  return null;
}

export function decideFile(
  file: SyncFile,
  base: string,
  current: string,
  doc: string,
  resolution?: ResolutionSpec,
): FileOutcome {
  const fileEqBase = current === base;
  const m = merge3(base, current, doc);

  if (!m.docChanged) return fileEqBase ? { file, action: "unchanged" } : { file, action: "doc_stale" };
  if (!fileEqBase && docEquivalent(current, doc)) return { file, action: "base_updated", newBase: current };

  const mass = massRemovalReason(m, doc);
  const reasons: string[] = [];
  if (m.conflicts.length > 0) reasons.push("arquivo mudou no repositório E no doc no mesmo trecho desde o último render");
  if (m.unsafe.length > 0) reasons.push("edição do doc não pôde ser des-escapada com segurança");
  if (mass) reasons.push(mass);

  if (reasons.length === 0) {
    // Base nova: com o arquivo intocado, o próprio resultado (bytes do arquivo);
    // com pipeline em trecho disjunto, o DOC — senão o próximo apply leria as
    // mudanças do pipeline como "edição do doc" e as reverteria.
    return {
      file,
      action: "pulled",
      write: m.content,
      newBase: fileEqBase ? m.content : doc,
      three_way: !fileEqBase,
      changes: summarizeHunks(m.applied),
    };
  }

  const token = resolveToken(current, doc);
  const conflict = (reason: string): FileOutcome => ({
    file,
    action: "conflict",
    reason,
    editor_changes: diffSummary(base, doc),
    pipeline_changes: diffSummary(base, current),
    overlaps: m.conflicts,
    unsafe: m.unsafe,
    current_sha256: sha256(current),
    doc_sha256: sha256(doc),
    resolve_token: token,
  });
  const baseReason = `${reasons.join("; ")} — nada gravado`;

  if (!resolution) return conflict(baseReason);
  if (resolution.token !== token) {
    return conflict(
      `resolução '${resolution.choice}@${resolution.token}' não corresponde ao conflito atual (token ${token}) — arquivo ou doc mudou desde a decisão; ${baseReason}`,
    );
  }
  if (resolution.choice === "arquivo") {
    // `m` já é o merge com o arquivo vencendo nos trechos em conflito. Se o que
    // sobra do doc for inseguro/remoção em massa, mantém o arquivo inteiro.
    const safe = m.unsafe.length === 0 && !mass;
    return {
      file,
      action: "resolved_keep_file",
      write: safe ? m.content : current,
      newBase: doc,
      changes: safe ? summarizeHunks(m.applied) : { lines: [], truncated: 0 },
    };
  }

  const md = merge3(base, current, doc, "doc");
  const mdMass = massRemovalReason(md, doc);
  if (md.unsafe.length > 0 || mdMass) {
    return conflict(
      `resolução 'doc' pedida, mas ${md.unsafe.length > 0 ? "a edição do doc não pôde ser des-escapada com segurança" : mdMass} — nada gravado`,
    );
  }
  return { file, action: "resolved_apply_doc", write: md.content, newBase: doc, changes: summarizeHunks(md.applied) };
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

function validateBase(raw: unknown, where: string): Record<SyncFile, BaseEntry> {
  const b = raw as Partial<Record<SyncFile, Partial<BaseEntry>>> | undefined;
  for (const file of SYNC_FILES) {
    const entry = b?.[file];
    if (!entry || typeof entry.content !== "string" || typeof entry.sha256 !== "string") {
      throw new DocsSyncFormatError(`${STATE_FILENAME}: ${where} sem base válida de ${file}`);
    }
    if (sha256(entry.content) !== entry.sha256) {
      throw new DocsSyncFormatError(`${STATE_FILENAME}: ${where} de ${file} com sha256 que não bate com o conteúdo (estado corrompido)`);
    }
  }
  return b as Record<SyncFile, BaseEntry>;
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
  if (!parsed || typeof parsed !== "object") throw new DocsSyncFormatError(`${STATE_FILENAME} não é um objeto`);
  const st = parsed as Partial<DocsGateState>;
  validateBase(st.base, "base");
  if (typeof st.rendered_at !== "string") throw new DocsSyncFormatError(`${STATE_FILENAME}: rendered_at ausente/inválido`);
  if (st.doc_url !== undefined && (typeof st.doc_url !== "string" || st.doc_url === "")) {
    throw new DocsSyncFormatError(`${STATE_FILENAME}: doc_url inválido`);
  }
  if (st.pending !== undefined) {
    validateBase(st.pending?.base, "pending");
    if (typeof st.pending.rendered_at !== "string") throw new DocsSyncFormatError(`${STATE_FILENAME}: pending.rendered_at inválido`);
  }
  return st as DocsGateState;
}

function writeState(editionDir: string, state: DocsGateState): void {
  const p = statePath(editionDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify(state, null, 2) + "\n");
}

function requireState(editionDir: string, cmd: string): DocsGateState {
  const state = readState(editionDir);
  if (!state) throw new DocsSyncFormatError(`${STATE_FILENAME} ausente — rode \`render\` antes de \`${cmd}\``);
  return state;
}

function readExport(path: string): Record<SyncFile, string> {
  if (!existsSync(path)) throw new DocsSyncFormatError(`export do doc não encontrado: ${path}`);
  return parseDocExport(readFileSync(path, "utf8"));
}

function disabledError(state: DocsGateState): DocsSyncFormatError {
  return new DocsSyncFormatError(
    `sync desativado para este doc (${state.sync_disabled?.reason}) — edições do doc NÃO são puxadas nem o doc é atualizado`,
  );
}

export interface RenderOptions {
  editionDir: string;
  edition: string;
  out?: string;
  summary?: string;
  /** Export atual do doc — obrigatório quando o estado já tem `doc_url`. */
  docExport?: string;
  /** `container.version` lida junto com esse export (guarda de concorrência). */
  docVersion?: string;
  now?: Date;
}

export interface RenderResult {
  out: string;
  /** true = base gravada como PENDENTE (efetivar com `confirm`). */
  pending: boolean;
  doc_url?: string;
  title: string;
  rendered_at: string;
}

/**
 * Gera o markdown do doc. Sem doc existente grava a base direto; com doc
 * existente exige o export, recusa edição pendente e grava a base como
 * PENDENTE. Estado corrompido → `DocsSyncFormatError` (nunca engolido).
 */
export function runRender(opts: RenderOptions): RenderResult {
  const state = readState(opts.editionDir);
  if (state?.sync_disabled) throw disabledError(state);
  const files = readSyncFiles(opts.editionDir);
  const now = (opts.now ?? new Date()).toISOString();

  if (state?.doc_url) {
    if (!opts.docExport) {
      throw new DocsSyncFormatError("doc já existe (doc_url no estado): `render` exige --doc-export com o export atual do doc");
    }
    const sections = readExport(opts.docExport);
    const pendingEdits = SYNC_FILES.filter((f) => !docEquivalent(state.base[f].content, sections[f]));
    if (pendingEdits.length > 0) {
      throw new DocsSyncFormatError(
        `o doc tem edição ainda não puxada em ${pendingEdits.join(", ")} — rode \`apply\` (e resolva conflitos) antes do render; nada gravado`,
      );
    }
  }

  const markdown = renderDocMarkdown({ edition: opts.edition, files, summary: opts.summary });
  const out = opts.out ?? resolve(opts.editionDir, "_internal", DOC_MD_FILENAME);
  mkdirSync(dirname(out), { recursive: true });
  writeFileAtomic(out, markdown);

  let next: DocsGateState;
  let pending: boolean;
  if (state?.doc_url) {
    next = {
      ...state,
      pending: { base: baseOf(files), rendered_at: now, ...(opts.docVersion ? { doc_version: opts.docVersion } : {}) },
    };
    pending = true;
  } else {
    next = { ...(state ?? {}), base: baseOf(files), rendered_at: now } as DocsGateState;
    delete next.pending;
    pending = false;
  }
  writeState(opts.editionDir, next);
  return { out, pending, ...(next.doc_url ? { doc_url: next.doc_url } : {}), title: docTitle(opts.edition), rendered_at: now };
}

/**
 * Efetiva a base pendente (o top-level já substituiu o doc). Com `docExport`,
 * confere que o doc de fato tem o conteúdo pendente antes de efetivar.
 */
export function runConfirm(opts: { editionDir: string; docExport?: string; docVersion?: string }): {
  rendered_at: string;
} {
  const state = requireState(opts.editionDir, "confirm");
  if (!state.pending) {
    throw new DocsSyncFormatError("nenhum render pendente para confirmar (apply posterior invalidou, ou render não rodou)");
  }
  // O render gravou a version do export que validou: o replace tinha de ser
  // contra ela. Version diferente (ou ausente) = o editor pode ter digitado
  // entre o export e o replace — não efetiva; voltar ao apply.
  if (state.pending.doc_version !== undefined && opts.docVersion !== state.pending.doc_version) {
    throw new DocsSyncFormatError(
      `--doc-version ${opts.docVersion ?? "(ausente)"} não bate com a version do export validado pelo render (${state.pending.doc_version}) — base NÃO efetivada; rode apply de novo`,
    );
  }
  if (opts.docExport) {
    const sections = readExport(opts.docExport);
    const off = SYNC_FILES.filter((f) => !docEquivalent(state.pending!.base[f].content, sections[f]));
    if (off.length > 0) {
      throw new DocsSyncFormatError(`o doc não tem o conteúdo do render pendente em ${off.join(", ")} — base NÃO efetivada`);
    }
  }
  const next: DocsGateState = { ...state, base: state.pending.base, rendered_at: state.pending.rendered_at };
  delete next.pending;
  writeState(opts.editionDir, next);
  return { rendered_at: next.rendered_at };
}

/** Grava só o `doc_url` (não toca na base). */
export function runSetUrl(opts: { editionDir: string; docUrl: string }): void {
  const state = requireState(opts.editionDir, "set-url");
  if (!/^https?:\/\//.test(opts.docUrl)) throw new DocsSyncFormatError(`--doc-url inválido: ${opts.docUrl}`);
  writeState(opts.editionDir, { ...state, doc_url: opts.docUrl });
}

/** Desliga o sync do doc por decisão explícita (ex.: editor aprovou o gate
 * "sem as edições do doc" depois de um sync final que falhou). */
export function runDisable(opts: { editionDir: string; reason: string; now?: Date }): void {
  const state = requireState(opts.editionDir, "disable");
  if (!opts.reason.trim()) throw new DocsSyncFormatError("--reason obrigatório no disable");
  writeState(opts.editionDir, { ...state, sync_disabled: { reason: opts.reason, at: (opts.now ?? new Date()).toISOString() } });
}

export interface RoundtripResult {
  ok: boolean;
  reason?: string;
  files: Array<{ file: SyncFile; equivalent: boolean; diff?: DiffSummary }>;
}

/**
 * Logo após criar o doc: o export do doc intocado tem de voltar equivalente à
 * base. Qualquer diferença (ou sentinela perdida) DESATIVA o sync deste doc
 * (`sync_disabled`) — o round-trip do conector não é confiável para ele.
 */
export function runCheckRoundtrip(opts: { editionDir: string; docExport: string; now?: Date }): RoundtripResult {
  const state = requireState(opts.editionDir, "check-roundtrip");
  const result = evaluateRoundtrip(state, opts.docExport);
  if (!result.ok) {
    writeState(opts.editionDir, {
      ...state,
      sync_disabled: { reason: result.reason ?? "round-trip falhou", at: (opts.now ?? new Date()).toISOString() },
    });
  }
  return result;
}

/** Compara o export com a base sem gravar nada. Erro de formato do export
 * (sentinela perdida etc.) vira reprovação; erro de I/O propaga. */
function evaluateRoundtrip(state: DocsGateState, docExport: string): RoundtripResult {
  let result: RoundtripResult;
  try {
    const sections = readExport(docExport);
    const files = SYNC_FILES.map((file) => {
      const base = state.base[file].content;
      // Estrito: além de nenhuma edição, nenhuma linha juntada/partida (o
      // conector não preservou a quebra de linha — editar ali perderia a quebra).
      const m = merge3(base, base, sections[file]);
      const equivalent = !m.docChanged && !m.layoutChanged;
      return equivalent ? { file, equivalent } : { file, equivalent, diff: diffSummary(state.base[file].content, sections[file]) };
    });
    const bad = files.filter((f) => !f.equivalent).map((f) => f.file);
    result = bad.length === 0 ? { ok: true, files } : { ok: false, reason: `round-trip do doc alterou ${bad.join(", ")} sem edição`, files };
  } catch (e) {
    if (!(e instanceof DocsSyncFormatError)) throw e;
    result = { ok: false, reason: `round-trip do doc falhou: ${e.message}`, files: [] };
  }
  return result;
}

export interface EnableResult extends RoundtripResult {
  /** true = o sync já estava ativo (nada mudou). */
  already_enabled?: boolean;
}

/**
 * Religa o sync depois de um `disable` (#10078) — só com o round-trip verde:
 * o export do doc tem de voltar equivalente à base. Reprovado → o sync segue
 * desligado (o motivo original é preservado) e nada é gravado. Aprovado →
 * apaga `sync_disabled` e também `final_apply`/`pending`, que eram de antes do
 * desligamento: o `check` do §4e volta a exigir um `apply --final` novo.
 *
 * Doc com edição do editor feita enquanto o sync estava desligado reprova de
 * propósito: sem o round-trip limpo não dá para separar edição de alteração do
 * conector.
 */
export function runEnable(opts: { editionDir: string; docExport: string }): EnableResult {
  const state = requireState(opts.editionDir, "enable");
  if (!state.doc_url) throw new DocsSyncFormatError("sem doc_url no estado — não há doc para religar o sync");
  if (!state.sync_disabled) return { ok: true, already_enabled: true, files: [] };
  const result = evaluateRoundtrip(state, opts.docExport);
  if (!result.ok) {
    return { ...result, reason: `sync continua desativado — ${result.reason}` };
  }
  const next: DocsGateState = { ...state };
  delete next.sync_disabled;
  delete next.final_apply;
  delete next.pending;
  writeState(opts.editionDir, next);
  return result;
}

export interface StatusResult {
  /** false = sem `04-docs-gate.json` ou sem `doc_url`. */
  has_doc: boolean;
  doc_url?: string;
  sync_enabled: boolean;
  sync_disabled?: { reason: string; at: string };
  /** Arquivos que o pipeline mudou desde o conteúdo que está no doc (sha do
   * arquivo ≠ sha da base). O doc NÃO mostra essas mudanças; as edições do
   * editor no doc são mescladas por cima delas no apply final (3 vias). */
  files_changed_since_doc: SyncFile[];
  pending_conflict: SyncFile[];
  final_apply_at?: string;
}

/**
 * Estado do doc SEM export (#10078) — custo zero, sem conector. É o que o
 * gate consulta a cada apresentação no lugar do ciclo export → apply: o
 * export do doc chega ao disco uma vez só, na finalização (ramo `sim`).
 */
export function runStatus(opts: { editionDir: string }): StatusResult {
  const state = readState(opts.editionDir);
  if (!state || !state.doc_url) {
    return { has_doc: false, sync_enabled: false, files_changed_since_doc: [], pending_conflict: [] };
  }
  const files = readSyncFiles(opts.editionDir);
  return {
    has_doc: true,
    doc_url: state.doc_url,
    sync_enabled: !state.sync_disabled,
    ...(state.sync_disabled ? { sync_disabled: state.sync_disabled } : {}),
    files_changed_since_doc: SYNC_FILES.filter((f) => sha256(files[f]) !== state.base[f].sha256),
    pending_conflict: state.pending_conflict ?? [],
    ...(state.final_apply ? { final_apply_at: state.final_apply.at } : {}),
  };
}

type ReportOutcome = FileOutcome extends infer O ? (O extends FileOutcome ? Omit<O, "write" | "newBase"> : never) : never;

export interface ApplyReport {
  ok: boolean;
  doc_url?: string;
  files: ReportOutcome[];
  /** Arquivos que receberam edição do doc (inclui `resolved_apply_doc`). */
  pulled: SyncFile[];
  /** Resumo do diff puxado por arquivo (para o "📝 Edições do doc puxadas"). */
  pulled_changes: Partial<Record<SyncFile, DiffSummary>>;
  /** Doc atrás do arquivo — atualizar o doc (apply → render → substituir → confirm). */
  doc_stale: SyncFile[];
  /** Conflitos resolvidos com "manter arquivo" — o doc ainda mostra a edição rejeitada: atualizar o doc. */
  kept_file: SyncFile[];
  conflicts: Array<Extract<ReportOutcome, { action: "conflict" }>>;
}

export interface ApplyOptions {
  editionDir: string;
  docExport: string;
  resolutions?: Partial<Record<SyncFile, ResolutionSpec>>;
  /** Apply final do ramo `sim`: sem conflito, grava `final_apply` (o `check`
   * do §4e exige). Apply não-final apaga `final_apply`. */
  final?: boolean;
  /** Tamanho em bytes do export devolvido pelo conector (#10116). Quando
   * passado, o arquivo em `docExport` tem de ter exatamente esse tamanho —
   * senão a cópia manual do export saiu truncada/alterada e nada é gravado. */
  expectedBytes?: number;
  now?: Date;
  /** Só para teste: roda entre a decisão e a releitura pré-escrita (TOCTOU). */
  beforeWrite?: (file: SyncFile) => void;
}

const REPLACEMENT_CHAR = "\uFFFD";

function countReplacementChars(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === REPLACEMENT_CHAR) n++;
  return n;
}

/**
 * #10116: o export chega ao disco copiado à mão (base64 → decode). Um erro de
 * cópia fora das linhas-sentinela vira U+FFFD (byte UTF-8 inválido) e, sem
 * esta checagem, entraria em `02-reviewed.md`/`03-social.md` como "edição do
 * editor". Recusa (exit 2, nada gravado) qualquer seção do export com mais
 * U+FFFD do que o arquivo/base já tinham — só o U+FFFD pré-existente no
 * conteúdo (raro, mas legítimo) é tolerado.
 */
function assertNoReplacementChars(
  sections: Record<SyncFile, string>,
  current: Record<SyncFile, string>,
  base: DocsGateState["base"],
): void {
  const bad = SYNC_FILES.filter((file) => {
    const inExport = countReplacementChars(sections[file]);
    if (inExport === 0) return false;
    return inExport > Math.max(countReplacementChars(current[file]), countReplacementChars(base[file].content));
  });
  if (bad.length > 0) {
    throw new DocsSyncFormatError(
      `export do doc contém caractere U+FFFD (cópia/decodificação corrompida) em ${bad.join(", ")} — refaça a cópia do export (nada gravado)`,
    );
  }
}

function stripOutcome(o: FileOutcome): ReportOutcome {
  const { write: _w, newBase: _n, ...rest } = o as FileOutcome & { write?: string; newBase?: string };
  return rest as ReportOutcome;
}

/**
 * Lê o export, decide por arquivo e só então grava (um erro de formato aborta
 * antes de qualquer escrita). Conflito não grava aquele arquivo mas não impede
 * de puxar o outro. O arquivo é relido logo antes de gravar: se mudou durante
 * o apply, vira conflito (TOCTOU). Falha inesperada → `DocsSyncUnexpectedError`
 * com a lista do que já foi gravado.
 */
export function runApply(opts: ApplyOptions): ApplyReport {
  const state = requireState(opts.editionDir, "apply");
  if (state.sync_disabled) throw disabledError(state);
  const exportBytes = existsSync(opts.docExport) ? readFileSync(opts.docExport) : null;
  if (exportBytes === null) throw new DocsSyncFormatError(`export do doc não encontrado: ${opts.docExport}`);
  if (opts.expectedBytes !== undefined && exportBytes.length !== opts.expectedBytes) {
    throw new DocsSyncFormatError(
      `export do doc com ${exportBytes.length} bytes, o conector devolveu ${opts.expectedBytes} — cópia do export corrompida; refaça a cópia (nada gravado)`,
    );
  }
  const exportText = exportBytes.toString("utf8");
  const sections = parseDocExport(exportText);
  const current = readSyncFiles(opts.editionDir);
  assertNoReplacementChars(sections, current, state.base);

  const outcomes: FileOutcome[] = SYNC_FILES.map((file) =>
    decideFile(file, state.base[file].content, current[file], sections[file], opts.resolutions?.[file]),
  );

  const written: string[] = [];
  try {
    const finalContent = { ...current };
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      if (o.action === "pulled" || o.action === "resolved_apply_doc" || o.action === "resolved_keep_file") {
        if (o.write === current[o.file]) continue; // nada a gravar
        const path = resolve(opts.editionDir, o.file);
        opts.beforeWrite?.(o.file);
        const now = readFileSync(path, "utf8");
        if (now !== current[o.file]) {
          outcomes[i] = {
            file: o.file,
            action: "conflict",
            reason: "arquivo mudou durante o apply (escrita concorrente) — nada gravado",
            editor_changes: diffSummary(state.base[o.file].content, sections[o.file]),
            pipeline_changes: diffSummary(state.base[o.file].content, now),
            overlaps: [],
            unsafe: [],
            current_sha256: sha256(now),
            doc_sha256: sha256(sections[o.file]),
            resolve_token: resolveToken(now, sections[o.file]),
          };
          continue;
        }
        if (o.write !== now) {
          writeFileAtomic(path, o.write);
          written.push(o.file);
        }
        finalContent[o.file] = o.write;
      }
    }
    for (const o of outcomes) {
      if ("newBase" in o) state.base[o.file] = { sha256: sha256(o.newBase), content: o.newBase };
    }
    const conflictFiles = outcomes.filter((o) => o.action === "conflict").map((o) => o.file);
    if (written.length > 0) delete state.pending; // render pendente ficou velho
    const at = (opts.now ?? new Date()).toISOString();
    state.last_apply_at = at;
    delete state.final_apply;
    if (conflictFiles.length > 0) {
      state.pending_conflict = conflictFiles;
    } else {
      delete state.pending_conflict;
      if (opts.final) {
        state.final_apply = {
          at,
          export_sha256: sha256(exportText),
          files_sha: Object.fromEntries(SYNC_FILES.map((f) => [f, sha256(finalContent[f])])) as Record<SyncFile, string>,
        };
      }
    }
    writeState(opts.editionDir, state);
  } catch (e) {
    throw new DocsSyncUnexpectedError((e as Error).message, written);
  }

  const pulledOutcomes = outcomes.filter(
    (o): o is Extract<FileOutcome, { action: "pulled" | "resolved_apply_doc" | "resolved_keep_file" }> =>
      o.action === "pulled" ||
      o.action === "resolved_apply_doc" ||
      (o.action === "resolved_keep_file" && o.changes.lines.length > 0),
  );
  const conflicts = outcomes
    .filter((o): o is Extract<FileOutcome, { action: "conflict" }> => o.action === "conflict")
    .map((o) => stripOutcome(o) as Extract<ReportOutcome, { action: "conflict" }>);
  const docStale: SyncFile[] = [];
  for (const o of outcomes) {
    switch (o.action) {
      case "doc_stale":
        docStale.push(o.file);
        break;
      case "pulled":
        if (o.three_way) docStale.push(o.file);
        break;
      case "resolved_apply_doc":
        // Doc atrás só se sobrou mudança do pipeline FORA dos trechos em
        // conflito (o arquivo final difere do doc). Comparar com a base nova
        // (que já é o doc) daria sempre "atrás".
        if (!docEquivalent(o.write, sections[o.file])) docStale.push(o.file);
        break;
      case "unchanged":
      case "base_updated":
      case "conflict":
      case "resolved_keep_file":
        break;
    }
  }
  return {
    ok: conflicts.length === 0,
    ...(state.doc_url ? { doc_url: state.doc_url } : {}),
    files: outcomes.map(stripOutcome),
    pulled: pulledOutcomes.map((o) => o.file),
    pulled_changes: Object.fromEntries(pulledOutcomes.map((o) => [o.file, o.changes])),
    doc_stale: docStale,
    kept_file: outcomes.filter((o) => o.action === "resolved_keep_file").map((o) => o.file),
    conflicts,
  };
}

export interface CheckResult {
  ok: boolean;
  reason: string;
}

/**
 * Conferência mecânica antes do sentinel do Stage 4 (§4e): sem doc ou com sync
 * desativado → ok (nada a conferir); senão exige que o ÚLTIMO apply tenha
 * sido um `apply --final` sem conflito e que os arquivos não tenham mudado
 * desde ele.
 */
export function runCheck(opts: { editionDir: string }): CheckResult {
  const state = readState(opts.editionDir);
  if (!state || !state.doc_url) return { ok: true, reason: "sem doc editável" };
  if (state.sync_disabled) return { ok: true, reason: `sync desativado (${state.sync_disabled.reason})` };
  if (state.pending_conflict && state.pending_conflict.length > 0) {
    return { ok: false, reason: `conflito pendente em ${state.pending_conflict.join(", ")} — resolva com apply --resolve` };
  }
  const fin = state.final_apply;
  if (!fin) {
    return { ok: false, reason: "o apply final (`apply --final`, ramo `sim`) não rodou depois da última apresentação/apply" };
  }
  const files = readSyncFiles(opts.editionDir);
  const changed = SYNC_FILES.filter((f) => sha256(files[f]) !== fin.files_sha[f]);
  if (changed.length > 0) {
    return { ok: false, reason: `${changed.join(", ")} mudou depois do apply final — rode o apply final de novo` };
  }
  return { ok: true, reason: `apply final ok em ${fin.at}` };
}

/** `02-reviewed.md=arquivo@<token>,03-social.md=doc@<token>` (aceita sem `.md`).
 * O token é o `resolve_token` do conflito — obrigatório. Chave repetida → erro. */
export function parseResolutions(spec: string): Partial<Record<SyncFile, ResolutionSpec>> {
  const out: Partial<Record<SyncFile, ResolutionSpec>> = {};
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(02-reviewed|03-social)(?:\.md)?=(arquivo|doc)@([0-9a-f]{12})$/.exec(part);
    if (!m) {
      throw new DocsSyncFormatError(
        `--resolve inválido: "${part}" (esperado 02-reviewed.md=arquivo|doc@<resolve_token do conflito>)`,
      );
    }
    const file = `${m[1]}.md` as SyncFile;
    if (out[file]) throw new DocsSyncFormatError(`--resolve repete ${file}`);
    out[file] = { choice: m[2] as Resolution, token: m[3] };
  }
  return out;
}
