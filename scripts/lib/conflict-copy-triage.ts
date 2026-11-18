/**
 * scripts/lib/conflict-copy-triage.ts (#13423)
 *
 * Triagem das cópias `.conflictN` que o rclone bisync de `data/` deixou
 * espalhadas no período em que o sync abortava a cada rodada (#13404). O
 * `--resync` une os dois lados, então devolveu até as cópias já movidas à mão
 * para as pastas `_conflitos-*`: em 17/11/2026 eram ~430 fora delas.
 *
 * A regra é a da issue, por arquivo: comparar cada cópia com o original e só
 * ARQUIVAR (mover para `_conflitos-{AAMMDD}/`, irmã da cópia, a mesma
 * convenção das pastas que já existem, ex.
 * `editions/2611/261117/_internal/_conflitos-261117/`) quando o original
 * existe e é válido. Nunca apaga nada: o #9732 já mostrou que a cópia de
 * conflito pode ser a única de algo.
 *
 * Três vereditos:
 *   - `archive`: o original existe e é válido, e a cópia é idêntica a ele, ou
 *     é inválida, ou é mais antiga (mtime) sem linha de JSONL que só ela tem;
 *   - `review`: o original é válido, mas a cópia pode ser a boa — mais nova
 *     que ele e diferente, com linhas de JSONL que o original não tem, ou é
 *     registro de sessão (`sessions/`), que o `session-registry` lê em união
 *     fail-safe (#6130) e tem limpeza própria (`planSafeBackupCleanup`);
 *   - `keep`: o original não existe ou é inválido. A cópia pode ser a única,
 *     e quem decide é o editor, olhando o conteúdo.
 *
 * O `--apply` (camada CLI, `scripts/triage-conflict-copies.ts`) só move o que
 * um plano gravado pelo dry-run marcou `archive`, depois de reconferir os
 * hashes da cópia e do original: se qualquer um dos dois mudou entre o
 * dry-run e o apply, a entrada é pulada.
 */

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, sep } from "node:path";
import { RCLONE_CONFLICT_SUFFIX_RE } from "./sync-conflict-copy.ts";

/** Pasta de arquivamento: `_conflitos-{qualquer coisa}`. Nunca varrida. */
export const ARCHIVE_DIR_PREFIX = "_conflitos-";

/** Diretórios que a varredura não desce. */
const SKIP_DIR_NAMES = new Set([".git", "node_modules"]);

/** Acima disso o JSON/JSONL não é parseado (validade cai para "não vazio"). */
export const MAX_PARSE_BYTES = 64 * 1024 * 1024;

/**
 * Nome do original de uma cópia `.conflictN`, removendo o sufixo em cadeia
 * (`s.json.conflict1.conflict3` → `s.json`). `null` sem sufixo, ou se sobrar
 * nome vazio.
 */
export function conflictChainOriginalName(name: string): string | null {
  if (!RCLONE_CONFLICT_SUFFIX_RE.test(name)) return null;
  let cur = name;
  while (RCLONE_CONFLICT_SUFFIX_RE.test(cur)) cur = cur.replace(RCLONE_CONFLICT_SUFFIX_RE, "");
  return cur.length > 0 ? cur : null;
}

export type Validity = { ok: true } | { ok: false; why: string };

/**
 * Validade de um arquivo pelo tipo: JSON parseia (inteiro ou uma linha JSON
 * por linha); JSONL tem toda linha não
 * vazia parseável; SQLite começa com o cabeçalho `SQLite format 3\0`; o resto
 * só precisa não ser vazio. Arquivo maior que `MAX_PARSE_BYTES` não é
 * parseado (só "não vazio").
 */
