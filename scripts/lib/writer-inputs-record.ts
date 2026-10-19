/**
 * writer-inputs-record.ts (#9648)
 *
 * Registro auditável do texto-fonte que cada `writer-destaque` recebeu no
 * Stage 2 — `_internal/02-writer-inputs.json` + cópia do texto em
 * `_internal/02-writer-inputs/d{N}-{sha12}.txt` (até #9648-resíduo era
 * `d{N}.txt`; registros antigos guardam esse nome em `snapshot_path`).
 *
 * Por que existe: `_internal/fact-check-sources/manifest.json` e `d{N}.txt`
 * são REGRAVADOS quando o editor troca um destaque no Stage 4
 * (`refresh-destaque-sources.ts` → `prefetchHighlightSources` apaga tudo e
 * re-baixa ao menor desvio de URL; `reorder-destaques.ts` remapeia). Depois
 * disso não sobra registro do texto que o writer do Stage 2 leu, e um fato
 * ausente no corpo (261005 D1) não dá pra atribuir a falha de INSUMO (o fato
 * não estava no texto recebido) ou de PROMPT (estava e o writer não usou).
 *
 * Quem escreve: só `refresh-destaque-sources.ts --record-writer-inputs`, que
 * o Stage 2 roda no passo 0 (antes do dispatch dos writer-destaque). Os
 * caminhos do Stage 4 chamam o mesmo script SEM a flag — então nunca tocam
 * este arquivo. Re-rodar o Stage 2 (resume) grava uma nova gravação no topo
 * e empilha a anterior em `history[]` (ver "Imutabilidade" abaixo).
 *
 * Quem lê: `collect-edition-signals.ts` (`writer_source_text_gap`, warning
 * pro auto-reporter, nunca bloqueante) e a medição do item 3 da #9648.
 *
 * Imutabilidade (#9648, resíduo do item 1): re-gravar NUNCA apaga o que já foi
 * registrado. A cópia do texto é endereçada por conteúdo
 * (`02-writer-inputs/d{N}-{sha12}.txt`), então um re-record não sobrescreve
 * cópia anterior; e `writeWriterInputsRecord` empilha a gravação anterior em
 * `history[]` quando a nova difere (mesmos URL+sha256+status = no-op, mantém
 * o `recorded_at` original). Antes disso, um re-run do passo 0 do Stage 2
 * depois de uma troca no Stage 4 (ex.: `/diaria-2-escrita social`, que roda o
 * passo 0 antes do branch por `$2`) apagava a cópia e o registro do que os
 * writers originais tinham lido.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const WRITER_INPUTS_FILE = "02-writer-inputs.json";
export const WRITER_INPUTS_SNAPSHOT_DIR = "02-writer-inputs";

/**
 * Abaixo disto o texto-fonte é tratado como TRUNCADO (teaser de paywall,
 * página de vídeo, cookie wall). Medido em 05/10/2026 sobre os 27 textos
 * `ok` de `fact-check-sources/` existentes (edições 2609–2610): o menor
 * artigo real tem 3.290 bytes (nota curta do Canaltech) e o único caso
 * abaixo de 3.000 é uma página de VÍDEO do Guardian com 927 bytes — sem
 * corpo de matéria. 2.000 separa os dois com folga dos dois lados, e o
 * `htmlToText` ainda conta menu/cabeçalho residual, então 2.000 bytes de
 * texto bruto já é pouco conteúdo editorial de fato.
 */
export const MIN_SOURCE_TEXT_BYTES = 2000;

/**
 * 1ª edição (AAMMDD) cujo Stage 2 roda obrigatoriamente com
 * `--record-writer-inputs` (#9648). A partir dela, registro AUSENTE com as
 * fontes baixadas (`fact-check-sources/manifest.json` presente) não é
 * "edição antiga": é falha de gravação, e vira signal. 261007 e não 261006
 * porque o Stage 2 da 261006 roda em 05/10/2026, possivelmente antes do merge
 * desta flag — preferimos perder 1 edição a acusar falso positivo.
 */
export const WRITER_INPUTS_CUTOVER_EDITION = "261007";

/** Formato mínimo de uma entrada de `prefetchHighlightSources` (run-fact-checker.ts). */
export interface WriterSourceInput {
  destaque: number;
  url: string;
  path?: string;
  error?: string;
}

export type WriterInputStatus = "ok" | "missing" | "short";

export interface WriterInputEntry {
  destaque: number;
  url: string;
  /** `source_text_path` passado ao writer (relativo ao diretório da edição); null = writer recebeu só title+summary. */
  source_text_path: string | null;
  /** Cópia congelada do texto recebido (relativa ao diretório da edição) — o Stage 4 não a sobrescreve. */
  snapshot_path: string | null;
  bytes: number | null;
  sha256: string | null;
  status: WriterInputStatus;
  /** Motivo do download falho (só quando `status: "missing"`). */
  error: string | null;
}

