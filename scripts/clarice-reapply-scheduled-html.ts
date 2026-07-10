#!/usr/bin/env node
/**
 * clarice-reapply-scheduled-html.ts (#2940)
 *
 * Near-miss real em 2026-07-03/04: o editor pediu pra "atualizar a newsletter
 * na Brevo" após correções de branding na edição 2606-07. As campanhas A/B/C
 * daquele ciclo foram montadas MANUALMENTE na Brevo — então
 * `data/monthly/{ciclo}/sends/cells/campaigns-summary.json` não existia, e
 * `clarice-schedule-sends --update-html` só sabe ler esse arquivo. A
 * atualização virou um one-off manual (GET/diff/PUT via brevo-client.ts), com
 * risco real de: (1) sobrescrever a campanha errada — o handoff
 * `ab-test-plan.md` estava desatualizado; (2) tocar campanha `sent` (envio já
 * saiu, update vira ruído); (3) perder subject/scheduledAt/lista num PUT amplo.
 *
 * Este script formaliza esse one-off: descobre as campanhas QUEUED do ciclo
 * direto na Brevo API (nunca via campaigns-summary.json, que pode nem
 * existir), filtra por `status=queued` (nunca toca `sent`/`in_process`), e
 * faz PUT só de `htmlContent` — preservando subject/scheduledAt/lista.
 *
 * Descoberta (#573 — ler estado ao vivo, não confiar em doc de handoff):
 *   GET /emailCampaigns?status=queued
 * O bug que escondeu as campanhas no near-miss foi ler `r.campaigns` em vez
 * de `r.body.campaigns` (brevoGet retorna `{status, body}` — o corpo da
 * resposta HTTP mora em `body`, não no objeto raiz). `fetchQueuedCampaigns`
 * abaixo faz esse parsing certo e falha alto se o shape mudar.
 *
 * Matching do ciclo: por prefixo do nome da campanha — o pipeline nomeia
 * campanhas como `Clarice News {yymm} {key} (dia)` (ver clarice-schedule-sends.ts),
 * então `Clarice News {cycleToYymm(cycle)}` é o prefixo esperado mesmo para
 * campanhas criadas manualmente na UI (desde que sigam a mesma convenção de
 * nome do ciclo).
 *
 * Fases:
 *   (default, sem --apply) dry-run: lista o que faria, NÃO escreve nada.
 *   --apply                 executa: revalida status ao vivo campanha-a-campanha
 *                            imediatamente antes do PUT (evita corrida
 *                            queued->sent entre a descoberta e a escrita),
 *                            PUT só htmlContent, depois GET-verify que
 *                            subject/scheduledAt não mudaram.
 *
 * Uso:
 *   npx tsx scripts/clarice-reapply-scheduled-html.ts --cycle 2606-07              # dry-run (default)
 *   npx tsx scripts/clarice-reapply-scheduled-html.ts --cycle 2606-07 --apply      # escreve de verdade
 *
 * ATENÇÃO: este script NUNCA deve ser rodado contra a Brevo real a partir de
 * uma sessão automatizada sem supervisão direta do editor — ele existe pra
 * formalizar um one-off que antes era manual, não pra rodar autonomamente.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { brevoGet, brevoPut } from "./lib/brevo-client.ts";
import { parseCycleArg } from "./lib/clarice-paths.ts";
import { monthlyDir as resolveMonthlyDir, cycleToYymm } from "./lib/mensal/monthly-paths.ts";
import { isMainModule } from "./lib/cli-args.ts";

loadProjectEnv();

/** Shape mínimo de um item de `/emailCampaigns` (list ou detail). */
export interface BrevoCampaignListItem {
  id: number;
  name: string;
  status: string;
  subject?: string;
  scheduledAt?: string | null;
}

/** GET /emailCampaigns/{id} traz também htmlContent. */
export interface BrevoCampaignDetail extends BrevoCampaignListItem {
  htmlContent?: string;
}

/**
 * Descobre as campanhas em status=queued via Brevo API.
 *
 * #2940 — o near-miss escondeu as campanhas porque o código lia `r.campaigns`
 * em vez de `r.body.campaigns` (brevoGet retorna `{status, body}`; o corpo
 * HTTP mora em `.body`). Aqui o parsing correto é a única forma suportada —
 * falha alto (nunca retorna [] silenciosamente) se o shape mudar.
 */
