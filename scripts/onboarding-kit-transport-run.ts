#!/usr/bin/env npx tsx
/**
 * onboarding-kit-transport-run.ts (#7922 fatia 1/N)
 *
 * Executor do TRANSPORTE Kit do onboarding — cria/agenda/consulta/cancela
 * broadcasts segmentados por tag via `kit-broadcasts.ts` (reusado, não
 * reconstruído). A camada de DECISÃO pura vive em
 * `scripts/lib/onboarding-kit-transport.ts`; cadência/estado/elegibilidade
 * continuam 100% em `onboarding-state.ts`/`onboarding-store.ts`
 * (`buildRunPlan`, `selectCandidatesNeedingRefresh` — reusados sem
 * modificação de comportamento, mesmo store `data/onboarding/store.json`).
 *
 * **Esta fatia NÃO faz cutover.** `onboarding-welcome-run.ts` continua sendo
 * quem de fato envia (Brevo) — este script roda AO LADO, sobre o MESMO
 * store, sem escrever nos campos que só o script Brevo possui
 * (`email{1,2}_brevo_id`, `email3_campaign_id` continuam exclusivos do
 * caminho Brevo). O estado dos lotes vive em
 * `store.kit_transport.lots`, um namespace próprio dentro do MESMO
 * arquivo (issue: "sem criar outra fonte de verdade"). **Exceção desde
 * #9014:** quando o broadcast de um lote de e-mail 1/2 é confirmado, este
 * script grava `email{1,2}_sent_at` + `email{1,2}_kit_lot_id` (e
 * `email1_transport = "kit"`, #9015) nas entries do lote, sob o mesmo lock
 * (`persistLotUpdate` → `applyKitLotToEntries`) — sem isso `buildRunPlan`
 * replanejava o e-mail 1 da mesma pessoa todo dia. Desde #9059 o mesmo vale
 * pro e-mail 3: lote confirmado grava `email3_state = "campaign_created"` +
 * `email3_kit_lot_id` (`email3_campaign_id`, id Brevo, segue intocado).
 * Desde #9060, `--reconcile` também faz backfill local das entries de lotes
 * já terminais (`backfillTerminalLotEntries`) — cobre lotes concluídos antes
 * do #9058. Cutover real (decidir
 * QUEM envia de fato, migrar novas entradas, corte explícito Brevo→Kit) é
 * escopo residual — ver corpo do PR.
 *
 * SEGURANÇA (ver docstring de `scripts/lib/onboarding-kit-transport.ts` para
 * os guards estruturais — este script só os invoca, não os reimplementa):
 *   - Default é DRY-RUN: sem `--send`, NENHUMA chamada de escrita ao Kit
 *     acontece (sem criar tag, sem taguear, sem criar broadcast, sem gravar
 *     store) — só imprime o plano. Leituras (refresh de status/stats,
 *     reconciliação) sempre acontecem, mesmo em dry-run, pro plano refletir
 *     estado real.
 *   - Kill switch DEDICADO: `onboarding.kit_transport.enabled` precisa ser
 *     `true` em `platform.config.json` — ausente/`false` = aborta antes de
 *     qualquer chamada, mesmo com `--send`. Este PR não liga o switch.
 *     **Exceto com `--pilot`** (#7922): o modo piloto ignora o kill switch
 *     porque só opera sobre um store ISOLADO e destinatários em allowlist
 *     (ver "MODO PILOTO" abaixo) — nunca toca o store nem a base real.
 *   - Backend precisa ser "kit" (`publishing.newsletter.subscriber_backend`).
 *   - E-mail 3 (D+10) só agenda com `--approve-email3-lot <lot_id> --send-at <iso>`
 *     explícitos — nunca como parte do `--send` normal.
 *
 * Uso:
 *   npx tsx scripts/onboarding-kit-transport-run.ts                    # dry-run (plano)
 *   npx tsx scripts/onboarding-kit-transport-run.ts --send              # cria/tageia lotes vencidos (email1/email2; email3 só cria RASCUNHO)
 *   npx tsx scripts/onboarding-kit-transport-run.ts --reconcile         # só releitura de status dos lotes já criados
 *   npx tsx scripts/onboarding-kit-transport-run.ts --cancel-lot <id>   # apaga (draft/scheduled) um lote
 *   npx tsx scripts/onboarding-kit-transport-run.ts --approve-email3-lot <id> --send-at <iso>
 *
 * MODO PILOTO (#7922, seção 4 de docs/onboarding-kit-cutover.md):
 *   npx tsx scripts/onboarding-kit-transport-run.ts --pilot --pilot-recipients <email> --store <isolado> [--send]
 *   Store isolado obrigatório (recusa o real), entries sintéticas só dos
 *   destinatários, os 3 kinds no mesmo dia (sem cadência), kill switch de
 *   produção ignorado SÓ aqui, guards de audiência duros — ver
 *   `scripts/lib/onboarding-kit-pilot.ts`. `--cancel-lot`/`--reconcile`/
 *   `--approve-email3-lot` também aceitam `--pilot` (mesmo store isolado).
 *
 * Flags auxiliares (testes/operações): --store <path>, --snippets-dir <path>,
 * --config <path>, --env-root <path>.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { getBroadcast, KitApiError, type KitBroadcastSummary } from "./lib/kit-client.ts";
import { withFileLock } from "./lib/file-lock.ts";
import {
  createBroadcast,
  updateBroadcast,
  deleteBroadcast,
  tagSubscriber,
  findTagIdByName,
  createTag,
} from "./lib/kit-broadcasts.ts";
import { resolveNewsletterSubscriberBackend } from "./lib/shared/newsletter-subscriber-source.ts";
import { unixSecondsToBrtDate } from "./lib/beehiiv-publish-date.ts";
import { readStore, writeStore, DEFAULT_STORE_PATH, type OnboardingStore } from "./lib/onboarding-store.ts";
import {
  parseOnboardingSnippet,
  buildRunPlan,
  selectCandidatesNeedingRefresh,
  filterKitPlanForBrevoInFlight,
  ownerTransportFor,
  type RunAction,
} from "./lib/onboarding-state.ts";
import {
  planLot,
  selectEligibleKitRecipients,
  buildOnboardingBroadcastInput,
  assertEmail3ScheduleAuthorized,
  decideLotReconciliation,
  reconcileLotWithKit,
  rebuildLotPlanForRecreate,
  findLatestLotForKindDate,
  applyKitLotToEntries,
  recordKitSendRun,
  countKitContentSkips,
  mapKitBroadcastStatusToLocal,
  type KitSendRunRecord,
  type OnboardingKitCandidate,
  type OnboardingKitLot,
  type OnboardingKitLotKind,
  type OnboardingKitLotPlan,
  type LotReconciliationDecision,
} from "./lib/onboarding-kit-transport.ts";
import { loadOnboardingConfig, fetchSubscriptionByIdKit } from "./onboarding-welcome-run.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { listAllTagSubscriberEmails } from "./lib/kit-broadcasts.ts";
import {
  parsePilotRecipients,
  assertPilotStoreIsolated,
  seedPilotStore,
  selectPilotEntriesForKind,
  runPilotLot,
  approvePilotEmail3Lot,
  assertPilotCancelable,
  buildPilotLotTagName,
  redactEmails,
  type PilotKitDeps,
} from "./lib/onboarding-kit-pilot.ts";
import type { OnboardingEntry } from "./lib/onboarding-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  send: boolean;
  reconcileOnly: boolean;
  cancelLotId?: string;
  approveEmail3LotId?: string;
  sendAt?: string;
  storePath?: string;
  snippetsDir?: string;
  configPath?: string;
  envRoot?: string;
  pilot: boolean;
  pilotRecipientsRaw?: string;
  pilotAllowUnechoedFilter: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { send: false, reconcileOnly: false, pilot: false, pilotAllowUnechoedFilter: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send") args.send = true;
    else if (a === "--reconcile") args.reconcileOnly = true;
    else if (a === "--cancel-lot") args.cancelLotId = argv[++i];
    else if (a === "--approve-email3-lot") args.approveEmail3LotId = argv[++i];
    else if (a === "--send-at") args.sendAt = argv[++i];
    else if (a === "--store") args.storePath = argv[++i];
    else if (a === "--snippets-dir") args.snippetsDir = argv[++i];
    else if (a === "--config") args.configPath = argv[++i];
    else if (a === "--env-root") args.envRoot = argv[++i];
    else if (a === "--pilot") args.pilot = true;
    else if (a === "--pilot-recipients") args.pilotRecipientsRaw = argv[++i];
    else if (a === "--pilot-allow-unechoed-filter") args.pilotAllowUnechoedFilter = true;
    else {
      process.stderr.write(`[onboarding-kit-transport] flag desconhecida: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Snippets (mesmo formato/arquivos do caminho Brevo — data/snippets/onboarding-{1,2,3}.md)
// ---------------------------------------------------------------------------

function loadSnippet(dirAbs: string, numero: 1 | 2 | 3): ReturnType<typeof parseOnboardingSnippet> {
  const p = resolve(dirAbs, `onboarding-${numero}.md`);
  if (!existsSync(p)) return null;
  return parseOnboardingSnippet(readFileSync(p, "utf8"), numero);
}

const KIND_TO_SNIPPET_NUM: Record<OnboardingKitLotKind, 1 | 2 | 3> = { email1: 1, email2: 2, email3: 3 };

// ---------------------------------------------------------------------------
// Kill switch dedicado — #7922: nasce OFF, ligar é decisão do editor
// ---------------------------------------------------------------------------

interface KitTransportConfig {
  enabled?: boolean;
}

function loadKitTransportConfig(configPathAbs: string): KitTransportConfig {
  const raw = JSON.parse(readFileSync(configPathAbs, "utf8")) as {
    onboarding?: { kit_transport?: KitTransportConfig };
  };
  return raw.onboarding?.kit_transport ?? { enabled: false };
}

// ---------------------------------------------------------------------------
// Tag resolution — cria só se ausente (mesmo padrão de resolveTestSendTagId)
// ---------------------------------------------------------------------------

async function resolveOrCreateLotTagId(tagName: string, config: KitConfig): Promise<number> {
  const found = await findTagIdByName(tagName, config);
  if (found != null) return found;
  const created = await createTag(tagName, config);
  return created.id;
}

// ---------------------------------------------------------------------------
// Reivindicação de lote — exclusão mútua entre rodadas/processos concorrentes
// ---------------------------------------------------------------------------

export interface ClaimLotResult {
  decision: LotReconciliationDecision;
  /** `null` só quando `decision.action === "blocked_concurrent"`. */
  lot: OnboardingKitLot | null;
}

