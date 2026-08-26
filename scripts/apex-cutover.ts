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
 *                clara — se o Worker não responder 200 em `/` e `/subscribe`
 *                (hoje os dois dão 404: #6359, em implementação paralela).
 *                Pressupõe que o passo manual do editor (Beehiiv → Domains →
 *                Disconnect domain) já aconteceu — este script NUNCA toca a
 *                Beehiiv, só a Cloudflare.
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
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
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

interface Config {
  token: string;
  accountId: string;
}

function loadConfig(): Config {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!token) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN não definida. Configure no .env (ver `npm run sync-env` via Doppler, ou preencha manualmente).",
    );
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID;
  return { token, accountId };
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
async function fetchDnsRecords(
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

async function fetchWorkerRoutes(
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

async function fetchWorkerCustomDomains(
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

async function attachCustomDomain(
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

async function detachCustomDomain(
  accountId: string,
  token: string,
  domainId: string,
  fetchFn: typeof fetch = fetch,
): Promise<CfResponse<unknown>> {
  return cfRequest("DELETE", `/accounts/${accountId}/workers/domains/${domainId}`, token, undefined, fetchFn);
}

async function patchDnsRecord(
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

async function createDnsRecord(
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

async function httpProbeStatus(url: string, fetchFn: typeof fetch = fetch): Promise<number | null> {
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

// ── Modos ─────────────────────────────────────────────────────────────────

async function runStatus(cfg: Config): Promise<number> {
  console.error(`${LOG_PREFIX} --status: lendo estado atual da zona ${ZONE_ID}...`);

  const [aRecords, aaaaRecords, routes, customDomainsAll] = await Promise.all([
    fetchDnsRecords(ZONE_ID, "A", APEX_HOSTNAME, cfg.token),
    fetchDnsRecords(ZONE_ID, "AAAA", APEX_HOSTNAME, cfg.token),
    fetchWorkerRoutes(ZONE_ID, cfg.token),
    fetchWorkerCustomDomains(cfg.accountId, cfg.token),
  ]);
  const apexCustomDomain = customDomainsAll.find((d) => d.hostname === APEX_HOSTNAME) ?? null;

  const workerProbes: Record<string, number | null> = {};
  for (const path of STATUS_PROBE_PATHS) {
    workerProbes[path] = await httpProbeStatus(`https://${WORKER_DEV_HOST}${path}`);
  }

  const apexProbes: Record<string, number | null> = {};
  for (const path of STATUS_PROBE_PATHS) {
    apexProbes[path] = await httpProbeStatus(`https://${APEX_HOSTNAME}${path}`);
  }

  // Reusa os probes já coletados acima (mesmos paths) pra mostrar de graça se
  // "--cutover" seria aceito hoje — sem chamada extra.
  const cutoverPrecondition = evaluateCutoverPrecondition({
    workerRootStatus: workerProbes["/"] ?? null,
    workerSubscribeStatus: workerProbes["/subscribe"] ?? null,
  });

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

async function runCutover(cfg: Config, apply: boolean): Promise<number> {
  console.error(`${LOG_PREFIX} --cutover: checando guard de pré-condição (${WORKER_DEV_HOST})...`);

  const [rootStatus, subscribeStatus] = await Promise.all([
    httpProbeStatus(`https://${WORKER_DEV_HOST}/`),
    httpProbeStatus(`https://${WORKER_DEV_HOST}/subscribe`),
  ]);

  const guard = evaluateCutoverPrecondition({
    workerRootStatus: rootStatus,
    workerSubscribeStatus: subscribeStatus,
  });

  if (!guard.ready) {
    console.error(`\n${LOG_PREFIX} RECUSADO — o Worker ${WORKER_NAME} não está pronto:`);
    for (const b of guard.blockers) console.error(`  - ${b}`);
    console.error(
      `\nCortar o apex agora derrubaria a superfície de cadastro em produção (sem fallback pra Beehiiv). ` +
        `Nada foi tocado.\n`,
    );
    return 1;
  }

  console.error(`${LOG_PREFIX} guard OK — Worker responde 200 em "/" e "/subscribe".`);

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
  );
  if (!attachRes.success) {
    console.error(
      `${LOG_PREFIX} PUT workers/domains falhou: HTTP ${attachRes.status} — ${JSON.stringify(attachRes.errors)}`,
    );
    return 2;
  }

  // #573 — nunca confiar na resposta do PUT. Reler.
  console.error(`${LOG_PREFIX} PUT aceito — relendo GET /accounts/${cfg.accountId}/workers/domains para verificar...`);
  const customDomainsAfter = await fetchWorkerCustomDomains(cfg.accountId, cfg.token);
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

async function runRollback(cfg: Config, apply: boolean): Promise<number> {
  console.error(`${LOG_PREFIX} --rollback: lendo estado atual...`);

  const [customDomainsAll, aRecords, aaaaRecords] = await Promise.all([
    fetchWorkerCustomDomains(cfg.accountId, cfg.token),
    fetchDnsRecords(ZONE_ID, "A", APEX_HOSTNAME, cfg.token),
    fetchDnsRecords(ZONE_ID, "AAAA", APEX_HOSTNAME, cfg.token),
  ]);
  const apexCustomDomain = customDomainsAll.find((d) => d.hostname === APEX_HOSTNAME) ?? null;
  const actualRecords = [...aRecords, ...aaaaRecords];

  const plan = buildRollbackPlan(apexCustomDomain?.id ?? null, actualRecords);
  // Defesa em profundidade — reafirma o guard bem antes de qualquer mutação,
  // mesmo já garantido dentro de buildRollbackPlan/buildRollbackDnsPlan.
  assertPlanTouchesOnlyAllowedRecordTypes(plan.dnsOps);

  console.log(JSON.stringify({ mode: "rollback", apply, plan }, null, 2));

  if (!apply) {
    console.error(`\n${LOG_PREFIX} DRY-RUN — nada foi mutado. Passe --apply para executar.\n`);
    return 0;
  }

  if (plan.detachOp) {
    console.error(`${LOG_PREFIX} aplicando: DELETE /accounts/${cfg.accountId}/workers/domains/${plan.detachOp.domainId}...`);
    const detachRes = await detachCustomDomain(cfg.accountId, cfg.token, plan.detachOp.domainId);
    if (!detachRes.success) {
      console.error(`${LOG_PREFIX} DELETE workers/domains falhou: HTTP ${detachRes.status} — ${JSON.stringify(detachRes.errors)}`);
      return 2;
    }
  } else {
    console.error(`${LOG_PREFIX} nenhum Custom Domain do apex encontrado — pulando detach.`);
  }

  for (const op of plan.dnsOps) {
    if (op.op === "patch") {
      console.error(`${LOG_PREFIX} aplicando: PATCH dns_records/${op.id} (${op.type} → ${op.content})...`);
      const res = await patchDnsRecord(ZONE_ID, cfg.token, op);
      if (!res.success) {
        console.error(`${LOG_PREFIX} PATCH ${op.type} falhou: HTTP ${res.status} — ${JSON.stringify(res.errors)}`);
        return 2;
      }
    } else {
      console.error(`${LOG_PREFIX} aplicando: POST dns_records (${op.type} → ${op.content}, criando)...`);
      const res = await createDnsRecord(ZONE_ID, cfg.token, op);
      if (!res.success) {
        console.error(`${LOG_PREFIX} POST ${op.type} falhou: HTTP ${res.status} — ${JSON.stringify(res.errors)}`);
        return 2;
      }
    }
  }

  // #573 — reler tudo, nunca confiar nas respostas acima.
  console.error(`${LOG_PREFIX} relendo estado para verificar restauração...`);
  const [aAfter, aaaaAfter, customDomainsAfter] = await Promise.all([
    fetchDnsRecords(ZONE_ID, "A", APEX_HOSTNAME, cfg.token),
    fetchDnsRecords(ZONE_ID, "AAAA", APEX_HOSTNAME, cfg.token),
    fetchWorkerCustomDomains(cfg.accountId, cfg.token),
  ]);
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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const modes = ["status", "cutover", "rollback"].filter((m) => args.flags.has(m));

  if (modes.length !== 1) {
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
    if (modes[0] === "status") return await runStatus(cfg);
    if (modes[0] === "cutover") return await runCutover(cfg, apply);
    return await runRollback(cfg, apply);
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

export { loadConfig };
