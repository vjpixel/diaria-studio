/**
 * sync-cursos-subscribers-kv.ts (#4052)
 *
 * Popula o KV `CURSOS_SUBSCRIBERS` (worker `cursos`) com uma chave
 * `subscriber:{sha256(email)}` → `"1"` por assinante ATIVO da diar.ia.br — a
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
 * #4381: além do `put`, diffa o conjunto de chaves `subscriber:*` JÁ
 * presentes no KV contra o conjunto ATUAL de ativos e `wrangler kv bulk
 * delete` as que sobraram (assinante que cancelou desde o sync anterior).
 * Antes do #4381, a chave de quem cancelava nunca era removida — antes do
 * #4320 (sync manual, esporádico) isso era um gap pontual; com o sync
 * agendado DIARIAMENTE, virou acúmulo permanente (a pessoa continua passando
 * pelo gate `?email=`/cookie indefinidamente, mitigado só pelo fallback
 * `by_email` da Beehiiv ser a fonte de verdade real — a KV é cache de
 * aceleração, não a única porta). O `kv key list` usa `--prefix "subscriber:"`
 * DE PROPÓSITO: o MESMO namespace `CURSOS_SUBSCRIBERS` também guarda chaves
 * `cooldown:cursos-pending-promo:*` (gate.ts, `shouldRecheckEmailVerification`,
 * #4387/#4390) e `rl:cursos-gate:*` (gate.ts, `checkGateRateLimit`) — sem o
 * prefixo, um `kv key list` sem filtro devolveria TODAS as chaves do
 * namespace e o diff apagaria cooldowns/rate-limits vivos junto (nunca
 * deveriam ser tocados por este script). O diff em si (`diffStaleSubscriberKeys`)
 * é puro e coberto por teste — nunca deleta uma chave que ainda está no
 * conjunto ativo corrente.
 *
 * #4442: até aqui, o `put` gravava o conjunto COMPLETO de assinantes ativos
 * TODO dia (551 escritas/dia numa base onde só ~3/dia de fato mudam) — o
 * `list` do #4381 já buscava a informação necessária pro diff, só não era
 * usada pro lado do put. `syncKvKeys` agora roda list→diff→put(só as
 * novas)→delete — ver a docstring da função pro detalhe da ordem e da
 * garantia (herdada do #4381) de que uma falha no `put` nunca é seguida de
 * um `delete`.
 *
 * #7338 follow-up (05/09/2026): a fonte de assinantes ATIVOS agora segue
 * `publishing.newsletter.subscriber_backend` (`resolveNewsletterSubscriberBackend`,
 * `scripts/lib/shared/newsletter-subscriber-source.ts`) em vez de Beehiiv
 * hardcoded — ver docstring de `fetchActiveSubscriberEmailsForBackend`.
 *
 * Uso:
 *   npx tsx scripts/sync-cursos-subscribers-kv.ts                  # full sync
 *   npx tsx scripts/sync-cursos-subscribers-kv.ts --dry-run        # só imprime contagem, não escreve
 *   npx tsx scripts/sync-cursos-subscribers-kv.ts --namespace-id X # override do binding id
 *   npx tsx scripts/sync-cursos-subscribers-kv.ts --force-empty-guard # ignora o guard de fonte suspeita-vazia (#7338)
 *
 * Env:
 *   BEEHIIV_API_KEY          obrigatório se subscriber_backend="beehiiv" (default)
 *   BEEHIIV_PUBLICATION_ID   opcional — fallback platform.config.json
 *   KIT_API_KEY              obrigatório se subscriber_backend="kit"
 *   CLOUDFLARE_ACCOUNT_ID    obrigatório pro write real (não pro --dry-run)
 *   CURSOS_KV_NAMESPACE_ID   id do namespace CURSOS_SUBSCRIBERS (ou --namespace-id)
 *
 * Agendado (#4320) via systemd — task "Diaria-Cursos-Kv-Sync", diária 09:15
 * (`scripts/lib/scheduled-tasks.ts`, via `scripts/run-task.ts`). Segue
 * funcionando standalone/manual também (uso abaixo).
 */