/** Uma gravação do passo 0 do Stage 2 (a atual ou uma anterior, em `history`). */
export interface WriterInputsRecording {
  recorded_at: string;
  /** Approved de onde vieram as URLs (relativo ao diretório da edição). */
  approved_path: string | null;
  min_source_text_bytes: number;
  /**
   * Nº de destaques do approved no momento da gravação (#9648). Destaque
   * 1..highlight_count sem entrada em `destaques` = writer despachado sem
   * registro do que leu. Ausente em registros anteriores a este campo.
   */
  highlight_count?: number;
  destaques: WriterInputEntry[];
}

export interface WriterInputsRecord extends WriterInputsRecording {
  schema_version: 1;
  /** Gravações anteriores, da mais antiga à mais recente — nunca reescritas (#9648). */
  history?: WriterInputsRecording[];
}

function relToEdition(editionDir: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(p);
  const rel = relative(editionDir, abs);
  // Fora do diretório da edição: guarda o path como veio (não inventa relativo com "..").
  return rel.startsWith("..") || isAbsolute(rel) ? p : rel.split("\\").join("/");
}

export function classifySourceText(bytes: number | null, minBytes = MIN_SOURCE_TEXT_BYTES): WriterInputStatus {
  if (bytes === null) return "missing";
  return bytes < minBytes ? "short" : "ok";
}

/**
 * Monta o registro a partir das entradas que o Stage 2 passou aos writers e
 * congela uma cópia de cada texto em `_internal/02-writer-inputs/d{N}.txt`.
 * Texto listado mas ilegível em disco conta como `missing` (o writer também
 * não teria conseguido ler).
 */
export function buildWriterInputsRecord(
  editionDir: string,
  sources: WriterSourceInput[],
  opts: { approvedPath?: string; now?: Date; minBytes?: number; highlightCount?: number } = {},
): WriterInputsRecord {
  const minBytes = opts.minBytes ?? MIN_SOURCE_TEXT_BYTES;
  const snapDir = join(editionDir, "_internal", WRITER_INPUTS_SNAPSHOT_DIR);
  // Sem rmSync (#9648): cópias de gravações anteriores ficam — o nome é por conteúdo.
  const destaques: WriterInputEntry[] = [...sources]
    .sort((a, b) => a.destaque - b.destaque)
    .map((s) => {
      let text: Buffer | null = null;
      let error = s.error ?? null;
      if (s.path) {
        try {
          text = readFileSync(s.path);
        } catch (e) {
          error = `texto-fonte ilegível em ${s.path}: ${(e as Error).message}`;
        }
      } else if (!error) {
        error = "sem source_text_path";
      }
      let snapshot_path: string | null = null;
      const sha256 = text ? createHash("sha256").update(text).digest("hex") : null;
      if (text && sha256) {
        mkdirSync(snapDir, { recursive: true });
        const snap = join(snapDir, snapshotFileName(s.destaque, sha256));
        // Mesmo nome = mesmo conteúdo: nunca reescreve uma cópia existente.
        if (!existsSync(snap)) writeFileSync(snap, text);
        snapshot_path = relToEdition(editionDir, snap);
      }
      const bytes = text ? text.length : null;
      return {
        destaque: s.destaque,
        url: s.url,
        source_text_path: text && s.path ? relToEdition(editionDir, s.path) : null,
        snapshot_path,
        bytes,
        sha256,
        status: classifySourceText(bytes, minBytes),
        error: text ? null : error,
      };
    });
  return {
    schema_version: 1,
    recorded_at: (opts.now ?? new Date()).toISOString(),
    approved_path: opts.approvedPath ? relToEdition(editionDir, opts.approvedPath) : null,
    min_source_text_bytes: minBytes,
    ...(typeof opts.highlightCount === "number" ? { highlight_count: opts.highlightCount } : {}),
    destaques,
  };
}

/** Nome da cópia congelada: endereçado por conteúdo, nunca colide entre gravações. */
export function snapshotFileName(destaque: number, sha256: string): string {
  return `d${destaque}-${sha256.slice(0, 12)}.txt`;
}

export function writerInputsPath(editionDir: string): string {
  return join(editionDir, "_internal", WRITER_INPUTS_FILE);
}

function sameInputs(a: WriterInputEntry[], b: WriterInputEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.destaque === y.destaque && x.url === y.url && x.sha256 === y.sha256 && x.status === y.status;
  });
}

function asRecording(r: WriterInputsRecord): WriterInputsRecording {
  const { schema_version: _v, history: _h, ...rest } = r;
  return rest;
}

