/**
 * scripts/lib/metrics/channel-cohort-funnel.ts (#7918)
 *
 * Comparação de canais pela PROGRESSÃO dos leitores depois do cadastro:
 * coortes por data de aquisição (dia ou semana BRT) × origem (`utm_source`)
 * × campanha (`utm_campaign`) × destino (`origem_cadastro`), cada uma com 4
 * etapas que NUNCA se confundem entre si:
 *
 *   cadastro aceito → confirmação (DOI) → entrega (≥1 edição) → engajamento
 *   (`primeiro-clique-14d` e `leitor-v1`)
 *
 * mais custo por confirmado/leitor quando gasto e população são da MESMA
 * coorte (mesma origem, mesma janela de cadastro).
 *
 * ## Por que existe
 *
 * O evento de conversão de `/assinar` dispara quando a API ACEITA o cadastro
 * — antes do double opt-in. Medir canal só por ele mede cadastro, não leitor.
 * O projeto já tinha as peças separadas (`acquisition-cohort.ts` — cadastro
 * e estado DOI por coorte, #7916; `ativacao-coorte.ts` — `primeiro-clique-14d`;
 * `leitor.ts` — `leitor-v1`; `ads-rolling-window.ts` — gasto da janela
 * móvel). Este módulo as conecta numa visão única por coorte, sem redefinir
 * nenhuma delas.
 *
 * ## Reuso, não definição paralela
 *
 * - Classe de aquisição: `classifyAcquisition` (#7173).
 * - Migração em massa: `isBulkImport` (`ativacao-coorte.ts`).
 * - 1º clique em 14 dias: `computePrimeiroClique14d` — chamado POR COORTE
 *   com os membros dela, nunca reimplementado (mesma maturação de 14 dias,
 *   mesmo denominador `recebeuAoMenosUma`, mesmas exclusões).
 * - Leitor: `isLeitorV1` com `LEITOR_V1_THRESHOLDS` — o `LeitorInput` vem
 *   do chamador (store cross-plataforma, `computeStoreLeitorInputCanonicalDedupBatched`).
 * - Interno/teste: `filterInternalAndTestSubscribers` (`cac.ts`).
 *
 * ## Estados de uma taxa — 4, nunca colapsados
 *
 * - `medido` — numerador/denominador conhecidos. Numerador 0 aqui é
 *   AUSÊNCIA DE EVENTOS (ninguém confirmou), uma medição.
 * - `em-observacao` — coorte mais nova que a janela da etapa. Nunca
 *   comparada como se tivesse maturado: `taxa`/`numerador` saem `null` para
 *   as etapas cuja definição exige maturação (14 dias, leitor-v1); para
 *   confirmação/entrega a contagem parcial sai, mas marcada.
 * - `sem-dados` — a FONTE não foi coletada/está indisponível (falta de dado).
 * - `nao-observavel` — a pergunta não se aplica a ninguém da coorte (ex.:
 *   DOI só é observável no Kit — Beehiiv/Brevo não expõem confirmação,
 *   mesma ressalva de `acquisition-cohort.ts`).
 *
 * ## Dedup
 *
 * O chamador entrega 1 entrada por `subscriber_id` resolvido; ainda assim
 * `personKey` repetido é FUNDIDO aqui (nunca conta 2 pessoas nem 2
 * conversões) e reportado em `resumo.duplicatasFundidas`.
 *
 * ## Módulo PURO, sem I/O
 *
 * O insumo vem de `channel-cohort-funnel-store.ts` (store do #6464) e o
 * gasto de `scripts/channel-cohort-funnel.ts` (CSV do teste 2608 via
 * `computeRollingWindow`). O relatório de 3 dias (`ads-rolling-cac.ts`)
 * segue intocado — esta visão o complementa.
 */

import { classifyAcquisition, type AcquisitionClass } from "./acquisition-class.ts";
import { computePrimeiroClique14d, isBulkImport, type AtivacaoCoorteSubscriberInput } from "./ativacao-coorte.ts";
import { filterInternalAndTestSubscribers } from "../cac.ts";
import { isLeitorV1, LEITOR_V1_THRESHOLDS, type LeitorInput } from "../leitor.ts";
import { normalizeKey } from "../shared/attribution-keys.ts";
import { unixSecondsToBrtDate } from "../beehiiv-publish-date.ts";
import { computeRollingWindow, shiftDate } from "../ads-rolling-window.ts";
import type { ClicksCsvRow } from "../ads-test-watch.ts";
import { CHANNEL_KEY_SPECS, type ChannelKeySpec } from "../shared/channel-key-specs.ts";
import { KIT_IMPORT_DAY, KIT_SERIES_FLOOR } from "./registry.ts";

// ---------------------------------------------------------------------------
// Janelas de maturação (declaradas, nunca implícitas)
// ---------------------------------------------------------------------------

/** Maturação do double opt-in — mesmo valor de `buildDoiConfirmationCohort`
 *  (`subscriber-state-snapshot.ts`, default 48h) e da `definicao` de
 *  `doi-confirmacao-dia`. Confirmação depois disso ainda CONTA (confirmação
 *  tardia é confirmação), mas é reportada em `confirmadosTardios`. */
