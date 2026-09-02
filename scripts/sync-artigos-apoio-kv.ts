#!/usr/bin/env node
/**
 * scripts/sync-artigos-apoio-kv.ts (#7030)
 *
 * Popula o KV `ARTIGOS_APOIO_NIVEL` (worker `artigos`) com uma chave
 * `apoio:{sha256(email)}` → nível de apoio (`amigo`/`apoiador`/`mantenedor`/
 * `patrono`) por assinante ativo cujo custom field `apoio_nivel` (Beehiiv)
 * está preenchido — fonte PRIMÁRIA do gate dos Artigos Especiais
 * (`workers/artigos/src/apoio-gate.ts`, via
 * `scripts/lib/shared/apoio-level-verify.ts`).
 *
 * Mesmo padrão de paginação/KV bulk de `scripts/sync-cursos-subscribers-kv.ts`
 * (#4052) — reusa `hasMorePages`, mesmo layout de comando `wrangler kv bulk
 * put`/`kv key list`/`kv bulk delete`. Diferença: em vez de "assinante
 * ativo?" (booleano), lê+grava o VALOR do custom field `apoio_nivel`, já
 * calculado com carência de 1 mês por `sync-apoio-nivel-beehiiv.ts` — este
 * script NÃO recalcula apoio a partir do apoia.se/Stripe, só espelha o que
 * já está sincronizado na Beehiiv pro KV do worker `artigos` (mesma divisão
 * de responsabilidade que `sync-cursos-subscribers-kv.ts` tem com
 * `subscriber-verify.ts`).
 *
 * Assinantes SEM `apoio_nivel` preenchido (ou com status inativo) não geram
 * entrada — o gate trata ausência de chave como `"unknown"` (nunca apoiou,
 * do ponto de vista do gate).
 *
 * Uso:
 *   npx tsx scripts/sync-artigos-apoio-kv.ts                  # full sync
 *   npx tsx scripts/sync-artigos-apoio-kv.ts --dry-run        # só imprime contagem, não escreve
 *   npx tsx scripts/sync-artigos-apoio-kv.ts --namespace-id X # override do binding id
 *
 * Env:
 *   BEEHIIV_API_KEY          obrigatório
 *   BEEHIIV_PUBLICATION_ID   opcional — fallback platform.config.json
 *   CLOUDFLARE_ACCOUNT_ID    obrigatório pro write real (não pro --dry-run)
 *   ARTIGOS_KV_NAMESPACE_ID  id do namespace ARTIGOS_APOIO_NIVEL (ou --namespace-id)
 *
 * NÃO agendado ainda (#7030 não abre esse passo — deploy/provisionamento do
 * KV real fica pro editor, ver PR body). Uso standalone/manual, mesmo
 * comportamento de `sync-cursos-subscribers-kv.ts` antes do #4320.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { apoioLevelKvKey } from "./lib/shared/apoio-level-verify.ts";
import { hasMorePages } from "./sync-cursos-subscribers-kv.ts";
import { extractApoioNivelValue, isApoioNivel, type ApoioNivel } from "./sync-apoio-nivel-beehiiv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = resolve(ROOT, "workers", "artigos");
const PER_PAGE = 100;
const RATE_LIMIT_DELAY_MS = 300;
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface BeehiivCustomFieldRaw {
  name?: unknown;
  value?: unknown;
}

interface BeehiivSubscriberRaw {
  email: string;
  status: string;
  custom_fields?: BeehiivCustomFieldRaw[];
}

interface Page<T> {
  data?: T[];
  total_results?: number;
  limit?: number;
}

async function apiFetch<T>(
  path: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  retries = 0,
): Promise<{ ok: boolean; status: number; body: T | null }> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetchImpl(`${beehiivApiBase()}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (res.status === 429 && retries < MAX_RETRIES) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    await sleep(Math.max(retryAfter * 1000, 30_000));
    return apiFetch<T>(path, apiKey, fetchImpl, retries + 1);
  }
  if (!res.ok) return { ok: false, status: res.status, body: null };
  return { ok: true, status: res.status, body: (await res.json()) as T };
}

/** Pagina `GET /subscriptions?status=active&expand[]=custom_fields`,
 * devolvendo só {email, apoioNivel} pros que TÊM um nível reconhecido
 * (`isApoioNivel`) — o resto (campo vazio/ausente/valor não reconhecido)
 * fica de fora, mesma semântica de "não gera entrada" do docstring do topo. */
