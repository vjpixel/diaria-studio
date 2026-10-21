#!/usr/bin/env npx tsx
/**
 * onboarding-followup-run.ts (#10604, #10605)
 *
 * Executor diário das sequências DEPOIS da escada de boas-vindas:
 *  - pedido de apoio em D+30/90/180/360 do cadastro, só pra quem não apoia;
 *  - formulário de perfil/interesses em D+6 + lembrete a cada 30 dias até
 *    preencher (sem teto, decisão do editor de 20/10/2026).
 *
 * Regras (janela "nunca atrasada", idempotência, espaçamento, só ativo/não
 * apoia, teto de lote, gates de texto) vivem PURAS em
 * `scripts/lib/onboarding-followup.ts`. O transporte é o MESMO da escada no
 * Kit: lote por etapa/dia, tag própria do lote, broadcast criado como
 * rascunho, audiência relida, agendado por PATCH e relido de novo
 * (`runProductionKitLot` de `onboarding-kit-transport-run.ts`, reusado). O
 * estado vive em `data/onboarding/store.json` → `followup` (por pessoa e com
 * data — o painel `/assinantes` conta daqui, #10606).
 *
 * ## Envio travado até os textos serem aprovados
 *
 * Sem os 4 textos de apoio aprovados (`data/snippets/apoio-{30,90,180,360}.md`
 * sem o marcador `ONBOARDING-CORPO-PENDENTE`) a sequência de apoio não sai; sem
 * os 2 do formulário + o Worker publicado (`onboarding.followup.form_url`/
 * `form_responses_url`) a de formulário não sai. Com as duas travadas a rodada
 * NÃO chama a API do Kit (zero leitura da base) e só registra o bloqueio
 * (`followup.last_run`), que o painel mostra. `--init-snippets` cria os
 * arquivos que faltam já com o marcador (nunca sobrescreve).
 *
 * SEGURANÇA:
 *  - Default é DRY-RUN: sem `--send` nada é criado no Kit nem gravado no store.
 *  - Kill switch `onboarding.followup.enabled` (com `--skip-if-disabled` o
 *    passo agendado sai 0 quando desligado).
 *  - Backend de assinante precisa ser "kit".
 *
 * Uso:
 *   npx tsx scripts/onboarding-followup-run.ts                 # dry-run
 *   npx tsx scripts/onboarding-followup-run.ts --send          # cria/agenda os lotes devidos
 *   npx tsx scripts/onboarding-followup-run.ts --init-snippets # cria os textos faltantes com o marcador
 * Flags auxiliares: --store <path>, --snippets-dir <path>, --config <path>, --env-root <path>, --skip-if-disabled.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { listAllKitSubscribers, getSubscriberById } from "./lib/kit-subscribers.ts";
import { KIT_APOIO_NIVEL_FIELD_KEY } from "./lib/apoio-segments-canonical-kit.ts";
import { findTagIdByName, listAllTagSubscriberEmails, deleteBroadcast } from "./lib/kit-broadcasts.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import { KIT_ENVIO_BREVO_TAG_NAME } from "./lib/kit-diaria-audience.ts";
import { withFileLock } from "./lib/file-lock.ts";
import { resolveNewsletterSubscriberBackend } from "./lib/shared/newsletter-subscriber-source.ts";
import { unixSecondsToBrtDate } from "./lib/beehiiv-publish-date.ts";
import { readStore, writeStore, DEFAULT_STORE_PATH, type OnboardingStore } from "./lib/onboarding-store.ts";
import { decideLotReconciliation, LOT_STALE_AFTER_MS } from "./lib/onboarding-kit-transport.ts";
import { redactEmails } from "./lib/onboarding-kit-pilot.ts";
import { parseFormResponsesPayload } from "./lib/onboarding-form-contract.ts";
import {
  ALL_FOLLOWUP_STEPS,
  apoioContentGate,
  applyFollowupLotToPeople,
  applyFormResponses,
  buildFollowupLotId,
  filterDueByLiveCheck,
  findLatestFollowupLot,
  formCandidatesFromEntries,
  formContentGate,
  idsInConfirmedFollowupLots,
  idsInUnresolvedFollowupLots,
  isApoioStep,
  isoToSec,
  isUnresolvedFollowupLot,
  normalizeEmail,
  parseFollowupSnippet,
  planFollowup,
  recordLiveCheckSkips,
  recordApoioChecks,
  recordFollowupRun,
  renderFollowupBody,
  splitDueByCap,
  capWindowOverflows,
  resolveFollowupConfig,
  snippetFileFor,
  snippetTemplate,
  type ApoioCandidate,
  type FollowupBlock,
  type FollowupBlockReason,
  type FollowupConfig,
  type FollowupConfigRaw,
  type FollowupDue,
  type FollowupLot,
  type FollowupRunRecord,
  type FollowupSnippets,
  type FollowupStepKind,
  type FormResponseRecord,
  type LiveSubscriberCheck,
} from "./lib/onboarding-followup.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { CliExit, runCli } from "./lib/cli-exit.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = "[onboarding-followup]";

// ---------------------------------------------------------------------------
// Store sob lock (mesmo lock `${store}.lock` dos executores Brevo/Kit)
// ---------------------------------------------------------------------------

function readStoreOrThrow(storePath: string, what: string): OnboardingStore {
  const { store, corrupted } = readStore(storePath);
  if (corrupted) {
    throw new Error(`${LOG} store em "${storePath}" está CORROMPIDO — recusando ${what} sobre um snapshot esvaziado.`);
  }
  store.followup ??= { people: {}, lots: {} };
  return store;
}

function withStore<T>(storePath: string, what: string, fn: (store: OnboardingStore, block: FollowupBlock) => { result: T; write: boolean }): T {
  return withFileLock(
    `${storePath}.lock`,
    () => {
      const store = readStoreOrThrow(storePath, what);
      const { result, write } = fn(store, store.followup!);
      if (write) writeStore(store, storePath);
      return result;
    },
    30_000,
  );
}

export interface ClaimFollowupLotResult {
  action: "create" | "recreate_after_timeout" | "reuse" | "blocked_concurrent";
  lot: FollowupLot | null;
}

/**
 * Decide + persiste o lote `pending` da etapa/dia ATOMICAMENTE (lock + releitura
 * do disco), mesma disciplina de `claimLot` da escada: duas rodadas
 * concorrentes nunca criam dois broadcasts da mesma etapa no mesmo dia.
 */
