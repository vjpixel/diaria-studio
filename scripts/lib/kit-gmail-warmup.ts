/**
 * kit-gmail-warmup.ts (#6504 item 2)
 *
 * Miolo PURO da rampa de aquecimento Gmail do canal `kit_diaria` —
 * `scripts/kit-gmail-warmup-ramp.ts` é a casca de I/O (fetch Kit/Beehiiv,
 * leitura/escrita de estado, mutação real via `--push`). Tudo aqui é
 * determinístico e testável sem rede/disco.
 *
 * ## O problema que este módulo resolve (contexto — #6504)
 *
 * A edição 260827 disparou 594 mensagens pelo Kit; o Gmail recusou 343 na
 * porta (soft bounce de reputação de domínio novo, não lista podre — ver
 * `scripts/lib/provider-split.ts`). A onda 1 do canal `kit_diaria`
 * (`platform.config.json` → `kit_diaria.audience_tag_note`) já reagiu a isso
 * promovendo os 81 endereços que ENGAJARAM no envio de 27/08 — mas essa
 * coorte é auto-selecionada por entregabilidade (quem engajou já tinha sido
 * aceito pelo Gmail) e não diz nada sobre os ~311 endereços Gmail que o
 * Google recusou e ainda não voltaram. Este módulo decide, a cada rodada, a
 * PRÓXIMA fatia desses recusados que pode ser promovida — em ondas de volume
 * crescente, gated pelo mesmo veredito de entrega (`avaliarRampa`,
 * `provider-split.ts`) que já governa a tag.
 *
 * ## Por que só ADITIVO (nunca remove ninguém do envio)
 *
 * A tag `kit_diaria.audience_tag` já reflete, por construção, só quem deve
 * receber a edição de hoje — cada onda é o editor decidindo/ampliando essa
 * tag deliberadamente (histórico completo na nota de config). Este módulo
 * nunca tenta EXCLUIR ninguém dela: ele só decide QUEM ENTRA na próxima
 * onda, com `tagSubscriber` (idempotente, sem risco de remover por engano
 * quem já está incluído). Evita depender de um endpoint de remoção de tag
 * não confirmado ao vivo contra a API v4 do Kit.
 *
 * ## Por que o gate consome `avaliarRampa`, não um cálculo próprio
 *
 * O piso de entrega/abertura Gmail (#6505, `RAMPA_GMAIL_DELIVERY_RATE_FLOOR_PCT`/
 * `RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT`) já é o veredito oficial da rampa,
 * citado por nome em `platform.config.json`. Reusar em vez de duplicar
 * mantém as DUAS decisões (a que já existe hoje na tag, e a que este módulo
 * propõe pra amanhã) sob o mesmo critério — divergir seria o tipo de bug
 * que só aparece quando alguém compara os dois manualmente.
 */

import { classifyProvider } from "./provider-split.ts";
import type { RampaVeredito } from "./provider-split.ts";

/** Tamanho da 1ª onda quando ainda não houve nenhuma onda PUSHADA. Decisão
 *  editorial deliberadamente modesta — mesma ordem de grandeza da onda 1 real
 *  do canal (81 endereços), não uma fração arbitrária do total recusado. */
export const WARMUP_INITIAL_WAVE_SIZE = 20;

/** Fator de crescimento por onda bem-sucedida (dobra) — mesmo espírito do
 *  crescimento geométrico de `computeWeekPlan` (Clarice, `weekly-plan.ts`),
 *  sem replicar a lógica de lá (públicos/pisos diferentes). */
export const WARMUP_GROWTH_FACTOR = 2;

/**
 * Endereços Gmail que foram ENVIADOS mas não ENTREGUES num broadcast —
 * exatamente o conjunto que #6504 chama de "recusados na porta". Pura,
 * normaliza (trim + caixa baixa) e deduplica; ordena alfabeticamente pra
 * seleção determinística de onda em onda (2 rodadas com o mesmo input
 * escolhem os mesmos primeiros N endereços).
 */
export function computeGmailRejectedEmails(
  sent: readonly string[],
  delivered: readonly string[],
): string[] {
  const deliveredSet = new Set(delivered.map((e) => e.trim().toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of sent) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (classifyProvider(email) !== "Gmail") continue;
    if (deliveredSet.has(email)) continue;
    out.push(email);
  }
  out.sort();
  return out;
}

