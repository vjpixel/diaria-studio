/**
 * sync-cursos-subscribers-kv.ts (#4052)
 *
 * Popula o KV `CURSOS_SUBSCRIBERS` (worker `cursos`) com uma chave
 * `subscriber:{sha256(email)}` → `"1"` por assinante ATIVO da Diar.ia — a
 * fonte PRIMÁRIA de verificação do gate (`workers/cursos/src/gate.ts`
 * `verifySubscriberViaKv`), decisão do #4052 porque o endpoint direto
 * `by_email` da Beehiiv não pôde ser confirmado ao vivo neste ambiente (sem
 * egress de rede / sem key real) — ver `scripts/lib/shared/subscriber-verify.ts`.
 *
 * Pagina `GET /subscriptions?status=active` no MESMO padrão comprovado de
 * `scripts/backup-beehiiv.ts` (`hasMorePages`, `resolveTotalPages`) — reusa
 * a lógica de paginação, não reinventa.
 *
 * Escrita no KV via `wrangler kv bulk put` (arquivo JSON temporário — muito
 * mais barato que 1 chamada por assinante numa base de dezenas de milhares).
 *
 * Uso:
 *   npx tsx scripts/sync-cursos-subscribers-kv.ts                  # full sync
 *   npx tsx scripts/sync-cursos-subscribers-kv.ts --dry-run        # só imprime contagem, não escreve
 *   npx tsx scripts/sync-cursos-subscribers-kv.ts --namespace-id X # override do binding id
 *
 * Env:
 *   BEEHIIV_API_KEY          obrigatório
 *   BEEHIIV_PUBLICATION_ID   opcional — fallback platform.config.json
 *   CLOUDFLARE_ACCOUNT_ID    obrigatório pro write real (não pro --dry-run)
 *   CURSOS_KV_NAMESPACE_ID   id do namespace CURSOS_SUBSCRIBERS (ou --namespace-id)
 *
 * Follow-up documentado no PR #4052: agendar via Task Scheduler seguindo o
 * MESMO padrão de `scripts/run-clarice-sync-daily.ps1` (não implementado
 * aqui — script funciona standalone/manual primeiro).
 */
import "dotenv/config";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { sha256Hex, subscriberKvKey } from "./lib/shared/subscriber-verify.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = resolve(ROOT, "workers", "cursos");
const PER_PAGE = 100;
const RATE_LIMIT_DELAY_MS = 300;
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface BeehiivSubscriber {
  email: string;
  status: string;
}

interface Page<T> {
  data?: T[];
  total_pages?: number;
  total_results?: number;
  limit?: number;
  page?: number;
}

/** Mesma heurística de `backup-beehiiv.ts` `hasMorePages` (#1897) — pure,
 * re-implementada aqui (não importada) porque `backup-beehiiv.ts` não
 * exporta as internals; mantida byte-idêntica em espírito. */
export function hasMorePages(input: {
  collected: number;
  gotLength: number;
  totalResults?: number | null;
  effectiveLimit?: number | null;
  requestedPerPage: number;
}): boolean {
  const { collected, gotLength, totalResults, effectiveLimit, requestedPerPage } = input;
  if (gotLength === 0) return false;
  if (totalResults != null && totalResults > 0) return collected < totalResults;
  const lim = effectiveLimit && effectiveLimit > 0 ? effectiveLimit : requestedPerPage;
  return gotLength >= lim;
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

/**
 * Pagina `GET /subscriptions?status=active`, retornando só os e-mails.
 * Exportada pra teste com `fetchImpl` mockado (nunca faz rede real em teste).
 */
export async function fetchActiveSubscriberEmails(
  publicationId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const emails: string[] = [];
  let page = 1;
  let more = true;
  while (more) {
    const res = await apiFetch<Page<BeehiivSubscriber>>(
      `/publications/${publicationId}/subscriptions?status=active&per_page=${PER_PAGE}&page=${page}`,
      apiKey,
      fetchImpl,
    );
    if (!res.ok) {
      if (res.status === 404 || res.status === 403) break;
      throw new Error(`Beehiiv API ${res.status} em /subscriptions (página ${page})`);
    }
    const body = res.body!;
    const got = (body.data ?? []).filter((s) => s.status === "active").map((s) => s.email);
    emails.push(...got);
    more = hasMorePages({
      collected: emails.length,
      gotLength: got.length,
      totalResults: body.total_results,
      effectiveLimit: body.limit,
      requestedPerPage: PER_PAGE,
    });
    page++;
  }
  return emails;
}

export interface KvBulkEntry {
  key: string;
  value: string;
}

/** Pure: e-mails ativos → entradas de bulk KV (`subscriber:{sha256}` → `"1"`).
 * `sha256Hex`/`subscriberKvKey` compartilhados com o worker (mesma chave em
 * ambos os lados — divergir quebraria a verificação silenciosamente). */
export async function buildKvBulkEntries(emails: string[]): Promise<KvBulkEntry[]> {
  const entries = await Promise.all(
    emails.map(async (email) => ({ key: await subscriberKvKey(email), value: "1" })),
  );
  // dedupe por key (case/whitespace diferentes colapsam no mesmo hash — sha256Hex normaliza)
  const seen = new Map<string, KvBulkEntry>();
  for (const e of entries) seen.set(e.key, e);
  return [...seen.values()];
}

function wranglerKvBulkPut(entries: KvBulkEntry[], namespaceId: string, accountId: string): void {
  const tmpDir = mkdtempSync(join(tmpdir(), "cursos-kv-bulk-"));
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
    if (r.status !== 0) {
      throw new Error(`wrangler kv bulk put falhou (exit ${r.status}):\n${r.stderr?.slice(0, 500)}`);
    }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const nsIdx = argv.indexOf("--namespace-id");
  const namespaceId = nsIdx >= 0 ? argv[nsIdx + 1] : process.env.CURSOS_KV_NAMESPACE_ID;

  const { apiKey, publicationId } = loadBeehiivConfig("[sync-cursos-subscribers-kv]");

  process.stderr.write("[sync-cursos-subscribers-kv] buscando assinantes ativos…\n");
  const emails = await fetchActiveSubscriberEmails(publicationId, apiKey);
  process.stderr.write(`[sync-cursos-subscribers-kv] ${emails.length} assinantes ativos.\n`);

  const entries = await buildKvBulkEntries(emails);
  process.stderr.write(`[sync-cursos-subscribers-kv] ${entries.length} entradas KV (após dedupe de hash).\n`);

  if (dryRun) {
    process.stderr.write("[sync-cursos-subscribers-kv] --dry-run: não escreve no KV.\n");
    console.log(JSON.stringify({ subscribers: emails.length, kv_entries: entries.length, dry_run: true }));
    return;
  }

  if (!namespaceId) {
    process.stderr.write(
      "[sync-cursos-subscribers-kv] CURSOS_KV_NAMESPACE_ID ausente (env ou --namespace-id) — rode `wrangler kv namespace create CURSOS_SUBSCRIBERS` primeiro.\n",
    );
    process.exit(2);
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    process.stderr.write("[sync-cursos-subscribers-kv] CLOUDFLARE_ACCOUNT_ID ausente.\n");
    process.exit(2);
  }

  wranglerKvBulkPut(entries, namespaceId, accountId);
  process.stderr.write(`[sync-cursos-subscribers-kv] KV atualizado: ${entries.length} entradas.\n`);
  console.log(JSON.stringify({ subscribers: emails.length, kv_entries: entries.length, dry_run: false }));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sync-cursos-subscribers-kv] erro fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}

export { sha256Hex };
