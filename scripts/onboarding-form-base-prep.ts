#!/usr/bin/env npx tsx
/**
 * onboarding-form-base-prep.ts (#10605, decisão 11 + regra B do editor)
 *
 * Prepara o e-mail ÚNICO da pesquisa nova para a base já cadastrada
 * (`data/snippets/pesquisa-base.md`, semente em
 * `context/templates/onboarding-followup/pesquisa-base.md`). Três passos,
 * todos DRY-RUN por padrão; só `--apply` escreve:
 *
 *  1. `--step sigs [--apply] [--max N]` — grava o custom field `form_sig`
 *     (assinatura do link, #10657) de quem vai receber o e-mail. Idempotente:
 *     quem já tem a assinatura certa (pela listagem do Kit) não gera escrita.
 *     Teto de `--max` escritas por rodada (padrão 500): rodar de novo até
 *     `pendentes: 0`. A listagem do Kit serve `fields` defasado por um tempo
 *     depois de um PATCH (#6425): uma rodada logo depois da anterior pode
 *     regravar o mesmo valor, o que é inofensivo.
 *  2. `--step draft [--apply]` — monta o broadcast como RASCUNHO no Kit: tag
 *     própria do lote, tagueia os destinatários, confere a audiência da tag,
 *     cria o broadcast com `send_at: null` e relê o filtro. NUNCA agenda nem
 *     envia: agendar é do editor, na UI do Kit, depois de aprovar texto e
 *     hora. Recusa enquanto o texto tiver `ONBOARDING-CORPO-PENDENTE`, sem o
 *     formulário configurado ou sem o segredo do link. Quem ainda não tem a
 *     assinatura certa fica fora (`sem_assinatura`: rodar o passo 1).
 *  3. `--step confirm [--apply]` — relê o broadcast; se o editor já agendou
 *     ou enviou, grava o envio `form_base` de cada destinatário no store
 *     (`followup.people[id].sends` + `form_invite`), o que libera o lembrete
 *     30 dias depois. O executor diário (`onboarding-followup-run.ts --send`)
 *     faz a mesma confirmação sozinho a cada rodada.
 *
 * Público (regra B, `selectBaseInviteAudience`): assinantes ativos do Kit,
 * menos quem já recebeu o convite D+6, quem vai recebê-lo em até
 * `base_invite_window_days` (7), quem já respondeu o formulário novo, quem já
 * recebeu este e-mail, quem tem `envio-brevo` e quem saiu do Kit numa etapa
 * do formulário.
 *
 * Uso:
 *   npx tsx scripts/onboarding-form-base-prep.ts --step sigs              # dry-run
 *   npx tsx scripts/onboarding-form-base-prep.ts --step sigs --apply --max 500
 *   npx tsx scripts/onboarding-form-base-prep.ts --step draft             # dry-run
 *   npx tsx scripts/onboarding-form-base-prep.ts --step draft --apply
 *   npx tsx scripts/onboarding-form-base-prep.ts --step confirm --apply
 * Flags auxiliares: --store <path>, --snippets-dir <path>, --config <path>, --env-root <path>.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { listAllKitSubscribers, getSubscriberById, updateSubscriberFields } from "./lib/kit-subscribers.ts";
import { findTagIdByName, listAllTagSubscriberEmails } from "./lib/kit-broadcasts.ts";
import { KIT_ENVIO_BREVO_TAG_NAME } from "./lib/kit-diaria-audience.ts";
import { resolveNewsletterSubscriberBackend } from "./lib/shared/newsletter-subscriber-source.ts";
import { unixSecondsToBrtDate } from "./lib/beehiiv-publish-date.ts";
import { readStore, writeStore, DEFAULT_STORE_PATH } from "./lib/onboarding-store.ts";
import { withFileLock } from "./lib/file-lock.ts";
import { buildOnboardingBroadcastInput } from "./lib/onboarding-kit-transport.ts";
import { assertPilotTagAudience, rereadPilotFilter, redactEmails, type PilotKitDeps } from "./lib/onboarding-kit-pilot.ts";
import { parseFormResponsesPayload } from "./lib/onboarding-form-contract.ts";
import { checkLinkSecret, FORM_SIG_KIT_FIELD, ONBOARDING_FORM_LINK_SECRET_ENV, signFormEmail } from "./lib/onboarding-form-link-sig.ts";
import {
  baseInviteContentGate,
  buildFollowupLotId,
  normalizeEmail,
  renderFollowupBody,
  resolveFollowupConfig,
  selectBaseInviteAudience,
  type BaseInviteExclusion,
  type FollowupBaseInvite,
  type FollowupBlock,
  type FollowupConfig,
  type FollowupConfigRaw,
  type FollowupDue,
  type FormResponseRecord,
  type LiveSubscriberCheck,
} from "./lib/onboarding-followup.ts";
import {
  confirmBaseInviteIfSent,
  fetchFormProbe,
  loadFollowupSnippets,
  probeFormLinkEndToEnd,
  provisionFormSigs,
  type FollowupRoundDeps,
  type FormSigWriteResult,
} from "./onboarding-followup-run.ts";
import { isKitTransientError } from "./onboarding-welcome-run.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { CliExit, runCli } from "./lib/cli-exit.ts";
import type { OnboardingStore } from "./lib/onboarding-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = "[onboarding-form-base]";

/** Padrão de `--max` do passo das assinaturas. */
export const BASE_SIGS_DEFAULT_MAX = 500;
/** Espaçamento entre as escritas de tag no Kit (mesmo das leituras singulares, #10616). */
export const BASE_TAG_SPACING_MS = 350;

