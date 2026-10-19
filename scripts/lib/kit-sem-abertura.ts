/**
 * scripts/lib/kit-sem-abertura.ts (#10437)
 *
 * Miolo PURO da movimentação Kit → Brevo de quem recebeu 6 edições da diária
 * no Kit sem abrir nenhuma (e sem clicar). O I/O (Kit, Brevo, store) fica em
 * `scripts/sync-kit-sem-abertura-to-brevo.ts`; aqui só decisão testável.
 *
 * ## Critério (corpo da issue + decisões do editor de 19/10/2026)
 *
 * Entra quem está `active` no Kit E tem >= 6 envios MADUROS (>= 48h, mesma
 * janela do Passo 2b de `evaluate-brevo-diaria.ts`) de broadcasts da DIÁRIA E
 * 0 aberturas E 0 cliques nesses broadcasts.
 *
 * - **Escopo nos broadcasts da diária (armadilha 1).** Abertura sem escopo
 *   conta o e-mail de confirmação (DOI) e o de boas-vindas — todo cadastro
 *   novo "abriu" algo, e o critério nunca dispararia pra ele. Envios,
 *   aberturas e cliques vêm só dos broadcasts do registro abaixo.
 * - **Registro determinístico, nunca regex de subject (armadilha 2).** A lista
 *   de broadcasts é o `broadcast_id` que o publish do Kit grava por edição
 *   (`_internal/newsletter-kit-published.json`, backend principal desde
 *   #7388, e `_internal/kit-diaria-published.json`, canal paralelo anterior),
 *   só com `status: "scheduled"` e `scheduled_at` legível — é o que de fato
 *   foi pro ar. Broadcasts de teste (`[teste]`) nunca são gravados ali.
 * - **Clique sem abertura é leitor (armadilha 3).** 0 cliques é exigido.
 * - **Abertura/clique em envio ainda não maduro também exclui.** A maturação
 *   só vale pra CONTAR envios (dar tempo de a abertura chegar); engajamento
 *   em qualquer broadcast da diária, maduro ou não, prova que a pessoa lê.
 *
 * Exclusões: apoiadores (custom field `apoio_nivel` preenchido ou tag
 * `apoio-*` — tirar do Kit cortaria também a Retrospectiva, #7660),
 * `EDITOR_SEED_EMAILS`, fixtures (`kit-fixture-patterns.ts`), tag
 * `diaria-test-email`, quem já tem a tag `envio-brevo` e quem já passou pelo
 * store da Brevo em qualquer status (armadilha 6: abertura na Brevo não chega
 * ao Kit, então quem voltou por promoção seguiria com 0 aberturas lá e seria
 * movido de novo na rodada seguinte).
 */
import { normalizeEmail } from "./brevo-diaria-store.ts";
import { matchFixtureEmail } from "./kit-fixture-patterns.ts";
import { checkAccountSendQuota } from "./brevo-account-quota.ts";
import { BREVO_DIARIA_MATURATION_HOURS } from "./shared/brevo-diaria-score.ts";
import { KIT_TEST_SEND_TAG_NAME } from "./kit-broadcasts.ts";
import { KIT_ENVIO_BREVO_TAG_NAME } from "./kit-diaria-audience.ts";
import { KIT_APOIO_NIVEL_FIELD_KEY } from "./apoio-segments-canonical-kit.ts";

/** Piso de envios maduros da diária sem abertura (pedido do editor, 18/10/2026). */
export const KIT_SEM_ABERTURA_MIN_MATURE_SENDS = 6;

/** Default da janela que define "cadastro novo" (entra sempre, fora da onda). */
export const KIT_SEM_ABERTURA_NEW_SIGNUP_WINDOW_DAYS = 30;

/** Valor do atributo de origem gravado no contato Brevo (intro condicional). */
export const BREVO_ORIGEM_ATTRIBUTE = "ORIGEM_DIARIA";
export const BREVO_ORIGEM_KIT_SEM_ABERTURA = "kit_sem_abertura";

