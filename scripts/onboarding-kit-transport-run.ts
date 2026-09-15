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
      const { store: freshStore } = readStore(storePath);
      freshStore.kit_transport ??= { lots: {} };
      const existingLot = freshStore.kit_transport.lots[lotPlan.lot_id] ?? null;
      const decision = decideLotReconciliation(existingLot, nowMs);
      if (decision.action === "blocked_concurrent") return { decision, lot: null };
      if (decision.action === "reuse") return { decision, lot: decision.lot };
      // action === "create" | "recreate_after_timeout" — seguro criar.
      const pending: OnboardingKitLot = {
        lot_id: lotPlan.lot_id,
        kind: lotPlan.kind,
        tag_name: lotPlan.tag_name,
        tag_id: null,
        broadcast_id: null,
        recipient_subscription_ids: lotPlan.recipient_subscription_ids,
        recipient_emails: lotPlan.recipient_emails,
        status: "pending",
        created_at: new Date(nowMs).toISOString(),
        send_at: null,
        last_reconciled_at: null,
        last_error: null,
      };
      freshStore.kit_transport.lots[lotPlan.lot_id] = pending;
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
      const { store: freshStore } = readStore(storePath);
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
  const { store } = readStore(storePath);
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
    // Guard estrutural — lança se `lot.kind !== "email3"` OR aprovação ausente;
    // aqui a aprovação É este próprio comando (só existe por invocação explícita).
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
    const results: { lot_id: string; before: string; after: string; error?: string }[] = [];
    for (const lot of Object.values(store.kit_transport.lots)) {
      if (lot.status === "completed" || lot.status === "cancelled") continue;
      const before = lot.status;
      try {
        const reconciled = await reconcileLotWithKit(lot, (id) => getBroadcast(id, kitCfg));
        store.kit_transport.lots[lot.lot_id] = reconciled;
        results.push({ lot_id: lot.lot_id, before, after: reconciled.status });
      } catch (e) {
        lot.last_error = (e as Error).message;
        results.push({ lot_id: lot.lot_id, before, after: lot.status, error: (e as Error).message });
      }
    }
    writeStore(store, storePath);
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
  for (const e of candidates) {
    const fresh = await fetchSubscriptionByIdKit(kitCfg, e.kit_subscriber_id != null ? String(e.kit_subscriber_id) : e.subscription_id, e.email);
    if (fresh) {
      e.status_detectado = fresh.status ?? e.status_detectado;
      statsById[e.subscription_id] = fresh.stats ?? null;
      if (typeof fresh.resolvedKitId === "number") e.kit_subscriber_id = fresh.resolvedKitId;
    } else {
      process.stderr.write(`[onboarding-kit-transport] refresh falhou pra ${e.subscription_id} — usando estado do store\n`);
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

  for (const kind of ["email1", "email2", "email3"] as OnboardingKitLotKind[]) {
    const actionsOfKind: RunAction[] =
      kind === "email3" ? plan.actions.filter((a) => a.kind === "email3_campaign") : plan.actions.filter((a) => a.kind === kind);
    if (actionsOfKind.length === 0) continue;

    const entries = kind === "email3" ? (actionsOfKind[0] as Extract<RunAction, { kind: "email3_campaign" }>).entries : actionsOfKind.map((a) => (a as Extract<RunAction, { kind: "email1" | "email2" }>).entry);

    const rawCandidates: OnboardingKitCandidate[] = entries.map((e) => ({
      subscription_id: e.subscription_id,
      email: e.email,
      kit_subscriber_id: e.kit_subscriber_id ?? null,
      kit_state: e.status_detectado ?? null,
      seeded_by: e.seeded_by ?? null,
    }));
    const { eligible, excluded } = selectEligibleKitRecipients(rawCandidates);
    if (eligible.length === 0) {
      (summary.lots as unknown[]).push({ kind, eligible: 0, excluded: excluded.length, note: "nenhum destinatário elegível — nada a fazer" });
      continue;
    }

    const lotPlan = planLot({ kind, dateIso, seq: 1, eligible });

    if (!args.send) {
      const existingLot = store.kit_transport.lots[lotPlan.lot_id] ?? null;
      const decision = decideLotReconciliation(existingLot, Date.now());
      (summary.lots as unknown[]).push({
        kind,
        lot_id: lotPlan.lot_id,
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

    if (claim.decision.action === "blocked_concurrent") {
      (summary.lots as unknown[]).push({ kind, lot_id: lotPlan.lot_id, skipped: "blocked_concurrent — outra rodada pode estar processando este lote" });
      continue;
    }
    if (claim.decision.action === "reuse") {
      (summary.lots as unknown[]).push({ kind, lot_id: lotPlan.lot_id, skipped: "reuse — broadcast já existe", broadcast_id: claim.lot?.broadcast_id ?? null });
      continue;
    }

    const lot = claim.lot as OnboardingKitLot; // "create"/"recreate_after_timeout" sempre devolve um lote pending
    store.kit_transport.lots[lot.lot_id] = lot; // mantém a cópia em memória coerente pro restante deste processo

    try {
      const tagId = await resolveOrCreateLotTagId(lotPlan.tag_name, kitCfg);
      lot.tag_id = tagId;
      for (const subId of lotPlan.recipient_subscription_ids) {
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
      (summary.lots as unknown[]).push({ kind, lot_id: lot.lot_id, created: true, broadcast_id: broadcast.id, recipients: lotPlan.recipient_emails.length });
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
