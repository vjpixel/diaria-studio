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
 * #4381: além do `put` das chaves ativas, diffa o conjunto de chaves
 * `subscriber:*` JÁ presentes no KV contra o conjunto ATUAL de ativos e
 * `wrangler kv bulk delete` as que sobraram (assinante que cancelou desde o
 * sync anterior). Antes do #4381, a chave de quem cancelava nunca era
 * removida — antes do #4320 (sync manual, esporádico) isso era um gap
 * pontual; com o sync agendado DIARIAMENTE, virou acúmulo permanente (a
 * pessoa continua passando pelo gate `?email=`/cookie indefinidamente,
 * mitigado só pelo fallback `by_email` da Beehiiv ser a fonte de verdade
 * real — a KV é cache de aceleração, não a única porta). O `kv key list` usa
 * `--prefix "subscriber:"` DE PROPÓSITO: o MESMO namespace `CURSOS_SUBSCRIBERS`
 * também guarda chaves `cooldown:cursos-pending-promo:*` (gate.ts,
 * `shouldRecheckEmailVerification`, #4387/#4390) e `rl:cursos-gate:*`
 * (gate.ts, `checkGateRateLimit`) — sem o prefixo, um `kv key list` sem filtro
 * devolveria TODAS as chaves do namespace e o diff apagaria cooldowns/rate-limits
 * vivos junto (nunca deveriam ser tocados por este script). O diff em si
 * (`diffStaleSubscriberKeys`) é puro e coberto por teste — nunca deleta uma
 * chave que ainda está no conjunto ativo corrente.
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
 * Agendado (#4320) via Task Scheduler no mesmo padrão de
 * `scripts/run-clarice-sync-daily.ps1` — ver `scripts/run-cursos-kv-sync.ps1`
 * + `scripts/setup-cursos-kv-sync-schedule.ps1` (task "Diaria-Cursos-Kv-Sync",
 * diária 09:15). Segue funcionando standalone/manual também (uso abaixo).
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

/** #4381: lista as chaves `subscriber:*` JÁ presentes no KV — SEMPRE com o
 * prefixo `subscriber:` (ver docstring do topo do arquivo pro porquê: o
 * namespace é compartilhado com chaves de cooldown/rate-limit do gate, que
 * este script nunca deve enxergar nem tocar). */
function wranglerKvKeyListSubscribers(namespaceId: string, accountId: string): string[] {
  const cmd = `npx wrangler kv key list --namespace-id=${namespaceId} --remote --prefix "subscriber:"`;
  const r = spawnSync(cmd, {
    cwd: WORKER_DIR,
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    throw new Error(`wrangler kv key list falhou (exit ${r.status}):\n${r.stderr?.slice(0, 500)}`);
  }
  const parsed = JSON.parse(r.stdout) as Array<{ name: string }>;
  return parsed.map((k) => k.name);
}

/**
 * Pure — diffa as chaves `subscriber:*` já presentes no KV contra o conjunto
 * ATUAL de entradas ativas, devolvendo só as que SOBRARAM (assinante que
 * cancelou/saiu da lista ativa desde o sync anterior — candidatas a delete).
 *
 * Duas garantias deliberadas, cobertas por teste (#4381 — é caminho de
 * deleção real, tolerância zero a falso-positivo):
 *   1. Uma chave presente em AMBOS os lados (ainda ativa) NUNCA aparece no
 *      resultado — corte por `Set` do lado dos ativos, não por índice/ordem.
 *   2. Uma chave que não começa com `subscriber:` é ignorada (defesa em
 *      profundidade — mesmo que `existingKeys` venha sem filtro nenhum de
 *      prefixo por engano em algum caller futuro, este helper nunca devolve
 *      uma chave de cooldown/rate-limit do MESMO namespace).
 */
export function diffStaleSubscriberKeys(existingKeys: string[], currentEntries: KvBulkEntry[]): string[] {
  const currentKeySet = new Set(currentEntries.map((e) => e.key));
  return existingKeys.filter((key) => key.startsWith("subscriber:") && !currentKeySet.has(key));
}

/** #4381: contraparte delete de `wranglerKvBulkPut` — mesmo padrão de arquivo
 * JSON temporário (`wrangler kv bulk delete` espera um array de strings, não
 * de `{key,value}` como o bulk put). `--force` pula o prompt de confirmação
 * interativo (script roda desassistido via Task Scheduler). No-op se `keys`
 * vier vazio — evita invocar wrangler à toa quando não há nada pra apagar. */
function wranglerKvBulkDelete(keys: string[], namespaceId: string, accountId: string): void {
  if (keys.length === 0) return;
  const tmpDir = mkdtempSync(join(tmpdir(), "cursos-kv-bulk-del-"));
  const tmpFile = join(tmpDir, "bulk-delete.json");
  try {
    writeFileSync(tmpFile, JSON.stringify(keys), "utf8");
    const cmd = `npx wrangler kv bulk delete "${tmpFile}" --namespace-id=${namespaceId} --remote --force`;
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
    // #4381: dry-run permanece um caminho 100% read-free de KV — não lista
    // nem calcula stale keys (isso exigiria namespaceId/accountId resolvidos
    // e uma chamada real de `kv key list`). Symmetria com o comportamento
    // pré-#4381: mostra só o que o PUT faria.
    process.stderr.write("[sync-cursos-subscribers-kv] --dry-run: não escreve nem apaga no KV.\n");
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
  process.stderr.write(`[sync-cursos-subscribers-kv] KV atualizado: ${entries.length} entradas ativas.\n`);

  // #4381: diff + delete das chaves subscriber:* que sobraram (cancelou desde
  // o sync anterior). Roda DEPOIS do put — se o put falhar, o processo já
  // lançou e nunca chega aqui; nunca deleta antes de confirmar que o conjunto
  // ativo foi escrito com sucesso.
  process.stderr.write("[sync-cursos-subscribers-kv] listando chaves subscriber:* existentes no KV…\n");
  const existingKeys = wranglerKvKeyListSubscribers(namespaceId, accountId);
  const staleKeys = diffStaleSubscriberKeys(existingKeys, entries);
  process.stderr.write(
    `[sync-cursos-subscribers-kv] ${existingKeys.length} chaves existentes, ${staleKeys.length} stale (cancelaram) a apagar.\n`,
  );
  wranglerKvBulkDelete(staleKeys, namespaceId, accountId);
  if (staleKeys.length > 0) {
    process.stderr.write(`[sync-cursos-subscribers-kv] ${staleKeys.length} chaves stale apagadas.\n`);
  }

  console.log(
    JSON.stringify({
      subscribers: emails.length,
      kv_entries: entries.length,
      stale_deleted: staleKeys.length,
      dry_run: false,
    }),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sync-cursos-subscribers-kv] erro fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}

export { sha256Hex };
