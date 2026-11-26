/**
 * scripts/lib/sessions/merge-grant-ledger.ts (#14004)
 *
 * Ledger de consumo do grant (`.merge-grant-consumed-*`), que registra o uso
 * único fora do arquivo da sessão.
 *
 * Parte de `scripts/lib/session-registry.ts`, dividido em módulos no #14004 sem
 * mudar comportamento. Fora de `scripts/lib/sessions/`, importe sempre de
 * `session-registry.ts`, que reexporta a API pública inteira e segue sendo a
 * entrada do CLI. O docstring de topo de `session-registry.ts` continua sendo o
 * mapa do registro.
 */

import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { MergeGrant } from "./types.ts";
import { probeSessionsDirWithWarning, readJsonSafe, sessionsDir, writeJsonSafe } from "./store.ts";

// ─── #11113: registro de consumo da BENEFICIÁRIA ─────────────────────────────
//
// Espelho de `.claude/hooks/lib/merge-grant-ledger.mjs` (mesmo prefixo, mesmo
// formato, mesma chave) — o docblock completo está lá. Resumo: consumir uma
// concessão emitida por coordenadora de OUTRA máquina nunca escreve no arquivo
// dela (o write concorria via OneDrive com o heartbeat/`grant-merge` da
// coordenadora, gerava cópia de conflito a cada merge e congelava a cópia
// local — a 3ª concessão seguida nunca chegava). O consumo vai para
// `data/sessions/.merge-grant-consumed-{beneficiária}.json`, que só a
// beneficiária escreve, e todo leitor trata a concessão como consumida se a
// identidade dela consta ali. Consumo só fecha janela, nunca abre.

export const MERGE_GRANT_LEDGER_PREFIX = ".merge-grant-consumed-";
export const MERGE_GRANT_LEDGER_RETENTION_MS = 24 * 60 * 60 * 1000;

interface MergeGrantLedgerEntry {
  grantedBy: string;
  grantedTo: string;
  grantedAt: string;
  consumedAt: string;
  pr?: number;
  repo?: string;
}

export function mergeGrantIdentityKey(grant: Partial<MergeGrant> | null | undefined): string | null {
  if (!grant || typeof grant !== "object") return null;
  const { grantedBy, grantedTo, grantedAt } = grant;
  if (typeof grantedBy !== "string" || typeof grantedTo !== "string" || typeof grantedAt !== "string") return null;
  return `${grantedBy}\u0000${grantedTo}\u0000${grantedAt}`;
}

export function mergeGrantLedgerPath(repoRoot: string, granteeSessionId: string): string {
  const safe = String(granteeSessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(sessionsDir(repoRoot), `${MERGE_GRANT_LEDGER_PREFIX}${safe}.json`);
}

/** `Map<chave de identidade, consumedAt mais antigo>` de todos os registros. Fail-soft. */
export function readMergeGrantConsumptions(repoRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = sessionsDir(repoRoot);
  let names: string[];
  try {
    if (!existsSync(dir)) {
      probeSessionsDirWithWarning(repoRoot); // #12547: avisa junction pendente
      return out;
    }
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.startsWith(MERGE_GRANT_LEDGER_PREFIX) || !name.endsWith(".json")) continue;
    const doc = readJsonSafe<{ entries?: unknown }>(join(dir, name));
    const entries = Array.isArray(doc?.entries) ? (doc.entries as Partial<MergeGrantLedgerEntry>[]) : [];
    for (const entry of entries) {
      const key = mergeGrantIdentityKey(entry);
      if (!key || typeof entry.consumedAt !== "string" || !Number.isFinite(Date.parse(entry.consumedAt))) continue;
      const prev = out.get(key);
      if (!prev || Date.parse(entry.consumedAt) < Date.parse(prev)) out.set(key, entry.consumedAt);
    }
  }
  return out;
}

/** Devolve `grant` com `consumedAt` do registro quando ele não tem um. Pura. */
export function withLedgerConsumption(
  grant: MergeGrant | undefined,
  ledger: Map<string, string>,
): MergeGrant | undefined {
  if (!grant || grant.consumedAt) return grant;
  const key = mergeGrantIdentityKey(grant);
  const consumedAt = key ? ledger.get(key) : undefined;
  return consumedAt ? { ...grant, consumedAt } : grant;
}

/**
 * Grava o consumo de `grant` no registro da beneficiária (`grant.grantedTo`).
 * Um só escritor por arquivo, então leitura + poda + escrita atômica basta.
 * Devolve `true` quando a releitura confirma a entrada. Nunca lança.
 */
export function recordMergeGrantConsumption(
  repoRoot: string,
  grant: MergeGrant,
  consumedAt: string,
  now: number = Date.now(),
): boolean {
  try {
    const key = mergeGrantIdentityKey(grant);
    if (!key) return false;
    const path = mergeGrantLedgerPath(repoRoot, grant.grantedTo);
    const doc = readJsonSafe<{ entries?: unknown }>(path);
    const kept = (Array.isArray(doc?.entries) ? (doc.entries as Partial<MergeGrantLedgerEntry>[]) : []).filter((e) => {
      const k = mergeGrantIdentityKey(e);
      if (!k || k === key) return false;
      const grantedMs = Date.parse(e.grantedAt ?? "");
      return Number.isFinite(grantedMs) && now - grantedMs <= MERGE_GRANT_LEDGER_RETENTION_MS;
    });
    const entry: MergeGrantLedgerEntry = {
      grantedBy: grant.grantedBy,
      grantedTo: grant.grantedTo,
      grantedAt: grant.grantedAt,
      consumedAt,
    };
    if (grant.pr !== undefined) entry.pr = grant.pr;
    if (grant.repo !== undefined) entry.repo = grant.repo;
    writeJsonSafe(path, { grantee: grant.grantedTo, entries: [...kept, entry] });
    const onDisk = readJsonSafe<{ entries?: Partial<MergeGrantLedgerEntry>[] }>(path);
    return (onDisk?.entries ?? []).some((e) => mergeGrantIdentityKey(e) === key && e.consumedAt === consumedAt);
  } catch {
    return false;
  }
}