import "dotenv/config";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { isMainModule, hasFlag } from "./lib/cli-args.ts";
import { sha256Hex, subscriberKvKey } from "./lib/shared/subscriber-verify.ts";
import {
  resolveNewsletterSubscriberBackend,
  type NewsletterSubscriberBackend,
} from "./lib/shared/newsletter-subscriber-source.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { listAllKitSubscribers } from "./lib/kit-subscribers.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = resolve(ROOT, "workers", "cursos");
const PER_PAGE = 100;
const RATE_LIMIT_DELAY_MS = 300;
const MAX_RETRIES = 3;
/** Guard: se a Beehiiv devolver menos que este % do que tinha na última
 *  rodada registrada, algo está errado (auth/paginação, ou — achado ao vivo
 *  #7338 — a fonte em si foi zerada por uma migração de plataforma), não
 *  "todo mundo cancelou". Mesmo valor/racional de `sync-beehiiv-subscribers-kit.ts`
 *  (`EMPTY_GUARD_RATIO`, #6092). */
const EMPTY_GUARD_RATIO = 0.5;

/**
 * #7338: `wranglerKvBulkPut`/`wranglerKvKeyListSubscribers`/`wranglerKvBulkDelete`
 * chamam `npx wrangler` via `spawnSync({ shell: true })`, herdando o PATH do
 * processo atual. Sob systemd `--user` (unit sem `Environment=PATH=`), esse
 * PATH resolve `npx` pro Node do SISTEMA — que pode ser mais antigo que o
 * Node com que ESTE script está rodando (`ExecStart` do unit aponta pra um
 * Node ≥22 explícito, mas isso não afeta o PATH que o processo herda).
 * Reproduzido ao vivo em `helios` 05/09/2026: unit falhando com `exit 1`
 * silencioso (journalctl não captura stdout/stderr do processo) porque
 * `npx` resolvia Node 20.20.2 via `/usr/bin/npx`, e wrangler exige ≥22
 * (CLAUDE.md 1a). `dirname(process.execPath)` — o diretório do binário Node
 * que está rodando ESTE processo agora, garantido ≥22 por construção — vai
 * na FRENTE do PATH herdado, então `npx` (e o `wrangler` que ele invoca)
 * resolvem pro mesmo Node deste processo, independente de qual PATH mínimo
 * o unit systemd (ou qualquer outro caller) fornece.
 */
export function wranglerSpawnEnv(accountId: string): NodeJS.ProcessEnv {
  const nodeBinDir = dirname(process.execPath);
  const existingPath = process.env.PATH ?? process.env.Path ?? "";
  return {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    PATH: [nodeBinDir, existingPath].filter(Boolean).join(delimiter),
  };
}

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

/**
 * #7338 follow-up (achado pós-merge do #7463, 05/09/2026): o guard de fonte
 * suspeita-vazia (`evaluateKvEmptyGuard` abaixo) protege o KV de ser
 * apagado por engano, mas até aqui `main()` continuava hardcoded pra
 * Beehiiv (`loadBeehiivConfig`/`fetchActiveSubscriberEmails`), nunca
 * checando `publishing.newsletter.subscriber_backend` — o MESMO padrão de
 * bug já achado e corrigido em `count-subscriptions-by-utm.ts` (#7395) e
 * declarado (mas não corrigido) em `cleanup-preflight-subscribers.ts`
 * (#7393). A Beehiiv zerou pra 0 assinantes ativos na migração #7386/#7388,
 * e `subscriber_backend` virou `"kit"` no #7395 — só que este script nunca
 * lia essa chave, então toda rodada buscava (corretamente, do ponto de
 * vista da API) 0 assinantes na Beehiiv, e o guard novo (corretamente)
 * recusava e saía com exit 1: a unit systemd falhava de novo, só que por
 * DESIGN (fonte errada), não pelo bug de PATH que o #7463 já tinha
 * corrigido. Esta função ramifica por `resolveNewsletterSubscriberBackend()`
 * — mesmo padrão do #7395 — em vez de assumir Beehiiv incondicionalmente.
 * Fetchers injetáveis (default os reais) pra ser testável sem rede — mesmo
 * padrão de `fetchByBackend` em `count-subscriptions-by-utm.ts` (#7395).
 */
