#!/usr/bin/env npx tsx
/**
 * onboarding-form-base-prep.ts (#10605, decisão 11 + regra B do editor)
 *
 * Prepara o e-mail ÚNICO da pesquisa nova para a base já cadastrada
 * (`data/snippets/pesquisa-base.md`, semente em
 * `context/templates/onboarding-followup/pesquisa-base.md`). Quatro passos,
 * todos DRY-RUN por padrão; só `--apply` escreve. Store ausente, corrompido
 * ou sem nenhuma entrada/pessoa: todos recusam (o script nunca cria store).
 *
 *  1. `--step sigs [--apply] [--max N]` — grava o custom field `form_sig`
 *     (assinatura do link, #10657) de quem vai receber o e-mail. Idempotente:
 *     quem já tem a assinatura certa (pela listagem do Kit) não gera escrita.
 *     Teto de `--max` escritas por rodada (padrão 500): REPETIR até
 *     `restantes: 0`. A listagem do Kit serve `fields` defasado por um tempo
 *     depois de um PATCH (#6425): uma rodada logo depois da anterior pode
 *     regravar o mesmo valor, o que é inofensivo. Falha de gravação ou campo
 *     ausente no Kit: exit 1, com o detalhe por motivo no JSON.
 *  2. `--step draft [--apply]` — monta o broadcast como RASCUNHO no Kit: tag
 *     própria do lote, tagueia os destinatários, confere a audiência da tag,
 *     cria o broadcast com `send_at: null` e relê o filtro. NUNCA agenda nem
 *     envia: agendar é do editor, na UI do Kit, depois de aprovar texto e
 *     hora. Recusa enquanto o texto tiver `ONBOARDING-CORPO-PENDENTE`, sem o
 *     formulário configurado ou sem o segredo do link. Com `--apply`, quem a
 *     listagem mostra sem a assinatura certa é conferido pelo GET singular;
 *     se faltar a de alguém, recusa (exit 1) com os ids: voltar ao passo 1.
 *     Filtro do rascunho não confirmado na releitura: grava `divergent`,
 *     apaga o rascunho e volta a `pending` (exit 1); se a exclusão falhar,
 *     fica `divergent` até `--step reset`.
 *  3. `--step confirm [--apply]` — sem `--apply` só mostra o que está no
 *     store. Com `--apply`, relê o broadcast: agendado vira `scheduled` (sem
 *     registro por pessoa, relido de novo depois); saindo/saído
 *     (`sending`/`completed`) com o filtro igual ao da tag grava o envio
 *     `form_base` de cada destinatário (`followup.people[id].sends` +
 *     `form_invite`), o que libera o lembrete 30 dias depois. Quem grava isso
 *     é este passo OU o executor diário (`onboarding-followup-run.ts --send`),
 *     o que rodar primeiro depois do envio (o executor só relê quando os
 *     textos de apoio ou do formulário estão liberados). Releitura falhando,
 *     `aborted`, filtro divergente/não ecoado ou `divergent`: exit 1.
 *  4. `--step reset [--apply] [--force]` — volta o convite a `pending` para
 *     montar de novo, só com o broadcast apagado (404) ou `aborted` no Kit.
 *     `--force` cobre releitura falhando ou nenhum broadcast gravado depois
 *     de um `createBroadcast` sem resposta, e só DEPOIS de conferir no
 *     painel do Kit que não há broadcast com a tag do lote. Nunca reseta
 *     `sent` nem broadcast `draft`/`scheduled`/`sending`/`completed`.
 *
 * Público (regra B, `selectBaseInviteAudience`): assinantes ativos do Kit,
 * menos quem já recebeu o convite D+6, quem vai recebê-lo em até 7 dias
 * (padrão de `base_invite_window_days`), quem já respondeu o formulário
 * novo, quem já recebeu este e-mail, quem tem `envio-brevo` e quem saiu do
 * Kit numa etapa do formulário. Enquanto o convite pode sair
 * (`draft`/`scheduled`/`divergent`), o executor diário não manda o D+6 para
 * os destinatários dele. Quem responde o formulário entre o rascunho e o
 * envio continua no público congelado da tag (aceito).
 *
 * Uso:
 *   npx tsx scripts/onboarding-form-base-prep.ts --step sigs              # dry-run
 *   npx tsx scripts/onboarding-form-base-prep.ts --step sigs --apply --max 500   # repetir até restantes: 0
 *   npx tsx scripts/onboarding-form-base-prep.ts --step draft             # dry-run
 *   npx tsx scripts/onboarding-form-base-prep.ts --step draft --apply
 *   npx tsx scripts/onboarding-form-base-prep.ts --step confirm --apply
 *   npx tsx scripts/onboarding-form-base-prep.ts --step reset --apply [--force]
 * Flags auxiliares: --store <path>, --snippets-dir <path>, --config <path>, --env-root <path>.
 */

