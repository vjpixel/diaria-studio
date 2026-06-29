/**
 * clarice-engagement-cohorts.ts (#2426)
 *
 * Pré-computa a tabela de COORTES DE ENGAJAMENTO por contato da base Clarice
 * (Brevo) e grava o resultado no KV do worker `clarice-dashboard`. O dashboard
 * (workers/brevo-dashboard) só RENDERIZA o JSON cacheado — nunca faz os GETs
 * per-contato no render (custo proibitivo + rate-limit). Roda como script,
 * análogo ao fetch per-contato de `clarice-build-waves.ts`.
 *
 * As 5 coortes são MUTUAMENTE EXCLUSIVAS (cada contato em exatamente uma):
 *   - "saídas" (bounce OU descadastro) têm PRECEDÊNCIA: um contato que deu
 *     bounce ou descadastrou cai aqui, não importa se abriu algo (regra do
 *     editor 2026-06-19). As demais coortes são sobre contatos sem saída:
 *       opened2plus       — abriu 2+ e-mails
 *       opened1           — abriu exatamente 1 e-mail
 *       received1_opened0 — recebeu 1, não abriu nenhum
 *       received2_opened0 — recebeu 2+, não abriu nenhum
 *
 * Universo = contatos que receberam ≥1 e-mail OU tiveram saída (bounce/unsub).
 * "Recebeu" = messagesSent (entregue) per-contato.
 *
 * ESCOPO (default "emailed"): só contatos que JÁ RECEBERAM campanha — derivados da
 * origem (campanhas status=sent → recipients.lists → membros dessas listas). A base
 * importada (~40k) é muito maior que o enviado; contato received=0 sem saída nem
 * entra no universo, então buscá-lo seria GET desperdiçado. `--all` força o crawl da
 * conta inteira (fallback).
 *
 * ROBUSTEZ a rate-limit (Brevo ~100 req/min): CHECKPOINT incremental em
 * data/clarice-subscribers/cohorts/checkpoint.json — um run interrompido (rate-limit
 * sustentado após os retries do brevoGet) é RETOMADO sem re-gastar GETs. STATUS em
 * status.json (success|partial|failed + contagens + duração) e LOG append em run.log.
 *
 * O quirk de open agregado-zerado da Brevo não afeta este script: o evento
 * per-contato (`statistics.opened`) sobrevive — mesmo motivo do GET individual
 * em clarice-build-waves.ts.
 *
 * Env:
 *   BREVO_CLARICE_API_KEY     obrigatório (lê statistics per-contato)
 *   CLOUDFLARE_ACCOUNT_ID     obrigatório p/ upload KV
 *   CLOUDFLARE_WORKERS_TOKEN  obrigatório p/ upload KV (permissão Workers KV)
 *
 * Uso CLI:
 *   npx tsx scripts/clarice-engagement-cohorts.ts [--dry-run] [--all] [--fresh] [--concurrency N]
 *
 *   --dry-run     computa e imprime o JSON, mas NÃO grava no KV.
 *   --all         crawla a conta inteira (default: só quem já recebeu e-mail).
 *   --fresh       ignora checkpoint existente e recomeça do zero.
 *   --concurrency concorrência dos GETs per-contato (default 6 — bem abaixo de
 *                 100 reqs/min da Brevo).
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { brevoGet } from "./lib/brevo-client.ts"; // #2651: direto da lib (era via re-export do build-waves)
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { CLARICE_BASE } from "./lib/clarice-paths.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg } from "./lib/cli-args.ts";

loadProjectEnv();

/** Diretório de estado do crawl (checkpoint + status + log). data/ é gitignored. */
export const COHORTS_STATE_DIR = resolve(CLARICE_BASE, "cohorts");
export const CHECKPOINT_PATH = resolve(COHORTS_STATE_DIR, "checkpoint.json");
export const STATUS_PATH = resolve(COHORTS_STATE_DIR, "status.json");
export const LOG_PATH = resolve(COHORTS_STATE_DIR, "run.log");
/** Idade máxima (h) de um checkpoint para ser retomado; acima disso, recomeça do zero. */
export const MAX_RESUME_AGE_H = 18;
/** A cada N contatos buscados, persiste o checkpoint (resiliência a rate-limit). */
const CHECKPOINT_FLUSH_EVERY = 500;

