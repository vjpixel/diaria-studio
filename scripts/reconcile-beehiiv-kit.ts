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
 * `--json` emite JSON em TODOS os exit codes, inclusive 2 (#6311) — nunca
 * stdout vazio quando a flag está presente. Exit 0/1 emitem
 * `{ result, decision }` (ver `maskResultForJson`/`decideGuardExitCode`);
 * exit 2 emite `{ error: { code: "config" | "network", message }, decision:
 * { exitCode: 2 } }` — envelope distinto, mas sempre JSON parseável.
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
import { parseRetryAfterSecs } from "./lib/brevo-client.ts";
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
 * Pure: quanto esperar (ms) antes de retentar um 429, a partir do header
 * `Retry-After` real da resposta — extraído do loop de paginação só pra ser
 * testável sem mockar `fetch`/dormir de verdade (#6311, testes de
 * regressão). `parseRetryAfterSecs` (reusado, não reimplementado — ver
 * comentário no call site) devolve `null` tanto pra header ausente quanto
 * pra forma não-numérica (data HTTP RFC 7231 incluída); os dois caem no
 * mesmo default seguro de 60s. Header numérico é respeitado, com piso de
 * 30s (nunca menos, mesmo se a API mandar `Retry-After: 1`).
 */
export function computeRetryWaitMs(headers: Headers): number {
  const retryAfterSecs = parseRetryAfterSecs(headers);
  return retryAfterSecs != null ? Math.max(retryAfterSecs * 1000, 30_000) : 60_000;
}

/**
 * I/O: pagina `GET /subscriptions?status=active`, drenando por
 * `total_results` (não `total_pages` — #1897, mesma disciplina de
 * `sync-apoio-nivel-beehiiv.ts`/`backup-beehiiv.ts`). Falha loud em
 * qualquer `!res.ok` ou truncamento — este é o recurso PRINCIPAL do guard,
 * uma leitura parcial não pode virar "conjunto completo" silenciosamente.
 */
/**
 * `export` desde #6504 item 2: `kit-gmail-warmup-ramp.ts` reusa esta MESMA
 * função pra checar, antes de devolver um endereço Gmail recusado pro envio
 * do Kit, se ele ainda está ativo na Beehiiv — o mesmo par sent/delivered
 * que motivou este guard existir (ver `audience_tag_note` do canal
 * `kit_diaria` em `platform.config.json`: taguear no Kit sem desativar na
 * Beehiiv duplica o envio, e essa desativação é passo MANUAL, não guard de
 * código). Reexportar em vez de duplicar a paginação + retry de 429.
 */
export async function fetchActiveBeehiivEmails(apiKey: string, publicationId: string): Promise<string[]> {
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
      // #6311: reusa `parseRetryAfterSecs` (já validado contra NaN/negativo
      // pelo #6284, mesma rodada) via `computeRetryWaitMs`, em vez de um 3º
      // parser duplicado — nunca mais o `NaN` que fazia `setTimeout` disparar
      // imediatamente quando o header vinha em forma de data HTTP.
      await sleep(computeRetryWaitMs(res.headers));
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

/**
 * #6311 item (b): antes deste helper, os `return` antecipados de erro de
 * config só escreviam em stderr — com `--json`, stdout saía vazio mesmo
 * assim, quebrando um consumidor programático (o pipeline do #6114, razão
 * de existir deste guard) que sempre espera JSON parseável em stdout quando
 * a flag está presente. Escolha explícita: emitir JSON em TODOS os
 * caminhos de saída, nunca deixar stdout vazio sob `--json` — em vez de só
 * documentar que exit 2 não produz JSON (a alternativa also-defensável
 * citada na issue). Motivo: o contrato já documentado no topo do arquivo
 * ("2 = falha de config/rede") não distingue exit 2 de exit 0/1 quanto a
 * `--json`; um consumidor que já faz `JSON.parse(stdout)` incondicionalmente
 * quando passa a flag não precisa de um 2º branch só pra esse exit code.
 */
export function emitError(asJson: boolean, humanMessage: string, code: "config" | "network"): void {
  process.stderr.write(`${humanMessage}\n`);
  if (asJson) {
    process.stdout.write(
      JSON.stringify({ error: { code, message: humanMessage }, decision: { exitCode: 2 } }, null, 2) + "\n",
    );
  }
  process.exitCode = 2;
}

async function main(): Promise<void> {
  loadProjectEnv();
  const asJson = hasFlag(process.argv.slice(2), "json");

  const beehiivConfig = resolveBeehiivConfig();
  if (!beehiivConfig.ok) {
    emitError(asJson, `${LOG_PREFIX} config Beehiiv inválida — não foi possível medir: ${beehiivConfig.reason}`, "config");
    return;
  }
  const kitConfig = resolveKitConfig();
  if (!kitConfig.ok) {
    emitError(asJson, `${LOG_PREFIX} config Kit inválida — não foi possível medir: ${kitConfig.reason}`, "config");
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
    emitError(asJson, `${LOG_PREFIX} falha de rede/API — não foi possível medir: ${msg}`, "network");
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
    emitError(
      hasFlag(process.argv.slice(2), "json"),
      `${LOG_PREFIX} erro fatal — não foi possível medir: ${(e as Error).message}`,
      "network",
    );
  });
}
