/**
 * onboarding-kit-transport.ts (#7922)
 *
 * Núcleo PURO da fatia 1/N da migração do TRANSPORTE do onboarding
 * (Brevo → Kit broadcasts segmentados). Decisão do editor (#7922, 10/09/2026):
 * o cadastro/cadência/estado continuam no servidor (`onboarding-state.ts`,
 * `onboarding-store.ts`, ambos reusados sem modificação de comportamento —
 * só ganharam `selectCandidatesNeedingRefresh` exportada, extração 1:1 de
 * `onboarding-welcome-run.ts`); o que muda é COMO o e-mail sai: em vez de
 * `POST /smtp/email` (Brevo transacional) ou `POST /emailCampaigns` (Brevo
 * campanha), este módulo monta LOTES segmentados por tag do Kit e cria
 * broadcasts via `kit-broadcasts.ts` (`createBroadcast`/`updateBroadcast`/
 * `deleteBroadcast`, já existentes — não reconstrói a integração).
 *
 * Este arquivo é só DECISÃO — zero I/O direto. O único ponto que toca rede é
 * `reconcileLotWithKit`, e mesmo esse recebe a chamada de rede INJETADA
 * (`fetchBroadcast`), pelo mesmo motivo de todo o resto do módulo: testável
 * sem mockar `fetch`. O executor (`scripts/onboarding-kit-transport-run.ts`)
 * é quem chama a API de verdade e persiste o resultado no store.
 *
 * ## Por que "lote", não "1 broadcast por assinante" (issue, "Envio
 * segmentado e segurança")
 *
 * Ao contrário do Brevo transacional (que despacha 1 e-mail por assinante,
 * imediatamente), o Kit não tem endpoint de envio individual — só broadcasts
 * segmentados por `subscriber_filter` (tag/segment). A issue já antecipa
 * isso: "criar público dedicado e estável por etapa/lote". Este módulo
 * agrupa TODOS os destinatários que venceram uma etapa (email1/email2/email3)
 * NUMA RODADA num único lote, tageado com um nome DETERMINÍSTICO e ESTÁVEL
 * (`onboarding-{kind}-{data}-{seq}`) — nunca reusa uma tag mutável entre
 * campanhas pendentes (issue, "Não reutilizar uma tag mutável entre
 * campanhas pendentes"): cada lote nasce com a SUA tag, criada uma vez.
 *
 * ## Guards de segurança que este módulo TORNA ESTRUTURAIS (não só prosa)
 *
 * - **Filtro vazio/base inteira**: `buildOnboardingLotFilter` só aceita um
 *   `tagId` numérico válido e devolve `KitSubscriberFilter` (a tupla
 *   NÃO-VAZIA de `kit-broadcasts.ts`, #7651) — nunca `KitAudienceFilter`
 *   (que também aceitaria `AllSubscribersFilter`). Um caller deste módulo
 *   não consegue, nem por acidente de tipo, montar um broadcast de
 *   onboarding que mire a base inteira.
 * - **`public: false`**: `buildOnboardingBroadcastInput` embute o campo
 *   incondicionalmente — não é parâmetro, não há como um caller pedir
 *   `public: true` por engano (issue: "não publicar onboarding no arquivo
 *   público da Kit").
 * - **E-mail 3 (D+10) nunca sai de rascunho sozinho**: `buildOnboardingBroadcastInput`
 *   força `send_at: null` para `kind === "email3"` INDEPENDENTE do que o
 *   caller passar, e `assertEmail3ScheduleAuthorized` é o único caminho para
 *   agendar/enviar um lote já criado — exige `humanApproved: true` explícito
 *   (issue: "e-mail 3 permanece rascunho com aprovação humana para
 *   agendar/enviar").
 * - **Coortes #7665/#7675 excluídas da seleção automática**: `seeded_by`
 *   (campo que `onboarding-store.ts`/o modo dirigido #7674 já gravam pra
 *   essas duas recuperações manuais) é motivo de exclusão em
 *   `selectEligibleKitRecipients` — nunca entram num lote automático desta
 *   migração (issue: "Excluir essas coortes da seleção automática").
 * - **Idempotência/reconciliação**: `decideLotReconciliation` nunca deixa
 *   recriar um lote com broadcast já criado — só permite recriar quando o
 *   lote anterior travou ANTES de criar o broadcast (crash entre tag e
 *   broadcast) E já passou da janela de stale. Um lookup que FALHA
 *   (`reconcileLotWithKit` propaga o erro do `fetchBroadcast` injetado)
 *   nunca é tratado como "não existe, pode recriar" — o broadcast_id
 *   persistido continua lá, e a próxima chamada de `decideLotReconciliation`
 *   volta a ver "reuse", nunca "create".
 */

