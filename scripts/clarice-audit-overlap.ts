#!/usr/bin/env node
/**
 * clarice-audit-overlap.ts (#5697)
 *
 * Responde "algum contato recebeu 2+ envios Clarice no período?" com CUSTO
 * DE COTA CONSTANTE (~2 chamadas `GET /v3/emailCampaigns?status=sent`,
 * paginado, independente do número de campanhas), em vez de reinventar a
 * pergunta em `node -e` com `fetch` cru fazendo N GETs — 1 por campanha —
 * que é justamente o que esgotou a cota horária da família
 * `/v3/emailCampaigns*` (100 req/HORA por CONTA — ver
 * docs/brevo-rate-limits.md) e bloqueou `clarice-build-segment.ts` no
 * incidente que originou esta issue.
 *
 * Método (ver `scripts/lib/clarice-overlap.ts` pra lógica pura + rationale
 * completo): no fluxo Clarice cada rodada de envio usa uma lista Brevo
 * DEDICADA (1 lista por `wN-*`/grupo), então uma mesma lista alimentando
 * mais de 1 campanha `sent` é o proxy barato pra "contato dessa lista
 * recebeu 2+ envios" — sem precisar de N GETs pra puxar destinatário a
 * destinatário (a API da Brevo não expõe isso de forma barata de qualquer
 * forma).
 *
 * READ-ONLY POR CONSTRUÇÃO — não escreve nada, não agenda, não dispara.
 * Consumidor de DIAGNÓSTICO: chama `assertCampaignQuotaHeadroom()` antes de
 * gastar cota, e recusa rodar se a cota já estiver abaixo da reserva do
 * caminho de escrita (`clarice-build-segment.ts`/`clarice-plan-wave.ts`) —
 * nunca o contrário.
 *
 * Uso:
 *   npx tsx scripts/clarice-audit-overlap.ts [--since 2026-08-01] [--until 2026-08-31] [--json]
 *
 *   --since ISO      opcional — só considera campanhas sent com sentDate >= since.
 *   --until ISO      opcional — só considera campanhas sent com sentDate <= until.
 *   --json           imprime o resultado como JSON em vez de texto legível.
 *
 * Env: `BREVO_CLARICE_API_KEY` (obrigatória).
 *
 * Exit codes: 0 nenhuma sobreposição · 1 erro (credencial ausente, cota
 * baixa, falha de rede) · 2 sobreposição encontrada (sinal pro chamador,
 * mesmo padrão de `clarice-plan-wave.ts` usar exit 2 pra "sucesso com
 * blockers").
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { assertCampaignQuotaHeadroom, fetchCampaignsByStatus } from "./lib/brevo-client.ts";
import { findOverlappingListCampaigns, type ListOverlap } from "./lib/clarice-overlap.ts";

loadProjectEnv();

export function renderOverlapReport(checked: number, overlaps: ListOverlap[]): string {
  if (overlaps.length === 0) {
    return `✅ nenhuma sobreposição — ${checked} campanha(s) sent verificada(s), nenhuma lista Brevo alimentou mais de 1 campanha no período.`;
  }
  const lines = [
    `⚠️  ${overlaps.length} lista(s) Brevo alimentaram mais de 1 campanha sent no período (${checked} campanha(s) verificada(s)) — contatos dessas listas podem ter recebido 2+ envios:`,
  ];
  for (const o of overlaps) {
    const camps = o.campaigns.map((c) => `#${c.id ?? "?"} "${c.name ?? "?"}" (${c.sentDate ?? "sem data"})`).join(", ");
    lines.push(`  lista ${o.listId}: ${camps}`);
  }
  return lines.join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    throw new Error("BREVO_CLARICE_API_KEY ausente — sem ela não dá pra consultar a Brevo.");
  }

  // #5697: consumidor READ-ONLY/diagnóstico — recusa gastar cota da família
  // /emailCampaigns* se já estiver abaixo da reserva que o caminho de
  // ESCRITA (clarice-build-segment.ts/clarice-plan-wave.ts) precisa. Nunca
  // espera/retenta sozinho aqui — o editor decide se aguarda o reset horário.
  assertCampaignQuotaHeadroom();

  const since = getArg(argv, "since") || undefined;
  const until = getArg(argv, "until") || undefined;

  const sent = await fetchCampaignsByStatus(apiKey, "sent");
  const overlaps = findOverlappingListCampaigns(sent, { since, until });

  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify({ checked: sent.length, overlaps }, null, 2));
  } else {
    console.log(renderOverlapReport(sent.length, overlaps));
  }

  if (overlaps.length > 0) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