/**
 * Decide + (se for o caso) persiste um lote `pending` — ATOMICAMENTE entre
 * PROCESSOS, não só entre chamadas de função (#7922, achado do self-review:
 * a versão anterior decidia sobre uma cópia do store capturada em memória no
 * início de `main()` — duas invocações concorrentes deste script podiam
 * ambas concluir "nenhum lote existe" sem nunca ver o que a outra acabou de
 * criar, duplicando o broadcast; `decideLotReconciliation` sozinha é pura e
 * não fecha essa corrida, só decide dado um snapshot).
 *
 * O lock (`file-lock.ts`, mesmo padrão de `social-published-store.ts`) força
 * as chamadas concorrentes a serializar aqui: quem entra primeiro RELÊ o
 * store do DISCO (nunca a cópia em memória do caller, que pode já estar
 * desatualizada), decide, e — se for criar — já persiste o `pending` antes
 * de soltar o lock. A 2ª chamada, ao adquirir o lock, relê o disco e agora
 * VÊ o `pending` recém-criado (idade < `LOT_STALE_AFTER_MS`) →
 * `blocked_concurrent`. Exportado (não só usado inline em `main()`) pra ser
 * testável sem depender de dois processos OS reais — ver
 * `test/onboarding-kit-transport-run-lock-7922.test.ts`.
 */
export function claimLot(
  storePath: string,
  lotPlan: OnboardingKitLotPlan,
  nowMs: number = Date.now(),
  /** #7922 piloto: nome de tag alternativo (`onboarding-pilot-{lot_id}`) —
   *  aplicado DEPOIS de `rebuildLotPlanForRecreate`, que sempre regera o
   *  nome de produção. */
  tagNameFor?: (lotId: string) => string,
): ClaimLotResult {
  const lockPath = `${storePath}.lock`;
  return withFileLock(
    lockPath,
    () => {
      // #7922 (gap #2, audit pós-merge da fatia 1/N): `readStore` devolve
      // `{ store: emptyStore(), corrupted: true }` em SILÊNCIO — sem lançar —
      // quando o JSON do disco está ilegível. Destructurar só `{ store }`
      // (como a versão anterior fazia) tratava um store CORROMPIDO como se
      // fosse um store vazio legítimo — e como esta função é quem ESCREVE de
      // volta (`writeStore` abaixo), seguir adiante persistiria esse vazio
      // por cima do arquivo bom, apagando todo `kit_transport.lots`
      // existente. Abortar alto aqui em vez de proceder.
      const { store: freshStore, corrupted } = readStore(storePath);
      if (corrupted) {
        throw new Error(
          `[onboarding-kit-transport] store em "${storePath}" está CORROMPIDO (JSON ilegível) — recusando decidir/persistir ` +
            `kit_transport.lots sobre um snapshot que "readStore" já esvaziou silenciosamente. Escrever agora sobrescreveria o ` +
            `arquivo bom com um vazio. Repare/restaure o store antes de rodar --send/--reconcile de novo.`,
        );
      }
      freshStore.kit_transport ??= { lots: {} };
      // #7922 (gap #4, audit pós-merge): olha pro lote MAIS NOVO da chave
      // kind+dateIso (`findLatestLotForKindDate`), nunca fixo em
      // `lotPlan.lot_id` (sempre seq=1, como o caller — `main()` abaixo —
      // sempre constrói). Sem isto, depois de uma 1ª recriação (seq=2), toda
      // chamada seguinte continuaria checando o slot velho (seq=1, morto
      // pra sempre) e recriaria de novo indefinidamente — nunca veria que o
      // lote recriado já teve seu broadcast confirmado.
      const existingLot = findLatestLotForKindDate(freshStore.kit_transport.lots, lotPlan.kind, lotPlan.dateIso);
      const decision = decideLotReconciliation(existingLot, nowMs);
      if (decision.action === "blocked_concurrent") return { decision, lot: null };
      if (decision.action === "reuse") return { decision, lot: decision.lot };
      // action === "create" | "recreate_after_timeout" — seguro criar.
      //
      // #7922 (gap #4, audit pós-merge da fatia 1/N): NUNCA reusar lot_id/
      // tag_name de um lote velho quando EXISTE um lote velho pra esta chave
      // — precisa de identidade NOVA (`rebuildLotPlanForRecreate`, seq
      // incrementado via `nextLotSeq`) pra (a) nunca sobrescrever/perder o
      // registro do lote velho no store (evidência de auditoria de um
      // possível broadcast órfão no Kit) e (b) nunca reusar uma tag que
      // possa já estar amarrada a um broadcast que a tentativa anterior de
      // fato criou, mas cujo response se perdeu antes de `broadcast_id` ser
      // persistido localmente — risco residual documentado na docstring de
      // `decideLotReconciliation`/gap #1 (mesmo audit).
      //
      // Fleet review pré-merge (4 achados independentes convergindo no
      // mesmo bug): a 1ª versão deste fix só rebuildava em
      // `recreate_after_timeout`, deixando "create" sempre com `lotPlan`
      // (seq=1 fixo, vindo de `main()`). Isso reabre o buraco quando um
      // lote seq≥2 (já recriado uma vez) é CANCELADO via `--cancel-lot`:
      // `decideLotReconciliation` trata "cancelled" como `{action: "create"}`
      // pra reabrir a chave — mas o `lotPlan` do caller ainda é seq=1, então
      // a escrita ia pro `lot_id`/`tag_name` do lote seq=1 ORIGINAL (o que
      // nunca teve `broadcast_id` confirmado), sobrescrevendo esse registro
      // de auditoria e reusando exatamente a tag que o mecanismo de seq-bump
      // existe pra evitar reusar. Fix: rebuildar sempre que EXISTE algum
      // lote pra esta chave (`existingLot != null`), não só quando a decisão
      // foi "recreate_after_timeout" — "create" sem `existingLot` (nenhum
      // lote pra esta chave, o caso comum de 1ª rodada do dia) continua
      // usando `lotPlan` tal como veio, sem identidade velha a evitar.
      const basePlan = existingLot != null ? rebuildLotPlanForRecreate(lotPlan, freshStore.kit_transport.lots) : lotPlan;
      const effectivePlan = tagNameFor ? { ...basePlan, tag_name: tagNameFor(basePlan.lot_id) } : basePlan;
      const pending: OnboardingKitLot = {
        lot_id: effectivePlan.lot_id,
        kind: effectivePlan.kind,
        tag_name: effectivePlan.tag_name,
        tag_id: null,
        broadcast_id: null,
        recipient_subscription_ids: effectivePlan.recipient_subscription_ids,
        recipient_emails: effectivePlan.recipient_emails,
        status: "pending",
        created_at: new Date(nowMs).toISOString(),
        send_at: null,
        last_reconciled_at: null,
        last_error: null,
      };
      freshStore.kit_transport.lots[pending.lot_id] = pending;
      writeStore(freshStore, storePath);
      return { decision, lot: pending };
    },
    30_000,
  );
}

/** Persiste um lote JÁ REIVINDICADO (via `claimLot`) de volta no store, sob o
 *  mesmo lock — usado depois de `createBroadcast`/erro atualizar o `lot` em
 *  memória com `broadcast_id`/`status`/`last_error`. Relê o disco fresco
 *  antes de escrever (nunca sobrescreve `kit_transport.lots` de outra chave
 *  que uma reconciliação concorrente possa ter tocado nesse meio-tempo). */
export function persistLotUpdate(storePath: string, lot: OnboardingKitLot, nowMs: number = Date.now()): number {
  const lockPath = `${storePath}.lock`;
  let touched = 0;
  withFileLock(
    lockPath,
    () => {
      // #7922 (gap #2, mesma classe do guard em `claimLot` acima): um store
      // corrompido nunca deve ser tratado como "vazio, seguro escrever por
      // cima" — faria este `writeStore` apagar todo `kit_transport.lots`
      // (e todo o resto do store) que estivesse bom no disco.
      const { store: freshStore, corrupted } = readStore(storePath);
      if (corrupted) {
        throw new Error(
          `[onboarding-kit-transport] store em "${storePath}" está CORROMPIDO (JSON ilegível) — recusando persistir a ` +
            `atualização do lote "${lot.lot_id}" sobre um snapshot que "readStore" já esvaziou silenciosamente. Repare/restaure ` +
            `o store antes de rodar --send/--reconcile de novo.`,
        );
      }
      freshStore.kit_transport ??= { lots: {} };
      freshStore.kit_transport.lots[lot.lot_id] = lot;
      // #9014: broadcast confirmado → marca `email{1,2}_sent_at` nas entries
      // do lote (lote cancelado → desfaz). Mesmo lock/snapshot fresco da
      // escrita do lote, então lote e entries nunca divergem no disco. Cobre
      // os 3 caminhos que chegam aqui: criação no --send, --reconcile (lote
      // cuja confirmação só foi vista depois) e --cancel-lot.
      touched = applyKitLotToEntries(freshStore.entries, lot, new Date(nowMs).toISOString());
      writeStore(freshStore, storePath);
    },
    30_000,
  );
  return touched;
}

