#!/usr/bin/env node
/**
 * apex-cutover.ts (#467)
 *
 * Mecaniza os três momentos do cutover do apex `diar.ia.br` (Beehiiv →
 * Worker `diaria-site`) descritos em `docs/apex-cutover-rollback.md` e nos
 * comentários do #467 (25-26/08/2026): olhar o estado atual, apontar o apex
 * pro Worker, e desfazer isso restaurando exatamente o estado pré-cutover.
 *
 * Toda a DECISÃO (guard de pré-condição, plano de rollback, o que conta como
 * "restaurado") vive em `scripts/lib/apex-cutover.ts` — pura, testável sem
 * rede. Este arquivo só faz I/O: chamadas à API da Cloudflare e probes HTTP.
 *
 * ── Modos (mutuamente exclusivos) ───────────────────────────────────────────
 *
 *   --status     Lê e imprime o estado atual — registros A/AAAA do apex (com
 *                IDs), Workers Custom Domains da conta, Workers Routes da
 *                zona, e o que o apex + o Worker respondem hoje nos paths de
 *                `STATUS_PROBE_PATHS`. Nunca muta nada. Sempre mede HTTP com
 *                User-Agent de navegador — `curl`/fetch sem UA leva challenge
 *                403 da Cloudflare no apex, e 403 de challenge NÃO distingue
 *                "no ar" de "fora do ar" (docs/apex-cutover-rollback.md §2).
 *
 *   --cutover    Aponta o apex pro Worker `diaria-site` via Workers Custom
 *                Domain (`PUT /accounts/{account}/workers/domains` — ver o
 *                docstring de `scripts/lib/apex-cutover.ts` pro porquê deste
 *                mecanismo e não uma Route clássica nem
 *                `wrangler.toml`+`wrangler deploy`). GUARD DE PRÉ-CONDIÇÃO
 *                (o coração desta unidade): recusa — exit != 0, mensagem
 *                clara — a menos que `/` sirva 200 com o `<title>` real
 *                (não só "responder alguma coisa") **e** `/subscribe`
 *                redirecione (3xx) para o perfil Kit hospedado
 *                (`diar-ia-br.kit.com`) — ver `evaluateCutoverPrecondition`
 *                em `scripts/lib/apex-cutover.ts` pro porquê de dois
 *                critérios diferentes (#6359/#6363/#6365 em implementação
 *                paralela). Pressupõe que o passo manual do editor (Beehiiv
 *                → Domains → Disconnect domain) já aconteceu — este script
 *                NUNCA toca a Beehiiv, só a Cloudflare.
 *
 *   --rollback   Restaura exatamente o estado pré-cutover de
 *                `docs/apex-cutover-rollback.md` §1 (A `104.16.243.55`, AAAA
 *                `2001:12ff:0:2::95`, ambos `proxied: true`, ttl auto) e
 *                remove o Custom Domain que o cutover criou — mesma ordem do
 *                §3 do doc (detach do binding ANTES do PATCH de DNS).
 *
 * `--apply` é obrigatória pra qualquer mutação (`--cutover`/`--rollback`).
 * Sem ela, o script imprime o plano e sai 0 sem tocar em nada — **este é o
 * default**, nunca o inverso. `--status` nunca muta, com ou sem `--apply`.
 *
 * ── Verificação pós-mutação (#573) ──────────────────────────────────────────
 *
 * Nunca reporta sucesso a partir do corpo da resposta do PUT/PATCH/POST/
 * DELETE — todo `--apply` termina relendo o estado da API (GET) e comparando
 * contra o esperado, mesmo padrão de `scripts/verify-scheduled-post.ts` e
 * `scripts/schedule-daily-brevo.ts`.
 *
 * ── O que este script NUNCA toca ────────────────────────────────────────────
 *
 * MX (Cloudflare Email Routing), TXT (SPF, `brevo-code`,
 * `google-site-verification`) e CAA do apex. A allowlist de tipos de DNS
 * (`ALLOWED_DNS_RECORD_TYPES` em `scripts/lib/apex-cutover.ts`) é a única
 * fonte de verdade — qualquer função que tente ler/escrever um tipo fora
 * dela lança. Nunca roda `wrangler deploy`.
 *
 * Uso:
 *   npx tsx scripts/apex-cutover.ts --status
 *   npx tsx scripts/apex-cutover.ts --cutover              # dry-run (plano)
 *   npx tsx scripts/apex-cutover.ts --cutover --apply      # executa
 *   npx tsx scripts/apex-cutover.ts --rollback             # dry-run (plano)
 *   npx tsx scripts/apex-cutover.ts --rollback --apply     # executa
 *
 * Variáveis de ambiente:
 *   CLOUDFLARE_API_TOKEN     obrigatório.
 *   CLOUDFLARE_ACCOUNT_ID    opcional — default é o mesmo hardcoded já usado
 *                            em scripts/lib/poll-kv.ts.
 *
 * Exit codes:
 *   0 = sucesso (status impresso; ou plano impresso em dry-run; ou mutação
 *       aplicada E verificada).
 *   1 = guard de pré-condição do --cutover recusou (Worker não pronto).
 *   2 = erro de config/API, ou mutação aplicada mas a VERIFICAÇÃO pós-mutação
 *       não bateu (estado real diverge do esperado — investigar antes de
 *       confiar que terminou).
 *   3 = uso inválido (nenhum modo passado, ou mais de um).
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
import { parseArgs, isMainModule, type ParsedArgs } from "./lib/cli-args.ts";
import {
  ZONE_ID,
  APEX_HOSTNAME,
  WORKER_NAME,
  WORKER_DEV_HOST,
  DEFAULT_ACCOUNT_ID,
  BROWSER_USER_AGENT,
  STATUS_PROBE_PATHS,
  ALLOWED_DNS_RECORD_TYPES,
  type AllowedDnsRecordType,
  type DnsRecordSnapshot,
  evaluateCutoverPrecondition,
  buildCutoverPlan,
  buildRollbackPlan,
  extractRollbackDnsOps,
  assertPlanTouchesOnlyAllowedRecordTypes,
  verifyDnsRestored,
  verifyCustomDomainDetached,
  verifyCutoverAttached,
} from "./lib/apex-cutover.ts";

loadProjectEnv();

const LOG_PREFIX = "[apex-cutover]";
const CF_API = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 20000;

// ── Config ────────────────────────────────────────────────────────────────

export interface Config {
  token: string;
  accountId: string;
}

export function loadConfig(): Config {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!token) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN não definida. Configure no .env (ver `npm run sync-env` via Doppler, ou preencha manualmente).",
    );
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID;
  return { token, accountId };
}

/** Formata o corpo de erro de uma resposta da Cloudflare: usa
 * `errors` quando a API devolveu JSON parseável, cai pro corpo bruto
 * (truncado) quando não (WAF, rate-limit, challenge — `errors` vem `[]` por
 * default nesses casos, e `"HTTP 403 — []"` não dá pista nenhuma pro
 * operador, exatamente quando o contexto é mais necessário). Mesmo padrão já
 * usado pelos GETs deste arquivo (`res.raw.slice(0, 300)`); antes desta
 * função os 4 pontos de mutação usavam só `JSON.stringify(res.errors)`. */
