#!/usr/bin/env node
/**
 * scripts/sync-artigos-apoio-kv.ts (#7030, fonte trocada no #9300)
 *
 * Popula o KV `ARTIGOS_APOIO_NIVEL` (worker `artigos`) com uma chave
 * `apoio:{sha256(email)}` → nível de apoio (`amigo`/`apoiador`/`mantenedor`/
 * `patrono`) por e-mail de apoiador — fonte PRIMÁRIA do gate dos Artigos
 * Especiais (`workers/artigos/src/apoio-gate.ts`, via
 * `scripts/lib/shared/apoio-level-verify.ts`).
 *
 * **Fonte (#9300):** o CRM de Apoios (apoia.se) — o MESMO cálculo de nível
 * com carência de 1 mês que alimenta os syncs de `apoio_nivel`
 * (`buildApoiosData` → `computeDesiredApoioLevels`, + overrides de
 * `data/apoio-overrides.json`). Até o #9300 este script espelhava o custom
 * field `apoio_nivel` da Beehiiv, o que tinha dois buracos: (1) apoiador que
 * não assina a Beehiiv (ou assina com outro e-mail) nunca entrava, e (2)
 * depois da migração pro Kit o campo da Beehiiv parou de ser mantido. Medido
 * em 01/10/2026: o KV tinha 4 chaves para 22 apoiadores R$10+ — o gate
 * recusava 20 deles. O gate é sobre APOIO, não sobre assinatura da
 * newsletter, então a fonte certa é a apoia.se, com TODOS os e-mails de cada
 * contato do CRM.
 *
 * Contatos com nível desconhecido (`sem_dados`, falha transiente da
 * apoia.se) não geram entrada nova, mas também nunca têm a chave existente
 * apagada. Remoções ficam bloqueadas quando a fonte veio degradada
 * (`buildApoiosData` com erro, snapshots de meses anteriores ilegíveis) ou
 * quando passam de 30% das chaves existentes (mesmo limiar do #4436),
 * salvo `--force-blast-radius`.
 *
 * Uso:
 *   npx tsx scripts/sync-artigos-apoio-kv.ts                  # full sync
 *   npx tsx scripts/sync-artigos-apoio-kv.ts --dry-run        # só imprime contagem, não escreve
 *   npx tsx scripts/sync-artigos-apoio-kv.ts --namespace-id X # override do binding id
 *   npx tsx scripts/sync-artigos-apoio-kv.ts --force-blast-radius
 *
 * Env:
 *   APOIA_SE_API_KEY/_SECRET/_CAMPAIGN  via `buildApoiosData`
 *   CLOUDFLARE_ACCOUNT_ID    obrigatório pro write real (não pro --dry-run)
 *   ARTIGOS_KV_NAMESPACE_ID  opcional — default: id do binding em workers/artigos/wrangler.toml
 *
 * Agendado como `Diaria-Artigos-Apoio-Kv-Sync` (`scripts/lib/scheduled-tasks.ts`, #9300).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { apoioLevelKvKey } from "./lib/shared/apoio-level-verify.ts";
import { type ApoioNivel } from "./lib/shared/apoio-nivel-types.ts";
import { readApoiaSeEnv, defaultCacheDir, competenceMonth } from "./lib/apoia-se.ts";
import { loadApoioOverrides, applyApoioOverrides } from "./lib/apoio-overrides.ts";
import { buildApoiosData, readPastMonthSnapshots, type MonthSnapshot } from "./studio-ui/studio-apoios.ts";
import { computeDesiredApoioLevels, type DesiredApoioLevel } from "./sync-apoio-nivel-beehiiv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = resolve(ROOT, "workers", "artigos");
const LOG_PREFIX = "[sync-artigos-apoio-kv]";

/** Mesmo limiar de blast radius do sync de `apoio_nivel` (#4436). */
export const BLAST_RADIUS_THRESHOLD = 0.3;
/** Abaixo disso o percentual não diz nada (2 de 4 = 50%). */
const BLAST_RADIUS_MIN_EXISTING = 5;

