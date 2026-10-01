/**
 * session-handoff.ts (#9374) — handoff estruturado da 1ª sessão da edição.
 *
 * Desde o #6171 cada edição roda em 2 sessões: `/diaria-edicao` (Etapas
 * 1–4) e `/diaria-5-publicacao` numa sessão NOVA (Etapas 5–6). O mapeamento
 * de bugs (`collect-edition-signals.ts` → `auto-reporter`) só roda no Stage
 * 6, na 2ª sessão, que só enxerga o que está em disco. Halts, MCP caindo,
 * retries e reclamações do editor no gate do Stage 4 ficavam só no contexto
 * da 1ª sessão e sumiam com ela (medido 260901→261001: 16 warn/error do
 * orchestrator no run-log, todos do Stage 0; sinais por edição caindo de
 * 8 para 0 sem dar pra separar "menos problema" de "menos registro").
 *
 * Este módulo é o arquivo de handoff: `_internal/session-1-handoff.json`,
 * escrito pela 1ª sessão (`scripts/session-handoff.ts add`/`close`) e lido
 * pelo `collect-edition-signals.ts` (signal `session1_handoff`) e pelo resumo
 * final do Stage 6.
 *
 * `closed_at` distingue "a 1ª sessão fechou o handoff sem nada a registrar"
 * (entries vazio + closed_at) de "ninguém registrou nada" (arquivo ausente) —
 * exatamente a ambiguidade que a issue não conseguia resolver com o dado
 * antigo.
 *
 * Remediação não prevista no playbook NÃO entra aqui: continua indo para
 * `_internal/runtime-fixes.jsonl` via `log-runtime-fix.ts` (#1210), que o
 * coletor já lê — duplicar viraria 2 sinais pro mesmo fato.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Caminho do handoff, relativo ao diretório da edição. */
export const SESSION1_HANDOFF_FILE = "_internal/session-1-handoff.json";

export const HANDOFF_KINDS = ["halt", "mcp_drop", "retry", "editor_complaint", "problem"] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

export const HANDOFF_SEVERITIES = ["low", "medium", "high"] as const;
export type HandoffSeverity = (typeof HANDOFF_SEVERITIES)[number];

export interface HandoffEntry {
  kind: HandoffKind;
  /** Etapa em que o fato aconteceu (0–4: a 1ª sessão cobre Stage 0 até o gate 4). */
  stage: number;
  summary: string;
  severity: HandoffSeverity;
  /** Agent/script/MCP envolvido (ex: `mcp__claude_ai_Gmail`, `writer-destaque`). */
  component?: string;
  recorded_at: string;
}

export interface SessionHandoff {
  edition: string;
  entries: HandoffEntry[];
  /** Carimbado por `close`: a 1ª sessão confirmou o handoff (mesmo vazio). */
  closed_at?: string;
}

/** Severidade padrão por tipo — halt/MCP/reclamação viram P2, retry vira P3. */
export function defaultSeverity(kind: HandoffKind): HandoffSeverity {
  return kind === "retry" ? "low" : "medium";
}

export function isHandoffKind(v: unknown): v is HandoffKind {
  return typeof v === "string" && (HANDOFF_KINDS as readonly string[]).includes(v);
}

export function isHandoffSeverity(v: unknown): v is HandoffSeverity {
  return typeof v === "string" && (HANDOFF_SEVERITIES as readonly string[]).includes(v);
}

export type ParseResult = { ok: true; value: SessionHandoff; invalidEntries: number } | { ok: false; error: string };

/**
 * Valida o documento. Entrada inválida dentro de um doc válido é descartada
 * e contada (`invalidEntries`), nunca derruba o resto. Pura.
 */
export function parseHandoff(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "documento não é objeto" };
  const doc = raw as Record<string, unknown>;
  if (typeof doc.edition !== "string") return { ok: false, error: "campo `edition` ausente" };
  if (!Array.isArray(doc.entries)) return { ok: false, error: "campo `entries` não é array" };
  const entries: HandoffEntry[] = [];
  let invalidEntries = 0;
  for (const e of doc.entries) {
    if (
      typeof e === "object" &&
      e !== null &&
      isHandoffKind((e as HandoffEntry).kind) &&
      typeof (e as HandoffEntry).stage === "number" &&
      typeof (e as HandoffEntry).summary === "string" &&
      (e as HandoffEntry).summary.trim() !== "" &&
      isHandoffSeverity((e as HandoffEntry).severity) &&
      typeof (e as HandoffEntry).recorded_at === "string"
    ) {
      const x = e as HandoffEntry;
      entries.push({
        kind: x.kind,
        stage: x.stage,
        summary: x.summary,
        severity: x.severity,
        ...(typeof x.component === "string" && x.component ? { component: x.component } : {}),
        recorded_at: x.recorded_at,
      });
    } else {
      invalidEntries++;
    }
  }
  return {
    ok: true,
    value: { edition: doc.edition, entries, ...(typeof doc.closed_at === "string" ? { closed_at: doc.closed_at } : {}) },
    invalidEntries,
  };
}