/** Estados pré-envio seguros (agendada-não-enviada) — a Brevo reporta como
 *  "queued" OU "scheduled" dependendo da versão de API/timing (drift documentado
 *  em clarice-schedule-sends.ts). Nunca "sent"/"in_process". */
export function isSchedulableStatus(status: string | undefined): boolean {
  return status === "queued" || status === "scheduled";
}

export async function fetchQueuedCampaigns(apiKey: string): Promise<BrevoCampaignListItem[]> {
  // Finding do review consolidado (260704): a Brevo pode reportar uma campanha
  // agendada-não-enviada como `status:"queued"` OU `status:"scheduled"`. Mas
  // `?status=scheduled` NÃO é filtro de query válido (a API retorna 400 — verificado
  // no near-miss). Então buscamos SEM filtro de status e filtramos localmente por
  // queued|scheduled — senão o tool falharia SILENCIOSO (0 campanhas) quando a Brevo
  // reporta "scheduled", deixando o HTML stale no ar (o exato incidente que ele previne).
  const { status, body } = await brevoGet(apiKey, "/emailCampaigns?limit=1000");
  if (status !== 200) {
    throw new Error(`Brevo GET /emailCampaigns falhou: HTTP ${status}`);
  }
  const campaigns = (body as { campaigns?: unknown } | undefined)?.campaigns;
  if (!Array.isArray(campaigns)) {
    throw new Error(
      `/emailCampaigns: shape inesperado — esperava body.campaigns[] ` +
      `(recebido: ${JSON.stringify(body).slice(0, 300)}). ` +
      `Bug do near-miss #2940 era ler r.campaigns em vez de r.body.campaigns.`,
    );
  }
  return (campaigns as BrevoCampaignListItem[]).filter((c) => isSchedulableStatus(c.status));
}

/** Prefixo de nome esperado pras campanhas do ciclo (ver clarice-schedule-sends.ts). */
export function cycleNamePrefix(cycle: string): string {
  return `Clarice News ${cycleToYymm(cycle)}`;
}

/** Filtra campanhas cujo nome bate com o prefixo do ciclo. Pure. */
export function filterCycleCampaigns(campaigns: BrevoCampaignListItem[], cycle: string): BrevoCampaignListItem[] {
  const prefix = cycleNamePrefix(cycle);
  return campaigns.filter((c) => typeof c.name === "string" && c.name.startsWith(prefix));
}

/**
 * Separa as campanhas do ciclo em queued (elegíveis a update) vs. não-queued
 * (puladas — NUNCA recebem PUT). Defensivo: mesmo que a query já tenha
 * filtrado `status=queued` do lado da Brevo, este segundo filtro local
 * garante que uma campanha `sent`/`in_process` que apareça no conjunto por
 * qualquer motivo (cache, corrida, mudança de shape da API) nunca é tocada.
 */
export function partitionByQueuedStatus(
  campaigns: BrevoCampaignListItem[],
): { toUpdate: BrevoCampaignListItem[]; skipped: BrevoCampaignListItem[] } {
  const toUpdate: BrevoCampaignListItem[] = [];
  const skipped: BrevoCampaignListItem[] = [];
  for (const c of campaigns) {
    if (isSchedulableStatus(c.status)) toUpdate.push(c); // queued OU scheduled — pré-envio seguro
    else skipped.push(c);
  }
  return { toUpdate, skipped };
}

/** Monta as linhas de plano impressas em dry-run e antes de --apply. Pure. */
export function buildPlanLines(toUpdate: BrevoCampaignListItem[], skipped: BrevoCampaignListItem[]): string[] {
  const lines: string[] = [];
  lines.push(`${toUpdate.length} campanha(s) queued a atualizar:`);
  for (const c of toUpdate) {
    lines.push(`  #${c.id} ${c.name} — scheduledAt=${c.scheduledAt ?? "?"} subject="${c.subject ?? "?"}"`);
  }
  if (skipped.length > 0) {
    lines.push(`${skipped.length} campanha(s) casaram o prefixo do ciclo mas NÃO estão queued (puladas, nunca recebem PUT):`);
    for (const c of skipped) {
      lines.push(`  #${c.id} ${c.name} — status=${c.status}`);
    }
  }
  return lines;
}

