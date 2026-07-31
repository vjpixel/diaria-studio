#!/usr/bin/env node
/**
 * scripts/sync-pending-to-brevo.ts (#4266, item 2a/3 do plano da issue)
 *
 * Triagem de SAÍDA (não envio duplicado aditivo — decisão do editor, sessão
 * /diaria-develop 260731, ver comentário mais recente da issue): identifica
 * assinantes com status **Pending** na Beehiiv (assinaram, mas nunca
 * confirmaram o double opt-in — por definição NÃO recebem nada da Beehiiv) e
 * os adiciona à lista da conta Brevo PRÓPRIA do editor (`brevo_diaria` em
 * `platform.config.json`, distinta da conta da parceria Clarice), pra que
 * recebam a diária por esse canal alternativo enquanto continuam pendentes
 * na Beehiiv.
 *
 * ## Dedup: pelo STORE, não pela Beehiiv (decisão de design)
 *
 * A issue original ("remove/marca da Beehiiv") deixava em aberto COMO
 * marcar. Investigação (#4266, achado 260730, replicado no #4273 Parte 2 pra
 * outro campo): a API pública da Beehiiv **ignora silenciosamente** escrita
 * de tag por assinante (`PATCH .../subscriptions/{id}` com `{tags:[...]}` →
 * 200, mas a releitura mostra `tags: []` — mesma armadilha documentada em
 * `scripts/sync-apoio-tags-beehiiv.ts`). Um custom field funcionaria (mesmo
 * padrão daquele script), mas exigiria o editor criar o campo manualmente na
 * publicação ANTES desta unidade poder rodar — bloqueio externo desnecessário
 * quando o dedup pode viver inteiramente do lado de cá: `brevo-diaria-store.ts`
 * já é a fonte de verdade de "quem já foi triado" (idempotente por email,
 * `upsertIngested` nunca duplica). A Beehiiv nunca é escrita por este script —
 * só lida. Consequência aceita: um Pending nunca ingerido por este script,
 * mas que já apareceu numa rodada, não fica marcado NA Beehiiv como "já
 * tratado" — só no store local. Isso é suficiente porque este script SEMPRE
 * roda contra o store (nunca re-varre "quem ainda não tem tag") e o store
 * vive em `data/` (mesmo mecanismo de persistência de todo o resto do
 * pipeline Clarice/Brevo).
 *
 * ## Risco de duplicidade (registrado na própria issue, não eliminado aqui)
 *
 * Um contato Pending pode confirmar o double opt-in da Beehiiv por conta
 * própria DEPOIS de já ter sido ingerido aqui — ficaria recebendo dos dois
 * canais. Este script não fecha esse gap (é read-then-create, roda 1x por
 * contato); `scripts/evaluate-brevo-diaria.ts` fecha o gap na ELE, checando
 * o status Beehiiv atual de cada contato `in_brevo` a cada rodada de
 * avaliação (ver `applySelfConfirmed` em `brevo-diaria-store.ts`).
 *
 * ## Uso
 *
 *   npx tsx scripts/sync-pending-to-brevo.ts              # dry-run (default)
 *   npx tsx scripts/sync-pending-to-brevo.ts --push        # aplica (cria contatos na Brevo)
 *
 * Env: BEEHIIV_API_KEY (leitura) + platform.config.json → brevo_diaria.api_key_env (escrita).
 *
 * **NUNCA executado com --push nesta sessão** (guard de publicação — scripts
 * que tocam Beehiiv/Brevo ao vivo não rodam a partir de sessão autônoma).
 * Validado só via testes com fetch mockado.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { hasMorePages } from "./sync-cursos-subscribers-kv.ts";
import { brevoPost, brevoGet } from "./lib/brevo-client.ts";
import {
  readStore,
  writeStore,
  upsertIngested,
  normalizeEmail,
  DEFAULT_STORE_PATH,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RATE_LIMIT_DELAY_MS = 300;
const PER_PAGE = 100;

interface BrevoDiariaConfig {
  api_key_env: string;
  list_id: number | null;
}
interface PlatformConfig {
  brevo_diaria?: BrevoDiariaConfig;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── leitura da Beehiiv (status=pending) ─────────────────────────────────────

export interface BeehiivPendingSubscription {
  id: string;
  email: string;
}

interface BeehiivSubscriptionApi {
  id: string;
  email: string;
}
interface Page<T> {
  data?: T[];
  total_results?: number;
  limit?: number;
}

async function beehiivFetch<T>(
  path: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  retries = 0,
): Promise<{ ok: boolean; status: number; body: T | null }> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetchImpl(`${beehiivApiBase()}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (res.status === 429 && retries < 5) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    await sleep(Math.max(retryAfter * 1000, 30_000));
    return beehiivFetch<T>(path, apiKey, fetchImpl, retries + 1);
  }
  if (!res.ok) return { ok: false, status: res.status, body: null };
  const text = await res.text();
  return { ok: true, status: res.status, body: text ? (JSON.parse(text) as T) : null };
}

/**
 * Pagina `GET /subscriptions?status=pending` — falha ALTO em qualquer !ok
 * (mesma disciplina de `sync-apoio-tags-beehiiv.ts::fetchCurrentBeehiivState`:
 * este é o recurso PRINCIPAL do script, uma leitura truncada geraria
 * ingestão incompleta silenciosa). Reconciliação anti-truncamento via
 * `total_results`, mesmo padrão.
 */
