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
 * store, sem escrever nos campos que o script Brevo possui
 * (`email{1,2}_sent_at`, `email{1,2}_brevo_id`, `email3_state`/`email3_campaign_id`
 * continuam exclusivos do caminho Brevo). O que este script persiste vive só
 * em `store.kit_transport.lots`, um namespace próprio dentro do MESMO
 * arquivo (issue: "sem criar outra fonte de verdade"). Cutover real (decidir
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
 * Flags auxiliares (testes/operações): --store <path>, --snippets-dir <path>,
 * --config <path>, --env-root <path>.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { getBroadcast } from "./lib/kit-client.ts";
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
import { parseOnboardingSnippet, buildRunPlan, selectCandidatesNeedingRefresh, type RunAction } from "./lib/onboarding-state.ts";
import {
  planLot,
  selectEligibleKitRecipients,
  buildOnboardingBroadcastInput,
  assertEmail3ScheduleAuthorized,
  decideLotReconciliation,
  reconcileLotWithKit,
  rebuildLotPlanForRecreate,
  findLatestLotForKindDate,
  type OnboardingKitCandidate,
  type OnboardingKitLot,
  type OnboardingKitLotKind,
  type OnboardingKitLotPlan,
  type LotReconciliationDecision,
} from "./lib/onboarding-kit-transport.ts";
import { loadOnboardingConfig, fetchSubscriptionByIdKit } from "./onboarding-welcome-run.ts";
import { isMainModule } from "./lib/cli-args.ts";

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
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { send: false, reconcileOnly: false };
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
export function claimLot(storePath: string, lotPlan: OnboardingKitLotPlan, nowMs: number = Date.now()): ClaimLotResult {
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
      // #7922 (gap #4, audit pós-merge da fatia 1/N): "recreate_after_timeout"
      // NUNCA reusa lot_id/tag_name do lote velho — precisa de identidade NOVA
      // (`rebuildLotPlanForRecreate`, seq incrementado via `nextLotSeq`) pra
      // (a) nunca sobrescrever/perder o registro do lote velho no store
      // (evidência de auditoria de um possível broadcast órfão no Kit) e
      // (b) nunca reusar uma tag que possa já estar amarrada a um broadcast
      // que a tentativa anterior de fato criou, mas cujo response se perdeu
      // antes de `broadcast_id` ser persistido localmente — risco residual
      // documentado na docstring de `decideLotReconciliation`/gap #1 (mesmo
      // audit). "create" (nenhum lote local pra esta chave) continua usando
      // `lotPlan` tal como veio — não há identidade velha a evitar.
      const effectivePlan =
        decision.action === "recreate_after_timeout" ? rebuildLotPlanForRecreate(lotPlan, freshStore.kit_transport.lots) : lotPlan;
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
export function persistLotUpdate(storePath: string, lot: OnboardingKitLot): void {
  const lockPath = `${storePath}.lock`;
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

  const backend = resolveNewsletterSubscriberBackend(configPathAbs);
  if (backend !== "kit") {
    process.stderr.write(
      `[onboarding-kit-transport] backend de assinante atual é "${backend}", não "kit" — nada a taguear/enviar. Abortando.\n`,
    );
    process.exit(2);
  }

  const kitResult = resolveKitConfig();
  if (!kitResult.ok) {
    process.stderr.write(`[onboarding-kit-transport] ${kitResult.reason}\n`);
    process.exit(2);
  }
  const kitCfg = kitResult.config;

  const storePath = args.storePath ?? resolve(ROOT, onboardingCfg.store_path ?? DEFAULT_STORE_PATH);
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
    process.exit(2);
  }
  store.kit_transport ??= { lots: {} };

  // --- Kill switch dedicado — checado ANTES de qualquer ação de escrita.
  // Leituras (--reconcile, dry-run de plano) não dependem dele: consultar o
  // Kit não é "armar" o transporte. ---
  const writeRequested = args.send || args.cancelLotId != null || args.approveEmail3LotId != null;
  if (writeRequested && kitTransportCfg.enabled !== true) {
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
    try {
      await deleteBroadcast(lot.broadcast_id, kitCfg);
      lot.status = "cancelled";
      persistLotUpdate(storePath, lot);
      console.log(JSON.stringify({ mode: "cancel-lot", lot_id: lot.lot_id, broadcast_id: lot.broadcast_id, ok: true }, null, 2));
    } catch (e) {
      // #7922: 422 "Broadcast has already been sent." é esperado quando o
      // envio já começou entre a leitura do store e esta chamada — não é bug
      // do cancelamento, é o Kit confirmando que não há mais o que cancelar.
      lot.last_error = (e as Error).message;
      persistLotUpdate(storePath, lot);
      console.log(JSON.stringify({ mode: "cancel-lot", lot_id: lot.lot_id, broadcast_id: lot.broadcast_id, ok: false, error: (e as Error).message }, null, 2));
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
    const results: { lot_id: string; before: string; after: string; error?: string }[] = [];
    for (const lot of Object.values(store.kit_transport.lots)) {
      if (lot.status === "completed" || lot.status === "cancelled") continue;
      const before = lot.status;
      try {
        const reconciled = await reconcileLotWithKit(lot, (id) => getBroadcast(id, kitCfg));
        persistLotUpdate(storePath, reconciled);
        results.push({ lot_id: lot.lot_id, before, after: reconciled.status });
      } catch (e) {
        lot.last_error = (e as Error).message;
        persistLotUpdate(storePath, lot);
        results.push({ lot_id: lot.lot_id, before, after: lot.status, error: (e as Error).message });
      }
    }
    console.log(JSON.stringify({ mode: "reconcile", results }, null, 2));
    return;
  }

  // --- Plano normal: candidatos devidos → lotes por kind ---
  const email2Days = onboardingCfg.email2_days ?? 3;
  const email3Days = onboardingCfg.email3_days ?? 10;
  const graceDays = onboardingCfg.email3_grace_days ?? 10;
  const nowSec = Math.floor(Date.now() / 1000);

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
  for (const e of candidates) {
    const fresh = await fetchSubscriptionByIdKit(kitCfg, e.kit_subscriber_id != null ? String(e.kit_subscriber_id) : e.subscription_id, e.email);
    if (fresh) {
      e.status_detectado = fresh.status ?? e.status_detectado;
      statsById[e.subscription_id] = fresh.stats ?? null;
      if (typeof fresh.resolvedKitId === "number") e.kit_subscriber_id = fresh.resolvedKitId;
    } else {
      refreshFailedThisRun.add(e.subscription_id);
      process.stderr.write(`[onboarding-kit-transport] refresh falhou pra ${e.subscription_id} — status NÃO CONFIRMADO nesta rodada, excluído da seleção (fail-safe)\n`);
    }
  }

  const snippetsDirAbs = resolve(ROOT, args.snippetsDir ?? onboardingCfg.snippets_dir ?? "data/snippets");
  const plan = buildRunPlan({
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
  });

  const dateIso = unixSecondsToBrtDate(nowSec);
  const summary: Record<string, unknown> = { mode: args.send ? "SEND" : "dry-run", now: new Date(nowSec * 1000).toISOString(), lots: [] as unknown[] };
  // #7922 (gap #3, audit pós-merge da fatia 1/N): `plan.skips` (candidatos
  // barrados por elegibilidade/guard de conteúdo — snippet ausente/pendente,
  // idade mínima, sem abertura, etc.) nunca aparecia no output deste
  // executor, diferente do irmão `onboarding-welcome-run.ts`
  // (`summary.skips = plan.skips.map(...)`, adicionado depois do #7670: um
  // skip silencioso fez o e-mail 3 nunca disparar pra ninguém, por meses,
  // com o script saindo exit 0 o tempo todo). Mesma forma/convenção do
  // irmão — nunca inclui `entry` bruta (PII) no resumo impresso.
  summary.skips = plan.skips.map((s) => ({ etapa: s.etapa, motivo: s.motivo, detalhe: s.detalhe }));

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
      (summary.lots as unknown[]).push({ kind, eligible: 0, excluded: excluded.length, note: "nenhum destinatário elegível — nada a fazer" });
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
      (summary.lots as unknown[]).push({
        kind,
        lot_id: existingLot?.lot_id ?? lotPlan.lot_id,
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
      lot.status = broadcast.status === "scheduled" ? "scheduled" : "created";
      lot.send_at = broadcast.send_at;
      persistLotUpdate(storePath, lot);
      (summary.lots as unknown[]).push({ kind, lot_id: lot.lot_id, created: true, broadcast_id: broadcast.id, recipients: lot.recipient_emails.length });
    } catch (e) {
      lot.last_error = (e as Error).message;
      persistLotUpdate(storePath, lot);
      (summary.lots as unknown[]).push({ kind, lot_id: lot.lot_id, created: false, error: (e as Error).message });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[onboarding-kit-transport] fatal: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