export interface ActiveSubscriberRow {
  kit_subscriber_id: number;
  email: string;
  /** `form_sig` como a LISTAGEM mostra (pode estar defasado, #6425). */
  formSig: string | null;
}

export interface BasePrepDeps {
  listActiveSubscribers(): Promise<ActiveSubscriberRow[]>;
  listEnvioBrevoEmails(): Promise<string[]>;
  fetchFormResponses(): Promise<FormResponseRecord[]>;
  getSubscriber(kitId: number): Promise<LiveSubscriberCheck>;
  setFormSig?(kitId: number, sig: string): Promise<FormSigWriteResult>;
  probeFormLink?: FollowupRoundDeps["probeFormLink"];
  getBroadcast?: FollowupRoundDeps["getBroadcast"];
  /** Transporte do rascunho (tag, broadcast). Ausente = `--step draft --apply` recusa. */
  kit?: PilotKitDeps;
  sleep?(ms: number): Promise<void>;
  isTransientLookupError?(err: unknown): boolean;
}

export interface BasePrepOpts {
  storePath: string;
  cfg: FollowupConfig;
  snippetsDir: string;
  apply: boolean;
  formLinkSecret: string | null;
  nowMs?: number;
  maxWrites?: number;
  /** Repassado à conferência da tag (`assertPilotTagAudience`); testes usam 1/0. */
  tagCheckAttempts?: number;
  tagCheckDelayMs?: number;
}

function readStoreOrThrow(storePath: string): OnboardingStore {
  const { store, corrupted } = readStore(storePath);
  if (corrupted) throw new Error(`${LOG} store em "${storePath}" está CORROMPIDO — recusando.`);
  store.followup ??= { people: {}, lots: {} };
  return store;
}

function withStore<T>(storePath: string, fn: (block: FollowupBlock) => { result: T; write: boolean }): T {
  return withFileLock(
    `${storePath}.lock`,
    () => {
      const store = readStoreOrThrow(storePath);
      const { result, write } = fn(store.followup!);
      if (write) writeStore(store, storePath);
      return result;
    },
    30_000,
  );
}

export interface BaseAudienceResult {
  recipients: ActiveSubscriberRow[];
  excluded: Record<BaseInviteExclusion, number>;
  active: number;
}

/** Público da regra B a partir das leituras do Kit/Worker e do store. */
export async function buildBaseAudience(opts: BasePrepOpts, deps: BasePrepDeps): Promise<BaseAudienceResult> {
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const store = readStoreOrThrow(opts.storePath);
  const [subs, brevo, responses] = await Promise.all([deps.listActiveSubscribers(), deps.listEnvioBrevoEmails(), deps.fetchFormResponses()]);
  const byId = new Map(subs.map((s) => [s.kit_subscriber_id, s] as const));
  const audience = selectBaseInviteAudience({
    subscribers: subs,
    entries: Object.values(store.entries),
    people: store.followup!.people,
    lots: store.followup!.lots,
    responseEmails: new Set(responses.map((r) => normalizeEmail(r.email))),
    excludedEmails: new Set(brevo.map(normalizeEmail)),
    nowSec,
    cfg: opts.cfg,
  });
  return { recipients: audience.recipients.map((r) => byId.get(r.kit_subscriber_id)!), excluded: audience.excluded, active: subs.length };
}

