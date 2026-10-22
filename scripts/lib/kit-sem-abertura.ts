/**
 * scripts/lib/kit-sem-abertura.ts (#10437)
 *
 * Miolo PURO da movimentação Kit → Brevo de quem recebeu `min_mature_sends`
 * edições da diária no Kit sem abrir nenhuma (e sem clicar). O I/O (Kit,
 * Brevo, store) fica em `scripts/sync-kit-sem-abertura-to-brevo.ts`; aqui só
 * decisão testável (a exceção é `readKitSemAberturaInBrevoCount`, leitor fino
 * do store usado pelos publishers).
 *
 * ## Critério (corpo da issue + decisões do editor de 19/10/2026)
 *
 * Entra quem está `active` no Kit E tem >= `min_mature_sends` (default
 * `KIT_SEM_ABERTURA_MIN_MATURE_SENDS`) envios ENTREGUES e MADUROS (>= 48h,
 * mesma janela do Passo 2b de `evaluate-brevo-diaria.ts`) de broadcasts da
 * DIÁRIA E 0 aberturas E 0 cliques nesses broadcasts. Entregues, não enviados:
 * o projeto mede e-mail sobre entregues (bounce não é "recebeu e não abriu"),
 * e o `POST /v4/subscribers/filter` do Kit distingue `sent` de `delivered`
 * (`kit-provider-split.ts`, medido ao vivo).
 *
 * - **Escopo nos broadcasts da diária (armadilha 1).** Abertura sem escopo
 *   conta o e-mail de confirmação (DOI) e o de boas-vindas — todo cadastro
 *   novo "abriu" algo, e o critério nunca dispararia pra ele. Entregas,
 *   aberturas e cliques vêm só dos broadcasts do registro abaixo. Um arquivo
 *   do registro ilegível ABORTA a rodada: o broadcast que falta poderia ter
 *   justamente a abertura que tira a pessoa da seleção.
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
 * - **O filtro do Kit indexa com atraso (#10697, medido ao vivo).** No
 *   broadcast segmentado 26499469 (envio 20/10 09:00 UTC), `sent`/`opens`
 *   pelo `/subscribers/filter` voltavam 0 ~17h depois do envio e 954/348 ~22h
 *   depois (stats: 954 destinatários, 362 aberturas). A maturação de 48h
 *   cobre esse atraso. Enquanto o filtro devolve 0 entregues, o broadcast não
 *   soma envio maduro a ninguém, então não faz ninguém parecer "sem abertura".
 *   Para atraso maior que as 48h, inclusive o parcial (entregues indexados,
 *   aberturas não), ver `partitionIndexedEngagement` (#10787).
 *
 * Exclusões: apoiadores (custom field `apoio_nivel` preenchido ou tag
 * `apoio-*` — tirar do Kit cortaria também a Retrospectiva, #7660; o
 * `apoio_nivel` da listagem pode vir defasado, então o sync o confirma pelo
 * GET singular só pros selecionados, antes de mover),
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
import { ORIGIN_PREFIX } from "./shared/brevo-diaria-origin.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

/** Piso de envios maduros da diária sem abertura (pedido do editor, 18/10/2026). */
export const KIT_SEM_ABERTURA_MIN_MATURE_SENDS = 6;

/** Default da janela que define "cadastro novo" (entra antes do backlog). */
export const KIT_SEM_ABERTURA_NEW_SIGNUP_WINDOW_DAYS = 30;

/** Teto de `new_signup_window_days` aceito na config (um ano). */
export const KIT_SEM_ABERTURA_MAX_NEW_SIGNUP_WINDOW_DAYS = 365;

/** NOME do atributo de contato Brevo que carrega a origem (intro condicional)… */
export const BREVO_ORIGEM_ATTRIBUTE = "ORIGEM_DIARIA";
/** …e o VALOR que esse atributo recebe pra quem veio por este fluxo. */
export const BREVO_ORIGEM_KIT_SEM_ABERTURA = "kit_sem_abertura";

/** Log append-only das movimentações e das saídas propagadas pro Kit. */
export const DEFAULT_KIT_SEM_ABERTURA_LOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
  "data/brevo-diaria/kit-sem-abertura-log.jsonl",
);

/** Caminho do store da Brevo diária relativo à raiz do repo (mesmo de `DEFAULT_STORE_PATH`). */
export const BREVO_DIARIA_STORE_RELATIVE_PATH = "data/brevo-diaria/contacts.json";

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