export const CONFIRMACAO_JANELA_HORAS = 48;

/** Maturação da 1ª entrega: a edição sai seg-sex, então um cadastro de
 *  sexta à noite só recebe na segunda — 3 dias corridos cobrem o pior caso
 *  sem feriado. Coorte mais nova que isso fica `em-observacao`. */
export const ENTREGA_JANELA_DIAS = 3;

/** Janela de `primeiro-clique-14d` (`ativacao-coorte.ts`). Só reexposta
 *  aqui para a idade da coorte e o rótulo; a maturação efetiva quem decide
 *  é `computePrimeiroClique14d`. */
export const PRIMEIRO_CLIQUE_JANELA_DIAS = 14;

/** `leitor-v1` exige ≥20 edições recebidas (`LEITOR_V1_THRESHOLDS`); na
 *  cadência seg-sex isso são 4 semanas corridas. Coorte mais nova que isso
 *  tem `leitor-v1` zero POR CONSTRUÇÃO — reportar a taxa compararia uma
 *  coorte imatura como se tivesse completado a janela. */
export const LEITOR_V1_MATURACAO_DIAS = Math.ceil((LEITOR_V1_THRESHOLDS.receivedMin / 5) * 7);

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type FunnelConfirmacaoInput =
  | { observavel: false; motivo: string }
  | {
      observavel: true;
      /** `true` só com o SINAL de confirmação (estado `active` no Kit ou
       *  evento `confirm`) — cadastro aceito sozinho nunca vira `true`. */
      confirmado: boolean;
      /** ISO 8601 da confirmação quando a fonte expõe o instante; `null`
       *  quando só o estado é conhecido. */
      confirmadoEm: string | null;
    };

export type FunnelEntregaInput =
  | { observavel: false; motivo: string }
  | { observavel: true; edicoesRecebidas: number };

export type FunnelEngajamentoInput =
  | { observavel: false; motivo: string }
  | {
      observavel: true;
      /** ISO 8601 do 1º clique em EDIÇÃO (onboarding fica fora — o ingest
       *  Kit já exclui os broadcasts de onboarding, #7916/#7922). */
      primeiroCliqueEm: string | null;
      /** Insumo de `isLeitorV1` — sempre calculado pela fonte canônica. */
      leitor: LeitorInput;
    };

export interface FunnelPersonInput {
  /** Chave de pessoa resolvida (`subscriber_id`). Repetida = mesma pessoa. */
  personKey: string;
  /** Usado só para a exclusão interno/teste (`filterInternalAndTestSubscribers`). */
  email: string;
  /** ISO 8601 — cadastro mais antigo entre as plataformas da pessoa. */
  enteredAt: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmChannel: string | null;
  referringSite: string | null;
  /** Superfície onde o cadastro aconteceu (`origem_cadastro`). */
  destino: string | null;
  /** Reativação sinalizada pela ingestão (`subscription.reativado`). */
  reativado: boolean;
  confirmacao: FunnelConfirmacaoInput;
  entrega: FunnelEntregaInput;
  engajamento: FunnelEngajamentoInput;
}

/** Estado de UMA fonte do relatório — `disponivel: false` é "falta de
 *  dado", diferente de "nenhum evento". */
export interface FunnelSourceStatus {
  fonte: string;
  frescor: string | null;
  disponivel: boolean;
  motivo?: string;
}

export interface FunnelSources {
  cadastro: FunnelSourceStatus;
  confirmacao: FunnelSourceStatus;
  entrega: FunnelSourceStatus;
  engajamento: FunnelSourceStatus;
}

export type FunnelGranularidade = "dia" | "semana";