/** Quem do público ainda não tem a assinatura certa no `form_sig` (pela listagem). */
export async function splitBySig(
  recipients: readonly ActiveSubscriberRow[],
  secret: string,
): Promise<{ ok: ActiveSubscriberRow[]; pending: ActiveSubscriberRow[] }> {
  const ok: ActiveSubscriberRow[] = [];
  const pending: ActiveSubscriberRow[] = [];
  for (const r of recipients) {
    if (r.formSig === (await signFormEmail(r.email, secret))) ok.push(r);
    else pending.push(r);
  }
  return { ok, pending };
}

function gateOrThrow(opts: BasePrepOpts): string {
  const snippets = loadFollowupSnippets(opts.snippetsDir);
  const gate = baseInviteContentGate(snippets.form_base, opts.cfg, opts.formLinkSecret);
  if (gate.blocked) throw new CliExitWithMessage(`e-mail da base travado (${gate.motivo}): ${gate.detalhe}`);
  return gate.linkSecret;
}

/** Erro de uso/bloqueio com mensagem para o operador (exit 1). */
export class CliExitWithMessage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliExitWithMessage";
  }
}

// ---------------------------------------------------------------------------
// Passo 1 — assinaturas
// ---------------------------------------------------------------------------

export interface BaseSigsResult {
  mode: "dry-run" | "apply";
  active: number;
  audience: number;
  excluded: Record<BaseInviteExclusion, number>;
  ja_assinados: number;
  pendentes: number;
  gravados: number;
  falhas: number;
  campo_ausente: string | null;
  restantes: number;
}

/**
 * Grava `form_sig` de até `maxWrites` pessoas do público que ainda não têm a
 * assinatura certa. Só a assinatura do link: nada de texto, nada de envio. O
 * gate do texto NÃO é exigido aqui (as assinaturas podem ir antes da
 * aprovação); o segredo do link e o `form_url`, sim.
 */
export async function runBaseSigs(opts: BasePrepOpts, deps: BasePrepDeps): Promise<BaseSigsResult> {
  // As assinaturas não dependem do texto: só do formulário configurado e do segredo.
  if (opts.cfg.formUrl == null || opts.cfg.formResponsesUrl == null) {
    throw new CliExitWithMessage("assinaturas travadas: onboarding.followup.form_url/form_responses_url ausentes");
  }
  const secretCheck = checkLinkSecret(opts.formLinkSecret);
  if (!secretCheck.ok) throw new CliExitWithMessage(`assinaturas travadas: ${secretCheck.detalhe} no ambiente`);
  const secret = secretCheck.secret;
  const aud = await buildBaseAudience(opts, deps);
  const { ok, pending } = await splitBySig(aud.recipients, secret);
  const max = opts.maxWrites ?? BASE_SIGS_DEFAULT_MAX;
  const batch = pending.slice(0, max);
  const out: BaseSigsResult = {
    mode: opts.apply ? "apply" : "dry-run",
    active: aud.active,
    audience: aud.recipients.length,
    excluded: aud.excluded,
    ja_assinados: ok.length,
    pendentes: pending.length,
    gravados: 0,
    falhas: 0,
    campo_ausente: null,
    restantes: pending.length,
  };
  if (!opts.apply || batch.length === 0) return out;
  const due: FollowupDue[] = batch.map((r) => ({ kit_subscriber_id: r.kit_subscriber_id, email: r.email, kind: "form_base" }));
  // A listagem não prova o valor atual: `formSig` nulo força a escrita (o PATCH reescreve o mesmo valor, inofensivo).
  const checks = new Map<number, LiveSubscriberCheck | null>(batch.map((r) => [r.kit_subscriber_id, { state: "active", apoioNivel: null, email: r.email, formSig: null }]));
  const prov = await provisionFormSigs(due, checks, secret, deps);
  out.gravados = prov.ok.length;
  out.falhas = prov.failed.length;
  out.campo_ausente = prov.fieldMissing;
  out.restantes = pending.length - prov.ok.length;
  return out;
}