/** Namespace KV do worker clarice-dashboard (workers/brevo-dashboard/wrangler.toml). */
export const DASHBOARD_KV_NAMESPACE_ID = "2f87d65d735c499ab8f465774d0167e2";
/** Chave KV lida pelo worker no render (`env.STATS_CACHE.get(COHORTS_KV_KEY, "json")`). */
export const COHORTS_KV_KEY = "cohorts:engagement";

/**
 * Sinal de engajamento normalizado de um contato — entrada pura de computeCohorts.
 * Desacoplado do shape da Brevo p/ ser trivialmente testável.
 */
export interface ContactEngagement {
  /** nº de campanhas entregues ao contato (statistics.messagesSent.length) */
  received: number;
  /**
   * nº de campanhas abertas pelo contato — aberturas reais (trackable) per-contato.
   * Corresponde a `statistics.opened` da Brevo, que ≈ `trackableViews` da campanha
   * (aproximado, não idêntico): EXCLUI MPP/machine (Apple Mail Privacy Protection).
   *
   * A Brevo não atribui MPP a contatos individuais — `appleMppOpens` existe só
   * como agregado de campanha, sem atribuição per-contato. `statistics.machineOpened`
   * não existe na API Brevo. Portanto este campo representa o sinal humano mais limpo
   * disponível por contato.
   */
  opened: number;
  /** teve hard ou soft bounce em alguma campanha */
  bounced: boolean;
  /** descadastrou / está suprimido (blacklist), excluindo suppressão por bounce */
  optedOut: boolean;
}

/**
 * Resultado das coortes — shape gravado no KV e lido pelo worker.
 * Mantido em sincronia com a interface homônima em
 * workers/brevo-dashboard/src/index.ts (bundles separados não compartilham tipos).
 */
export interface EngagementCohorts {
  /** ISO timestamp da geração (dado é pré-computado, não live) */
  generatedAt: string;
  /** total de pessoas únicas alcançadas (recebeu ≥1 OU teve saída) — cada contato conta 1× (≠ eventos de envio) */
  universe: number;
  /** abriu 2+ e-mails (sem saída) */
  opened2plus: number;
  /** abriu exatamente 1 e-mail (sem saída) */
  opened1: number;
  /** recebeu 1, não abriu nenhum (sem saída) */
  received1_opened0: number;
  /** recebeu 2+, não abriu nenhum (sem saída) */
  received2_opened0: number;
  /** saídas: bounce OU descadastro (precedência sobre tudo) */
  exits: number;
  /** breakdown DISJUNTO das saídas (bounced + optedOut = exits) */
  exitsBreakdown: { bounced: number; optedOut: number };
  /** maior nº de e-mails recebidos por um único contato (valida o rótulo "2+") */
  maxReceived: number;
}

/**
 * Classifica contatos em 5 coortes mutuamente exclusivas. Pura (testável).
 *
 * Precedência: saída (bounce/unsub) > abriu 2+ > abriu 1 > (não abriu: recebeu 1
 * | recebeu 2+). Contatos fora do universo (received=0 e sem saída) são ignorados.
 */
export function computeCohorts(
  contacts: ContactEngagement[],
  generatedAt: string,
): EngagementCohorts {
  const r: EngagementCohorts = {
    generatedAt,
    universe: 0,
    opened2plus: 0,
    opened1: 0,
    received1_opened0: 0,
    received2_opened0: 0,
    exits: 0,
    exitsBreakdown: { bounced: 0, optedOut: 0 },
    maxReceived: 0,
  };

  for (const c of contacts) {
    const isExit = c.bounced || c.optedOut;
    // Fora do universo: nunca recebeu, nunca abriu e não teve saída → não conta.
    // (opened>0 com received=0 é anomalia rara da Brevo — open de e-mail
    // encaminhado / campanha deletada do histórico. Contamos o engajamento em
    // vez de descartar silenciosamente.)
    if (c.received <= 0 && c.opened <= 0 && !isExit) continue;
    r.universe++;
    if (c.received > r.maxReceived) r.maxReceived = c.received;

    // Precedência absoluta da saída (regra do editor 2026-06-19).
    if (isExit) {
      r.exits++;
      // Breakdown disjunto: bounce tem prioridade sobre optedOut p/ somar exato.
      if (c.bounced) r.exitsBreakdown.bounced++;
      else r.exitsBreakdown.optedOut++;
      continue;
    }

    if (c.opened >= 2) r.opened2plus++;
    else if (c.opened === 1) r.opened1++;
    else if (c.received === 1) r.received1_opened0++;
    else r.received2_opened0++; // received >= 2, opened 0
  }

  return r;
}

