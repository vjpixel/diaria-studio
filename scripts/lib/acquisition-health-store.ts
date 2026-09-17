/**
 * acquisition-health-store.ts (#8243 item 2)
 *
 * Ponte store→`ChannelStats` para o alarme de saúde de aquisição
 * (`scripts/lib/acquisition-health.ts`), quando a fonte VIVA de assinantes
 * não é mais a Beehiiv (`subscriber_backend !== "beehiiv"`, hoje `"kit"`,
 * ver #7386/#7395). `computeChannelStats`/`detectAcquisitionHealthFindings`
 * continuam INTOCADOS — este módulo só produz o array de
 * `BeehiivBackupSubscriber`-shaped que eles já sabem consumir, lido do
 * store unificado (`scripts/lib/diaria-subscribers-db.ts`) em vez de um
 * snapshot congelado.
 *
 * ## A armadilha de coorte (viés de sobrevivente da migração em bloco)
 *
 * A migração de 04/09/2026 (#7386) copiou pro Kit só quem estava ATIVO na
 * Beehiiv — um canal antigo qualquer aparece com sobrevivência artificial
 * de ~100% no Kit não porque o canal é bom, mas porque só os sobreviventes
 * foram copiados (exemplo medido no corpo da #8243:
 * `www.alquimiaoperativa.news` tinha 257 cadastros na Beehiiv e aparece
 * 20/20 ativos no Kit). Incluir essas linhas no denominador de
 * sobrevivência infla o número tanto quanto o bug antigo (#8086) deflava —
 * os dois sentidos são fabricação, não vigilância real.
 *
 * `isMigratedFromBeehiiv` decide, por `subscription`, se a linha entrou
 * pelo funil nativo do Kit (conta) ou foi copiada da migração em bloco
 * (exclui). Critério, nesta ordem:
 *
 * 1. `origem_cadastro === "beehiiv-sync"` (`KIT_BEEHIIV_SYNC_SIGNUP_MARKER`,
 *    `sync-beehiiv-subscribers-kit.ts`) → migrada, exclui.
 * 2. `origem_cadastro` é `"kit-nativo"` ou `"brevo-diaria-score"` (os 2
 *    outros marcadores de `kit-signup-origin.ts`) → nativa, conta.
 * 3. Sem marcador nenhum (a maioria das linhas hoje — `origem_cadastro`
 *    só começou a ser gravado por parte dos caminhos, ver
 *    `kit-signup-origin.ts`): fallback por DATA, declarado aqui, não
 *    inferido em silêncio — `entered_at >= KIT_BULK_MIGRATION_CUTOFF_ISO`
 *    (04/09/2026, data da migração #7386) → nativa, conta; antes disso →
 *    migrada, exclui. `origem_serie` NÃO serve para este fallback: a
 *    ingestão do roster (`diaria-subscribers-ingest-kit.ts`) grava
 *    `"kit-vivo"` em TODA linha do roster, migradas inclusive — não
 *    distingue proveniência (achado do corpo da #8243).
 * 4. `entered_at` ausente/inválido → não dá para aplicar o fallback acima;
 *    trata como migrada (exclui) por precaução — o princípio que não pode
 *    regredir aqui é "fonte sem dado vira 'sem dado' visível, nunca um
 *    número plausível" (#8243, citando o próprio #8086): incluir uma linha
 *    de proveniência desconhecida no denominador arriscaria inflar a
 *    sobrevivência do mesmo jeito que o bug original a zerava.
 *
 * ## CTR por canal — suprimido de propósito, não calculado (#8236)
 *
 * O corpo da #8243 já documenta que o CTR por canal sobre o store dá 0
 * recebidas para TODO cadastro Kit nativo, porque os eventos do Kit hoje
 * ficam presos num alias sem `external_id` (#8236, identidade partida) —
 * diferente do `subscriber_id` da inscrição do roster. Em vez de duplicar
 * o cálculo de `total_received`/`total_unique_clicked` aqui (um "3º
 * leitor", que o corpo da issue pede para não escrever — a leitura de
 * recebidas/cliques já vive em `leitor-store.ts`), este módulo deixa
 * `stats` em `{ total_received: 0, total_unique_clicked: 0 }` para toda
 * linha — o mesmo resultado que `computeStoreLeitorInputCanonicalDedup`
 * daria hoje (0 recebidas, #8236), só sem pagar o custo de reconstruir a
 * timeline por assinante. `computeChannelStats` já trata isso como
 * `amostraVazia` (guard existente, nenhum código novo aqui) — o efeito
 * observável é `ctr_abaixo_base` nunca disparar enquanto #8236 não for
 * corrigido. O caller (`check-acquisition-health.ts`) loga isso
 * explicitamente uma vez por rodada ("CTR suprimido: identidade partida"),
 * para não calar a limitação (#8243 pede registro, não silêncio). Quando
 * #8236 for corrigido, a correção entra aqui trocando os zeros por uma
 * chamada real a `computeStoreLeitorInputCanonicalDedup` — sem mudar a
 * forma do módulo.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  getAllAliasesBySubscriber,
  getAllSubscriptionsBySubscriber,
  getSubscriptionAsOf,
  resolveSubscriberAttribution,
  type Platform,
  type SubscriptionRecord,
} from "./diaria-subscribers-db.ts";
import type { BeehiivBackupSubscriber } from "./beehiiv-backup-snapshots.ts";
import {
  KIT_NATIVE_SIGNUP_MARKER,
  KIT_SCORE_PROMOTION_SIGNUP_MARKER,
  KIT_BEEHIIV_SYNC_SIGNUP_MARKER,
} from "./shared/kit-signup-origin.ts";

/** Data da migração em bloco Beehiiv → Kit (#7386/#7395) — cutoff do
 *  fallback por data de `isMigratedFromBeehiiv` (ver docstring do módulo). */