export function fileValidity(path: string): Validity {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    return { ok: false, why: `ilegível: ${(e as Error).message}` };
  }
  if (size === 0) return { ok: false, why: "vazio" };
  const kind = fileKind(path);
  if (kind === "sqlite") {
    const head = readHead(path, 16);
    return head.toString("latin1") === "SQLite format 3\u0000" ? { ok: true } : { ok: false, why: "sem cabeçalho SQLite" };
  }
  if (size > MAX_PARSE_BYTES || kind === "other") return { ok: true };
  const text = readFileSync(path, "utf8");
  if (kind === "json") {
    try {
      JSON.parse(text);
      return { ok: true };
    } catch {
      // `.json` com uma linha JSON por linha também é válido: o
      // `overnight/.nightly-chain-last-overnight.json` é a saída stream-json
      // do `claude --print`, medido em 17/11/2026.
      return jsonLinesValidity(text).ok ? { ok: true } : { ok: false, why: "JSON inválido" };
    }
  }
  return jsonLinesValidity(text);
}

function jsonLinesValidity(text: string): Validity {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      JSON.parse(line);
    } catch {
      return { ok: false, why: `JSONL inválido na linha ${i + 1}` };
    }
  }
  return { ok: true };
}

export type FileKind = "json" | "jsonl" | "sqlite" | "other";

/** Tipo pelo nome do ORIGINAL (sem `.conflictN`). */
export function fileKind(path: string): FileKind {
  const name = conflictChainOriginalName(basename(path)) ?? basename(path);
  const lower = name.toLowerCase();
  if (lower.endsWith(".jsonl")) return "jsonl";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".db") || lower.endsWith(".sqlite") || lower.endsWith(".sqlite3")) return "sqlite";
  return "other";
}