// ─── Normalização do shape Brevo → ContactEngagement ─────────────────────────

/** Conta entradas de um campo de statistics que pode ser array ou ausente. */
function len(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/**
 * Detecta descadastro a partir do statistics.unsubscriptions da Brevo, que é um
 * OBJETO `{ userUnsubscription: [...], adminUnsubscription: [...] }` (não array).
 */
function hasUnsub(stats: any): boolean {
  const u = stats?.unsubscriptions;
  if (!u) return false;
  return len(u.userUnsubscription) > 0 || len(u.adminUnsubscription) > 0;
}

/**
 * Converte o contato bruto da Brevo (list + statistics) em ContactEngagement.
 * `bounced` tem prioridade no breakdown: optedOut só conta blacklist/unsub que
 * NÃO seja consequência de bounce já contabilizado.
 *
 * `opened` = statistics.opened per-contato (≈ trackableViews da campanha).
 * A Brevo NÃO atribui MPP a contatos individuais: `appleMppOpens` é só agregado
 * de campanha, e `statistics.machineOpened` não existe na API Brevo — qualquer
 * referência a esse campo é no-op (len([]) = 0). Portanto `opened` representa
 * aberturas reais (EXCLUI MPP/proxy Apple), que é o sinal humano mais limpo
 * disponível por contato. (#2446 — campo machineOpened removido do cálculo.)
 */
export function normalizeContact(raw: {
  emailBlacklisted?: boolean;
  statistics?: any;
}): ContactEngagement {
  const stats = raw.statistics ?? {};
  const bounced = len(stats.hardBounces) > 0 || len(stats.softBounces) > 0;
  // optedOut: descadastro explícito OU blacklist (suppressão), exceto quando já é
  // bounce (que tem prioridade no breakdown disjunto).
  const optedOut = !bounced && (hasUnsub(stats) || raw.emailBlacklisted === true);
  return {
    received: len(stats.messagesSent),
    // opened = aberturas reais per-contato (statistics.opened ≈ trackableViews).
    // EXCLUI MPP: a Brevo não atribui MPP a contatos individuais. (#2446)
    opened: len(stats.opened),
    bounced,
    optedOut,
  };
}

// ─── Escopo do crawl: só contatos que JÁ RECEBERAM e-mail ────────────────────
//
// A base importada na Brevo (~40k) é muito maior do que quem de fato recebeu
// campanha. Contato com received=0 e sem saída nem entra no universo das coortes
// (computeCohorts o ignora) — buscar o status dele é GET desperdiçado e pressão de
// rate-limit à toa. Em vez de paginar TODA a conta, derivamos o conjunto da
// ORIGEM: campanhas enviadas → recipients.lists → membros ATUAIS dessas listas.
// É uma APROXIMAÇÃO de "quem já recebeu e-mail" (não exata), com 2 vieses sabidos,
// ambos sem afetar a corretude das contagens:
//   - over-include: contato adicionado a uma lista DEPOIS do envio entra no crawl,
//     mas tem received=0 → computeCohorts o descarta. Só custa GET.
//   - DEPENDÊNCIA p/ a coorte de Saídas: assume que a Brevo MANTÉM contatos com
//     bounce/descadastro como membros da lista (só seta emailBlacklisted), em vez
//     de removê-los. Validado empiricamente nesta conta (2026-06-19: 211 saídas —
//     103 bounce + 108 optedOut — apareceram na membership; total ≈ cumulativo
//     enviado). SE a Brevo passar a auto-remover bounces das listas, a coorte de
//     Saídas subcontaria → use `--all` (crawl da conta inteira) para reconciliar.
// `--all` é também o fallback geral.

export interface ContactRef {
  id: number;
  blacklisted: boolean;
}

/**
 * Pool de concorrência limitada com ABORT no primeiro erro (#2426 review): ao
 * primeiro throw, marca `aborted` e os demais workers param após o await em
 * curso — sem isso, um rate-limit sustentado num worker deixava os outros 5
 * martelando a Brevo (mais 429) e mutando `done` após o catch já ter salvo o
 * snapshot. A rejeição do Promise.all propaga o erro original.
 */
async function pool<T>(items: T[], n: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  let aborted = false;
  const run = async (): Promise<void> => {
    while (i < items.length && !aborted) {
      const item = items[i++];
      try {
        await worker(item);
      } catch (e) {
        aborted = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, run));
}

/** União dos list IDs de todas as campanhas enviadas (status=sent). */
async function fetchSentListIds(apiKey: string): Promise<number[]> {
  const set = new Set<number>();
  let offset = 0;
  for (;;) {
    const { status, body } = await brevoGet(
      apiKey,
      `/emailCampaigns?status=sent&limit=100&offset=${offset}&sort=desc`,
    );
    // brevoGet coage QUALQUER 404 para {status:404, body:{}} — incluindo escopo/
    // validade da API key. Falha alto em vez de truncar silenciosamente (#2426 review).
    if (status === 404) {
      throw new Error(
        "Brevo /emailCampaigns retornou 404 — abortando (verifique escopo/validade da BREVO_CLARICE_API_KEY).",
      );
    }
    const cs: any[] = body?.campaigns ?? [];
    for (const c of cs) for (const l of c?.recipients?.lists ?? []) set.add(l);
    if (cs.length < 100) break;
    offset += 100;
  }
  return [...set];
}

/** Membros (id + emailBlacklisted) das listas dadas, dedup por id. */
async function fetchListMembers(apiKey: string, listIds: number[]): Promise<Map<number, ContactRef>> {
  const map = new Map<number, ContactRef>();
  for (const listId of listIds) {
    let offset = 0;
    for (;;) {
      const { status, body } = await brevoGet(
        apiKey,
        `/contacts/lists/${listId}/contacts?limit=500&offset=${offset}`,
      );
      if (status === 404) break; // lista apagada — pula
      const cs: any[] = body?.contacts ?? [];
      for (const c of cs) {
        // OR-merge do blacklist: 2 listas podem trazer o mesmo contato.
        const prev = map.get(c.id);
        map.set(c.id, { id: c.id, blacklisted: !!c.emailBlacklisted || !!prev?.blacklisted });
      }
      if (cs.length < 500) break;
      offset += 500;
    }
  }
  return map;
}

/** Conjunto "já recebeu e-mail" = membros das listas que receberam campanha. */
async function fetchEmailedContactIds(apiKey: string): Promise<ContactRef[]> {
  const listIds = await fetchSentListIds(apiKey);
  if (listIds.length === 0) {
    throw new Error(
      "Nenhuma campanha enviada encontrada (status=sent) — abortando para não " +
        "sobrescrever o KV com zeros (verifique escopo/validade da BREVO_CLARICE_API_KEY).",
    );
  }
  const members = await fetchListMembers(apiKey, listIds);
  const refs = [...members.values()];
  if (refs.length === 0) {
    throw new Error(
      `Listas enviadas (${listIds.length}) sem membros — abortando para não sobrescrever o KV com zeros.`,
    );
  }
  return refs;
}

/** Pagina TODOS os contatos da conta (fallback --all). */
async function fetchAllContactIds(apiKey: string): Promise<ContactRef[]> {
  const base: ContactRef[] = [];
  let offset = 0;
  for (;;) {
    const { body } = await brevoGet(apiKey, `/contacts?limit=500&offset=${offset}`);
    const cs: any[] = body?.contacts ?? [];
    for (const c of cs) base.push({ id: c.id, blacklisted: !!c.emailBlacklisted });
    if (cs.length < 500) break;
    offset += 500;
  }
  if (base.length === 0) {
    throw new Error(
      "Brevo /contacts retornou 0 contatos — abortando para não sobrescrever o KV com zeros.",
    );
  }
  return base;
}

// ─── Checkpoint + status + logs ──────────────────────────────────────────────

export interface Checkpoint {
  startedAt: string;
  scope: "emailed" | "all";
  refs: ContactRef[];
  /** id → engajamento já buscado (resiliência a rate-limit; resume pula estes). */
  done: Record<string, ContactEngagement>;
}

/** IDs ainda não buscados (puro — testável). */
export function remainingRefs(refs: ContactRef[], done: Record<string, ContactEngagement>): ContactRef[] {
  return refs.filter((r) => done[String(r.id)] === undefined);
}

/** Decide se um checkpoint pode ser retomado (puro — testável). */
export function shouldResume(
  cp: Checkpoint | null,
  nowMs: number,
  scope: "emailed" | "all",
  maxAgeH = MAX_RESUME_AGE_H,
): boolean {
  if (!cp || cp.scope !== scope) return false;
  const started = Date.parse(cp.startedAt);
  if (isNaN(started)) return false;
  const ageH = (nowMs - started) / 3_600_000;
  return ageH >= 0 && ageH < maxAgeH;
}

function ensureStateDir(): void {
  if (!existsSync(COHORTS_STATE_DIR)) mkdirSync(COHORTS_STATE_DIR, { recursive: true });
}

function logLine(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  console.error(line);
  try {
    ensureStateDir();
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    /* log nunca bloqueia o crawl */
  }
}

function loadCheckpoint(): Checkpoint | null {
  try {
    if (!existsSync(CHECKPOINT_PATH)) return null;
    return JSON.parse(readFileSync(CHECKPOINT_PATH, "utf8")) as Checkpoint;
  } catch {
    return null; // checkpoint corrompido → recomeça do zero
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  ensureStateDir();
  writeFileAtomic(CHECKPOINT_PATH, JSON.stringify(cp), { fsync: false });
}

function clearCheckpoint(): void {
  try {
    // unlink (não escrever "") — um arquivo de 0 bytes parece checkpoint pendente
    // a inspeção manual; remover deixa o estado inequívoco (#2426 review).
    if (existsSync(CHECKPOINT_PATH)) unlinkSync(CHECKPOINT_PATH);
  } catch {
    /* não-fatal */
  }
}

export interface RunStatus {
  status: "success" | "partial" | "failed";
  finishedAt: string;
  scope: "emailed" | "all";
  total: number;
  fetched: number;
  universe?: number;
  durationMs: number;
  error?: string;
}

function writeStatus(s: RunStatus): void {
  try {
    ensureStateDir();
    writeFileAtomic(STATUS_PATH, JSON.stringify(s, null, 2), { fsync: false });
  } catch {
    /* não-fatal */
  }
}

/**
 * Busca o engajamento per-contato (só de quem recebeu, por default) com
 * checkpoint incremental — um run rate-limitado pode ser retomado sem re-gastar.
 * Em falha (ex: rate-limit sustentado após os retries do brevoGet), persiste o
 * checkpoint e re-lança; o próximo run continua de onde parou.
 */
export async function buildCohorts(
  apiKey: string,
  concurrency: number,
  generatedAt: string,
  opts: { scope?: "emailed" | "all"; fresh?: boolean; nowMs?: number } = {},
): Promise<EngagementCohorts> {
  const scope = opts.scope ?? "emailed";
  const nowMs = opts.nowMs ?? Date.now();

  // Resume de checkpoint recente do mesmo escopo, salvo --fresh.
  let cp = opts.fresh ? null : loadCheckpoint();
  if (!shouldResume(cp, nowMs, scope)) cp = null;

  let refs: ContactRef[];
  const done: Record<string, ContactEngagement> = cp?.done ?? {};
  if (cp) {
    refs = cp.refs;
    logLine(`▶️  Retomando checkpoint (${Object.keys(done).length}/${refs.length} já buscados, escopo ${scope}).`);
  } else {
    logLine(`🔎 Resolvendo conjunto (escopo: ${scope})…`);
    refs = scope === "all" ? await fetchAllContactIds(apiKey) : await fetchEmailedContactIds(apiKey);
    cp = { startedAt: new Date(nowMs).toISOString(), scope, refs, done };
    saveCheckpoint(cp);
    logLine(`📇 ${refs.length} contatos ${scope === "all" ? "na conta" : "que já receberam e-mail"} — buscando statistics per-id…`);
  }

  const todo = remainingRefs(refs, done);
  let since = 0;
  try {
    await pool(todo, concurrency, async (c) => {
      const { status, body } = await brevoGet(apiKey, `/contacts/${c.id}`);
      if (status !== 404) {
        // Blacklist fresca: GET per-contato é mais novo que o snapshot da lista.
        done[String(c.id)] = normalizeContact({
          emailBlacklisted: c.blacklisted || body?.emailBlacklisted === true,
          statistics: body?.statistics,
        });
      } else {
        // contato sumiu entre listar e buscar — marca como vazio p/ não re-tentar no resume
        done[String(c.id)] = { received: 0, opened: 0, bounced: false, optedOut: false };
      }
      const n = Object.keys(done).length;
      if (++since >= CHECKPOINT_FLUSH_EVERY) {
        since = 0;
        saveCheckpoint(cp!);
        logLine(`  …${n}/${refs.length}`);
      }
    });
  } catch (e) {
    saveCheckpoint(cp!); // preserva progresso p/ o próximo run retomar
    logLine(`⛔ crawl interrompido (${Object.keys(done).length}/${refs.length}): ${(e as Error).message}`);
    throw e;
  }

  saveCheckpoint(cp!);
  return computeCohorts(Object.values(done), generatedAt);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const fresh = hasFlag(argv, "fresh");
  const scope: "emailed" | "all" = hasFlag(argv, "all") ? "all" : "emailed";
  const concurrency = Number(getArg(argv, "concurrency") || "6") || 6;

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida (veja .env.example).");
    process.exit(1);
  }

  // Fail-fast: validar creds CF ANTES do crawl per-contato. Sem isso, a falta de
  // credencial só seria detectada depois de gastar quota da Brevo. --dry-run não grava.
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_WORKERS_TOKEN;
  if (!dryRun && (!accountId || !token)) {
    console.error(
      "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_WORKERS_TOKEN não definidos — necessários " +
        "para gravar no KV. Configure as credenciais (ou rode com --dry-run) antes do crawl.",
    );
    process.exit(1);
  }

  const startMs = Date.now();
  const generatedAt = new Date(startMs).toISOString();
  logLine(`🚀 Crawl de coortes iniciado (escopo: ${scope}, concorrência ${concurrency}${fresh ? ", --fresh" : ""}${dryRun ? ", --dry-run" : ""}).`);

  let cohorts: EngagementCohorts;
  try {
    cohorts = await buildCohorts(apiKey, concurrency, generatedAt, { scope, fresh });
  } catch (e) {
    // Falha (ex: rate-limit sustentado) — checkpoint já foi persistido por buildCohorts.
    // Lê o checkpoint p/ reportar progresso REAL (#2426 review: total:0/fetched:0
    // mascarava milhares de GETs já feitos e salvos).
    const cp = loadCheckpoint();
    writeStatus({
      status: "partial",
      finishedAt: new Date().toISOString(),
      scope,
      total: cp?.refs.length ?? 0,
      fetched: cp ? Object.keys(cp.done).length : 0,
      durationMs: Date.now() - startMs,
      error: e instanceof Error ? e.message : String(e),
    });
    // #2440: incluir mensagem de erro no logLine para que a causa raiz apareça
    // nos logs capturados pela Task agendada (run.log/task.log), não apenas no status.json.
    const errMsg = e instanceof Error ? e.message : String(e);
    logLine(`❌ Falhou — ${errMsg} — checkpoint preservado (${cp ? Object.keys(cp.done).length : 0}/${cp?.refs.length ?? 0}), re-rode para retomar.`);
    process.exit(1);
  }

  console.error(`\n✅ Coortes (universo ${cohorts.universe}, maxRecebido ${cohorts.maxReceived}):`);
  console.log(JSON.stringify(cohorts, null, 2));

  if (dryRun) {
    logLine("(--dry-run) KV não atualizado.");
    return;
  }

  // Anti-clobber: nunca sobrescrever o snapshot bom do KV com zeros.
  if (cohorts.universe === 0) {
    writeStatus({
      status: "failed",
      finishedAt: new Date().toISOString(),
      scope,
      total: cohorts.universe,
      fetched: cohorts.universe,
      universe: cohorts.universe,
      durationMs: Date.now() - startMs,
      error: "universe 0 — upload abortado",
    });
    // Limpa o checkpoint (#2426 review): senão um run all-404/zero deixaria um
    // checkpoint "completo" (remainingRefs=[]) que todo run subsequente <18h
    // retomaria → recomputa universe=0 → exit(1) de novo, preso até --fresh.
    clearCheckpoint();
    logLine("⚠️  Universo 0 — não gravando no KV (checkpoint limpo; evita sobrescrever dado bom com zeros).");
    process.exit(1);
  }

  await uploadTextToWorkerKV(JSON.stringify(cohorts), COHORTS_KV_KEY, {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
    accountId,
    token,
    contentType: "application/json",
  });
  logLine(`📤 KV atualizado: ${COHORTS_KV_KEY} (namespace ${DASHBOARD_KV_NAMESPACE_ID}).`);

  // Sucesso: status + limpa checkpoint (próximo run começa fresco).
  writeStatus({
    status: "success",
    finishedAt: new Date().toISOString(),
    scope,
    total: cohorts.universe,
    fetched: cohorts.universe,
    universe: cohorts.universe,
    durationMs: Date.now() - startMs,
  });
  clearCheckpoint();
  logLine(`🏁 Concluído em ${Math.round((Date.now() - startMs) / 1000)}s.`);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