export async function fetchActiveSubscriberEmailsForBackend(
  backend: NewsletterSubscriberBackend,
  fetchers: {
    fetchBeehiiv?: () => Promise<string[]>;
    fetchKit?: () => Promise<string[]>;
  } = {},
): Promise<string[]> {
  if (backend === "kit") {
    return (
      fetchers.fetchKit ??
      (async () => {
        const result = resolveKitConfig();
        if (!result.ok) {
          throw new Error(`[sync-cursos-subscribers-kv] Kit config inválida: ${result.reason}`);
        }
        const subscribers = await listAllKitSubscribers(result.config, { status: "active" });
        return subscribers.map((s) => s.email_address);
      })
    )();
  }
  return (
    fetchers.fetchBeehiiv ??
    (() => {
      const { apiKey, publicationId } = loadBeehiivConfig("[sync-cursos-subscribers-kv]");
      return fetchActiveSubscriberEmails(publicationId, apiKey);
    })
  )();
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

/** No-op se `entries` vier vazio (#4442) — mesmo padrão de
 * `wranglerKvBulkDelete` abaixo: evita criar arquivo temporário e invocar o
 * wrangler à toa quando não há nada novo pra gravar (dia comum: 0 assinantes
 * novos desde o sync anterior). */
function wranglerKvBulkPut(entries: KvBulkEntry[], namespaceId: string, accountId: string): void {
  if (entries.length === 0) return;
  const tmpDir = mkdtempSync(join(tmpdir(), "cursos-kv-bulk-"));
  const tmpFile = join(tmpDir, "bulk.json");
  try {
    writeFileSync(tmpFile, JSON.stringify(entries), "utf8");
    const cmd = `npx wrangler kv bulk put "${tmpFile}" --namespace-id=${namespaceId} --remote`;
    const r = spawnSync(cmd, {
      cwd: WORKER_DIR,
      encoding: "utf8",
      env: wranglerSpawnEnv(accountId),
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

/**
 * Pure: constrói o command string do wrangler kv key list — SEMPRE com
 * `--prefix "subscriber:"` (ver docstring do topo do arquivo pro porquê: o
 * namespace é compartilhado com chaves de cooldown/rate-limit do gate, que
 * este script nunca deve enxergar nem tocar). Exportada pra teste direto do
 * comando construído, sem precisar mockar `spawnSync` (mesmo padrão de
 * `buildKvPutCommand` em `scripts/lib/poll-kv.ts`, #1245) — fecha a lacuna de
 * "prefixo certo" apontada no self-review (#4381 finding 1) sem depender de
 * uma chamada real ao wrangler.
 */
export function buildKvKeyListCommand(args: { namespaceId: string }): string {
  return `npx wrangler kv key list --namespace-id=${args.namespaceId} --remote --prefix "subscriber:"`;
}

/** #4381: lista as chaves `subscriber:*` JÁ presentes no KV. */
function wranglerKvKeyListSubscribers(namespaceId: string, accountId: string): string[] {
  const cmd = buildKvKeyListCommand({ namespaceId });
  const r = spawnSync(cmd, {
    cwd: WORKER_DIR,
    encoding: "utf8",
    env: wranglerSpawnEnv(accountId),
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

/**
 * Pure: constrói o command string do wrangler kv bulk delete — SEMPRE com
 * `--force` (script roda desassistido via Task Scheduler; sem essa flag o
 * `spawnSync` ficaria esperando uma confirmação interativa que nunca chega).
 * Exportada pra teste direto, mesmo padrão de `buildKvKeyListCommand` acima.
 */
export function buildKvBulkDeleteCommand(args: { tmpFile: string; namespaceId: string }): string {
  return `npx wrangler kv bulk delete "${args.tmpFile}" --namespace-id=${args.namespaceId} --remote --force`;
}

/** #4381: contraparte delete de `wranglerKvBulkPut` — mesmo padrão de arquivo
 * JSON temporário (`wrangler kv bulk delete` espera um array de strings, não
 * de `{key,value}` como o bulk put). No-op se `keys` vier vazio — evita
 * invocar wrangler à toa quando não há nada pra apagar. */
function wranglerKvBulkDelete(keys: string[], namespaceId: string, accountId: string): void {
  if (keys.length === 0) return;
  const tmpDir = mkdtempSync(join(tmpdir(), "cursos-kv-bulk-del-"));
  const tmpFile = join(tmpDir, "bulk-delete.json");
  try {
    writeFileSync(tmpFile, JSON.stringify(keys), "utf8");
    const cmd = buildKvBulkDeleteCommand({ tmpFile, namespaceId });
    const r = spawnSync(cmd, {
      cwd: WORKER_DIR,
      encoding: "utf8",
      env: wranglerSpawnEnv(accountId),
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

/** Trio de operações de baixo nível que `syncKvKeys` orquestra — injetável só
 * pra teste (`test/sync-cursos-subscribers-kv.test.ts` mocka os 3 e verifica
 * ordem + argumentos sem tocar wrangler/KV de verdade). Em produção, `main()`
 * sempre usa `defaultKvSyncOps` (as implementações reais via `spawnSync`). */
export interface KvSyncOps {
  put: (entries: KvBulkEntry[], namespaceId: string, accountId: string) => void;
  listSubscribers: (namespaceId: string, accountId: string) => string[];
  bulkDelete: (keys: string[], namespaceId: string, accountId: string) => void;
}

const defaultKvSyncOps: KvSyncOps = {
  put: wranglerKvBulkPut,
  listSubscribers: wranglerKvKeyListSubscribers,
  bulkDelete: wranglerKvBulkDelete,
};

/**
 * Orquestra list → diff → put(só as novas) → delete(stale) NESTA ORDEM FIXA.
 *
 * #4442: antes, `ops.put` recebia o CONJUNTO COMPLETO de assinantes ativos
 * TODO dia — 551 escritas/dia onde só ~3 de fato mudam (o teto de escrita de
 * KV do plano grátis do Cloudflare é 1.000/dia por CONTA, compartilhado entre
 * todos os workers; este sync sozinho consumia 55%). O `list` já rodava
 * (`ops.listSubscribers`, #4381), mas só alimentava o lado da DELEÇÃO — a
 * informação necessária pro diff do put já estava sendo buscada, só não
 * estava sendo usada pra isso. Agora `list` roda PRIMEIRO (leitura, sem
 * efeito colateral — não enfraquece nenhuma garantia de segurança) pra
 * computar `toAdd` (só as chaves ausentes do KV) ANTES do put.
 *
 * Garantia do #4381 PRESERVADA (self-review finding 1, caminho de deleção
 * real): `ops.put` continua ANTES de `ops.bulkDelete`, e se lançar, a
 * exceção propaga direto — `ops.bulkDelete` NUNCA roda nesse caso. O que
 * mudou é só O QUE o put recebe (`toAdd`, não `entries` inteiro) e que o
 * `list` — necessário pra calcular esse `toAdd` — agora roda ANTES do put em
 * vez de depois (não havia como ser diferente: não dá pra saber o que é
 * "novo" sem primeiro saber o que já existe). `put` vazio (`toAdd.length ===
 * 0`, dia sem assinante novo — caso comum) é pulado por completo (chamada
 * nem acontece; `wranglerKvBulkPut` também já é no-op nesse caso, defesa
 * dupla). `ops` default (`defaultKvSyncOps`) é a implementação real; o
 * parâmetro só existe pra teste substituir por spies e verificar ordem +
 * argumentos sem `spawnSync` de verdade.
 */
export function syncKvKeys(
  entries: KvBulkEntry[],
  namespaceId: string,
  accountId: string,
  ops: KvSyncOps = defaultKvSyncOps,
): { existingKeys: string[]; staleKeys: string[]; addedKeys: string[] } {
  const existingKeys = ops.listSubscribers(namespaceId, accountId);
  const existing = new Set(existingKeys);
  const toAdd = entries.filter((e) => !existing.has(e.key));
  const staleKeys = diffStaleSubscriberKeys(existingKeys, entries);

  if (toAdd.length > 0) ops.put(toAdd, namespaceId, accountId); // lança => delete nunca roda
  ops.bulkDelete(staleKeys, namespaceId, accountId);
  return { existingKeys, staleKeys, addedKeys: toAdd.map((e) => e.key) };
}

// ---------------------------------------------------------------------------
// Guard: fonte de assinantes suspeita-vazia (#7338)
// ---------------------------------------------------------------------------

export interface KvSyncState {
  last_run_at: string;
  active_subscriber_count: number;
  /** #7485: backend que gerou este baseline (`resolveNewsletterSubscriberBackend()`
   *  no momento da rodada). Opcional — estado legado gravado antes deste
   *  campo existir (ou seja, qualquer arquivo `.kv-sync-state.json` já em
   *  disco antes desta PR) não tem esta chave; `isValidKvSyncState` aceita
   *  a ausência tratando como "backend desconhecido", e `evaluateKvEmptyGuard`
   *  trata "desconhecido" como não-comparável ao backend atual (mesmo
   *  caminho de troca de backend — ver docstring de `evaluateKvEmptyGuard`). */
  backend?: NewsletterSubscriberBackend;
}

function statePath(rootDir: string): string {
  return resolve(rootDir, "data", "cursos-subscribers", ".kv-sync-state.json");
}

/** Achado ao vivo #7338: `syncKvKeys` trata TODO assinante ausente de
 *  `entries` como stale e o apaga do KV (`diffStaleSubscriberKeys`). Se
 *  `fetchActiveSubscriberEmails` devolver 0 (ou quase 0) por uma falha de
 *  fonte — não porque todo mundo cancelou —, a próxima chamada apagaria o
 *  KV inteiro. Confirmado ao vivo: a migração de backend (#7388/#7395)
 *  zerou os assinantes ATIVOS da Beehiiv (fonte que este script lê,
 *  hardcoded via `loadBeehiivConfig` — ver #7393/#7395 pro mesmo padrão de
 *  bug noutros scripts), e este script rodaria sobre uma base de 0 achando
 *  que é o número real, apagando as chaves de quem de fato tem acesso ao
 *  curso. Mesmo shape/racional de `evaluateEmptyGuard` em
 *  `sync-beehiiv-subscribers-kit.ts` (#6092) — sem histórico prévio (1ª
 *  rodada), sempre passa.
 *
 *  #7485: `backend` é OPCIONAL de propósito — estado legado gravado antes
 *  deste campo existir não o tem, e isso não é shape inválido: é tratado
 *  como "backend desconhecido" (nunca compara igual a um backend
 *  conhecido em `evaluateKvEmptyGuard`, então cai no mesmo caminho de "sem
 *  baseline comparável" de uma troca de backend legítima). */
function isValidKvSyncState(v: unknown): v is KvSyncState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.last_run_at !== "string") return false;
  if (typeof o.active_subscriber_count !== "number" || !Number.isFinite(o.active_subscriber_count)) return false;
  if (o.backend !== undefined && o.backend !== "beehiiv" && o.backend !== "kit") return false;
  return true;
}

export function readKvSyncState(rootDir: string): KvSyncState | null {
  const path = statePath(rootDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path}: JSON inválido (${(e as Error).message}) — apagar o arquivo trata como "sem baseline" na próxima rodada.`);
  }
  if (!isValidKvSyncState(parsed)) {
    throw new Error(`${path}: shape inesperado (esperava {last_run_at: string, active_subscriber_count: number}) — apagar o arquivo trata como "sem baseline" na próxima rodada.`);
  }
  return parsed;
}

export function writeKvSyncState(rootDir: string, state: KvSyncState): void {
  const path = statePath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

/** #7485 finding HIGH (fleet review, silent-failure-hunter): `skippedReason`
 *  distingue, no lado `ok:true`, um "passou porque a razão realmente está
 *  boa" (ou "sem histórico, 1ª rodada") de um "passou porque o guard de
 *  razão foi INTEIRAMENTE PULADO por mismatch de backend contra o
 *  baseline" — sem esse campo, os dois caem no mesmo `{ok:true}` opaco e
 *  `main()` não tinha como logar o caso de bypass: se o mismatch coincidir
 *  com (ou for CAUSADO por) uma fonte genuinamente degradada — não um flip
 *  real, mas um bug que muda `resolveNewsletterSubscriberBackend()` por
 *  engano —, ninguém veria rastro nenhum de que o guard de razão foi
 *  ignorado naquela rodada. */
export type KvEmptyGuardResult =
  | { ok: true; skippedReason?: "backend-mismatch" }
  | { ok: false; reason: string };

/** Pura — recusa a rodada se a contagem atual de ativos encolheu demais
 *  desde a última vez (ver docstring acima). Sem histórico prévio, sempre
 *  passa. `!Number.isFinite(ratio)` falha FECHADO (nunca aberto).
 *  `backendLabel` (default `"a fonte"`) nomeia o backend nas mensagens —
 *  review do #7477 apontou que ficavam hardcoded "Beehiiv" mesmo quando
 *  `main()` já lê do Kit (`subscriber_backend="kit"`, #7395): reportar o
 *  sistema errado como culpado é exatamente a classe de confusão de
 *  diagnóstico que este guard existe pra evitar.
 *
 *  #7485: `currentBackend` (opcional) é o backend da rodada CORRENTE —
 *  quando informado e diferente de `previousState.backend` (inclusive
 *  quando este último é `undefined`, baseline legado sem o campo, tratado
 *  como "desconhecido" por `isValidKvSyncState`), o guard trata como "SEM
 *  baseline comparável", mesmo caminho de `!previousState` acima — o piso
 *  absoluto de `currentCount === 0` continua valendo nesse caso. Sem isso,
 *  um flip legítimo de `publishing.newsletter.subscriber_backend` (ex:
 *  Beehiiv 5000 assinantes → Kit 400, escala diferente da fonte nova, não
 *  degradação) travava a task de forma persistente: a razão comparava
 *  contagens de fontes DIFERENTES, e nem `--force-empty-guard` destravava
 *  de vez, porque force não atualiza o baseline (por design, pro caso
 *  normal de queda real). Quando `currentBackend` é omitido (chamador
 *  legado que não conhece o backend), o comportamento é o de antes desta
 *  PR — só compara a razão, sem checar backend. */
export function evaluateKvEmptyGuard(
  currentCount: number,
  previousState: KvSyncState | null,
  currentBackend?: NewsletterSubscriberBackend,
  backendLabel: string = "a fonte",
): KvEmptyGuardResult {
  // #7463 finding P0 (self-review): SEM baseline (1ª rodada desde que este
  // guard existe — exatamente o estado real de produção hoje, já que
  // `.kv-sync-state.json` nasce com esta mesma PR) `!previousState` cairia
  // no `{ok:true}` de "sem histórico pra comparar" — mas a Beehiiv está
  // ATUALMENTE com 0 assinantes ativos (migração #7388/#7395, fato do
  // mundo real no momento deste deploy, não hipotético). Sem este piso
  // absoluto, a 1ª rodada bem-sucedida após o fix do PATH (bug 1 desta
  // mesma issue) leria 0, passaria o guard por falta de baseline, e
  // apagaria o KV inteiro — o EXATO incidente que este guard existe pra
  // prevenir. `currentCount === 0` recusa SEMPRE, com ou sem baseline;
  // `--force-empty-guard` continua sendo o escape hatch caso 0 seja
  // legitimamente o número certo (ex: KV genuinamente vazio, dia 1).
  if (currentCount === 0) {
    return {
      ok: false,
      reason:
        `${backendLabel} devolveu 0 assinantes ativos — piso absoluto, nunca aceito mesmo sem baseline prévio ` +
        `(fonte pode estar zerada por migração de plataforma, não "todo mundo cancelou"). ` +
        `A próxima etapa apagaria o KV CURSOS_SUBSCRIBERS inteiro.`,
    };
  }
  if (!previousState || previousState.active_subscriber_count === 0) return { ok: true };
  // #7485: baseline de outro backend (ou legado sem `backend`, "desconhecido")
  // não é comparável — a razão só faz sentido entre rodadas da MESMA fonte.
  // `skippedReason: "backend-mismatch"` marca que o guard de razão foi
  // INTEIRAMENTE PULADO nesta rodada (não "passou porque a razão está boa")
  // — `main()` usa esse campo pra logar o bypass explicitamente (finding
  // HIGH do fleet review: sem isso, o pulo era indistinguível de um "passou
  // normal" nos logs).
  if (currentBackend !== undefined && previousState.backend !== currentBackend) {
    return { ok: true, skippedReason: "backend-mismatch" };
  }
  const ratio = currentCount / previousState.active_subscriber_count;
  if (!Number.isFinite(ratio) || ratio < EMPTY_GUARD_RATIO) {
    const pct = Number.isFinite(ratio) ? `${(ratio * 100).toFixed(0)}%` : "indefinido";
    return {
      ok: false,
      reason: `${backendLabel} devolveu ${currentCount} assinantes ativos, ${pct} dos ${previousState.active_subscriber_count} da última rodada (${previousState.last_run_at}) — provável falha de fonte/auth/paginação (ou fonte zerada por migração de plataforma), não "todo mundo cancelou". A próxima etapa apagaria essas chaves do KV CURSOS_SUBSCRIBERS.`,
    };
  }
  return { ok: true };
}

export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const forceEmptyGuard = hasFlag(argv, "force-empty-guard");
  const nsIdx = argv.indexOf("--namespace-id");
  const namespaceId = nsIdx >= 0 ? argv[nsIdx + 1] : process.env.CURSOS_KV_NAMESPACE_ID;

  // #7338 follow-up: backend segue publishing.newsletter.subscriber_backend
  // (default "beehiiv") em vez de assumir Beehiiv incondicionalmente — ver
  // docstring de fetchActiveSubscriberEmailsForBackend.
  const backend = resolveNewsletterSubscriberBackend();
  process.stderr.write(`[sync-cursos-subscribers-kv] buscando assinantes ativos (backend=${backend})…\n`);
  const emails = await fetchActiveSubscriberEmailsForBackend(backend);
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

  // #7338: guard ANTES de qualquer chamada real de wrangler — `syncKvKeys`
  // trata todo ausente de `entries` como stale e apaga do KV
  // (`diffStaleSubscriberKeys`); uma fonte suspeita-vazia apagaria o KV
  // inteiro em vez de "ninguém mudou". `--force-empty-guard` é o escape
  // hatch e NUNCA atualiza o baseline persistido (mesmo padrão de
  // `sync-beehiiv-subscribers-kit.ts`, #6092) — só uma rodada que passou
  // pelo guard normalmente grava estado, pra não perpetuar um número
  // degradado como "normal".
  const previousState = readKvSyncState(rootDir);
  const backendLabel = backend === "kit" ? "Kit" : "Beehiiv";
  const guard = evaluateKvEmptyGuard(emails.length, previousState, backend, backendLabel);
  if (!guard.ok) {
    if (!forceEmptyGuard) {
      process.stderr.write(`[sync-cursos-subscribers-kv] GUARD: ${guard.reason}\n`);
      process.stderr.write(
        "[sync-cursos-subscribers-kv] abortando sem tocar no KV — rode com --force-empty-guard se a queda for legítima.\n",
      );
      process.exit(1);
    }
    process.stderr.write(`[sync-cursos-subscribers-kv] AVISO (--force-empty-guard): ${guard.reason} — prosseguindo mesmo assim.\n`);
  } else if (guard.skippedReason === "backend-mismatch") {
    // #7485 finding HIGH (fleet review): sem este log, um bypass por
    // mismatch de backend é indistinguível nos logs de "razão passou
    // normal" ou "1ª rodada, sem baseline" — visibilidade explícita mesmo
    // quando a rodada segue sem abortar.
    process.stderr.write(
      `[sync-cursos-subscribers-kv] AVISO: baseline é de outro backend (${previousState?.backend ?? "desconhecido"} → ${backend}) — guard de razão IGNORADO nesta rodada (só o piso absoluto de 0 continua valendo).\n`,
    );
  }

  // #4442 (era #4381 put→list→diff→delete): agora list→diff→put(só as
  // novas)→delete, nesta ordem fixa — ver docstring de `syncKvKeys`. O put só
  // recebe as chaves AUSENTES do KV (write-amplification de 551/dia pra ~3/dia
  // no caso comum); a garantia do #4381 (put antes de delete, put que lança
  // impede o delete) continua intacta.
  const { existingKeys, staleKeys, addedKeys } = syncKvKeys(entries, namespaceId, accountId);
  const skippedCount = entries.length - addedKeys.length;
  process.stderr.write(
    `[sync-cursos-subscribers-kv] KV atualizado: ${addedKeys.length} chaves gravadas (novas), ${skippedCount} puladas (sem mudança).\n`,
  );
  process.stderr.write(
    `[sync-cursos-subscribers-kv] ${existingKeys.length} chaves existentes, ${staleKeys.length} stale (cancelaram) a apagar.\n`,
  );
  if (staleKeys.length > 0) {
    process.stderr.write(`[sync-cursos-subscribers-kv] ${staleKeys.length} chaves stale apagadas.\n`);
  }

  if (!forceEmptyGuard) {
    writeKvSyncState(rootDir, { last_run_at: new Date().toISOString(), active_subscriber_count: emails.length, backend });
  } else {
    process.stderr.write("[sync-cursos-subscribers-kv] baseline NÃO atualizado (rodada só seguiu via --force-empty-guard).\n");
  }

  console.log(
    JSON.stringify({
      subscribers: emails.length,
      kv_entries: entries.length,
      added: addedKeys.length,
      skipped: skippedCount,
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