/** Fatia de `platform.config.json` → `brevo_diaria.kit_sem_abertura`. */
export interface KitSemAberturaConfig {
  /** Flag da seleção + movimentação. Ausente ⇒ desligada. */
  enabled?: boolean;
  min_mature_sends?: number;
  new_signup_window_days?: number;
}

export function isKitSemAberturaEnabled(cfg: KitSemAberturaConfig | undefined): boolean {
  return cfg?.enabled === true;
}

// ── registro de broadcasts da diária ─────────────────────────────────────

export interface DiariaBroadcastRecord {
  broadcastId: number;
  /** ISO do envio (o `scheduled_at` confirmado por releitura na Etapa 6). */
  sentAt: string;
  edition: string;
}

/**
 * Pura — extrai o registro de UM arquivo de estado do publish do Kit. Só vale
 * o que foi agendado de verdade (`status: "scheduled"` + `scheduled_at`
 * legível); draft/test_sent nunca saíram pra base.
 */
export function parseDiariaBroadcastState(raw: unknown, edition: string): DiariaBroadcastRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as { broadcast_id?: unknown; status?: unknown; scheduled_at?: unknown };
  if (typeof s.broadcast_id !== "number" || !Number.isInteger(s.broadcast_id) || s.broadcast_id <= 0) return null;
  if (s.status !== "scheduled") return null;
  if (typeof s.scheduled_at !== "string" || !Number.isFinite(Date.parse(s.scheduled_at))) return null;
  return { broadcastId: s.broadcast_id, sentAt: s.scheduled_at, edition };
}

/** Pura — dedup por id (a mesma edição pode ter os dois arquivos), ordem por envio. */
export function dedupeBroadcastRecords(records: readonly DiariaBroadcastRecord[]): DiariaBroadcastRecord[] {
  const byId = new Map<number, DiariaBroadcastRecord>();
  for (const r of records) if (!byId.has(r.broadcastId)) byId.set(r.broadcastId, r);
  return [...byId.values()].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
}

/**
 * Pura — separa o que já saiu (`sentAt <= now`) do que já maturou
 * (`sentAt <= now - 48h`). Broadcast agendado pro futuro não entra em nenhum.
 */
export function classifyDiariaBroadcasts(
  records: readonly DiariaBroadcastRecord[],
  nowMs: number,
  maturationHours: number = BREVO_DIARIA_MATURATION_HOURS,
): { sentIds: number[]; matureIds: number[] } {
  const maturationMs = maturationHours * 60 * 60 * 1000;
  const sentIds: number[] = [];
  const matureIds: number[] = [];
  for (const r of records) {
    const t = Date.parse(r.sentAt);
    if (!Number.isFinite(t) || t > nowMs) continue;
    sentIds.push(r.broadcastId);
    if (nowMs - t >= maturationMs) matureIds.push(r.broadcastId);
  }
  return { sentIds, matureIds };
}

// ── engajamento por assinante ────────────────────────────────────────────

/** Quem foi enviado/abriu/clicou num broadcast (`POST /v4/subscribers/filter`). */
export interface BroadcastEngagement {
  broadcastId: number;
  sent: readonly string[];
  opens: readonly string[];
  clicks: readonly string[];
}

export interface SubscriberEngagement {
  matureSends: number;
  opens: number;
  clicks: number;
}

/**
 * Pura — agrega por e-mail. `matureSends` conta só os broadcasts maduros;
 * aberturas e cliques contam em TODOS os broadcasts passados (ver docstring
 * do módulo). Cada broadcast conta no máximo 1 por eixo por pessoa.
 */
export function buildEngagementIndex(
  perBroadcast: readonly BroadcastEngagement[],
  matureIds: ReadonlySet<number>,
): Map<string, SubscriberEngagement> {
  const index = new Map<string, SubscriberEngagement>();
  const get = (email: string): SubscriberEngagement => {
    const key = normalizeEmail(email);
    let e = index.get(key);
    if (!e) {
      e = { matureSends: 0, opens: 0, clicks: 0 };
      index.set(key, e);
    }
    return e;
  };
  for (const b of perBroadcast) {
    if (matureIds.has(b.broadcastId)) for (const email of new Set(b.sent.map(normalizeEmail))) get(email).matureSends++;
    for (const email of new Set(b.opens.map(normalizeEmail))) get(email).opens++;
    for (const email of new Set(b.clicks.map(normalizeEmail))) get(email).clicks++;
  }
  return index;
}