export interface FunnelOptions {
  /** ISO 8601 — "agora" injetado (testável). */
  now: string;
  granularidade?: FunnelGranularidade;
  /** Quebrar por `utm_campaign` (default `true`). */
  porCampanha?: boolean;
  /** Quebrar por destino (default `true`). */
  porDestino?: boolean;
  fontes: FunnelSources;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type FunnelRateEstado = "medido" | "em-observacao" | "sem-dados" | "nao-observavel";

export interface FunnelRate {
  etapa: "confirmacao" | "entrega" | "primeiro-clique-14d" | "leitor-v1";
  numerador: number | null;
  denominador: number | null;
  /** 0..1, ou `null` quando não há o que dividir / a coorte não maturou. */
  taxa: number | null;
  janela: string;
  fonte: string;
  frescor: string | null;
  estado: FunnelRateEstado;
  motivo: string | null;
}

export type FunnelSegmento = "novo" | "migrado" | "reativado";

export interface FunnelCohortRow {
  /** `YYYY-MM-DD` BRT — o dia, ou a segunda-feira da semana. */
  periodo: string;
  origem: string | null;
  campanha: string | null;
  destino: string | null;
  segmento: FunnelSegmento;
  atribuido: boolean;
  classe: AcquisitionClass;
  /** Dias desde o cadastro do membro MAIS NOVO — a coorte só é tão madura
   *  quanto ele (mesmo critério de `computePrimeiroClique14d`). */
  idadeDias: number;
  /** `true` se ALGUMA etapa ainda não maturou para esta coorte. */
  emObservacao: boolean;
  /** Cobertura da fonte para esta coorte, para comparações antes/depois da
   *  migração Beehiiv→Kit: `pre-kit` (todos os cadastros antes de
   *  `KIT_SERIES_FLOOR` — DOI não observável para quem só tem Beehiiv),
   *  `kit` (todos a partir dele) ou `mista` (a coorte atravessa a troca —
   *  não comparar como se a cobertura fosse uniforme). A DEFINIÇÃO das
   *  etapas é a mesma nos três casos; muda só o que a fonte enxerga. */
  cobertura: "pre-kit" | "kit" | "mista";
  cadastrosAceitos: number;
  confirmacao: FunnelRate;
  /** Confirmações observadas DEPOIS da janela de 48h — só contáveis quando a
   *  fonte expõe o instante; `null` quando nenhum membro tem `confirmadoEm`. */
  confirmadosTardios: number | null;
  entrega: FunnelRate;
  primeiroClique14d: FunnelRate;
  leitorV1: FunnelRate;
}

export interface FunnelSummary {
  pessoasRecebidas: number;
  duplicatasFundidas: number;
  internasOuTesteExcluidas: number;
  semDataDeCadastro: number;
  semAtribuicao: number;
  migrados: number;
  reativados: number;
}

export interface ChannelCohortFunnel {
  geradoEm: string;
  granularidade: FunnelGranularidade;
  fontes: FunnelSources;
  resumo: FunnelSummary;
  rows: FunnelCohortRow[];
}

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** ISO → dia BRT, `null` se malformado. @pure */
export function brtDayOfIso(iso: string | null | undefined): string | null {
  const ms = parseMs(iso);
  return ms == null ? null : unixSecondsToBrtDate(Math.floor(ms / 1000));
}

/** Segunda-feira (BRT) da semana do dia `YYYY-MM-DD`. @pure */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = segunda
  return new Date(d.getTime() - dow * DAY_MS).toISOString().slice(0, 10);
}

function clean(v: string | null | undefined): string | null {
  return normalizeKey(v) === "__none__" ? null : String(v).trim();
}

/** Segmento da pessoa: reativação vence migração (a pessoa existia antes e
 *  foi trazida de volta), migração vence "novo". Migração = import em massa
 *  (`isBulkImport`) OU cadastro datado do dia do import Beehiiv→Kit
 *  (`KIT_IMPORT_DAY`, que o registry já exclui das métricas de aquisição —
 *  o `created_at` do Kit nesse dia é a data da cópia, não da aquisição).
 *  @pure */
export function resolveSegmento(
  p: Pick<FunnelPersonInput, "reativado" | "utmChannel">,
  classe: AcquisitionClass,
  diaCadastroBrt?: string | null,
): FunnelSegmento {
  if (p.reativado || classe === "reativacao") return "reativado";
  if (isBulkImport(p.utmChannel) || diaCadastroBrt === KIT_IMPORT_DAY) return "migrado";
  return "novo";
}

function minIso(a: string | null, b: string | null): string | null {
  const am = parseMs(a);
  const bm = parseMs(b);
  if (am == null) return bm == null ? null : b;
  if (bm == null) return a;
  return am <= bm ? a : b;
}

/**
 * Funde entradas com o mesmo `personKey` — evento repetido nunca vira 2
 * pessoas nem 2 conversões. Regras: cadastro mais antigo; atribuição da
 * entrada mais antiga (inteira, nunca campo a campo); confirmado se QUALQUER
 * entrada tem o sinal; recebidas/leitor da entrada com mais recebidas
 * (dedup por edição já é da fonte); 1º clique mais antigo. @pure
 */
export function dedupePeople(people: readonly FunnelPersonInput[]): { people: FunnelPersonInput[]; duplicatasFundidas: number } {
  const byKey = new Map<string, FunnelPersonInput>();
  let dup = 0;
  const ordered = [...people].sort((a, b) => (parseMs(a.enteredAt) ?? Infinity) - (parseMs(b.enteredAt) ?? Infinity));
  for (const p of ordered) {
    const prev = byKey.get(p.personKey);
    if (!prev) {
      byKey.set(p.personKey, p);
      continue;
    }
    dup++;
    const confirmacao: FunnelConfirmacaoInput =
      prev.confirmacao.observavel && p.confirmacao.observavel
        ? {
            observavel: true,
            confirmado: prev.confirmacao.confirmado || p.confirmacao.confirmado,
            confirmadoEm: minIso(prev.confirmacao.confirmadoEm, p.confirmacao.confirmadoEm),
          }
        : prev.confirmacao.observavel
          ? prev.confirmacao
          : p.confirmacao;
    const entrega: FunnelEntregaInput =
      prev.entrega.observavel && p.entrega.observavel
        ? { observavel: true, edicoesRecebidas: Math.max(prev.entrega.edicoesRecebidas, p.entrega.edicoesRecebidas) }
        : prev.entrega.observavel
          ? prev.entrega
          : p.entrega;
    let engajamento: FunnelEngajamentoInput;
    if (prev.engajamento.observavel && p.engajamento.observavel) {
      const richer =
        p.engajamento.leitor.totalReceived > prev.engajamento.leitor.totalReceived ? p.engajamento.leitor : prev.engajamento.leitor;
      engajamento = {
        observavel: true,
        primeiroCliqueEm: minIso(prev.engajamento.primeiroCliqueEm, p.engajamento.primeiroCliqueEm),
        leitor: richer,
      };
    } else {
      engajamento = prev.engajamento.observavel ? prev.engajamento : p.engajamento;
    }
    byKey.set(p.personKey, {
      ...prev,
      reativado: prev.reativado || p.reativado,
      confirmacao,
      entrega,
      engajamento,
    });
  }
  return { people: [...byKey.values()], duplicatasFundidas: dup };
}