import { existsSync, readFileSync } from "node:fs";
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
  baseInviteMayExist,
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
/** Espaçamento entre as escritas de tag no Kit: ~110 escritas/min, abaixo do
 *  limite de 120 req/min da API v4 com folga para as outras leituras. */
export const BASE_TAG_SPACING_MS = 550;
/** Espaçamento das leituras singulares (mesmo do #10616). */
export const BASE_LOOKUP_SPACING_MS = 350;
/** Quantos ids listar na recusa por assinatura faltando. */
export const BASE_MISSING_SIG_LIST_MAX = 50;

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
  /** O erro da releitura é 404 (broadcast apagado no Kit). Usado só pelo `--step reset`. */
  isNotFoundError?(err: unknown): boolean;
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

/**
 * Store ausente, corrompido ou sem nenhuma entrada/pessoa: recusa. O
 * `readStore` devolve um store VAZIO para arquivo ausente (1ª execução dos
 * executores da escada); aqui isso significaria montar o público sem as
 * exclusões da escada (D+6 já recebido, cadastro recente) e, com `--apply`,
 * criar um store novo do zero. Junction `data/` fora do ar ou `--store`
 * errado caem nisto, nunca num e-mail para a base inteira.
 */
function readStoreOrThrow(storePath: string): OnboardingStore {
  if (!existsSync(storePath)) {
    throw new CliExitWithMessage(`store em "${storePath}" não existe — recusando (sem ele o público perde as exclusões da escada; este script nunca cria store).`);
  }
  const { store, corrupted } = readStore(storePath);
  if (corrupted) throw new CliExitWithMessage(`store em "${storePath}" está CORROMPIDO — recusando.`);
  store.followup ??= { people: {}, lots: {} };
  if (Object.keys(store.entries).length === 0 && Object.keys(store.followup.people).length === 0) {
    throw new CliExitWithMessage(`store em "${storePath}" sem nenhuma entrada da escada nem pessoa do followup — recusando (store errado ou recém-criado).`);
  }
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
  /** Falhas por motivo (`assinatura_falhou`, `assinatura_divergente_pos_escrita`, `campo_assinatura_ausente`). */
  falhas_por_motivo: Record<string, number>;
  /** Até 10 erros distintos (id + motivo + mensagem, sem e-mail). */
  erros: string[];
  campo_ausente: string | null;
  restantes: number;
}

/** Exit do passo: `sigs` com falha ou campo ausente e `confirm` com falha saem 1. */
export function basePrepExitCode(step: "sigs" | "draft" | "confirm" | "reset", out: unknown): 0 | 1 {
  if (step === "sigs") {
    const r = out as Pick<BaseSigsResult, "falhas" | "campo_ausente">;
    return r.falhas > 0 || r.campo_ausente != null ? 1 : 0;
  }
  if (step === "confirm") return (out as { result?: { failed?: boolean } }).result?.failed === true ? 1 : 0;
  return 0;
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
    falhas_por_motivo: {},
    erros: [],
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
  const erros = new Set<string>();
  for (const f of prov.failed) {
    out.falhas_por_motivo[f.motivo] = (out.falhas_por_motivo[f.motivo] ?? 0) + 1;
    if (erros.size < 10) erros.add(`${f.due.kit_subscriber_id}: ${f.motivo}: ${redactEmails(f.error)}`);
  }
  out.erros = [...erros];
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
  /** Com `--apply`: quantos sem assinatura pela LISTAGEM o GET singular mostrou já assinados. */
  confirmados_por_get?: number;
  aviso?: string;
}

/**
 * #10605 (item 5 do review): a listagem do Kit serve `fields` defasado depois
 * de um PATCH (#6425). Antes de montar o rascunho, quem a listagem mostra sem
 * a assinatura certa é conferido pelo GET singular (autoritativo). Devolve os
 * que o GET mostrou assinados e os que continuam sem (leitura falha conta
 * como sem: na dúvida, ninguém recebe link que o Worker recusaria).
 */
