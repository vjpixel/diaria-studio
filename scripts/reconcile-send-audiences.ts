#!/usr/bin/env node
/**
 * reconcile-send-audiences.ts (#7385)
 *
 * Guard "quem recebe × quem recebe" nas 3 plataformas de envio da edição
 * diária — sucessor, em ESCOPO, de `scripts/reconcile-beehiiv-kit.ts`
 * (#6269), que continua existindo intocado (é o precondition do switchover
 * #6114, "só na Beehiiv: 0" contra as bases de ATIVOS, ver
 * `platform.config.json` → `publishing.newsletter.backend_note`).
 *
 * O achado do #7385: comparar BASES DE ATIVOS engana. Medição de
 * 03/09/2026 — Kit tinha 629 assinantes ativos, mas só 280 na tag
 * `rampa-kit` (quem de fato recebe); Beehiiv tinha 317 ativos e 314
 * destinatários reais do último post. Comparar 629×317 sugere migração
 * concluída; a comparação verdadeira é 280×314. Os 349 que sobram no Kit
 * fora da tag ficaram sem receber NADA por 7 dias (#7357) sem nenhum guard
 * acusando, porque nada media a audiência de ENVIO.
 *
 * Este script mede, para as 3 plataformas que hoje compõem o envio da
 * edição diária:
 *   1. **Audiência de envio** — quem RECEBERIA a próxima edição:
 *      - Kit: membros da tag `kit_diaria.audience_tag` (default `rampa-kit`).
 *      - Beehiiv: assinantes `active` (ainda é a audiência de envio real do
 *        post principal — todo `active` recebe, salvo o gap constante
 *        medido no item 2).
 *      - Brevo: contatos da lista `brevo_diaria.list_id` (a campanha diária
 *        mira a lista inteira).
 *   2. **Destinatários reais do último envio** de cada plataforma —
 *      informativo, sujeito às 2 armadilhas de medição documentadas no
 *      corpo da issue (ver `scripts/lib/beehiiv-kit-reconcile.ts`):
 *      `checkBeehiivDeliveryGap` tolera o gap constante da Beehiiv (~3
 *      abaixo do total ativo); `resolveBrevoCampaignRecipients` recusa ler
 *      `statistics.globalStats.sent` sem o parâmetro `?statistics=
 *      globalStats` (a chamada de rede — `brevoGetCampaignGlobalStats` —
 *      já o inclui de forma hardcoded, então esta armadilha é evitada
 *      mecanicamente, não só detectada).
 *   3. **Órfãos** — ativo em alguma plataforma, fora de TODA audiência de
 *      envio (`findOrphans`).
 *   4. **Sobreposição** — presente em mais de uma audiência de envio ao
 *      mesmo tempo (`reconcileSendAudiences`), hoje deveria ser sempre 0.
 *
 * Fail-soft por MEDIÇÃO individual (item 2 é sujeito a `not-measured`, não
 * derruba o resto do guard) — mas fail-hard em qualquer falha de config/rede
 * que impeça medir a AUDIÊNCIA (item 1), porque é essa medição que sustenta
 * os itens 3/4.
 *
 * Exit codes (mesma convenção de `reconcile-beehiiv-kit.ts`):
 *   0 = guard passa (sem órfão, sem sobreposição)
 *   1 = DIVERGE (órfão e/ou sobreposição encontrados)
 *   2 = falha de config/rede — não foi possível medir a audiência
 *
 * Uso:
 *   npx tsx scripts/reconcile-send-audiences.ts            # texto humano
 *   npx tsx scripts/reconcile-send-audiences.ts --json      # JSON
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { findTagIdByName, listAllTagSubscriberEmails } from "./lib/kit-broadcasts.ts";
import { listBroadcasts, getBroadcastStats } from "./lib/kit-client.ts";
import { brevoListContacts, brevoGetCampaignGlobalStats, fetchCampaignsByStatus } from "./lib/brevo-client.ts";
import { fetchActiveBeehiivEmails } from "./reconcile-beehiiv-kit.ts";
import {
  reconcileSendAudiences,
  maskSendAudiencesResultForJson,
  findOrphans,
  maskOrphansForJson,
  checkBeehiivDeliveryGap,
  resolveBrevoCampaignRecipients,
  type EmailSource,
} from "./lib/beehiiv-kit-reconcile.ts";

const LOG_PREFIX = "[reconcile-send-audiences]";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KIT_DEFAULT_AUDIENCE_TAG = "rampa-kit";

interface PlatformConfig {
  kit_diaria?: { audience_tag?: string };
  brevo_diaria?: { api_key_env?: string; list_id?: number };
}

function readPlatformConfig(): PlatformConfig {
  return JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as PlatformConfig;
}

/** Última entrega REAL medida por plataforma — `null` quando não foi
 *  possível medir (fail-soft, não impede o resto do guard de rodar). */