export function formatCfError(res: Pick<CfResponse<unknown>, "errors" | "raw">): string {
  return res.errors.length ? JSON.stringify(res.errors) : res.raw.slice(0, 300);
}

// ── I/O: Cloudflare REST API ─────────────────────────────────────────────────

interface CfResponse<T> {
  ok: boolean;
  status: number;
  success: boolean;
  result: T | null;
  errors: unknown[];
  raw: string;
}

async function cfRequest<T = unknown>(
  method: "GET" | "PATCH" | "POST" | "PUT" | "DELETE",
  path: string,
  token: string,
  body?: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<CfResponse<T>> {
  const res = await fetchFn(`${CF_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  let json: { success?: boolean; result?: T; errors?: unknown[] } = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    // corpo não-JSON — segue com json={} e deixa o status HTTP decidir.
  }
  return {
    ok: res.ok,
    status: res.status,
    success: json.success ?? res.ok,
    result: json.result ?? null,
    errors: json.errors ?? [],
    raw,
  };
}

/** GET /zones/{zone}/dns_records?type={type}&name={name} — só A/AAAA, uma
 * chamada por tipo. NUNCA pede o endpoint sem filtro de `type` (isso
 * devolveria MX/TXT/CAA junto). */
export async function fetchDnsRecords(
  zoneId: string,
  type: AllowedDnsRecordType,
  name: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<DnsRecordSnapshot[]> {
  if (!(ALLOWED_DNS_RECORD_TYPES as readonly string[]).includes(type)) {
    throw new Error(`fetchDnsRecords: tipo "${type}" fora do escopo permitido.`);
  }
  const res = await cfRequest<
    { id: string; type: string; name: string; content: string; proxied?: boolean; ttl?: number }[]
  >("GET", `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`, token, undefined, fetchFn);
  if (!res.success || !res.result) {
    throw new Error(`GET dns_records (${type}) falhou: HTTP ${res.status} — ${res.raw.slice(0, 300)}`);
  }
  return res.result.map((r) => ({
    id: r.id,
    type: type,
    name: r.name,
    content: r.content,
    proxied: r.proxied ?? false,
    ttl: r.ttl ?? 1,
  }));
}

export async function fetchWorkerRoutes(
  zoneId: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ id: string; pattern: string; script?: string }[]> {
  const res = await cfRequest<{ id: string; pattern: string; script?: string }[]>(
    "GET",
    `/zones/${zoneId}/workers/routes`,
    token,
    undefined,
    fetchFn,
  );
  if (!res.success || !res.result) {
    throw new Error(`GET workers/routes falhou: HTTP ${res.status} — ${res.raw.slice(0, 300)}`);
  }
  return res.result;
}

export async function fetchWorkerCustomDomains(
  accountId: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ id: string; hostname: string; service: string; zone_id?: string }[]> {
  const res = await cfRequest<{ id: string; hostname: string; service: string; zone_id?: string }[]>(
    "GET",
    `/accounts/${accountId}/workers/domains`,
    token,
    undefined,
    fetchFn,
  );
  if (!res.success || !res.result) {
    throw new Error(`GET workers/domains falhou: HTTP ${res.status} — ${res.raw.slice(0, 300)}`);
  }
  return res.result;
}

export async function attachCustomDomain(
  accountId: string,
  token: string,
  hostname: string,
  service: string,
  zoneId: string,
  zoneName: string,
  fetchFn: typeof fetch = fetch,
): Promise<CfResponse<{ id: string }>> {
  return cfRequest<{ id: string }>(
    "PUT",
    `/accounts/${accountId}/workers/domains`,
    token,
    { hostname, service, zone_id: zoneId, zone_name: zoneName },
    fetchFn,
  );
}

export async function detachCustomDomain(
  accountId: string,
  token: string,
  domainId: string,
  fetchFn: typeof fetch = fetch,
): Promise<CfResponse<unknown>> {
  return cfRequest("DELETE", `/accounts/${accountId}/workers/domains/${domainId}`, token, undefined, fetchFn);
}

export async function patchDnsRecord(
  zoneId: string,
  token: string,
  op: { id: string; type: AllowedDnsRecordType; name: string; content: string; proxied: boolean; ttl: number },
  fetchFn: typeof fetch = fetch,
): Promise<CfResponse<unknown>> {
  return cfRequest(
    "PATCH",
    `/zones/${zoneId}/dns_records/${op.id}`,
    token,
    { type: op.type, name: op.name, content: op.content, proxied: op.proxied, ttl: op.ttl },
    fetchFn,
  );
}

export async function createDnsRecord(
  zoneId: string,
  token: string,
  op: { type: AllowedDnsRecordType; name: string; content: string; proxied: boolean; ttl: number },
  fetchFn: typeof fetch = fetch,
): Promise<CfResponse<unknown>> {
  return cfRequest(
    "POST",
    `/zones/${zoneId}/dns_records`,
    token,
    { type: op.type, name: op.name, content: op.content, proxied: op.proxied, ttl: op.ttl },
    fetchFn,
  );
}

// ── I/O: probes HTTP (sempre com UA de navegador) ────────────────────────────

export async function httpProbeStatus(url: string, fetchFn: typeof fetch = fetch): Promise<number | null> {
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { "User-Agent": BROWSER_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status;
  } catch {
    return null;
  }
}

export interface HttpProbeDetail {
  status: number | null;
  /** Corpo da resposta (texto). `null` em erro de rede/timeout, ou se o
   * corpo não pôde ser lido como texto. */
  body: string | null;
  /** Header `Location`, quando presente. `null` em erro de rede, ausência
   * do header, ou resposta não é redirect. */
  location: string | null;
}

/** Como `httpProbeStatus`, mas também lê o corpo e o header `Location` — o
 * guard de pré-condição do `--cutover` precisa afirmar sobre CONTEÚDO
 * (`/`) e sobre DESTINO do redirect (`/subscribe`), não só sobre status
 * (ver `evaluateCutoverPrecondition` em `scripts/lib/apex-cutover.ts`, F1 do
 * fleet review da PR #6364). */
export async function httpProbeDetailed(url: string, fetchFn: typeof fetch = fetch): Promise<HttpProbeDetail> {
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { "User-Agent": BROWSER_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    let body: string | null;
    try {
      body = await res.text();
    } catch {
      body = null;
    }
    return { status: res.status, body, location: res.headers.get("location") };
  } catch {
    return { status: null, body: null, location: null };
  }
}

// ── Modos ─────────────────────────────────────────────────────────────────

/** Roda os 2 probes que o guard de pré-condição precisa (corpo de `/`,
 * status + `Location` de `/subscribe`) contra um host — usado tanto por
 * `runCutover` (guard de verdade) quanto por `runStatus` (mostrar de graça
 * se `--cutover` seria aceito hoje). Não dá pra reusar os probes genéricos
 * de `STATUS_PROBE_PATHS` (que só guardam status) pra isso — precisam de 2
 * chamadas HTTP dedicadas, aceitável mesmo em `--status` (comando
 * interativo, não perf-crítico). */
export async function probeCutoverPrecondition(
  host: string,
  fetchFn: typeof fetch = fetch,
): Promise<{
  workerRootStatus: number | null;
  workerRootBody: string | null;
  workerSubscribeStatus: number | null;
  workerSubscribeLocation: string | null;
}> {
  const [root, subscribe] = await Promise.all([
    httpProbeDetailed(`https://${host}/`, fetchFn),
    httpProbeDetailed(`https://${host}/subscribe`, fetchFn),
  ]);
  return {
    workerRootStatus: root.status,
    workerRootBody: root.body,
    workerSubscribeStatus: subscribe.status,
    workerSubscribeLocation: subscribe.location,
  };
}