export interface ApoioLevelRows {
  /** Uma linha por e-mail de contato com nível conhecido. */
  rows: Array<{ email: string; nivel: ApoioNivel }>;
  /** E-mails de contatos `sem_dados` — chave existente nunca é apagada. */
  protectedEmails: string[];
}

/** Pure: níveis desejados por contato → linhas {email, nivel} pro KV. Todos
 * os e-mails do contato recebem o nível (o apoiador pode confirmar no gate
 * com qualquer um deles). */
export function rowsFromDesiredLevels(desired: readonly DesiredApoioLevel[]): ApoioLevelRows {
  const rows: Array<{ email: string; nivel: ApoioNivel }> = [];
  const protectedEmails: string[] = [];
  for (const d of desired) {
    if (d.unresolved) {
      protectedEmails.push(...d.emails);
      continue;
    }
    if (!d.level) continue;
    for (const email of d.emails) rows.push({ email, nivel: d.level });
  }
  return { rows, protectedEmails };
}

export interface DeletionDecision {
  allowed: boolean;
  reason?: string;
}

/** Pure: pode apagar as chaves stale nesta rodada? */
export function decideStaleDeletion(args: {
  staleCount: number;
  existingCount: number;
  sourceDegraded: boolean;
  forceBlastRadius: boolean;
}): DeletionDecision {
  if (args.staleCount === 0) return { allowed: true };
  if (args.sourceDegraded) {
    return { allowed: false, reason: "fonte apoia.se degradada nesta rodada — remoções bloqueadas" };
  }
  if (
    !args.forceBlastRadius &&
    args.existingCount >= BLAST_RADIUS_MIN_EXISTING &&
    args.staleCount / args.existingCount > BLAST_RADIUS_THRESHOLD
  ) {
    return {
      allowed: false,
      reason:
        `${args.staleCount} de ${args.existingCount} chaves seriam apagadas (> ${BLAST_RADIUS_THRESHOLD * 100}%) — ` +
        "remoções bloqueadas; rode com --force-blast-radius se for real",
    };
  }
  return { allowed: true };
}

/** Lê o id do binding `ARTIGOS_APOIO_NIVEL` de `workers/artigos/wrangler.toml`. */
export function readNamespaceIdFromWranglerToml(toml: string): string | undefined {
  const m = toml.match(/binding\s*=\s*"ARTIGOS_APOIO_NIVEL"\s*\r?\n\s*id\s*=\s*"([^"]+)"/);
  if (!m || m[1].startsWith("PLACEHOLDER")) return undefined;
  return m[1];
}

export interface KvBulkEntry {
  key: string;
  value: string;
}

/** Pure: {email, nivel}[] → entradas de bulk KV (`apoio:{sha256}` → nível).
 * Dedupe por key (mesmo e-mail normalizado colapsa no mesmo hash). */
export async function buildKvBulkEntries(
  rows: Array<{ email: string; nivel: ApoioNivel }>,
): Promise<KvBulkEntry[]> {
  const entries = await Promise.all(
    rows.map(async (r) => ({ key: await apoioLevelKvKey(r.email), value: r.nivel })),
  );
  const seen = new Map<string, KvBulkEntry>();
  for (const e of entries) seen.set(e.key, e);
  return [...seen.values()];
}