export async function fetchApoioNivelByEmail(
  publicationId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ email: string; nivel: ApoioNivel }>> {
  const out: Array<{ email: string; nivel: ApoioNivel }> = [];
  let collected = 0;
  let page = 1;
  let more = true;
  while (more) {
    const res = await apiFetch<Page<BeehiivSubscriberRaw>>(
      `/publications/${publicationId}/subscriptions?status=active&expand[]=custom_fields&per_page=${PER_PAGE}&page=${page}`,
      apiKey,
      fetchImpl,
    );
    if (!res.ok) {
      if (res.status === 404 || res.status === 403) break;
      throw new Error(`Beehiiv API ${res.status} em /subscriptions (página ${page})`);
    }
    const body = res.body!;
    const got = body.data ?? [];
    collected += got.length;
    for (const sub of got) {
      const value = extractApoioNivelValue(sub.custom_fields);
      if (value && isApoioNivel(value)) out.push({ email: sub.email.trim().toLowerCase(), nivel: value });
    }
    more = hasMorePages({
      collected,
      gotLength: got.length,
      totalResults: body.total_results,
      effectiveLimit: body.limit,
      requestedPerPage: PER_PAGE,
    });
    page++;
  }
  return out;
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
): { existingKeys: string[]; staleKeys: string[] } {
  const existingKeys = ops.listApoio(namespaceId, accountId);
  const staleKeys = diffStaleApoioKeys(existingKeys, entries);

  if (entries.length > 0) ops.put(entries, namespaceId, accountId); // lança => delete nunca roda
  ops.bulkDelete(staleKeys, namespaceId, accountId);
  return { existingKeys, staleKeys };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const nsIdx = argv.indexOf("--namespace-id");
  const namespaceId = nsIdx >= 0 ? argv[nsIdx + 1] : process.env.ARTIGOS_KV_NAMESPACE_ID;

  const { apiKey, publicationId } = loadBeehiivConfig("[sync-artigos-apoio-kv]");

  process.stderr.write("[sync-artigos-apoio-kv] buscando apoio_nivel dos assinantes ativos…\n");
  const rows = await fetchApoioNivelByEmail(publicationId, apiKey);
  process.stderr.write(`[sync-artigos-apoio-kv] ${rows.length} assinantes com apoio_nivel reconhecido.\n`);

  const entries = await buildKvBulkEntries(rows);

  if (dryRun) {
    process.stderr.write("[sync-artigos-apoio-kv] --dry-run: não escreve nem apaga no KV.\n");
    console.log(JSON.stringify({ apoiadores: rows.length, kv_entries: entries.length, dry_run: true }));
    return;
  }

  if (!namespaceId) {
    process.stderr.write(
      "[sync-artigos-apoio-kv] ARTIGOS_KV_NAMESPACE_ID ausente (env ou --namespace-id) — rode `wrangler kv namespace create ARTIGOS_APOIO_NIVEL` primeiro.\n",
    );
    process.exit(2);
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    process.stderr.write("[sync-artigos-apoio-kv] CLOUDFLARE_ACCOUNT_ID ausente.\n");
    process.exit(2);
  }

  const { existingKeys, staleKeys } = syncKvKeys(entries, namespaceId, accountId);
  process.stderr.write(
    `[sync-artigos-apoio-kv] KV atualizado: ${entries.length} chaves gravadas, ${existingKeys.length} existentes antes, ${staleKeys.length} stale apagadas.\n`,
  );

  console.log(
    JSON.stringify({
      apoiadores: rows.length,
      kv_entries: entries.length,
      stale_deleted: staleKeys.length,
      dry_run: false,
    }),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sync-artigos-apoio-kv] erro fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
