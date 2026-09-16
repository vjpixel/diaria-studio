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
 *      **Nota (#7482, fleet review 16/09/2026):** com backend=kit, a fonte
 *      "kit" deste check passa a ser TODO ativo (ver item 1 acima), não só
 *      a tag — o universo de comparação cresce, então um número de
 *      sobreposição medido ANTES desta mudança não é comparável direto
 *      contra um medido DEPOIS (o segundo enxerga duplicatas
 *      Kit-ativo-fora-da-tag × Brevo que o primeiro deixava passar batido
 *      — mais correto, não uma regressão de medição).
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
import { listAllKitSubscribers } from "./lib/kit-subscribers.ts";
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
  publishing?: { newsletter?: { backend?: string } };
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
  /** #7482, condição simplificada pelo #8182 (16/09/2026): `true` quando o
   *  gap não foi calculado de propósito (backend=kit, independente da
   *  contagem de ativos residual na Beehiiv) — distingue de "não deu pra
   *  medir" (measured=false). */
  beehiivGapSkippedPostMigration: boolean;
  /** #7482 (achado do fleet review, 16/09/2026): `true` quando a audiência
   *  de envio do Kit foi medida como "todo ativo" em vez da tag `rampa-kit`
   *  — espelha `beehiivGapSkippedPostMigration` acima. Sem este campo, um
   *  consumidor do `--json` não conseguia distinguir "órfãos=0 porque a tag
   *  bateu de verdade" de "órfãos=0 porque pulei a tag e usei todo-ativo"
   *  sem reler `platform.config.json` por fora. */
  kitAudienceIsAllActive: boolean;
  blocking: boolean;
}

/**
 * Pura: decide se a audiência de ENVIO do Kit deve ser medida como "todo
 * assinante active" (`true`) em vez de "membros da tag `rampa-kit`"
 * (`false`) — #7482, achado 16/09/2026, ver comentário completo no call
 * site. A tag só reflete a audiência real enquanto o canal paralelo
 * `kit_diaria` (rampa incremental) está ligado; desde que o backend
 * principal virou "kit" (#7388, 04/09/2026), `publish-newsletter-kit.ts`
 * manda pra `buildAllSubscribersFilter()` — todo `active`, sem tag — e
 * nada mais alimenta a tag pra gente nova, então ela fica congelada
 * enquanto a base cresce, produzindo "órfãos" que na verdade recebem
 * normalmente.
 */
export function shouldUseAllActiveAsKitAudience(newsletterBackend?: string): boolean {
  return newsletterBackend === "kit";
}