export async function runStatus(cfg: Config, fetchFn: typeof fetch = fetch): Promise<number> {
  console.error(`${LOG_PREFIX} --status: lendo estado atual da zona ${ZONE_ID}...`);

  const [aRecords, aaaaRecords, routes, customDomainsAll] = await Promise.all([
    fetchDnsRecords(ZONE_ID, "A", APEX_HOSTNAME, cfg.token, fetchFn),
    fetchDnsRecords(ZONE_ID, "AAAA", APEX_HOSTNAME, cfg.token, fetchFn),
    fetchWorkerRoutes(ZONE_ID, cfg.token, fetchFn),
    fetchWorkerCustomDomains(cfg.accountId, cfg.token, fetchFn),
  ]);
  const apexCustomDomain = customDomainsAll.find((d) => d.hostname === APEX_HOSTNAME) ?? null;

  const workerProbes: Record<string, number | null> = {};
  for (const path of STATUS_PROBE_PATHS) {
    workerProbes[path] = await httpProbeStatus(`https://${WORKER_DEV_HOST}${path}`, fetchFn);
  }

  const apexProbes: Record<string, number | null> = {};
  for (const path of STATUS_PROBE_PATHS) {
    apexProbes[path] = await httpProbeStatus(`https://${APEX_HOSTNAME}${path}`, fetchFn);
  }

  // O guard precisa de corpo de "/" e Location de "/subscribe" — não dá pra
  // reusar os probes status-only acima; 2 chamadas extras, aceitável num
  // comando interativo (ver docstring de probeCutoverPrecondition).
  const cutoverPrecondition = evaluateCutoverPrecondition(
    await probeCutoverPrecondition(WORKER_DEV_HOST, fetchFn),
  );

  const summary = {
    zone_id: ZONE_ID,
    dns: { A: aRecords, AAAA: aaaaRecords },
    workers_routes_on_zone: routes,
    apex_custom_domain: apexCustomDomain,
    probes: {
      note: "medido com User-Agent de navegador — ver docs/apex-cutover-rollback.md §2",
      worker_dev_host: WORKER_DEV_HOST,
      worker: workerProbes,
      apex: apexProbes,
    },
    cutover_precondition: cutoverPrecondition,
  };

  console.log(JSON.stringify(summary, null, 2));

  console.error(
    `${LOG_PREFIX} routes na zona: ${routes.length} (esperado 0). ` +
      `custom domain do apex: ${apexCustomDomain ? `SIM (service=${apexCustomDomain.service})` : "não"}.`,
  );
  return 0;
}

