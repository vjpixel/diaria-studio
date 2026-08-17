#!/usr/bin/env node
/**
 * scripts/probe-home-widget-static.ts (#5545)
 *
 * Sondagem estática opcional (sem navegador) — item 3 do escopo da #5545.
 * Baixa a home com uma query string de teste e registra o que o HTML
 * servido de fato contém sobre o widget "Assinar grátis" (script, form
 * nativo, âncoras). Serve pra prever o resultado e diagnosticar rápido se o
 * teste real (#5522) falhar — **não** é aprovação. Ver
 * `scripts/lib/home-widget-probe.ts` pro racional completo.
 *
 * Uso:
 *   npx tsx scripts/probe-home-widget-static.ts
 *   npx tsx scripts/probe-home-widget-static.ts --query "utm_source=google-ads&utm_medium=cpc&utm_campaign=preflight-2608"
 *
 * GET público, sem autenticação, sem API Beehiiv, sem MCP — mesmo perfil de
 * `scripts/beehiiv-home-meta-check.ts` (permitido em sessão overnight/develop,
 * não é ação de publish/schedule/send).
 *
 * Exit codes: 0 = sondagem concluída (independente do que encontrou — não é
 * pass/fail); 1 = falha de rede ao buscar a home.
 */
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { BEEHIIV_BASE_URL } from "./lib/edition-url.ts";
import { probeHomeWidgetHtml, formatHomeWidgetProbeFinding } from "./lib/home-widget-probe.ts";

const LOG_PREFIX = "[probe-home-widget-static]";
const FETCH_TIMEOUT_MS = 15_000;
/** Query default — mesma forma dos 3 braços reais, `utm_source` neutro
 *  (não usar um dos 3 braços de verdade aqui, pra não confundir com um
 *  teste real do #5522 se alguém rodar isto por engano em vez do roteiro). */
const DEFAULT_QUERY = "utm_source=probe-static&utm_medium=diagnostico&utm_campaign=preflight-probe";

export async function fetchHomeHtmlWithQuery(
  query: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ html: string | null; url: string; fetchError: string | null }> {
  const url = `${BEEHIIV_BASE_URL}/?${query}`;
  try {
    const res = await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { html: null, url, fetchError: `HTTP ${res.status}` };
    return { html: await res.text(), url, fetchError: null };
  } catch (e) {
    return { html: null, url, fetchError: (e as Error).message };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const query = getStringArg(argv, "query") ?? DEFAULT_QUERY;

  console.log(`${LOG_PREFIX} query: ${query}`);
  const { html, url, fetchError } = await fetchHomeHtmlWithQuery(query);

  if (fetchError || html === null) {
    console.error(`${LOG_PREFIX} falha ao buscar ${url}: ${fetchError}`);
    process.exitCode = 1;
    return;
  }

  const finding = probeHomeWidgetHtml(html, query);
  console.log("");
  console.log(formatHomeWidgetProbeFinding(finding, url));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