export function decideOutcome(
  audience: ReturnType<typeof reconcileSendAudiences>,
  orphans: ReturnType<typeof findOrphans>,
  recentDelivery: RecentDeliveryMeasurement[],
  beehiivActiveCount: number,
  newsletterBackend?: string,
): GuardOutcome {
  const beehiivDelivery = recentDelivery.find((r) => r.platform === "beehiiv");
  // #7482 (decisão do editor, 10/09/2026), revisado pelo #8182 (16/09/2026):
  // com o canal principal já em "kit", a Beehiiv está decomissionada como
  // canal de ENVIO — `measureBeehiivRecentDelivery` lê o post mais recente
  // da Beehiiv, que fica CONGELADO no último envio de antes da migração
  // terminar (nada volta a publicar lá), então esse "destinatários reais" é
  // sempre um dado HISTÓRICO, nunca uma medição do canal atual. Comparar
  // esse resíduo contra a contagem de ativos ATUAL não faz sentido —
  // independente do valor exato do residual: a condição original exigia
  // `beehiivActiveCount === 0` (achado #8182, 16/09/2026: com 1 residual
  // ativo em vez de exatamente 0, a condição não disparava e o guard
  // reportava "inesperado, investigar" pra um estado que já era o esperado
  // pós-migração). `newsletterBackend === "kit"` sozinho já implica migração
  // DE FATO completa (#7386) — não uma transição gradual em que a Beehiiv
  // ainda estivesse enviando de verdade para uma base grande.
  const skipBeehiivGap = newsletterBackend === "kit";
  const beehiivDeliveryGap =
    !skipBeehiivGap && beehiivDelivery?.measured && typeof beehiivDelivery.recipients === "number"
      ? checkBeehiivDeliveryGap(beehiivActiveCount, beehiivDelivery.recipients)
      : null;
  const blocking = audience.overlapCount > 0 || orphans.length > 0;
  return {
    audience,
    orphans,
    recentDelivery,
    beehiivDeliveryGap,
    beehiivGapSkippedPostMigration: skipBeehiivGap,
    kitAudienceIsAllActive: shouldUseAllActiveAsKitAudience(newsletterBackend),
    blocking,
  };
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
  if (outcome.beehiivGapSkippedPostMigration) {
    lines.push(
      "  gap de entrega Beehiiv: não checado — backend=kit, Beehiiv decomissionada como canal de envio (decisão do editor, #7482/#8182).",
    );
  } else if (outcome.beehiivDeliveryGap) {
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
  const newsletterBackend = platformConfig.publishing?.newsletter?.backend;
  // #7482, achado 16/09/2026: a tag `rampa-kit` era a audiência de envio
  // REAL do Kit só enquanto `kit_diaria.enabled` estava `true` — a rampa
  // incremental por ondas, DESLIGADA em 04/09/2026 (#7388) quando o
  // backend principal virou "kit". Desde então, `publish-newsletter-kit.ts`
  // manda a edição pra `buildAllSubscribersFilter()` — TODO assinante
  // `active`, sem filtro de tag nenhum. Como nada mais taggeia gente nova
  // em `rampa-kit` (só `kit-diaria-stage5-dispatch.ts` fazia isso, e só
  // roda com `kit_diaria.enabled: true`), a tag ficou CONGELADA no
  // tamanho de 04/09 enquanto a base ativa cresce — o guard media
  // "órfãos" (ativo fora da audiência de envio) contra uma audiência que
  // não é mais a real, e o número só cresce (37 em 05/09, 299 em 16/09,
  // sempre a MESMA divergência, nunca resolvida por nenhum PR porque
  // nenhum PR jamais tocou este ponto — as duas rodadas anteriores
  // trataram isso como pendência de produto/mutação de audiência viva,
  // quando na verdade é o guard medindo a coisa errada). Com backend=kit,
  // a audiência de envio do Kit é `kitActiveEmails` (medido de qualquer
  // forma, ver comentário abaixo) — não a tag, que fica só como registro
  // histórico das ondas (mesmo racional do `kit_diaria.audience_tag_note`
  // em platform.config.json).
  const kitAudienceIsAllActive = shouldUseAllActiveAsKitAudience(newsletterBackend);

  let beehiivActiveEmails: string[];
  let kitAudienceEmails: string[];
  let kitActiveEmails: string[];
  let brevoAudienceEmails: string[];
  try {
    process.stderr.write(`${LOG_PREFIX} buscando ativos na Beehiiv…\n`);
    beehiivActiveEmails = await fetchActiveBeehiivEmails(beehiivConfig.config.apiKey, beehiivConfig.config.publicationId);

    // #7385 review: a base de ATIVOS do Kit (todo `state: "active"`, não só
    // a tag) é buscada À PARTE da audiência de envio (a tag) — é essa
    // DIFERENÇA entre as duas que `findOrphans` precisa pra achar o
    // cenário exato da issue (629 ativos, 280 na tag, 349 órfãos). Usar a
    // MESMA lista pras duas coisas (erro do 1º rascunho deste PR, achado no
    // self-review) faz `findOrphans` nunca encontrar órfão nenhum do lado
    // Kit — por construção, todo elemento de `activeIn` já estaria em
    // `sendUnion`, porque as duas listas seriam idênticas. **Isso segue
    // valendo com backend != "kit"** (ou se a rampa for religada, ver
    // `kit_diaria.enabled_note`) — só o caso `kitAudienceIsAllActive` acima
    // faz as duas listas convergirem de propósito, porque aí é a REALIDADE
    // que convergiu, não um bug de medição.
    process.stderr.write(`${LOG_PREFIX} buscando ativos no Kit…\n`);
    const kitActiveSubscribers = await listAllKitSubscribers(undefined, { status: "active" });
    kitActiveEmails = kitActiveSubscribers.map((s) => s.email_address);

    if (kitAudienceIsAllActive) {
      process.stderr.write(
        `${LOG_PREFIX} backend=kit — audiência de envio do Kit é TODO ativo (buildAllSubscribersFilter), não a tag "${kitAudienceTag}" — pulando lookup de tag.\n`,
      );
      kitAudienceEmails = kitActiveEmails;
    } else {
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
    }

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
  // Órfãos: ativo em alguma plataforma × audiência de ENVIO de cada
  // plataforma — as duas listas do lado Kit são DIFERENTES de propósito
  // (`kitActiveEmails` = todo `state: active`; `kitAudienceEmails` = só a
  // tag). Beehiiv usa a MESMA lista dos dois lados porque ali "ativo" JÁ É
  // "audiência de envio" por design (todo `active` recebe o post
  // principal, ver docstring do módulo) — não há um recorte menor.
  const activeSources: EmailSource[] = [
    { name: "kit", emails: kitActiveEmails },
    { name: "beehiiv", emails: beehiivActiveEmails },
  ];
  const orphans = findOrphans(activeSources, sources);

  process.stderr.write(`${LOG_PREFIX} medindo destinatários reais do último envio por plataforma…\n`);
  const recentDelivery = await Promise.all([
    measureBeehiivRecentDelivery(beehiivConfig.config.apiKey, beehiivConfig.config.publicationId),
    measureKitRecentDelivery(),
    measureBrevoRecentDelivery(brevoApiKey, brevoListId),
  ]);

  const outcome = decideOutcome(
    audience,
    orphans,
    recentDelivery,
    beehiivActiveEmails.length,
    platformConfig.publishing?.newsletter?.backend,
  );

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          audience: maskSendAudiencesResultForJson(outcome.audience),
          orphans: maskOrphansForJson(outcome.orphans),
          recentDelivery: outcome.recentDelivery,
          beehiivDeliveryGap: outcome.beehiivDeliveryGap,
          beehiivGapSkippedPostMigration: outcome.beehiivGapSkippedPostMigration,
          kitAudienceIsAllActive: outcome.kitAudienceIsAllActive,
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