export type HandoffRead =
  | { state: "absent" }
  | { state: "corrupt"; error: string }
  | { state: "ok"; value: SessionHandoff; invalidEntries: number };

export function readHandoff(editionDir: string): HandoffRead {
  const p = resolve(editionDir, SESSION1_HANDOFF_FILE);
  if (!existsSync(p)) return { state: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    return { state: "corrupt", error: e instanceof Error ? e.message : String(e) };
  }
  const r = parseHandoff(parsed);
  return r.ok ? { state: "ok", value: r.value, invalidEntries: r.invalidEntries } : { state: "corrupt", error: r.error };
}

/**
 * Base pra uma escrita: doc existente, ou doc novo. Doc corrompido NUNCA é
 * sobrescrito em silêncio (perderia o que a sessão já registrou) — lança.
 */
function baseForWrite(editionDir: string, edition: string): SessionHandoff {
  const cur = readHandoff(editionDir);
  if (cur.state === "corrupt") {
    throw new Error(`${SESSION1_HANDOFF_FILE} ilegível (${cur.error}) — corrija ou remova o arquivo antes de registrar`);
  }
  return cur.state === "ok" ? cur.value : { edition, entries: [] };
}

function writeAtomic(editionDir: string, doc: SessionHandoff): string {
  const p = resolve(editionDir, SESSION1_HANDOFF_FILE);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
  return p;
}

export function appendHandoffEntry(
  editionDir: string,
  edition: string,
  entry: Omit<HandoffEntry, "recorded_at" | "severity"> & { severity?: HandoffSeverity },
  now: Date = new Date(),
): SessionHandoff {
  if (!isHandoffKind(entry.kind)) throw new Error(`kind inválido: ${String(entry.kind)} (válidos: ${HANDOFF_KINDS.join(", ")})`);
  if (!Number.isInteger(entry.stage) || entry.stage < 0 || entry.stage > 4) {
    throw new Error(`stage inválido: ${entry.stage} (a 1ª sessão cobre as Etapas 0–4)`);
  }
  if (!entry.summary.trim()) throw new Error("summary vazio");
  const doc = baseForWrite(editionDir, edition);
  doc.entries.push({
    kind: entry.kind,
    stage: entry.stage,
    summary: entry.summary.trim(),
    severity: entry.severity ?? defaultSeverity(entry.kind),
    ...(entry.component ? { component: entry.component } : {}),
    recorded_at: now.toISOString(),
  });
  writeAtomic(editionDir, doc);
  return doc;
}

/** Carimba `closed_at` (idempotente: reexecução atualiza o carimbo). */
export function closeHandoff(editionDir: string, edition: string, now: Date = new Date()): SessionHandoff {
  const doc = baseForWrite(editionDir, edition);
  doc.closed_at = now.toISOString();
  writeAtomic(editionDir, doc);
  return doc;
}

/**
 * Fechamento MECÂNICO (#9374): chamado pelo `pipeline-sentinel.ts write
 * --step 4`. Idempotente — se o handoff já está fechado, não mexe (preserva o
 * `closed_at` original); se não existe, cria vazio+fechado. Lança em arquivo
 * corrompido (nunca sobrescreve o que a sessão registrou).
 */
export function ensureHandoffClosed(editionDir: string, edition: string, now: Date = new Date()): "closed" | "already-closed" {
  const cur = readHandoff(editionDir);
  if (cur.state === "ok" && cur.value.closed_at) return "already-closed";
  closeHandoff(editionDir, edition, now);
  return "closed";
}

/**
 * Linha de 1 frase pro resumo final do Stage 6. Pura.
 * Distingue "ausente" (1ª sessão não registrou) de "fechado sem ocorrências".
 */
export function summarizeHandoffForStage6(read: HandoffRead): string {
  if (read.state === "absent") return "Handoff da 1ª sessão: ausente — Etapas 1–4 sem registro de problemas (não dá pra afirmar que não houve).";
  if (read.state === "corrupt") return `Handoff da 1ª sessão: ilegível (${read.error}).`;
  const n = read.value.entries.length;
  const open = read.value.closed_at ? "" : " (não fechado pela 1ª sessão)";
  if (n === 0) return `Handoff da 1ª sessão: nenhuma ocorrência nas Etapas 1–4${open}.`;
  const byKind = new Map<string, number>();
  for (const e of read.value.entries) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  const parts = [...byKind.entries()].map(([k, c]) => `${c} ${k}`).join(", ");
  return `Handoff da 1ª sessão: ${n} ocorrência(s) nas Etapas 1–4 (${parts})${open} — viraram sinal pro auto-reporter.`;
}