export const KIT_BULK_MIGRATION_CUTOFF_ISO = "2026-09-04T00:00:00.000Z";

/** Idade máxima (dias) de `getSubscriptionAsOf` antes do store ser tratado
 *  como sem captura recente — mesmo piso de `beehiiv-backup-staleness-alarm.ts`
 *  (`maxAgeDays` default 7, cadência semanal desta task). "Não avaliar e
 *  não avançar o state" (#8243, mesma regra do #5281) quando o store estiver
 *  mais velho que isto. */
export const STORE_STALENESS_MAX_DAYS = 7;

/** Pure: decide se `sub` (1 linha `subscription` de plataforma Kit) veio da
 *  migração em bloco da Beehiiv (exclui do denominador de sobrevivência) ou
 *  entrou nativamente (conta). Ver docstring do módulo para os 4 passos. */
export function isMigratedFromBeehiiv(
  sub: Pick<SubscriptionRecord, "origem_cadastro" | "entered_at">,
): boolean {
  if (sub.origem_cadastro === KIT_BEEHIIV_SYNC_SIGNUP_MARKER) return true;
  if (sub.origem_cadastro === KIT_NATIVE_SIGNUP_MARKER || sub.origem_cadastro === KIT_SCORE_PROMOTION_SIGNUP_MARKER) {
    return false;
  }
  // Sem marcador — fallback por data (#8243), declarado, não inferido.
  if (!sub.entered_at) return true; // sem proveniência confiável — exclui (precaução).
  const enteredMs = Date.parse(sub.entered_at);
  if (!Number.isFinite(enteredMs)) return true;
  return enteredMs < Date.parse(KIT_BULK_MIGRATION_CUTOFF_ISO);
}

export interface StoreChannelReadResult {
  /** Assinantes NATIVOS (não migrados) das `platforms` cobertas, no formato
   *  que `computeChannelStats` já consome — pronto para passar direto. */
  subscribers: BeehiivBackupSubscriber[];
  /** Total de `subscription` nas `platforms` cobertas, migradas ou não —
   *  para log/diagnóstico (não entra em nenhum cálculo). */
  totalSubscriptions: number;
  /** Quantas linhas foram excluídas por `isMigratedFromBeehiiv`. */
  excludedMigrated: number;
  /** `getSubscriptionAsOf` sobre as `platforms` cobertas — frescor do
   *  store, para o caller decidir se avalia ou não (ver
   *  `STORE_STALENESS_MAX_DAYS`). `null` se `subscription` não tem
   *  nenhuma linha ainda nessas plataformas. */
  asOf: string | null;
}