export async function recheckPendingSigs(
  pending: readonly ActiveSubscriberRow[],
  secret: string,
  deps: Pick<BasePrepDeps, "getSubscriber" | "sleep">,
): Promise<{ signed: ActiveSubscriberRow[]; missing: { kit_subscriber_id: number; motivo: string }[] }> {
  const sleep = deps.sleep ?? (() => Promise.resolve());
  const signed: ActiveSubscriberRow[] = [];
  const missing: { kit_subscriber_id: number; motivo: string }[] = [];
  let first = true;
  for (const r of pending) {
    if (!first) await sleep(BASE_LOOKUP_SPACING_MS);
    first = false;
    try {
      const live = await deps.getSubscriber(r.kit_subscriber_id);
      // O link usa o e-mail que a merge tag põe (o atual do Kit); a assinatura cobre esse.
      const email = live.email || r.email;
      if (normalizeEmail(email) !== normalizeEmail(r.email)) {
        // E-mail mudou depois da listagem: a tag do lote é conferida pelo e-mail listado.
        missing.push({ kit_subscriber_id: r.kit_subscriber_id, motivo: "email_mudou" });
      } else if (live.formSig != null && live.formSig === (await signFormEmail(email, secret))) {
        signed.push({ ...r, formSig: live.formSig });
      } else {
        missing.push({ kit_subscriber_id: r.kit_subscriber_id, motivo: live.formSig ? "assinatura_diferente" : "sem_assinatura" });
      }
    } catch (e) {
      missing.push({ kit_subscriber_id: r.kit_subscriber_id, motivo: `leitura_falhou: ${redactEmails((e as Error).message)}` });
    }
  }
  return { signed, missing };
}

/**
 * Monta o broadcast do e-mail da base como RASCUNHO (`send_at: null`). Nunca
 * agenda, nunca envia (não há `updateBroadcast` neste caminho). Um convite já
 * em `draft`/`scheduled`/`divergent`/`sent` no store recusa: um e-mail único
 * não ganha segundo rascunho. Audiência do rascunho não confirmada pela
 * releitura (divergente, não ecoada, releitura falhou): grava `divergent`,
 * apaga o rascunho, volta a `pending` e sai com erro — se a exclusão falhar,
 * fica `divergent` (nada marca `sent` até `--step reset`).
 *
 * Quem responder o formulário entre o rascunho e o envio continua no público
 * congelado da tag (aceito: tirar da tag custaria uma escrita por pessoa).
 */
