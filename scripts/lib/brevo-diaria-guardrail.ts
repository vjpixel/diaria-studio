/**
 * brevo-diaria-guardrail.ts (#4476 item 9 — "Circuit breakers de campanha")
 *
 * Camada DIFERENTE do score por-contato (`brevo-diaria-score.ts`, itens 1/2
 * da issue) — este módulo avalia a saúde AGREGADA dos envios da campanha
 * `brevo_diaria` (não decide sobre 1 pessoa) e decide se o ROLLOUT INTEIRO
 * (o backfill contínuo de `sync-pending-to-brevo.ts`, item 5) deve pausar.
 *
 * Mesmos limiares já usados no ramp Clarice (issue #4476, seção "Rollout em
 * canário", números fechados 260802): abertura <15%, bounce duro ≥2%, bounce
 * total ≥5%, spam ≥0,1%, unsub ≥3%. Reusa `evaluateArmGuardrails`/
 * `DEFAULT_HEALTH_THRESHOLDS`/`CTA_SPAM_BREACH_YELLOW_PCT`
 * (`workers/brevo-dashboard/src/experiment-cta.ts`+`thresholds.ts`) — a MESMA
 * fonte única de limiar que `clarice-guardrail-alarm.ts` já usa pro alarme do
 * ramp Clarice, sem reimplementar nenhum número aqui.
 *
 * ## Abertura é INFORMATIVA, não pausa (texto literal da issue)
 *
 * "Furar o piso de abertura no primeiro lote é resultado esperado de uma
 * cohort fria de 7+ meses (não é fracasso, é informação) — mas qualquer
 * breaker de bounce/spam deve pausar o rollout até o editor decidir." —
 * `shouldPauseRollout` abaixo deliberadamente IGNORA `openBreach` na decisão
 * de pausar (mas o resultado completo, incluindo `openBreach`, continua
 * disponível pro relatório/e-mail de alarme — `describeBreaches`, reusada de
 * `clarice-guardrail-alarm.ts`, já lista todos os breaches, não só os que
 * pausam).
 *
 * ## Latch, não sensor contínuo — "até o editor decidir"
 *
 * Uma vez pausado, o estado NUNCA despausa sozinho numa checagem seguinte
 * (mesmo que a próxima checagem volte a ficar toda verde) — a issue pede
 * explicitamente "pausa o rollout até o editor decidir". Só
 * `unpauseRollout` (ação explícita, tipicamente disparada por
 * `--unpause` no script orquestrador) limpa o estado. `applyGuardrailCheck`
 * abaixo é a função pura que implementa esse latch.
 *
 * ## Sem dado ainda não é sinal (`campaignCount === 0`)
 *
 * `evaluateBrevoDiariaRolloutGuardrail` retorna `null` quando não há nenhuma
 * campanha agregada — nunca avalia `evaluateArmGuardrails` sobre
 * `sent=delivered=0` (que combinado com `treatZeroAsBreach: true` casaria
 * como falha total de entrega por engano). `applyGuardrailCheck` trata
 * `null` como "sem dado suficiente pra decidir" — atualiza só o timestamp de
 * última checagem, nunca pausa nem despausa a partir de ausência de dado.
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateArmGuardrails,
  type ArmGuardrailResult,
} from "../../workers/brevo-dashboard/src/experiment-cta.ts";
import { DEFAULT_HEALTH_THRESHOLDS, type HealthThresholds } from "../../workers/brevo-dashboard/src/thresholds.ts";
import { describeBreaches, type CampaignGuardrailInput } from "./clarice-guardrail-alarm.ts";
import { writeFileAtomic } from "./atomic-write.ts";

export type { CampaignGuardrailInput };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ─── Agregação pura (soma N campanhas → 1 conjunto de contadores) ─────────

export interface AggregatedBrevoDiariaStats {
  campaignCount: number;
  sent: number;
  delivered: number;
  uniqueViews: number;
  unsubscriptions: number;
  complaints: number;
  hardBounces: number;
  softBounces: number;
}

/**
 * Pura — soma os contadores brutos de N campanhas enviadas pela conta
 * `brevo_diaria` (dedicada, distinta de `brevo_monthly`/Clarice — mesma
 * conta cuja API key é `platform.config.json → brevo_diaria.api_key_env`).
 * Lista vazia → todos os campos zerados, `campaignCount: 0` (ver "Sem dado
 * ainda não é sinal" no header do módulo).
 */
