/**
 * reconcile-beehiiv-kit.ts (#6269)
 *
 * Guard de reconciliação Beehiiv×Kit — pré-condição do switchover do #6114
 * (`publishing.newsletter.backend: "beehiiv" → "kit"`). Puxa a lista de
 * ativos de cada plataforma (paginado) e compara os CONJUNTOS de e-mail
 * normalizado — nunca as contagens, que o achado do #6269 provou
 * insuficiente (587 == 587 com interseção 584, divergência simétrica
 * invisível a qualquer checagem por contagem).
 *
 * Miolo puro (comparação de conjuntos, normalização, hash) mora em
 * `scripts/lib/beehiiv-kit-reconcile.ts` — este script só faz o fetch e
 * delega. Ver esse módulo pro critério de saída assimétrico.
 *
 * Uso:
 *   npx tsx scripts/reconcile-beehiiv-kit.ts            # texto humano
 *   npx tsx scripts/reconcile-beehiiv-kit.ts --json      # JSON pra consumo programático
 *
 * Exit codes (distintos de propósito — "não consegui medir" != "medi e diverge"):
 *   0 = guard passa (conjuntos batem, ou só warning não-bloqueante só-no-Kit)
 *   1 = DIVERGE de forma bloqueante (há e-mail só na Beehiiv — ver módulo)
 *   2 = falha de config/rede — não foi possível medir (credencial ausente,
 *       API indisponível, paginação truncada) — NUNCA confundir com "diverge"
 *
 * Env: BEEHIIV_API_KEY, BEEHIIV_PUBLICATION_ID (ou platform.config.json),
 * KIT_API_KEY — mesmos nomes já usados pelos scripts vizinhos (ver
 * `scripts/lib/beehiiv-config.ts`, `scripts/lib/kit-config.ts`).
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { listAllKitSubscribers } from "./lib/kit-subscribers.ts";
import type { KitConfig } from "./lib/kit-config.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { hasMorePages } from "./sync-cursos-subscribers-kv.ts";
import {
  reconcileEmailSets,
  decideGuardExitCode,
  formatGuardReport,
  maskResultForJson,
} from "./lib/beehiiv-kit-reconcile.ts";

const LOG_PREFIX = "[reconcile-beehiiv-kit]";
const PER_PAGE = 100;

interface BeehiivSubscriptionApi {
  email: string;
}

interface Page<T> {
  data?: T[];
  total_results?: number;
  limit?: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * I/O: pagina `GET /subscriptions?status=active`, drenando por
 * `total_results` (não `total_pages` — #1897, mesma disciplina de
 * `sync-apoio-nivel-beehiiv.ts`/`backup-beehiiv.ts`). Falha loud em
 * qualquer `!res.ok` ou truncamento — este é o recurso PRINCIPAL do guard,
 * uma leitura parcial não pode virar "conjunto completo" silenciosamente.
 */
async function fetchActiveBeehiivEmails(apiKey: string, publicationId: string): Promise<string[]> {
  const out: string[] = [];
  let page = 1;
  let more = true;
  let totalResults: number | null = null;
  while (more) {
    const res = await fetch(
      `${beehiivApiBase()}/publications/${publicationId}/subscriptions?status=active&per_page=${PER_PAGE}&page=${page}`,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
    );
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
      await sleep(Math.max(retryAfter * 1000, 30_000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Beehiiv API ${res.status} em /subscriptions (página ${page})`);
    }
    const body = (await res.json()) as Page<BeehiivSubscriptionApi>;
    const got = body.data ?? [];
    for (const s of got) out.push(s.email);
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
      `paginação de /subscriptions terminou cedo: coletado ${out.length} de ${totalResults} reportado pela API`,
    );
  }
  return out;
}

/** I/O: todos os assinantes Kit com `state === "active"` (client-side —
 *  `/v4/subscribers` não filtra por state server-side, mesmo padrão de
 *  `fetchCurrentKitState` em `sync-apoio-nivel-kit.ts`). */
async function fetchActiveKitEmails(config: KitConfig): Promise<string[]> {
  const subs = await listAllKitSubscribers(config);
  return subs.filter((s) => s.state === "active").map((s) => s.email_address);
}

async function main(): Promise<void> {
  loadProjectEnv();
  const asJson = hasFlag(process.argv.slice(2), "json");

  const beehiivConfig = resolveBeehiivConfig();
  if (!beehiivConfig.ok) {
    process.stderr.write(`${LOG_PREFIX} config Beehiiv inválida — não foi possível medir: ${beehiivConfig.reason}\n`);
    process.exitCode = 2;
    return;
  }
  const kitConfig = resolveKitConfig();
  if (!kitConfig.ok) {
    process.stderr.write(`${LOG_PREFIX} config Kit inválida — não foi possível medir: ${kitConfig.reason}\n`);
    process.exitCode = 2;
    return;
  }

  let beehiivEmails: string[];
  let kitEmails: string[];
  try {
    process.stderr.write(`${LOG_PREFIX} buscando ativos na Beehiiv…\n`);
    beehiivEmails = await fetchActiveBeehiivEmails(beehiivConfig.config.apiKey, beehiivConfig.config.publicationId);
    process.stderr.write(`${LOG_PREFIX} buscando state=active no Kit…\n`);
    kitEmails = await fetchActiveKitEmails(kitConfig.config);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${LOG_PREFIX} falha de rede/API — não foi possível medir: ${msg}\n`);
    process.exitCode = 2;
    return;
  }

  const result = reconcileEmailSets(beehiivEmails, kitEmails);
  const decision = decideGuardExitCode(result);

  if (asJson) {
    // #6269 finding: e-mails de `onlyInBeehiiv`/`onlyInKit` sempre mascarados
    // aqui — mesma disciplina "sem PII crua no stdout" que a saída humana já
    // seguia (`formatGuardReport`). `--json` alimenta pipeline/log/CI, então
    // é o caminho de MAIOR alcance, não o de menor risco.
    process.stdout.write(JSON.stringify({ result: maskResultForJson(result), decision }, null, 2) + "\n");
  } else {
    process.stdout.write(formatGuardReport(result, decision) + "\n");
  }

  process.exitCode = decision.exitCode;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro fatal — não foi possível medir: ${(e as Error).message}\n`);
    process.exitCode = 2;
  });
}