export interface RecentDeliveryMeasurement {
  platform: "beehiiv" | "kit" | "brevo";
  measured: boolean;
  recipients?: number;
  reason?: string;
}

async function measureBeehiivRecentDelivery(
  apiKey: string,
  publicationId: string,
): Promise<RecentDeliveryMeasurement> {
  try {
    const res = await fetch(
      `${beehiivApiBase()}/publications/${publicationId}/posts?order_by=publish_date&direction=desc&limit=1&expand[]=stats`,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
    );
    if (!res.ok) {
      return { platform: "beehiiv", measured: false, reason: `Beehiiv API ${res.status} em /posts` };
    }
    const body = (await res.json()) as { data?: Array<{ stats?: { email?: { recipients?: number } } }> };
    const recipients = body.data?.[0]?.stats?.email?.recipients;
    if (typeof recipients !== "number") {
      return { platform: "beehiiv", measured: false, reason: "post mais recente sem stats.email.recipients" };
    }
    return { platform: "beehiiv", measured: true, recipients };
  } catch (e) {
    return { platform: "beehiiv", measured: false, reason: (e as Error).message };
  }
}

async function measureKitRecentDelivery(): Promise<RecentDeliveryMeasurement> {
  try {
    const { broadcasts } = await listBroadcasts({ status: "completed", perPage: 50 });
    if (broadcasts.length === 0) {
      return { platform: "kit", measured: false, reason: "nenhum broadcast completed encontrado" };
    }
    const latest = broadcasts.reduce((best, b) =>
      Date.parse(b.published_at ?? b.created_at) > Date.parse(best.published_at ?? best.created_at) ? b : best,
    );
    const stats = await getBroadcastStats(latest.id);
    return { platform: "kit", measured: true, recipients: stats.recipients };
  } catch (e) {
    return { platform: "kit", measured: false, reason: (e as Error).message };
  }
}

async function measureBrevoRecentDelivery(apiKey: string, listId: number): Promise<RecentDeliveryMeasurement> {
  try {
    const sent = await fetchCampaignsByStatus(apiKey, "sent");
    const forList = sent.filter((c) => (c.recipients?.lists ?? []).includes(listId) && c.sentDate);
    if (forList.length === 0) {
      return { platform: "brevo", measured: false, reason: `nenhuma campanha 'sent' encontrada para a lista ${listId}` };
    }
    const latest = forList.reduce((best, c) => (Date.parse(c.sentDate!) > Date.parse(best.sentDate!) ? c : best));
    if (typeof latest.id !== "number") {
      return { platform: "brevo", measured: false, reason: "campanha mais recente sem id" };
    }
    const stats = await brevoGetCampaignGlobalStats(apiKey, latest.id);
    const resolved = resolveBrevoCampaignRecipients(stats);
    if (!resolved.ok) return { platform: "brevo", measured: false, reason: resolved.reason };
    return { platform: "brevo", measured: true, recipients: resolved.sent };
  } catch (e) {
    return { platform: "brevo", measured: false, reason: (e as Error).message };
  }
}

