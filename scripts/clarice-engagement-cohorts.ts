/**
 * clarice-engagement-cohorts.ts (#2426)
 *
 * Pré-computa a tabela de COORTES DE ENGAJAMENTO por contato da base Clarice
 * (Brevo) e grava o resultado no KV do worker `clarice-dashboard`. O dashboard
 * (workers/brevo-dashboard) só RENDERIZA o JSON cacheado — nunca faz os ~40k
 * GETs per-contato no render (custo proibitivo + rate-limit). Roda como script,
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
 * "Recebeu" = messagesSent (entregue) per-contato. Escopo = toda a conta Brevo
 * da Clarice (todas as campanhas/edições), que é o que o `statistics` per-contato
 * agrega nativamente.
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
 *   npx tsx scripts/clarice-engagement-cohorts.ts [--dry-run] [--concurrency N]
 *
 *   --dry-run     computa e imprime o JSON, mas NÃO grava no KV.
 *   --concurrency concorrência dos GETs per-contato (default 6, igual ao
 *                 clarice-build-waves — bem abaixo de 100 reqs/min da Brevo).
 */

import { brevoGet } from "./clarice-build-waves.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg } from "./lib/cli-args.ts";

loadProjectEnv();

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
  /** nº de campanhas abertas pelo contato (statistics.opened.length) */
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
  /** total de contatos no universo (recebeu ≥1 OU teve saída) */
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
    opened: len(stats.opened),
    bounced,
    optedOut,
  };
}

// ─── Fetch da Brevo (paginação + per-id) ─────────────────────────────────────

/** Pool de concorrência limitada (idêntico em forma ao de clarice-build-waves). */
async function pool<T>(items: T[], n: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const run = async (): Promise<void> => {
    while (i < items.length) await worker(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, run));
}

/** Pagina TODOS os contatos da conta → id + emailBlacklisted. */
async function fetchAllContactIds(
  apiKey: string,
): Promise<{ id: number; blacklisted: boolean }[]> {
  const base: { id: number; blacklisted: boolean }[] = [];
  let offset = 0;
  for (;;) {
    const { body } = await brevoGet(apiKey, `/contacts?limit=500&offset=${offset}`);
    const cs: any[] = body?.contacts ?? [];
    for (const c of cs) base.push({ id: c.id, blacklisted: !!c.emailBlacklisted });
    if (cs.length < 500) break;
    offset += 500;
  }
  // Anti-clobber (#2426 review): brevoGet devolve {status:404, body:{}} pra QUALQUER
  // 404 — inclusive escopo/validade da API key surfaceando como 404 no /contacts.
  // Sem este guard, 0 contatos → universo 0 → upload sobrescreveria o snapshot bom
  // do KV com zeros e o dashboard renderizaria tabela zerada sem erro. Falha alto.
  if (base.length === 0) {
    throw new Error(
      "Brevo /contacts retornou 0 contatos — abortando para não sobrescrever o KV " +
        "com zeros (verifique escopo/validade da BREVO_CLARICE_API_KEY).",
    );
  }
  return base;
}

/**
 * Busca o engajamento per-contato da conta Brevo inteira e computa as coortes.
 * Exportada p/ permitir um runner alternativo; o CLI abaixo é o caminho normal.
 */
export async function buildCohorts(
  apiKey: string,
  concurrency: number,
  generatedAt: string,
): Promise<EngagementCohorts> {
  const ids = await fetchAllContactIds(apiKey);
  console.error(`📇 Brevo: ${ids.length} contatos — buscando statistics per-id…`);

  const engagements: ContactEngagement[] = [];
  let done = 0;
  await pool(ids, concurrency, async (c) => {
    const { status, body } = await brevoGet(apiKey, `/contacts/${c.id}`);
    if (status === 404) return; // contato sumiu entre listar e buscar — não-fatal
    // Blacklist fresca (#2426 review): o GET per-contato traz emailBlacklisted
    // atualizado; o snapshot da paginação (c.blacklisted) pode estar horas velho.
    // OR-merge é conservador — se qualquer fonte diz blacklisted, vale.
    engagements.push(
      normalizeContact({
        emailBlacklisted: c.blacklisted || body?.emailBlacklisted === true,
        statistics: body?.statistics,
      }),
    );
    if (++done % 500 === 0) console.error(`  …${done}/${ids.length}`);
  });

  return computeCohorts(engagements, generatedAt);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const concurrency = Number(getArg(argv, "concurrency") || "6") || 6;

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida (veja .env.example).");
    process.exit(1);
  }

  // Fail-fast (#2426 review): validar creds CF ANTES do crawl per-contato (~40k
  // GETs, dezenas de minutos). Sem isso, a falta de credencial só seria detectada
  // depois de gastar toda a quota da Brevo. --dry-run não grava, então não exige.
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_WORKERS_TOKEN;
  if (!dryRun && (!accountId || !token)) {
    console.error(
      "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_WORKERS_TOKEN não definidos — necessários " +
        "para gravar no KV. Configure as credenciais (ou rode com --dry-run) antes do crawl.",
    );
    process.exit(1);
  }

  const generatedAt = new Date().toISOString();
  const cohorts = await buildCohorts(apiKey, concurrency, generatedAt);

  console.error(
    `\n✅ Coortes (universo ${cohorts.universe}, maxRecebido ${cohorts.maxReceived}):`,
  );
  console.log(JSON.stringify(cohorts, null, 2));

  if (dryRun) {
    console.error("\n(--dry-run) KV não atualizado.");
    return;
  }

  // Anti-clobber (#2426 review): nunca sobrescrever o snapshot bom do KV com zeros.
  // fetchAllContactIds já falha alto em 0 contatos; este é defesa em profundidade.
  if (cohorts.universe === 0) {
    console.error(
      "\n⚠️  Universo 0 — não gravando no KV (evita sobrescrever dado bom com zeros).",
    );
    process.exit(1);
  }

  await uploadTextToWorkerKV(JSON.stringify(cohorts), COHORTS_KV_KEY, {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
    accountId,
    token,
    contentType: "application/json",
  });
  console.error(`\n📤 KV atualizado: ${COHORTS_KV_KEY} (namespace ${DASHBOARD_KV_NAMESPACE_ID}).`);
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