import { buildTagFilter, type CreateBroadcastInput, type KitSubscriberFilter } from "./kit-broadcasts.ts";
import type { KitBroadcastSummary } from "./kit-client.ts";

// ---------------------------------------------------------------------------
// Lotes — identidade e tipos
// ---------------------------------------------------------------------------

export type OnboardingKitLotKind = "email1" | "email2" | "email3";

/**
 * Estado local do lote. Espelha (mas não é idêntico a) `KitBroadcastSummary["status"]`
 * — ver `mapKitBroadcastStatusToLocal` para a tradução. `pending` é um
 * estado LOCAL sem equivalente no Kit: existe entre "decidimos criar este
 * lote" e "o broadcast foi confirmado criado" — é justamente a janela onde
 * um crash pode deixar a tag criada sem o broadcast (ou vice-versa), o
 * cenário que a reconciliação existe para fechar.
 */
export type OnboardingKitLotStatus =
  | "pending"
  | "created"
  | "scheduled"
  | "completed"
  | "cancelled";

export interface OnboardingKitLot {
  lot_id: string;
  kind: OnboardingKitLotKind;
  tag_name: string;
  tag_id: number | null;
  broadcast_id: number | null;
  recipient_subscription_ids: string[];
  recipient_emails: string[];
  status: OnboardingKitLotStatus;
  /** ISO — quando este REGISTRO local nasceu (não quando o broadcast foi
   *  confirmado criado no Kit) — base da janela de stale em `decideLotReconciliation`. */
  created_at: string;
  send_at: string | null;
  last_reconciled_at: string | null;
  last_error: string | null;
}

/** `yyyy-mm-dd` (dia BRT do run) + kind + sequência dentro do dia — 1 lote
 *  por etapa por dia é o caso normal (todos os vencidos da rodada entram
 *  juntos); `seq` existe só para o raro caso de precisar mais de 1 lote no
 *  mesmo dia/etapa (ex: reconciliação abriu um novo após stale). */
export function buildLotId(kind: OnboardingKitLotKind, dateIso: string, seq: number): string {
  return `${kind}-${dateIso}-${String(seq).padStart(2, "0")}`;
}

/** Nome da tag Kit dedicada ao lote — 1:1 com `lot_id`, nunca reusada. */
export function buildLotTagName(lotId: string): string {
  return `onboarding-${lotId}`;
}

// ---------------------------------------------------------------------------
// Seleção de destinatários — "wrong recipient"/"unsubscribe"/"failed lookup"
// ---------------------------------------------------------------------------

export type OnboardingKitIneligibleReason =
  /** Status Kit fresco ≠ "active" no momento da seleção — cobre não
   *  confirmado, cancelado, descadastrado, bounced, complained, e também
   *  "não sei" (lookup falhou e o caller passou `null`, ver docstring de
   *  `kit_state` abaixo — falha de consulta NUNCA autoriza envio). */
  | "status_nao_confirmado"
  /** Sem id numérico do Kit resolvido — não dá pra taguear (nem enviar) sem ele. */
  | "sem_kit_subscriber_id"
  /** `seeded_by` presente — entrada é recuperação manual #7665/#7675,
   *  explicitamente excluída da seleção automática desta migração. */
  | "cohort_excluida_manual";

