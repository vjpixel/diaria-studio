/**
 * scripts/lib/metrics/channel-cohort-funnel-store.ts (#7918)
 *
 * Camada de TRADUÇÃO store (#6464, `diaria-subscribers.db`) → insumo puro de
 * `channel-cohort-funnel.ts` (`FunnelPersonInput[]` + `FunnelSources`). Mesmo
 * par "puro × I/O" de `acquisition-store-deps.ts`: toda a regra de negócio
 * fica no módulo puro; aqui só leitura e mapeamento.
 *
 * ## De onde sai cada campo (reuso da base do #7916)
 *
 * - Pessoa: 1 entrada por `subscriber_id` (identidade já resolvida e
 *   deduplicada entre plataformas pelo #6589/#8236) — nunca por
 *   `subscription`. Sem e-mail: entra com `email: ""` e o módulo puro a
 *   exclui, contada em `resumo.semEmail`.
 * - Cadastro: `entered_at` MAIS ANTIGO entre as `subscription` da pessoa
 *   (troca de provedor não vira aquisição nova).
 * - Origem/campanha: `resolveSubscriberAttribution` (precedência fixa
 *   kit > beehiiv > brevo_diaria, bundle inteiro). Destino: `origem_cadastro`
 *   da mesma plataforma vencedora, senão o 1º não-nulo.
 * - Reativação: `subscription.reativado` (pegajoso, #8235).
 * - Confirmação (`resolveConfirmacaoFromStore`): evento `confirm` (instante
 *   conhecido) ou estado NATIVO do Kit — `active` = confirmado, `inactive` =
 *   DOI pendente. Inscrição Kit anterior a `KIT_SERIES_FLOOR` (importação
 *   Beehiiv→Kit, sem DOI) é NÃO OBSERVÁVEL. Estado de saída (`cancelled`/
 *   `bounced`/`complained`) com ≥1 edição Kit recebida conta como confirmado
 *   (o Kit só envia broadcast a quem está `active`, ou seja, confirmou); sem
 *   nenhuma recebida, é não observável. Nunca `false` fabricado.
 * - Entrega e leitor: `computeStoreLeitorInputCanonicalDedupBatched` — a
 *   MESMA derivação que `leitor-v1` cross-plataforma usa (recebidas por
 *   edição canônica, `delivered` ou `sent − bounce`). Se NENHUMA plataforma
 *   da pessoa tem envio no store depois do cadastro dela (store defasado
 *   naquela plataforma), entrega e engajamento são não observáveis para ela
 *   — senão "não recebeu" seria uma ausência fabricada. Engajamento exige
 *   mais: envio E clique depois do cadastro na MESMA plataforma
 *   (`resolveFreshnessObservability`) — ingestão de clique parada torna
 *   "nunca clicou" não observável, mesmo com envio fresco.
 * - 1º clique: `firstClickAtOrAfter` — o 1º clique com `ts >= cadastro`
 *   (clique anterior ao cadastro é descartado, nunca "dia 0"). Os broadcasts
 *   de onboarding do Kit já são excluídos na ingestão (#7916/#7922, PR
 *   #9747); `edicoesExcluidas` repete essa exclusão aqui como defesa em
 *   profundidade.
 *
 * ## Só leitura
 *
 * `openFunnelStoreReadOnly` abre o SQLite com `readOnly: true` — sem criar
 * arquivo, sem rodar SCHEMA/migrations/WAL (ao contrário de
 * `openDiariaSubscribersDb`, que é o caminho de ESCRITA dos ingestores).
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  PLATFORMS,
  getAllAliasesBySubscriber,
  getAllEventsBySubscriber,
  getAllSubscriberPlatforms,
  getAllSubscriptionsBySubscriber,
  getSubscriptionAsOf,
  resolveSubscriberAttribution,
  type Platform,
  type SubscriberEventRow,
  type SubscriptionRecord,
} from "../diaria-subscribers-db.ts";
import { buildCanonicalEdicaoMapFromEvents } from "../diaria-subscribers-edicao-canonica.ts";
import { computeStoreLeitorInputCanonicalDedupBatched, detectPlatformCapabilities } from "../leitor-store.ts";
import {
  brtDayOfIso,
  type FunnelConfirmacaoInput,
  type FunnelPersonInput,
  type FunnelPlatformFreshness,
  type FunnelSources,
  type FunnelSourceStatus,
} from "./channel-cohort-funnel.ts";
import { KIT_SERIES_FLOOR } from "./registry.ts";

export const STORE_FONTE = "data/diaria-subscribers/diaria-subscribers.db";

/**
 * Abre o store SÓ PARA LEITURA. Lança (com a mensagem original do SQLite)
 * se o arquivo não existir ou não abrir — o chamador decide como reportar;
 * nunca cria um `.db` vazio que depois se leria como "zero cadastros".
 */
