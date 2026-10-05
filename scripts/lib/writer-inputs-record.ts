/**
 * writer-inputs-record.ts (#9648)
 *
 * Registro auditável do texto-fonte que cada `writer-destaque` recebeu no
 * Stage 2 — `_internal/02-writer-inputs.json` + cópia do texto em
 * `_internal/02-writer-inputs/d{N}.txt`.
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
 * este arquivo. Re-rodar o Stage 2 (resume) regrava, o que é correto: os
 * writers são re-despachados com o texto novo.
 *
 * Quem lê: `collect-edition-signals.ts` (`writer_source_text_gap`, warning
 * pro auto-reporter, nunca bloqueante) e a medição do item 3 da #9648.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

export interface WriterInputsRecord {
  schema_version: 1;
  recorded_at: string;
  /** Approved de onde vieram as URLs (relativo ao diretório da edição). */
  approved_path: string | null;
  min_source_text_bytes: number;
  destaques: WriterInputEntry[];
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
  opts: { approvedPath?: string; now?: Date; minBytes?: number } = {},
): WriterInputsRecord {
  const minBytes = opts.minBytes ?? MIN_SOURCE_TEXT_BYTES;
  const snapDir = join(editionDir, "_internal", WRITER_INPUTS_SNAPSHOT_DIR);
  rmSync(snapDir, { recursive: true, force: true });
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
      if (text) {
        mkdirSync(snapDir, { recursive: true });
        const snap = join(snapDir, `d${s.destaque}.txt`);
        writeFileSync(snap, text);
        snapshot_path = relToEdition(editionDir, snap);
      }
      const bytes = text ? text.length : null;
      return {
        destaque: s.destaque,
        url: s.url,
        source_text_path: text && s.path ? relToEdition(editionDir, s.path) : null,
        snapshot_path,
        bytes,
        sha256: text ? createHash("sha256").update(text).digest("hex") : null,
        status: classifySourceText(bytes, minBytes),
        error: text ? null : error,
      };
    });
  return {
    schema_version: 1,
    recorded_at: (opts.now ?? new Date()).toISOString(),
    approved_path: opts.approvedPath ? relToEdition(editionDir, opts.approvedPath) : null,
    min_source_text_bytes: minBytes,
    destaques,
  };
}

export function writerInputsPath(editionDir: string): string {
  return join(editionDir, "_internal", WRITER_INPUTS_FILE);
}

export function writeWriterInputsRecord(editionDir: string, record: WriterInputsRecord): string {
  const p = writerInputsPath(editionDir);
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  writeFileSync(p, JSON.stringify(record, null, 2) + "\n", "utf8");
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
  status: Exclude<WriterInputStatus, "ok">;
  bytes: number | null;
  error: string | null;
}

/** Destaques escritos no Stage 2 sem texto-fonte (`missing`) ou com texto truncado (`short`). */
export function findWriterInputGaps(record: WriterInputsRecord): WriterInputGap[] {
  const minBytes = record.min_source_text_bytes ?? MIN_SOURCE_TEXT_BYTES;
  return record.destaques.flatMap((d) => {
    // Reclassifica pelo `bytes` (não confia só no `status` gravado): registro
    // escrito com outro limiar continua sendo julgado pelo limiar dele.
    const status = classifySourceText(typeof d.bytes === "number" ? d.bytes : null, minBytes);
    return status === "ok" ? [] : [{ destaque: d.destaque, url: d.url, status, bytes: d.bytes ?? null, error: d.error ?? null }];
  });
}