/**
 * Pura — valida os números da config. `min_mature_sends` inteiro >= 1;
 * `new_signup_window_days` inteiro entre 1 e `KIT_SEM_ABERTURA_MAX_NEW_SIGNUP_WINDOW_DAYS`.
 * Ausente ⇒ default. Inválido ⇒ erro (nunca um default silencioso: `0` em
 * `min_mature_sends` moveria todo ativo sem abertura, inclusive quem nunca
 * recebeu nada).
 */
export function parseKitSemAberturaNumbers(
  cfg: KitSemAberturaConfig | undefined,
): { ok: true; minMatureSends: number; newSignupWindowDays: number } | { ok: false; reason: string } {
  const min = cfg?.min_mature_sends ?? KIT_SEM_ABERTURA_MIN_MATURE_SENDS;
  if (typeof min !== "number" || !Number.isInteger(min) || min < 1) {
    return { ok: false, reason: `brevo_diaria.kit_sem_abertura.min_mature_sends precisa ser inteiro >= 1 (veio ${JSON.stringify(min)}).` };
  }
  const win = cfg?.new_signup_window_days ?? KIT_SEM_ABERTURA_NEW_SIGNUP_WINDOW_DAYS;
  if (typeof win !== "number" || !Number.isInteger(win) || win < 1 || win > KIT_SEM_ABERTURA_MAX_NEW_SIGNUP_WINDOW_DAYS) {
    return {
      ok: false,
      reason:
        `brevo_diaria.kit_sem_abertura.new_signup_window_days precisa ser inteiro entre 1 e ` +
        `${KIT_SEM_ABERTURA_MAX_NEW_SIGNUP_WINDOW_DAYS} (veio ${JSON.stringify(win)}).`,
    };
  }
  return { ok: true, minMatureSends: min, newSignupWindowDays: win };
}

/**
 * Pura — quantos contatos `kit-sem-abertura:` estão `in_brevo`, a partir do
 * TEXTO do store (`null` = arquivo ausente ⇒ 0). JSON ilegível: se o texto
 * menciona o prefixo, é erro (não dá pra afirmar que ninguém foi movido); se
 * não menciona, 0 com aviso (o store quebrado não esconde gente movida).
 */
export function countKitSemAberturaInBrevo(raw: string | null): { count: number; warning?: string } | { error: string } {
  if (raw === null || raw.trim() === "") return { count: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    if (raw.includes(ORIGIN_PREFIX.KIT_SEM_ABERTURA)) {
      return { error: `store da Brevo ilegível (${(e as Error).message}) e menciona contatos ${ORIGIN_PREFIX.KIT_SEM_ABERTURA}` };
    }
    return { count: 0, warning: `store da Brevo ilegível (${(e as Error).message}); sem menção a ${ORIGIN_PREFIX.KIT_SEM_ABERTURA}` };
  }
  const contacts = (parsed as { contacts?: unknown })?.contacts;
  if (!Array.isArray(contacts)) return { count: 0 };
  let count = 0;
  for (const c of contacts as { status?: unknown; beehiiv_subscription_id?: unknown }[]) {
    if (c?.status === "in_brevo" && typeof c.beehiiv_subscription_id === "string" && c.beehiiv_subscription_id.startsWith(ORIGIN_PREFIX.KIT_SEM_ABERTURA)) {
      count++;
    }
  }
  return { count };
}

/**
 * I/O (a única do módulo, fina) — `countKitSemAberturaInBrevo` sobre o store
 * em `{rootDir}/data/brevo-diaria/contacts.json`. Consumida pelo publish e
 * pelo schedule do Kit e pelo publish da Brevo pra detectar "flag desligada
 * com gente já movida".
 */