export interface OnboardingKitCandidate {
  subscription_id: string;
  email: string;
  kit_subscriber_id: number | null;
  /**
   * Estado Kit FRESCO (não cacheado) no momento da seleção — `null` quando o
   * lookup mais recente falhou. `null` é tratado como "não confirmado" (fail
   * -safe): esta é a materialização do requisito da issue "Falha de consulta
   * não autoriza envio" — o candidato some do lote, nunca some do log.
   */
  kit_state: string | null;
  /** Rótulo de recuperação manual (#7674) — presença exclui, ver
   *  `OnboardingKitIneligibleReason.cohort_excluida_manual`. */
  seeded_by?: string | null;
}

/** Único estado Kit que autoriza inclusão num lote de onboarding. */
export const KIT_SENDABLE_STATE = "active";

export interface OnboardingKitSelectionResult {
  eligible: OnboardingKitCandidate[];
  excluded: { candidate: OnboardingKitCandidate; reason: OnboardingKitIneligibleReason }[];
}

/**
 * Filtra candidatos pra um lote — primeira regra que casa vence (ordem
 * importa só para o motivo reportado, nunca para o resultado: um candidato
 * com múltiplos problemas é excluído de qualquer forma).
 */
export function selectEligibleKitRecipients(candidates: OnboardingKitCandidate[]): OnboardingKitSelectionResult {
  const eligible: OnboardingKitCandidate[] = [];
  const excluded: OnboardingKitSelectionResult["excluded"] = [];
  for (const candidate of candidates) {
    if (candidate.seeded_by) {
      excluded.push({ candidate, reason: "cohort_excluida_manual" });
      continue;
    }
    if (candidate.kit_subscriber_id == null) {
      excluded.push({ candidate, reason: "sem_kit_subscriber_id" });
      continue;
    }
    if (candidate.kit_state !== KIT_SENDABLE_STATE) {
      excluded.push({ candidate, reason: "status_nao_confirmado" });
      continue;
    }
    eligible.push(candidate);
  }
  return { eligible, excluded };
}

// ---------------------------------------------------------------------------
// Plano do lote
// ---------------------------------------------------------------------------

export interface OnboardingKitLotPlan {
  lot_id: string;
  kind: OnboardingKitLotKind;
  tag_name: string;
  recipient_subscription_ids: string[];
  recipient_emails: string[];
}

/** Monta o PLANO de um lote a partir dos elegíveis já filtrados — não cria
 *  nada, é puro. Lote vazio (0 elegíveis) é um plano válido — o caller
 *  decide se vale a pena materializar (normalmente não: nada a enviar). */
export function planLot(opts: {
  kind: OnboardingKitLotKind;
  dateIso: string;
  seq: number;
  eligible: OnboardingKitCandidate[];
}): OnboardingKitLotPlan {
  const lot_id = buildLotId(opts.kind, opts.dateIso, opts.seq);
  return {
    lot_id,
    kind: opts.kind,
    tag_name: buildLotTagName(lot_id),
    recipient_subscription_ids: opts.eligible.map((c) => c.subscription_id),
    recipient_emails: opts.eligible.map((c) => c.email),
  };
}

// ---------------------------------------------------------------------------
// Filtro de audiência — "empty filter"
// ---------------------------------------------------------------------------

/**
 * `subscriber_filter` de um lote de onboarding — só aceita um `tagId`
 * numérico válido, e o tipo de retorno (`KitSubscriberFilter`, a tupla
 * NÃO-VAZIA de `kit-broadcasts.ts`) exclui `AllSubscribersFilter` em tempo
 * de compilação. O `throw` em runtime é defesa em profundidade para quando
 * `tagId` chega como `number` mas inválido (0, negativo, `NaN` por um
 * `resolveTestSendTagId`/criação de tag que falhou silenciosamente) — o
 * tipo por si só não barra esses valores.
 */
