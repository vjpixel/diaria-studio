/**
 * Leitura pura de campanhas Brevo da Clarice News (#13994): chave de ciclo/dia
 * pelo nome, escolha da fonte de stats (globalStats x campaignStats) e mês BRT
 * do envio. Movido de `workers/brevo-dashboard/src/sections-core.ts`, que
 * reexporta os 3 nomes: o Worker e o pipeline (`clarice-envio-risk.ts`,
 * `clarice-monthly-coverage.ts`, o núcleo da rampa) leem as campanhas do mesmo
 * jeito sem que `scripts/` importe código de Worker. Sem I/O e Workers-safe.
 * Entra no bundle do Worker: listado no `paths:` de
 * `.github/workflows/deploy-brevo-dashboard.yml`.
 */
import type { BrevoCampaign, BrevoGlobalStats, BrevoCampaignStats } from "./brevo-dashboard-types.ts";

/**
 * Extrai o ciclo e o número do dia de uma campanha Clarice News.
 * ex: "Clarice News 2605 d02-C (qui)" → { cycle: "2605", dayNum: 2, cell: "C" }
 * ex: "Clarice News 2605 d08 (qua)"  → { cycle: "2605", dayNum: 8, cell: null }
 * Retorna null para campanhas que não seguem o padrão.
 *
 * #2360: sufixo de célula (-A/-B/-C) é OPCIONAL. Envios únicos (sem A/B/C) têm
 * cell: null e são incluídos em calcCumulativeSent / detectActiveCycle. Não
 * participam do resumo A/B/C (aggregateAbcSummary filtra cell === null).
 */
export function parseClariceCampaignKey(campaignName: string): {
  cycle: string;
  dayNum: number;
  cell: "A" | "B" | "C" | null;
  monthly: boolean;
} | null {
  const m = campaignName.match(/Clarice News (\d{4}) d(\d{2})(?:-([ABC]))?(?=\s|$)/i);
  if (m) {
    const cell = m[3] ? (m[3].toUpperCase() as "A" | "B" | "C") : null;
    return { cycle: m[1], dayNum: parseInt(m[2], 10), cell, monthly: false };
  }
  // #2889: naming do digest MENSAL — "Clarice News AAMM-MM — X: subject" (ciclo
  // conteúdo-envio, célula A/B/C, sem dayNum). O teste ABC mensal é 1 campanha
  // por célula (não S1/dias), então não tem dNN. `monthly: true` faz
  // aggregateAbcSummary pular o corte de dia e detectActiveCycle ignorar (o
  // diário e o mensal são testes distintos, cada um com seu Resumo A/B/C).
  const mm = campaignName.match(/Clarice News (\d{4}-\d{2})\s*[—–-]\s*([ABC])\b/i);
  if (mm) {
    return { cycle: mm[1], dayNum: 0, cell: mm[2].toUpperCase() as "A" | "B" | "C", monthly: true };
  }
  return null;
}

/**
 * #2254: fonte única da escolha de stats reais de uma campanha — globalStats
 * (primário, bate com a UI da Brevo) quando `sent > 0`, senão campaignStats[0].
 * Centraliza o padrão `gsIsReal ? gs : cs` que estava duplicado em vários lugares
 * (renderDashboardHtml, aggregateByWeekday, calcCumulativeSent, aggregateAbcSummary). Retorna `null` quando não há stats reais (sent>0).
 * `!(... .sent > 0)` cobre sent=0, undefined e null sem NaN.
 *
 * #2258 (semântica de MPP, verificada empiricamente 2026-06-14 contra a API
 * Brevo): TANTO `globalStats.uniqueViews` QUANTO `campaignStats.uniqueViews`
 * INCLUEM Apple MPP opens (cs.uv ≈ gs.uv, ~levemente menor por lag de snapshot;
 * NÃO é gs.uv − appleMppOpens). Logo `uniqueViews` é uma base homogênea
 * (MPP-inclusiva) entre as duas fontes — usar direto é consistente. O orgânico
 * (sem MPP) só é computável de globalStats, que expõe `appleMppOpens`; por isso
 * `isGlobal` é retornado: quem quiser orgânico subtrai SÓ quando isGlobal.
 */
export function pickStats(
  c: BrevoCampaign,
): { stats: BrevoGlobalStats | BrevoCampaignStats; isGlobal: boolean } | null {
  const gs = c.statistics?.globalStats;
  if (gs && gs.sent > 0) return { stats: gs, isGlobal: true };
  const cs = c.statistics?.campaignStats?.[0];
  if (cs && cs.sent > 0) return { stats: cs, isGlobal: false };
  return null;
}

/**
 * Retorna a chave "YYYY-MM" do sentDate em BRT (America/Sao_Paulo).
 * Exportado pra teste unitário.
 *
 * Necessário porque `sentDate.slice(0,7)` usa UTC — campanha enviada
 * 2026-07-01T00:00:00Z (= 30/jun 21:00 BRT) produziria "2026-07" via slice,
 * mas deve ser "2026-06" para ser consistente com fmtTimeBRT / weekdayKeyBRT.
 * (#2402)
 */
export function monthKeyBRT(iso: string): string | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${year}-${month}`; // "2026-06"
}