export function openFunnelStoreReadOnly(dbPath: string): DatabaseSync {
  if (!existsSync(dbPath)) throw new Error(`store não encontrado: ${dbPath}`);
  const { DatabaseSync: Ctor } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
  return new Ctor(dbPath, { readOnly: true });
}

/** Confirmação a partir das `subscription`, do instante do evento `confirm`
 *  (se houver) e de quantas edições Kit a pessoa recebeu.
 *
 *  Inscrição no Kit anterior a `KIT_SERIES_FLOOR` (o import Beehiiv→Kit de
 *  24/08/2026 e qualquer cópia anterior) é NÃO OBSERVÁVEL: a pessoa nasceu
 *  `active` no Kit por importação, sem passar pelo double opt-in — ler esse
 *  `active` como confirmação fazia as coortes pré-Kit saírem com ~100%
 *  (self-review da PR #9839). Só o evento `confirm` explícito vence isso.
 *
 *  Estado de saída (`cancelled`/`bounced`/`complained`) não diz por si se a
 *  pessoa confirmou; com `kitEdicoesRecebidas >= 1` ela confirmou (o Kit só
 *  envia broadcast a `active`), sem isso fica não observável. @pure */
export function resolveConfirmacaoFromStore(
  subs: readonly Pick<SubscriptionRecord, "platform" | "status" | "entered_at">[],
  confirmTs: string | null,
  kitEdicoesRecebidas = 0,
): FunnelConfirmacaoInput {
  if (confirmTs) return { observavel: true, confirmado: true, confirmadoEm: confirmTs };
  const kit = subs.find((s) => s.platform === "kit");
  if (!kit) return { observavel: false, motivo: "sem subscription no Kit — DOI não observável" };
  const kitDia = brtDayOfIso(kit.entered_at);
  if (kitDia == null) {
    return { observavel: false, motivo: "subscription Kit sem entered_at legível — não dá pra saber se passou pelo DOI" };
  }
  if (kitDia < KIT_SERIES_FLOOR) {
    return {
      observavel: false,
      motivo: `entrou no Kit em ${kitDia}, antes de ${KIT_SERIES_FLOOR} (importação) — estado Kit não é sinal de DOI`,
    };
  }
  if (kit.status === "active") return { observavel: true, confirmado: true, confirmadoEm: null };
  if (kit.status === "inactive") return { observavel: true, confirmado: false, confirmadoEm: null };
  if (kitEdicoesRecebidas >= 1) return { observavel: true, confirmado: true, confirmadoEm: null };
  return { observavel: false, motivo: `estado Kit "${kit.status ?? "null"}" sem edição Kit recebida — não diz se a pessoa confirmou` };
}

function earliestIso(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms < bestMs) {
      bestMs = ms;
      best = v;
    }
  }
  return best;
}

function firstTsByType(db: DatabaseSync, type: string): Map<number, string> {
  const rows = db
    .prepare(`SELECT subscriber_id, MIN(ts) AS ts FROM event WHERE subscriber_id IS NOT NULL AND type = ? GROUP BY subscriber_id`)
    .all(type) as unknown as Array<{ subscriber_id: number; ts: string }>;
  return new Map(rows.map((r) => [r.subscriber_id, r.ts]));
}

