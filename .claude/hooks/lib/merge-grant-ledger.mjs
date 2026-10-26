// .claude/hooks/lib/merge-grant-ledger.mjs (#11113)
//
// Registro de CONSUMO de concessão de merge mantido pela BENEFICIÁRIA, num
// arquivo que só ela escreve: `data/sessions/.merge-grant-consumed-{sessão}.json`.
//
// Por que existe: até o #11113 o consumo (`consumedAt`) era gravado no
// arquivo da COORDENADORA — que pertence a outra máquina quando a concessão
// cruza máquinas (overnight no Zenbook, sessão interativa no Neo). Com
// `data/sessions/` sincronizado pelo OneDrive, esse write concorria com o
// heartbeat/`grant-merge` da coordenadora, gerava uma cópia de conflito
// (`…-Neo.json`, `…-Neo-2.json`) a cada merge, e a versão local do arquivo
// deixava de receber as concessões seguintes (medido em 25/10/2026: a
// concessão da 3ª PR nunca chegou ao Neo).
//
// Regra: quem consome uma concessão de OUTRA máquina nunca escreve no
// arquivo da coordenadora — grava o consumo aqui. Todos os leitores (guard,
// hook de consumo, `session-registry.ts`) tratam uma concessão como
// consumida se `merge_grant.consumedAt` existe OU se a identidade dela
// (grantedBy, grantedTo, grantedAt) consta em qualquer um destes arquivos.
// Consumo só fecha janela, nunca abre — um arquivo destes, mesmo
// forjado ou cópia de conflito, nunca autoriza merge.
//
// Espelhado em `scripts/lib/session-registry.ts` (mesmo prefixo, mesmo
// formato, mesma chave) — paridade travada por
// `test/merge-grant-consumption-ledger-11113.test.ts`.
//
// O nome começa com `.` de propósito: todas as varreduras de registro de
// sessão (`listSessionJsonFiles`, os hooks) já pulam dotfiles, como pulam o
// `.merge-lock.json`. Nenhuma delas confunde este arquivo com uma sessão.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MERGE_GRANT_LEDGER_PREFIX = ".merge-grant-consumed-";

/** Entradas mais velhas que isto (pelo `grantedAt`) são podadas na escrita. */
export const MERGE_GRANT_LEDGER_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Chave de identidade de uma concessão — a mesma tripla do #6952. */
export function mergeGrantIdentityKey(grant) {
  if (!grant || typeof grant !== "object") return null;
  const { grantedBy, grantedTo, grantedAt } = grant;
  if (typeof grantedBy !== "string" || typeof grantedTo !== "string" || typeof grantedAt !== "string") return null;
  return `${grantedBy}\u0000${grantedTo}\u0000${grantedAt}`;
}

export function mergeGrantLedgerPath(repoRoot, granteeSessionId) {
  const safe = String(granteeSessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(repoRoot, "data", "sessions", `${MERGE_GRANT_LEDGER_PREFIX}${safe}.json`);
}

/**
 * Lê TODOS os registros de consumo de `data/sessions/` (inclusive cópias de
 * conflito deles) e devolve `Map<chave, consumedAt mais antigo>`. Fail-soft:
 * diretório ausente, arquivo ilegível ou entrada malformada são ignorados.
 */
export function readMergeGrantConsumptions(repoRoot) {
  const out = new Map();
  const dir = join(repoRoot, "data", "sessions");
  let names;
  try {
    if (!existsSync(dir)) return out;
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.startsWith(MERGE_GRANT_LEDGER_PREFIX) || !name.endsWith(".json")) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const entries = Array.isArray(doc?.entries) ? doc.entries : [];
    for (const entry of entries) {
      const key = mergeGrantIdentityKey(entry);
      if (!key || typeof entry.consumedAt !== "string" || !Number.isFinite(Date.parse(entry.consumedAt))) continue;
      const prev = out.get(key);
      if (!prev || Date.parse(entry.consumedAt) < Date.parse(prev)) out.set(key, entry.consumedAt);
    }
  }
  return out;
}

/** `consumedAt` da concessão segundo o registro, ou `undefined`. */
export function ledgerConsumedAt(ledger, grant) {
  const key = mergeGrantIdentityKey(grant);
  return key ? ledger.get(key) : undefined;
}

/**
 * Grava o consumo de `grant` no registro da BENEFICIÁRIA (`grant.grantedTo`).
 * Leitura + poda + escrita atômica (write-then-rename). Um só escritor por
 * arquivo (a própria beneficiária, na própria máquina), então não há lock.
 * Devolve `true` se a releitura confirma a entrada. Nunca lança.
 */
export function recordMergeGrantConsumption(repoRoot, grant, consumedAt, now = Date.now()) {
  try {
    const key = mergeGrantIdentityKey(grant);
    if (!key) return false;
    const path = mergeGrantLedgerPath(repoRoot, grant.grantedTo);
    let doc = null;
    try {
      if (existsSync(path)) doc = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      doc = null; // corrompido: recomeça — o arquivo só guarda fatos de fechamento
    }
    const kept = (Array.isArray(doc?.entries) ? doc.entries : []).filter((e) => {
      const k = mergeGrantIdentityKey(e);
      if (!k || k === key) return false;
      const grantedMs = Date.parse(e.grantedAt);
      return Number.isFinite(grantedMs) && now - grantedMs <= MERGE_GRANT_LEDGER_RETENTION_MS;
    });
    const entry = { grantedBy: grant.grantedBy, grantedTo: grant.grantedTo, grantedAt: grant.grantedAt, consumedAt };
    if (grant.pr !== undefined) entry.pr = grant.pr;
    if (grant.repo !== undefined) entry.repo = grant.repo;
    const next = { grantee: grant.grantedTo, entries: [...kept, entry] };
    mkdirSync(join(repoRoot, "data", "sessions"), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next), "utf8");
    renameSync(tmp, path);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    return (onDisk?.entries ?? []).some((e) => mergeGrantIdentityKey(e) === key && e.consumedAt === consumedAt);
  } catch {
    return false;
  }
}

/**
 * O arquivo de sessão `fileName` pertence a esta máquina? Decide pelo NOME
 * (`{kind}-{tag}-{sessionId}[-safeBackup-…].json`), que é o arquivo que de
 * fato seria escrito. `localTag` é o `machineTag()` de quem chama.
 */
export function sessionFileIsLocal(fileName, kind, localTag) {
  if (typeof fileName !== "string" || typeof kind !== "string" || typeof localTag !== "string") return false;
  return fileName.startsWith(`${kind}-${localTag}-`);
}
