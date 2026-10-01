/**
 * onboarding-kit-pilot.ts (#7922 — piloto supervisionado, seção 4 de
 * `docs/onboarding-kit-cutover.md`)
 *
 * Núcleo do MODO PILOTO de `scripts/onboarding-kit-transport-run.ts`
 * (`--pilot --pilot-recipients <email> --store <isolado>`). O editor aprovou
 * o doc de corte e autorizou o piloto com UM destinatário de teste
 * (decisão registrada na #7922, sessão /diaria-develop 260930) — o kill
 * switch de produção (`onboarding.kit_transport.enabled`) segue OFF.
 *
 * O piloto é ENVIO REAL (o Kit não tem preview de broadcast), então tudo
 * aqui é guard de audiência, em camadas independentes:
 *
 *   1. **Store isolado** (`assertPilotStoreIsolated`): o piloto nunca lê nem
 *      escreve `data/onboarding/store.json` — exige `--store` apontando pra
 *      outro arquivo. É ISSO que permite ignorar o kill switch de produção
 *      só no piloto: as entries e os lotes do piloto vivem fora do store que
 *      o executor Brevo e o Kit de produção leem.
 *   2. **Store só do piloto** (`seedPilotStore`): recusa um store isolado
 *      que já contenha entry de e-mail fora da allowlist — cobre
 *      `--store` apontando pra uma CÓPIA do store real.
 *   3. **Allowlist por lote** (`assertLotRecipientsInAllowlist`): os
 *      destinatários de cada lote têm de ser subconjunto de
 *      `--pilot-recipients`, senão aborta antes de criar tag/broadcast.
 *   4. **Tag fresca e com exatamente os destinatários**
 *      (`runPilotLot` → `checkPilotTagMembers`): a tag do lote não pode
 *      existir antes (tag pré-existente pode ter membros), e depois de
 *      tageada é relida pela API — ausente, vazia, com membro fora da
 *      allowlist ou com contagem diferente de `recipients.length` aborta.
 *      Risco #6126: `subscriber_filter` que o Kit não resolve = base INTEIRA.
 *   5. **Releitura do broadcast** (`verifyPilotBroadcastFilter`): o
 *      broadcast nasce SEMPRE rascunho no piloto (mesmo e-mail 1/2), é
 *      relido, e só é agendado se o `subscriber_filter` relido for
 *      exatamente o da tag do lote (2xx não é prova, #6582). Divergente →
 *      apaga o rascunho e aborta. Não ecoado → fica rascunho e aborta, a
 *      menos que o editor passe `--pilot-allow-unechoed-filter` (o eco de
 *      `subscriber_filter` por `GET /broadcasts/{id}` nunca foi confirmado
 *      ao vivo — ver `KitBroadcastDetail.subscriber_filter`).
 *
 * Cadência: no piloto os 3 kinds (email1/email2/email3) são planejados no
 * MESMO dia, ignorando D+3/D+10 e as regras de abertura do e-mail 3 — o
 * objetivo é validar segmentação/entrega/renderização dos 3 conteúdos, não
 * a régua (que já tem cobertura própria em `onboarding-state.ts`). E-mail 3
 * continua nascendo rascunho e só agenda via `--approve-email3-lot
 * --send-at`, que no piloto repete a checagem da tag (camada 4) antes.
 *
 * Tudo aqui é puro ou recebe a rede INJETADA (`PilotKitDeps`) — testável
 * sem `fetch` real (`test/onboarding-kit-pilot-7922.test.ts`).
 */

import { resolve } from "node:path";
import type { CreateBroadcastInput, KitSubscriberFilter } from "./kit-broadcasts.ts";
import type { OnboardingEntry, OnboardingStore } from "./onboarding-store.ts";
import {
  buildOnboardingBroadcastInput,
  buildOnboardingLotFilter,
  hasConfirmedKitLotForEntry,
  type OnboardingKitLot,
  type OnboardingKitLotKind,
} from "./onboarding-kit-transport.ts";

/** Teto de destinatários do piloto — "lista curta e nomeada" (doc, seção 4).
 *  Mais que isso já não é piloto supervisionado. */
export const PILOT_MAX_RECIPIENTS = 5;

/** Prefixo das tags de lote do piloto — nunca colide com a tag de um lote de
 *  produção do mesmo dia (`onboarding-{lot_id}`). */