// ── seleção ──────────────────────────────────────────────────────────────

export interface KitActiveCandidate {
  id: number;
  email: string;
  created_at: string;
  fields?: Record<string, string | null | undefined>;
  tagNames: readonly string[];
}

export type KitSemAberturaExclusion =
  | "apoiador"
  | "editor_seed"
  | "fixture"
  | "tag_teste"
  | "ja_tem_tag_envio_brevo"
  | "ja_passou_pelo_store"
  | "envios_insuficientes"
  | "abriu"
  | "clicou";

export interface KitSemAberturaSelected extends KitActiveCandidate {
  matureSends: number;
}

export interface KitSemAberturaSelection {
  selected: KitSemAberturaSelected[];
  excluded: Record<KitSemAberturaExclusion, number>;
}

/** Pura — razão de exclusão de UM candidato, ou `null` se ele entra. */
export function classifyKitSemAberturaCandidate(
  c: KitActiveCandidate,
  ctx: {
    engagement: ReadonlyMap<string, SubscriberEngagement>;
    storeEmails: ReadonlySet<string>;
    seedEmails: ReadonlySet<string>;
    minMatureSends: number;
  },
): KitSemAberturaExclusion | null {
  const email = normalizeEmail(c.email);
  const nivel = c.fields?.[KIT_APOIO_NIVEL_FIELD_KEY];
  if ((typeof nivel === "string" && nivel.trim() !== "") || c.tagNames.some((t) => t.toLowerCase().startsWith("apoio-"))) {
    return "apoiador";
  }
  if (ctx.seedEmails.has(email)) return "editor_seed";
  if (matchFixtureEmail(email) !== null) return "fixture";
  if (c.tagNames.includes(KIT_TEST_SEND_TAG_NAME)) return "tag_teste";
  if (c.tagNames.includes(KIT_ENVIO_BREVO_TAG_NAME)) return "ja_tem_tag_envio_brevo";
  if (ctx.storeEmails.has(email)) return "ja_passou_pelo_store";
  const e = ctx.engagement.get(email) ?? { matureSends: 0, opens: 0, clicks: 0 };
  if (e.opens > 0) return "abriu";
  if (e.clicks > 0) return "clicou";
  if (e.matureSends < ctx.minMatureSends) return "envios_insuficientes";
  return null;
}

export function selectKitSemAbertura(params: {
  subscribers: readonly KitActiveCandidate[];
  engagement: ReadonlyMap<string, SubscriberEngagement>;
  storeEmails: Iterable<string>;
  seedEmails: Iterable<string>;
  minMatureSends?: number;
}): KitSemAberturaSelection {
  const ctx = {
    engagement: params.engagement,
    storeEmails: new Set([...params.storeEmails].map(normalizeEmail)),
    seedEmails: new Set([...params.seedEmails].map(normalizeEmail)),
    minMatureSends: params.minMatureSends ?? KIT_SEM_ABERTURA_MIN_MATURE_SENDS,
  };
  const excluded: Record<KitSemAberturaExclusion, number> = {
    apoiador: 0,
    editor_seed: 0,
    fixture: 0,
    tag_teste: 0,
    ja_tem_tag_envio_brevo: 0,
    ja_passou_pelo_store: 0,
    envios_insuficientes: 0,
    abriu: 0,
    clicou: 0,
  };
  const selected: KitSemAberturaSelected[] = [];
  const seen = new Set<string>();
  for (const c of params.subscribers) {
    const email = normalizeEmail(c.email);
    if (seen.has(email)) continue;
    seen.add(email);
    const reason = classifyKitSemAberturaCandidate(c, ctx);
    if (reason) {
      excluded[reason]++;
      continue;
    }
    selected.push({ ...c, email, matureSends: ctx.engagement.get(email)!.matureSends });
  }
  return { selected, excluded };
}

// ── onda (backlog limitado pela cota; cadastros novos sempre entram) ─────