export function aggregateBrevoDiariaCampaignStats(
  campaigns: readonly CampaignGuardrailInput[],
): AggregatedBrevoDiariaStats {
  const acc: AggregatedBrevoDiariaStats = {
    campaignCount: 0,
    sent: 0,
    delivered: 0,
    uniqueViews: 0,
    unsubscriptions: 0,
    complaints: 0,
    hardBounces: 0,
    softBounces: 0,
  };
  for (const c of campaigns) {
    acc.campaignCount += 1;
    acc.sent += c.sent;
    acc.delivered += c.delivered;
    acc.uniqueViews += c.uniqueViews;
    acc.unsubscriptions += c.unsubscriptions;
    acc.complaints += c.complaints;
    acc.hardBounces += c.hardBounces;
    acc.softBounces += c.softBounces;
  }
  return acc;
}

/**
 * Pura — avalia o guardrail agregado. `null` se `campaigns` estiver vazia
 * (nenhuma campanha enviada ainda pela conta `brevo_diaria` — sem dado
 * suficiente pra decidir qualquer coisa, ver header do módulo).
 *
 * `treatZeroAsBreach: true` (mesmo racional de `evaluateSendGuardrails` em
 * `clarice-guardrail-alarm.ts`): diferente do path original da dashboard
 * (pensado pra minutos pós-envio, quando 0% pode ser só MPP ainda
 * propagando), esta função é chamada por um job que roda periodicamente
 * sobre dado JÁ existente — 0% de abertura agregada é sinal real (embora,
 * pela decisão da issue, só INFORMATIVO — não pausa sozinho, ver
 * `shouldPauseRollout`).
 */
export interface BrevoDiariaGuardrailEvaluation {
  result: ArmGuardrailResult;
  /** `aggregateBrevoDiariaCampaignStats(campaigns).campaignCount` — carregado
   * à parte porque `ArmGuardrailResult` (tipo compartilhado com o dashboard)
   * não tem esse campo. Consumido por `applyGuardrailCheck` pra persistir
   * `last_campaign_count` no estado. */
  campaignCount: number;
}

export function evaluateBrevoDiariaRolloutGuardrail(
  campaigns: readonly CampaignGuardrailInput[],
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): BrevoDiariaGuardrailEvaluation | null {
  const agg = aggregateBrevoDiariaCampaignStats(campaigns);
  if (agg.campaignCount === 0) return null;
  const result = evaluateArmGuardrails(
    {
      armId: "brevo_diaria_rollout",
      label: "brevo_diaria (agregado)",
      campaignCount: agg.campaignCount,
      sent: agg.sent,
      delivered: agg.delivered,
      uniqueViews: agg.uniqueViews,
      uniqueClicks: 0,
      decisionClicks: 0,
      unsubscriptions: agg.unsubscriptions,
      complaints: agg.complaints,
      hardBounces: agg.hardBounces,
      softBounces: agg.softBounces,
    },
    thresholds,
    { treatZeroAsBreach: true },
  );
  return { result, campaignCount: agg.campaignCount };
}

/**
 * Pura — decide se o resultado exige PAUSAR o rollout. Deliberadamente
 * ignora `openBreach` (issue #4476: "furar o piso de abertura ... não é
 * fracasso, é informação" — cohort fria, esperado). Bounce (hard OU total),
 * spam, e unsub são os 3 breakers que pausam — "qualquer breaker de
 * bounce/spam deve pausar o rollout até o editor decidir" (unsub incluído
 * pelo mesmo espírito: é dano observável à base, não ruído de amostra fria
 * como abertura baixa).
 */
export function shouldPauseRollout(result: ArmGuardrailResult): boolean {
  return result.bounceBreach || result.spamBreach || result.unsubBreach;
}

/** Re-exporta `describeBreaches` — mesmo texto/limiar usado no alarme do
 * ramp Clarice, sem duplicar formatação aqui. */
export { describeBreaches };

// ─── Estado persistido (latch) ─────────────────────────────────────────────

export interface RolloutGuardrailState {
  rollout_paused: boolean;
  /** ISO — `null` se nunca pausado (ou já despausado explicitamente). */
  paused_at: string | null;
  /** Saída de `describeBreaches` no momento em que pausou — `null` se nunca pausado. */
  paused_reason: string[] | null;
  /** ISO da última checagem que rodou (independente do resultado). `null` se nunca checado. */
  last_checked_at: string | null;
  /** `campaignCount` agregado na última checagem com dado suficiente. */
  last_campaign_count: number;
}

export function emptyRolloutGuardrailState(): RolloutGuardrailState {
  return {
    rollout_paused: false,
    paused_at: null,
    paused_reason: null,
    last_checked_at: null,
    last_campaign_count: 0,
  };
}