/**
 * Grava o registro SEM apagar o anterior (#9648): se já existe um registro
 * com os mesmos insumos (URL+sha256+status por destaque), é no-op e o
 * original fica intocado; se difere, o anterior vai pra `history[]` (junto
 * com o histórico que ele já carregava). Registro anterior ilegível é
 * preservado ao lado (`02-writer-inputs.corrupt-{ts}.json`), nunca
 * sobrescrito.
 */
export function writeWriterInputsRecord(editionDir: string, record: WriterInputsRecord): string {
  const p = writerInputsPath(editionDir);
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  const prev = readWriterInputsRecord(editionDir);
  const history = [...(record.history ?? [])];
  if (prev.kind === "ok") {
    if (sameInputs(prev.record.destaques, record.destaques)) return p;
    history.unshift(...(prev.record.history ?? []), asRecording(prev.record));
  } else if (prev.kind === "corrupt") {
    renameSync(p, p.replace(/\.json$/, `.corrupt-${record.recorded_at.replace(/[:.]/g, "-")}.json`));
  }
  const { history: _h, ...rest } = record;
  const toWrite: WriterInputsRecord = history.length > 0 ? { ...rest, history } : rest;
  writeFileSync(p, JSON.stringify(toWrite, null, 2) + "\n", "utf8");
  return p;
}

export type ReadWriterInputs =
  | { kind: "absent" }
  | { kind: "corrupt"; error: string }
  | { kind: "ok"; record: WriterInputsRecord };

export function readWriterInputsRecord(editionDir: string): ReadWriterInputs {
  const p = writerInputsPath(editionDir);
  if (!existsSync(p)) return { kind: "absent" };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<WriterInputsRecord>;
    if (!raw || !Array.isArray(raw.destaques)) return { kind: "corrupt", error: "campo destaques ausente" };
    return { kind: "ok", record: raw as WriterInputsRecord };
  } catch (e) {
    return { kind: "corrupt", error: (e as Error).message };
  }
}

export interface WriterInputGap {
  destaque: number;
  url: string;
  /** `unrecorded` = destaque do approved (1..highlight_count) sem entrada no registro. */
  status: Exclude<WriterInputStatus, "ok"> | "unrecorded";
  bytes: number | null;
  error: string | null;
}

/**
 * Destaques escritos no Stage 2 sem texto-fonte (`missing`), com texto
 * truncado (`short`) ou sem entrada no registro (`unrecorded` — só quando o
 * registro traz `highlight_count`).
 */
export function findWriterInputGaps(record: WriterInputsRecord): WriterInputGap[] {
  const minBytes = record.min_source_text_bytes ?? MIN_SOURCE_TEXT_BYTES;
  const gaps: WriterInputGap[] = record.destaques.flatMap((d) => {
    // Reclassifica pelo `bytes` (não confia só no `status` gravado): registro
    // escrito com outro limiar continua sendo julgado pelo limiar dele.
    const status = classifySourceText(typeof d.bytes === "number" ? d.bytes : null, minBytes);
    return status === "ok" ? [] : [{ destaque: d.destaque, url: d.url, status, bytes: d.bytes ?? null, error: d.error ?? null }];
  });
  if (typeof record.highlight_count === "number") {
    const seen = new Set(record.destaques.map((d) => d.destaque));
    for (let n = 1; n <= record.highlight_count; n++) {
      if (!seen.has(n)) gaps.push({ destaque: n, url: "", status: "unrecorded", bytes: null, error: "destaque sem entrada no registro" });
    }
  }
  return gaps.sort((a, b) => a.destaque - b.destaque);
}

export interface WriterInputSnapshotIssue {
  destaque: number;
  snapshot_path: string | null;
  problem: "snapshot-ausente" | "hash-divergente";
}

/**
 * (#9648) Confere que a cópia congelada de cada texto registrado ainda existe
 * e bate com o `sha256` gravado. Sem isso o registro guarda o hash mas não
 * deixa reler o texto, e a medição do item 3 (o fato estava no texto
 * recebido?) fica sem base. Entradas sem texto (`sha256: null`) são ignoradas.
 */
export function checkWriterInputSnapshots(editionDir: string, record: WriterInputsRecord): WriterInputSnapshotIssue[] {
  const issues: WriterInputSnapshotIssue[] = [];
  for (const d of record.destaques) {
    if (!d.sha256) continue;
    const snap = d.snapshot_path ? (isAbsolute(d.snapshot_path) ? d.snapshot_path : join(editionDir, d.snapshot_path)) : null;
    let sha: string | null = null;
    try {
      if (snap && existsSync(snap)) sha = createHash("sha256").update(readFileSync(snap)).digest("hex");
    } catch {
      sha = null;
    }
    if (sha === null) issues.push({ destaque: d.destaque, snapshot_path: d.snapshot_path ?? null, problem: "snapshot-ausente" });
    else if (sha !== d.sha256) issues.push({ destaque: d.destaque, snapshot_path: d.snapshot_path, problem: "hash-divergente" });
  }
  return issues;
}
