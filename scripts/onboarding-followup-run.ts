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
 * arquivos que faltam já com o marcador (nunca sobrescreve texto editado).
 * Quando existe rascunho versionado da etapa em
 * `context/templates/onboarding-followup/` (#10605: os 2 do formulário), é
 * ele que vira o arquivo, com o marcador pendente intacto; um arquivo que
 * ainda é o modelo vazio de antes do rascunho é trocado pelo rascunho.
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
 *   npx tsx scripts/onboarding-followup-run.ts --init-snippets # cria os textos faltantes com o marcador (rascunho versionado quando há)
 * Flags auxiliares: --store <path>, --snippets-dir <path>, --config <path>, --env-root <path>, --skip-if-disabled.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { listAllKitSubscribers, getSubscriberById, updateSubscriberFields } from "./lib/kit-subscribers.ts";
import { KIT_APOIO_NIVEL_FIELD_KEY } from "./lib/apoio-segments-canonical-kit.ts";
import { findTagIdByName, listAllTagSubscriberEmails, deleteBroadcast } from "./lib/kit-broadcasts.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import { KIT_ENVIO_BREVO_TAG_NAME } from "./lib/kit-diaria-audience.ts";
import { withFileLock } from "./lib/file-lock.ts";
import { resolveNewsletterSubscriberBackend } from "./lib/shared/newsletter-subscriber-source.ts";
import { unixSecondsToBrtDate } from "./lib/beehiiv-publish-date.ts";
import { readStore, writeStore, DEFAULT_STORE_PATH, type OnboardingStore } from "./lib/onboarding-store.ts";
import { decideLotReconciliation, LOT_STALE_AFTER_MS, refreshKitCandidates, type RefreshKitCandidatesOpts } from "./lib/onboarding-kit-transport.ts";
import { isKitTransientError } from "./onboarding-welcome-run.ts";
import { redactEmails } from "./lib/onboarding-kit-pilot.ts";
import { parseFormResponsesPayload } from "./lib/onboarding-form-contract.ts";
import { FORM_PAGE_MARKER, FORM_SIG_KIT_FIELD, ONBOARDING_FORM_LINK_SECRET_ENV, signFormEmail } from "./lib/onboarding-form-link-sig.ts";
import { PENDING_BODY_MARKER } from "./lib/onboarding-state.ts";
import {
  ALL_FOLLOWUP_STEPS,
  apoioContentGate,
  applyFollowupLotToPeople,
  applyFormResponses,
  buildFollowupLotId,
  filterDueByLiveCheck,
  isConcreteKitState,
  findLatestFollowupLot,
  formCandidatesFromEntries,
  formContentGate,
  buildFormLink,
  FORM_LINK_PROBE_EMAIL,
  idsInConfirmedFollowupLots,
  idsInUnresolvedFollowupLots,
  isApoioStep,
  isFormStep,
  isoToSec,
  isUnresolvedFollowupLot,
  normalizeEmail,
  parseFollowupSnippet,
  planFollowup,
  recordLiveCheckSkips,
  recordLiveCheckFailures,
  hasLiveFailure,
  isCapDemoted,
  refreshPeopleEmailsFromChecks,
  resolveFollowupExitCode,
  recordApoioChecks,
  recordFollowupRun,
  renderFollowupBody,
  splitDueByCap,
  capWindowOverflows,
  classifyLookupFailures,
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
  type LookupFailure,
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

/** Rascunhos versionados dos textos (#10605) — semente do `--init-snippets`. */
export const FOLLOWUP_DRAFTS_DIR = resolve(ROOT, "context/templates/onboarding-followup");

/**
 * Cria os textos que faltam já com o marcador pendente: o rascunho versionado
 * da etapa quando existe (`draftsDirAbs`), senão o modelo vazio. Nunca
 * sobrescreve texto editado; só troca um arquivo que ainda é EXATAMENTE o
 * modelo vazio (`snippetTemplate`) pelo rascunho, caso de quem rodou
 * `--init-snippets` antes de o rascunho existir. Rascunho sem o marcador
 * pendente é recusado (lança): a semente nunca pode destravar envio sozinha.
 * A validação de TODOS os rascunhos acontece antes de qualquer escrita, então
 * uma recusa não deixa o diretório pela metade.
 * Devolve os caminhos gravados (`written`) e os que ficaram como estavam
 * (`skipped`, com o motivo).
 */
export interface InitSnippetsResult {
  written: string[];
  skipped: { path: string; reason: "texto_existente" | "ja_e_o_rascunho" }[];
}

export function initFollowupSnippets(dirAbs: string, draftsDirAbs: string = FOLLOWUP_DRAFTS_DIR): InitSnippetsResult {
  const drafts = new Map<FollowupStepKind, string | null>();
  for (const kind of ALL_FOLLOWUP_STEPS) {
    const draftPath = resolve(draftsDirAbs, snippetFileFor(kind));
    const draft = existsSync(draftPath) ? readFileSync(draftPath, "utf8") : null;
    if (draft != null && !draft.includes(PENDING_BODY_MARKER)) {
      throw new Error(`[onboarding-followup] rascunho ${draftPath} sem ${PENDING_BODY_MARKER}: a semente nunca pode sair já aprovada`);
    }
    drafts.set(kind, draft);
  }
  mkdirSync(dirAbs, { recursive: true });
  const out: InitSnippetsResult = { written: [], skipped: [] };
  for (const kind of ALL_FOLLOWUP_STEPS) {
    const p = resolve(dirAbs, snippetFileFor(kind));
    const draft = drafts.get(kind) ?? null;
    if (existsSync(p)) {
      const current = readFileSync(p, "utf8");
      if (draft != null && current === snippetTemplate(kind)) {
        writeFileSync(p, draft);
        out.written.push(p);
      } else {
        out.skipped.push({ path: p, reason: draft != null && current === draft ? "ja_e_o_rascunho" : "texto_existente" });
      }
      continue;
    }
    writeFileSync(p, draft ?? snippetTemplate(kind), { flag: "wx" });
    out.written.push(p);
  }
  return out;
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
  /**
   * #10676: espera entre as leituras singulares e antes da passada de retry
   * (espaçamento/cooldown de `refreshKitCandidates`, #10616). Ausente = não
   * espera (testes); o executor real passa `setTimeout`.
   */
  sleep?(ms: number): Promise<void>;
  /** #10676: o erro da leitura singular é retentável mais tarde (429/5xx/rede).
   *  Ausente = todo erro conta como transitório. */
  isTransientLookupError?(err: unknown): boolean;
  /**
   * #10657: grava a assinatura do link do formulário no custom field
   * `form_sig` da pessoa (PATCH) e diz o que a RESPOSTA mostra do campo (o
   * Kit descarta campo inexistente com 2xx, #9663). Ausente = nenhuma
   * assinatura gravável: quem ainda não tem a assinatura certa fica fora do
   * lote do formulário.
   */
  setFormSig?(kitId: number, sig: string): Promise<FormSigWriteResult>;
  /**
   * #10657: sonda de ponta a ponta do link — `GET` no link do formulário
   * assinado para `FORM_LINK_PROBE_EMAIL`, sem efeito colateral. Devolve o
   * status HTTP e se o corpo é a página REAL do formulário
   * (`FORM_PAGE_MARKER`); lança em erro de rede/timeout. Ausente = formulário
   * travado (`link_rejeitado_pelo_worker`): sem a sonda ninguém sabe se o
   * Worker aceita o link. O executor real usa `fetchFormProbe`.
   */
  probeFormLink?(url: string): Promise<FormProbeResult>;
}

export interface FormProbeResult {
  status: number;
  /** O corpo traz `FORM_PAGE_MARKER` — 200 sem ele (página de desafio da
   *  Cloudflare, "Link inválido" servido com 200 por algum proxy) não vale. */
  bodyHasForm: boolean;
}

/** User-Agent de navegador na sonda: sem ele a Cloudflare pode responder com
 *  página de desafio em vez do Worker. */
export const FORM_PROBE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
export const FORM_PROBE_TIMEOUT_MS = 15_000;

/** #10657: o GET real da sonda — User-Agent de navegador, sem seguir
 *  redirect, com timeout (lança no abort; o chamador trava o formulário). */
export async function fetchFormProbe(
  url: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = FORM_PROBE_TIMEOUT_MS,
): Promise<FormProbeResult> {
  const res = await fetchFn(url, {
    redirect: "manual",
    headers: { "user-agent": FORM_PROBE_USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  return { status: res.status, bodyHasForm: body.includes(FORM_PAGE_MARKER) };
}

/** O que a resposta do PATCH mostra do `form_sig`:
 *  - `stored`: `fields` traz o campo com este valor;
 *  - `absent`: `fields` veio sem o campo (o Kit descartou a chave);
 *  - `unknown`: a resposta veio sem `fields` — não prova nada, relê pelo GET singular. */
export type FormSigWriteResult = { kind: "stored"; value: string } | { kind: "absent" } | { kind: "unknown" };

/** Por que uma pessoa ficou fora do lote do formulário (vira contagem por etapa). */
export type FormSigFailureReason =
  /** Erro na gravação (depois do retry, ou não transitório). */
  | "assinatura_falhou"
  /** A releitura trouxe OUTRO valor (concorrência, ou Kit mexendo no valor) — por pessoa. */
  | "assinatura_divergente_pos_escrita"
  /** Releitura sem o campo: `form_sig` não existe no Kit — trava o formulário inteiro. */
  | "campo_assinatura_ausente";

export interface FormSigProvisionResult {
  /** Devidos do formulário com a assinatura certa gravada no Kit. */
  ok: FollowupDue[];
  /** Fora do lote nesta rodada (volta na próxima). `ok` + `failed` cobrem todos os devidos. */
  failed: { due: FollowupDue; motivo: FormSigFailureReason; error: string }[];
  /** A releitura (resposta do PATCH, ou GET singular quando ela veio sem
   *  `fields`) não trouxe o `form_sig`: o campo não existe na conta. Todo o
   *  resto do formulário fica fora (não adianta tentar pessoa a pessoa). */
  fieldMissing: string | null;
  /** Gravações (PATCH) tentadas nesta rodada, contando as de retry. */
  written: number;
}

/** Espaçamento/cooldown/passadas da gravação — mesmos defaults das leituras
 *  singulares (`refreshKitCandidates`, #10616/#10676): 350ms, 60s, 1 passada. */
export type FormSigWriteOpts = Pick<RefreshKitCandidatesOpts, "spacingMs" | "retryDelayMs" | "retryPasses">;

/**
 * #10657: garante, pessoa a pessoa, que o custom field `form_sig` do Kit
 * guarda a assinatura do e-mail ATUAL dela (o da leitura singular, que é o
 * mesmo que a merge tag `{{ subscriber.email_address }}` vai pôr no link; sem
 * ele, o e-mail do store). Quem já tem o valor certo não gera escrita; o
 * lembrete reaproveita. A mesma pessoa devida em `form` e `form_lembrete`
 * gera UMA escrita e as duas entram em `ok`. Nunca deixa passar alguém sem
 * assinatura confirmada: o link dela seria recusado pelo Worker.
 *
 * Mesmo regime das leituras (#10676): 1ª passada espaçada, depois passada(s)
 * extra(s) só sobre erro transitório (429/5xx/rede) após cooldown; erro não
 * transitório (401/403) não é retentado.
 *
 * Confirmação pós-escrita: o que a resposta do PATCH mostra; se ela vier sem
 * `fields`, relê pelo GET singular (autoritativo — a LISTAGEM do Kit serve
 * `fields` defasado, o GET singular não). Releitura SEM o campo = campo
 * ausente no Kit (`fieldMissing`, trava tudo); releitura com OUTRO valor =
 * falha só daquela pessoa (`assinatura_divergente_pos_escrita`).
 * `secret` é o segredo já validado por `formContentGate`.
 */
export async function provisionFormSigs(
  due: readonly FollowupDue[],
  checks: ReadonlyMap<number, LiveSubscriberCheck | null>,
  secret: string,
  deps: Pick<FollowupRoundDeps, "setFormSig" | "sleep" | "isTransientLookupError" | "getSubscriber">,
  opts: FormSigWriteOpts = {},
): Promise<FormSigProvisionResult> {
  const spacingMs = opts.spacingMs ?? 350;
  const retryDelayMs = opts.retryDelayMs ?? 60_000;
  const retryPasses = opts.retryPasses ?? 1;
  const sleep = deps.sleep ?? noSleep;
  const isTransient = deps.isTransientLookupError ?? (() => true);
  const out: FormSigProvisionResult = { ok: [], failed: [], fieldMissing: null, written: 0 };

  // Assinatura esperada por pessoa e quem precisa de escrita (1 escrita por
  // pessoa, mesmo com duas etapas do formulário devidas).
  const expectedById = new Map<number, string>();
  const dueById = new Map<number, FollowupDue[]>();
  for (const d of due) {
    const id = d.kit_subscriber_id;
    if (!expectedById.has(id)) {
      const check = checks.get(id);
      expectedById.set(id, await signFormEmail(check?.email || d.email, secret));
    }
    const list = dueById.get(id) ?? [];
    list.push(d);
    dueById.set(id, list);
  }
  const accept = (id: number) => out.ok.push(...dueById.get(id)!);
  const reject = (id: number, motivo: FormSigFailureReason, error: string) => {
    for (const d of dueById.get(id)!) out.failed.push({ due: d, motivo, error });
  };

  let pending: number[] = [];
  for (const id of dueById.keys()) {
    if (checks.get(id)?.formSig === expectedById.get(id)) accept(id);
    else pending.push(id);
  }
  if (pending.length > 0 && !deps.setFormSig) {
    for (const id of pending) reject(id, "assinatura_falhou", "sem gravação de form_sig configurada");
    return out;
  }

  const missingMsg = `releitura do ${FORM_SIG_KIT_FIELD} sem o campo depois do PATCH 2xx — criar o custom field "${FORM_SIG_KIT_FIELD}" no Kit (#10657)`;
  const skippedMsg = `não tentado: ${FORM_SIG_KIT_FIELD} ausente no Kit`;
  for (let pass = 0; pass <= retryPasses && pending.length > 0; pass++) {
    if (pass > 0) await sleep(retryDelayMs);
    const retry: number[] = [];
    let first = true;
    for (const id of pending) {
      if (out.fieldMissing) {
        reject(id, "campo_assinatura_ausente", skippedMsg);
        continue;
      }
      if (!first) await sleep(spacingMs);
      first = false;
      const expected = expectedById.get(id)!;
      try {
        out.written++;
        let res = await deps.setFormSig!(id, expected);
        if (res.kind === "unknown") {
          // Resposta sem `fields`: não prova nada — relê pelo GET singular.
          await sleep(spacingMs);
          const reread = (await deps.getSubscriber(id)).formSig;
          res = typeof reread === "string" && reread !== "" ? { kind: "stored", value: reread } : { kind: "absent" };
        }
        if (res.kind === "stored" && res.value === expected) {
          accept(id);
          continue;
        }
        if (res.kind === "stored") {
          reject(
            id,
            "assinatura_divergente_pos_escrita",
            `releitura do ${FORM_SIG_KIT_FIELD} com outro valor (${res.value.length} caracteres, esperado ${expected.length})`,
          );
          continue;
        }
        out.fieldMissing = missingMsg;
        reject(id, "campo_assinatura_ausente", missingMsg);
      } catch (e) {
        const msg = redactEmails((e as Error)?.message ?? String(e));
        if (isTransient(e) && pass < retryPasses) {
          retry.push(id);
        } else {
          reject(id, "assinatura_falhou", msg);
        }
      }
    }
    if (out.fieldMissing) {
      for (const id of retry) reject(id, "campo_assinatura_ausente", skippedMsg);
      break;
    }
    pending = retry;
  }
  return out;
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
  /** #10676: espaçamento/cooldown/passadas das leituras singulares (defaults
   *  de `refreshKitCandidates`: 350ms, 60s, 1 passada extra). A espera em si
   *  vem de `deps.sleep`. */
  lookupOpts?: Omit<RefreshKitCandidatesOpts, "sleep">;
  /** #10657: `ONBOARDING_FORM_LINK_SECRET`. Ausente/vazio TRAVA o envio do
   *  formulário (`assinatura_nao_configurada`), nunca sai link sem assinatura. */
  formLinkSecret?: string | null;
}

const noSleep = () => Promise.resolve();

export interface LiveCheckOutcome {
  /** Leitura por id — `null` = falhou (nunca autoriza envio). */
  results: Map<number, LiveSubscriberCheck | null>;
  /** Ids que seguiram falhando depois do retry, com o devido, se o erro era
   *  transitório e a mensagem (já sem e-mail) para o log. */
  failed: Map<number, { due: FollowupDue; transient: boolean; error: string }>;
  /** Leituras distintas tentadas. */
  total: number;
}

/**
 * #10676: leitura singular dos devidos (1 por pessoa) via `refreshKitCandidates`
 * (#10616) — 1ª passada espaçada, depois passada(s) extra(s) só sobre erro
 * transitório após cooldown. Erro não transitório (401/403) não é retentado.
 */
class MissingStateError extends Error {
  constructor(id: number) {
    super(`GET /subscribers/${id} sem state`);
    this.name = "MissingStateError";
  }
}

export async function liveCheckDue(
  due: readonly FollowupDue[],
  opts: Pick<FollowupRoundOpts, "lookupOpts">,
  deps: Pick<FollowupRoundDeps, "getSubscriber" | "sleep" | "isTransientLookupError">,
): Promise<LiveCheckOutcome> {
  const byId = new Map<number, FollowupDue>();
  for (const d of due) if (!byId.has(d.kit_subscriber_id)) byId.set(d.kit_subscriber_id, d);
  const isTransient = deps.isTransientLookupError ?? (() => true);
  const reads = new Map<number, LiveSubscriberCheck>();
  const lastError = new Map<number, { transient: boolean; error: string }>();
  const list = [...byId.keys()].map((id) => ({ subscription_id: String(id), id }));
  const refreshed = await refreshKitCandidates(
    list,
    async (c, diag) => {
      try {
        const r = await deps.getSubscriber(c.id);
        // #10685: resposta sem `state` concreto não prova saída — é leitura
        // falha (transitória, entra no retry), nunca pulo terminal `nao_ativo`.
        if (!isConcreteKitState(r.state)) throw new MissingStateError(c.id);
        reads.set(c.id, r);
        lastError.delete(c.id);
        return { status: r.state ?? undefined, stats: null };
      } catch (e) {
        diag.transportError = true;
        diag.transient = e instanceof MissingStateError ? true : isTransient(e);
        lastError.set(c.id, { transient: diag.transient, error: redactEmails((e as Error)?.message ?? String(e)) });
        return null;
      }
    },
    { ...opts.lookupOpts, sleep: deps.sleep ?? noSleep },
  );
  const results = new Map<number, LiveSubscriberCheck | null>();
  const failed: LiveCheckOutcome["failed"] = new Map();
  for (const { id } of list) {
    const ok = reads.get(id);
    if (ok && !refreshed.failed.has(String(id))) {
      results.set(id, ok);
      continue;
    }
    results.set(id, null);
    const err = lastError.get(id) ?? { transient: true, error: "leitura sem resultado" };
    failed.set(id, { due: byId.get(id)!, ...err });
  }
  return { results, failed, total: list.length };
}

function gateReason(g: { blocked: false } | { blocked: true; motivo: FollowupBlockReason; detalhe: string }): { motivo: FollowupBlockReason; detalhe: string } | null {
  return g.blocked ? { motivo: g.motivo, detalhe: g.detalhe } : null;
}

/**
 * #10657: sonda de ponta a ponta antes do 1º lote do formulário da rodada —
 * assina `FORM_LINK_PROBE_EMAIL` com o segredo do executor e faz `GET` no
 * link (montado igual ao do e-mail, com o e-mail cru). Pega segredo diferente
 * do Worker, Worker defasado e `form_url` errado ANTES de alguém receber um
 * link que daria "Link inválido". `null` = Worker aceitou (200 com a página
 * real do formulário).
 */
export async function probeFormLinkEndToEnd(
  formUrl: string,
  secret: string,
  deps: Pick<FollowupRoundDeps, "probeFormLink">,
): Promise<{ motivo: "link_rejeitado_pelo_worker"; detalhe: string } | null> {
  if (!deps.probeFormLink) {
    return { motivo: "link_rejeitado_pelo_worker", detalhe: "sonda do link não configurada no executor — sem ela não há como saber se o Worker aceita o link" };
  }
  const url = buildFormLink(formUrl, FORM_LINK_PROBE_EMAIL, await signFormEmail(FORM_LINK_PROBE_EMAIL, secret));
  try {
    const { status, bodyHasForm } = await deps.probeFormLink(url);
    if (status === 200 && bodyHasForm) return null;
    const what = status === 200 ? "HTTP 200 sem a página do formulário (desafio da Cloudflare ou página errada)" : `HTTP ${status} (esperado 200)`;
    return {
      motivo: "link_rejeitado_pelo_worker",
      detalhe: `GET do link assinado de sonda respondeu ${what} — conferir ONBOARDING_FORM_LINK_SECRET igual no Worker e no executor, Worker publicado e onboarding.followup.form_url`,
    };
  } catch (e) {
    return { motivo: "link_rejeitado_pelo_worker", detalhe: `GET do link assinado de sonda falhou: ${redactEmails((e as Error)?.message ?? String(e))}` };
  }
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
  const formGate = formContentGate(snippets, cfg, opts.formLinkSecret);
  // Segredo já validado (trim + tamanho) — é o que assina; nunca o valor cru.
  const linkSecret = formGate.blocked ? null : formGate.linkSecret;
  let formBlocked = gateReason(formGate);
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
  // #10763 rodízio; #10773: o rebaixamento cede no último dia da janela, e a
  // projeção do teto (`capWindowOverflows`) aplica a mesma regra.
  const failedLastRound = (d: FollowupDue) => hasLiveFailure(block.people[String(d.kit_subscriber_id)], d.kind);
  const demoted = (d: FollowupDue) => isCapDemoted(d, failedLastRound(d), orderSec(d), nowSec, cfg);
  const { within: dueWithinCap, deferred: capDeferred } = splitDueByCap(due, cfg.maxRecipientsPerLot, orderSec, demoted);
  for (const o of capDeferred) {
    bump(o.kind, "adiado_teto", o.deferred);
    lotsOut.push({ kind: o.kind, eligible: o.eligible, deferred: o.deferred, cap: cfg.maxRecipientsPerLot });
  }
  // #10652: excedente que não cabe na janela vira `vencida` sem receber —
  // a decisão de lote parcial (#10631) fica, mas isso não pode passar calado.
  // #10660: capacidade por pessoa (dias que restam da janela de cada um), na
  // mesma ordem do corte acima. A projeção usa todos os devidos; o corte
  // precede o filtro ao vivo: exclusões ocupam vaga sem reposição hoje; falhas de
  // consulta podem voltar amanhã. Estimativa, sem limite garantido de perdas
  // e com imprecisão de ~1h na fronteira diária (ver capWindowOverflows).
  const windowOverflows = capWindowOverflows(due, cfg.maxRecipientsPerLot, nowSec, cfg, orderSec, failedLastRound);
  run.cap_window_overflow = windowOverflows.length;
  for (const w of windowOverflows) {
    bump(w.kind, "excede_janela", w.projected_vencidas);
    lotsOut.push({ kind: w.kind, cap_window_overflow: true, eligible: w.eligible, capacity: w.capacity, projected_vencidas: w.projected_vencidas });
    process.stderr.write(
      `${LOG} ${w.kind}: ${w.eligible} elegíveis, só ${w.capacity} cabem nos dias que restam das janelas (${cfg.maxRecipientsPerLot}/lote/dia) — estimativa de ${w.projected_vencidas} vencimentos sem envio; conferir com o editor (subir onboarding.followup.max_recipients_per_lot ou grace_days)\n`,
    );
  }

  // Checagem perto do envio: ativo + não apoia (leitura singular, nunca a listagem).
  // #10676: até `max_recipients_per_lot` GETs por etapa — mesmo espaçamento e
  // passada de retry após cooldown do refresh da escada (#10616), senão uma
  // coorte enchendo o teto toma 429 e um GET esgotado derrubava a rodada.
  const checks = await liveCheckDue(dueWithinCap, opts, deps);
  const failures: LookupFailure[] = [];
  for (const f of checks.failed.values()) {
    failures.push({ due: f.due, transient: f.transient, anchorSec: orderSec(f.due) });
  }
  const lookupSplit = classifyLookupFailures(failures, checks.total, nowSec, cfg);
  run.lookups_failed += lookupSplit.blocking;
  if (lookupSplit.deferred > 0) run.lookups_deferred = lookupSplit.deferred;
  for (const [id, f] of checks.failed) {
    process.stderr.write(`${LOG} leitura de ${id} (${f.due.kind}) falhou depois do retry — fora do envio de hoje: ${f.error}\n`);
  }
  if (failures.length > 0) {
    process.stderr.write(`${LOG} leituras singulares falhas: ${failures.length}/${checks.total} — ${lookupSplit.deferred} adiadas para amanhã, ${lookupSplit.blocking} contam como falha da rodada\n`);
  }
  const { send: liveOk, excluded } = filterDueByLiveCheck(dueWithinCap, checks.results);
  for (const x of excluded) bump(x.due.kind, x.motivo);
  if (send) {
    persistFollowupPeople(storePath, (people) => {
      recordLiveCheckSkips(people, excluded, nowIso);
      recordLiveCheckFailures(people, excluded, liveOk, nowIso);
      recordApoioChecks(people, liveOk, nowIso);
      // #10774: o link do formulário é assinado com o e-mail ATUAL do Kit;
      // a resposta tem de casar com ele, não com o e-mail da 1ª gravação.
      refreshPeopleEmailsFromChecks(people, checks.results);
    });
  }

  // #10657: assinatura do link do formulário. Só com `--send` (o dry-run
  // nunca escreve no Kit nem chama o Worker). 1º a sonda de ponta a ponta
  // (o Worker aceita um link assinado por este executor?), depois a
  // assinatura pessoa a pessoa no custom field do Kit. Quem não ficou com a
  // assinatura confirmada sai do lote: o link dela seria recusado.
  let toSend = liveOk;
  const formDue = liveOk.filter((d) => isFormStep(d.kind));
  if (send && formDue.length > 0 && linkSecret != null && cfg.formUrl != null) {
    const probe = await probeFormLinkEndToEnd(cfg.formUrl, linkSecret, deps);
    if (probe) {
      formBlocked = probe;
      run.form_blocked = formBlocked;
      for (const d of formDue) bump(d.kind, "link_rejeitado");
      toSend = liveOk.filter((d) => !isFormStep(d.kind));
      process.stderr.write(`${LOG} formulário travado: ${probe.detalhe}\n`);
    } else {
      const prov = await provisionFormSigs(formDue, checks.results, linkSecret, deps, opts.lookupOpts);
      const okSet = new Set(prov.ok);
      toSend = liveOk.filter((d) => !isFormStep(d.kind) || okSet.has(d));
      for (const f of prov.failed) {
        bump(f.due.kind, f.motivo);
        process.stderr.write(`${LOG} assinatura do formulário de ${f.due.kit_subscriber_id} (${f.due.kind}) não confirmada — fora do envio de hoje: ${f.motivo}: ${f.error}\n`);
      }
      // Falhas por pessoa contam como falha da rodada (alarme); o campo
      // ausente já conta pelo `form_blocked`.
      run.lookups_failed += prov.failed.filter((f) => f.motivo !== "campo_assinatura_ausente").length;
      if (prov.fieldMissing) {
        formBlocked = { motivo: "campo_assinatura_ausente", detalhe: prov.fieldMissing };
        run.form_blocked = formBlocked;
        process.stderr.write(`${LOG} formulário travado: ${prov.fieldMissing}\n`);
      }
    }
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
        // {{FORM_URL}} só existe nas etapas do formulário; num texto de apoio
        // o `apoioContentGate` já travou (#10657).
        body: isFormStep(kind) ? renderFollowupBody(snip.body, cfg.formUrl) : snip.body,
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
  // #10774: quem entrou no store agora (1º envio) nasceu com o e-mail do
  // plano; alinha ao e-mail atual do Kit, o mesmo que assinou o link.
  if (send && run.lots_created > 0) persistFollowupPeople(storePath, (people) => refreshPeopleEmailsFromChecks(people, checks.results));
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
      const sig = s.fields?.[FORM_SIG_KIT_FIELD];
      return {
        state: s.state ?? null,
        apoioNivel: typeof nivel === "string" ? nivel : "",
        email: s.email_address ?? null,
        formSig: typeof sig === "string" ? sig : null,
      };
    },
    // GET sem efeito colateral: o Worker só renderiza a página.
    probeFormLink: (url) => fetchFormProbe(url),
    async setFormSig(kitId, sig) {
      // #10657: o PATCH devolve o assinante; o valor relido prova que o
      // campo existe (o Kit descarta chave desconhecida com 2xx, #9663).
      const s = await updateSubscriberFields(kitId, { [FORM_SIG_KIT_FIELD]: sig }, kitCfg);
      // Sem `fields` na resposta: `unknown` faz o executor reler pelo GET singular.
      if (s.fields == null || typeof s.fields !== "object") return { kind: "unknown" };
      const stored = s.fields[FORM_SIG_KIT_FIELD];
      return typeof stored === "string" && stored !== "" ? { kind: "stored", value: stored } : { kind: "absent" };
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
    // #10676: espaçamento/cooldown reais das leituras singulares (#10616).
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    isTransientLookupError: isKitTransientError,
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
    // JSON: `written` = caminhos gravados (criados, ou modelo vazio trocado pelo
    // rascunho); `skipped` = {path, reason} dos que ficaram como estavam.
    // (Antes do #10605 a chave única era `created`.)
    const { written, skipped } = initFollowupSnippets(snippetsDirAbs);
    console.log(JSON.stringify({ mode: "init-snippets", written, skipped }));
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
  // Cru: a normalização (trim + tamanho mínimo) é do `formContentGate`/`checkLinkSecret`.
  const formLinkSecret = process.env[ONBOARDING_FORM_LINK_SECRET_ENV] ?? null;
  const formGate = formContentGate(snippets, cfg, formLinkSecret);
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
    out = await runFollowupRound({ storePath, send: args.send, cfg, snippets, formLinkSecret }, deps);
  } catch (e) {
    const msg = redactEmails((e as Error).message);
    record({ at: new Date().toISOString(), apoio_blocked: null, form_blocked: null, lots_created: 0, lots_failed: 0, over_cap: 0, lookups_failed: 0, counts: {}, aborted: true, error: msg });
    throw e;
  }
  record(out.run);
  console.log(JSON.stringify({ mode: args.send ? "SEND" : "dry-run", ...out.run, lots: out.lots }, null, 2));
  // #10661: excedente do teto sozinho sai 3 (`successExitCodes: [3]` na task);
  // nunca rebaixa um exit 1 já posto (ex.: falha ao registrar a rodada).
  const code = resolveFollowupExitCode(out.run);
  if (code !== 0 && (process.exitCode ?? 0) === 0) process.exitCode = code;
  else if (code === 1) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  void runCli(main, {
    onError: (e) => process.stderr.write(`${LOG} erro: ${redactEmails((e as Error).message)}\n`),
  });
}