function readHead(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** sha256 em blocos (as cópias de `.db` passam de centenas de MB). */
export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const got = readSync(fd, buf, 0, buf.length, null);
      if (got === 0) break;
      hash.update(buf.subarray(0, got));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Linhas não vazias do JSONL `copy` que não aparecem no `original`. */
export function jsonlLinesOnlyInCopy(copy: string, original: string): number {
  const have = new Set(readFileSync(original, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
  let n = 0;
  for (const raw of readFileSync(copy, "utf8").split("\n")) {
    const line = raw.trim();
    if (line && !have.has(line)) n++;
  }
  return n;
}

export type Verdict = "archive" | "review" | "keep";

export type Reason =
  | "identica"
  | "copia-invalida"
  | "copia-mais-antiga"
  | "copia-mais-nova-difere"
  | "jsonl-linhas-so-na-copia"
  | "registro-de-sessao"
  | "original-ausente"
  | "original-invalido";

/** Os fatos de uma cópia, já medidos; `classifyConflictCopy` é pura sobre eles. */
export interface CopyFacts {
  /** Caminho relativo à raiz varrida, com `/`. */
  rel: string;
  originalExists: boolean;
  originalValid: Validity | null;
  copyValid: Validity;
  identical: boolean;
  copyMtimeMs: number;
  originalMtimeMs: number | null;
  /** Linhas de JSONL que só a cópia tem (`null` fora de JSONL ou sem medir). */
  jsonlOnlyInCopy: number | null;
}

export interface Classification {
  verdict: Verdict;
  reason: Reason;
  detail: string;
}

/** Cópia dentro de `sessions/` (relativo à raiz `data/`): o `session-registry` lê a cópia em união (#6130). */
export function isSessionRegistryPath(rel: string): boolean {
  return rel.startsWith("sessions/");
}

/** @pure */
export function classifyConflictCopy(f: CopyFacts): Classification {
  if (!f.originalExists) return { verdict: "keep", reason: "original-ausente", detail: "o original não existe: a cópia pode ser a única" };
  if (!f.originalValid || !f.originalValid.ok) {
    const why = f.originalValid && !f.originalValid.ok ? f.originalValid.why : "não verificado";
    return { verdict: "keep", reason: "original-invalido", detail: `original inválido (${why}): a cópia pode ser a boa` };
  }
  if (f.identical) return { verdict: "archive", reason: "identica", detail: "mesmo conteúdo do original" };
  if (!f.copyValid.ok) return { verdict: "archive", reason: "copia-invalida", detail: `cópia inválida (${f.copyValid.why}), original válido` };
  if (isSessionRegistryPath(f.rel)) {
    return { verdict: "review", reason: "registro-de-sessao", detail: "registro de sessão diferente do original: o session-registry lê a cópia em união (#6130); usar a limpeza do registro" };
  }
  if (f.jsonlOnlyInCopy !== null && f.jsonlOnlyInCopy > 0) {
    return { verdict: "review", reason: "jsonl-linhas-so-na-copia", detail: `${f.jsonlOnlyInCopy} linha(s) só na cópia` };
  }
  if (f.originalMtimeMs !== null && f.copyMtimeMs > f.originalMtimeMs) {
    return { verdict: "review", reason: "copia-mais-nova-difere", detail: "cópia mais nova que o original e diferente: pode ser a boa" };
  }
  return { verdict: "archive", reason: "copia-mais-antiga", detail: "original válido e mais novo (ou do mesmo horário) que a cópia" };
}

export interface TriageEntry extends Classification {
  /** Caminho relativo à raiz, com `/`. */
  rel: string;
  /** Caminho relativo do original, com `/`. */
  originalRel: string;
  copySha256: string;
  originalSha256: string | null;
  copyBytes: number;
  copyMtimeMs: number;
  originalMtimeMs: number | null;
}

/** Lista as cópias `.conflictN` sob `root`, fora de `_conflitos-*`, sem seguir symlink de diretório. */
export function findConflictCopies(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name.startsWith(ARCHIVE_DIR_PREFIX) || SKIP_DIR_NAMES.has(name)) continue;
        walk(full);
      } else if (st.isFile() && conflictChainOriginalName(name) !== null) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

function toRel(root: string, p: string): string {
  return relative(root, p).split(sep).join("/");
}

/** Mede e classifica uma cópia. */
export function triageCopy(root: string, copyPath: string): TriageEntry {
  const name = basename(copyPath);
  const originalName = conflictChainOriginalName(name)!;
  const originalPath = join(dirname(copyPath), originalName);
  const cst = statSync(copyPath);
  const originalExists = existsSync(originalPath) && statSync(originalPath).isFile();
  const copySha256 = sha256File(copyPath);
  const originalSha256 = originalExists ? sha256File(originalPath) : null;
  const originalMtimeMs = originalExists ? statSync(originalPath).mtimeMs : null;
  const originalValid = originalExists ? fileValidity(originalPath) : null;
  const copyValid = fileValidity(copyPath);
  const identical = originalSha256 !== null && originalSha256 === copySha256;
  let jsonlOnlyInCopy: number | null = null;
  if (
    originalExists && !identical && fileKind(copyPath) === "jsonl" &&
    cst.size <= MAX_PARSE_BYTES && statSync(originalPath).size <= MAX_PARSE_BYTES
  ) {
    jsonlOnlyInCopy = jsonlLinesOnlyInCopy(copyPath, originalPath);
  }
  const rel = toRel(root, copyPath);
  const cls = classifyConflictCopy({
    rel,
    originalExists,
    originalValid,
    copyValid,
    identical,
    copyMtimeMs: cst.mtimeMs,
    originalMtimeMs,
    jsonlOnlyInCopy,
  });
  return {
    ...cls,
    rel,
    originalRel: toRel(root, originalPath),
    copySha256,
    originalSha256,
    copyBytes: cst.size,
    copyMtimeMs: cst.mtimeMs,
    originalMtimeMs,
  };
}

export interface TriagePlan {
  issue: 13423;
  root: string;
  generatedAt: string;
  /** Sufixo da pasta de arquivamento (`_conflitos-{stamp}`). */
  stamp: string;
  entries: TriageEntry[];
}

/** AAMMDD em BRT (UTC-3, sem horário de verão desde 2019). */
export function brtStampAAMMDD(nowMs: number): string {
  return new Date(nowMs - 3 * 3600_000).toISOString().slice(2, 10).replace(/-/g, "");
}

export function buildTriagePlan(root: string, opts: { nowMs?: number; stamp?: string } = {}): TriagePlan {
  const nowMs = opts.nowMs ?? Date.now();
  return {
    issue: 13423,
    root,
    generatedAt: new Date(nowMs).toISOString(),
    stamp: opts.stamp ?? brtStampAAMMDD(nowMs),
    entries: findConflictCopies(root).map((p) => triageCopy(root, p)),
  };
}

export interface PlanSummary {
  total: number;
  byVerdict: Record<Verdict, number>;
  byReason: Partial<Record<Reason, number>>;
  /** Contagem por diretório (relativo), ordenada pela maior. */
  byDir: Array<{ dir: string; count: number }>;
}

/** @pure */
export function summarizePlan(entries: readonly TriageEntry[]): PlanSummary {
  const byVerdict: Record<Verdict, number> = { archive: 0, review: 0, keep: 0 };
  const byReason: Partial<Record<Reason, number>> = {};
  const dirs = new Map<string, number>();
  for (const e of entries) {
    byVerdict[e.verdict]++;
    byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
    const d = e.rel.includes("/") ? e.rel.slice(0, e.rel.lastIndexOf("/")) : ".";
    dirs.set(d, (dirs.get(d) ?? 0) + 1);
  }
  const byDir = [...dirs.entries()].map(([dir, count]) => ({ dir, count })).sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
  return { total: entries.length, byVerdict, byReason, byDir };
}

export type ApplyOutcome =
  | { rel: string; status: "moved"; to: string }
  | { rel: string; status: "skipped"; why: string };

/**
 * Move para `_conflitos-{stamp}/` (irmã da cópia) cada entrada `archive` do
 * plano, depois de reconferir que a cópia e o original não mudaram desde o
 * dry-run (mesmo sha256, original ainda presente). Destino existente nunca é
 * sobrescrito. Só `rename`: nada é apagado.
 */
export function applyTriagePlan(plan: TriagePlan, root: string): ApplyOutcome[] {
  const out: ApplyOutcome[] = [];
  for (const e of plan.entries) {
    if (e.verdict !== "archive") continue;
    const copyPath = join(root, ...e.rel.split("/"));
    const originalPath = join(root, ...e.originalRel.split("/"));
    if (!existsSync(copyPath)) {
      out.push({ rel: e.rel, status: "skipped", why: "cópia não existe mais" });
      continue;
    }
    if (sha256File(copyPath) !== e.copySha256) {
      out.push({ rel: e.rel, status: "skipped", why: "cópia mudou desde o dry-run" });
      continue;
    }
    if (!existsSync(originalPath)) {
      out.push({ rel: e.rel, status: "skipped", why: "original sumiu desde o dry-run" });
      continue;
    }
    if (e.originalSha256 === null || sha256File(originalPath) !== e.originalSha256) {
      out.push({ rel: e.rel, status: "skipped", why: "original mudou desde o dry-run" });
      continue;
    }
    if (!fileValidity(originalPath).ok) {
      out.push({ rel: e.rel, status: "skipped", why: "original deixou de ser válido" });
      continue;
    }
    const archiveDir = join(dirname(copyPath), `${ARCHIVE_DIR_PREFIX}${plan.stamp}`);
    const dest = join(archiveDir, basename(copyPath));
    if (existsSync(dest)) {
      out.push({ rel: e.rel, status: "skipped", why: "destino já existe no arquivo" });
      continue;
    }
    mkdirSync(archiveDir, { recursive: true });
    renameSync(copyPath, dest);
    out.push({ rel: e.rel, status: "moved", to: toRel(root, dest) });
  }
  return out;
}

/** Confere se o JSON lido é um plano desta triagem. */
export function parseTriagePlan(raw: unknown): TriagePlan {
  const p = raw as Partial<TriagePlan> | null;
  if (!p || p.issue !== 13423 || typeof p.root !== "string" || typeof p.stamp !== "string" || !Array.isArray(p.entries)) {
    throw new Error("plano inválido: não é a saída de triage-conflict-copies.ts --out");
  }
  if (!/^[\w.-]+$/.test(p.stamp)) throw new Error(`plano inválido: stamp "${p.stamp}" não serve de nome de pasta`);
  for (const e of p.entries) {
    if (typeof e?.rel !== "string" || typeof e?.originalRel !== "string" || e.rel.split("/").includes("..") || e.originalRel.split("/").includes("..")) {
      throw new Error("plano inválido: entrada sem caminho relativo seguro");
    }
  }
  return p as TriagePlan;
}
