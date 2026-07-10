#!/usr/bin/env tsx
/**
 * migrate-nickname-index.ts (#3117)
 *
 * Migration one-shot: popula o índice `nickname:{normalizado}` → email a
 * partir do estado atual das chaves `score:{email}` existentes no KV do
 * Worker `poll`.
 *
 * Contexto: `/set-name` fazia dedup de apelido escaneando TODAS as chaves
 * `score:*` (1 list + N gets sequenciais, N = nº de votantes distintos
 * all-time, já ~60+ e crescendo monotonicamente) — O(N) a cada tentativa de
 * salvar apelido, na zona de estouro do teto de 50 subrequests/request do
 * Workers free plan. `workers/poll/src/index.ts` (`handleSetName`) foi
 * reescrito pra checar unicidade via 1 `get` no índice `nickname:{normalizado}`
 * em vez do scan.
 *
 * *** IMPORTANTE — RODAR MANUALMENTE ANTES DO DEPLOY ***
 * Sem rodar este script ANTES do deploy do worker atualizado, o índice fica
 * vazio e o dedup de apelidos pré-existentes quebra SILENCIOSAMENTE: dois
 * leitores diferentes poderiam reivindicar o mesmo apelido já em uso (o
 * `get` no índice vazio nunca encontra o dono anterior, então nunca rejeita).
 * Precisa de credenciais Cloudflare (`CLOUDFLARE_API_TOKEN` com escopo
 * "Workers KV Storage:Edit"). Rodar 1x por brand ANTES do deploy do worker
 * `poll` que contém o novo `handleSetName`.
 *
 * Uso:
 *   CLOUDFLARE_API_TOKEN=... \
 *   CLOUDFLARE_ACCOUNT_ID=5d15d8303325211d6976d73051f4b002 \
 *     npx tsx scripts/migrate-nickname-index.ts
 *
 *   # Dry-run (não escreve, só reporta o que faria):
 *   npx tsx scripts/migrate-nickname-index.ts --dry-run
 *
 *   # Só um brand (default: roda diaria E clarice em sequência):
 *   npx tsx scripts/migrate-nickname-index.ts --brand clarice
 *
 * Idempotente: re-rodar é seguro — sobrescreve o índice com o estado atual
 * de `score:*` (first-come-wins determinístico por ordem de `list()`, ver
 * `buildNicknameIndex`). Conflitos (dois emails já com o MESMO apelido
 * normalizado antes da migração — não deveria acontecer no fluxo normal,
 * mas é possível se `/admin/correct` ou edição manual do KV introduziu um)
 * são reportados no console pro editor resolver manualmente; o script NUNCA
 * aborta por causa deles — só o primeiro (por ordem de listagem) fica no
 * índice, os demais mantêm o nickname em `score:*` mas ficam "sem dono" no
 * índice até o editor decidir.
 */

// #2130: extensão `.ts` intencional (convenção tsx do repo) — ver mesma nota
// em backfill-score-by-month.ts.
import "dotenv/config";
import { normalizeNickname } from "../workers/poll/src/lib.ts";
// #2834: isMainModule as isEntryModule — alias pra evitar colisão com a const
// local `isMainModule` já usada por este script (mesmo nome, propósito idêntico).
import { isMainModule as isEntryModule } from "./lib/cli-args.ts";

// ── Lógica pura (testável sem rede/KV real) ─────────────────────────────────

export interface ScoreEntry {
  email: string;
  nickname: string | null;
}

export interface NicknameConflict {
  normalized: string;
  winner: string; // email que fica no índice
  loser: string; // email cujo apelido não pôde ser indexado
}

export interface NicknameIndexResult {
  /** normalizado → email vencedor */
  index: Map<string, string>;
  conflicts: NicknameConflict[];
}

/**
 * Pure: agrega entries de `score:*` num índice normalizado→email.
 * First-come-wins na ordem em que `entries` é iterado — caller decide a
 * ordem (produção usa a ordem de `list()`, que não é garantida estável entre
 * runs; ok pra este caso porque conflitos genuínos são raros e reportados).
 * Exportada pra teste (#3117).
 */
export function buildNicknameIndex(entries: ScoreEntry[]): NicknameIndexResult {
  const index = new Map<string, string>();
  const conflicts: NicknameConflict[] = [];
  for (const { email, nickname } of entries) {
    if (!nickname) continue;
    const norm = normalizeNickname(nickname);
    if (!norm) continue;
    const existing = index.get(norm);
    if (existing && existing !== email) {
      conflicts.push({ normalized: norm, winner: existing, loser: email });
      continue;
    }
    index.set(norm, email);
  }
  return { index, conflicts };
}

