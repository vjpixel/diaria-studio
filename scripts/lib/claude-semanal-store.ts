/**
 * scripts/lib/claude-semanal-store.ts (#14329)
 *
 * I/O local do e-mail semanal "Claude na semana": caminhos por semana em
 * `data/claude-semanal/{AAMMDD}/` e leitura dos registros de envio que
 * alimentam o dedup entre semanas (`sentUrlsFromRecords`, puro, em
 * `claude-semanal.ts`). Não fala com rede.
 *
 * O registro de envio de cada semana (`_internal/claude-semanal-published.json`)
 * é a fonte ÚNICA do dedup: ele já é gravado no envio com os itens, então não
 * existe um 2º arquivo de "itens enviados" que pudesse divergir dele.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ClaudeSemanalGuardError,
  CLAUDE_SEMANAL_CONFIG_KEY,
  resolveClaudeSemanalConfig,
  sentUrlsFromRecords,
  type ClaudeSemanalConfig,
  type KitClaudeSemanalRawConfig,
} from "./claude-semanal.ts";

export const CLAUDE_SEMANAL_DIR = "claude-semanal";
export const CLAUDE_SEMANAL_PUBLISHED_FILE = "claude-semanal-published.json";

export interface ClaudeSemanalPaths {
  weekDir: string;
  internalDir: string;
  candidatesPath: string;
  draftPath: string;
  previewHtmlPath: string;
  previewTextPath: string;
  publishedPath: string;
  lockPath: string;
}

/** `dataRoot` é a raiz do repo (que contém `data/`), como nos outros canais. */
export function claudeSemanalPaths(dataRoot: string, week: string): ClaudeSemanalPaths {
  const weekDir = join(dataRoot, "data", CLAUDE_SEMANAL_DIR, week);
  const internalDir = join(weekDir, "_internal");
  return {
    weekDir,
    internalDir,
    candidatesPath: join(internalDir, "01-candidates.json"),
    draftPath: join(internalDir, "02-draft.json"),
    previewHtmlPath: join(internalDir, "claude-semanal-preview.html"),
    previewTextPath: join(internalDir, "claude-semanal-preview.txt"),
    publishedPath: join(internalDir, CLAUDE_SEMANAL_PUBLISHED_FILE),
    lockPath: join(internalDir, "claude-semanal.lock"),
  };
}

/**
 * Lê os registros de envio de TODAS as semanas. Arquivo ilegível entra como
 * `raw: null` (o puro o lista em `unreadable`), nunca derruba a leitura.
 */
export function readClaudeSemanalRecords(dataRoot: string): { week: string; raw: unknown }[] {
  const base = join(dataRoot, "data", CLAUDE_SEMANAL_DIR);
  if (!existsSync(base)) return [];
  const out: { week: string; raw: unknown }[] = [];
  for (const week of readdirSync(base)) {
    if (!/^\d{6}$/.test(week)) continue;
    const p = join(base, week, "_internal", CLAUDE_SEMANAL_PUBLISHED_FILE);
    if (!existsSync(p)) continue;
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      raw = null;
    }
    out.push({ week, raw });
  }
  return out;
}

/** URLs já enviadas em outras semanas (normalizadas → semana) + semanas com registro ilegível. */
export function loadClaudeSemanalSent(dataRoot: string, currentWeek: string) {
  return sentUrlsFromRecords(readClaudeSemanalRecords(dataRoot), currentWeek);
}

/** Aviso único das semanas que o dedup não considera (ilegíveis, `pending`, `cancel-failed`). */
export function logClaudeSemanalDedupGaps(
  r: { unreadable: readonly string[]; skipped: readonly string[] },
  log: (msg: string) => void,
): void {
  const parts: string[] = [];
  if (r.unreadable.length > 0) parts.push(`registro ilegível em ${r.unreadable.join(", ")}`);
  if (r.skipped.length > 0) parts.push(`semana sem envio confirmado em ${r.skipped.join(", ")}`);
  if (parts.length > 0) {
    log(`AVISO: o dedup não considera os itens destas semanas (${parts.join("; ")}). Confira o Kit e o registro antes de confiar no dedup.`);
  }
}

/** Lê e valida `platform.config.json` → `kit_claude_semanal`. Lança `ClaudeSemanalGuardError`. */
export function loadClaudeSemanalConfig(rootDir: string): {
  config: ClaudeSemanalConfig;
  raw: KitClaudeSemanalRawConfig;
} {
  const path = resolve(rootDir, "platform.config.json");
  if (!existsSync(path)) throw new ClaudeSemanalGuardError(`${path} ausente.`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new ClaudeSemanalGuardError(`${path} não é JSON válido: ${(e as Error).message}`);
  }
  const raw = parsed[CLAUDE_SEMANAL_CONFIG_KEY] as KitClaudeSemanalRawConfig | undefined;
  const r = resolveClaudeSemanalConfig(raw);
  if (!r.ok) throw new ClaudeSemanalGuardError(r.reason);
  return { config: r.config, raw: raw as KitClaudeSemanalRawConfig };
}