export function buildOnboardingLotFilter(tagId: number): KitSubscriberFilter {
  if (!Number.isInteger(tagId) || tagId <= 0) {
    throw new Error(
      `[onboarding-kit-transport] tagId inválido (${tagId}) — recusando montar subscriber_filter de onboarding ` +
        `(#7922: nunca vazio/base inteira).`,
    );
  }
  return buildTagFilter(tagId);
}

// ---------------------------------------------------------------------------
// Payload do broadcast — "public: false" + "D+10 sempre rascunho"
// ---------------------------------------------------------------------------

export interface BuildOnboardingBroadcastInputOpts {
  kind: OnboardingKitLotKind;
  subject: string;
  content: string;
  previewText?: string;
  tagId: number;
  /** ISO — quando agendar o envio. `null` = rascunho. Ignorado (forçado a
   *  `null`) quando `kind === "email3"`, ver docstring do módulo. */
  sendAt: string | null;
}

/** Monta o payload de `createBroadcast` (kit-broadcasts.ts) para um lote de
 *  onboarding — `public: false` e o guard de e-mail 3 são incondicionais,
 *  nunca dependem de o caller lembrar de passá-los certo. */
export function buildOnboardingBroadcastInput(opts: BuildOnboardingBroadcastInputOpts): CreateBroadcastInput {
  const sendAt = opts.kind === "email3" ? null : opts.sendAt;
  return {
    subject: opts.subject,
    content: opts.content,
    preview_text: opts.previewText,
    public: false,
    send_at: sendAt,
    subscriber_filter: buildOnboardingLotFilter(opts.tagId),
  };
}

/**
 * Guard que TODO caminho de agendar/enviar um lote de e-mail 3 já criado
 * (ex: `updateBroadcast(id, { send_at })`) precisa passar por ANTES de
 * chamar a API — lança se `kind === "email3"` e `humanApproved` não é
 * `true`. Nenhum outro parâmetro pode contornar isto (não há flag "confia em
 * mim"): a única forma de `humanApproved` virar `true` é o executor CLI
 * receber um flag explícito do operador (`--approve-email3-lot`), nunca um
 * default.
 */
export function assertEmail3ScheduleAuthorized(kind: OnboardingKitLotKind, humanApproved: boolean): void {
  if (kind === "email3" && !humanApproved) {
    throw new Error(
      "[onboarding-kit-transport] agendar/enviar o e-mail 3 (D+10) exige aprovação humana explícita " +
        "(--approve-email3-lot) — nunca automático (#7922).",
    );
  }
}

// ---------------------------------------------------------------------------
// Idempotência / reconciliação — "duas rodadas concorrentes", "timeout após
// criação", "reexecução"
// ---------------------------------------------------------------------------

/** Janela em que um lote SEM broadcast confirmado ainda é considerado "outra
 *  rodada pode estar processando agora" — generosa o bastante para cobrir
 *  criar a tag + taguear N destinatários + criar o broadcast numa conexão
 *  lenta, sem ser tão longa a ponto de travar retry legítimo por muito tempo
 *  depois de um crash real. */
export const LOT_STALE_AFTER_MS = 15 * 60_000;

export type LotReconciliationDecision =
  /** Existe um lote com broadcast já confirmado (criado/agendado/concluído)
   *  — reusa, nunca recria. */
  | { action: "reuse"; lot: OnboardingKitLot }
  /** Nenhum lote local para esta chave — seguro criar do zero. */
  | { action: "create" }
  /** Lote local sem broadcast confirmado, mas VELHO o bastante (> `LOT_STALE_AFTER_MS`)
   *  para presumir que a rodada que o criou morreu antes de terminar — seguro
   *  recriar (o executor deve, antes, tentar reconciliar contra o Kit via
   *  `reconcileLotWithKit`; só cai aqui se isso também não achar nada). */
  | { action: "recreate_after_timeout"; staleLot: OnboardingKitLot }
  /** Lote local sem broadcast confirmado e DENTRO da janela de stale — outra
   *  rodada pode estar no meio do processamento agora. Nunca criar em cima. */
  | { action: "blocked_concurrent"; lot: OnboardingKitLot };

