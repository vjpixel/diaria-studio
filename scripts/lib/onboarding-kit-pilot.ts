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
 *      escreve o store real — exige `--store` apontando pra outro arquivo,
 *      comparado por `realpathSync.native` (`data/` é junction OneDrive, um
 *      caminho textual diferente pode ser o mesmo arquivo). É ISSO que
 *      permite ignorar o kill switch de produção só no piloto.
 *   2. **Store só do piloto** (`seedPilotStore`): recusa um store isolado
 *      que já contenha entry de e-mail fora da allowlist (cópia do real).
 *   3. **Allowlist por lote** (`assertLotRecipientsInAllowlist`): os
 *      destinatários de cada lote têm de ser subconjunto de
 *      `--pilot-recipients`, senão aborta antes de qualquer escrita no Kit.
 *   4. **Tag com exatamente os destinatários** (`assertPilotTagAudience`):
 *      tag `onboarding-pilot-{lot_id}`; num lote novo ela não pode existir
 *      antes (pode ter membros); o id usado é o devolvido pelo `createTag`
 *      DESTA execução, e a busca por nome (que leva ~90s pra enxergar tag
 *      nova, armadilha 3 de `kit-client.ts`) só confirma — dentro do mesmo
 *      loop de retry da listagem de membros (~180s de atraso, armadilha 5).
 *      Vazia/maior/estranha/id divergente aborta. Risco #6126:
 *      `subscriber_filter` que o Kit não resolve = base INTEIRA.
 *   5. **Releitura do broadcast** (`rereadPilotFilter`): o broadcast nasce
 *      SEMPRE rascunho, é relido antes de agendar, e o PATCH que agenda
 *      REENVIA o `subscriber_filter` junto com `send_at` (PATCH no Kit pode
 *      zerar campo omitido, armadilha 4 / #8208) e é relido DE NOVO depois.
 *      Divergente (em qualquer releitura) → apaga o broadcast e aborta.
 *      Leitura que FALHA (`read_failed`) nunca agenda, com ou sem flag.
 *      Campo não ecoado (`not_echoed`) só agenda com
 *      `--pilot-allow-unechoed-filter`, e com aviso — o eco de
 *      `subscriber_filter` por `GET /broadcasts/{id}` nunca foi confirmado
 *      ao vivo.
 *
 * Cadência: no piloto os 3 kinds (email1/email2/email3) são planejados no
 * MESMO dia, ignorando D+3/D+10 e as regras de abertura do e-mail 3 — o
 * objetivo é validar segmentação/entrega/renderização dos 3 conteúdos, não
 * a régua. E-mail 3 continua nascendo rascunho e só agenda via
 * `--approve-email3-lot --send-at` (`approvePilotEmail3Lot`, que repete as
 * camadas 3-5).
 *
 * Tudo aqui é puro ou recebe a rede INJETADA (`PilotKitDeps`) — testável
 * sem `fetch` real (`test/onboarding-kit-pilot-7922.test.ts`).
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { CreateBroadcastInput, KitSubscriberFilter } from "./kit-broadcasts.ts";
import type { OnboardingEntry, OnboardingStore } from "./onboarding-store.ts";
import {
  buildOnboardingBroadcastInput,
  buildOnboardingLotFilter,
  hasConfirmedKitLotForEntry,
  type OnboardingKitLot,
  type OnboardingKitLotKind,
} from "./onboarding-kit-transport.ts";

/** Teto de destinatários do piloto — "lista curta e nomeada" (doc, seção 4). */
export const PILOT_MAX_RECIPIENTS = 5;

/** Prefixo das tags de lote do piloto — nunca colide com a tag de um lote de
 *  produção do mesmo dia (`onboarding-{lot_id}`). */
export const PILOT_TAG_PREFIX = "onboarding-pilot-";

/** Prefixo do `subscription_id` sintético das entries semeadas. */
export const PILOT_SUBSCRIPTION_PREFIX = "pilot:";

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const EMAIL_ANYWHERE_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

/** Remove e-mails de uma string — o summary vai pra issue, e um
 *  `KitApiError` carrega o body da API, que pode ecoar e-mail. */
export function redactEmails(s: string): string {
  return s.replace(EMAIL_ANYWHERE_RE, "<email>");
}

/** Nome da tag de um lote do piloto. */
export function buildPilotLotTagName(lotId: string): string {
  return `${PILOT_TAG_PREFIX}${lotId}`;
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
    if (!EMAIL_RE.test(e)) throw new Error("[onboarding-kit-pilot] destinatário de piloto malformado em --pilot-recipients.");
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

/** Caminho canônico: `realpathSync.native` do arquivo (ou do diretório pai,
 *  se o arquivo ainda não existe) — resolve junction/symlink (`data/` é
 *  junction OneDrive). Case-insensitive no Windows. */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  let canon = abs;
  try {
    if (existsSync(abs)) canon = realpathSync.native(abs);
    else if (existsSync(dirname(abs))) canon = join(realpathSync.native(dirname(abs)), basename(abs));
  } catch {
    canon = abs;
  }
  return process.platform === "win32" ? canon.toLowerCase() : canon;
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
  const canon = canonicalPath(abs);
  for (const real of realStorePaths) {
    if (canon === canonicalPath(real)) {
      throw new Error(
        `[onboarding-kit-pilot] --store "${storePath}" é o store REAL do onboarding — recusado. ` +
          "Aponte para um arquivo isolado (ex: um JSON fora de data/onboarding/).",
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

/** Lote é do piloto: tag com o prefixo do piloto. */
export function assertPilotLotPrefix(lot: Pick<OnboardingKitLot, "lot_id" | "tag_name">): void {
  if (!lot.tag_name.startsWith(PILOT_TAG_PREFIX)) {
    throw new Error(
      `[onboarding-kit-pilot] lote "${lot.lot_id}" tem tag "${lot.tag_name}" sem o prefixo "${PILOT_TAG_PREFIX}" — não é lote do piloto, recusado.`,
    );
  }
}

/** Guard do `--pilot --cancel-lot`: só lote do piloto, só destinatários da allowlist. */
export function assertPilotCancelable(lot: OnboardingKitLot, recipients: string[]): void {
  assertPilotLotPrefix(lot);
  assertLotRecipientsInAllowlist(lot.recipient_emails, recipients);
}

export type PilotTagCheck = { ok: true } | { ok: false; retryable: boolean; reason: string };

/** Camada 4 (pura): membros RELIDOS da tag × destinatários do lote.
 *  `retryable` só quando faltam membros e nenhum é estranho (atraso de
 *  propagação). Membro a mais ou fora da allowlist nunca é retentável. */
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

export type PilotFilterVerification =
  | { status: "verified"; echoed: unknown }
  | { status: "divergent"; reason: string; echoed: unknown }
  | { status: "not_echoed"; reason: string }
  | { status: "read_failed"; reason: string };

/** Extrai os ids de tag de um `subscriber_filter` ecoado — `null` se o shape
 *  tiver qualquer coisa além de condições `tag` em grupos `all` (grupos
 *  `any`/`none` só são tolerados vazios). */
function extractTagIds(filter: unknown): number[] | null {
  if (!Array.isArray(filter)) return null;
  const ids: number[] = [];
  for (const group of filter) {
    if (group == null || typeof group !== "object") return null;
    for (const [key, val] of Object.entries(group as Record<string, unknown>)) {
      if (key !== "all") {
        if (Array.isArray(val) && val.length === 0) continue;
        return null;
      }
      if (!Array.isArray(val)) return null;
      for (const cond of val) {
        if (cond == null || typeof cond !== "object") return null;
        const c = cond as { type?: unknown; ids?: unknown };
        if (c.type !== "tag" || !Array.isArray(c.ids)) return null;
        for (const id of c.ids) {
          const n = typeof id === "string" ? Number(id) : id;
          if (typeof n !== "number" || !Number.isInteger(n)) return null;
          ids.push(n);
        }
      }
    }
  }
  return ids;
}

/** Camada 5 (pura): `subscriber_filter` relido × filtro da tag do lote,
 *  comparado ESTRUTURALMENTE (conjunto de ids de tag), não por
 *  `JSON.stringify` — ordem de chave/tipo do id no eco não deve gerar falso
 *  divergente, e nada além da tag do lote pode estar no filtro. */
export function verifyPilotBroadcastFilter(rereadFilter: unknown, expected: KitSubscriberFilter): PilotFilterVerification {
  if (rereadFilter === undefined) {
    return { status: "not_echoed", reason: "a releitura do broadcast não trouxe 'subscriber_filter' — audiência NÃO confirmada." };
  }
  const want = extractTagIds(expected);
  const got = extractTagIds(rereadFilter);
  const same =
    want != null && got != null && got.length > 0 && new Set(got).size === new Set(want).size && got.every((id) => want.includes(id));
  if (same) return { status: "verified", echoed: rereadFilter };
  return {
    status: "divergent",
    echoed: rereadFilter,
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
  getBroadcast(id: number): Promise<{ status?: string; send_at?: string | null; subscriber_filter?: unknown }>;
  updateBroadcast(
    id: number,
    patch: { send_at: string; subscriber_filter: KitSubscriberFilter },
  ): Promise<{ status: string; send_at?: string | null }>;
  deleteBroadcast(id: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Avisos operacionais (stderr no runner). */
  warn(msg: string): void;
}

/** Relê o broadcast e verifica o filtro — leitura que lança vira
 *  `read_failed` (nunca `not_echoed`: "não consegui ler" ≠ "não ecoou"). */
export async function rereadPilotFilter(
  deps: Pick<PilotKitDeps, "getBroadcast">,
  broadcastId: number,
  tagId: number,
): Promise<{ verification: PilotFilterVerification; reread: { status?: string; send_at?: string | null } | null }> {
  let reread: { status?: string; send_at?: string | null; subscriber_filter?: unknown };
  try {
    reread = await deps.getBroadcast(broadcastId);
  } catch (e) {
    return {
      verification: { status: "read_failed", reason: `a releitura do broadcast ${broadcastId} falhou (${redactEmails((e as Error).message)}).` },
      reread: null,
    };
  }
  return { verification: verifyPilotBroadcastFilter(reread.subscriber_filter, buildOnboardingLotFilter(tagId)), reread };
}

/** Apaga o broadcast (audiência errada/incerta) e LANÇA — com instrução de
 *  apagar no painel se o próprio delete falhar. */
async function deleteAndAbort(
  deps: Pick<PilotKitDeps, "deleteBroadcast">,
  lot: OnboardingKitLot,
  broadcastId: number,
  reason: string,
): Promise<never> {
  try {
    await deps.deleteBroadcast(broadcastId);
    lot.status = "cancelled";
    lot.send_at = null;
  } catch (e) {
    throw new Error(
      `[onboarding-kit-pilot] ${reason} E o broadcast ${broadcastId} NÃO pôde ser apagado (${redactEmails((e as Error).message)}) — ` +
        "APAGUE NO PAINEL DO KIT AGORA, antes que saia.",
    );
  }
  throw new Error(`[onboarding-kit-pilot] ${reason} Broadcast ${broadcastId} apagado; nada foi agendado.`);
}

/** Decide, sobre a releitura PRÉ-agendamento, se pode seguir. Lança (e apaga
 *  quando divergente) senão. */
async function gatePreSchedule(
  deps: Pick<PilotKitDeps, "deleteBroadcast" | "warn">,
  lot: OnboardingKitLot,
  broadcastId: number,
  v: PilotFilterVerification,
  allowUnechoedFilter: boolean,
): Promise<void> {
  if (v.status === "divergent") await deleteAndAbort(deps, lot, broadcastId, v.reason);
  if (v.status === "read_failed") {
    throw new Error(`[onboarding-kit-pilot] ${v.reason} Broadcast ${broadcastId} mantido RASCUNHO — nunca agendo sem ler o filtro.`);
  }
  if (v.status === "not_echoed") {
    if (!allowUnechoedFilter) {
      throw new Error(
        `[onboarding-kit-pilot] ${v.reason} Broadcast ${broadcastId} mantido RASCUNHO sem agendar. Confira a audiência no painel ` +
          `do Kit e, se ok, agende à mão — ou --cancel-lot ${lot.lot_id} e re-rode --send com --pilot-allow-unechoed-filter ` +
          "(o lote rascunho conta como confirmado e não é replanejado sem o cancelamento).",
      );
    }
    deps.warn(`[onboarding-kit-pilot] AVISO: ${v.reason} Seguindo por --pilot-allow-unechoed-filter (lote ${lot.lot_id}).`);
  }
}

export interface PilotScheduleResult {
  status: "scheduled";
  send_at: string;
  verification: PilotFilterVerification;
}

/**
 * Agenda um broadcast do piloto JÁ verificado como rascunho: o PATCH reenvia
 * `subscriber_filter` junto com `send_at` (campo omitido no PATCH pode ser
 * zerado, #8208), `sendAt` é calculado IMEDIATAMENTE antes do PATCH, e o
 * broadcast é relido DEPOIS: filtro divergente ou ilegível → apaga e aborta;
 * status ≠ scheduled → falha (nunca "ok sem nada agendado").
 */
export async function schedulePilotBroadcast(
  deps: PilotKitDeps,
  lot: OnboardingKitLot,
  opts: { tagId: number; sendAtFn: () => string; allowUnechoedFilter: boolean },
): Promise<PilotScheduleResult> {
  const broadcastId = lot.broadcast_id;
  if (broadcastId == null) throw new Error(`[onboarding-kit-pilot] lote "${lot.lot_id}" sem broadcast — nada a agendar.`);
  const filter = buildOnboardingLotFilter(opts.tagId);
  const sendAt = opts.sendAtFn();
  const updated = await deps.updateBroadcast(broadcastId, { send_at: sendAt, subscriber_filter: filter });

  const { verification: post, reread } = await rereadPilotFilter(deps, broadcastId, opts.tagId);
  if (post.status === "divergent") await deleteAndAbort(deps, lot, broadcastId, `após o PATCH: ${post.reason}`);
  if (post.status === "read_failed") {
    await deleteAndAbort(deps, lot, broadcastId, `após o PATCH, ${post.reason} Audiência do broadcast agendado é desconhecida.`);
  }
  if (post.status === "not_echoed") {
    if (!opts.allowUnechoedFilter) await deleteAndAbort(deps, lot, broadcastId, `após o PATCH: ${post.reason}`);
    deps.warn(`[onboarding-kit-pilot] AVISO: após o PATCH, ${post.reason} Agendado por --pilot-allow-unechoed-filter (lote ${lot.lot_id}).`);
  }

  const remoteStatus = reread?.status ?? updated.status;
  if (updated.status !== "scheduled" || remoteStatus !== "scheduled") {
    lot.status = "created";
    lot.send_at = null;
    throw new Error(
      `[onboarding-kit-pilot] PATCH de agendamento do broadcast ${broadcastId} não deixou o broadcast agendado ` +
        `(resposta "${updated.status}", releitura "${reread?.status ?? "?"}") — nada agendado; confira no painel.`,
    );
  }
  lot.status = "scheduled";
  lot.send_at = reread?.send_at ?? updated.send_at ?? sendAt;
  return { status: "scheduled", send_at: lot.send_at, verification: post };
}

export interface PilotLotOptions {
  recipients: string[];
  /** subscription_id → kit_subscriber_id dos destinatários do lote. */
  kitIdBySubscription: Record<string, number | undefined>;
  subject: string;
  content: string;
  previewText?: string;
  /** Calculado imediatamente antes do PATCH (email1/email2; email3 nunca agenda aqui). */
  sendAtFn: () => string;
  allowUnechoedFilter: boolean;
  /** Releituras da tag (propagação ~90s da tag, ~180s dos membros). */
  tagCheckAttempts?: number;
  tagCheckDelayMs?: number;
}

/** Camada 4: confirma que a tag do lote resolve pro id do lote e tem
 *  exatamente os destinatários. Busca por nome e listagem de membros no
 *  MESMO loop de retry (defaults: 8 × 30s = 240s, cobre os ~90s/~180s de
 *  propagação). Nome resolvendo pra OUTRO id ou membro estranho aborta na
 *  hora. Lança quando não fecha. */
export async function assertPilotTagAudience(
  deps: Pick<PilotKitDeps, "findTagIdByName" | "listTagMemberEmails" | "sleep">,
  lot: Pick<OnboardingKitLot, "tag_name" | "tag_id" | "recipient_emails">,
  recipients: string[],
  attempts = 8,
  delayMs = 30_000,
): Promise<void> {
  const tagId = lot.tag_id;
  if (tagId == null) throw new Error(`[onboarding-kit-pilot] lote sem tag_id — abortando (risco #6126).`);
  let lastReason = "não checado";
  for (let i = 0; i < Math.max(1, attempts); i++) {
    if (i > 0) await deps.sleep(delayMs);
    const resolved = await deps.findTagIdByName(lot.tag_name);
    if (resolved != null && resolved !== tagId) {
      throw new Error(
        `[onboarding-kit-pilot] tag "${lot.tag_name}" resolve no Kit pra OUTRO id (${resolved} ≠ ${tagId}) — abortando (risco #6126).`,
      );
    }
    const check = checkPilotTagMembers(lot.tag_name, await deps.listTagMemberEmails(tagId), lot.recipient_emails, recipients);
    if (!check.ok && !check.retryable) throw new Error(`[onboarding-kit-pilot] guard de audiência: ${check.reason} Abortando.`);
    if (check.ok && resolved === tagId) return;
    lastReason = !check.ok ? check.reason : `tag "${lot.tag_name}" ainda não aparece na busca por nome (propagação).`;
  }
  throw new Error(`[onboarding-kit-pilot] guard de audiência: ${lastReason} Abortando.`);
}

export interface PilotLotResult {
  broadcast_id: number;
  status: "created" | "scheduled";
  send_at: string | null;
  filter_verification: PilotFilterVerification["status"];
  /** O que o Kit ecoou de `subscriber_filter` (sem PII — só ids de tag). */
  filter_echoed: unknown;
}

/**
 * Executa UM lote do piloto, já reivindicado. Muta `lot.tag_id`/
 * `lot.broadcast_id`/`lot.status` à medida que os efeitos externos
 * acontecem — o caller persiste `lot` mesmo quando isto lança.
 *
 * Ordem: prefixo + allowlist → (lote novo) tag não pode pré-existir → cria
 * tag → tageia → camada 4 → broadcast RASCUNHO → releitura (camada 5) →
 * (email1/2) PATCH com filtro + releitura de novo.
 */
export async function runPilotLot(deps: PilotKitDeps, lot: OnboardingKitLot, opts: PilotLotOptions): Promise<PilotLotResult> {
  assertPilotLotPrefix(lot);
  assertLotRecipientsInAllowlist(lot.recipient_emails, opts.recipients);

  if (lot.tag_id == null) {
    const preexisting = await deps.findTagIdByName(lot.tag_name);
    if (preexisting != null) {
      throw new Error(
        `[onboarding-kit-pilot] tag "${lot.tag_name}" já existe no Kit (id ${preexisting}) — lote novo do piloto só usa tag ` +
          "recém-criada (uma tag pré-existente pode ter membros).",
      );
    }
    // O id que vale é o devolvido AQUI — a busca por nome leva ~90s pra ver tag nova.
    lot.tag_id = (await deps.createTag(lot.tag_name)).id;
  }
  const tagId = lot.tag_id;

  const missingKitId = lot.recipient_subscription_ids.filter((subId) => opts.kitIdBySubscription[subId] == null);
  if (missingKitId.length > 0) {
    throw new Error(`[onboarding-kit-pilot] ${missingKitId.length} destinatário(s) sem kit_subscriber_id — abortando.`);
  }
  for (const subId of lot.recipient_subscription_ids) {
    await deps.tagSubscriber(tagId, opts.kitIdBySubscription[subId] as number);
  }

  await assertPilotTagAudience(deps, lot, opts.recipients, opts.tagCheckAttempts, opts.tagCheckDelayMs);

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

  const { verification: pre } = await rereadPilotFilter(deps, created.id, tagId);
  await gatePreSchedule(deps, lot, created.id, pre, opts.allowUnechoedFilter);
  const echoedPre = "echoed" in pre ? pre.echoed : undefined;

  if (lot.kind === "email3") {
    return { broadcast_id: created.id, status: "created", send_at: null, filter_verification: pre.status, filter_echoed: echoedPre };
  }

  const sched = await schedulePilotBroadcast(deps, lot, { tagId, sendAtFn: opts.sendAtFn, allowUnechoedFilter: opts.allowUnechoedFilter });
  return {
    broadcast_id: created.id,
    status: "scheduled",
    send_at: sched.send_at,
    filter_verification: sched.verification.status,
    filter_echoed: "echoed" in sched.verification ? sched.verification.echoed : undefined,
  };
}

/** `--pilot --approve-email3-lot`: repete prefixo + allowlist + tag +
 *  releitura do filtro, e agenda pelo mesmo caminho verificado
 *  (`schedulePilotBroadcast`). */
export async function approvePilotEmail3Lot(
  deps: PilotKitDeps,
  lot: OnboardingKitLot,
  opts: { recipients: string[]; sendAtFn: () => string; allowUnechoedFilter: boolean },
): Promise<PilotScheduleResult> {
  assertPilotLotPrefix(lot);
  assertLotRecipientsInAllowlist(lot.recipient_emails, opts.recipients);
  if (lot.kind !== "email3") throw new Error(`[onboarding-kit-pilot] lote "${lot.lot_id}" não é email3.`);
  if (lot.tag_id == null || lot.broadcast_id == null) {
    throw new Error(`[onboarding-kit-pilot] lote "${lot.lot_id}" sem tag/broadcast — nada a aprovar.`);
  }
  await assertPilotTagAudience(deps, lot, opts.recipients, 1, 0);
  const { verification: pre } = await rereadPilotFilter(deps, lot.broadcast_id, lot.tag_id);
  await gatePreSchedule(deps, lot, lot.broadcast_id, pre, opts.allowUnechoedFilter);
  return schedulePilotBroadcast(deps, lot, { tagId: lot.tag_id, sendAtFn: opts.sendAtFn, allowUnechoedFilter: opts.allowUnechoedFilter });
}