// ---------------------------------------------------------------------------
// Passo 2 — rascunho
// ---------------------------------------------------------------------------

export interface BaseDraftResult {
  mode: "dry-run" | "apply";
  active: number;
  audience: number;
  recipients: number;
  excluded: Record<BaseInviteExclusion | "sem_assinatura", number>;
  subject: string;
  preview_text: string | null;
  lot_id: string | null;
  broadcast_id: number | null;
  status: FollowupBaseInvite["status"] | null;
  aviso?: string;
}

/**
 * Monta o broadcast do e-mail da base como RASCUNHO (`send_at: null`). Nunca
 * agenda, nunca envia (não há `updateBroadcast` neste caminho). Um convite já
 * em `draft`/`sent` no store recusa: um e-mail único não ganha segundo rascunho.
 */
export async function runBaseDraft(opts: BasePrepOpts, deps: BasePrepDeps): Promise<BaseDraftResult> {
  const secret = gateOrThrow(opts);
  const snip = loadFollowupSnippets(opts.snippetsDir).form_base!;
  const existing = readStoreOrThrow(opts.storePath).followup!.base_invite ?? null;
  if (existing && existing.status !== "pending") {
    throw new CliExitWithMessage(
      `já existe o e-mail da base no store (lote ${existing.lot_id}, status ${existing.status}, broadcast ${existing.broadcast_id ?? "-"}) — e-mail único, nada a montar.`,
    );
  }
  const aud = await buildBaseAudience(opts, deps);
  const { ok, pending } = await splitBySig(aud.recipients, secret);
  const out: BaseDraftResult = {
    mode: opts.apply ? "apply" : "dry-run",
    active: aud.active,
    audience: aud.recipients.length,
    recipients: ok.length,
    excluded: { ...aud.excluded, sem_assinatura: pending.length },
    subject: snip.assunto ?? "",
    preview_text: snip.previewText ?? null,
    lot_id: existing?.lot_id ?? null,
    broadcast_id: null,
    status: existing?.status ?? null,
  };
  if (pending.length > 0) out.aviso = `${pending.length} pessoa(s) sem form_sig certo ficam fora — rode --step sigs --apply antes.`;
  if (!opts.apply) return out;
  if (ok.length === 0) throw new CliExitWithMessage("nenhum destinatário com a assinatura certa — nada a montar.");
  if (!deps.kit) throw new CliExitWithMessage("transporte Kit não configurado — recusando montar o rascunho.");

  const probe = await probeFormLinkEndToEnd(opts.cfg.formUrl!, secret, deps);
  if (probe) throw new CliExitWithMessage(`formulário travado: ${probe.detalhe}`);

  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  // Reivindica (ou reaproveita o `pending` de uma tentativa que caiu no meio).
  const invite = withStore<FollowupBaseInvite>(opts.storePath, (block) => {
    const cur = block.base_invite;
    if (cur && cur.status !== "pending") throw new CliExitWithMessage(`e-mail da base já ${cur.status} (lote ${cur.lot_id}) — recusando.`);
    const lotId = cur?.lot_id ?? buildFollowupLotId("form_base", unixSecondsToBrtDate(Math.floor(nowMs / 1000)), 1);
    const next: FollowupBaseInvite = {
      lot_id: lotId,
      tag_name: cur?.tag_name ?? `onboarding-${lotId}`,
      tag_id: cur?.tag_id ?? null,
      broadcast_id: null,
      recipient_subscription_ids: ok.map((r) => String(r.kit_subscriber_id)),
      recipient_emails: ok.map((r) => r.email),
      status: "pending",
      created_at: cur?.created_at ?? nowIso,
      send_at: null,
      confirmed_at: null,
      last_error: null,
    };
    block.base_invite = next;
    return { result: next, write: true };
  });
  const persist = () =>
    withStore(opts.storePath, (block) => {
      block.base_invite = invite;
      return { result: undefined, write: true };
    });

  const kit = deps.kit;
  const sleep = deps.sleep ?? (() => Promise.resolve());
  try {
    if (invite.tag_id == null) {
      invite.tag_id = (await kit.findTagIdByName(invite.tag_name)) ?? (await kit.createTag(invite.tag_name)).id;
      persist();
    }
    const tagId = invite.tag_id;
    let first = true;
    for (const id of invite.recipient_subscription_ids) {
      if (!first) await sleep(BASE_TAG_SPACING_MS);
      first = false;
      await kit.tagSubscriber(tagId, Number(id));
    }
    await assertPilotTagAudience(kit, invite, invite.recipient_emails, opts.tagCheckAttempts, opts.tagCheckDelayMs);
    const created = await kit.createBroadcast(
      buildOnboardingBroadcastInput({
        kind: "form_base",
        subject: snip.assunto ?? "",
        content: renderFollowupBody(snip.body, opts.cfg.formUrl),
        previewText: snip.previewText ?? undefined,
        tagId,
        sendAt: null,
      }),
    );
    invite.broadcast_id = created.id;
    invite.status = "draft";
    persist();
    const { verification, reread } = await rereadPilotFilter(kit, created.id, tagId);
    if (verification.status === "divergent") {
      // Rascunho com audiência errada: apaga (nunca saiu, nada agendado).
      await kit.deleteBroadcast(created.id);
      invite.broadcast_id = null;
      invite.status = "pending";
      invite.last_error = `filtro do rascunho divergente, broadcast ${created.id} apagado: ${verification.reason}`;
      persist();
      throw new CliExitWithMessage(invite.last_error);
    }
    if (verification.status !== "verified") {
      invite.last_error = `audiência do rascunho ${created.id} não confirmada pela releitura (${verification.status}): conferir a tag ${invite.tag_name} no painel do Kit antes de agendar.`;
      out.aviso = invite.last_error;
    } else if (reread?.status != null && reread.status !== "draft") {
      invite.last_error = `o broadcast ${created.id} voltou "${reread.status}", não "draft" — conferir no painel do Kit AGORA.`;
      out.aviso = invite.last_error;
    }
    persist();
  } catch (e) {
    if (e instanceof CliExitWithMessage) throw e;
    invite.last_error = redactEmails((e as Error).message);
    persist();
    throw e;
  }
  out.lot_id = invite.lot_id;
  out.broadcast_id = invite.broadcast_id;
  out.status = invite.status;
  return out;
}