export const PILOT_TAG_PREFIX = "onboarding-pilot-";

/** Prefixo do `subscription_id` sintético das entries semeadas. */
export const PILOT_SUBSCRIPTION_PREFIX = "pilot:";

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

/** `--pilot-recipients <email>[,<email>]` → lista normalizada, deduplicada.
 *  Lança em vazio, e-mail malformado ou acima de `PILOT_MAX_RECIPIENTS`. */
export function parsePilotRecipients(raw: string | undefined): string[] {
  if (raw == null || raw.trim() === "") {
    throw new Error("[onboarding-kit-pilot] --pilot exige --pilot-recipients <email[,email]> (não-vazio).");
  }
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const e = normEmail(part);
    if (e === "") continue;
    if (!EMAIL_RE.test(e)) throw new Error(`[onboarding-kit-pilot] destinatário de piloto malformado: "${part.trim()}".`);
    if (!out.includes(e)) out.push(e);
  }
  if (out.length === 0) throw new Error("[onboarding-kit-pilot] --pilot-recipients não contém nenhum e-mail.");
  if (out.length > PILOT_MAX_RECIPIENTS) {
    throw new Error(
      `[onboarding-kit-pilot] ${out.length} destinatários — o piloto aceita no máximo ${PILOT_MAX_RECIPIENTS} (lista curta e nomeada).`,
    );
  }
  return out;
}

function normPath(p: string): string {
  const abs = resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** Camada 1: `--store` obrigatório e diferente de qualquer store real
 *  conhecido (o configurado em `platform.config.json` e o default). */
export function assertPilotStoreIsolated(storePath: string | undefined, realStorePaths: string[]): string {
  if (storePath == null || storePath.trim() === "") {
    throw new Error(
      "[onboarding-kit-pilot] --pilot exige --store <path-isolado> — o piloto nunca usa o store real (data/onboarding/store.json).",
    );
  }
  const abs = resolve(storePath);
  for (const real of realStorePaths) {
    if (normPath(abs) === normPath(real)) {
      throw new Error(
        `[onboarding-kit-pilot] --store "${storePath}" é o store REAL do onboarding — recusado. ` +
          "Aponte para um arquivo isolado (ex: um JSON em diretório temporário).",
      );
    }
  }
  return abs;
}

/** Entry sintética do piloto — sem `seeded_by` (excluiria da seleção) e sem
 *  `kit_subscriber_id` (resolvido pelo e-mail no refresh da rodada). */
export function buildPilotEntry(email: string, nowIso: string): OnboardingEntry {
  const e = normEmail(email);
  return {
    subscription_id: `${PILOT_SUBSCRIPTION_PREFIX}${e}`,
    email: e,
    status_detectado: "unknown",
    created_at: null,
    detected_at: nowIso,
    email1_sent_at: null,
    email1_brevo_id: null,
    email2_sent_at: null,
    email2_brevo_id: null,
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
  };
}

/** Camada 2 + semeadura: recusa store com entry fora da allowlist; adiciona
 *  a entry sintética de cada destinatário ainda ausente. Muta e devolve
 *  quantas entries foram criadas. */
export function seedPilotStore(store: OnboardingStore, recipients: string[], nowIso: string): number {
  const allow = new Set(recipients.map(normEmail));
  const foreign = Object.values(store.entries).filter((e) => !allow.has(normEmail(e.email)));
  if (foreign.length > 0) {
    throw new Error(
      `[onboarding-kit-pilot] o store isolado contém ${foreign.length} entry(s) fora de --pilot-recipients — ` +
        "parece uma cópia do store real. O piloto só roda sobre um store que contém APENAS os destinatários do piloto.",
    );
  }
  let created = 0;
  for (const email of recipients) {
    const entry = buildPilotEntry(email, nowIso);
    if (store.entries[entry.subscription_id]) continue;
    store.entries[entry.subscription_id] = entry;
    created++;
  }
  return created;
}

/** Entries do piloto que ainda não estão num lote CONFIRMADO deste kind —
 *  substitui `buildRunPlan` no piloto (sem cadência). Re-rodar não replaneja
 *  quem já tem broadcast confirmado (mesmo dedup de #9014). */
export function selectPilotEntriesForKind(
  store: OnboardingStore,
  kind: OnboardingKitLotKind,
  recipients: string[],
): OnboardingEntry[] {
  const allow = new Set(recipients.map(normEmail));
  const lots = Object.values(store.kit_transport?.lots ?? {});
  return Object.values(store.entries).filter(
    (e) => allow.has(normEmail(e.email)) && hasConfirmedKitLotForEntry(lots, kind, e.subscription_id) == null,
  );
}

/** Camada 3: destinatários do lote ⊆ allowlist, e lote não-vazio. */
export function assertLotRecipientsInAllowlist(lotEmails: string[], recipients: string[]): void {
  if (lotEmails.length === 0) throw new Error("[onboarding-kit-pilot] lote do piloto sem destinatários — abortando.");
  const allow = new Set(recipients.map(normEmail));
  const outside = lotEmails.filter((e) => !allow.has(normEmail(e)));
  if (outside.length > 0) {
    throw new Error(
      `[onboarding-kit-pilot] ${outside.length} destinatário(s) do lote fora de --pilot-recipients — abortando antes de qualquer escrita no Kit.`,
    );
  }
}

export type PilotTagCheck =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: string };