function rate(
  etapa: FunnelRate["etapa"],
  janela: string,
  src: FunnelSourceStatus,
  numerador: number | null,
  denominador: number | null,
  estado: FunnelRateEstado,
  motivo: string | null,
): FunnelRate {
  const taxa = numerador != null && denominador != null && denominador > 0 ? numerador / denominador : null;
  return { etapa, numerador, denominador, taxa, janela, fonte: src.fonte, frescor: src.frescor, estado, motivo };
}

function semDados(etapa: FunnelRate["etapa"], janela: string, src: FunnelSourceStatus): FunnelRate {
  return rate(etapa, janela, src, null, null, "sem-dados", src.motivo ?? `fonte ${src.fonte} indisponível`);
}

// ---------------------------------------------------------------------------
// Etapas de 1 coorte
// ---------------------------------------------------------------------------

interface Member {
  p: FunnelPersonInput;
  enteredMs: number;
  /** Dia BRT do cadastro. */
  dia: string;
  classe: AcquisitionClass;
  segmento: FunnelSegmento;
}

function confirmacaoRate(members: readonly Member[], nowMs: number, src: FunnelSourceStatus): { r: FunnelRate; tardios: number | null } {
  const janela = `confirmação DOI (estado active ou evento confirm) — maturação ${CONFIRMACAO_JANELA_HORAS}h após o cadastro; confirmação tardia conta e é contada à parte`;
  if (!src.disponivel) return { r: semDados("confirmacao", janela, src), tardios: null };
  const obs = members.filter((m) => m.p.confirmacao.observavel);
  if (obs.length === 0) {
    return {
      r: rate("confirmacao", janela, src, null, null, "nao-observavel", "nenhum membro tem confirmação observável (DOI só existe no Kit)"),
      tardios: null,
    };
  }
  let confirmados = 0;
  let tardios = 0;
  let comInstante = 0;
  for (const m of obs) {
    const c = m.p.confirmacao;
    if (!c.observavel || !c.confirmado) continue;
    confirmados++;
    const cMs = parseMs(c.confirmadoEm);
    if (cMs != null) {
      comInstante++;
      if (cMs - m.enteredMs > CONFIRMACAO_JANELA_HORAS * 3600_000) tardios++;
    }
  }
  const naoObs = members.length - obs.length;
  const youngest = Math.max(...obs.map((m) => m.enteredMs));
  const imaturo = nowMs - youngest < CONFIRMACAO_JANELA_HORAS * 3600_000;
  const partes: string[] = [];
  if (naoObs > 0) partes.push(`${naoObs}/${members.length} sem confirmação observável (fora do denominador)`);
  if (imaturo) partes.push(`coorte com menos de ${CONFIRMACAO_JANELA_HORAS}h — contagem parcial`);
  return {
    r: rate("confirmacao", janela, src, confirmados, obs.length, imaturo ? "em-observacao" : "medido", partes.length ? partes.join("; ") : null),
    tardios: comInstante > 0 ? tardios : null,
  };
}

function entregaRate(members: readonly Member[], nowMs: number, src: FunnelSourceStatus): FunnelRate {
  const janela = `≥1 edição recebida até o frescor da fonte — maturação ${ENTREGA_JANELA_DIAS} dias (edição seg-sex)`;
  if (!src.disponivel) return semDados("entrega", janela, src);
  const obs = members.filter((m) => m.p.entrega.observavel);
  if (obs.length === 0) return rate("entrega", janela, src, null, null, "nao-observavel", "nenhum membro com entrega observável");
  const n = obs.filter((m) => m.p.entrega.observavel && m.p.entrega.edicoesRecebidas >= 1).length;
  const youngest = Math.max(...obs.map((m) => m.enteredMs));
  const imaturo = nowMs - youngest < ENTREGA_JANELA_DIAS * DAY_MS;
  const naoObs = members.length - obs.length;
  const partes: string[] = [];
  if (naoObs > 0) partes.push(`${naoObs}/${members.length} sem entrega observável (fora do denominador)`);
  if (imaturo) partes.push(`coorte com menos de ${ENTREGA_JANELA_DIAS} dias — contagem parcial`);
  return rate("entrega", janela, src, n, obs.length, imaturo ? "em-observacao" : "medido", partes.length ? partes.join("; ") : null);
}