/**
 * Lê o store unificado e devolve os assinantes NATIVOS (excluindo a
 * migração em bloco da Beehiiv) de `platforms`, no formato consumido por
 * `computeChannelStats`. `created` vem de `entered_at` (epoch segundos);
 * `utm_source`/`referring_site` vêm de `resolveSubscriberAttribution`
 * (mesma precedência kit > beehiiv > brevo_diaria de #7207) — mas como só
 * `platforms` entra no scan, na prática só a `subscription` dessa(s)
 * plataforma(s) é considerada. `stats` sempre `{0, 0}` — ver docstring do
 * módulo, seção CTR.
 */
export function buildKitChannelSubscribersFromStore(
  db: DatabaseSync,
  platforms: readonly Platform[] = ["kit"],
): StoreChannelReadResult {
  const asOf = getSubscriptionAsOf(db, platforms);
  const subscriptionsBySubscriber = getAllSubscriptionsBySubscriber(db);
  const aliasesBySubscriber = getAllAliasesBySubscriber(db);
  const platformSet = new Set<Platform>(platforms);

  const subscribers: BeehiivBackupSubscriber[] = [];
  let totalSubscriptions = 0;
  let excludedMigrated = 0;

  for (const [subscriberId, subs] of subscriptionsBySubscriber) {
    const covered = subs.filter((s) => platformSet.has(s.platform));
    if (covered.length === 0) continue;
    totalSubscriptions += covered.length;

    // Migrada se QUALQUER subscription coberta for migrada — uma pessoa
    // com >1 subscription nas `platforms` avaliadas (hoje só "kit", então
    // isto é sempre exatamente 1 linha) não deveria acontecer na prática,
    // mas o critério conservador (excluir se qualquer linha for migrada)
    // evita contar uma pessoa cuja origem real é ambígua.
    if (covered.some((s) => isMigratedFromBeehiiv(s))) {
      excludedMigrated += covered.length;
      continue;
    }

    const aliases = aliasesBySubscriber.get(subscriberId) ?? [];
    const email = aliases.find((a) => a.email)?.email;
    if (!email) continue; // sem email, sem registro — mesmo critério de leitor-store.ts.

    // status: entre as linhas cobertas, a mais recente por `updated_at`
    // vence — hoje só há 1 linha coberta na prática (plataforma única).
    const primary = [...covered].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0];
    const attribution = resolveSubscriberAttribution(covered);
    const enteredMs = covered
      .map((s) => s.entered_at)
      .filter((v): v is string => typeof v === "string")
      .map((v) => Date.parse(v))
      .filter((ms) => Number.isFinite(ms));
    const created = enteredMs.length > 0 ? Math.floor(Math.min(...enteredMs) / 1000) : 0;

    subscribers.push({
      email,
      status: primary.status ?? "",
      created,
      utm_source: attribution.utmSource ?? "",
      utm_medium: attribution.utmMedium ?? "",
      utm_campaign: attribution.utmCampaign ?? "",
      referring_site: attribution.referringSite ?? "",
      // #8236 — ver docstring do módulo. Deixa a métrica de CTR suprimida
      // (amostraVazia) em vez de fabricar um número de uma leitura de
      // identidade quebrada.
      stats: { total_received: 0, total_unique_clicked: 0 },
    });
  }

  return { subscribers, totalSubscriptions, excludedMigrated, asOf };
}

/** Pure: `true` quando `asOf` (ISO) está mais velho que `maxAgeDays` dias em
 *  relação a `nowMs`, ou é `null` (store sem nenhuma captura ainda —
 *  tratado como "sem dado", não como "fresco"). */
export function isStoreStale(
  asOf: string | null,
  nowMs: number = Date.now(),
  maxAgeDays: number = STORE_STALENESS_MAX_DAYS,
): boolean {
  if (asOf == null) return true;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return true;
  const ageDays = (nowMs - asOfMs) / 86_400_000;
  return ageDays > maxAgeDays;
}