/** Camada 4 (pura): membros RELIDOS da tag × destinatários do lote.
 *  `retryable` só quando faltam membros e nenhum é estranho — o
 *  `GET /tags/{id}/subscribers` tem atraso de propagação medido de até 180s
 *  logo após `tagSubscriber` (ver `listTagSubscribersPage`). Membro a mais ou
 *  fora da allowlist nunca é retentável. */
export function checkPilotTagMembers(
  tagName: string,
  memberEmails: string[],
  lotEmails: string[],
  recipients: string[],
): PilotTagCheck {
  const allow = new Set(recipients.map(normEmail));
  const expected = new Set(lotEmails.map(normEmail));
  const members = memberEmails.map(normEmail);
  const strangers = members.filter((m) => !expected.has(m) || !allow.has(m));
  if (strangers.length > 0) {
    return {
      ok: false,
      retryable: false,
      reason: `tag "${tagName}" tem ${strangers.length} membro(s) fora do lote/allowlist (${members.length} no total, esperado ${expected.size}).`,
    };
  }
  if (members.length > expected.size) {
    return { ok: false, retryable: false, reason: `tag "${tagName}" tem ${members.length} membros, esperado exatamente ${expected.size}.` };
  }
  if (members.length === 0) {
    return { ok: false, retryable: true, reason: `tag "${tagName}" está VAZIA na releitura (esperado ${expected.size}) — risco #6126.` };
  }
  if (new Set(members).size !== expected.size) {
    return { ok: false, retryable: true, reason: `tag "${tagName}" tem ${new Set(members).size} de ${expected.size} membros esperados.` };
  }
  return { ok: true };
}

export type PilotFilterVerification = { verified: true } | { verified: false; reason: string } | { verified: null; reason: string };

/** Camada 5 (pura): `subscriber_filter` relido × filtro da tag do lote. */
export function verifyPilotBroadcastFilter(rereadFilter: unknown, expected: KitSubscriberFilter): PilotFilterVerification {
  if (rereadFilter === undefined) {
    return { verified: null, reason: "a releitura do broadcast não trouxe 'subscriber_filter' — audiência NÃO confirmada." };
  }
  if (JSON.stringify(rereadFilter) === JSON.stringify(expected)) return { verified: true };
  return {
    verified: false,
    reason: `subscriber_filter relido DIVERGENTE: esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(rereadFilter)}.`,
  };
}