/** Cliques por subscriber (com plataforma/edição, pra excluir onboarding) —
 *  o 1º clique VÁLIDO depende do cadastro resolvido da pessoa (ver
 *  `firstClickAtOrAfter`), então não dá pra resolver com um `MIN(ts)` cego. */
function clicksBySubscriber(db: DatabaseSync): Map<number, Array<{ platform: string; edicao: string | null; ts: string }>> {
  const rows = db
    .prepare(`SELECT subscriber_id, platform, edicao, ts FROM event WHERE subscriber_id IS NOT NULL AND type = 'click'`)
    .all() as unknown as Array<{ subscriber_id: number; platform: string; edicao: string | null; ts: string }>;
  const map = new Map<number, Array<{ platform: string; edicao: string | null; ts: string }>>();
  for (const { subscriber_id, ...rest } of rows) {
    const list = map.get(subscriber_id);
    if (list) list.push(rest);
    else map.set(subscriber_id, [rest]);
  }
  return map;
}

/** 1º clique com `ts >= enteredAt` — clique anterior ao cadastro resolvido
 *  (dado inconsistente entre plataformas) é descartado, nunca vira "clique
 *  no dia 0". `ts` malformado também é descartado. Sem `enteredAt` legível,
 *  `null` (a pessoa sai da coorte de qualquer forma). @pure */
export function firstClickAtOrAfter(clickTs: readonly string[], enteredAt: string | null): string | null {
  const enteredMs = enteredAt ? Date.parse(enteredAt) : NaN;
  if (!Number.isFinite(enteredMs)) return null;
  let best: string | null = null;
  let bestMs = Infinity;
  for (const ts of clickTs) {
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms) || ms < enteredMs) continue;
    if (ms < bestMs) {
      bestMs = ms;
      best = ts;
    }
  }
  return best;
}