function primeiroCliqueRate(members: readonly Member[], segmento: FunnelSegmento, nowMs: number, src: FunnelSourceStatus): FunnelRate {
  const janela = `primeiro-clique-14d (ativacao-coorte.ts): ≥1 clique em edição ≤${PRIMEIRO_CLIQUE_JANELA_DIAS} dias do cadastro ÷ recebeu ≥1 edição`;
  if (!src.disponivel) return semDados("primeiro-clique-14d", janela, src);
  if (segmento === "migrado") {
    return rate(
      "primeiro-clique-14d",
      janela,
      src,
      null,
      null,
      "nao-observavel",
      "migração em massa (utm_channel=import) fica fora da definição de primeiro-clique-14d (isBulkImport)",
    );
  }
  const inputs: AtivacaoCoorteSubscriberInput[] = [];
  for (const m of members) {
    const e = m.p.engajamento;
    const ent = m.p.entrega;
    if (!e.observavel || !ent.observavel) continue;
    const clickMs = parseMs(e.primeiroCliqueEm);
    inputs.push({
      email: m.p.email,
      created: Math.floor(m.enteredMs / 1000),
      utm_source: m.p.utmSource,
      utm_medium: m.p.utmMedium,
      utm_channel: m.p.utmChannel,
      referring_site: m.p.referringSite,
      recebeuAoMenosUma: ent.edicoesRecebidas >= 1,
      primeiraEdicaoDadosDisponiveis: true,
      abriuPrimeiraEdicao: false,
      diasAtePrimeiroClique: clickMs == null ? null : Math.max(0, (clickMs - m.enteredMs) / DAY_MS),
    });
  }
  if (inputs.length === 0) {
    return rate("primeiro-clique-14d", janela, src, null, null, "nao-observavel", "nenhum membro com engajamento observável");
  }
  const r = computePrimeiroClique14d(inputs, Math.floor(nowMs / 1000));
  if (r.qualidade === "indeterminado") {
    // `denom > 0` + indeterminado = coorte imatura (o único caso possível
    // aqui: `primeiraEdicaoDadosDisponiveis` é sempre `true` vindo do store).
    // `denom === 0` = ninguém recebeu edição — ausência medida, não falta de dado.
    if (r.denom > 0) return rate("primeiro-clique-14d", janela, src, null, r.denom, "em-observacao", r.motivo);
    return rate("primeiro-clique-14d", janela, src, 0, 0, "medido", r.motivo);
  }
  const numerador = Math.round((r.valor ?? 0) * r.denom);
  return rate("primeiro-clique-14d", janela, src, numerador, r.denom, "medido", r.motivo);
}

function leitorRate(members: readonly Member[], nowMs: number, src: FunnelSourceStatus): FunnelRate {
  const t = LEITOR_V1_THRESHOLDS;
  const janela = `leitor-v1 (leitor.ts): status active, ≥${t.receivedMin} recebidas, CTR ≥${t.ctrMinPct}% — maturação ${LEITOR_V1_MATURACAO_DIAS} dias`;
  if (!src.disponivel) return semDados("leitor-v1", janela, src);
  const obs = members.filter((m) => m.p.engajamento.observavel);
  if (obs.length === 0) return rate("leitor-v1", janela, src, null, null, "nao-observavel", "nenhum membro com engajamento observável");
  const youngest = Math.max(...obs.map((m) => m.enteredMs));
  if (nowMs - youngest < LEITOR_V1_MATURACAO_DIAS * DAY_MS) {
    return rate(
      "leitor-v1",
      janela,
      src,
      null,
      obs.length,
      "em-observacao",
      `coorte com menos de ${LEITOR_V1_MATURACAO_DIAS} dias — leitor-v1 é zero por construção antes de ${t.receivedMin} recebidas`,
    );
  }
  const n = obs.filter((m) => m.p.engajamento.observavel && isLeitorV1(m.p.engajamento.leitor)).length;
  return rate("leitor-v1", janela, src, n, obs.length, "medido", null);
}

// ---------------------------------------------------------------------------
// Preparação comum (exclusões + dedup + classificação)
// ---------------------------------------------------------------------------

interface Prepared {
  members: Member[];
  resumo: FunnelSummary;
}