export function readKitSemAberturaInBrevoCount(rootDir: string): { count: number; warning?: string } | { error: string } {
  const path = resolve(rootDir, BREVO_DIARIA_STORE_RELATIVE_PATH);
  let raw: string | null;
  try {
    raw = existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch (e) {
    return { error: `store da Brevo (${path}) não pôde ser lido: ${(e as Error).message}` };
  }
  return countKitSemAberturaInBrevo(raw);
}

/**
 * Pura — dia UTC (`YYYY-MM-DD`) do ENVIO da campanha Brevo que vai levar quem
 * for movido agora: a edição é D+1 e sai de manhã em BRT (UTC−3), então é o
 * dia seguinte no calendário de Brasília. É esse dia que a cota da conta
 * precisa ter livre, não o de hoje.
 */
export function diariaSendDayUtc(nowMs: number): string {
  const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
  return new Date(nowMs - BRT_OFFSET_MS + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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

/** Quem recebeu (entregue)/abriu/clicou num broadcast (`POST /v4/subscribers/filter`). */
export interface BroadcastEngagement {
  broadcastId: number;
  /** `type: "delivered"` — entregues, não só enviados (bounce não conta como envio). */
  delivered: readonly string[];
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
    if (matureIds.has(b.broadcastId)) for (const email of new Set(b.delivered.map(normalizeEmail))) get(email).matureSends++;
    for (const email of new Set(b.opens.map(normalizeEmail))) get(email).opens++;
    for (const email of new Set(b.clicks.map(normalizeEmail))) get(email).clicks++;
  }
  return index;
}

/**
 * Pura (#10787) — separa o engajamento lido em "indexado" e "ainda não
 * indexado pelo filtro do Kit". O `/subscribers/filter` já devolveu 0
 * entregues/aberturas num broadcast segmentado com 954 destinatários (#10697,
 * atraso de indexação de ~17-22h). A maturação de 48h cobre o atraso medido,
 * mas nada garante que todo atraso caiba nela, e o caso perigoso é o parcial:
 * entregues já indexados e aberturas ainda não. Aí todo mundo daquele envio
 * ganharia 1 envio maduro sem abertura.
 *
 * Um broadcast da diária com entregues e 0 aberturas E 0 cliques não acontece
 * com a base real (centenas de aberturas por envio), então é tratado como não
 * indexado: os entregues dele não contam envio (aberturas/cliques, se houver,
 * seguem contando, porque só tiram gente da seleção). Broadcast com 0
 * entregues também é não indexado. Nenhum dos dois pode ser congelado no
 * cache (#10514): congelado com dado vazio, nunca mais seria relido.
 *
 * Erro possível: um envio legítimo com 0 aberturas deixaria de contar envio.
 * É o lado conservador (move menos gente), e o log da rodada nomeia o id.
 */
export function partitionIndexedEngagement(perBroadcast: readonly BroadcastEngagement[]): {
  usable: BroadcastEngagement[];
  unindexedIds: number[];
} {
  const usable: BroadcastEngagement[] = [];
  const unindexedIds: number[] = [];
  for (const b of perBroadcast) {
    const indexed = b.delivered.length > 0 && (b.opens.length > 0 || b.clicks.length > 0);
    if (indexed) usable.push(b);
    else {
      unindexedIds.push(b.broadcastId);
      usable.push({ ...b, delivered: [] });
    }
  }
  return { usable, unindexedIds };
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
    // `classifyKitSemAberturaCandidate` só devolve `null` com matureSends >= piso,
    // então a entrada existe; o `?? 0` só evita o `!` (nunca é exercitado).
    selected.push({ ...c, email, matureSends: ctx.engagement.get(email)?.matureSends ?? 0 });
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

/**
 * Pura — os cadastros novos (que entram antes do backlog) cabem na cota da
 * CONTA no dia de envio? Sem novos ⇒ ok. Consumo transacional não lido ⇒
 * reprova: cota ilegível nunca vira permissão de envio (mesma regra do
 * backlog). O caller aborta o Passo 3c inteiro quando reprova.
 */
export function checkNewSignupsFitAccountQuota(params: {
  currentActiveCount: number;
  seedCount: number;
  newCount: number;
  dailyLimit: number;
  transactionalOnSendDay: number | null;
}): { ok: true } | { ok: false; reason: string } {
  if (params.newCount === 0) return { ok: true };
  if (params.transactionalOnSendDay === null) {
    return { ok: false, reason: `cota da conta Brevo não lida — ${params.newCount} cadastro(s) novo(s) não cabem comprovadamente` };
  }
  const check = checkAccountSendQuota({
    dailyLimit: params.dailyLimit,
    transactionalRequestsOnSendDay: params.transactionalOnSendDay,
    recipients: params.currentActiveCount + params.seedCount + params.newCount,
  });
  if (!check.ok) return { ok: false, reason: `${params.newCount} cadastro(s) novo(s) não cabem na cota da conta: ${check.reason}` };
  return { ok: true };
}

export interface KitSemAberturaWave {
  /** Ordem de execução: cadastros novos primeiro, depois o backlog mais antigo. */
  toMove: (KitSemAberturaSelected & { wave: "novo" | "backlog" })[];
  newCount: number;
  backlogCount: number;
  deferred: number;
  /**
   * #10664 — o resto do backlog (fora de `slots`), na mesma ordem (mais antigo
   * primeiro). O sync puxa daqui quando um contato do backlog da onda é pulado
   * na confirmação (blacklisted na Brevo, apoiador pelo GET singular): sem a
   * reposição, quem é pulado não fica registrado em lugar nenhum, volta a ser
   * selecionado na rodada seguinte e, sendo o mais antigo, ocupa a mesma vaga
   * todo dia — a fila para. Contado em `deferred`.
   */
  backlogReserve: KitSemAberturaSelected[];
}

/**
 * #10664 — teto de reposições do backlog por rodada (contatos pulados na
 * confirmação e trocados pelo próximo da fila). Cada reposição custa uma
 * leitura na Brevo (blacklist) e, se passar, um GET singular no Kit; o teto só
 * limita o pior caso de uma rodada (milhares de blacklisted seguidos na cabeça
 * do backlog). Atingido, o sync avisa no log e marca
 * `backlogReplacementCapHit` no resultado (#10701, teste do caso atingido em
 * `test/kit-sem-abertura-replacement-cap-10701.test.ts`).
 *
 * O valor 1000 é estimativa, sem medição. Os pulados (blacklisted na Brevo)
 * seguem sem registro e são relidos a cada rodada; registrá-los (2ª opção da
 * #10664) fica para quando o aviso aparecer em produção.
 */
export const KIT_SEM_ABERTURA_MAX_BACKLOG_REPLACEMENTS = 1000;

/** Pura — "novo" = cadastrado no Kit há no máximo `newSignupWindowDays` dias.
 *  Novos entram ANTES do backlog e sem o teto da fila, mas sujeitos à cota da
 *  conta (`checkNewSignupsFitAccountQuota`, conferida pelo sync). */
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
    return { toMove: [], newCount: 0, backlogCount: 0, deferred: params.selected.length, backlogReserve: [] };
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
    backlogReserve: backlog.slice(backlogNow.length),
  };
}

// ── log append-only ──────────────────────────────────────────────────────

export interface KitSemAberturaLogEntry {
  ts: string;
  email: string;
  kit_subscriber_id: number;
  origin: string;
  /** `reconcile` = tinha a tag `envio-brevo` sem estar no store (órfão reconciliado). */
  wave: "novo" | "backlog" | "reconcile";
  mature_sends: number;
  brevo_list_id: number;
  kit_tag: string;
  /** `true` quando a tag não foi confirmada por releitura; o sync retenta na rodada seguinte. */
  kit_tag_pending?: boolean;
}

/** Saída terminal na Brevo propagada pro Kit (descadastro com releitura). */
export interface KitSemAberturaExitLogEntry {
  ts: string;
  event: "kit_unsubscribed";
  email: string;
  kit_subscriber_id: number;
  /** Motivo da saída na Brevo (`native_unsubscribe`, `native_complaint` #10666, `native_bounce`, `native_admin_block`, `suppress`). */
  brevo_exit: string;
}

/**
 * #10557 — movimentação DESFEITA: o contato já estava `emailBlacklisted` na
 * Brevo antes de entrar na lista (#10536), então a tag `envio-brevo` foi
 * removida no Kit (confirmada por releitura) e ele volta a receber por lá.
 * `step`: `evaluate` (Passo 0 de `evaluate-brevo-diaria.ts`) ou
 * `sync_orphan` (órfão do sync, nunca gravado no store).
 */
export interface KitSemAberturaRevertLogEntry {
  ts: string;
  event: "kit_tag_removed_preexisting_blacklist";
  email: string;
  kit_subscriber_id: number;
  step: "evaluate" | "sync_orphan";
}

/** Pura — uma linha do log (`data/brevo-diaria/kit-sem-abertura-log.jsonl`). */
export function formatKitSemAberturaLogLine(
  entry: KitSemAberturaLogEntry | KitSemAberturaExitLogEntry | KitSemAberturaRevertLogEntry,
): string {
  return JSON.stringify(entry) + "\n";
}