/**
 * #9060 item 1: backfill LOCAL (sem rede) das entries de lotes JÁ TERMINAIS
 * (`completed`/`cancelled`) — o `--reconcile` pula esses lotes na releitura
 * do Kit (status terminal não muda), então um lote concluído ANTES do #9058
 * (que introduziu `applyKitLotToEntries`) nunca teria gravado
 * `email{1,2}_sent_at`/`email3_state` nas suas entries. Reaplica
 * `applyKitLotToEntries` sob o mesmo lock + releitura fresca de
 * `persistLotUpdate`, e só escreve no disco quando algo de fato muda
 * (idempotente: rodadas seguintes são no-op e não reescrevem o store).
 * O registro do lote em si é preservado byte a byte (nunca reescrito aqui).
 *
 * Devolve quantas entries foram tocadas.
 */
export function backfillTerminalLotEntries(storePath: string, lotId: string, nowMs: number = Date.now()): number {
  const lockPath = `${storePath}.lock`;
  let touched = 0;
  withFileLock(
    lockPath,
    () => {
      const { store: freshStore, corrupted } = readStore(storePath);
      if (corrupted) {
        throw new Error(
          `[onboarding-kit-transport] store em "${storePath}" está CORROMPIDO (JSON ilegível) — recusando o backfill ` +
            `do lote "${lotId}". Repare/restaure o store antes de rodar --reconcile de novo.`,
        );
      }
      const lot = freshStore.kit_transport?.lots[lotId];
      if (lot == null || (lot.status !== "completed" && lot.status !== "cancelled")) return;
      touched = applyKitLotToEntries(freshStore.entries, lot, new Date(nowMs).toISOString());
      if (touched > 0) writeStore(freshStore, storePath);
    },
    30_000,
  );
  return touched;
}

/** Linha do resultado de `reconcileOpenLots` (mesmo formato que `--reconcile`
 *  sempre imprimiu, mais `recovered` quando o lote era `unverified`). */
export interface OpenLotReconcileRow {
  lot_id: string;
  before: string;
  after: string;
  error?: string;
  backfilled?: number;
  /** Só pra lote de e-mail 1/2 `unverified` relido com limpeza permitida. */
  recovered?: "scheduled" | "unscheduled" | "unverified";
}

export interface ReconcileOpenLotsDeps {
  getBroadcast(id: number): Promise<{ status: KitBroadcastSummary["status"]; send_at?: string | null }>;
  /**
   * Presente = a releitura pode APAGAR o broadcast de um lote de e-mail 1/2
   * `unverified` que o Kit mostra não-agendado (mesma regra do `--send` em
   * `confirmOrCleanUpScheduledLot`). Ausente = só leitura (`--reconcile`,
   * dry-run): nunca escreve no Kit.
   */
  deleteBroadcast?(id: number): Promise<void>;
}

/**
 * #9367 item 1: o laço de releitura dos lotes — compartilhado entre
 * `--reconcile` e o INÍCIO de cada `--send`.
 *
 * O buraco que fecha: um `--send` cria o broadcast agendado de e-mail 1/2,
 * mas a releitura de confirmação falha (rede) → lote `created`
 * (`unverified`). Sem `email1_sent_at` gravado, a régua não ancora (e-mail
 * 2/3 nunca planejados); e como `hasConfirmedKitLotForEntry` conta `created`
 * como confirmado, a entrada também nunca entra num lote novo — presa em
 * silêncio. Nada em produção agenda `--reconcile`, e a streak do alarme
 * zerava na rodada seguinte. Rodando este laço antes de planejar, a rodada
 * `--send` seguinte relê o lote: agendado/enviado → grava o envio nas
 * entries; não agendado → apaga e cancela (entradas voltam ao plano); ainda
 * ilegível → conta em `stillUnverified` (o caller soma em `lots_unverified`,
 * a streak não zera).
 *
 * Para cada lote:
 *   - terminal (`completed`/`cancelled`): backfill local das entries (#9060).
 *   - sem `broadcast_id` (`pending`): nada a reler (`claimLot` decide).
 *   - e-mail 1/2 `unverified` (`created`, sem `schedule_failed`) com
 *     `deps.deleteBroadcast`: `confirmOrCleanUpScheduledLot`.
 *   - resto: `reconcileLotWithKit` (só leitura); falha vira `last_error`.
 *
 * Sempre aplica o resultado no `store` EM MEMÓRIA (o plano que vem depois
 * enxerga as entries atualizadas); com `persist`, também grava cada lote no
 * disco (`persistLotUpdate`/`backfillTerminalLotEntries`, sob lock — nunca
 * um `writeStore` de lote-múltiplo fora do lock, #8136).
 */
export async function reconcileOpenLots(
  opts: { storePath: string; store: OnboardingStore; persist: boolean; nowMs?: number },
  deps: ReconcileOpenLotsDeps,
): Promise<{ results: OpenLotReconcileRow[]; stillUnverified: number }> {
  const { storePath, store, persist } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  store.kit_transport ??= { lots: {} };
  const results: OpenLotReconcileRow[] = [];
  let stillUnverified = 0;
  for (const lot of Object.values(store.kit_transport.lots)) {
    if (lot.status === "completed" || lot.status === "cancelled") {
      // #9060 item 1: terminal não é relido no Kit, mas as entries de um
      // lote concluído antes do #9058 podem nunca ter sido marcadas.
      const inMemory = applyKitLotToEntries(store.entries, lot, nowIso);
      const backfilled = persist ? backfillTerminalLotEntries(storePath, lot.lot_id, nowMs) : inMemory;
      if (backfilled > 0) results.push({ lot_id: lot.lot_id, before: lot.status, after: lot.status, backfilled });
      continue;
    }
    if (lot.broadcast_id == null) continue;
    const before = lot.status;
    const isUnverified = (lot.kind === "email1" || lot.kind === "email2") && lot.status === "created" && lot.schedule_failed !== true;
    let updated: OnboardingKitLot;
    const row: OpenLotReconcileRow = { lot_id: lot.lot_id, before, after: before };
    if (isUnverified && deps.deleteBroadcast) {
      updated = { ...lot };
      const outcome = await confirmOrCleanUpScheduledLot(updated, { getBroadcast: deps.getBroadcast, deleteBroadcast: deps.deleteBroadcast });
      updated.last_reconciled_at = nowIso;
      row.recovered = outcome;
      if (outcome === "unverified") {
        stillUnverified++;
        row.error = updated.last_error ?? undefined;
      }
    } else {
      try {
        updated = await reconcileLotWithKit(lot, deps.getBroadcast, nowIso);
      } catch (e) {
        updated = { ...lot, last_error: (e as Error).message };
        row.error = (e as Error).message;
        if (isUnverified) stillUnverified++;
      }
    }
    row.after = updated.status;
    store.kit_transport.lots[lot.lot_id] = updated;
    applyKitLotToEntries(store.entries, updated, nowIso);
    if (persist) persistLotUpdate(storePath, updated, nowMs);
    results.push(row);
  }
  return { results, stillUnverified };
}

/**
 * #7922 (pré-requisito do corte, §3 de docs/onboarding-kit-cutover.md):
 * registra o resultado de uma rodada `--send` NÃO-piloto em
 * `store.kit_transport.last_send_run` + `consecutive_failed_send_runs`
 * (`recordKitSendRun`), sob o MESMO lock + releitura fresca de
 * `persistLotUpdate` — é o sinal que o alarme de continuidade
 * (`onboarding-continuity-alarm.ts`) lê quando o transporte Kit está ativo.
 * Store corrompido lança (mesma classe de `claimLot`/`persistLotUpdate`:
 * nunca regravar um vazio por cima do arquivo bom).
 */
