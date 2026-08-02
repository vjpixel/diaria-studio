#!/usr/bin/env node
/**
 * scripts/sync-pending-to-brevo.ts (#4266, item 2a/3 do plano da issue;
 * fila de tamanho fixo + backfill adicionados no #4476 item 5)
 *
 * Triagem de SAÍDA (não envio duplicado aditivo — decisão do editor, sessão
 * /diaria-develop 260731, comentário 260731 da issue #4266): identifica
 * assinantes com status **Pending** na Beehiiv (assinaram, mas nunca
 * confirmaram o double opt-in — por definição NÃO recebem nada da Beehiiv) e
 * os adiciona à lista da conta Brevo PRÓPRIA do editor (`brevo_diaria` em
 * `platform.config.json`, distinta da conta da parceria Clarice), pra que
 * recebam a diária por esse canal alternativo enquanto continuam pendentes
 * na Beehiiv.
 *
 * ## Fila de tamanho fixo + backfill contínuo (#4476 item 5)
 *
 * SUBSTITUI o comportamento original (ingeria TODO `computeContactsToIngest`
 * de uma vez, sem cap): a fila de contatos `in_brevo` nunca excede o cap
 * free-tier da Brevo (300, `brevo_diaria.daily_send_cap`,
 * `computeAvailableSlots`). Cada rodada calcula quantos slots estão livres
 * (cap menos quem hoje ocupa um slot) e ingere só até esse número,
 * PRIORIZADO pelo score de origem (#4476 item 4, `selectContactsForBackfill`
 * + `loadOriginScores`, que lê `data/pending-reativacao/pending-scored-computed.csv`
 * gerado por `scripts/score-pending-origin.ts`). "Backfill CONTÍNUO" é uma
 * propriedade emergente de rodar este script periodicamente: quando
 * `evaluate-brevo-diaria.ts` promove/suprime/detecta descadastro nativo de
 * um contato (mudando seu status pra fora de `in_brevo`), a PRÓXIMA rodada
 * deste script vê mais slots livres e ingere o próximo da fila — nenhum
 * mecanismo adicional de "notificação de slot livre" é necessário.
 *
 * MillionVerifier (issue #4476 item 8) é DELIBERADAMENTE fora do escopo
 * deste backfill — a issue resolveu (260802) que a verificação roda em 1
 * passada em lote sobre os 627 contatos ANTES do primeiro envio, não uma
 * checagem por-backfill (ver checklist da issue #4476: "1 passada de
 * MillionVerifier em todos os 627... não por-backfill — item 8"). Este
 * script não verifica e-mail nenhum — assume que o pool já passou pela
 * verificação em lote (script separado, ainda não implementado) antes do
 * primeiro `--push` real.
 *
 * ## Dedup: pelo STORE, não pela Beehiiv (decisão de design)
 *
 * A issue original ("remove/marca da Beehiiv") deixava em aberto COMO
 * marcar. Investigação (#4266, achado 260730, replicado no #4273 Parte 2 pra
 * outro campo): a API pública da Beehiiv **ignora silenciosamente** escrita
 * de tag por assinante (`PATCH .../subscriptions/{id}` com `{tags:[...]}` →
 * 200, mas a releitura mostra `tags: []` — mesma armadilha documentada em
 * `scripts/sync-apoio-nivel-beehiiv.ts`). Um custom field funcionaria (mesmo
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
 * Como do PR #4398 (260731), `--push` ainda não foi rodado com efeito real
 * (guard de publicação — scripts que tocam Beehiiv/Brevo ao vivo não rodam a
 * partir de sessão autônoma). Validado só via testes com fetch mockado.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { hasMorePages } from "./sync-cursos-subscribers-kv.ts";
import { brevoPost, brevoGet } from "./lib/brevo-client.ts";
import { DEFAULT_OUTPUT_PATH as ORIGIN_SCORES_CSV_PATH } from "./score-pending-origin.ts";
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
  /** #4476 item 5 — cap free tier Brevo (300), reusado como teto da fila de
   * contatos ATIVOS (`in_brevo`), não só de envio diário — ver
   * `computeAvailableSlots`. */
  daily_send_cap?: number;
}
interface PlatformConfig {
  brevo_diaria?: BrevoDiariaConfig;
}

/** Fallback se `daily_send_cap` não estiver em `platform.config.json` (nunca
 * deveria faltar — já documentado lá desde #4266 — mas o campo é opcional no
 * tipo, então um fallback explícito é mais seguro que `undefined` silencioso
 * chegando em `computeAvailableSlots`). */