/**
 * Decide o que fazer para uma chave de lote (`lot_id`) dado o registro local
 * existente (ou `null`, se nunca criado). Pura — não consulta o Kit; é o
 * passo ANTES de `reconcileLotWithKit` no fluxo do executor (reconciliar
 * primeiro quando há broadcast_id; só recorrer a este timeout quando não há
 * broadcast_id para reconciliar contra).
 */
export function decideLotReconciliation(
  existingLot: OnboardingKitLot | null,
  nowMs: number,
  staleAfterMs: number = LOT_STALE_AFTER_MS,
): LotReconciliationDecision {
  if (existingLot == null) return { action: "create" };
  if (existingLot.status === "cancelled") return { action: "create" };
  if (
    existingLot.broadcast_id != null &&
    (existingLot.status === "created" || existingLot.status === "scheduled" || existingLot.status === "completed")
  ) {
    return { action: "reuse", lot: existingLot };
  }
  // Sem broadcast confirmado — decide por idade do registro local. Data
  // ilegível é tratada como "recente" (fail-safe cauteloso: nunca recria por
  // engano quando não dá pra medir a idade).
  const createdAtMs = Date.parse(existingLot.created_at);
  const ageMs = Number.isFinite(createdAtMs) ? nowMs - createdAtMs : 0;
  if (ageMs < staleAfterMs) return { action: "blocked_concurrent", lot: existingLot };
  return { action: "recreate_after_timeout", staleLot: existingLot };
}

/** Traduz o `status` do Kit (`KitBroadcastSummary`) para o estado LOCAL do
 *  lote. `sending` vira `completed` — uma vez que o envio começou, o lote é
 *  terminal para fins de reconciliação (nunca recriar em cima de um
 *  broadcast que já começou a sair, mesmo que ainda não tenha terminado). */
export function mapKitBroadcastStatusToLocal(status: KitBroadcastSummary["status"]): OnboardingKitLotStatus {
  switch (status) {
    case "draft":
      return "created";
    case "scheduled":
      return "scheduled";
    case "sending":
    case "completed":
      return "completed";
    case "aborted":
      return "cancelled";
  }
}

/**
 * Reconcilia UM lote contra o estado real do Kit — `fetchBroadcast` é
 * injetado de propósito (nunca `getBroadcast` de `kit-client.ts` chamado
 * direto aqui) para o módulo continuar 100% testável sem mockar `fetch`.
 *
 * **Contrato de falha, o ponto central do requisito "failed lookup nunca
 * autoriza envio/recriação":** se `fetchBroadcast` REJEITA (rede, 404, rate
 * limit, o que for), o erro PROPAGA sem ser capturado aqui — o `lot`
 * original volta intocado para quem chamou. `broadcast_id` continua
 * presente no registro local, então a PRÓXIMA chamada de
 * `decideLotReconciliation` (sem sequer chegar a reconciliar de novo) ainda
 * vê `broadcast_id != null` com o `status` local antigo e decide "reuse" —
 * nunca "create". Um lookup que falha nunca abre a porta para duplicar.
 *
 * Lote sem `broadcast_id` (ainda não confirmado criado) não tem o que
 * reconciliar — devolve o lote intocado sem chamar `fetchBroadcast`.
 */
export async function reconcileLotWithKit(
  lot: OnboardingKitLot,
  fetchBroadcast: (broadcastId: number) => Promise<{ status: KitBroadcastSummary["status"] }>,
  nowIso: string = new Date().toISOString(),
): Promise<OnboardingKitLot> {
  if (lot.broadcast_id == null) return lot;
  const remote = await fetchBroadcast(lot.broadcast_id);
  return {
    ...lot,
    status: mapKitBroadcastStatusToLocal(remote.status),
    last_reconciled_at: nowIso,
    last_error: null,
  };
}