export interface GuardOutcome {
  audience: ReturnType<typeof reconcileSendAudiences>;
  orphans: ReturnType<typeof findOrphans>;
  recentDelivery: RecentDeliveryMeasurement[];
  beehiivDeliveryGap: ReturnType<typeof checkBeehiivDeliveryGap> | null;
  blocking: boolean;
}

export function decideOutcome(
  audience: ReturnType<typeof reconcileSendAudiences>,
  orphans: ReturnType<typeof findOrphans>,
  recentDelivery: RecentDeliveryMeasurement[],
  beehiivActiveCount: number,
): GuardOutcome {
  const beehiivDelivery = recentDelivery.find((r) => r.platform === "beehiiv");
  const beehiivDeliveryGap =
    beehiivDelivery?.measured && typeof beehiivDelivery.recipients === "number"
      ? checkBeehiivDeliveryGap(beehiivActiveCount, beehiivDelivery.recipients)
      : null;
  const blocking = audience.overlapCount > 0 || orphans.length > 0;
  return { audience, orphans, recentDelivery, beehiivDeliveryGap, blocking };
}

function formatReport(outcome: GuardOutcome): string {
  const lines: string[] = [];
  lines.push(`${LOG_PREFIX} audiência de envio — Kit (tag) × Beehiiv (ativos) × Brevo (lista diária)`);
  for (const s of outcome.audience.sources) {
    lines.push(`  ${s.name}: ${s.total} (hash ${s.hash.slice(0, 12)}…)`);
  }
  lines.push(`  distintos (união): ${outcome.audience.distinctTotal}`);
  lines.push(`  sobreposição: ${outcome.audience.overlapCount}`);
  if (outcome.audience.overlapCount > 0) {
    lines.push("  BLOQUEANTE — presentes em >1 audiência de envio:");
    for (const o of maskSendAudiencesResultForJson(outcome.audience).overlaps) {
      lines.push(`    - ${o.email} (${o.sources.join(", ")})`);
    }
  }
  lines.push(`  órfãos (ativo em alguma plataforma, fora de toda audiência): ${outcome.orphans.length}`);
  if (outcome.orphans.length > 0) {
    lines.push("  BLOQUEANTE — órfãos:");
    for (const o of maskOrphansForJson(outcome.orphans)) {
      lines.push(`    - ${o.email} (ativo em: ${o.activeIn.join(", ")})`);
    }
  }
  lines.push("  destinatários reais do último envio por plataforma:");
  for (const r of outcome.recentDelivery) {
    lines.push(
      r.measured
        ? `    ${r.platform}: ${r.recipients}`
        : `    ${r.platform}: não medido (${r.reason})`,
    );
  }
  if (outcome.beehiivDeliveryGap) {
    const g = outcome.beehiivDeliveryGap;
    lines.push(
      g.ok
        ? `  gap de entrega Beehiiv: ${g.gap} (dentro da tolerância ${g.tolerated}) — normal.`
        : `  aviso: gap de entrega Beehiiv fora do normal — ${g.reason}`,
    );
  }
  lines.push(outcome.blocking ? "  VEREDITO: DIVERGE (bloqueante)." : "  VEREDITO: OK.");
  return lines.join("\n");
}

function emitError(asJson: boolean, message: string, code: "config" | "network"): void {
  process.stderr.write(`${message}\n`);
  if (asJson) {
    process.stdout.write(JSON.stringify({ error: { code, message }, decision: { exitCode: 2 } }, null, 2) + "\n");
  }
  process.exitCode = 2;
}