/**
 * Pura — transição de estado (latch, ver header do módulo). 3 casos:
 *
 * 1. `result === null` (sem dado suficiente): só atualiza `last_checked_at`,
 *    nunca muda `rollout_paused` nem `last_campaign_count`.
 * 2. `state.rollout_paused === true` (já pausado): permanece pausado
 *    INDEPENDENTE do novo resultado — só `unpauseRollout` limpa. Atualiza
 *    `last_checked_at`/`last_campaign_count` (útil pro editor ver que a
 *    checagem continua rodando mesmo pausado).
 * 3. `state.rollout_paused === false` E `shouldPauseRollout(result)`:
 *    transiciona pra pausado, grava `paused_at`/`paused_reason` (o motivo
 *    NA HORA da transição — não recalculado depois).
 * 4. Caso contrário (não pausado, resultado saudável ou só `openBreach`):
 *    permanece despausado, atualiza timestamps.
 */
export function applyGuardrailCheck(
  state: RolloutGuardrailState,
  evaluation: BrevoDiariaGuardrailEvaluation | null,
  now: Date,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): RolloutGuardrailState {
  const nowIso = now.toISOString();
  if (evaluation === null) {
    return { ...state, last_checked_at: nowIso };
  }
  const { result, campaignCount } = evaluation;
  if (state.rollout_paused) {
    return { ...state, last_checked_at: nowIso, last_campaign_count: campaignCount };
  }
  if (shouldPauseRollout(result)) {
    return {
      rollout_paused: true,
      paused_at: nowIso,
      paused_reason: describeBreaches(result, thresholds),
      last_checked_at: nowIso,
      last_campaign_count: campaignCount,
    };
  }
  return { ...state, last_checked_at: nowIso, last_campaign_count: campaignCount };
}

/** Pura — limpa o latch (ação explícita do editor, ex: `--unpause`). Nunca
 * chamada automaticamente por `applyGuardrailCheck`. */
export function unpauseRollout(state: RolloutGuardrailState, now: Date): RolloutGuardrailState {
  return {
    ...state,
    rollout_paused: false,
    paused_at: null,
    paused_reason: null,
    last_checked_at: now.toISOString(),
  };
}

// ─── I/O (leitura/escrita do estado em disco) ──────────────────────────────

/** Mesmo diretório de `brevo-diaria-store.ts` (`data/brevo-diaria/`) — dado
 * business-sensitive, fora do repo via `.gitignore` blanket de `data/`. */
export const DEFAULT_GUARDRAIL_STATE_PATH = resolve(ROOT, "data/brevo-diaria/guardrail-state.json");

/**
 * I/O — fail-soft (mesma disciplina de `readStore`/`brevo-diaria-store.ts`):
 * arquivo ausente OU malformado → estado vazio (nunca pausado), nunca lança.
 * Um JSON corrompido nunca deveria travar o rollout "por acidente" nem
 * mascarar uma pausa real — se o arquivo existe mas não parseia, o caller
 * trata como "nunca pausado", que é o estado mais conservador pro CALLER
 * de `sync-pending-to-brevo.ts` (não bloqueia por engano) — o PRÓPRIO
 * `check-brevo-diaria-guardrail.ts`, ao rodar de novo, reavalia e persiste
 * um estado válido na próxima execução.
 */
export function readRolloutGuardrailState(path: string = DEFAULT_GUARDRAIL_STATE_PATH): RolloutGuardrailState {
  if (!existsSync(path)) return emptyRolloutGuardrailState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw?.rollout_paused !== "boolean") return emptyRolloutGuardrailState();
    return {
      rollout_paused: raw.rollout_paused,
      paused_at: typeof raw.paused_at === "string" ? raw.paused_at : null,
      paused_reason: Array.isArray(raw.paused_reason) ? raw.paused_reason.map(String) : null,
      last_checked_at: typeof raw.last_checked_at === "string" ? raw.last_checked_at : null,
      last_campaign_count: typeof raw.last_campaign_count === "number" ? raw.last_campaign_count : 0,
    };
  } catch {
    return emptyRolloutGuardrailState();
  }
}

/** I/O — escrita atômica (`writeFileAtomic`, mesmo padrão do resto do
 * pipeline) + cria o diretório pai se ainda não existir (1ª execução). */
export function writeRolloutGuardrailState(
  state: RolloutGuardrailState,
  path: string = DEFAULT_GUARDRAIL_STATE_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
}