export function claimFollowupLot(
  storePath: string,
  kind: FollowupStepKind,
  dateIso: string,
  recipients: readonly FollowupDue[],
  nowMs: number = Date.now(),
): ClaimFollowupLotResult {
  return withStore<ClaimFollowupLotResult>(storePath, "reivindicar lote", (_store, block) => {
    const latest = findLatestFollowupLot(block.lots, kind, dateIso);
    const decision = decideLotReconciliation<FollowupLot>(latest?.lot ?? null, nowMs, LOT_STALE_AFTER_MS);
    if (decision.action === "blocked_concurrent") return { result: { action: "blocked_concurrent", lot: decision.lot }, write: false };
    if (decision.action === "reuse") return { result: { action: "reuse", lot: decision.lot }, write: false };
    const seq = latest == null ? 1 : latest.seq + 1;
    const lotId = buildFollowupLotId(kind, dateIso, seq);
    const lot: FollowupLot = {
      lot_id: lotId,
      kind,
      tag_name: `onboarding-${lotId}`,
      tag_id: null,
      broadcast_id: null,
      recipient_subscription_ids: recipients.map((r) => String(r.kit_subscriber_id)),
      recipient_emails: recipients.map((r) => r.email),
      status: "pending",
      created_at: new Date(nowMs).toISOString(),
      send_at: null,
      last_reconciled_at: null,
      last_error: null,
    };
    block.lots[lotId] = lot;
    return { result: { action: decision.action, lot }, write: true };
  });
}

/** Persiste o lote e, se confirmado, os envios por pessoa — mesmo lock/snapshot. */
export function persistFollowupLot(storePath: string, lot: FollowupLot, cadastroById: ReadonlyMap<number, string | null>, nowMs = Date.now()): number {
  return withStore(storePath, "persistir lote", (_store, block) => {
    block.lots[lot.lot_id] = lot;
    const n = applyFollowupLotToPeople(block.people, lot, new Date(nowMs).toISOString(), cadastroById);
    return { result: n, write: true };
  });
}

/** Aplica uma mutação nas pessoas sob lock (respostas do formulário, pulos `apoia`/`nao_ativo`). */
export function persistFollowupPeople(storePath: string, mutate: (people: FollowupBlock["people"]) => void): void {
  withStore(storePath, "gravar pessoas", (_store, block) => {
    mutate(block.people);
    return { result: undefined, write: true };
  });
}