const DEFAULT_QUEUE_CAP = 300;

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
 * (mesma disciplina de `sync-apoio-nivel-beehiiv.ts::fetchCurrentBeehiivState`:
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
 * (por qualquer status: `in_brevo`/`promoted_beehiiv`/`suppressed`/
 * `unsubscribed` contam como "já tratado", nunca re-ingerido).
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

// ── fila de tamanho fixo + backfill (#4476 item 5) ──────────────────────────

/**
 * Pura — quantos slots estão livres na fila (cap free tier Brevo — 300,
 * reusa `brevo_diaria.daily_send_cap` de `platform.config.json`; o mesmo
 * valor já documentado ali como "cabe no free tier da Brevo" cobre tanto o
 * teto de ENVIO diário quanto o teto de CONTATOS ativos simultâneos — são
 * numericamente o mesmo limite no plano free da Brevo). `currentActiveCount`
 * é `store.contacts` com `status === "in_brevo"` (quem hoje ocupa um slot —
 * `promoted_beehiiv`/`suppressed`/`unsubscribed` já liberaram o deles).
 * Nunca negativo (população acima do cap por transição de config — ex: cap
 * reduzido depois do fato — não gera backfill negativo, só 0 slots livres).
 */
export function computeAvailableSlots(currentActiveCount: number, cap: number): number {
  return Math.max(0, cap - currentActiveCount);
}

/**
 * Pura — seleciona os próximos `availableSlots` candidatos a ingerir,
 * ORDENADOS pelo score de origem (#4476 item 4, maior primeiro). `scoreByEmail`
 * vem de `data/pending-reativacao/pending-scored-computed.csv`
 * (`scripts/score-pending-origin.ts`) — se `null` (arquivo ainda não gerado
 * nesta máquina), a seleção cai pra ordem original de chegada (paginação da
 * Beehiiv) — fail-soft: a fila ainda funciona sem o score, só sem
 * priorização até o arquivo existir. Candidato sem score individual
 * (email ausente do CSV, ex: cadastro novo que o CSV snapshot não capturou)
 * ordena por ÚLTIMO entre os que têm score (nunca na frente de um candidato
 * já pontuado — mais seguro assumir prioridade baixa que alta pra um dado
 * desconhecido).
 *
 * MillionVerifier (item 8 da issue #4476) é DELIBERADAMENTE fora do escopo
 * desta função — a issue resolveu (260802) que a verificação é 1 passada em
 * lote sobre os 627 ANTES do primeiro envio, não uma checagem por-backfill
 * (ver checklist da issue: "não por-backfill — item 8"). Esta seleção não
 * verifica e-mail nenhum; assume que o pool já passou pela verificação em
 * lote antes de qualquer backfill rodar.
 */
export function selectContactsForBackfill(
  candidates: PendingToIngestEntry[],
  availableSlots: number,
  scoreByEmail: Map<string, number> | null,
): PendingToIngestEntry[] {
  if (availableSlots <= 0) return [];
  const ordered = scoreByEmail
    ? [...candidates].sort((a, b) => {
        const sa = scoreByEmail.get(a.email);
        const sb = scoreByEmail.get(b.email);
        if (sa === undefined && sb === undefined) return 0;
        if (sa === undefined) return 1; // a sem score → depois de b
        if (sb === undefined) return -1; // b sem score → depois de a
        return sb - sa; // descendente
      })
    : candidates; // sem mapa de score — mantém a ordem original (FIFO da paginação Beehiiv)
  return ordered.slice(0, availableSlots);
}

/**
 * I/O — lê o CSV emitido por `scripts/score-pending-origin.ts`
 * (`email,score,...`) e devolve `email → score`. Fail-soft: arquivo
 * ausente/malformado → `null` (nunca lança) — a seleção cai pro fallback
 * FIFO documentado em `selectContactsForBackfill`. Score sozinho não é
 * suficiente pra bloquear o backfill: a priorização é um refinamento, não um
 * pré-requisito de funcionamento.
 */
export function loadOriginScores(path: string, log: (msg: string) => void = () => {}): Map<string, number> | null {
  if (!existsSync(path)) {
    log(`aviso: ${path} não encontrado — backfill sem priorização por score (ordem FIFO). Rode scripts/score-pending-origin.ts pra gerar.`);
    return null;
  }
  try {
    const csvText = readFileSync(path, "utf8");
    const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true });
    if (parsed.errors.length > 0) {
      log(`aviso: falha ao parsear ${path} — backfill sem priorização por score. Erros: ${JSON.stringify(parsed.errors.slice(0, 2))}`);
      return null;
    }
    const map = new Map<string, number>();
    for (const row of parsed.data) {
      const email = (row.email ?? "").trim().toLowerCase();
      const score = Number(row.score);
      if (email && !Number.isNaN(score)) map.set(email, score);
    }
    return map;
  } catch (e) {
    log(`aviso: erro lendo ${path} — backfill sem priorização por score: ${(e as Error).message}`);
    return null;
  }
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
  log(`${toIngest.length} contato(s) novo(s) elegível(is) (dedup pelo store — ${store.contacts.length} já tratado(s)).`);

  // #4476 item 5 — fila de tamanho fixo: só backfill até o cap, priorizado
  // pelo score de origem (item 4). Substitui o comportamento antigo de
  // ingerir TODO o `toIngest` de uma vez (ou abortar se > cap).
  const cap = brevoDiaria!.daily_send_cap ?? DEFAULT_QUEUE_CAP;
  const currentActiveCount = store.contacts.filter((c) => c.status === "in_brevo").length;
  const availableSlots = computeAvailableSlots(currentActiveCount, cap);
  log(`fila: ${currentActiveCount}/${cap} ocupados, ${availableSlots} slot(s) livre(s) pro backfill.`);

  const scoreByEmail = loadOriginScores(ORIGIN_SCORES_CSV_PATH, log);
  const selected = selectContactsForBackfill(toIngest, availableSlots, scoreByEmail);
  log(`${selected.length} contato(s) selecionado(s) pra este backfill (de ${toIngest.length} elegíveis, ordenados por score).`);

  if (!push) {
    for (const c of selected) log(`  + ${c.email} (sub ${c.beehiiv_subscription_id})`);
    log("dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.");
    return;
  }

  let nextStore = store;
  let applied = 0;
  let failed = 0;
  for (const c of selected) {
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