/**
 * Tamanho da PRÓXIMA onda — geométrico, capado pelo que resta.
 *
 * `lastWaveSize` é o tamanho da última onda de fato PUSHADA (não a última
 * proposta — uma proposta recusada pelo gate, ou nunca empurrada porque a
 * invocação foi `--dry-run`, não faz a rampa crescer). `null` = nenhuma onda
 * pushada ainda → usa `WARMUP_INITIAL_WAVE_SIZE`.
 *
 * `lastWaveSize <= 0` é tratado como equivalente a `null` (#6566) — uma onda
 * histórica com `size: 0` (ex: `safeToTag` saiu vazio porque os endereços
 * ainda estavam ativos na Beehiiv, ou a config da Beehiiv estava
 * indisponível) NUNCA deve travar a progressão geométrica: `0 *
 * WARMUP_GROWTH_FACTOR = 0` é um estado absorvente — toda rodada seguinte
 * recalcularia 0 pra sempre, silenciosamente, sem parecer um deadlock.
 * Reiniciar em `WARMUP_INITIAL_WAVE_SIZE` é seguro porque `size: 0` nunca
 * significa "onda pequena de verdade" — significa "nada foi de fato
 * taggeado nessa rodada".
 */
export function computeNextWaveSize(
  remaining: number,
  lastWaveSize: number | null,
): number {
  if (remaining <= 0) return 0;
  const effectiveLastWaveSize = lastWaveSize != null && lastWaveSize > 0 ? lastWaveSize : null;
  const base = effectiveLastWaveSize == null ? WARMUP_INITIAL_WAVE_SIZE : effectiveLastWaveSize * WARMUP_GROWTH_FACTOR;
  return Math.min(base, remaining);
}

export interface PlanNextWaveInput {
  /** Cohort completo recusado (imutável — capturado 1x na 1ª rodada). */
  rejectedEmails: readonly string[];
  /** União de todas as ondas já PUSHADAS (nunca as só propostas). */
  alreadyReturned: ReadonlySet<string>;
  /** Tamanho da última onda pushada, ou `null` se nenhuma ainda. */
  lastWaveSize: number | null;
  /** Veredito da rampa medido no broadcast mais recente. */
  gate: RampaVeredito;
}

export interface WavePlan {
  emails: string[];
  size: number;
  /** `true` quando o gate mandou SEGURAR — `emails`/`size` vêm vazios/zero. */
  skipped: boolean;
  /** Motivo em 1 linha — do gate quando `skipped`, descritivo caso contrário. */
  reason: string;
}

/**
 * Decide a próxima onda: SEGURA se o gate mandar segurar (nunca cresce
 * às cegas — mesma disciplina de `avaliarRampa`), senão seleciona os
 * próximos N endereços (ordem estável de `computeGmailRejectedEmails`)
 * ainda não devolvidos.
 */
export function planNextWave(input: PlanNextWaveInput): WavePlan {
  const { rejectedEmails, alreadyReturned, lastWaveSize, gate } = input;

  if (!gate.podeCrescer) {
    return { emails: [], size: 0, skipped: true, reason: gate.motivo };
  }

  const pending = rejectedEmails.filter((e) => !alreadyReturned.has(e));
  const size = computeNextWaveSize(pending.length, lastWaveSize);
  if (size === 0) {
    return {
      emails: [],
      size: 0,
      skipped: true,
      reason:
        pending.length === 0
          ? "todos os endereços recusados já foram devolvidos — nada a propor."
          : "tamanho de onda calculado em zero.",
    };
  }
  return {
    emails: pending.slice(0, size),
    size,
    skipped: false,
    reason: `gate OK (${gate.motivo}) — onda de ${size} de ${pending.length} restante(s).`,
  };
}

/**
 * Separa uma onda proposta em quem é seguro taguear AGORA (não está ativo
 * na Beehiiv — taguear no Kit não duplica nada) e quem exige o passo MANUAL
 * de desativação na Beehiiv primeiro (`kit_diaria.audience_tag_note`:
 * "não existe automação que desative na Beehiiv quem ganha a tag no Kit").
 * Pura — recebe o conjunto de ativos da Beehiiv já normalizado (a coleta ao
 * vivo é responsabilidade do caller).
 */
export function partitionByBeehiivActive(
  emails: readonly string[],
  activeBeehiivEmails: ReadonlySet<string>,
): { safeToTag: string[]; needsBeehiivDeactivation: string[] } {
  const safeToTag: string[] = [];
  const needsBeehiivDeactivation: string[] = [];
  for (const email of emails) {
    if (activeBeehiivEmails.has(email.trim().toLowerCase())) needsBeehiivDeactivation.push(email);
    else safeToTag.push(email);
  }
  return { safeToTag, needsBeehiivDeactivation };
}

/**
 * Resolve a partição Beehiiv considerando também o caso "config Beehiiv
 * indisponível" — extraído de `runWarmupRamp` (fleet review, #6504) pra
 * ficar testável sem rede: quando `beehiivCfgOk` é `false`, TODOS os
 * e-mails da onda vão pra `needsBeehiivDeactivation` (nada é tagueado) —
 * falha segura, nunca duplica envio. É o guard central que impede taguear
 * alguém ainda ativo na Beehiiv quando a checagem em si não pôde rodar.
 */