function prepare(people: readonly FunnelPersonInput[]): Prepared {
  const { people: deduped, duplicatasFundidas } = dedupePeople(people);
  const { kept, removedCount } = filterInternalAndTestSubscribers(deduped);
  const members: Member[] = [];
  let semData = 0;
  let semAtribuicao = 0;
  let migrados = 0;
  let reativados = 0;
  for (const p of kept) {
    const enteredMs = parseMs(p.enteredAt);
    if (enteredMs == null) {
      semData++;
      continue;
    }
    const classe = classifyAcquisition({
      utm_source: p.utmSource,
      utm_medium: p.utmMedium,
      utm_channel: p.utmChannel,
      referring_site: p.referringSite,
      created: Math.floor(enteredMs / 1000),
    });
    const dia = unixSecondsToBrtDate(Math.floor(enteredMs / 1000));
    const segmento = resolveSegmento(p, classe, dia);
    if (segmento === "migrado") migrados++;
    if (segmento === "reativado") reativados++;
    if (clean(p.utmSource) == null && clean(p.referringSite) == null) semAtribuicao++;
    members.push({ p, enteredMs, dia, classe, segmento });
  }
  return {
    members,
    resumo: {
      pessoasRecebidas: people.length,
      duplicatasFundidas,
      internasOuTesteExcluidas: removedCount,
      semDataDeCadastro: semData,
      semAtribuicao,
      migrados,
      reativados,
    },
  };
}

// ---------------------------------------------------------------------------
// Relatório de coortes
// ---------------------------------------------------------------------------

/**
 * Coortes de aquisição × origem/campanha/destino, cada uma com as 4 etapas
 * separadas. Ordenado por período ascendente, depois cadastros desc. @pure
 */
export function buildChannelCohortFunnel(people: readonly FunnelPersonInput[], opts: FunnelOptions): ChannelCohortFunnel {
  const nowMs = parseMs(opts.now);
  if (nowMs == null) throw new Error(`[channel-cohort-funnel] opts.now inválido: "${opts.now}"`);
  const granularidade = opts.granularidade ?? "semana";
  const porCampanha = opts.porCampanha ?? true;
  const porDestino = opts.porDestino ?? true;
  const { members, resumo } = prepare(people);

  type GroupKey = Pick<FunnelCohortRow, "periodo" | "origem" | "campanha" | "destino" | "segmento" | "atribuido" | "classe">;
  const groups = new Map<string, { key: GroupKey; members: Member[] }>();
  for (const m of members) {
    const periodo = granularidade === "dia" ? m.dia : mondayOf(m.dia);
    const origem = clean(m.p.utmSource);
    const campanha = porCampanha ? clean(m.p.utmCampaign) : null;
    const destino = porDestino ? clean(m.p.destino) : null;
    const segmento = m.segmento;
    const atribuido = origem != null || clean(m.p.referringSite) != null;
    const k = [periodo, origem ?? "", campanha ?? "", destino ?? "", segmento, m.classe].join("|");
    let g = groups.get(k);
    if (!g) {
      g = { key: { periodo, origem, campanha, destino, segmento, atribuido, classe: m.classe }, members: [] };
      groups.set(k, g);
    }
    g.members.push(m);
  }

  const rows: FunnelCohortRow[] = [];
  for (const g of groups.values()) {
    const youngest = Math.max(...g.members.map((m) => m.enteredMs));
    const { r: confirmacao, tardios } = confirmacaoRate(g.members, nowMs, opts.fontes.confirmacao);
    const entrega = entregaRate(g.members, nowMs, opts.fontes.entrega);
    const primeiroClique14d = primeiroCliqueRate(g.members, g.key.segmento, nowMs, opts.fontes.engajamento);
    const leitorV1 = leitorRate(g.members, nowMs, opts.fontes.engajamento);
    const etapas = [confirmacao, entrega, primeiroClique14d, leitorV1];
    rows.push({
      ...g.key,
      idadeDias: Math.max(0, Math.floor((nowMs - youngest) / DAY_MS)),
      emObservacao: etapas.some((e) => e.estado === "em-observacao"),
      cobertura: g.members.every((m) => m.dia >= KIT_SERIES_FLOOR)
        ? "kit"
        : g.members.every((m) => m.dia < KIT_SERIES_FLOOR)
          ? "pre-kit"
          : "mista",
      cadastrosAceitos: g.members.length,
      confirmacao,
      confirmadosTardios: tardios,
      entrega,
      primeiroClique14d,
      leitorV1,
    });
  }
  rows.sort((a, b) => (a.periodo === b.periodo ? b.cadastrosAceitos - a.cadastrosAceitos : a.periodo < b.periodo ? -1 : 1));
  return { geradoEm: opts.now, granularidade, fontes: opts.fontes, resumo, rows };
}

// ---------------------------------------------------------------------------
// Custo por confirmado / por leitor — só com população da MESMA coorte
// ---------------------------------------------------------------------------

export interface CohortSpendInput {
  canal: string;
  /** `utm_source` que os anúncios do canal escrevem (`CHANNEL_KEY_SPECS`). */
  origens: readonly string[];
  /** Janela do gasto, `YYYY-MM-DD` BRT inclusivos. */
  de: string;
  ate: string;
  gasto: number;
  fonte: string;
  frescor: string | null;
  /** Limitação do próprio número de gasto, repassada ao resultado (ex.: sem
   *  linha-base antes da janela — o gasto é o acumulado desde o 1º registro
   *  do braço, e só é da mesma coorte se o braço começou dentro da janela). */
  ressalvaGasto?: string | null;
}