export function stampFollowupRun(storePath: string, run: FollowupRunRecord): void {
  withStore(storePath, "registrar a rodada", (_store, block) => {
    recordFollowupRun(block, run);
    return { result: undefined, write: true };
  });
}

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

export function loadFollowupSnippets(dirAbs: string): FollowupSnippets {
  const out: FollowupSnippets = {};
  for (const kind of ALL_FOLLOWUP_STEPS) {
    const p = resolve(dirAbs, snippetFileFor(kind));
    out[kind] = existsSync(p) ? parseFollowupSnippet(readFileSync(p, "utf8")) : null;
  }
  return out;
}

/** Cria os textos que faltam já com o marcador pendente. Nunca sobrescreve. */
export function initFollowupSnippets(dirAbs: string): string[] {
  mkdirSync(dirAbs, { recursive: true });
  const created: string[] = [];
  for (const kind of ALL_FOLLOWUP_STEPS) {
    const p = resolve(dirAbs, snippetFileFor(kind));
    if (existsSync(p)) continue;
    writeFileSync(p, snippetTemplate(kind), { flag: "wx" });
    created.push(p);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Rodada (deps injetáveis — testável sem rede)
// ---------------------------------------------------------------------------

export interface FollowupRoundDeps {
  listActiveSubscribers(): Promise<ApoioCandidate[]>;
  getSubscriber(kitId: number): Promise<LiveSubscriberCheck>;
  /** E-mails com a tag `envio-brevo` (#10437). Lança se a tag não existir ou a leitura falhar (a rodada trava). */
  listEnvioBrevoEmails(): Promise<string[]>;
  fetchFormResponses(): Promise<FormResponseRecord[]>;
  /** Cria/agenda o lote no Kit (muta `lot`; lança se não confirmar). */
  runLot(lot: FollowupLot, content: { subject: string; body: string; previewText?: string }): Promise<void>;
  /**
   * #10628: releitura (e limpeza) dos lotes não resolvidos no início do
   * `--send`, pela mesma regra da escada (`confirmOrCleanUpScheduledLot`).
   * Ausentes = o lote segue não resolvido: destinatários fora de `due` e a
   * rodada conta como falha (`lots_unresolved`).
   */
  getBroadcast?(id: number): Promise<{ status?: string | null; send_at?: string | null }>;
  deleteBroadcast?(id: number): Promise<void>;
  /**
   * #10633 (follow-up do #10628): id da conta Kit da credencial em uso
   * (`GET /account`). Gravado em `lot.kit_account_id` antes de criar o lote e
   * usado na releitura — 404 só cancela o lote quando a conta atual é a dona
   * (`verifyLotAccount`). Ausente = lote nasce sem id e 404 nunca cancela.
   */
  getAccountId?(): Promise<string>;
}

export interface FollowupLotReconcileRow {
  lot_id: string;
  kind: FollowupStepKind;
  before: FollowupLot["status"];
  after: FollowupLot["status"];
  reconciled: "scheduled" | "unscheduled" | "unverified" | "not_attempted";
  /** Pessoas que ganharam registro de envio com esta releitura. */
  marked: number;
  error?: string | null;
}

/**
 * #10628: relê os lotes `created` (releitura pós-PATCH falhou ou limpeza
 * falhou → `schedule_failed`) com `confirmOrCleanUpScheduledLot` — a MESMA
 * regra que `reconcileOpenLots` aplica aos lotes da escada no início do
 * `--send`. Agendado/enviado → grava os envios por pessoa
 * (`applyFollowupLotToPeople`); não agendado e apagado → `cancelled` (as
 * pessoas voltam ao plano); releitura/DELETE falhando de novo → segue não
 * resolvido (conta em `unresolved`; o caller tira os destinatários de `due`).
 *
 * Sem `persist` (dry-run) ou sem as deps de releitura, não chama o Kit: só
 * conta. Atualiza `block` EM MEMÓRIA (o plano que vem depois enxerga) e, com
 * `persist`, grava cada lote no disco sob lock (`persistFollowupLot`).
 *
 * Sem corrida com rodada concorrente: um lote só chega ao disco como
 * `created` DEPOIS de `runLot` terminar (antes disso ele é `pending`, sem
 * broadcast), então um `created` no disco é sempre resultado final de rodada.
 */
export async function reconcileFollowupLots(
  opts: { storePath: string; block: FollowupBlock; persist: boolean; nowMs: number },
  deps: Pick<FollowupRoundDeps, "getBroadcast" | "deleteBroadcast" | "getAccountId">,
): Promise<{ results: FollowupLotReconcileRow[]; unresolved: number }> {
  const { storePath, block, persist, nowMs } = opts;
  const nowIso = new Date(nowMs).toISOString();
  const results: FollowupLotReconcileRow[] = [];
  let unresolved = 0;
  const open = Object.values(block.lots).filter(isUnresolvedFollowupLot);
  if (open.length === 0) return { results, unresolved };
  const getB = deps.getBroadcast;
  const delB = deps.deleteBroadcast;
  if (!persist || !getB || !delB) {
    for (const lot of open) {
      unresolved++;
      results.push({ lot_id: lot.lot_id, kind: lot.kind, before: lot.status, after: lot.status, reconciled: "not_attempted", marked: 0, error: lot.last_error });
    }
    return { results, unresolved };
  }
  // Import tardio, como em `runLot`: o executor da escada carrega o transporte Kit inteiro.
  const { confirmOrCleanUpScheduledLot } = await import("./onboarding-kit-transport-run.ts");
  for (const lot of open) {
    const updated: FollowupLot = { ...lot };
    const outcome = await confirmOrCleanUpScheduledLot(updated, {
      getBroadcast: (id) => getB(id),
      deleteBroadcast: (id) => delB(id),
      // #10633: sem isto um 404 (broadcast apagado à mão na UI) nunca
      // cancelava o lote e o alarme tocava toda rodada.
      getAccountId: deps.getAccountId ? () => deps.getAccountId!() : undefined,
    });
    updated.last_reconciled_at = nowIso;
    block.lots[updated.lot_id] = updated;
    applyFollowupLotToPeople(block.people, updated, nowIso);
    const marked = persistFollowupLot(storePath, updated, new Map(), nowMs);
    const still = isUnresolvedFollowupLot(updated);
    if (still) unresolved++;
    results.push({ lot_id: updated.lot_id, kind: updated.kind, before: lot.status, after: updated.status, reconciled: outcome, marked, error: still ? updated.last_error : null });
  }
  return { results, unresolved };
}

export interface FollowupRoundOpts {
  storePath: string;
  send: boolean;
  cfg: FollowupConfig;
  snippets: FollowupSnippets;
  nowMs?: number;
}

function gateReason(g: ReturnType<typeof apoioContentGate>): { motivo: FollowupBlockReason; detalhe: string } | null {
  return g.blocked ? { motivo: g.motivo, detalhe: g.detalhe } : null;
}

/**
 * Uma rodada inteira. Devolve o registro da rodada (gravado no store só com
 * `send`). Lança só em erro inesperado (store corrompido etc.) — o caller
 * registra como `aborted`.
 */
export async function runFollowupRound(opts: FollowupRoundOpts, deps: FollowupRoundDeps): Promise<{ run: FollowupRunRecord; lots: unknown[] }> {
  const nowMs = opts.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const nowIso = new Date(nowMs).toISOString();
  const { cfg, snippets, storePath, send } = opts;
  let apoioBlocked = gateReason(apoioContentGate(snippets));
  let formBlocked = gateReason(formContentGate(snippets, cfg));
  const run: FollowupRunRecord = {
    at: nowIso,
    apoio_blocked: apoioBlocked,
    form_blocked: formBlocked,
    lots_created: 0,
    lots_failed: 0,
    over_cap: 0,
    lookups_failed: 0,
    counts: {},
  };
  const lotsOut: unknown[] = [];
  // Com as duas travadas: nenhuma chamada ao Kit — só o registro do bloqueio.
  if (apoioBlocked && formBlocked) return { run, lots: lotsOut };

  const store = readStoreOrThrow(storePath, "planejar");
  const block = store.followup!;

  // #10628: relê os lotes que ficaram sem confirmação numa rodada anterior
  // ANTES de planejar — senão a pessoa segue na janela, entra num lote novo e
  // recebe o mesmo e-mail duas vezes.
  const rec = await reconcileFollowupLots({ storePath, block, persist: send, nowMs }, deps);
  run.lots_unresolved = rec.unresolved;
  for (const r of rec.results) lotsOut.push({ reconcile: true, ...r });

  // Formulário: quem preencheu sai dos lembretes ANTES de planejar.
  if (!formBlocked) {
    try {
      const responses = await deps.fetchFormResponses();
      const apply = (people: FollowupBlock["people"]) => applyFormResponses(people, responses);
      apply(block.people);
      if (send) persistFollowupPeople(storePath, apply);
    } catch (e) {
      // Sem saber quem preencheu, lembrete poderia ir pra quem já respondeu: trava.
      formBlocked = { motivo: "respostas_indisponiveis", detalhe: redactEmails((e as Error).message) };
      run.form_blocked = formBlocked;
    }
  }

  // #10437: quem tem a tag `envio-brevo` foi movido pra Brevo — nada de pedido
  // de apoio/formulário pelo Kit (review #10623). Sem conseguir ler a tag,
  // trava os dois lados: enviar às cegas mandaria pra quem saiu do Kit.
  let envioBrevoEmails = new Set<string>();
  if (!apoioBlocked || !formBlocked) {
    try {
      envioBrevoEmails = new Set((await deps.listEnvioBrevoEmails()).map(normalizeEmail));
    } catch (e) {
      run.lookups_failed++;
      const detalhe = `tag envio-brevo ilegível: ${redactEmails((e as Error).message)}`;
      if (!apoioBlocked) run.apoio_blocked = apoioBlocked = { motivo: "kit_indisponivel", detalhe };
      if (!formBlocked) run.form_blocked = formBlocked = { motivo: "kit_indisponivel", detalhe };
    }
  }

  let apoioCandidates: ApoioCandidate[] = [];
  if (!apoioBlocked) {
    try {
      apoioCandidates = await deps.listActiveSubscribers();
    } catch (e) {
      run.lookups_failed++;
      apoioBlocked = { motivo: "kit_indisponivel", detalhe: `listagem do Kit falhou: ${redactEmails((e as Error).message)}` };
      run.apoio_blocked = apoioBlocked;
    }
  }
  const { candidates: formCandidates } = formBlocked ? { candidates: [] } : formCandidatesFromEntries(Object.values(store.entries));

  const plan = planFollowup({
    apoioCandidates,
    formCandidates,
    people: block.people,
    nowSec,
    cfg,
    apoioBlocked: apoioBlocked?.motivo ?? null,
    formBlocked: formBlocked?.motivo ?? null,
    excludedEmails: envioBrevoEmails,
  });
  run.counts = plan.counts;
  const bump = (kind: FollowupStepKind, motivo: string, n = 1) => {
    const k = (run.counts[kind] ??= {});
    k[motivo] = (k[motivo] ?? 0) + n;
  };

  // #10628: num lote ainda não resolvido (de qualquer etapa) o broadcast pode
  // ter saído — fica fora até a releitura resolver o lote.
  const unresolvedIds = idsInUnresolvedFollowupLots(block.lots);
  // Defesa em profundidade: já num lote confirmado desta etapa (registro perdido).
  const due = plan.due.filter((d) => {
    const id = String(d.kit_subscriber_id);
    if (unresolvedIds.has(id)) {
      bump(d.kind, "lote_nao_confirmado");
      return false;
    }
    if (!idsInConfirmedFollowupLots(block.lots, d.kind).has(id)) return true;
    bump(d.kind, "ja_em_lote");
    return false;
  });

  // Teto de lote ANTES das leituras singulares (review #10623), em lote PARCIAL
  // (#10631): saem até o teto, cadastro mais antigo primeiro (a janela dele
  // fecha antes); o excedente fica sem registro e volta a ser devido na rodada
  // seguinte, dentro da janela da etapa.
  const capOverflowMsg = `acima do teto (${cfg.maxRecipientsPerLot}) — nada enviado; conferir com o editor e subir onboarding.followup.max_recipients_per_lot`;
  const cadastroSecById = new Map(apoioCandidates.map((c) => [c.kit_subscriber_id, isoToSec(c.cadastro_at)] as const));
  const anchorSecById = new Map(formCandidates.map((c) => [c.kit_subscriber_id, c.anchorSec] as const));
  const orderSec = (d: { kit_subscriber_id: number; kind: FollowupStepKind }) =>
    (isApoioStep(d.kind) ? cadastroSecById.get(d.kit_subscriber_id) : anchorSecById.get(d.kit_subscriber_id)) ?? null;
  const { within: dueWithinCap, deferred: capDeferred } = splitDueByCap(due, cfg.maxRecipientsPerLot, orderSec);
  for (const o of capDeferred) {
    bump(o.kind, "adiado_teto", o.deferred);
    lotsOut.push({ kind: o.kind, eligible: o.eligible, deferred: o.deferred, cap: cfg.maxRecipientsPerLot });
  }
  // #10652: excedente que não cabe na janela vira `vencida` sem receber —
  // a decisão de lote parcial (#10631) fica, mas isso não pode passar calado.
  // #10660: capacidade por pessoa (dias que restam da janela de cada um), na
  // mesma ordem do corte acima. `due` é contado antes do filtro ao vivo
  // (`nao_ativo`/`apoia`, logo abaixo): a projeção é um teto superior.
  const windowOverflows = capWindowOverflows(due, cfg.maxRecipientsPerLot, nowSec, cfg, orderSec);
  run.cap_window_overflow = windowOverflows.length;
  for (const w of windowOverflows) {
    bump(w.kind, "excede_janela", w.projected_vencidas);
    lotsOut.push({ kind: w.kind, cap_window_overflow: true, eligible: w.eligible, capacity: w.capacity, projected_vencidas: w.projected_vencidas });
    process.stderr.write(
      `${LOG} ${w.kind}: ${w.eligible} elegíveis, só ${w.capacity} cabem nos dias que restam das janelas (${cfg.maxRecipientsPerLot}/lote/dia) — ${w.projected_vencidas} vão vencer sem receber; conferir com o editor (subir onboarding.followup.max_recipients_per_lot ou grace_days)\n`,
    );
  }

  // Checagem perto do envio: ativo + não apoia (leitura singular, nunca a listagem).
  const checks = new Map<number, LiveSubscriberCheck | null>();
  for (const d of dueWithinCap) {
    if (checks.has(d.kit_subscriber_id)) continue;
    try {
      checks.set(d.kit_subscriber_id, await deps.getSubscriber(d.kit_subscriber_id));
    } catch {
      checks.set(d.kit_subscriber_id, null);
      run.lookups_failed++;
    }
  }
  const { send: toSend, excluded } = filterDueByLiveCheck(dueWithinCap, checks);
  for (const x of excluded) bump(x.due.kind, x.motivo);
  if (send) {
    persistFollowupPeople(storePath, (people) => {
      recordLiveCheckSkips(people, excluded, nowIso);
      recordApoioChecks(people, toSend, nowIso);
    });
  }

  const cadastroById = new Map(apoioCandidates.map((c) => [c.kit_subscriber_id, c.cadastro_at] as const));
  const dateIso = unixSecondsToBrtDate(nowSec);
  for (const kind of ALL_FOLLOWUP_STEPS) {
    const recipients = toSend.filter((d) => d.kind === kind);
    if (recipients.length === 0) continue;
    // Redundante com o corte acima (a checagem só remove gente), mantido como
    // defesa em profundidade caso a ordem mude.
    if (recipients.length > cfg.maxRecipientsPerLot) {
      run.over_cap++;
      bump(kind, "acima_do_teto", recipients.length);
      lotsOut.push({ kind, eligible: recipients.length, skipped: capOverflowMsg });
      continue;
    }
    if (!send) {
      lotsOut.push({ kind, eligible: recipients.length, dry_run: true });
      continue;
    }
    const claim = claimFollowupLot(storePath, kind, dateIso, recipients, nowMs);
    if (claim.action === "blocked_concurrent" || claim.action === "reuse") {
      lotsOut.push({ kind, lot_id: claim.lot?.lot_id ?? null, skipped: claim.action });
      continue;
    }
    const lot = claim.lot!;
    const snip = snippets[kind]!;
    // #10633: grava a conta Kit dona ANTES de criar o broadcast (mesma regra
    // do `beforeCreate` da escada, #9487). Falha não trava o envio: o lote
    // nasce sem id e um 404 numa releitura futura só não cancela (lado seguro).
    if (deps.getAccountId) {
      try {
        lot.kit_account_id = await deps.getAccountId();
      } catch (e) {
        process.stderr.write(`${LOG} GET /account falhou ao criar o lote ${lot.lot_id} — lote sem id de conta (404 numa releitura futura não será tratado como deleção): ${redactEmails((e as Error).message)}\n`);
      }
    }
    try {
      await deps.runLot(lot, {
        subject: snip.assunto ?? "",
        body: renderFollowupBody(snip.body, cfg.formUrl),
        previewText: snip.previewText ?? undefined,
      });
      const marked = persistFollowupLot(storePath, lot, cadastroById, nowMs);
      run.lots_created++;
      bump(kind, "enviado", marked);
      lotsOut.push({ kind, lot_id: lot.lot_id, created: true, broadcast_id: lot.broadcast_id, recipients: recipients.length, send_at: lot.send_at });
    } catch (e) {
      run.lots_failed++;
      lot.last_error = lot.last_error ?? redactEmails((e as Error).message);
      persistFollowupLot(storePath, lot, cadastroById, nowMs);
      bump(kind, "falhou", recipients.length);
      lotsOut.push({ kind, lot_id: lot.lot_id, created: false, status: lot.status, error: lot.last_error });
    }
  }
  return { run, lots: lotsOut };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface CliArgs {
  send: boolean;
  initSnippets: boolean;
  skipIfDisabled: boolean;
  storePath?: string;
  snippetsDir?: string;
  configPath?: string;
  envRoot?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { send: false, initSnippets: false, skipIfDisabled: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--send") a.send = true;
    else if (f === "--init-snippets") a.initSnippets = true;
    else if (f === "--skip-if-disabled") a.skipIfDisabled = true;
    else if (f === "--store") a.storePath = argv[++i];
    else if (f === "--snippets-dir") a.snippetsDir = argv[++i];
    else if (f === "--config") a.configPath = argv[++i];
    else if (f === "--env-root") a.envRoot = argv[++i];
    else {
      process.stderr.write(`${LOG} flag desconhecida: ${f}\n`);
      throw new CliExit(2);
    }
  }
  return a;
}

function buildRealDeps(kitCfg: KitConfig, cfg: FollowupConfig): FollowupRoundDeps {
  // #10633: `GET /account` memoizado por rodada (só o sucesso; ver `memoizeAccountId`).
  let accountIdMemo: (() => Promise<string>) | null = null;
  return {
    async listActiveSubscribers() {
      const subs = await listAllKitSubscribers(kitCfg, { status: "active" });
      return subs.map((s) => ({ kit_subscriber_id: s.id, email: s.email_address, cadastro_at: s.created_at ?? null }));
    },
    async getSubscriber(kitId) {
      const s = await getSubscriberById(kitId, kitCfg);
      const nivel = s.fields?.[KIT_APOIO_NIVEL_FIELD_KEY];
      return { state: s.state ?? null, apoioNivel: typeof nivel === "string" ? nivel : "" };
    },
    async listEnvioBrevoEmails() {
      // Tag ausente lança (trava a rodada): um rename no painel do Kit não pode
      // virar "ninguém foi movido" e mandar pedido pra quem está na Brevo.
      const tagId = await findTagIdByName(KIT_ENVIO_BREVO_TAG_NAME, kitCfg);
      if (tagId == null) throw new Error(`tag ${KIT_ENVIO_BREVO_TAG_NAME} não existe no Kit`);
      return listAllTagSubscriberEmails(tagId, kitCfg);
    },
    async fetchFormResponses() {
      const token = process.env[cfg.formResponsesTokenEnv];
      if (!cfg.formResponsesUrl || !token) throw new Error(`endpoint de respostas ou ${cfg.formResponsesTokenEnv} ausente`);
      const res = await fetch(cfg.formResponsesUrl, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`GET respostas do formulário: HTTP ${res.status}`);
      }
      return parseFormResponsesPayload(await res.json());
    },
    async runLot(lot, content) {
      // Import tardio: o executor da escada carrega o resto do transporte Kit.
      const { runProductionKitLot, buildPilotKitDeps, productionOrphanAlert } = await import("./onboarding-kit-transport-run.ts");
      const kitIdBySubscription = Object.fromEntries(lot.recipient_subscription_ids.map((id) => [id, Number(id)]));
      await runProductionKitLot(buildPilotKitDeps(kitCfg), lot, {
        alert: productionOrphanAlert(),
        kitIdBySubscription,
        subject: content.subject,
        content: content.body,
        previewText: content.previewText,
        sendAtFn: () => new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    },
    getBroadcast: (id) => getBroadcast(id, kitCfg),
    deleteBroadcast: (id) => deleteBroadcast(id, kitCfg),
    async getAccountId() {
      if (!accountIdMemo) {
        const { memoizeAccountId, fetchKitAccountId } = await import("./onboarding-kit-transport-run.ts");
        accountIdMemo = memoizeAccountId(() => fetchKitAccountId(kitCfg));
      }
      return accountIdMemo();
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadProjectEnv(args.envRoot);
  const configPathAbs = args.configPath ?? resolve(ROOT, "platform.config.json");
  const rawCfg = JSON.parse(readFileSync(configPathAbs, "utf8")) as {
    onboarding?: { store_path?: string; snippets_dir?: string; followup?: FollowupConfigRaw };
  };
  const cfg = resolveFollowupConfig(rawCfg.onboarding?.followup);
  const snippetsDirAbs = resolve(ROOT, args.snippetsDir ?? rawCfg.onboarding?.snippets_dir ?? "data/snippets");

  if (args.initSnippets) {
    const created = initFollowupSnippets(snippetsDirAbs);
    console.log(JSON.stringify({ mode: "init-snippets", created }));
    return;
  }
  if (!cfg.enabled) {
    const msg = "onboarding.followup.enabled não é true — sequências de apoio/formulário desligadas";
    if (args.skipIfDisabled || !args.send) {
      console.log(JSON.stringify({ mode: "skip", reason: msg }));
      return;
    }
    process.stderr.write(`${LOG} ${msg}; recusando --send.\n`);
    throw new CliExit(2);
  }
  const storePath = args.storePath ?? resolve(ROOT, rawCfg.onboarding?.store_path ?? DEFAULT_STORE_PATH);
  const snippets = loadFollowupSnippets(snippetsDirAbs);

  const record = (run: FollowupRunRecord) => {
    if (!args.send) return;
    try {
      stampFollowupRun(storePath, run);
    } catch (e) {
      process.stderr.write(`${LOG} falha ao registrar a rodada: ${(e as Error).message}\n`);
      process.exitCode = 1;
    }
  };
  const abortRun = (reason: string): never => {
    record({ at: new Date().toISOString(), apoio_blocked: null, form_blocked: null, lots_created: 0, lots_failed: 0, over_cap: 0, lookups_failed: 0, counts: {}, aborted: true, error: reason });
    process.stderr.write(`${LOG} ${reason}\n`);
    // #9911: CliExit em vez de process.exit — o script usa fetch, e no
    // Windows process.exit depois de fetch sai 127. Chamado fora do try/catch
    // de runFollowupRound, então nada engole a exceção até o runCli.
    throw new CliExit(2);
  };

  const apoioGate = apoioContentGate(snippets);
  const formGate = formContentGate(snippets, cfg);
  // Travado pelos dois lados: nem precisa de credencial do Kit.
  let deps: FollowupRoundDeps;
  if (apoioGate.blocked && formGate.blocked) {
    deps = {
      listActiveSubscribers: () => Promise.reject(new Error("não chamado")),
      getSubscriber: () => Promise.reject(new Error("não chamado")),
      listEnvioBrevoEmails: () => Promise.reject(new Error("não chamado")),
      fetchFormResponses: () => Promise.reject(new Error("não chamado")),
      runLot: () => Promise.reject(new Error("não chamado")),
    };
  } else {
    const backend = resolveNewsletterSubscriberBackend(configPathAbs);
    if (backend !== "kit") abortRun(`backend de assinante "${backend}", não "kit"`);
    const kitResult = resolveKitConfig();
    if (!kitResult.ok) abortRun(`config Kit: ${kitResult.reason}`);
    deps = buildRealDeps((kitResult as { ok: true; config: KitConfig }).config, cfg);
  }

  let out: { run: FollowupRunRecord; lots: unknown[] };
  try {
    out = await runFollowupRound({ storePath, send: args.send, cfg, snippets }, deps);
  } catch (e) {
    const msg = redactEmails((e as Error).message);
    record({ at: new Date().toISOString(), apoio_blocked: null, form_blocked: null, lots_created: 0, lots_failed: 0, over_cap: 0, lookups_failed: 0, counts: {}, aborted: true, error: msg });
    throw e;
  }
  record(out.run);
  console.log(JSON.stringify({ mode: args.send ? "SEND" : "dry-run", ...out.run, lots: out.lots }, null, 2));
  if (out.run.lots_failed > 0 || out.run.over_cap > 0 || (out.run.lots_unresolved ?? 0) > 0 || (out.run.cap_window_overflow ?? 0) > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  void runCli(main, {
    onError: (e) => process.stderr.write(`${LOG} erro: ${redactEmails((e as Error).message)}\n`),
  });
}