/** Abstração mínima de KV pra permitir teste com mock, sem depender de fetch/rede. */
export interface KvClient {
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface MigrateOptions {
  /** Prefixo de brand (#1905) — "" pra diaria, "clarice:" pra clarice. */
  brandPrefix?: string;
  dryRun?: boolean;
  /** Callback opcional pra progress logging (testável sem poluir stdout). */
  onProgress?: (msg: string) => void;
}

export interface MigrateResult {
  scanned: number;
  written: number;
  conflicts: NicknameConflict[];
}

/**
 * Lê todas as `{brandPrefix}score:{email}` keys, agrega em índice
 * normalizado→email, e escreve `{brandPrefix}nickname:{normalizado}` →
 * email pra cada uma (exceto em dry-run). Exportada pra teste com `KvClient`
 * mockado — não bate em rede/KV real (#3117 requisito: testar a lógica
 * isoladamente, nunca rodar a migração de verdade a partir da sessão que
 * implementa a issue).
 */
export async function migrateNicknameIndex(
  kv: KvClient,
  opts: MigrateOptions = {},
): Promise<MigrateResult> {
  const prefix = opts.brandPrefix ?? "";
  const scorePrefix = `${prefix}score:`;
  const log = opts.onProgress ?? (() => {});

  const scoreKeys = await kv.list(scorePrefix);
  log(`[migrate-nickname-index] ${scoreKeys.length} chave(s) ${scorePrefix}* encontradas`);

  const entries: ScoreEntry[] = [];
  for (const key of scoreKeys) {
    // key shape: "{prefix}score:{email}" — email pode conter ":" (raro, defensive).
    const email = key.slice(scorePrefix.length);
    const raw = await kv.get(key);
    if (!raw) continue;
    let parsed: { nickname?: string | null };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    entries.push({ email, nickname: parsed.nickname ?? null });
  }

  const { index, conflicts } = buildNicknameIndex(entries);
  log(`[migrate-nickname-index] ${index.size} apelido(s) únicos pra indexar, ${conflicts.length} conflito(s)`);

  for (const conflict of conflicts) {
    log(
      `[migrate-nickname-index] CONFLITO: apelido normalizado "${conflict.normalized}" já usado por ` +
        `${conflict.winner} — ${conflict.loser} NÃO foi indexado (nickname permanece em score:* mas sem entrada ` +
        `no índice; resolver manualmente ou pedir pro leitor trocar de apelido).`,
    );
  }

  let written = 0;
  for (const [norm, email] of index) {
    const key = `${prefix}nickname:${norm}`;
    if (opts.dryRun) {
      log(`[dry-run] PUT ${key} = ${email}`);
    } else {
      await kv.put(key, email);
    }
    written++;
  }

  return { scanned: scoreKeys.length, written, conflicts };
}

// ── CLI (Cloudflare REST API — mesmo padrão de backfill-score-by-month.ts) ──

async function main(): Promise<void> {
  const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
  const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
  const NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6"; // POLL namespace

  if (!ACCOUNT_ID || !API_TOKEN) {
    console.error("Erro: CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_API_TOKEN obrigatórios no env");
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  const brandArgIdx = process.argv.indexOf("--brand");
  const brandArg = brandArgIdx >= 0 ? process.argv[brandArgIdx + 1] : undefined;
  const brands = brandArg === "diaria" || brandArg === "clarice" ? [brandArg] : ["diaria", "clarice"];

  const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}`;

  const restKv: KvClient = {
    async list(prefix: string): Promise<string[]> {
      const all: string[] = [];
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams({ prefix, limit: "1000" });
        if (cursor) params.set("cursor", cursor);
        const res = await fetch(`${KV_BASE}/keys?${params}`, {
          headers: { Authorization: `Bearer ${API_TOKEN}` },
        });
        if (!res.ok) throw new Error(`KV list failed: ${res.status} ${await res.text()}`);
        const json = (await res.json()) as {
          result: Array<{ name: string }>;
          result_info: { cursor?: string; count: number };
        };
        all.push(...json.result.map((k) => k.name));
        cursor = json.result_info.cursor || undefined;
      } while (cursor);
      return all;
    },
    async get(key: string): Promise<string | null> {
      const res = await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`KV get ${key} failed: ${res.status}`);
      return await res.text();
    },
    async put(key: string, value: string): Promise<void> {
      const res = await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        body: value,
      });
      if (!res.ok) throw new Error(`KV put ${key} failed: ${res.status} ${await res.text()}`);
    },
  };

  console.log(`[migrate-nickname-index] mode: ${dryRun ? "DRY-RUN" : "WRITE"}, brands: ${brands.join(", ")}`);

  let totalWritten = 0;
  let totalConflicts = 0;
  for (const brand of brands) {
    const brandPrefix = brand === "diaria" ? "" : `${brand}:`;
    console.log(`[migrate-nickname-index] brand=${brand} (prefix="${brandPrefix}")`);
    const result = await migrateNicknameIndex(restKv, {
      brandPrefix,
      dryRun,
      onProgress: (msg) => console.log(msg),
    });
    console.log(
      `[migrate-nickname-index] brand=${brand}: ${result.scanned} score:* escaneadas, ` +
        `${result.written} índice(s) ${dryRun ? "seriam escritos" : "escritos"}, ${result.conflicts.length} conflito(s)`,
    );
    totalWritten += result.written;
    totalConflicts += result.conflicts.length;
  }

  console.log(
    `[migrate-nickname-index] done — ${totalWritten} índice(s) ${dryRun ? "seriam escritos" : "escritos"} no total, ` +
      `${totalConflicts} conflito(s) pra revisar manualmente`,
  );
}

// #3117: só roda o CLI quando invocado diretamente (`npx tsx migrate-nickname-index.ts`),
// nunca quando importado por teste (`import { migrateNicknameIndex } from "./migrate-nickname-index.ts"`).
// #2834: delega pro helper canônico (isEntryModule = isMainModule, ver alias no import acima).
const isMainModule = isEntryModule(import.meta.url);
if (isMainModule) {
  main().catch((e) => {
    console.error("[migrate-nickname-index] erro:", e);
    process.exit(1);
  });
}