export function resolveWarmupBeehiivPartition(
  emails: readonly string[],
  beehiivCfgOk: boolean,
  activeBeehiivEmails: ReadonlySet<string>,
): { safeToTag: string[]; needsBeehiivDeactivation: string[] } {
  return beehiivCfgOk
    ? partitionByBeehiivActive(emails, activeBeehiivEmails)
    : { safeToTag: [], needsBeehiivDeactivation: [...emails] };
}

// ---------------------------------------------------------------------------
// Estado persistido — `data/kit-gmail-warmup/state.json` (default)
// ---------------------------------------------------------------------------

export interface KitGmailWarmupWave {
  index: number;
  decidedAt: string;
  /** Broadcast usado pra medir o gate desta onda. */
  gateBroadcastId: number;
  gateVerdict: "podeCrescer" | "segurar";
  gateMotivo: string;
  size: number;
  emails: string[];
  needsBeehiivDeactivation: string[];
  /** `false` = só proposta (dry-run) — não conta pra `alreadyReturned`/`lastWaveSize`. */
  pushed: boolean;
  /**
   * Subconjunto de `emails` cuja releitura pós-`tagSubscriber`
   * (`listSubscriberTags`) NÃO confirmou a tag — mutação respondeu 2xx mas a
   * confirmação (ver "Armadilhas da API v4" em `kit-client.ts`) não bateu.
   * Continuam contando em `returnedEmails` (a mutação foi tentada e aceita)
   * mas ficam marcados aqui pra auditoria/retry manual. Vazio no caminho
   * normal.
   */
  unverifiedEmails: string[];
}

export interface KitGmailWarmupState {
  /** Broadcast cujo par sent/delivered definiu o cohort recusado — imutável. */
  referenceBroadcastId: number;
  capturedAt: string;
  totalRejected: number;
  rejectedEmails: string[];
  waves: KitGmailWarmupWave[];
}

export const DEFAULT_KIT_GMAIL_WARMUP_STATE_PATH = "data/kit-gmail-warmup/state.json";

/** União dos e-mails de todas as ondas PUSHADAS. Pura. */
export function returnedEmails(state: KitGmailWarmupState): Set<string> {
  const out = new Set<string>();
  for (const wave of state.waves) {
    if (!wave.pushed) continue;
    for (const email of wave.emails) out.add(email);
  }
  return out;
}

/** Tamanho da última onda PUSHADA, ou `null` se nenhuma ainda. Pura. */
export function lastPushedWaveSize(state: KitGmailWarmupState): number | null {
  for (let i = state.waves.length - 1; i >= 0; i--) {
    if (state.waves[i].pushed) return state.waves[i].size;
  }
  return null;
}

/** Monta o estado inicial (1ª rodada) a partir do cohort capturado. Pura. */
export function buildInitialState(
  referenceBroadcastId: number,
  rejectedEmails: string[],
  now: Date = new Date(),
): KitGmailWarmupState {
  return {
    referenceBroadcastId,
    capturedAt: now.toISOString(),
    totalRejected: rejectedEmails.length,
    rejectedEmails,
    waves: [],
  };
}

/**
 * Constrói o registro de onda. `emails` é o que de fato entrou (ou entraria,
 * em dry-run) na tag do Kit — **nunca** inclui `needsBeehiivDeactivation`
 * (ver `partitionByBeehiivActive`): quem precisa do passo manual na Beehiiv
 * não foi taguado, então não pode contar como "devolvido" em
 * `returnedEmails`/`lastPushedWaveSize`, senão a próxima rodada nunca mais
 * reconsidera esses endereços mesmo depois do editor desativá-los na
 * Beehiiv. Pura — só é chamada pelo caller real (`runWarmupRamp`) quando
 * `--push` está ativo; em dry-run o caller retorna antes, sem construir nem
 * salvar nenhum registro de onda (o rastro de um dry-run é só o relatório
 * impresso, `formatReport`, nunca `state.json`). Se ALGUÉM chamar esta
 * função com `pushed:false` (o parâmetro aceita o valor — é só o caller real
 * que nunca o exercita), o registro sai construído normalmente; é
 * `alreadyReturned`/`returnedEmails` que somam só ondas `pushed:true`.
 */
export function buildWaveEntry(
  state: KitGmailWarmupState,
  gateBroadcastId: number,
  gate: RampaVeredito,
  emails: string[],
  needsBeehiivDeactivation: string[],
  pushed: boolean,
  now: Date = new Date(),
  unverifiedEmails: string[] = [],
): KitGmailWarmupWave {
  return {
    index: state.waves.length,
    decidedAt: now.toISOString(),
    gateBroadcastId,
    gateVerdict: gate.podeCrescer ? "podeCrescer" : "segurar",
    gateMotivo: gate.motivo,
    size: emails.length,
    emails,
    needsBeehiivDeactivation,
    pushed,
    unverifiedEmails,
  };
}