export async function runBaseDraft(opts: BasePrepOpts, deps: BasePrepDeps): Promise<BaseDraftResult> {
  const secret = gateOrThrow(opts);
  const snip = loadFollowupSnippets(opts.snippetsDir).form_base!;
  const existing = readStoreOrThrow(opts.storePath).followup!.base_invite ?? null;
  const refuseExisting = (cur: FollowupBaseInvite) => {
    if (cur.status !== "pending") {
      return `já existe o e-mail da base no store (lote ${cur.lot_id}, status ${cur.status}, broadcast ${cur.broadcast_id ?? "-"}) — e-mail único, nada a montar.`;
    }
    if (baseInviteMayExist(cur)) {
      return (
        `a tentativa anterior (lote ${cur.lot_id}) chamou createBroadcast sem confirmar o broadcast — o Kit pode ter criado um rascunho com a tag ${cur.tag_name}. ` +
        "Conferir no painel do Kit, apagar o rascunho se existir e rodar --step reset --apply --force."
      );
    }
    return null;
  };
  const refusal = existing ? refuseExisting(existing) : null;
  if (refusal) throw new CliExitWithMessage(refusal);
  const aud = await buildBaseAudience(opts, deps);
  const split = await splitBySig(aud.recipients, secret);
  const ok = [...split.ok];
  let pending = split.pending;
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
  if (!opts.apply) {
    if (pending.length > 0) out.aviso = `${pending.length} pessoa(s) sem form_sig certo pela listagem — o --apply confere cada uma pelo GET singular e recusa se faltar alguma (rode --step sigs --apply até restantes: 0).`;
    return out;
  }
  if (pending.length > 0) {
    const re = await recheckPendingSigs(pending, secret, deps);
    ok.push(...re.signed);
    out.confirmados_por_get = re.signed.length;
    pending = pending.filter((p) => !re.signed.includes(p));
    if (re.missing.length > 0) {
      const ids = re.missing.slice(0, BASE_MISSING_SIG_LIST_MAX).map((m) => `${m.kit_subscriber_id} (${m.motivo})`);
      throw new CliExitWithMessage(
        `${re.missing.length} pessoa(s) do público sem a assinatura certa pelo GET singular — nada montado. Rode --step sigs --apply até restantes: 0. ` +
          `Ids: ${ids.join(", ")}${re.missing.length > ids.length ? ` e mais ${re.missing.length - ids.length}` : ""}.`,
      );
    }
    out.recipients = ok.length;
    out.excluded.sem_assinatura = 0;
  }
  if (ok.length === 0) throw new CliExitWithMessage("nenhum destinatário com a assinatura certa — nada a montar.");
  if (!deps.kit) throw new CliExitWithMessage("transporte Kit não configurado — recusando montar o rascunho.");

  const probe = await probeFormLinkEndToEnd(opts.cfg.formUrl!, secret, deps);
  if (probe) throw new CliExitWithMessage(`formulário travado: ${probe.detalhe}`);

  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const okIds = ok.map((r) => String(r.kit_subscriber_id));
  // Reivindica (ou reaproveita o `pending` de uma tentativa que caiu no meio).
  const invite = withStore<FollowupBaseInvite>(opts.storePath, (block) => {
    const cur = block.base_invite;
    const again = cur ? refuseExisting(cur) : null;
    if (again) throw new CliExitWithMessage(again);
    const lotId = cur?.lot_id ?? buildFollowupLotId("form_base", unixSecondsToBrtDate(Math.floor(nowMs / 1000)), 1);
    let attempt = cur?.attempt ?? 1;
    let tagName = cur?.tag_name ?? `onboarding-${lotId}`;
    let tagId = cur?.tag_id ?? null;
    // A tag da tentativa anterior só serve se todo mundo tagueado nela ainda
    // está no público (senão `assertPilotTagAudience` acusa membro fora do
    // lote): tag nova, com o número da tentativa.
    if (cur && cur.tag_id != null) {
      const now = new Set(okIds);
      if (cur.recipient_subscription_ids.some((id) => !now.has(id))) {
        attempt += 1;
        tagName = `onboarding-${lotId}-t${attempt}`;
        tagId = null;
      }
    }
    const next: FollowupBaseInvite = {
      lot_id: lotId,
      tag_name: tagName,
      tag_id: tagId,
      broadcast_id: null,
      recipient_subscription_ids: okIds,
      recipient_emails: ok.map((r) => r.email),
      status: "pending",
      created_at: cur?.created_at ?? nowIso,
      send_at: null,
      confirmed_at: null,
      last_error: null,
      attempt,
      create_attempted_at: null,
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
  /** Audiência do rascunho não confirmada: `divergent` ANTES de apagar; o erro do delete é anexado. */
  const abandonDraft = async (broadcastId: number, reason: string): Promise<never> => {
    invite.status = "divergent";
    invite.last_error = reason;
    persist();
    try {
      await kit.deleteBroadcast(broadcastId);
    } catch (e) {
      invite.last_error = `${reason} | E a exclusão do broadcast ${broadcastId} falhou (${redactEmails((e as Error).message)}) — APAGUE NO PAINEL DO KIT AGORA e rode --step reset --apply.`;
      persist();
      throw new CliExitWithMessage(invite.last_error);
    }
    invite.broadcast_id = null;
    invite.status = "pending";
    invite.create_attempted_at = null;
    invite.last_error = `${reason} | broadcast ${broadcastId} apagado; nada agendado.`;
    persist();
    throw new CliExitWithMessage(invite.last_error);
  };
  try {
    let reused = invite.tag_id != null;
    if (invite.tag_id == null) {
      const found = await kit.findTagIdByName(invite.tag_name);
      reused = found != null;
      invite.tag_id = found ?? (await kit.createTag(invite.tag_name)).id;
      persist();
    }
    const tagId = invite.tag_id;
    // Retomada: não reescreve quem a tag já tem (a listagem pode atrasar; regravar é inofensivo).
    const already = reused ? new Set((await kit.listTagMemberEmails(tagId)).map(normalizeEmail)) : new Set<string>();
    let first = true;
    for (let i = 0; i < invite.recipient_subscription_ids.length; i++) {
      if (already.has(normalizeEmail(invite.recipient_emails[i] ?? ""))) continue;
      if (!first) await sleep(BASE_TAG_SPACING_MS);
      first = false;
      await kit.tagSubscriber(tagId, Number(invite.recipient_subscription_ids[i]));
    }
    await assertPilotTagAudience(kit, invite, invite.recipient_emails, opts.tagCheckAttempts, opts.tagCheckDelayMs);
    // Marca ANTES de criar: um timeout aqui pode ter criado o rascunho no Kit.
    invite.create_attempted_at = new Date(opts.nowMs ?? Date.now()).toISOString();
    persist();
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
    invite.create_attempted_at = null;
    persist();
    const { verification, reread } = await rereadPilotFilter(kit, created.id, tagId);
    if (verification.status !== "verified") {
      await abandonDraft(created.id, `audiência do rascunho ${created.id} não confirmada pela releitura (${verification.status}): ${verification.reason}`);
    }
    if (reread?.status != null && reread.status !== "draft") {
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

/** Sem `--apply` só mostra o que está no store (nenhuma leitura do Kit). */
export async function runBaseConfirm(opts: BasePrepOpts, deps: BasePrepDeps): Promise<unknown> {
  const store = readStoreOrThrow(opts.storePath);
  const invite = store.followup!.base_invite ?? null;
  if (!invite) return { mode: opts.apply ? "apply" : "dry-run", base_invite: null };
  if (!opts.apply) {
    return {
      mode: "dry-run",
      base_invite: { lot_id: invite.lot_id, status: invite.status, broadcast_id: invite.broadcast_id, recipients: invite.recipient_subscription_ids.length, last_error: invite.last_error },
    };
  }
  const out = await confirmBaseInviteIfSent(opts.storePath, store.followup!, deps, opts.nowMs ?? Date.now());
  return { mode: "apply", result: out ?? { status: invite.status, failed: false } };
}

// ---------------------------------------------------------------------------
// Passo 4 — reset (sair de draft/scheduled/divergent sem envio)
// ---------------------------------------------------------------------------

export interface BaseResetResult {
  mode: "dry-run" | "apply";
  lot_id: string;
  before: FollowupBaseInvite["status"];
  after: FollowupBaseInvite["status"];
  motivo: string;
  forced: boolean;
}

/**
 * Volta o e-mail da base a `pending` (sem broadcast) para que `--step draft`
 * possa montar de novo. Só quando o Kit prova que o broadcast não sai: 404
 * (apagado) ou `aborted`. `--force` cobre o que o Kit não consegue provar
 * (releitura falhando, ou nenhum broadcast gravado depois de um
 * `createBroadcast` sem resposta) e só deve ser usado DEPOIS de conferir no
 * painel do Kit que não há broadcast com a tag do lote. Nunca reseta, nem
 * com `--force`: convite `sent`, ou broadcast que o Kit mostra `draft`
 * (apagar no painel antes: um rascunho órfão é utilizável), `scheduled`,
 * `sending` ou `completed`. Mantém tag e destinatários (a próxima montagem
 * reaproveita a tag só se todo mundo nela ainda está no público).
 */
export async function runBaseReset(opts: BasePrepOpts & { force?: boolean }, deps: BasePrepDeps): Promise<BaseResetResult> {
  const invite = readStoreOrThrow(opts.storePath).followup!.base_invite ?? null;
  if (!invite) throw new CliExitWithMessage("nenhum e-mail da base no store — nada a resetar.");
  if (invite.status === "sent") throw new CliExitWithMessage(`e-mail da base já enviado (lote ${invite.lot_id}) — reset recusado.`);
  if (!baseInviteMayExist(invite)) throw new CliExitWithMessage(`e-mail da base já em "${invite.status}" sem broadcast — nada a resetar.`);
  const force = opts.force === true;
  let motivo: string;
  if (invite.broadcast_id == null) {
    if (!force) {
      throw new CliExitWithMessage(
        `lote ${invite.lot_id} sem broadcast gravado depois de chamar createBroadcast — o Kit não prova que nada foi criado. Conferir no painel (tag ${invite.tag_name}) e usar --force.`,
      );
    }
    motivo = "sem broadcast gravado; --force depois de conferir o painel";
  } else {
    const id = invite.broadcast_id;
    if (!deps.getBroadcast) throw new CliExitWithMessage("releitura do Kit não configurada — reset recusado.");
    let status: string | null = null;
    let readError: string | null = null;
    try {
      status = (await deps.getBroadcast(id)).status ?? null;
    } catch (e) {
      if (deps.isNotFoundError?.(e)) status = "__404__";
      else readError = redactEmails((e as Error).message);
    }
    if (status === "__404__") motivo = `broadcast ${id} não existe mais no Kit (404)`;
    else if (status === "aborted") motivo = `broadcast ${id} "aborted" no Kit`;
    else if (status === "draft" || status === "scheduled" || status === "sending" || status === "completed") {
      throw new CliExitWithMessage(
        `broadcast ${id} está "${status}" no Kit — reset recusado (nem com --force): ${status === "draft" ? "apagar o rascunho no painel antes" : "o e-mail pode sair ou já saiu"}.`,
      );
    } else if (force) motivo = `broadcast ${id}: ${readError ? `releitura falhou (${readError})` : `status "${status ?? "?"}"`}; --force depois de conferir o painel`;
    else {
      throw new CliExitWithMessage(
        `broadcast ${id}: ${readError ? `releitura falhou (${readError})` : `status "${status ?? "?"}"`} — o Kit não prova que ele não sai. Conferir no painel e usar --force.`,
      );
    }
  }
  const out: BaseResetResult = { mode: opts.apply ? "apply" : "dry-run", lot_id: invite.lot_id, before: invite.status, after: "pending", motivo, forced: force };
  if (!opts.apply) return out;
  const nowIso = new Date(opts.nowMs ?? Date.now()).toISOString();
  withStore(opts.storePath, (block) => {
    const cur = block.base_invite;
    if (!cur || cur.lot_id !== invite.lot_id || cur.status !== invite.status) throw new CliExitWithMessage("o e-mail da base mudou no store durante o reset — rode de novo.");
    block.base_invite = { ...cur, status: "pending", broadcast_id: null, send_at: null, create_attempted_at: null, last_error: `reset em ${nowIso}: ${motivo}` };
    return { result: undefined, write: true };
  });
  return out;
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
  step: "sigs" | "draft" | "confirm" | "reset" | null;
  apply: boolean;
  force: boolean;
  max?: number;
  storePath?: string;
  snippetsDir?: string;
  configPath?: string;
  envRoot?: string;
}

export function parseBasePrepArgs(argv: string[]): CliArgs {
  const a: CliArgs = { step: null, apply: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--step") {
      const v = argv[++i];
      if (v !== "sigs" && v !== "draft" && v !== "confirm" && v !== "reset") throw new CliExitWithMessage(`--step inválido: ${v ?? "(vazio)"} (sigs | draft | confirm | reset)`);
      a.step = v;
    } else if (f === "--apply") a.apply = true;
    else if (f === "--force") a.force = true;
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
  if (a.step == null) throw new CliExitWithMessage("--step é obrigatório (sigs | draft | confirm | reset)");
  if (a.force && a.step !== "reset") throw new CliExitWithMessage("--force só vale com --step reset");
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
  if (args.step === "confirm" || args.step === "reset") {
    const { getBroadcast } = await import("./lib/kit-client.ts");
    const { isKitNotFoundError } = await import("./onboarding-kit-transport-run.ts");
    deps.getBroadcast = (id) => getBroadcast(id, kitCfg);
    deps.isNotFoundError = isKitNotFoundError;
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
    const step = args.step!;
    const out =
      step === "sigs"
        ? await runBaseSigs(opts, deps)
        : step === "draft"
          ? await runBaseDraft(opts, deps)
          : step === "confirm"
            ? await runBaseConfirm(opts, deps)
            : await runBaseReset({ ...opts, force: args.force }, deps);
    console.log(JSON.stringify({ step, ...(out as object) }, null, 2));
    // `sigs` com falha/campo ausente e `confirm` com falha: exit 1 (o JSON já saiu com o detalhe).
    if (basePrepExitCode(step, out) !== 0) {
      process.stderr.write(`${LOG} --step ${step} terminou com falha (ver JSON acima).\n`);
      throw new CliExit(1);
    }
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