async function main(): Promise<void> {
  loadProjectEnv();
  const asJson = hasFlag(process.argv.slice(2), "json");

  const beehiivConfig = resolveBeehiivConfig();
  if (!beehiivConfig.ok) {
    emitError(asJson, `${LOG_PREFIX} config Beehiiv inválida: ${beehiivConfig.reason}`, "config");
    return;
  }
  const kitConfig = resolveKitConfig();
  if (!kitConfig.ok) {
    emitError(asJson, `${LOG_PREFIX} config Kit inválida: ${kitConfig.reason}`, "config");
    return;
  }
  const platformConfig = readPlatformConfig();
  const brevoApiKeyEnv = platformConfig.brevo_diaria?.api_key_env ?? "BREVO_DIARIA_API_KEY";
  const brevoApiKey = process.env[brevoApiKeyEnv];
  const brevoListId = platformConfig.brevo_diaria?.list_id;
  if (!brevoApiKey) {
    emitError(asJson, `${LOG_PREFIX} config Brevo inválida: env ${brevoApiKeyEnv} ausente.`, "config");
    return;
  }
  if (typeof brevoListId !== "number") {
    emitError(asJson, `${LOG_PREFIX} config Brevo inválida: platform.config.json → brevo_diaria.list_id ausente.`, "config");
    return;
  }
  const kitAudienceTag = platformConfig.kit_diaria?.audience_tag?.trim() || KIT_DEFAULT_AUDIENCE_TAG;

  let beehiivActiveEmails: string[];
  let kitAudienceEmails: string[];
  let brevoAudienceEmails: string[];
  try {
    process.stderr.write(`${LOG_PREFIX} buscando ativos na Beehiiv…\n`);
    beehiivActiveEmails = await fetchActiveBeehiivEmails(beehiivConfig.config.apiKey, beehiivConfig.config.publicationId);

    process.stderr.write(`${LOG_PREFIX} resolvendo tag "${kitAudienceTag}" no Kit…\n`);
    const tagId = await findTagIdByName(kitAudienceTag);
    if (tagId === null) {
      emitError(
        asJson,
        `${LOG_PREFIX} tag "${kitAudienceTag}" não existe no Kit — não foi possível medir a audiência de envio do Kit.`,
        "config",
      );
      return;
    }
    process.stderr.write(`${LOG_PREFIX} listando membros da tag "${kitAudienceTag}"…\n`);
    kitAudienceEmails = await listAllTagSubscriberEmails(tagId);

    process.stderr.write(`${LOG_PREFIX} listando contatos da lista Brevo ${brevoListId}…\n`);
    brevoAudienceEmails = await brevoListContacts(brevoApiKey, brevoListId);
  } catch (e) {
    emitError(asJson, `${LOG_PREFIX} falha de rede/API — não foi possível medir a audiência: ${(e as Error).message}`, "network");
    return;
  }

  const sources: EmailSource[] = [
    { name: "kit", emails: kitAudienceEmails },
    { name: "beehiiv", emails: beehiivActiveEmails },
    { name: "brevo", emails: brevoAudienceEmails },
  ];
  const audience = reconcileSendAudiences(sources);
  // Órfãos: ativo em alguma plataforma (aqui, mesmas 3 bases — a Beehiiv já
  // É audiência de envio, então active===sendAudience pra ela) e ausente de
  // toda audiência de envio.
  const orphans = findOrphans(sources, sources);

  process.stderr.write(`${LOG_PREFIX} medindo destinatários reais do último envio por plataforma…\n`);
  const recentDelivery = await Promise.all([
    measureBeehiivRecentDelivery(beehiivConfig.config.apiKey, beehiivConfig.config.publicationId),
    measureKitRecentDelivery(),
    measureBrevoRecentDelivery(brevoApiKey, brevoListId),
  ]);

  const outcome = decideOutcome(audience, orphans, recentDelivery, beehiivActiveEmails.length);

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          audience: maskSendAudiencesResultForJson(outcome.audience),
          orphans: maskOrphansForJson(outcome.orphans),
          recentDelivery: outcome.recentDelivery,
          beehiivDeliveryGap: outcome.beehiivDeliveryGap,
          decision: { exitCode: outcome.blocking ? 1 : 0, blocking: outcome.blocking },
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(formatReport(outcome) + "\n");
  }
  process.exitCode = outcome.blocking ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    emitError(hasFlag(process.argv.slice(2), "json"), `${LOG_PREFIX} erro fatal: ${(e as Error).message}`, "network");
  });
}