export type CohortCostEstado = "calculado" | "parcial" | "indisponivel";

export interface CohortCostResult {
  canal: string;
  de: string;
  ate: string;
  gasto: number;
  fonte: string;
  frescor: string | null;
  /** Cadastros NOVOS da origem com cadastro dentro de [de, ate] — mesma
   *  população e mesma janela do gasto. */
  populacao: number;
  /** Migrados/reativados da mesma origem e janela, FORA da população (não
   *  são aquisição nova). */
  excluidosNaoNovos: number;
  custoPorCadastro: number | null;
  confirmados: number | null;
  custoPorConfirmado: number | null;
  /** `teto` quando parte da população não tem estado DOI legível (contada
   *  como não confirmada — o custo real só pode ser menor). */
  custoPorConfirmadoQualidade: "exato" | "teto" | null;
  motivoConfirmado: string | null;
  leitores: number | null;
  custoPorLeitor: number | null;
  motivoLeitor: string | null;
  estado: CohortCostEstado;
  motivo: string | null;
}

/**
 * Custo da coorte do gasto: população = pessoas NOVAS cuja origem está em
 * `spend.origens` E cujo cadastro (dia BRT) cai em [de, ate]. Nunca divide
 * gasto de um período por assinantes de outro. Cada custo sai `null` com
 * motivo quando a etapa não pode ser atribuída à mesma população inteira
 * (confirmação não observável em parte dela, coorte imatura, população
 * vazia = gasto sem correspondência). @pure
 */
export function computeCohortCost(
  people: readonly FunnelPersonInput[],
  spend: CohortSpendInput,
  opts: { now: string; fontes: FunnelSources },
): CohortCostResult {
  const nowMs = parseMs(opts.now);
  if (nowMs == null) throw new Error(`[channel-cohort-funnel] opts.now inválido: "${opts.now}"`);
  const base = {
    canal: spend.canal,
    de: spend.de,
    ate: spend.ate,
    gasto: spend.gasto,
    fonte: spend.fonte,
    frescor: spend.frescor,
  };
  const indisponivel = (motivo: string, populacao = 0, excluidos = 0): CohortCostResult => ({
    ...base,
    populacao,
    excluidosNaoNovos: excluidos,
    custoPorCadastro: null,
    confirmados: null,
    custoPorConfirmado: null,
    custoPorConfirmadoQualidade: null,
    motivoConfirmado: motivo,
    leitores: null,
    custoPorLeitor: null,
    motivoLeitor: motivo,
    estado: "indisponivel",
    motivo,
  });

  if (!Number.isFinite(spend.gasto) || spend.gasto < 0) return indisponivel(`gasto inválido (${spend.gasto})`);
  const hojeBrt = unixSecondsToBrtDate(Math.floor(nowMs / 1000));
  if (spend.ate >= hojeBrt) return indisponivel(`janela do gasto inclui o dia em curso (${spend.ate} ≥ ${hojeBrt}) — gasto parcial`);
  if (spend.de > spend.ate) return indisponivel(`janela inválida (${spend.de} > ${spend.ate})`);
  if (!opts.fontes.cadastro.disponivel) {
    return indisponivel(opts.fontes.cadastro.motivo ?? `fonte de cadastro ${opts.fontes.cadastro.fonte} indisponível`);
  }

  const keys = new Set(spend.origens.map(normalizeKey));
  const { members } = prepare(people);
  const naJanela = members.filter((m) => {
    if (!keys.has(normalizeKey(m.p.utmSource))) return false;
    return m.dia >= spend.de && m.dia <= spend.ate;
  });
  const pop = naJanela.filter((m) => m.segmento === "novo");
  const excluidos = naJanela.length - pop.length;
  if (pop.length === 0) {
    return indisponivel(
      `gasto sem correspondência: nenhum cadastro novo com utm_source ∈ {${spend.origens.join(", ")}} entre ${spend.de} e ${spend.ate}`,
      0,
      excluidos,
    );
  }

  const endOfAteMs = Date.parse(`${spend.ate}T23:59:59.999-03:00`);
  const custoPorCadastro = spend.gasto / pop.length;

  let confirmados: number | null = null;
  let motivoConfirmado: string | null = null;
  const naoObsConf = pop.filter((m) => !m.p.confirmacao.observavel).length;
  if (!opts.fontes.confirmacao.disponivel) {
    motivoConfirmado = opts.fontes.confirmacao.motivo ?? "fonte de confirmação indisponível";
  } else if (naoObsConf === pop.length) {
    motivoConfirmado = "nenhum membro da população tem confirmação observável (DOI só existe no Kit)";
  } else if (nowMs - endOfAteMs < CONFIRMACAO_JANELA_HORAS * 3600_000) {
    motivoConfirmado = `coorte em observação: último dia da janela tem menos de ${CONFIRMACAO_JANELA_HORAS}h`;
  } else {
    confirmados = pop.filter((m) => m.p.confirmacao.observavel && m.p.confirmacao.confirmado).length;
    if (confirmados === 0) {
      motivoConfirmado = "nenhum confirmado na população — custo por confirmado indefinido (não é infinito nem zero)";
    } else if (naoObsConf > 0) {
      // Membro sem estado DOI legível (ex.: Kit `cancelled`) PODE ter
      // confirmado antes de sair — contá-lo como não confirmado só pode
      // subestimar `confirmados`, então o custo vira um TETO, declarado.
      motivoConfirmado =
        `${naoObsConf}/${pop.length} da população sem estado DOI observável, contados como não confirmados — ` +
        "custo por confirmado é TETO (o real só pode ser menor)";
    }
  }

  let leitores: number | null = null;
  let motivoLeitor: string | null = null;
  const naoObsEng = pop.filter((m) => !m.p.engajamento.observavel).length;
  if (!opts.fontes.engajamento.disponivel) {
    motivoLeitor = opts.fontes.engajamento.motivo ?? "fonte de engajamento indisponível";
  } else if (naoObsEng > 0) {
    motivoLeitor = `${naoObsEng}/${pop.length} da população sem engajamento observável`;
  } else if (nowMs - endOfAteMs < LEITOR_V1_MATURACAO_DIAS * DAY_MS) {
    motivoLeitor = `coorte em observação: leitor-v1 só matura ${LEITOR_V1_MATURACAO_DIAS} dias após o último cadastro da janela`;
  } else {
    leitores = pop.filter((m) => m.p.engajamento.observavel && isLeitorV1(m.p.engajamento.leitor)).length;
    if (leitores === 0) motivoLeitor = "nenhum leitor-v1 na população — custo por leitor indefinido (não é infinito nem zero)";
  }

  const custoPorConfirmado = confirmados != null && confirmados > 0 ? spend.gasto / confirmados : null;
  const custoPorConfirmadoQualidade = custoPorConfirmado == null ? null : naoObsConf > 0 ? "teto" : "exato";
  const custoPorLeitor = leitores != null && leitores > 0 ? spend.gasto / leitores : null;
  const completo =
    custoPorConfirmadoQualidade === "exato" && custoPorLeitor != null && !spend.ressalvaGasto;
  return {
    ...base,
    populacao: pop.length,
    excluidosNaoNovos: excluidos,
    custoPorCadastro,
    confirmados,
    custoPorConfirmado,
    custoPorConfirmadoQualidade,
    motivoConfirmado,
    leitores,
    custoPorLeitor,
    motivoLeitor,
    estado: completo ? "calculado" : "parcial",
    motivo: completo
      ? null
      : [spend.ressalvaGasto ?? null, motivoConfirmado, motivoLeitor].filter(Boolean).join("; ") || null,
  };
}