export async function runCutover(cfg: Config, apply: boolean, fetchFn: typeof fetch = fetch): Promise<number> {
  console.error(`${LOG_PREFIX} --cutover: checando guard de pré-condição (${WORKER_DEV_HOST})...`);

  const guard = evaluateCutoverPrecondition(await probeCutoverPrecondition(WORKER_DEV_HOST, fetchFn));

  if (!guard.ready) {
    console.error(`\n${LOG_PREFIX} RECUSADO — o Worker ${WORKER_NAME} não está pronto:`);
    for (const b of guard.blockers) console.error(`  - ${b}`);
    console.error(
      `\nCortar o apex agora derrubaria a superfície de cadastro em produção (sem fallback pra Beehiiv). ` +
        `Nada foi tocado.\n`,
    );
    return 1;
  }

  console.error(`${LOG_PREFIX} guard OK — "/" serve a página certa e "/subscribe" redireciona pro destino esperado.`);

  const plan = buildCutoverPlan();
  console.log(JSON.stringify({ mode: "cutover", apply, plan }, null, 2));

  if (!apply) {
    console.error(`\n${LOG_PREFIX} DRY-RUN — nada foi mutado. Passe --apply para executar.\n`);
    return 0;
  }

  console.error(
    `${LOG_PREFIX} aplicando: PUT /accounts/${cfg.accountId}/workers/domains ` +
      `(hostname=${plan.workerDomainOp.hostname}, service=${plan.workerDomainOp.service})...`,
  );
  const attachRes = await attachCustomDomain(
    cfg.accountId,
    cfg.token,
    plan.workerDomainOp.hostname,
    plan.workerDomainOp.service,
    plan.workerDomainOp.zoneId,
    plan.workerDomainOp.zoneName,
    fetchFn,
  );
  if (!attachRes.success) {
    console.error(`${LOG_PREFIX} PUT workers/domains falhou: HTTP ${attachRes.status} — ${formatCfError(attachRes)}`);
    return 2;
  }

  // #573 — nunca confiar na resposta do PUT. Reler.
  console.error(`${LOG_PREFIX} PUT aceito — relendo GET /accounts/${cfg.accountId}/workers/domains para verificar...`);
  let customDomainsAfter: Awaited<ReturnType<typeof fetchWorkerCustomDomains>>;
  try {
    customDomainsAfter = await fetchWorkerCustomDomains(cfg.accountId, cfg.token, fetchFn);
  } catch (e) {
    console.error(
      `\n${LOG_PREFIX} MUTAÇÃO PODE TER SIDO APLICADA — releitura falhou: ${(e as Error).message}. ` +
        `Rode --status antes de repetir --apply.\n`,
    );
    return 2;
  }
  const attached = verifyCutoverAttached(customDomainsAfter);

  console.log(JSON.stringify({ mode: "cutover", applied: true, verified: attached, custom_domains: customDomainsAfter }, null, 2));

  if (!attached) {
    console.error(
      `\n${LOG_PREFIX} ATENÇÃO — PUT retornou sucesso mas a releitura NÃO mostra ` +
        `${APEX_HOSTNAME} anexado ao Worker ${WORKER_NAME}. Investigar antes de considerar concluído.\n`,
    );
    return 2;
  }

  console.error(
    `\n${LOG_PREFIX} OK — ${APEX_HOSTNAME} anexado ao Worker ${WORKER_NAME}. ` +
      `Rode "--status" em alguns minutos pra confirmar propagação (certificado/DNS levam tempo) ` +
      `e siga o checklist de docs/apex-cutover-rollback.md §5-6.\n`,
  );
  return 0;
}