function wranglerKvBulkPut(entries: KvBulkEntry[], namespaceId: string, accountId: string): void {
  if (entries.length === 0) return;
  const tmpDir = mkdtempSync(join(tmpdir(), "artigos-kv-bulk-"));
  const tmpFile = join(tmpDir, "bulk.json");
  try {
    writeFileSync(tmpFile, JSON.stringify(entries), "utf8");
    const cmd = `npx wrangler kv bulk put "${tmpFile}" --namespace-id=${namespaceId} --remote`;
    const r = spawnSync(cmd, {
      cwd: WORKER_DIR,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) throw new Error(`wrangler kv bulk put falhou (exit ${r.status}):\n${r.stderr?.slice(0, 500)}`);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export function buildKvKeyListCommand(args: { namespaceId: string }): string {
  return `npx wrangler kv key list --namespace-id=${args.namespaceId} --remote --prefix "apoio:"`;
}

function wranglerKvKeyListApoio(namespaceId: string, accountId: string): string[] {
  const cmd = buildKvKeyListCommand({ namespaceId });
  const r = spawnSync(cmd, {
    cwd: WORKER_DIR,
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) throw new Error(`wrangler kv key list falhou (exit ${r.status}):\n${r.stderr?.slice(0, 500)}`);
  const parsed = JSON.parse(r.stdout) as Array<{ name: string }>;
  return parsed.map((k) => k.name);
}

/** Pure — diffa as chaves `apoio:*` já presentes no KV contra o conjunto
 * ATUAL, devolvendo só as que sobraram (perdeu apoio/nível caiu abaixo de
 * qualquer faixa reconhecida desde o sync anterior) — mesma garantia de
 * `diffStaleSubscriberKeys` em `sync-cursos-subscribers-kv.ts`. */
export function diffStaleApoioKeys(existingKeys: string[], currentEntries: KvBulkEntry[]): string[] {
  const currentKeySet = new Set(currentEntries.map((e) => e.key));
  return existingKeys.filter((key) => key.startsWith("apoio:") && !currentKeySet.has(key));
}

export function buildKvBulkDeleteCommand(args: { tmpFile: string; namespaceId: string }): string {
  return `npx wrangler kv bulk delete "${args.tmpFile}" --namespace-id=${args.namespaceId} --remote --force`;
}

function wranglerKvBulkDelete(keys: string[], namespaceId: string, accountId: string): void {
  if (keys.length === 0) return;
  const tmpDir = mkdtempSync(join(tmpdir(), "artigos-kv-bulk-del-"));
  const tmpFile = join(tmpDir, "bulk-delete.json");
  try {
    writeFileSync(tmpFile, JSON.stringify(keys), "utf8");
    const cmd = buildKvBulkDeleteCommand({ tmpFile, namespaceId });
    const r = spawnSync(cmd, {
      cwd: WORKER_DIR,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) {
      throw new Error(`wrangler kv bulk delete falhou (exit ${r.status}):\n${r.stderr?.slice(0, 500)}`);
    }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export interface KvSyncOps {
  put: (entries: KvBulkEntry[], namespaceId: string, accountId: string) => void;
  listApoio: (namespaceId: string, accountId: string) => string[];
  bulkDelete: (keys: string[], namespaceId: string, accountId: string) => void;
}

const defaultKvSyncOps: KvSyncOps = {
  put: wranglerKvBulkPut,
  listApoio: wranglerKvKeyListApoio,
  bulkDelete: wranglerKvBulkDelete,
};

/** Orquestra list → put(tudo, idempotente) → delete(stale) — mesma ordem
 * fixa de `syncKvKeys` em `sync-cursos-subscribers-kv.ts` (put lança =>
 * delete nunca roda). Diferente daquele script, não filtra "só as novas"
 * antes do put (#4442 é uma otimização de write-amplification que este
 * volume — dezenas de apoiadores, não centenas — não justifica agora; put é
 * idempotente, reescrever um valor igual é barato e simplifica o caminho). */
export function syncKvKeys(
  entries: KvBulkEntry[],
  namespaceId: string,
  accountId: string,
  ops: KvSyncOps = defaultKvSyncOps,
  opts: {
    /** Chaves que nunca entram no delete (contatos `sem_dados`, #9300). */
    protectedKeys?: ReadonlySet<string>;
    /** Guard de remoção (#9300) — `allowed: false` pula o delete. */
    decide?: (staleCount: number, existingCount: number) => DeletionDecision;
  } = {},
): { existingKeys: string[]; staleKeys: string[]; deletion: DeletionDecision } {
  const existingKeys = ops.listApoio(namespaceId, accountId);
  const staleKeys = diffStaleApoioKeys(existingKeys, entries).filter((k) => !opts.protectedKeys?.has(k));
  const deletion = opts.decide ? opts.decide(staleKeys.length, existingKeys.length) : { allowed: true };

  if (entries.length > 0) ops.put(entries, namespaceId, accountId); // lança => delete nunca roda
  if (deletion.allowed) ops.bulkDelete(staleKeys, namespaceId, accountId);
  return { existingKeys, staleKeys, deletion };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  loadProjectEnv(ROOT);
  const dryRun = hasFlag(argv, "dry-run");
  const forceBlastRadius = hasFlag(argv, "force-blast-radius");
  const nsIdx = argv.indexOf("--namespace-id");
  const namespaceId =
    (nsIdx >= 0 ? argv[nsIdx + 1] : undefined) ??
    process.env.ARTIGOS_KV_NAMESPACE_ID ??
    readNamespaceIdFromWranglerToml(readFileSync(join(WORKER_DIR, "wrangler.toml"), "utf8"));

  process.stderr.write(`${LOG_PREFIX} calculando níveis de apoio a partir do CRM apoia.se…\n`);
  const data = await buildApoiosData(ROOT);
  let sourceDegraded = false;
  if (data.error) {
    sourceDegraded = true;
    process.stderr.write(`${LOG_PREFIX} aviso: buildApoiosData reportou erro: ${data.error}\n`);
  }

  const currentMonth = competenceMonth(new Date());
  let pastSnapshots: MonthSnapshot[] = [];
  try {
    pastSnapshots = readPastMonthSnapshots(defaultCacheDir(readApoiaSeEnv().campaign), currentMonth);
  } catch (e) {
    sourceDegraded = true;
    process.stderr.write(
      `${LOG_PREFIX} aviso: snapshots de meses anteriores ilegíveis (carência off): ${(e as Error).message}\n`,
    );
  }

  let desired = computeDesiredApoioLevels(data.contacts, pastSnapshots, currentMonth);
  const overrides = loadApoioOverrides(ROOT);
  if (overrides.length > 0) desired = applyApoioOverrides(desired, overrides);

  const { rows, protectedEmails } = rowsFromDesiredLevels(desired);
  const entries = await buildKvBulkEntries(rows);
  const protectedKeys = new Set(await Promise.all(protectedEmails.map((e) => apoioLevelKvKey(e))));
  const byLevel: Record<string, number> = {};
  for (const e of entries) byLevel[e.value] = (byLevel[e.value] ?? 0) + 1;
  process.stderr.write(
    `${LOG_PREFIX} ${entries.length} e-mail(s) com nível (${JSON.stringify(byLevel)}), ` +
      `${protectedEmails.length} protegido(s) por sem_dados.\n`,
  );

  if (dryRun) {
    process.stderr.write(`${LOG_PREFIX} --dry-run: não escreve nem apaga no KV.\n`);
    console.log(JSON.stringify({ kv_entries: entries.length, by_level: byLevel, dry_run: true }));
    return;
  }

  if (!namespaceId) {
    process.stderr.write(
      `${LOG_PREFIX} namespace ARTIGOS_APOIO_NIVEL não resolvido (env, --namespace-id ou wrangler.toml).\n`,
    );
    process.exit(2);
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    process.stderr.write(`${LOG_PREFIX} CLOUDFLARE_ACCOUNT_ID ausente.\n`);
    process.exit(2);
  }

  const { existingKeys, staleKeys, deletion } = syncKvKeys(entries, namespaceId, accountId, defaultKvSyncOps, {
    protectedKeys,
    decide: (staleCount, existingCount) =>
      decideStaleDeletion({ staleCount, existingCount, sourceDegraded, forceBlastRadius }),
  });
  if (!deletion.allowed) process.stderr.write(`${LOG_PREFIX} aviso: ${deletion.reason}\n`);
  const deleted = deletion.allowed ? staleKeys.length : 0;
  process.stderr.write(
    `${LOG_PREFIX} KV atualizado: ${entries.length} chaves gravadas, ${existingKeys.length} existentes antes, ` +
      `${deleted} stale apagadas.\n`,
  );

  console.log(
    JSON.stringify({
      kv_entries: entries.length,
      by_level: byLevel,
      stale_deleted: deleted,
      stale_blocked: staleKeys.length - deleted,
      dry_run: false,
    }),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