/**
 * PUT só de `htmlContent` — nunca subject/scheduledAt/recipients (preserva o
 * resto da campanha intacto). Único callsite de escrita deste script.
 */
export async function reapplyHtml(apiKey: string, campaignId: number, html: string): Promise<unknown> {
  return brevoPut(apiKey, `/emailCampaigns/${campaignId}`, { htmlContent: html });
}

export interface VerifyIssue { campaignId: number; message: string }

/**
 * Compara o estado da campanha ANTES vs. DEPOIS do PUT de htmlContent.
 * Espera: subject e scheduledAt inalterados, status ainda queued/scheduled
 * (nunca sent/in_process), e htmlContent batendo com o esperado. Pure.
 */
export function verifyUnchanged(
  before: BrevoCampaignListItem,
  after: BrevoCampaignDetail,
  expectedHtml: string,
): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  if (before.subject !== after.subject) {
    issues.push({ campaignId: before.id, message: `subject mudou: "${before.subject}" -> "${after.subject}"` });
  }
  if (before.scheduledAt !== after.scheduledAt) {
    issues.push({ campaignId: before.id, message: `scheduledAt mudou: "${before.scheduledAt}" -> "${after.scheduledAt}"` });
  }
  if (after.status === "sent" || after.status === "in_process") {
    issues.push({
      campaignId: before.id,
      message: `status pós-update é "${after.status}" — campanha pode ter sido enviada durante a operação`,
    });
  }
  if (after.htmlContent !== undefined && after.htmlContent !== expectedHtml) {
    issues.push({ campaignId: before.id, message: `htmlContent pós-update não bate com o esperado` });
  }
  return issues;
}

/** Parseia --apply (default false = dry-run). */
export function parseApplyArg(argv: string[]): boolean {
  return argv.includes("--apply");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = parseCycleArg(argv);
  if (!cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).");
    process.exit(1);
  }
  const apply = parseApplyArg(argv);

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida.");
    process.exit(1);
  }

  const htmlPath = resolve(resolveMonthlyDir(cycle), "_internal", "cloudflare-preview.html");
  if (!existsSync(htmlPath)) throw new Error(`HTML render não existe: ${htmlPath}`);
  const html = readFileSync(htmlPath, "utf8");

  const all = await fetchQueuedCampaigns(apiKey);
  const matched = filterCycleCampaigns(all, cycle);
  const { toUpdate, skipped } = partitionByQueuedStatus(matched);

  console.error(`\n📋 clarice-reapply-scheduled-html --cycle ${cycle} (prefixo "${cycleNamePrefix(cycle)}")`);
  for (const line of buildPlanLines(toUpdate, skipped)) console.error(`  ${line}`);

  if (!apply) {
    console.error(`\ndry-run (default) — use --apply para escrever o HTML nas campanhas queued acima.`);
    return;
  }

  if (toUpdate.length === 0) {
    console.error(`\nNenhuma campanha queued do ciclo ${cycle} encontrada — nada a fazer.`);
    return;
  }

  for (const c of toUpdate) {
    // #573: revalida o status AO VIVO imediatamente antes do PUT — a lista
    // veio de uma chamada anterior e pode ter ficado stale (corrida
    // queued -> sent entre a descoberta e agora).
    const { status: getStatus, body: freshBody } = await brevoGet(apiKey, `/emailCampaigns/${c.id}`);
    if (getStatus !== 200) {
      console.error(`⚠ #${c.id} GET pré-PUT falhou (HTTP ${getStatus}) — pulando.`);
      continue;
    }
    const fresh = freshBody as BrevoCampaignListItem;
    if (!isSchedulableStatus(fresh.status)) {
      console.error(`⚠ #${c.id} não está mais queued/scheduled (agora "${fresh.status}") — PUT abortado.`);
      continue;
    }

    await reapplyHtml(apiKey, c.id, html);

    const { body: afterBody } = await brevoGet(apiKey, `/emailCampaigns/${c.id}`);
    const after = afterBody as BrevoCampaignDetail;
    const issues = verifyUnchanged(c, after, html);
    if (issues.length === 0) {
      console.error(`✓ #${c.id} (${c.name}) html reaplicado — subject/scheduledAt inalterados.`);
    } else {
      for (const issue of issues) console.error(`⚠ #${issue.campaignId}: ${issue.message}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}