// ---------------------------------------------------------------------------
// Gasto da MESMA janela — derivado do relatório de 3 dias, sem alterá-lo
// ---------------------------------------------------------------------------

/**
 * Monta 1 `CohortSpendInput` por canal pago com spec não-ambígua em
 * `CHANNEL_KEY_SPECS`, usando `computeRollingWindow` (a MESMA aritmética do
 * relatório de 3 dias — `último − linha anterior à janela`) para o gasto de
 * [ate − dias + 1, ate]. Canal sem linha no CSV fica de fora (nada a
 * atribuir); canal cujo CSV não cobre o último dia da janela entra com
 * `cobreUltimoDia: false` para o chamador avisar. @pure
 */
export function buildCohortSpendInputs(
  rows: readonly ClicksCsvRow[],
  opts: { ate: string; dias: number; specs?: readonly ChannelKeySpec[]; fonte: string },
): Array<CohortSpendInput & { cobreUltimoDia: boolean }> {
  const specs = opts.specs ?? CHANNEL_KEY_SPECS;
  const byCanal = new Map<string, string[]>();
  for (const s of specs) {
    if (s.ambigua) continue;
    byCanal.set(s.canal, [...(byCanal.get(s.canal) ?? []), ...s.keys]);
  }
  const canais = new Set(rows.map((r) => r.canal));
  const out: Array<CohortSpendInput & { cobreUltimoDia: boolean }> = [];
  for (const [canal, origens] of byCanal) {
    if (!canais.has(canal)) continue;
    const w = computeRollingWindow([...rows], { canal, ate: opts.ate, dias: opts.dias });
    const de = shiftDate(opts.ate, -(opts.dias - 1));
    out.push({
      canal,
      origens,
      de,
      ate: opts.ate,
      gasto: w.gastoJanela,
      fonte: opts.fonte,
      frescor: w.dias.at(-1) ?? null,
      ressalvaGasto:
        w.baseData == null && w.dias.length > 0
          ? `sem linha de apuração antes de ${de}: o gasto é o acumulado desde o 1º registro do braço (${w.dias[0]}) — ` +
            `só é da mesma coorte se o braço começou dentro da janela`
          : null,
      cobreUltimoDia: w.dias.at(-1) === opts.ate,
    });
  }
  return out;
}