/**
 * Pura — quantos contatos do BACKLOG cabem nesta rodada. Dois tetos, vale o
 * menor: a fila da Brevo (`daily_send_cap` menos quem já está `in_brevo`) e a
 * cota da CONTA (`checkAccountSendQuota`, balde único de 300/dia com o
 * transacional, #6146). Os cadastros novos desta rodada ocupam espaço antes.
 * Cota ilegível ⇒ 0 (nunca vira permissão de envio).
 */
export function computeBacklogSlots(params: {
  queueCap: number;
  currentActiveCount: number;
  seedCount: number;
  newCount: number;
  dailyLimit: number;
  /** `null` = consumo transacional não lido (falha de rede) ⇒ backlog 0. */
  transactionalToday: number | null;
}): number {
  const queueSlots = Math.max(0, params.queueCap - params.currentActiveCount - params.newCount);
  if (params.transactionalToday === null) return 0;
  const base = params.currentActiveCount + params.seedCount + params.newCount;
  const probe = checkAccountSendQuota({
    dailyLimit: params.dailyLimit,
    transactionalRequestsOnSendDay: params.transactionalToday,
    recipients: base,
  });
  if (!probe.ok) return 0;
  const quotaSlots = Math.max(0, probe.available - base);
  if (quotaSlots > 0) {
    const confirm = checkAccountSendQuota({
      dailyLimit: params.dailyLimit,
      transactionalRequestsOnSendDay: params.transactionalToday,
      recipients: base + quotaSlots,
    });
    if (!confirm.ok) return 0;
  }
  return Math.min(queueSlots, quotaSlots);
}

export interface KitSemAberturaWave {
  /** Ordem de execução: cadastros novos primeiro, depois o backlog mais antigo. */
  toMove: (KitSemAberturaSelected & { wave: "novo" | "backlog" })[];
  newCount: number;
  backlogCount: number;
  deferred: number;
}

/** Pura — "novo" = cadastrado no Kit há no máximo `newSignupWindowDays` dias. */
export function isNewSignup(createdAt: string, nowMs: number, newSignupWindowDays: number): boolean {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && nowMs - t <= newSignupWindowDays * 24 * 60 * 60 * 1000;
}

/**
 * Pura — monta a onda. Circuit breaker da Brevo pausado (`rolloutPaused`)
 * zera TUDO, inclusive cadastros novos: a pausa existe por entregabilidade
 * (bounce/spam acima do limiar) e vale pra qualquer contato a mais.
 */
export function planKitSemAberturaWave(params: {
  selected: readonly KitSemAberturaSelected[];
  nowMs: number;
  newSignupWindowDays: number;
  backlogSlots: (newCount: number) => number;
  rolloutPaused: boolean;
}): KitSemAberturaWave {
  if (params.rolloutPaused) {
    return { toMove: [], newCount: 0, backlogCount: 0, deferred: params.selected.length };
  }
  const novos = params.selected.filter((s) => isNewSignup(s.created_at, params.nowMs, params.newSignupWindowDays));
  const backlog = params.selected
    .filter((s) => !isNewSignup(s.created_at, params.nowMs, params.newSignupWindowDays))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const slots = Math.max(0, params.backlogSlots(novos.length));
  const backlogNow = backlog.slice(0, slots);
  return {
    toMove: [
      ...novos.map((s) => ({ ...s, wave: "novo" as const })),
      ...backlogNow.map((s) => ({ ...s, wave: "backlog" as const })),
    ],
    newCount: novos.length,
    backlogCount: backlogNow.length,
    deferred: backlog.length - backlogNow.length,
  };
}

// ── log append-only ──────────────────────────────────────────────────────

export interface KitSemAberturaLogEntry {
  ts: string;
  email: string;
  kit_subscriber_id: number;
  origin: string;
  wave: "novo" | "backlog";
  mature_sends: number;
  brevo_list_id: number;
  kit_tag: string;
}

/** Pura — uma linha do log (`data/brevo-diaria/kit-sem-abertura-log.jsonl`). */
export function formatKitSemAberturaLogLine(entry: KitSemAberturaLogEntry): string {
  return JSON.stringify(entry) + "\n";
}