export async function runRollback(cfg: Config, apply: boolean, fetchFn: typeof fetch = fetch): Promise<number> {
  console.error(`${LOG_PREFIX} --rollback: lendo estado atual...`);

  const [customDomainsAll, aRecords, aaaaRecords] = await Promise.all([
    fetchWorkerCustomDomains(cfg.accountId, cfg.token, fetchFn),
    fetchDnsRecords(ZONE_ID, "A", APEX_HOSTNAME, cfg.token, fetchFn),
    fetchDnsRecords(ZONE_ID, "AAAA", APEX_HOSTNAME, cfg.token, fetchFn),
  ]);
  const apexCustomDomain = customDomainsAll.find((d) => d.hostname === APEX_HOSTNAME) ?? null;
  const actualRecords = [...aRecords, ...aaaaRecords];

  // buildRollbackPlan (via buildRollbackDnsPlan) lança se houver mais de 1
  // registro do mesmo tipo na zona — propaga pro catch de main() como erro
  // explícito (exit 2), nunca silenciosamente escolhe "o primeiro".
  const plan = buildRollbackPlan(apexCustomDomain?.id ?? null, actualRecords);
  // Defesa em profundidade — reafirma o guard bem antes de qualquer mutação,
  // mesmo já garantido dentro de buildRollbackPlan/buildRollbackDnsPlan.
  assertPlanTouchesOnlyAllowedRecordTypes(extractRollbackDnsOps(plan));

  console.log(JSON.stringify({ mode: "rollback", apply, plan }, null, 2));

  if (!apply) {
    console.error(`\n${LOG_PREFIX} DRY-RUN — nada foi mutado. Passe --apply para executar.\n`);
    return 0;
  }

  if (!plan.some((s) => s.kind === "detach")) {
    console.error(`${LOG_PREFIX} nenhum Custom Domain do apex encontrado — pulando detach.`);
  }

  // Itera o PLANO em ordem — a estrutura de `plan` (union ordenada, não dois
  // campos independentes) já garante detach-antes-de-DNS; este loop só
  // executa o que o plano manda, na ordem em que manda.
  for (const step of plan) {
    if (step.kind === "detach") {
      console.error(`${LOG_PREFIX} aplicando: DELETE /accounts/${cfg.accountId}/workers/domains/${step.detach.domainId}...`);
      const detachRes = await detachCustomDomain(cfg.accountId, cfg.token, step.detach.domainId, fetchFn);
      if (!detachRes.success) {
        console.error(`${LOG_PREFIX} DELETE workers/domains falhou: HTTP ${detachRes.status} — ${formatCfError(detachRes)}`);
        return 2;
      }
      continue;
    }

    const op = step.dns;
    if (op.op === "patch") {
      console.error(`${LOG_PREFIX} aplicando: PATCH dns_records/${op.id} (${op.type} → ${op.content})...`);
      const res = await patchDnsRecord(ZONE_ID, cfg.token, op, fetchFn);
      if (!res.success) {
        console.error(`${LOG_PREFIX} PATCH ${op.type} falhou: HTTP ${res.status} — ${formatCfError(res)}`);
        return 2;
      }
    } else {
      console.error(`${LOG_PREFIX} aplicando: POST dns_records (${op.type} → ${op.content}, criando)...`);
      const res = await createDnsRecord(ZONE_ID, cfg.token, op, fetchFn);
      if (!res.success) {
        console.error(`${LOG_PREFIX} POST ${op.type} falhou: HTTP ${res.status} — ${formatCfError(res)}`);
        return 2;
      }
    }
  }

  // #573 — reler tudo, nunca confiar nas respostas acima.
  console.error(`${LOG_PREFIX} relendo estado para verificar restauração...`);
  let aAfter: DnsRecordSnapshot[], aaaaAfter: DnsRecordSnapshot[], customDomainsAfter: Awaited<ReturnType<typeof fetchWorkerCustomDomains>>;
  try {
    [aAfter, aaaaAfter, customDomainsAfter] = await Promise.all([
      fetchDnsRecords(ZONE_ID, "A", APEX_HOSTNAME, cfg.token, fetchFn),
      fetchDnsRecords(ZONE_ID, "AAAA", APEX_HOSTNAME, cfg.token, fetchFn),
      fetchWorkerCustomDomains(cfg.accountId, cfg.token, fetchFn),
    ]);
  } catch (e) {
    console.error(
      `\n${LOG_PREFIX} MUTAÇÃO PODE TER SIDO APLICADA — releitura falhou: ${(e as Error).message}. ` +
        `Rode --status antes de repetir --apply.\n`,
    );
    return 2;
  }
  const dnsCheck = verifyDnsRestored([...aAfter, ...aaaaAfter]);
  const detachCheck = verifyCustomDomainDetached(customDomainsAfter.map((d) => d.hostname));

  console.log(
    JSON.stringify(
      {
        mode: "rollback",
        applied: true,
        verified: dnsCheck.restored && detachCheck,
        dns_check: dnsCheck,
        custom_domain_detached: detachCheck,
        dns_after: { A: aAfter, AAAA: aaaaAfter },
      },
      null,
      2,
    ),
  );

  if (!dnsCheck.restored || !detachCheck) {
    console.error(`\n${LOG_PREFIX} ATENÇÃO — verificação pós-rollback não bateu:`);
    for (const m of dnsCheck.mismatches) console.error(`  - DNS: ${m}`);
    if (!detachCheck) console.error(`  - Custom Domain do apex ainda presente.`);
    console.error("");
    return 2;
  }

  console.error(`\n${LOG_PREFIX} OK — estado pré-cutover restaurado e verificado.\n`);
  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────

function printUsage(): void {
  process.stderr.write(
    "Uso: apex-cutover.ts (--status|--cutover|--rollback) [--apply]\n" +
      "  --status              lê e imprime o estado atual (nunca muta)\n" +
      "  --cutover [--apply]   aponta o apex pro Worker diaria-site\n" +
      "  --rollback [--apply]  restaura o estado pré-cutover\n" +
      "Sem --apply, --cutover/--rollback só imprimem o plano (dry-run, default).\n",
  );
}

/** Resolve qual dos 3 modos mutuamente exclusivos foi pedido — `null` quando
 * 0 ou 2+ flags de modo estão presentes (uso inválido, exit 3). Pura —
 * testável sem tocar `process.argv`/rede/config. */
export function resolveMode(args: ParsedArgs): "status" | "cutover" | "rollback" | null {
  const modes = (["status", "cutover", "rollback"] as const).filter((m) => args.flags.has(m));
  return modes.length === 1 ? modes[0] : null;
}

export async function main(argv: string[] = process.argv.slice(2), fetchFn: typeof fetch = fetch): Promise<number> {
  const args = parseArgs(argv);
  const mode = resolveMode(args);

  if (mode === null) {
    printUsage();
    return 3;
  }
  const apply = args.flags.has("apply");

  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} erro de config: ${(e as Error).message}\n`);
    return 2;
  }

  try {
    if (mode === "status") return await runStatus(cfg, fetchFn);
    if (mode === "cutover") return await runCutover(cfg, apply, fetchFn);
    return await runRollback(cfg, apply, fetchFn);
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} erro inesperado: ${(e as Error).message}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  // Windows fix (#4638): process.exitCode + return em vez de process.exit(),
  // deixando o event loop drenar sozinho (evita UV_HANDLE_CLOSING com sockets
  // keep-alive do fetch ainda abertos).
  main().then((code) => {
    process.exitCode = code;
  });
}