export async function fetchPendingBeehiivSubscriptions(
  publicationId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BeehiivPendingSubscription[]> {
  const out: BeehiivPendingSubscription[] = [];
  let page = 1;
  let more = true;
  let totalResults: number | null = null;
  while (more) {
    const res = await beehiivFetch<Page<BeehiivSubscriptionApi>>(
      `/publications/${publicationId}/subscriptions?status=pending&per_page=${PER_PAGE}&page=${page}`,
      apiKey,
      fetchImpl,
    );
    if (!res.ok) {
      throw new Error(`Beehiiv API ${res.status} em /subscriptions?status=pending (página ${page})`);
    }
    const body = res.body!;
    const got = body.data ?? [];
    for (const s of got) out.push({ id: s.id, email: normalizeEmail(s.email) });
    if (body.total_results != null) totalResults = body.total_results;
    more = hasMorePages({
      collected: out.length,
      gotLength: got.length,
      totalResults: body.total_results,
      effectiveLimit: body.limit,
      requestedPerPage: PER_PAGE,
    });
    page++;
  }
  if (totalResults != null && totalResults > 0 && out.length < totalResults) {
    throw new Error(
      `paginação de /subscriptions?status=pending terminou cedo: coletado ${out.length} de ${totalResults} — ` +
        "leitura truncada nunca alimenta a ingestão.",
    );
  }
  return out;
}

// ── diff puro (desejado × store) ────────────────────────────────────────────

export interface PendingToIngestEntry {
  email: string;
  beehiiv_subscription_id: string;
}

/**
 * Pura — quem entre os Pending atuais da Beehiiv AINDA não está no store
 * (por qualquer status: `in_brevo`/`promoted_beehiiv`/`suppressed` contam
 * como "já tratado", nunca re-ingerido).
 */
export function computeContactsToIngest(
  pending: BeehiivPendingSubscription[],
  store: BrevoDiariaStore,
): PendingToIngestEntry[] {
  const known = new Set(store.contacts.map((c) => c.email));
  const out: PendingToIngestEntry[] = [];
  const seen = new Set<string>();
  for (const p of pending) {
    if (known.has(p.email) || seen.has(p.email)) continue;
    seen.add(p.email);
    out.push({ email: p.email, beehiiv_subscription_id: p.id });
  }
  return out;
}

// ── aplicação (I/O — cria contato na Brevo + verifica por releitura) ───────

/**
 * Cria (ou atualiza — `updateEnabled: true`) o contato na lista Brevo
 * `brevo_diaria.list_id` e confirma por RELEITURA (mesma disciplina de
 * `applyApoioTagEntry` — nunca confiar só no 2xx do POST).
 */
export async function ingestContactToBrevo(
  apiKey: string,
  listId: number,
  email: string,
): Promise<void> {
  await brevoPost(apiKey, "/contacts", { email, listIds: [listId], updateEnabled: true });
  const check = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
  if (check.status !== 200) {
    throw new Error(`releitura pós-criação falhou pra ${email} (HTTP ${check.status}) — mutação não confirmada.`);
  }
  const listIds: unknown = check.body?.listIds;
  if (!Array.isArray(listIds) || !listIds.includes(listId)) {
    throw new Error(
      `releitura pós-criação NÃO confere pra ${email}: listIds=${JSON.stringify(listIds)}, esperado incluir ${listId}.`,
    );
  }
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const log = (msg: string) => process.stderr.write(`[sync-pending-to-brevo] ${msg}\n`);

  const platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as PlatformConfig;
  const brevoDiaria = platformConfig.brevo_diaria;
  if (!brevoDiaria) {
    log("ERRO: brevo_diaria não configurado em platform.config.json.");
    process.exit(2);
  }
  if (brevoDiaria!.list_id == null) {
    log("ERRO: brevo_diaria.list_id não definido em platform.config.json.");
    process.exit(2);
  }

  const { apiKey: beehiivApiKey, publicationId } = loadBeehiivConfig("[sync-pending-to-brevo]");

  const brevoApiKey = process.env[brevoDiaria!.api_key_env];
  if (push && !brevoApiKey) {
    log(`ERRO: ${brevoDiaria!.api_key_env} não definido no ambiente (necessário pra --push).`);
    process.exit(2);
  }

  log("buscando assinantes Pending na Beehiiv…");
  const pending = await fetchPendingBeehiivSubscriptions(publicationId, beehiivApiKey);
  log(`${pending.length} assinante(s) Pending encontrado(s).`);

  const store = readStore(DEFAULT_STORE_PATH);
  const toIngest = computeContactsToIngest(pending, store);
  log(`${toIngest.length} contato(s) novo(s) a ingerir (dedup pelo store — ${store.contacts.length} já tratado(s)).`);

  if (!push) {
    for (const c of toIngest) log(`  + ${c.email} (sub ${c.beehiiv_subscription_id})`);
    log("dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.");
    return;
  }

  let nextStore = store;
  let applied = 0;
  let failed = 0;
  for (const c of toIngest) {
    try {
      await ingestContactToBrevo(brevoApiKey!, brevoDiaria!.list_id as number, c.email);
      nextStore = upsertIngested(nextStore, c);
      applied++;
    } catch (e) {
      failed++;
      log(`FALHA em ${c.email}: ${(e as Error).message}`);
    }
  }
  writeStore(nextStore, DEFAULT_STORE_PATH);
  log(`push concluído: ${applied} ingerido(s), ${failed} falha(s).`);
  if (failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sync-pending-to-brevo] erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
