#!/usr/bin/env node
/**
 * clarice-check-semaphore.ts (#4347 Etapa 4, D4)
 *
 * Guard de entregabilidade da skill `/diaria-clarice-novos`: reusa a MESMA
 * lógica pura já usada pela rampa (`deriveRampVolumes` em
 * clarice-schedule-ramp.ts → `aggregateHealth`/`decideSemaphore` em
 * `workers/brevo-dashboard/src/weekly-plan.ts`, sobre `GET
 * {dashboard-url}/api/campaigns`) — não duplica a lógica de circuit breaker,
 * só decide o que fazer com o resultado no contexto da rodada `novos`:
 *
 *   semáforo "red"                → ABORTA (exit 1). D4: "entra no orçamento
 *                                    da rampa e aborta em vermelho".
 *   semáforo "yellow"/"green"     → passa (exit 0).
 *   indeterminado (sem envio maduro,
 *   volume-base indisponível — resposta 2xx bem-formada, só sem dado
 *   suficiente) → passa com aviso (exit 0) — não é "vermelho", é "não dá pra
 *                                    saber ainda"; bloquear aqui degradaria a
 *                                    skill toda vez que a rampa não tem dado
 *                                    maduro suficiente, o que é comum.
 *   GET falhou (não-2xx) OU erro de rede → ABORTA (exit 1, propaga como
 *                                    exceção). Categoria DIFERENTE de
 *                                    "indeterminado": aqui não sabemos se o
 *                                    breaker diria vermelho, então trata como
 *                                    "MCP indisponível = fail-fast" (#738) —
 *                                    nunca como "seguro prosseguir".
 *
 * Uso:
 *   npx tsx scripts/clarice-check-semaphore.ts [--dashboard-url URL] [--dashboard-limit N]
 *
 * Stdout: JSON { ok, semaphore, reason? }. Stderr: log humano-legível.
 */

import { getArg, getIntArg, isMainModule } from "./lib/cli-args.ts";
import {
  DEFAULT_DASHBOARD_URL,
  DEFAULT_DASHBOARD_LIMIT,
  fetchPostmasterSpamEntry,
  deriveRampVolumes,
} from "./clarice-schedule-ramp.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";
import type { Semaphore } from "../workers/brevo-dashboard/src/weekly-plan.ts";

export interface SemaphoreCheckResult {
  ok: boolean; // false = ABORTAR a rodada (semáforo vermelho)
  semaphore: Semaphore | "indeterminate";
  reason?: string;
}

/** Pura: decide o resultado do guard a partir do `deriveRampVolumes` já resolvido. */
export function decideSemaphoreGuard(
  result: ReturnType<typeof deriveRampVolumes>,
): SemaphoreCheckResult {
  if (!result.ok) {
    return { ok: true, semaphore: "indeterminate", reason: result.reason };
  }
  if (result.plan.semaphore === "red") {
    return { ok: false, semaphore: "red", reason: "circuit breaker(s) de entregabilidade rompido(s) (D4, #4347) — aborte a rodada." };
  }
  return { ok: true, semaphore: result.plan.semaphore };
}

/**
 * #4347 review: uma resposta HTTP não-2xx do dashboard (5xx do Worker, 401/403
 * de auth drift) é uma classe de falha DIFERENTE de "sem dado maduro ainda"
 * (`deriveRampVolumes` retornando `ok:false` sobre uma resposta 2xx
 * bem-formada) — a primeira significa "não sabemos se o breaker diria
 * vermelho", a segunda significa "o breaker legitimamente não tem nada a
 * dizer ainda". Tratar as duas como "indeterminate → passa" (como uma
 * primeira versão deste guard fazia) era ASSIMÉTRICO com o comportamento de
 * uma falha de REDE (que já propaga como exceção não capturada até
 * `main().catch()` → aborta) — um 5xx do MESMO serviço silenciosamente
 * passava enquanto uma queda total da rede abortava. Lança aqui pra tratar os
 * dois casos igual (mesmo racional de "MCP indisponível = fail-fast", CLAUDE.md #738).
 */
export async function checkSemaphore(
  dashboardUrl: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SemaphoreCheckResult> {
  const res = await fetchImpl(`${dashboardUrl}/api/campaigns?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`GET ${dashboardUrl}/api/campaigns falhou (${res.status}) — não dá pra determinar o semáforo, tratado como falha (não "indeterminate/passa").`);
  }
  const campaigns = (await res.json()) as BrevoCampaign[];
  // `fetchImpl` propagado (não o default global `fetch`) — sem isso, testes
  // que injetam `fetchImpl` pra evitar rede real ainda disparariam uma
  // chamada de verdade aqui (silenciosamente engolida pelo catch interno de
  // fetchPostmasterSpamEntry, mas uma chamada de rede real mesmo assim).
  const spamEntry = await fetchPostmasterSpamEntry(dashboardUrl, fetchImpl).catch(() => null);
  const result = deriveRampVolumes(campaigns, new Date(), spamEntry);
  return decideSemaphoreGuard(result);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const dashboardUrl = getArg(argv, "dashboard-url") || DEFAULT_DASHBOARD_URL;
  // #4568: `getIntArg` (não `getArg` + resolveDashboardLimit) — devolve
  // `undefined` só quando a flag está genuinamente AUSENTE e LANÇA em valor
  // inválido, em vez de colapsar "" em 0. `min: 1` porque `limit=0` não tem
  // significado válido pra este endpoint (o Worker responde 502): melhor um
  // erro legível de CLI que um 5xx atribuído ao serviço.
  const limit = getIntArg(argv, "dashboard-limit", { min: 1 }) ?? DEFAULT_DASHBOARD_LIMIT;

  const result = await checkSemaphore(dashboardUrl, limit);
  if (result.semaphore === "red") {
    console.error(`🔴 semáforo VERMELHO — ${result.reason}`);
  } else if (result.semaphore === "indeterminate") {
    console.error(`⚪ semáforo indeterminado — ${result.reason} (prosseguindo, não é motivo de abort)`);
  } else {
    console.error(`✓ semáforo ${result.semaphore === "green" ? "🟢" : "🟡"} ${result.semaphore}`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(String((e as Error)?.stack || e));
    process.exit(1);
  });
}