export function stampKitSendRun(storePath: string, run: KitSendRunRecord): void {
  const lockPath = `${storePath}.lock`;
  withFileLock(
    lockPath,
    () => {
      const { store: freshStore, corrupted } = readStore(storePath);
      if (corrupted) {
        throw new Error(
          `[onboarding-kit-transport] store em "${storePath}" está CORROMPIDO (JSON ilegível) — recusando registrar a ` +
            `rodada --send (last_send_run). Repare/restaure o store antes de rodar --send de novo.`,
        );
      }
      freshStore.kit_transport ??= { lots: {} };
      recordKitSendRun(freshStore.kit_transport, run);
      writeStore(freshStore, storePath);
    },
    30_000,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadProjectEnv(args.envRoot);

  const configPathAbs = args.configPath ?? resolve(ROOT, "platform.config.json");
  const kitTransportCfg = loadKitTransportConfig(configPathAbs);
  const onboardingCfg = loadOnboardingConfig(configPathAbs);
  const realStorePath = resolve(ROOT, onboardingCfg.store_path ?? DEFAULT_STORE_PATH);
  let pilotRecipients: string[] = [];
  let storePath: string;
  if (args.pilot) {
    // #7922 piloto — camada 1: store isolado obrigatório, ANTES de ler qualquer store.
    try {
      pilotRecipients = parsePilotRecipients(args.pilotRecipientsRaw);
      storePath = assertPilotStoreIsolated(args.storePath, [realStorePath, DEFAULT_STORE_PATH]);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exit(2);
    }
  } else {
    if (args.pilotRecipientsRaw != null || args.pilotAllowUnechoedFilter) {
      process.stderr.write("[onboarding-kit-transport] --pilot-recipients/--pilot-allow-unechoed-filter só valem com --pilot.\n");
      process.exit(2);
    }
    storePath = args.storePath ?? realStorePath;
  }

  // #7922 (alarme de continuidade do transporte Kit): com o kill switch
  // LIGADO, uma rodada `--send` de produção que aborta antes de processar os
  // lotes (backend errado, config Kit ausente) é e-mail que não sai —
  // registra a rodada como abortada. Store CORROMPIDO não tem como ser
  // registrado (a gravação também falha) e o alarme NÃO cobre esse caso:
  // ele lê o mesmo store ilegível e responde `cannot-verify`, sem issue nem
  // e-mail — quem sinaliza é o exit != 0 desta rodada.
  const isProductionSend =
    args.send && !args.pilot && args.cancelLotId == null && args.approveEmail3LotId == null && !args.reconcileOnly && kitTransportCfg.enabled === true;
  const abortSend: (reason: string) => never = (reason) => {
    if (isProductionSend) {
      recordKitSendRunSafely(storePath, {
        lots_created: 0,
        lots_failed: 0,
        lots_unverified: 0,
        blocked_concurrent: 0,
        refresh_candidates: 0,
        refresh_failed: 0,
        content_skipped: 0,
        aborted: true,
        error: redactEmails(reason),
      });
    }
    process.exit(2);
  };

  const backend = resolveNewsletterSubscriberBackend(configPathAbs);
  if (backend !== "kit") {
    process.stderr.write(
      `[onboarding-kit-transport] backend de assinante atual é "${backend}", não "kit" — nada a taguear/enviar. Abortando.\n`,
    );
    abortSend(`backend de assinante "${backend}", não "kit"`);
  }

  const kitResult = resolveKitConfig();
  if (!kitResult.ok) {
    process.stderr.write(`[onboarding-kit-transport] ${kitResult.reason}\n`);
    abortSend(`config Kit: ${kitResult.reason}`);
  }
  const kitCfg = kitResult.config;

  // #7922 (gap #2, mesma classe do guard em `claimLot`/`persistLotUpdate`
  // abaixo): sem checar `corrupted`, um JSON ilegível vira silenciosamente
  // um store vazio, e `--cancel-lot`/`--approve-email3-lot`/`--reconcile`
  // (que leem `store.kit_transport.lots` desta cópia) reportariam "lote não
  // encontrado" — nunca "store corrompido" — mascarando a causa real.
  const { store, corrupted } = readStore(storePath);
  if (corrupted) {
    process.stderr.write(
      `[onboarding-kit-transport] store em "${storePath}" está CORROMPIDO (JSON ilegível) — abortando antes de decidir/tocar ` +
        `qualquer lote sobre um snapshot que "readStore" já esvaziou silenciosamente. Repare/restaure o store antes de rodar de novo.\n`,
    );
    abortSend("store corrompido");
  }
  store.kit_transport ??= { lots: {} };

  // --- Kill switch dedicado — checado ANTES de qualquer ação de escrita.
  // Leituras (--reconcile, dry-run de plano) não dependem dele: consultar o
  // Kit não é "armar" o transporte. ---
  const writeRequested = args.send || args.cancelLotId != null || args.approveEmail3LotId != null;
  if (isWriteBlockedByKillSwitch(writeRequested, kitTransportCfg.enabled, args.pilot)) {
    process.stderr.write(
      "[onboarding-kit-transport] ⏸️  onboarding.kit_transport.enabled não é `true` em platform.config.json — " +
        "nenhuma escrita ao Kit é permitida (kill switch dedicado, #7922). Ligar é decisão do editor.\n",
    );
    process.exit(2);
  }

  // --- Modos dedicados: --cancel-lot / --approve-email3-lot (não recomputam plano) ---
  if (args.cancelLotId) {
    const lot = store.kit_transport.lots[args.cancelLotId];
    if (!lot) {
      process.stderr.write(`[onboarding-kit-transport] lote "${args.cancelLotId}" não encontrado no store.\n`);
      process.exit(2);
    }
    if (lot.broadcast_id == null) {
      process.stderr.write(`[onboarding-kit-transport] lote "${args.cancelLotId}" não tem broadcast criado — nada a apagar.\n`);
      process.exit(2);
    }
    if (args.pilot) {
      // #7922 piloto: só cancela lote do piloto (prefixo da tag) com destinatários da allowlist.
      try {
        assertPilotCancelable(lot, pilotRecipients);
      } catch (e) {
        process.stderr.write(`${(e as Error).message}\n`);
        process.exit(2);
      }
    }
    try {
      const outcome = await cancelKitLot(lot, (id) => deleteBroadcast(id, kitCfg));
      persistLotUpdate(storePath, lot);
      console.log(JSON.stringify({ mode: "cancel-lot", lot_id: lot.lot_id, broadcast_id: lot.broadcast_id, ok: true, ...(outcome === "already_gone" ? { note: "broadcast já não existia no Kit (404)" } : {}) }, null, 2));
    } catch (e) {
      // #7922: 422 "Broadcast has already been sent." é esperado quando o
      // envio já começou entre a leitura do store e esta chamada — não é bug
      // do cancelamento, é o Kit confirmando que não há mais o que cancelar.
      lot.last_error = (e as Error).message;
      persistLotUpdate(storePath, lot);
      console.log(JSON.stringify({ mode: "cancel-lot", lot_id: lot.lot_id, broadcast_id: lot.broadcast_id, ok: false, error: redactEmails((e as Error).message) }, null, 2));
      process.exitCode = 1;
    }
    return;
  }

  if (args.approveEmail3LotId) {
    const lot = store.kit_transport.lots[args.approveEmail3LotId];
    if (!lot) {
      process.stderr.write(`[onboarding-kit-transport] lote "${args.approveEmail3LotId}" não encontrado no store.\n`);
      process.exit(2);
    }
    if (!args.sendAt) {
      process.stderr.write("[onboarding-kit-transport] --approve-email3-lot exige --send-at <iso>.\n");
      process.exit(2);
    }
    if (lot.broadcast_id == null) {
      process.stderr.write(`[onboarding-kit-transport] lote "${args.approveEmail3LotId}" não tem broadcast criado ainda — rode --send primeiro.\n`);
      process.exit(2);
    }
    // #8136 fleet review (code-reviewer, P3): `assertEmail3ScheduleAuthorized`
    // só lança quando `kind === "email3" && !humanApproved` — é um NO-OP pra
    // qualquer outro `kind` (comentário anterior aqui afirmava o contrário).
    // Sem este check explícito, `--approve-email3-lot` aceitaria um lot_id
    // de email1/email2 e reagendaria aquele broadcast silenciosamente.
    if (lot.kind !== "email3") {
      process.stderr.write(
        `[onboarding-kit-transport] lote "${args.approveEmail3LotId}" é kind="${lot.kind}", não "email3" — --approve-email3-lot só se aplica a lotes de e-mail 3.\n`,
      );
      process.exit(2);
    }
    // aprovação É este próprio comando (só existe por invocação explícita).
    assertEmail3ScheduleAuthorized(lot.kind, true);
    if (args.pilot) {
      // #7922 piloto: repete prefixo + allowlist + tag + filtro e agenda pelo
      // caminho verificado (PATCH com filtro + releitura pós-PATCH).
      const sendAt = args.sendAt;
      try {
        const res = await approvePilotEmail3Lot(buildPilotKitDeps(kitCfg), lot, {
          recipients: pilotRecipients,
          sendAtFn: () => sendAt,
          allowUnechoedFilter: args.pilotAllowUnechoedFilter,
        });
        console.log(
          JSON.stringify(
            { mode: "PILOT-approve-email3-lot", lot_id: lot.lot_id, broadcast_id: lot.broadcast_id, status: res.status, send_at: res.send_at, filter_verification: res.verification.status },
            null,
            2,
          ),
        );
      } catch (e) {
        lot.last_error = redactEmails((e as Error).message);
        process.stderr.write(`${lot.last_error}\n`);
        process.exitCode = 1;
      } finally {
        try {
          persistLotUpdate(storePath, lot);
        } catch (pe) {
          process.stderr.write(`${recordUnpersistedLot(storePath, lot, pe)}\n`);
          process.exitCode = 1;
        }
      }
      return;
    }
    const updated = await updateBroadcast(lot.broadcast_id, { send_at: args.sendAt }, kitCfg);
    lot.send_at = args.sendAt;
    lot.status = updated.status === "scheduled" ? "scheduled" : lot.status;
    persistLotUpdate(storePath, lot);
    console.log(JSON.stringify({ mode: "approve-email3-lot", lot_id: lot.lot_id, broadcast_id: lot.broadcast_id, send_at: args.sendAt, kit_status: updated.status }, null, 2));
    return;
  }

  // --- --reconcile: só releitura de status dos lotes não-terminais ---
  if (args.reconcileOnly) {
    // #8136 fleet review (comment-analyzer, alta/P2): a versão anterior lia
    // `store` uma vez no topo de `main()`, mutava vários lotes em memória
    // durante o loop (com chamadas de rede `await` entre cada um) e só
    // escrevia tudo de volta com UM `writeStore` não-locked no fim — sem
    // passar pelo mesmo lock/re-leitura fresca que `claimLot`/
    // `persistLotUpdate` já usam. Um `--send` concorrente que reivindicasse/
    // persistisse um lote NESSA janela seria sobrescrito pelo `writeStore`
    // deste bloco, que carrega um snapshot desatualizado daquele lote. Fix:
    // persistir CADA lote individualmente via `persistLotUpdate` (mesmo
    // lock + re-leitura fresca de `claimLot`) assim que ele é reconciliado —
    // nunca um `writeStore` de lote-múltiplo fora do lock. A chamada de rede
    // (`reconcileLotWithKit`) continua fora do lock, de propósito (não
    // segurar o lock por 30s através de N round-trips de rede).
    //
    // #9367 item 1: o laço vive em `reconcileOpenLots` (compartilhado com o
    // início de cada `--send`). Aqui SEM `deleteBroadcast` — `--reconcile` é
    // só leitura e roda até com o kill switch desligado.
    const { results } = await reconcileOpenLots({ storePath, store, persist: true }, { getBroadcast: (id) => getBroadcast(id, kitCfg) });
    console.log(JSON.stringify({ mode: "reconcile", results }, null, 2));
    return;
  }

  if (args.pilot) {
    const snippetsDirPilot = resolve(ROOT, args.snippetsDir ?? onboardingCfg.snippets_dir ?? "data/snippets");
    let result: PilotPlanResult;
    try {
      result = await runPilotPlan(
        { send: args.send, allowUnechoedFilter: args.pilotAllowUnechoedFilter, storePath, store, recipients: pilotRecipients },
        {
          kit: buildPilotKitDeps(kitCfg),
          fetchSubscription: (e) =>
            fetchSubscriptionByIdKit(kitCfg, e.kit_subscriber_id != null ? String(e.kit_subscriber_id) : e.subscription_id, e.email),
          loadSnippet: (n) => loadSnippet(snippetsDirPilot, n),
          claimLot,
          persistLotUpdate,
          now: () => Date.now(),
        },
      );
    } catch (e) {
      process.stderr.write(`${redactEmails((e as Error).message)}\n`);
      process.exit(2);
    }
    console.log(JSON.stringify(result.summary, null, 2));
    if (result.failed) process.exitCode = 1;
    return;
  }

  // --- Plano normal: candidatos devidos → lotes por kind ---
  // #7922 (alarme de continuidade do transporte Kit): a rodada `--send` é
  // SEMPRE registrada — inclusive quando morre no meio (claimLot/
  // persistLotUpdate lançando): o registro sai com `aborted: true` e os
  // contadores parciais, e o erro segue propagando (exit != 0).
  const counters: SendRunCounters = {
    lots_created: 0,
    lots_failed: 0,
    lots_unverified: 0,
    blocked_concurrent: 0,
    refresh_candidates: 0,
    refresh_failed: 0,
    content_skipped: 0,
  };
  const summary = await runAndRecordSendRun(storePath, args.send, counters, () =>
    runNormalPlan({ args, onboardingCfg, store, kitCfg, kitTransportEnabled: kitTransportCfg.enabled === true, storePath }, counters),
  );
  console.log(JSON.stringify(summary, null, 2));
}

/**
 * Roda o plano normal e REGISTRA a rodada `--send` (`stampKitSendRun`) —
 * sempre: rodada que lança no meio sai como `aborted: true` com os contadores
 * parciais e o erro segue propagando (exit != 0 via `main().catch`). Falha
 * ao registrar não desfaz o que a rodada fez; vira exit != 0 visível.
 * Exportado pra teste (o caminho de exceção não é reproduzível por
 * subprocesso sem corromper o próprio store onde o registro é gravado).
 */
export async function runAndRecordSendRun(
  storePath: string,
  send: boolean,
  counters: SendRunCounters,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  let summary: Record<string, unknown>;
  try {
    summary = await run();
  } catch (e) {
    if (send) recordKitSendRunSafely(storePath, { ...counters, aborted: true, error: redactEmails((e as Error).message) });
    throw e;
  }
  if (send) summary.send_run = recordKitSendRunSafely(storePath, { ...counters });
  return summary;
}

/**
 * #7922: confirma o agendamento de um broadcast de e-mail 1/2 recém-criado
 * pela RELEITURA no Kit (mesma regra de `schedule-newsletter-kit.ts`: 2xx do
 * POST não é prova; o que vale é o `send_at` ecoado no GET — `status` é só
 * diagnóstico). Muta `lot`.
 *   - `"scheduled"`: releitura com status `scheduled` + `send_at` válido
 *     ecoado, OU status `sending`/`completed` (o envio já começou — #9367
 *     item 2: nesse caso o `send_at` pode nem vir ecoado, e mesmo assim é
 *     ENVIADO; nunca apagar). Lote `scheduled`/`completed`.
 *   - `"unscheduled"`: qualquer outra releitura — sem `send_at`, ou status
 *     fora de {scheduled, sending, completed} (#9367 item 3: `aborted` com
 *     `send_at` ecoado NÃO é agendado). O e-mail não sai sozinho. Apaga o
 *     broadcast e marca o lote `cancelled` (as entradas voltam ao plano na
 *     rodada seguinte); se o DELETE falhar, o lote fica `created` com
 *     `schedule_failed: true`, que tira dele o status de "confirmado"
 *     (`hasConfirmedKitLotForEntry`) — nunca prende as entradas. Exceção
 *     (#9367 item 2): DELETE que devolve 422 "already been sent" é o Kit
 *     dizendo que o broadcast JÁ SAIU (releitura atrasada além do `send_at`)
 *     — vira `"scheduled"` com lote `completed`, nunca volta ao plano (seria
 *     o e-mail 1 em dobro).
 *   - `"unverified"`: a releitura falhou (rede/API). Não se declara falha de
 *     ENTREGA sem leitura: o lote fica `created` (dedup preservada — não
 *     cria 2º broadcast pra quem pode já estar agendado), e a rodada conta
 *     como falha de transporte (`lots_unverified`). A rodada `--send`
 *     seguinte relê o lote ANTES de planejar (`reconcileOpenLots`, #9367
 *     item 1) — sem depender de um `--reconcile` agendado.
 */
export async function confirmOrCleanUpScheduledLot(
  lot: OnboardingKitLot,
  deps: { getBroadcast: (id: number) => Promise<{ status?: string | null; send_at?: string | null }>; deleteBroadcast: (id: number) => Promise<void> },
): Promise<"scheduled" | "unscheduled" | "unverified"> {
  const id = lot.broadcast_id as number;
  let reread: { status?: string | null; send_at?: string | null };
  try {
    reread = await deps.getBroadcast(id);
  } catch (e) {
    if (isKitNotFoundError(e)) {
      // #9460: 404 permanente = broadcast apagado (ex.: à mão na UI do Kit).
      // Não existe, logo não está agendado — mesma saída do "unscheduled"
      // com DELETE ok: lote `cancelled`, entradas voltam ao plano. Mantê-lo
      // `created` prenderia as entradas (contam como confirmadas) e o streak
      // de `lots_unverified` nunca zeraria.
      lot.status = "cancelled";
      lot.send_at = null;
      delete lot.schedule_failed;
      lot.last_error = `broadcast ${id} não existe mais no Kit (404 na releitura) — lote cancelado (entradas voltam ao plano)`;
      return "unscheduled";
    }
    lot.status = "created";
    lot.last_error = `releitura do broadcast ${id} falhou — agendamento NÃO confirmado: ${redactEmails((e as Error).message)}`;
    return "unverified";
  }
  const sendAt = reread.send_at ?? null;
  const sendAtValid = sendAt != null && !Number.isNaN(Date.parse(sendAt));
  if (reread.status === "sending" || reread.status === "completed") {
    // #9367 item 2: já saiu (ou está saindo) — enviado, com ou sem `send_at`.
    if (sendAtValid) lot.send_at = sendAt;
    lot.status = "completed";
    lot.last_error = null;
    delete lot.schedule_failed;
    return "scheduled";
  }
  if (reread.status === "scheduled" && sendAtValid) {
    lot.send_at = sendAt;
    lot.status = "scheduled";
    lot.last_error = null;
    delete lot.schedule_failed;
    return "scheduled";
  }
  const why = `broadcast ${id} sem agendamento na releitura (send_at ${JSON.stringify(reread.send_at ?? null)}, status Kit "${reread.status ?? "?"}") — e-mail não sai sozinho`;
  try {
    await deps.deleteBroadcast(id);
    lot.status = "cancelled";
    lot.send_at = null;
    lot.last_error = `${why}; broadcast apagado, lote cancelado (entradas voltam ao plano)`;
  } catch (e) {
    if (isKitAlreadySentError(e)) {
      // #9367 item 2: o Kit recusou apagar porque o broadcast já foi enviado.
      lot.status = "completed";
      delete lot.schedule_failed;
      lot.last_error = `${why}; DELETE recusado com 422 "already been sent" — broadcast JÁ ENVIADO, lote marcado completed`;
      return "scheduled";
    }
    if (isKitNotFoundError(e)) {
      // #9460: sumiu entre a releitura e o DELETE — o efeito desejado (não
      // existir broadcast) já vale.
      lot.status = "cancelled";
      lot.send_at = null;
      delete lot.schedule_failed;
      lot.last_error = `${why}; DELETE devolveu 404 — broadcast já não existe, lote cancelado (entradas voltam ao plano)`;
      return "unscheduled";
    }
    lot.status = "created";
    lot.schedule_failed = true;
    lot.last_error = `${why}; DELETE falhou (${redactEmails((e as Error).message)}) — rascunho ficou no Kit, lote marcado schedule_failed`;
  }
  return "unscheduled";
}

/** #9367 item 2: `DELETE /broadcasts/{id}` de um broadcast que já saiu
 *  devolve 422 `"Broadcast has already been sent."` (confirmado ao vivo —
 *  docstring de `kit-broadcasts.ts`). É o Kit confirmando o ENVIO, não uma
 *  falha do DELETE. */
export function isKitAlreadySentError(e: unknown): boolean {
  return e instanceof KitApiError && e.status === 422 && /already been sent/i.test(e.body);
}

/** #9460: 404 do Kit num broadcast = ele não existe (apagado na UI). Pra
 *  releitura/DELETE de lote, equivale a "não agendado". */
export function isKitNotFoundError(e: unknown): boolean {
  return e instanceof KitApiError && e.status === 404;
}

/** `--cancel-lot`: apaga o broadcast e marca o lote `cancelled`. #9460: 404 no
 *  DELETE (broadcast já apagado à mão) também cancela — antes o lote ficava
 *  `created` pra sempre e só editar o store resolvia. Outros erros propagam
 *  (o caller grava `last_error` e sai != 0). Muta `lot`. */
export async function cancelKitLot(
  lot: OnboardingKitLot,
  deleteFn: (id: number) => Promise<void>,
): Promise<"deleted" | "already_gone"> {
  const id = lot.broadcast_id as number;
  let outcome: "deleted" | "already_gone" = "deleted";
  try {
    await deleteFn(id);
  } catch (e) {
    if (!isKitNotFoundError(e)) throw e;
    outcome = "already_gone";
  }
  lot.status = "cancelled";
  lot.send_at = null;
  delete lot.schedule_failed;
  lot.last_error = outcome === "already_gone" ? `--cancel-lot: broadcast ${id} já não existia no Kit (404) — lote cancelado` : null;
  return outcome;
}

/** Contadores de uma rodada `--send` (tudo de `KitSendRunRecord` menos o carimbo). */
type SendRunCounters = Omit<KitSendRunRecord, "at" | "aborted" | "error">;

/** Carimba a rodada (`stampKitSendRun`) sem nunca lançar — falha de
 *  registro vira stderr + exit != 0. Devolve o registro montado. */
function recordKitSendRunSafely(storePath: string, run: Omit<KitSendRunRecord, "at">): KitSendRunRecord {
  const record: KitSendRunRecord = { at: new Date().toISOString(), ...run };
  try {
    stampKitSendRun(storePath, record);
  } catch (e) {
    process.stderr.write(`[onboarding-kit-transport] falha ao registrar last_send_run: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
  return record;
}

interface NormalPlanCtx {
  args: CliArgs;
  onboardingCfg: ReturnType<typeof loadOnboardingConfig>;
  store: OnboardingStore;
  kitCfg: KitConfig;
  kitTransportEnabled: boolean;
  storePath: string;
}

/**
 * Plano normal (não-piloto): candidatos devidos → lotes por kind. Atualiza
 * `counters` À MEDIDA que a rodada avança (o caller registra os parciais se
 * algo lançar no meio). Devolve o resumo impresso.
 */
async function runNormalPlan(ctx: NormalPlanCtx, counters: SendRunCounters): Promise<Record<string, unknown>> {
  const { args, onboardingCfg, store, kitCfg, storePath } = ctx;
  store.kit_transport ??= { lots: {} };
  const email2Days = onboardingCfg.email2_days ?? 3;
  const email3Days = onboardingCfg.email3_days ?? 10;
  const graceDays = onboardingCfg.email3_grace_days ?? 10;
  const nowSec = Math.floor(Date.now() / 1000);

  // #9367 item 1: reler os lotes abertos ANTES de planejar — um lote de e-mail
  // 1/2 `unverified` de uma rodada anterior (releitura de confirmação falhou)
  // prendia as entradas em silêncio até alguém rodar `--reconcile`, que nada
  // agenda em produção. No `--send` a releitura pode limpar (apagar broadcast
  // não agendado) e persiste; no dry-run é só leitura, em memória.
  const preSend = await reconcileOpenLots(
    { storePath, store, persist: args.send },
    {
      getBroadcast: (id) => getBroadcast(id, kitCfg),
      ...(args.send ? { deleteBroadcast: (id: number) => deleteBroadcast(id, kitCfg) } : {}),
    },
  );
  counters.lots_unverified += preSend.stillUnverified;

  const candidates = selectCandidatesNeedingRefresh(Object.values(store.entries), nowSec, email2Days, email3Days);
  const statsById: Record<string, { total_unique_opened?: number | null; total_clicked?: number | null } | null> = {};
  // #8136 fleet review (silent-failure-hunter, alta/P1): antes, um lookup
  // falho deixava `e.status_detectado` intocado — como esse campo é o
  // ESTADO PERSISTIDO no store (populado na última vez que o refresh deu
  // certo, tipicamente "active"), `kit_state: e.status_detectado ?? null`
  // (abaixo) nunca virava `null` num refresh falho, e a exclusão
  // `status_nao_confirmado` de `selectEligibleKitRecipients` nunca disparava
  // — exatamente o oposto do requisito da issue ("Falha de consulta não
  // autoriza envio", já testado no módulo puro, nunca exercitado aqui).
  // Fix: rastrear falha de refresh NESTA rodada separado do campo
  // persistido — nunca mutar `status_detectado` numa falha (preserva o
  // último estado bom conhecido pro store), mas forçar `kit_state: null`
  // só na hora de montar `rawCandidates` (abaixo) pra quem falhou agora.
  const refreshFailedThisRun = new Set<string>();
  counters.refresh_candidates = candidates.length;
  for (const e of candidates) {
    // #7922: só erro de TRANSPORTE (rede/auth/5xx) conta no alarme —
    // "assinante não existe mais no Kit" é crônico por pessoa, não apagão.
    const diag = { transportError: false };
    const fresh = await fetchSubscriptionByIdKit(
      kitCfg,
      e.kit_subscriber_id != null ? String(e.kit_subscriber_id) : e.subscription_id,
      e.email,
      diag,
    );
    if (fresh) {
      e.status_detectado = fresh.status ?? e.status_detectado;
      statsById[e.subscription_id] = fresh.stats ?? null;
      if (typeof fresh.resolvedKitId === "number") e.kit_subscriber_id = fresh.resolvedKitId;
    } else {
      refreshFailedThisRun.add(e.subscription_id);
      if (diag.transportError) counters.refresh_failed++;
      process.stderr.write(`[onboarding-kit-transport] refresh falhou pra ${e.subscription_id} — status NÃO CONFIRMADO nesta rodada, excluído da seleção (fail-safe)\n`);
    }
  }

  const snippetsDirAbs = resolve(ROOT, args.snippetsDir ?? onboardingCfg.snippets_dir ?? "data/snippets");
  // #8966: espelho do guard aplicado do lado Brevo (`onboarding-welcome-run.ts`)
  // — sem isto, uma entrada cujo e-mail 1 já saiu pela Brevo seria planejada
  // pelos DOIS executores no mesmo e-mail 2. Ver docstring de
  // `filterKitPlanForBrevoInFlight` (onboarding-state.ts).
  const plan = filterKitPlanForBrevoInFlight(
    buildRunPlan({
      entries: Object.values(store.entries),
      statsById,
      nowSec,
      email2Days,
      email3Days,
      email3GraceDays: graceDays,
      snippets: {
        1: loadSnippet(snippetsDirAbs, 1),
        2: loadSnippet(snippetsDirAbs, 2),
        3: loadSnippet(snippetsDirAbs, 3),
      },
    }),
    ctx.kitTransportEnabled,
    // #9014: defesa em profundidade — entrada já presente num lote Kit
    // confirmado de QUALQUER dia anterior nunca entra num lote novo.
    Object.values(store.kit_transport.lots),
  );

  const dateIso = unixSecondsToBrtDate(nowSec);
  const summary: Record<string, unknown> = { mode: args.send ? "SEND" : "dry-run", now: new Date(nowSec * 1000).toISOString(), lots: [] as unknown[] };
  if (preSend.results.length > 0) summary.reconciled_before_send = preSend.results;
  // #7922 (gap #3, audit pós-merge da fatia 1/N): `plan.skips` (candidatos
  // barrados por elegibilidade/guard de conteúdo — snippet ausente/pendente,
  // idade mínima, sem abertura, etc.) nunca aparecia no output deste
  // executor, diferente do irmão `onboarding-welcome-run.ts`
  // (`summary.skips = plan.skips.map(...)`, adicionado depois do #7670: um
  // skip silencioso fez o e-mail 3 nunca disparar pra ninguém, por meses,
  // com o script saindo exit 0 o tempo todo). Mesma forma/convenção do
  // irmão — nunca inclui `entry` bruta (PII) no resumo impresso.
  summary.skips = plan.skips.map((s) => ({ etapa: s.etapa, motivo: s.motivo, detalhe: s.detalhe }));
  // #7922: ação devida a ESTE executor barrada por guard de conteúdo
  // (snippet ausente/pendente/inválido) é e-mail que não sai — conta como
  // falha da rodada (`isFailedKitSendRun`), senão "0 lotes, 0 falhas" = ok
  // indefinidamente.
  counters.content_skipped = countKitContentSkips(
    plan.skips,
    (entry, etapa) => ownerTransportFor(entry, etapa, ctx.kitTransportEnabled) === "kit",
  );

  for (const kind of ["email1", "email2", "email3"] as OnboardingKitLotKind[]) {
    const actionsOfKind: RunAction[] =
      kind === "email3" ? plan.actions.filter((a) => a.kind === "email3_campaign") : plan.actions.filter((a) => a.kind === kind);
    if (actionsOfKind.length === 0) continue;

    const entries = kind === "email3" ? (actionsOfKind[0] as Extract<RunAction, { kind: "email3_campaign" }>).entries : actionsOfKind.map((a) => (a as Extract<RunAction, { kind: "email1" | "email2" }>).entry);

    const rawCandidates: OnboardingKitCandidate[] = entries.map((e) => ({
      subscription_id: e.subscription_id,
      email: e.email,
      kit_subscriber_id: e.kit_subscriber_id ?? null,
      // #8136 fleet review, achado acima: refresh falho nesta rodada força
      // null (não-confirmado), mesmo que `status_detectado` persistido
      // ainda carregue um valor antigo "active" de uma checagem anterior.
      kit_state: refreshFailedThisRun.has(e.subscription_id) ? null : (e.status_detectado ?? null),
      seeded_by: e.seeded_by ?? null,
    }));
    const { eligible, excluded } = selectEligibleKitRecipients(rawCandidates);
    if (eligible.length === 0) {
      // `excluded` fica como contagem (compat com o formato anterior do
      // resumo) — o MOTIVO de cada exclusão (ex: "falha de consulta" nunca
      // autoriza envio) vai em `excludedReasons`, nunca só implícito na
      // contagem. Achado do fleet review da PR #8967: sem este campo, o
      // teste de regressão de "falha de consulta" não tinha como verificar
      // a RAZÃO da exclusão neste ramo (só o `eligible.length === 0`),
      // deixando a asserção mais importante do teste sem nunca rodar.
      (summary.lots as unknown[]).push({
        kind,
        eligible: 0,
        excluded: excluded.length,
        excludedReasons: excluded.map((x) => ({ email: x.candidate.email, reason: x.reason })),
        note: "nenhum destinatário elegível — nada a fazer",
      });
      continue;
    }

    const lotPlan = planLot({ kind, dateIso, seq: 1, eligible });

    if (!args.send) {
      // #7922 (gap #4): mesma fonte de verdade de `claimLot` — o lote MAIS
      // NOVO da chave, nunca fixo no slot seq=1 — senão o preview de
      // dry-run mentiria "reconciliation: recreate_after_timeout" pra
      // sempre depois da 1ª recriação, mesmo já existindo um lote seq=2+
      // com broadcast confirmado.
      const existingLot = findLatestLotForKindDate(store.kit_transport.lots, kind, dateIso);
      const decision = decideLotReconciliation(existingLot, Date.now());
      // Fleet review pré-merge: espelha o `effectivePlan` real de `claimLot`
      // (mesma correção do achado acima) — "reuse" mostra o lote reusado de
      // verdade; qualquer caso com `existingLot` (recreate OU create-após-
      // cancelamento) mostra a identidade NOVA que `rebuildLotPlanForRecreate`
      // de fato geraria; só "create" sem `existingLot` mostra `lotPlan.lot_id`
      // cru. Sem isso o preview de dry-run mentia o `lot_id` real em 2 dos 3
      // casos não-reuse.
      const previewLotId =
        decision.action === "reuse"
          ? decision.lot.lot_id
          : existingLot != null
            ? rebuildLotPlanForRecreate(lotPlan, store.kit_transport.lots).lot_id
            : lotPlan.lot_id;
      (summary.lots as unknown[]).push({
        kind,
        lot_id: previewLotId,
        eligible: eligible.length,
        excluded: excluded.map((x) => ({ email: x.candidate.email, reason: x.reason })),
        reconciliation: decision.action,
      });
      continue;
    }

    // #7922 (self-review): decidir "existe lote?" + persistir o `pending`
    // precisa ser UMA operação atômica entre PROCESSOS, não só entre
    // chamadas de função (issue: "exclusão mútua para impedir duplicação
    // entre rodadas") — `claimLot` faz isso sob lock de arquivo, relendo o
    // disco fresco em vez da cópia em memória capturada no início de
    // `main()`. Ver docstring de `claimLot`.
    const claim = claimLot(storePath, lotPlan);

    // #7922 (gap #4): `lot_id` no resumo reflete o lote de fato encontrado
    // (`claim.decision.lot`/`claim.lot`), nunca `lotPlan.lot_id` (sempre
    // seq=1 fixo) — desde que a reconciliação passou a olhar pro lote MAIS
    // NOVO da chave, os dois podem divergir depois de uma recriação.
    if (claim.decision.action === "blocked_concurrent") {
      // NÃO conta falha: um `pending` com `last_error` dentro da janela de
      // stale (15 min, `LOT_STALE_AFTER_MS`) é a falha de uma rodada
      // ANTERIOR, que já entrou no contador dela — contar de novo aqui
      // dobraria a streak (que é por rodada) com uma única falha real. Conta
      // só como `blocked_concurrent`, que deixa a rodada NEUTRA na streak.
      counters.blocked_concurrent++;
      (summary.lots as unknown[]).push({
        kind,
        lot_id: claim.decision.lot.lot_id,
        skipped: "blocked_concurrent — outra rodada pode estar processando este lote",
      });
      continue;
    }
    if (claim.decision.action === "reuse") {
      (summary.lots as unknown[]).push({
        kind,
        lot_id: claim.lot?.lot_id ?? lotPlan.lot_id,
        skipped: "reuse — broadcast já existe",
        broadcast_id: claim.lot?.broadcast_id ?? null,
      });
      continue;
    }

    const lot = claim.lot as OnboardingKitLot; // "create"/"recreate_after_timeout" sempre devolve um lote pending
    store.kit_transport.lots[lot.lot_id] = lot; // mantém a cópia em memória coerente pro restante deste processo

    // #7922 (gap #4, audit pós-merge da fatia 1/N): daqui pra baixo, usar
    // `lot.*` — NUNCA `lotPlan.*` — pra tag/destinatários/lot_id. Num
    // "recreate_after_timeout", `claimLot` já reconstruiu a identidade
    // (`rebuildLotPlanForRecreate`, seq incrementado — `lot.lot_id`/
    // `lot.tag_name` diferem de `lotPlan.lot_id`/`lotPlan.tag_name`, que
    // continuam apontando pra identidade VELHA). Taguear/criar o broadcast
    // com `lotPlan.tag_name` aqui reintroduziria exatamente o problema que a
    // identidade nova existe pra evitar.
    try {
      const tagId = await resolveOrCreateLotTagId(lot.tag_name, kitCfg);
      lot.tag_id = tagId;
      for (const subId of lot.recipient_subscription_ids) {
        const entry = store.entries[subId];
        const kitId = entry?.kit_subscriber_id;
        if (kitId != null) await tagSubscriber(tagId, kitId, kitCfg);
      }
      const snippet = loadSnippet(snippetsDirAbs, KIND_TO_SNIPPET_NUM[kind]);
      const input = buildOnboardingBroadcastInput({
        kind,
        subject: snippet?.assunto ?? "",
        content: snippet?.body ?? "",
        previewText: snippet?.previewText ?? undefined,
        tagId,
        sendAt: kind === "email3" ? null : new Date(Date.now() + 60_000).toISOString(),
      });
      const broadcast = await createBroadcast(input, kitCfg);
      lot.broadcast_id = broadcast.id;
      lot.status = mapKitBroadcastStatusToLocal(broadcast.status);
      lot.send_at = broadcast.send_at ?? null;
      // #7922: e-mail 1/2 nasce com `send_at` — o agendamento só vale
      // confirmado pela RELEITURA (`confirmOrCleanUpScheduledLot`), nunca
      // pelo `status` da resposta do POST. E-mail 3 nasce rascunho por
      // desenho (aprovação humana), então `created` é o sucesso dele.
      const outcome = kind === "email3" ? "scheduled" : await confirmOrCleanUpScheduledLot(lot, { getBroadcast: (id) => getBroadcast(id, kitCfg), deleteBroadcast: (id) => deleteBroadcast(id, kitCfg) });
      persistLotUpdate(storePath, lot);
      if (outcome === "scheduled") {
        counters.lots_created++;
        (summary.lots as unknown[]).push({ kind, lot_id: lot.lot_id, created: true, broadcast_id: broadcast.id, recipients: lot.recipient_emails.length });
      } else if (outcome === "unverified") {
        counters.lots_unverified++;
        (summary.lots as unknown[]).push({ kind, lot_id: lot.lot_id, created: true, unverified: true, broadcast_id: broadcast.id, warning: lot.last_error });
      } else {
        counters.lots_failed++;
        (summary.lots as unknown[]).push({ kind, lot_id: lot.lot_id, created: false, broadcast_id: broadcast.id, status: lot.status, error: lot.last_error });
      }
    } catch (e) {
      counters.lots_failed++;
      lot.last_error = (e as Error).message;
      persistLotUpdate(storePath, lot);
      (summary.lots as unknown[]).push({ kind, lot_id: lot.lot_id, created: false, error: (e as Error).message });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Modo piloto (#7922, seção 4 de docs/onboarding-kit-cutover.md)
// ---------------------------------------------------------------------------

/** Kill switch de produção: escrita bloqueada se não está ligado — EXCETO
 *  com `--pilot` (store isolado + allowlist já garantidos antes). */
export function isWriteBlockedByKillSwitch(writeRequested: boolean, enabled: boolean | undefined, pilot: boolean): boolean {
  return writeRequested && enabled !== true && !pilot;
}

function buildPilotKitDeps(kitCfg: KitConfig): PilotKitDeps {
  return {
    findTagIdByName: (name) => findTagIdByName(name, kitCfg),
    createTag: (name) => createTag(name, kitCfg),
    tagSubscriber: (tagId, subId) => tagSubscriber(tagId, subId, kitCfg),
    listTagMemberEmails: (tagId) => listAllTagSubscriberEmails(tagId, kitCfg),
    createBroadcast: (input) => createBroadcast(input, kitCfg),
    getBroadcast: (id) => getBroadcast(id, kitCfg),
    updateBroadcast: (id, patch) => updateBroadcast(id, patch, kitCfg),
    deleteBroadcast: (id) => deleteBroadcast(id, kitCfg),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    warn: (msg) => {
      process.stderr.write(`${msg}\n`);
    },
  };
}

/** Semeia (sob lock) o store isolado com as entries sintéticas do piloto. */
export function seedPilotStoreOnDisk(storePath: string, recipients: string[], nowIso: string = new Date().toISOString()): number {
  let created = 0;
  withFileLock(
    `${storePath}.lock`,
    () => {
      const { store, corrupted } = readStore(storePath);
      if (corrupted) throw new Error(`[onboarding-kit-pilot] store isolado "${storePath}" está CORROMPIDO — abortando.`);
      created = seedPilotStore(store, recipients, nowIso);
      if (created > 0) writeStore(store, storePath);
    },
    30_000,
  );
  return created;
}

// ---------------------------------------------------------------------------
// Sidecar de broadcasts não persistidos (#7922 piloto)
// ---------------------------------------------------------------------------

export interface PendingBroadcastRecord {
  lot_id: string;
  kind: OnboardingKitLotKind;
  broadcast_id: number;
  status: string;
  recorded_at: string;
}

/** `<store>.pending-broadcasts.json` — registro de último recurso quando o
 *  `persistLotUpdate` falha DEPOIS de um broadcast existir no Kit. */
export function pendingBroadcastSidecarPath(storePath: string): string {
  return `${storePath}.pending-broadcasts.json`;
}

export function readPendingBroadcastSidecar(storePath: string): PendingBroadcastRecord[] {
  const p = pendingBroadcastSidecarPath(storePath);
  if (!existsSync(p)) return [];
  const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`[onboarding-kit-pilot] sidecar "${p}" ilegível (não é array) — confira à mão.`);
  return parsed as PendingBroadcastRecord[];
}

/** Append (lê + regrava o array). Sem lock: só é chamado quando o caminho
 *  com lock (`persistLotUpdate`) já falhou. */
export function appendPendingBroadcastSidecar(storePath: string, rec: PendingBroadcastRecord): void {
  let existing: PendingBroadcastRecord[] = [];
  try {
    existing = readPendingBroadcastSidecar(storePath);
  } catch {
    existing = [];
  }
  existing.push(rec);
  writeFileSync(pendingBroadcastSidecarPath(storePath), JSON.stringify(existing, null, 2) + "\n");
}

/** Registra no sidecar (se houver broadcast) e devolve a mensagem de aviso. */
function recordUnpersistedLot(storePath: string, lot: OnboardingKitLot, err: unknown): string {
  const base =
    `[onboarding-kit-pilot] FALHA ao persistir lote ${lot.lot_id} (broadcast_id=${lot.broadcast_id ?? "null"}, status=${lot.status}): ` +
    `${redactEmails((err as Error).message)}`;
  if (lot.broadcast_id == null) return `${base} — nenhum broadcast criado, nada a proteger.`;
  try {
    appendPendingBroadcastSidecar(storePath, {
      lot_id: lot.lot_id,
      kind: lot.kind,
      broadcast_id: lot.broadcast_id,
      status: lot.status,
      recorded_at: new Date().toISOString(),
    });
    return `${base} — registrado em ${pendingBroadcastSidecarPath(storePath)}; o piloto não recria este kind enquanto o registro existir.`;
  } catch (se) {
    return `${base} — E o sidecar também falhou (${(se as Error).message}). REGISTRE O broadcast_id À MÃO antes de re-rodar (risco de 2º envio).`;
  }
}

/** Tudo que `runPilotPlan` toca fora de si — injetável nos testes. */
export interface PilotPlanDeps {
  kit: PilotKitDeps;
  /** Refresh do estado Kit de uma entry (pelo e-mail); `null` = falhou. */
  fetchSubscription(entry: OnboardingEntry): Promise<{ status?: string; resolvedKitId?: number } | null>;
  loadSnippet(numero: 1 | 2 | 3): ReturnType<typeof parseOnboardingSnippet>;
  claimLot: typeof claimLot;
  persistLotUpdate: typeof persistLotUpdate;
  now(): number;
}

export interface PilotPlanResult {
  summary: {
    mode: "PILOT-SEND" | "PILOT-dry-run";
    now: string;
    pilot_recipients: number;
    seeded_entries: number;
    refresh_failed: number;
    lots: Record<string, unknown>[];
  };
  failed: boolean;
}

/**
 * Plano do piloto — substitui `buildRunPlan` (sem cadência). Dry-run semeia
 * só em memória e nunca grava o store. Toda falha de lote marca `failed`
 * (o caller sai 1); o lote é SEMPRE persistido (mesmo se `runPilotLot`
 * lançar) e, se a própria persistência falhar, o erro vai pro stderr com
 * lot_id/broadcast_id/status — nunca esconde o erro original.
 */
export async function runPilotPlan(
  ctx: { send: boolean; allowUnechoedFilter: boolean; storePath: string; store: OnboardingStore; recipients: string[] },
  deps: PilotPlanDeps,
): Promise<PilotPlanResult> {
  const { storePath, recipients } = ctx;
  let store = ctx.store;
  let seeded: number;
  if (ctx.send) {
    seeded = seedPilotStoreOnDisk(storePath, recipients, new Date(deps.now()).toISOString());
    const reread = readStore(storePath);
    if (reread.corrupted) throw new Error(`[onboarding-kit-pilot] store isolado "${storePath}" ilegível após a semeadura — abortando.`);
    store = reread.store;
  } else {
    seeded = seedPilotStore(store, recipients, new Date(deps.now()).toISOString());
  }
  store.kit_transport ??= { lots: {} };

  const refreshFailed = new Set<string>();
  for (const e of Object.values(store.entries)) {
    const fresh = await deps.fetchSubscription(e);
    if (fresh) {
      e.status_detectado = fresh.status ?? e.status_detectado;
      if (typeof fresh.resolvedKitId === "number") e.kit_subscriber_id = fresh.resolvedKitId;
    } else {
      refreshFailed.add(e.subscription_id);
    }
  }

  const dateIso = unixSecondsToBrtDate(Math.floor(deps.now() / 1000));
  const summary: PilotPlanResult["summary"] = {
    mode: ctx.send ? "PILOT-SEND" : "PILOT-dry-run",
    now: new Date(deps.now()).toISOString(),
    pilot_recipients: recipients.length,
    seeded_entries: seeded,
    refresh_failed: refreshFailed.size,
    lots: [],
  };
  let failed = false;

  for (const kind of ["email1", "email2", "email3"] as OnboardingKitLotKind[]) {
    const entries = selectPilotEntriesForKind(store, kind, recipients);
    if (entries.length === 0) {
      summary.lots.push({ kind, note: "todos os destinatários já têm lote confirmado deste kind — nada a fazer" });
      continue;
    }
    const { eligible, excluded } = selectEligibleKitRecipients(
      entries.map((e) => ({
        subscription_id: e.subscription_id,
        email: e.email,
        kit_subscriber_id: e.kit_subscriber_id ?? null,
        kit_state: refreshFailed.has(e.subscription_id) ? null : (e.status_detectado ?? null),
        seeded_by: e.seeded_by ?? null,
      })),
    );
    const excludedReasons = excluded.map((x) => x.reason);
    if (eligible.length === 0) {
      summary.lots.push({ kind, eligible: 0, excluded: excluded.length, excludedReasons, note: "nenhum destinatário elegível" });
      continue;
    }
    const snippet = deps.loadSnippet(KIND_TO_SNIPPET_NUM[kind]);
    if (!snippet?.assunto || !snippet.body || snippet.hasPendingMarker) {
      summary.lots.push({ kind, eligible: eligible.length, failed: true, error: `snippet onboarding-${KIND_TO_SNIPPET_NUM[kind]}.md ausente/vazio/pendente` });
      failed = true;
      continue;
    }
    const lotPlan = planLot({ kind, dateIso, seq: 1, eligible });
    if (!ctx.send) {
      summary.lots.push({ kind, lot_id: lotPlan.lot_id, tag_name: buildPilotLotTagName(lotPlan.lot_id), eligible: eligible.length, excluded: excluded.length, excludedReasons });
      continue;
    }

    // Broadcast criado numa rodada cujo store não persistiu: nunca recriar.
    const sidecarHit = readPendingBroadcastSidecar(storePath).find((r) => r.kind === kind && r.broadcast_id != null);
    if (sidecarHit) {
      summary.lots.push({ kind, lot_id: sidecarHit.lot_id, broadcast_id: sidecarHit.broadcast_id, skipped: "reuse (pending-broadcasts sidecar)" });
      continue;
    }
    const claim = deps.claimLot(storePath, lotPlan, deps.now(), buildPilotLotTagName);
    if (claim.decision.action === "reuse") {
      summary.lots.push({ kind, lot_id: claim.decision.lot.lot_id, skipped: "reuse" });
      continue;
    }
    if (claim.decision.action === "blocked_concurrent") {
      const blocked = claim.decision.lot;
      if (blocked.last_error) {
        // Lote pendente que FALHOU há pouco (janela de stale) — é falha, não "outra rodada em curso".
        failed = true;
        summary.lots.push({ kind, lot_id: blocked.lot_id, failed: true, error: `lote pendente com erro recente: ${redactEmails(blocked.last_error)}` });
      } else {
        summary.lots.push({ kind, lot_id: blocked.lot_id, skipped: "blocked_concurrent" });
      }
      continue;
    }
    const lot = claim.lot as OnboardingKitLot;
    const kitIdBySubscription: Record<string, number | undefined> = {};
    for (const subId of lot.recipient_subscription_ids) kitIdBySubscription[subId] = store.entries[subId]?.kit_subscriber_id;
    try {
      const res = await runPilotLot(deps.kit, lot, {
        recipients,
        kitIdBySubscription,
        subject: snippet.assunto,
        content: snippet.body,
        previewText: snippet.previewText ?? undefined,
        sendAtFn: () => new Date(deps.now() + 5 * 60_000).toISOString(),
        allowUnechoedFilter: ctx.allowUnechoedFilter,
      });
      lot.last_error = null;
      summary.lots.push({
        kind,
        lot_id: lot.lot_id,
        broadcast_id: res.broadcast_id,
        status: res.status,
        send_at: res.send_at,
        filter_verification: res.filter_verification,
        filter_echoed: res.filter_echoed ?? null,
        recipients: lot.recipient_emails.length,
      });
    } catch (e) {
      lot.last_error = redactEmails((e as Error).message);
      failed = true;
      summary.lots.push({ kind, lot_id: lot.lot_id, broadcast_id: lot.broadcast_id, status: lot.status, failed: true, error: lot.last_error });
    } finally {
      // Nunca perder o registro de um broadcast já criado — e nunca deixar a
      // falha de persistência engolir o erro original.
      try {
        deps.persistLotUpdate(storePath, lot);
      } catch (pe) {
        failed = true;
        deps.kit.warn(recordUnpersistedLot(storePath, lot, pe));
        summary.lots.push({ kind, lot_id: lot.lot_id, broadcast_id: lot.broadcast_id, failed: true, error: "persistência do lote falhou — ver stderr" });
      }
    }
  }

  return { summary, failed };
}


if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[onboarding-kit-transport] fatal: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