/** Rede injetada — em produção, as funções de `kit-broadcasts.ts`/`kit-client.ts`. */
export interface PilotKitDeps {
  findTagIdByName(name: string): Promise<number | null>;
  createTag(name: string): Promise<{ id: number }>;
  tagSubscriber(tagId: number, subscriberId: number): Promise<void>;
  listTagMemberEmails(tagId: number): Promise<string[]>;
  createBroadcast(input: CreateBroadcastInput): Promise<{ id: number; status: string; send_at: string | null }>;
  getBroadcast(id: number): Promise<{ status?: string; subscriber_filter?: unknown }>;
  updateBroadcast(id: number, patch: { send_at: string }): Promise<{ status: string; send_at?: string | null }>;
  deleteBroadcast(id: number): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface PilotLotOptions {
  recipients: string[];
  /** subscription_id → kit_subscriber_id dos destinatários do lote. */
  kitIdBySubscription: Record<string, number | undefined>;
  subject: string;
  content: string;
  previewText?: string;
  /** ISO de agendamento para email1/email2 (ignorado no email3, sempre rascunho). */
  sendAt: string;
  allowUnechoedFilter: boolean;
  /** Releituras da tag enquanto faltarem membros (propagação). */
  tagCheckAttempts?: number;
  tagCheckDelayMs?: number;
}

/** Releitura da tag com retry só pra falta de membros (propagação). Lança
 *  quando não fecha. */
export async function assertPilotTagAudience(
  deps: Pick<PilotKitDeps, "findTagIdByName" | "listTagMemberEmails" | "sleep">,
  lot: Pick<OnboardingKitLot, "tag_name" | "tag_id" | "recipient_emails">,
  recipients: string[],
  attempts = 8,
  delayMs = 30_000,
): Promise<void> {
  const resolvedId = await deps.findTagIdByName(lot.tag_name);
  if (resolvedId == null || resolvedId !== lot.tag_id) {
    throw new Error(
      `[onboarding-kit-pilot] tag "${lot.tag_name}" não resolve no Kit para o id do lote (${resolvedId} ≠ ${lot.tag_id}) — abortando (risco #6126).`,
    );
  }
  let last: PilotTagCheck = { ok: false, retryable: true, reason: "não checado" };
  for (let i = 0; i < Math.max(1, attempts); i++) {
    if (i > 0) await deps.sleep(delayMs);
    const members = await deps.listTagMemberEmails(resolvedId);
    last = checkPilotTagMembers(lot.tag_name, members, lot.recipient_emails, recipients);
    if (last.ok || !last.retryable) break;
  }
  if (!last.ok) throw new Error(`[onboarding-kit-pilot] guard de audiência: ${last.reason} Abortando.`);
}

export interface PilotLotResult {
  broadcast_id: number;
  status: "created" | "scheduled";
  send_at: string | null;
  filter_verified: boolean | null;
}

/**
 * Executa UM lote do piloto, já reivindicado (`lot` com `lot_id`/`tag_name`/
 * destinatários). Muta `lot.tag_id`/`lot.broadcast_id` à medida que os
 * efeitos externos acontecem — o caller persiste `lot` mesmo quando isto
 * lança, pra nunca perder o registro de um broadcast já criado.
 *
 * Ordem: allowlist → tag não pode pré-existir → cria tag → tageia →
 * releitura da tag (camada 4) → cria broadcast RASCUNHO → releitura do
 * filtro (camada 5) → (email1/2) agenda.
 */
export async function runPilotLot(deps: PilotKitDeps, lot: OnboardingKitLot, opts: PilotLotOptions): Promise<PilotLotResult> {
  assertLotRecipientsInAllowlist(lot.recipient_emails, opts.recipients);
  if (!lot.tag_name.startsWith(PILOT_TAG_PREFIX)) {
    throw new Error(`[onboarding-kit-pilot] tag "${lot.tag_name}" sem o prefixo "${PILOT_TAG_PREFIX}" — abortando.`);
  }

  if (lot.tag_id == null) {
    const preexisting = await deps.findTagIdByName(lot.tag_name);
    if (preexisting != null) {
      throw new Error(
        `[onboarding-kit-pilot] tag "${lot.tag_name}" já existe no Kit (id ${preexisting}) — o piloto só usa tag recém-criada ` +
          "(uma tag pré-existente pode ter membros). Cancele/limpe e rode de novo.",
      );
    }
    lot.tag_id = (await deps.createTag(lot.tag_name)).id;
  }
  const tagId = lot.tag_id;

  const missingKitId = lot.recipient_subscription_ids.filter((subId) => opts.kitIdBySubscription[subId] == null);
  if (missingKitId.length > 0) {
    // Sem PII na mensagem — ela vai pro summary que o editor cola na issue.
    throw new Error(`[onboarding-kit-pilot] ${missingKitId.length} destinatário(s) sem kit_subscriber_id — abortando.`);
  }
  for (const subId of lot.recipient_subscription_ids) {
    await deps.tagSubscriber(tagId, opts.kitIdBySubscription[subId] as number);
  }

  await assertPilotTagAudience(deps, lot, opts.recipients, opts.tagCheckAttempts, opts.tagCheckDelayMs);

  // Rascunho SEMPRE (sendAt null) — agendar só depois da releitura do filtro.
  const input = buildOnboardingBroadcastInput({
    kind: lot.kind,
    subject: opts.subject,
    content: opts.content,
    previewText: opts.previewText,
    tagId,
    sendAt: null,
  });
  if (input.send_at != null) throw new Error("[onboarding-kit-pilot] invariante: broadcast do piloto precisa nascer rascunho.");
  const created = await deps.createBroadcast(input);
  lot.broadcast_id = created.id;
  lot.status = "created";
  lot.send_at = null;

  let verification: PilotFilterVerification;
  try {
    const reread = await deps.getBroadcast(created.id);
    verification = verifyPilotBroadcastFilter(reread.subscriber_filter, buildOnboardingLotFilter(tagId));
  } catch (e) {
    verification = { verified: null, reason: `a releitura do broadcast falhou (${(e as Error).message}).` };
  }

  if (verification.verified === false) {
    // Rascunho com audiência errada: apaga (rascunho = reversível) e aborta.
    try {
      await deps.deleteBroadcast(created.id);
      lot.status = "cancelled";
    } catch (e) {
      throw new Error(
        `[onboarding-kit-pilot] ${verification.reason} E o rascunho ${created.id} NÃO pôde ser apagado (${(e as Error).message}) — apague no painel do Kit.`,
      );
    }
    throw new Error(`[onboarding-kit-pilot] ${verification.reason} Rascunho ${created.id} apagado; nada foi agendado.`);
  }
  if (verification.verified === null && !opts.allowUnechoedFilter) {
    throw new Error(
      `[onboarding-kit-pilot] ${verification.reason} Rascunho ${created.id} mantido SEM agendar. Confira a audiência no painel ` +
        `do Kit e, se ok, agende à mão — ou --cancel-lot ${lot.lot_id} e re-rode --send com --pilot-allow-unechoed-filter ` +
        "(o lote rascunho conta como confirmado e não é replanejado sem o cancelamento).",
    );
  }

  if (lot.kind === "email3") {
    return { broadcast_id: created.id, status: "created", send_at: null, filter_verified: verification.verified };
  }

  const updated = await deps.updateBroadcast(created.id, { send_at: opts.sendAt });
  lot.status = updated.status === "scheduled" ? "scheduled" : "created";
  lot.send_at = updated.status === "scheduled" ? (updated.send_at ?? opts.sendAt) : null;
  return { broadcast_id: created.id, status: lot.status, send_at: lot.send_at, filter_verified: verification.verified };
}

/** Guard do `--approve-email3-lot` no piloto: repete as camadas 3 e 4 sobre o
 *  lote já criado, e a 5 sobre o broadcast, antes de agendar. */
export async function assertPilotEmail3Approvable(
  deps: Pick<PilotKitDeps, "findTagIdByName" | "listTagMemberEmails" | "getBroadcast" | "sleep">,
  lot: OnboardingKitLot,
  recipients: string[],
  allowUnechoedFilter: boolean,
): Promise<void> {
  assertLotRecipientsInAllowlist(lot.recipient_emails, recipients);
  if (lot.tag_id == null || lot.broadcast_id == null) {
    throw new Error(`[onboarding-kit-pilot] lote "${lot.lot_id}" sem tag/broadcast — nada a aprovar.`);
  }
  await assertPilotTagAudience(deps, lot, recipients, 1, 0);
  const reread = await deps.getBroadcast(lot.broadcast_id);
  const v = verifyPilotBroadcastFilter(reread.subscriber_filter, buildOnboardingLotFilter(lot.tag_id));
  if (v.verified === false || (v.verified === null && !allowUnechoedFilter)) {
    throw new Error(`[onboarding-kit-pilot] ${v.reason} Não agendando o e-mail 3.`);
  }
}

/** Nome da tag de um lote do piloto. */
export function buildPilotLotTagName(lotId: string): string {
  return `${PILOT_TAG_PREFIX}${lotId}`;
}
