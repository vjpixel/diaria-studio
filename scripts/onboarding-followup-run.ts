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
  parseFollowupSnippet,
  planFollowup,
  recordApoiaSkips,
  recordApoioChecks,
  recordFollowupRun,
  renderFollowupBody,
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

/** Aplica uma mutação nas pessoas sob lock (respostas do formulário, pulos `apoia`). */
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
  fetchFormResponses(): Promise<FormResponseRecord[]>;
  /** Cria/agenda o lote no Kit (muta `lot`; lança se não confirmar). */
  runLot(lot: FollowupLot, content: { subject: string; body: string; previewText?: string }): Promise<void>;
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
  });
  run.counts = plan.counts;
  const bump = (kind: FollowupStepKind, motivo: string, n = 1) => {
    const k = (run.counts[kind] ??= {});
    k[motivo] = (k[motivo] ?? 0) + n;
  };

  // Defesa em profundidade: já num lote confirmado desta etapa (registro perdido).
  const due = plan.due.filter((d) => {
    if (!idsInConfirmedFollowupLots(block.lots, d.kind).has(String(d.kit_subscriber_id))) return true;
    bump(d.kind, "ja_em_lote");
    return false;
  });

  // Checagem perto do envio: ativo + não apoia (leitura singular, nunca a listagem).
  const checks = new Map<number, LiveSubscriberCheck | null>();
  for (const d of due) {
    if (checks.has(d.kit_subscriber_id)) continue;
    try {
      checks.set(d.kit_subscriber_id, await deps.getSubscriber(d.kit_subscriber_id));
    } catch {
      checks.set(d.kit_subscriber_id, null);
      run.lookups_failed++;
    }
  }
  const { send: toSend, excluded } = filterDueByLiveCheck(due, checks);
  for (const x of excluded) bump(x.due.kind, x.motivo);
  if (send) {
    persistFollowupPeople(storePath, (people) => {
      recordApoiaSkips(people, excluded, nowIso);
      recordApoioChecks(people, toSend, nowIso);
    });
  }

  const cadastroById = new Map(apoioCandidates.map((c) => [c.kit_subscriber_id, c.cadastro_at] as const));
  const dateIso = unixSecondsToBrtDate(nowSec);
  for (const kind of ALL_FOLLOWUP_STEPS) {
    const recipients = toSend.filter((d) => d.kind === kind);
    if (recipients.length === 0) continue;
    if (recipients.length > cfg.maxRecipientsPerLot) {
      run.over_cap++;
      bump(kind, "acima_do_teto", recipients.length);
      lotsOut.push({ kind, eligible: recipients.length, skipped: `acima do teto (${cfg.maxRecipientsPerLot}) — nada enviado; conferir com o editor e subir onboarding.followup.max_recipients_per_lot` });
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
      process.exit(2);
    }
  }
  return a;
}

function buildRealDeps(kitCfg: KitConfig, cfg: FollowupConfig): FollowupRoundDeps {
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
    async fetchFormResponses() {
      const token = process.env[cfg.formResponsesTokenEnv];
      if (!cfg.formResponsesUrl || !token) throw new Error(`endpoint de respostas ou ${cfg.formResponsesTokenEnv} ausente`);
      const res = await fetch(cfg.formResponsesUrl, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`GET respostas do formulário: HTTP ${res.status}`);
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
    process.exit(2);
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
    process.exit(2);
  };

  const apoioGate = apoioContentGate(snippets);
  const formGate = formContentGate(snippets, cfg);
  // Travado pelos dois lados: nem precisa de credencial do Kit.
  let deps: FollowupRoundDeps;
  if (apoioGate.blocked && formGate.blocked) {
    deps = {
      listActiveSubscribers: () => Promise.reject(new Error("não chamado")),
      getSubscriber: () => Promise.reject(new Error("não chamado")),
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
  if (out.run.lots_failed > 0 || out.run.over_cap > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG} erro: ${redactEmails((e as Error).message)}\n`);
    process.exitCode = 1;
  });
}