function maxTsByPlatform(db: DatabaseSync, types: readonly string[]): Map<string, string> {
  const ph = types.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT platform, MAX(ts) AS ts FROM event WHERE type IN (${ph}) GROUP BY platform`)
    .all(...types) as unknown as Array<{ platform: string; ts: string | null }>;
  const map = new Map<string, string>();
  for (const r of rows) if (r.ts) map.set(r.platform, r.ts);
  return map;
}

function maxIso(values: Iterable<string>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = v;
    }
  }
  return best;
}

function status(fonte: string, frescor: string | null, disponivel: boolean, motivo: string): FunnelSourceStatus {
  return disponivel ? { fonte, frescor, disponivel: true } : { fonte, frescor, disponivel: false, motivo };
}

/**
 * Guarda de frescor por pessoa, plataforma a plataforma:
 * - entrega observável ⇔ ALGUMA plataforma da pessoa tem envio com
 *   `ts >= cadastro`;
 * - engajamento observável ⇔ ALGUMA plataforma da pessoa tem envio E clique
 *   com `ts >= cadastro` NA MESMA plataforma — uma plataforma que segue
 *   enviando mas parou de ingerir clique não pode tornar "nunca clicou"
 *   observável, nem o clique fresco de outra plataforma em que a pessoa não
 *   recebe.
 * Cadastro ilegível: ambos `true` (a pessoa sai da coorte no módulo puro de
 * qualquer forma). @pure
 */
export function resolveFreshnessObservability(
  plataformas: readonly string[],
  enteredAt: string | null,
  lastDelivery: ReadonlyMap<string, string>,
  lastClick: ReadonlyMap<string, string>,
): { entrega: boolean; engajamento: boolean } {
  const enteredMs = enteredAt ? Date.parse(enteredAt) : NaN;
  if (!Number.isFinite(enteredMs)) return { entrega: true, engajamento: true };
  const fresh = (m: ReadonlyMap<string, string>, p: string) => {
    const v = m.get(p);
    return v != null && Date.parse(v) >= enteredMs;
  };
  const comEnvio = plataformas.filter((p) => fresh(lastDelivery, p));
  return { entrega: comEnvio.length > 0, engajamento: comEnvio.some((p) => fresh(lastClick, p)) };
}

export interface FunnelStoreOptions {
  /** `edicao` (broadcast id) de envios de ONBOARDING a desconsiderar —
   *  `readOnboardingBroadcastExclusion(...).ids`. Vale para eventos Kit. */
  edicoesExcluidas?: ReadonlySet<string>;
}

export interface FunnelStoreInput {
  people: FunnelPersonInput[];
  fontes: FunnelSources;
  /** Avisos de cobertura (ex.: pessoas cuja plataforma parou de ingerir). */
  avisos: string[];
}

/** Lê o store inteiro (1 scan por tabela) e devolve o insumo do relatório. */
export function loadFunnelInputFromStore(db: DatabaseSync, opts: FunnelStoreOptions = {}): FunnelStoreInput {
  const excl = opts.edicoesExcluidas ?? new Set<string>();
  const isOnboarding = (e: { platform: string; edicao: string | null }) => e.platform === "kit" && e.edicao != null && excl.has(e.edicao);

  const caps = detectPlatformCapabilities(db, PLATFORMS);
  const canonicalMap = buildCanonicalEdicaoMapFromEvents(db);
  const platformsBySub = getAllSubscriberPlatforms(db);
  const subsBySub = getAllSubscriptionsBySubscriber(db);
  const aliasesBySub = getAllAliasesBySubscriber(db);
  const eventsBySub = getAllEventsBySubscriber(db);
  const clicks = clicksBySubscriber(db);
  const firstConfirm = firstTsByType(db, "confirm");
  const lastDelivery = maxTsByPlatform(db, ["delivered", "sent"]);
  // Último clique por plataforma SEM os de onboarding — um clique só em
  // boas-vindas não prova que a ingestão de clique em EDIÇÃO está em dia.
  const lastClick = new Map<string, string>();
  for (const list of clicks.values()) {
    for (const c of list) {
      if (isOnboarding(c)) continue;
      const prev = lastClick.get(c.platform);
      const ms = Date.parse(c.ts);
      if (Number.isFinite(ms) && (prev == null || ms > Date.parse(prev))) lastClick.set(c.platform, c.ts);
    }
  }

  const people: FunnelPersonInput[] = [];
  let semEnvioDepoisDoCadastro = 0;
  let semCliqueDepoisDoCadastro = 0;
  for (const [subscriberId, platformSet] of platformsBySub) {
    const aliases = aliasesBySub.get(subscriberId) ?? [];
    const subs = subsBySub.get(subscriberId) ?? [];
    const events: SubscriberEventRow[] = (eventsBySub.get(subscriberId) ?? []).filter((e) => !isOnboarding(e));
    const attribution = resolveSubscriberAttribution(subs);
    const winner = attribution.platform ? subs.find((s) => s.platform === attribution.platform) : undefined;
    const destino = winner?.origem_cadastro ?? subs.find((s) => s.origem_cadastro)?.origem_cadastro ?? null;
    const leitor = computeStoreLeitorInputCanonicalDedupBatched(events, aliases, subs, caps, canonicalMap, PLATFORMS);
    const enteredAt = earliestIso(subs.map((s) => s.entered_at));
    const kitRecebidas = new Set(
      events.filter((e) => e.platform === "kit" && (e.type === "delivered" || e.type === "sent")).map((e) => e.edicao ?? e.external_event_id),
    ).size;

    const plataformas = new Set<string>([...platformSet, ...subs.map((s) => s.platform)]);
    const obs = resolveFreshnessObservability([...plataformas], enteredAt, lastDelivery, lastClick);
    if (!obs.entrega) semEnvioDepoisDoCadastro++;
    else if (!obs.engajamento) semCliqueDepoisDoCadastro++;
    const temEnvioDepois = obs.entrega;
    const motivoSemEnvio = `nenhuma plataforma da pessoa (${[...plataformas].join(", ")}) tem envio no store depois do cadastro — store defasado nessa plataforma`;
    const motivoSemClique =
      `nenhuma plataforma da pessoa (${[...plataformas].join(", ")}) tem envio E clique no store depois do cadastro — ` +
      "ingestão de clique defasada nessa plataforma";

    people.push({
      personKey: String(subscriberId),
      // Sem e-mail: passa vazio e o módulo puro exclui (resumo.semEmail) —
      // mesmo destino de `buildCacCompatibleSubscribersFromStore`, que pula,
      // mas com a exclusão contada em vez de silenciosa.
      email: aliases.find((a) => a.email)?.email ?? "",
      enteredAt,
      utmSource: attribution.utmSource,
      utmMedium: attribution.utmMedium,
      utmCampaign: attribution.utmCampaign,
      utmChannel: attribution.utmChannel,
      referringSite: attribution.referringSite,
      destino,
      reativado: subs.some((s) => s.reativado === 1),
      confirmacao: resolveConfirmacaoFromStore(subs, firstConfirm.get(subscriberId) ?? null, kitRecebidas),
      entrega: temEnvioDepois ? { observavel: true, edicoesRecebidas: leitor.totalReceived } : { observavel: false, motivo: motivoSemEnvio },
      engajamento: obs.engajamento
        ? {
            observavel: true,
            primeiroCliqueEm: firstClickAtOrAfter(
              (clicks.get(subscriberId) ?? []).filter((c) => !isOnboarding(c)).map((c) => c.ts),
              enteredAt,
            ),
            leitor,
          }
        : { observavel: false, motivo: temEnvioDepois ? motivoSemClique : motivoSemEnvio },
    });
  }

  const porPlataforma: Record<string, FunnelPlatformFreshness> = {};
  for (const p of PLATFORMS as readonly Platform[]) {
    porPlataforma[p] = { ultimaEntrega: lastDelivery.get(p) ?? null, ultimoClique: lastClick.get(p) ?? null };
  }

  const subsAsOf = getSubscriptionAsOf(db, PLATFORMS);
  const deliveryAsOf = maxIso(lastDelivery.values());
  const clickAsOf = maxIso(lastClick.values());
  const hasSubs = subsAsOf != null;
  const fontes: FunnelSources = {
    cadastro: status(`${STORE_FONTE} (subscription)`, subsAsOf, hasSubs, "store sem nenhuma subscription — ingestão não rodou"),
    confirmacao: status(
      `${STORE_FONTE} (subscription.status Kit + event confirm)`,
      subsAsOf,
      hasSubs,
      "store sem nenhuma subscription — estado DOI não coletado",
    ),
    entrega: status(
      `${STORE_FONTE} (event delivered/sent, edição canônica)`,
      deliveryAsOf,
      deliveryAsOf != null,
      "store sem eventos delivered/sent — entrega não coletada",
    ),
    // Disponibilidade de engajamento vem de CLIQUE coletado, não de entrega:
    // store com envios e sem nenhum clique é ingestão de clique ausente, não
    // "ninguém clicou".
    engajamento: status(
      `${STORE_FONTE} (event click, leitor-store.ts)`,
      clickAsOf,
      clickAsOf != null && deliveryAsOf != null,
      clickAsOf == null ? "store sem nenhum evento click — cliques não coletados" : "store sem eventos de envio — sem denominador",
    ),
    porPlataforma,
  };

  const avisos: string[] = [];
  for (const [p, f] of Object.entries(porPlataforma)) {
    if (f.ultimaEntrega == null) avisos.push(`plataforma ${p}: nenhum envio no store`);
  }
  if (semEnvioDepoisDoCadastro > 0) {
    avisos.push(
      `${semEnvioDepoisDoCadastro} pessoa(s) sem envio de nenhuma das suas plataformas depois do cadastro — entrega/engajamento delas marcados como não observáveis`,
    );
  }
  if (semCliqueDepoisDoCadastro > 0) {
    avisos.push(
      `${semCliqueDepoisDoCadastro} pessoa(s) com envio mas sem clique coletado em nenhuma das suas plataformas depois do cadastro — engajamento delas marcado como não observável`,
    );
  }
  return { people, fontes, avisos };
}