// ---------------------------------------------------------------------------
// Passo 3 — confirmação
// ---------------------------------------------------------------------------

export async function runBaseConfirm(opts: BasePrepOpts, deps: BasePrepDeps): Promise<unknown> {
  const store = readStoreOrThrow(opts.storePath);
  const invite = store.followup!.base_invite ?? null;
  if (!invite) return { mode: opts.apply ? "apply" : "dry-run", base_invite: null };
  if (!opts.apply) return { mode: "dry-run", base_invite: { lot_id: invite.lot_id, status: invite.status, broadcast_id: invite.broadcast_id, recipients: invite.recipient_subscription_ids.length } };
  const out = await confirmBaseInviteIfSent(opts.storePath, store.followup!, deps, opts.nowMs ?? Date.now());
  return { mode: "apply", result: out ?? { status: invite.status } };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function buildRealDeps(kitCfg: KitConfig, cfg: FollowupConfig): BasePrepDeps {
  return {
    async listActiveSubscribers() {
      const subs = await listAllKitSubscribers(kitCfg, { status: "active" });
      return subs.map((s) => {
        const sig = s.fields?.[FORM_SIG_KIT_FIELD];
        return { kit_subscriber_id: s.id, email: s.email_address, formSig: typeof sig === "string" && sig !== "" ? sig : null };
      });
    },
    async listEnvioBrevoEmails() {
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
    async getSubscriber(kitId) {
      const s = await getSubscriberById(kitId, kitCfg);
      const sig = s.fields?.[FORM_SIG_KIT_FIELD];
      return { state: s.state ?? null, apoioNivel: null, email: s.email_address ?? null, formSig: typeof sig === "string" ? sig : null };
    },
    async setFormSig(kitId, sig) {
      const s = await updateSubscriberFields(kitId, { [FORM_SIG_KIT_FIELD]: sig }, kitCfg);
      if (s.fields == null || typeof s.fields !== "object") return { kind: "unknown" };
      const stored = s.fields[FORM_SIG_KIT_FIELD];
      return typeof stored === "string" && stored !== "" ? { kind: "stored", value: stored } : { kind: "absent" };
    },
    probeFormLink: (url) => fetchFormProbe(url),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    isTransientLookupError: isKitTransientError,
  };
}

interface CliArgs {
  step: "sigs" | "draft" | "confirm" | null;
  apply: boolean;
  max?: number;
  storePath?: string;
  snippetsDir?: string;
  configPath?: string;
  envRoot?: string;
}

export function parseBasePrepArgs(argv: string[]): CliArgs {
  const a: CliArgs = { step: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--step") {
      const v = argv[++i];
      if (v !== "sigs" && v !== "draft" && v !== "confirm") throw new CliExitWithMessage(`--step inválido: ${v ?? "(vazio)"} (sigs | draft | confirm)`);
      a.step = v;
    } else if (f === "--apply") a.apply = true;
    else if (f === "--max") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new CliExitWithMessage("--max precisa ser inteiro positivo");
      a.max = n;
    } else if (f === "--store") a.storePath = argv[++i];
    else if (f === "--snippets-dir") a.snippetsDir = argv[++i];
    else if (f === "--config") a.configPath = argv[++i];
    else if (f === "--env-root") a.envRoot = argv[++i];
    else throw new CliExitWithMessage(`flag desconhecida: ${f}`);
  }
  if (a.step == null) throw new CliExitWithMessage("--step é obrigatório (sigs | draft | confirm)");
  return a;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseBasePrepArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${LOG} ${(e as Error).message}\n`);
    throw new CliExit(2);
  }
  loadProjectEnv(args.envRoot);
  const configPathAbs = args.configPath ?? resolve(ROOT, "platform.config.json");
  const rawCfg = JSON.parse(readFileSync(configPathAbs, "utf8")) as {
    onboarding?: { store_path?: string; snippets_dir?: string; followup?: FollowupConfigRaw };
  };
  const cfg = resolveFollowupConfig(rawCfg.onboarding?.followup);
  const backend = resolveNewsletterSubscriberBackend(configPathAbs);
  if (backend !== "kit") {
    process.stderr.write(`${LOG} backend de assinante "${backend}", não "kit" — recusando.\n`);
    throw new CliExit(2);
  }
  const kitResult = resolveKitConfig();
  if (!kitResult.ok) {
    process.stderr.write(`${LOG} config Kit: ${kitResult.reason}\n`);
    throw new CliExit(2);
  }
  const kitCfg = (kitResult as { ok: true; config: KitConfig }).config;
  const deps = buildRealDeps(kitCfg, cfg);
  if (args.step === "draft" && args.apply) {
    const { buildPilotKitDeps } = await import("./onboarding-kit-transport-run.ts");
    deps.kit = buildPilotKitDeps(kitCfg);
  }
  if (args.step === "confirm") {
    const { getBroadcast } = await import("./lib/kit-client.ts");
    deps.getBroadcast = (id) => getBroadcast(id, kitCfg);
  }
  const opts: BasePrepOpts = {
    storePath: args.storePath ?? resolve(ROOT, rawCfg.onboarding?.store_path ?? DEFAULT_STORE_PATH),
    cfg,
    snippetsDir: resolve(ROOT, args.snippetsDir ?? rawCfg.onboarding?.snippets_dir ?? "data/snippets"),
    apply: args.apply,
    formLinkSecret: process.env[ONBOARDING_FORM_LINK_SECRET_ENV] ?? null,
    maxWrites: args.max,
  };
  try {
    const out =
      args.step === "sigs" ? await runBaseSigs(opts, deps) : args.step === "draft" ? await runBaseDraft(opts, deps) : await runBaseConfirm(opts, deps);
    console.log(JSON.stringify({ step: args.step, ...(out as object) }, null, 2));
  } catch (e) {
    if (e instanceof CliExitWithMessage) {
      process.stderr.write(`${LOG} ${e.message}\n`);
      throw new CliExit(1);
    }
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  void runCli(main, {
    onError: (e) => process.stderr.write(`${LOG} erro: ${redactEmails((e as Error).message)}\n`),
  });
}
