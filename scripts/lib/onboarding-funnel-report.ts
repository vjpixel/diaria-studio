/**
 * onboarding-funnel-report.ts (#7917)
 *
 * Camada de leitura PURA (sem I/O) que reconstrói, por assinante e por
 * coorte, em que passo do funil de onboarding cada leitor está — objetivo
 * declarado da issue: "tornar visível quantos leitores chegam a cada passo
 * e quais convites aguardam ação humana, preservando o envio supervisionado
 * existente". Isto NUNCA decide nem executa nada — é só reconciliação de
 * leitura sobre o estado já gravado por `onboarding-state.ts`/
 * `onboarding-store.ts` (transporte Brevo, #5908/#7599) e
 * `onboarding-kit-transport.ts` (transporte Kit, #7922).
 *
 * ## Por que isto existe (e por que não é o #7922)
 *
 * `campaign_created` (Brevo) e o lote Kit `created`/`pending` só confirmam
 * PREPARAÇÃO do convite D+10 — nunca envio, entrega ou conversão (issue,
 * corpo). Sem reconciliar contra o estado VIVO da plataforma (via
 * `resolveBrevoCampaignState`/`mapKitBroadcastStatusToLocal`, ambos já
 * existentes), um rascunho esquecido há semanas parece idêntico a um
 * rascunho criado ontem. Este módulo faz essa distinção; quem cria/agenda/
 * cancela broadcasts é o #7922 (`onboarding-kit-transport-run.ts`) e quem
 * cria/agenda campanhas Brevo é `onboarding-welcome-run.ts` — nenhum dos
 * dois muda aqui.
 *
 * ## Coexistência Brevo/Kit sem contar a mesma pessoa 2x
 *
 * Uma entrada do store (`OnboardingEntry`) é a UNIDADE — nunca uma
 * campanha/lote. O provider de cada etapa é resolvido por EVIDÊNCIA
 * presente na própria entrada (id Brevo transacional) ou por MEMBRO DE LOTE
 * KIT (`findKitLotForEntry`) — nunca inferido do backend de detecção atual
 * (`last_detection_backend` é sobre QUEM DETECTOU o assinante, não sobre
 * QUEM TRANSPORTOU um e-mail específico; #7922 documenta que entradas
 * iniciadas na Brevo terminam na Brevo mesmo após o corte).
 *
 * ## Nunca fabricar dado (issue, item 3 do "O que construir")
 *
 * Toda ausência de evidência vira um estado explícito
 * (`"aguardando_confirmacao"`, `"aguardando_dados"`, `"falha_consulta"`) —
 * nunca `0`/`null` silencioso disfarçado de "não aconteceu". Em particular:
 * - `brevoQueryFailed: true` produz `"falha_consulta"`, nunca degrada pra
 *   `"rascunho_criado"` (que afirmaria "ainda é rascunho", uma leitura tão
 *   forte quanto errada quando a consulta simplesmente não respondeu).
 * - Sem `apoiadorIndex` injetado, `apoiador` fica `null` (motivo:
 *   `"sem_indice"`), nunca `{ linked: false }` (que afirmaria "checamos e
 *   não é apoiador").
 *
 * ## Fronteira com #7916/#7918 (clique → pagamento)
 *
 * Este módulo reusa `linkSubscriberToApoiador`/`LinkableApoiador`
 * (`scripts/lib/metrics/apoiador-link.ts`, #7916 fatia 5/N) para o vínculo
 * e-mail → apoiador confirmado — não duplica essa lógica. O que ele NÃO
 * tem: rastreamento de CLIQUE no convite D+10 especificamente (distinto do
 * clique numa edição normal) — nenhuma API (Brevo/Kit) hoje expõe isso por
 * destinatário de campanha de forma barata, e inventar essa métrica sem
 * fonte seria a fabricação que este módulo existe pra evitar. O resumo
 * agregado (`OnboardingCohortComparison`) documenta esse campo como
 * `cliquesRastreados: null` — lacuna de atribuição explícita, não omissão
 * silenciosa (issue, "Ligar cliques e pagamentos... sem assumir que todo
 * pagamento posterior foi causado pelo convite" — este módulo não afirma
 * causalidade em nenhum sentido: relata coocorrência de coorte, ponto).
 */

import type { OnboardingEntry } from "./onboarding-store.ts";
import { findKitLotForEntry, type OnboardingKitLot, type OnboardingKitLotKind, type OnboardingKitLotStatus } from "./onboarding-kit-transport.ts";
import { reguaAnchorSec, dueForEmail2 } from "./onboarding-state.ts";
import { resolveBrevoCampaignState, type BrevoCampaignLike } from "./publish-state.ts";
import { linkSubscriberToApoiador, daysBetweenIso, type LinkableApoiador } from "./metrics/apoiador-link.ts";

const DAY_S = 86_400;

/** Rascunho/lote aberto por ≥ N dias sem ser agendado/enviado é "parado" —
 *  critério de atraso documentado (issue: "critério de atraso documentado",
 *  item 2 dos critérios de aceite). Escolhido como metade do intervalo
 *  D+3→D+10 — não uma medição formal, sinalizado aqui pra ser ajustado com
 *  dado real quando houver. */
export const STALE_DRAFT_DAYS = 3;

export type OnboardingProvider = "brevo" | "kit";

// ---------------------------------------------------------------------------
// Etapas transacionais (e-mail 1 / e-mail 2)
// ---------------------------------------------------------------------------

export type OnboardingTransactionalStepState = "not_reached" | "sent" | "blocked_not_active";

export interface OnboardingTransactionalStepInfo {
  state: OnboardingTransactionalStepState;
  sentAt: string | null;
  /** Id do envio transacional Brevo (`email{1,2}_brevo_id`). `null` quando
   *  ainda não enviado. Sem ramo Kit aqui — não porque #7922 exclua
   *  email1/email2 (`OnboardingKitLotKind` cobre os 3: `email1`, `email2`,
   *  `email3`, e `onboarding-kit-transport-run.ts` monta lotes pros 3), mas
   *  porque desde o #9014 o executor Kit grava `email{1,2}_sent_at` direto
   *  na `OnboardingEntry` (via `applyKitLotToEntries`) — `sentAt` já cobre o
   *  envio Kit, e o lote fica em `email{1,2}_kit_lot_id`. Só o e-mail 3
   *  reconcilia pelo lote aqui (`findKitLotForEntry`, ver `buildEmail3Info`). */
  brevoMessageId: string | null;
}

function buildTransactionalStep(
  sentAt: string | null,
  brevoId: string | null,
  blockedNotActive: boolean,
): OnboardingTransactionalStepInfo {
  if (sentAt != null) return { state: "sent", sentAt, brevoMessageId: brevoId };
  if (blockedNotActive) return { state: "blocked_not_active", sentAt: null, brevoMessageId: null };
  return { state: "not_reached", sentAt: null, brevoMessageId: null };
}

// ---------------------------------------------------------------------------
// E-mail 3 (D+10) — a etapa com ramificação real
// ---------------------------------------------------------------------------

export type OnboardingEmail3Stage =
  | "aguardando_confirmacao"
  | "not_due"
  | "aguardando_dados"
  | "rascunho_criado"
  | "agendado"
  | "enviado"
  | "cancelado"
  | "skipped_no_open"
  | "skipped_inactive"
  | "skipped_sem_dados"
  | "falha_consulta"
  /** #7917 item 4 (fleet review PR #8955): Brevo devolveu um status ambíguo
   *  (`suspended`/`in_review`, ambos mapeados pra `PublishState = "unknown"`
   *  por `resolveBrevoCampaignState`) — `resolveBrevoCampaignState` NUNCA
   *  promove isso a `"published"`/`"scheduled"`, mas colapsar junto de
   *  `"rascunho_criado"` escondia que o estado é anormal e pede investigação
   *  humana, não só "aguardar ação de agendar/enviar" como um rascunho
   *  comum. */
  | "estado_ambiguo";

export interface OnboardingEmail3Info {
  stage: OnboardingEmail3Stage;
  provider: OnboardingProvider | null;
  /** Id da campanha Brevo (`entry.email3_campaign_id`) ou do broadcast Kit
   *  (`OnboardingKitLot.broadcast_id`) — ambos `number | null` na origem;
   *  nenhum branch produz `string` aqui. */
  campaignOrBroadcastId: number | null;
  /** ISO — quando o rascunho/lote nasceu (`email3_decided_at` ou
   *  `OnboardingKitLot.created_at`). `null` quando a etapa ainda não
   *  produziu artefato nenhum. */
  createdAt: string | null;
  /** Dias inteiros desde `createdAt` até `nowSec` injetado — `null` sem
   *  `createdAt`. */
  ageDays: number | null;
  /** `true` quando `stage` é `"rascunho_criado"`/`"agendado"` E
   *  `ageDays >= STALE_DRAFT_DAYS` — "aguardando ação humana há tempo
   *  demais" (issue: "rascunhos pendentes mostram idade e próxima ação"). */
  stale: boolean;
  /** Texto curto, pro editor — nunca vazio. */
  nextAction: string;
}

function ageDaysSince(iso: string | null, nowSec: number): number | null {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((nowSec - ms / 1000) / DAY_S);
}

function terminalEmail3(stage: OnboardingEmail3Stage, nextAction: string): OnboardingEmail3Info {
  return { stage, provider: null, campaignOrBroadcastId: null, createdAt: null, ageDays: null, stale: false, nextAction };
}

function kitLotStatusToEmail3Stage(status: OnboardingKitLotStatus): OnboardingEmail3Stage {
  switch (status) {
    case "pending":
    case "created":
      return "rascunho_criado";
    case "scheduled":
      return "agendado";
    case "completed":
      return "enviado";
    case "cancelled":
      return "cancelado";
  }
}

/** #8979: `findKitLotForEntry` mudou de dono — agora vive em
 *  `onboarding-kit-transport.ts` (junto do tipo `OnboardingKitLot` que
 *  define), porque `onboarding-state.ts` passou a precisar dela também
 *  (§6.3 do corte, mecanizado) e já é importada POR este módulo — um
 *  import de volta daqui criaria ciclo. Re-exportado para não quebrar
 *  `studio-onboarding.ts`/testes existentes que importam daqui. */
export { findKitLotForEntry } from "./onboarding-kit-transport.ts";

export interface Email3ResolutionInput {
  nowSec: number;
  email3Days: number;
  email3GraceDays: number;
  kitLots: readonly OnboardingKitLot[];
  /** Estado vivo da campanha Brevo (`GET /v3/emailCampaigns/{id}`), já
   *  resolvido pelo caller — este módulo nunca chama rede. `undefined` =
   *  consulta não tentada nesta rodada (degrada pra tratar como rascunho,
   *  nunca promove a enviado sem confirmação). */
  brevoCampaignState?: BrevoCampaignLike | null;
  /** `true` quando o caller TENTOU consultar a Brevo e falhou (rede, 4xx/5xx)
   *  — produz `"falha_consulta"` explícito, nunca cai no default de
   *  rascunho (issue, critério de aceite: "uma falha de consulta" precisa
   *  ser um dos estados cobertos por teste). */
  brevoQueryFailed?: boolean;
}

/** Nunca alcançável em runtime se `OnboardingEmail3State` continuar
 *  exaustivamente coberto pelo `switch` de `buildEmail3Info` — o compilador
 *  recusa a build se um novo membro do union for adicionado sem um `case`
 *  correspondente (#7917 item 6, fleet review PR #8955). */
function assertNeverEmail3State(state: never): never {
  throw new Error(`[onboarding-funnel-report] OnboardingEmail3State inesperado: ${JSON.stringify(state)}`);
}

function buildEmail3Info(entry: OnboardingEntry, input: Email3ResolutionInput): OnboardingEmail3Info {
  const { nowSec, email3Days, email3GraceDays, kitLots } = input;

  // #7917 item 7 (fleet review PR #8955): um lote Kit para email3, quando
  // presente, SEMPRE determina o estágio — independente de
  // `entry.email3_state`. Até o #9059 `onboarding-kit-transport-run.ts`
  // nunca escrevia `email3_state` de volta na entrada (desde então grava
  // `campaign_created` + `email3_kit_lot_id`; `email3_campaign_id` segue
  // Brevo-only) — e lotes anteriores ao fix, ou marcação perdida, ainda podem
  // existir com `email3_state` `"pending"` e ficariam invisíveis se esta checagem só rodasse dentro do
  // branch `"campaign_created"` (como antes deste fix). Quando AMBOS
  // existem (campanha Brevo local + lote Kit pra mesma entrada), o lote Kit
  // vence — mesma precedência que já existia, agora também válida quando
  // `email3_state` é `"pending"`.
  const kitLot = findKitLotForEntry(kitLots, "email3", entry.subscription_id);
  // #9151 item 3: desde o #9059, cancelar o lote Kit devolve a entrada a
  // `pending` e a Brevo pode criar um rascunho PRÓPRIO. Lote Kit cancelado só
  // vence quando a entrada não tem estado Brevo a mostrar — com `pending` ou
  // com uma campanha Brevo (`email3_campaign_id`), o estado da entrada é o
  // que pede ação, e "cancelado — nenhuma" esconderia isso.
  const cancelledKitYieldsToEntry =
    kitLot != null &&
    kitLot.status === "cancelled" &&
    (entry.email3_state === "pending" || (entry.email3_state === "campaign_created" && entry.email3_campaign_id != null));
  if (kitLot != null && !cancelledKitYieldsToEntry) {
    const stage = kitLotStatusToEmail3Stage(kitLot.status);
    const age = ageDaysSince(kitLot.created_at, nowSec);
    const stale = (stage === "rascunho_criado" || stage === "agendado") && age != null && age >= STALE_DRAFT_DAYS;
    const nextAction =
      stage === "enviado"
        ? "nenhuma — já enviado (Kit)"
        : stage === "agendado"
          ? "nenhuma — agendado no Kit, aguardando disparo"
          : stage === "cancelado"
            ? "nenhuma — lote cancelado"
            : stale
              ? `lote Kit parado há ${age} dia(s) sem agendar/enviar — revisar broadcast ${kitLot.broadcast_id ?? "(sem id ainda)"}`
              : "aguardar ação humana de agendar/enviar o broadcast Kit";
    return { stage, provider: "kit", campaignOrBroadcastId: kitLot.broadcast_id, createdAt: kitLot.created_at, ageDays: age, stale, nextAction };
  }

  switch (entry.email3_state) {
    case "skipped_no_open":
      return terminalEmail3("skipped_no_open", "nenhuma — decisão terminal (#7599): zero abertura em D+10 não recebe e-mail 3.");
    case "skipped_inactive":
      return terminalEmail3("skipped_inactive", "nenhuma — assinante não estava ativo quando a decisão foi tomada.");
    case "skipped_sem_dados":
      return terminalEmail3("skipped_sem_dados", "nenhuma — stats de abertura nunca ficaram disponíveis dentro da janela de tolerância.");

    case "campaign_created": {
      // Sem lote Kit (checado acima) → o transporte foi Brevo (campanha clássica, #5908/#7599).
      const createdAt = entry.email3_decided_at;
      const age = ageDaysSince(createdAt, nowSec);
      if (input.brevoQueryFailed) {
        return {
          stage: "falha_consulta",
          provider: "brevo",
          campaignOrBroadcastId: entry.email3_campaign_id,
          createdAt,
          ageDays: age,
          stale: false,
          nextAction: "reconsultar a Brevo (última consulta falhou) antes de agendar/enviar",
        };
      }
      const publishState = input.brevoCampaignState ? resolveBrevoCampaignState(input.brevoCampaignState) : "draft";
      if (publishState === "published") {
        return { stage: "enviado", provider: "brevo", campaignOrBroadcastId: entry.email3_campaign_id, createdAt, ageDays: age, stale: false, nextAction: "nenhuma — já enviado (Brevo)" };
      }
      if (publishState === "scheduled") {
        return { stage: "agendado", provider: "brevo", campaignOrBroadcastId: entry.email3_campaign_id, createdAt, ageDays: age, stale: false, nextAction: "nenhuma — agendado na Brevo (queued), aguardando disparo" };
      }
      if (publishState === "unknown") {
        // #7917 item 4: Brevo devolveu status ambíguo (suspended/in_review)
        // — `resolveBrevoCampaignState` já garante que isso NUNCA promove a
        // enviado/agendado, mas colapsar no mesmo bucket de "rascunho_criado"
        // escondia que o estado é anormal e pede investigação humana antes
        // de qualquer ação, não só "aguardar agendar/enviar" como um
        // rascunho comum.
        const stale = age != null && age >= STALE_DRAFT_DAYS;
        return {
          stage: "estado_ambiguo",
          provider: "brevo",
          campaignOrBroadcastId: entry.email3_campaign_id,
          createdAt,
          ageDays: age,
          stale,
          nextAction: `Brevo devolveu estado ambíguo (suspended/in_review) — investigar antes de agendar (campanha ${entry.email3_campaign_id ?? "?"})`,
        };
      }
      // publishState === "draft" (local, sem live data, ou consulta não tentada nesta rodada).
      const stale = age != null && age >= STALE_DRAFT_DAYS;
      return {
        stage: "rascunho_criado",
        provider: "brevo",
        campaignOrBroadcastId: entry.email3_campaign_id,
        createdAt,
        ageDays: age,
        stale,
        nextAction: stale
          ? `rascunho Brevo parado há ${age} dia(s) — agendar/enviar manualmente (campanha ${entry.email3_campaign_id ?? "?"})`
          : "aguardar ação humana de agendar/enviar a campanha Brevo",
      };
    }

    case "pending": {
      const anchor = reguaAnchorSec(entry);
      if (anchor == null) {
        return terminalEmail3("aguardando_confirmacao", "nenhuma — aguardando confirmação de assinatura (double opt-in) antes da régua D+10 começar a contar.");
      }
      const dueAtSec = anchor + email3Days * DAY_S;
      if (nowSec < dueAtSec) {
        const diasFaltando = Math.ceil((dueAtSec - nowSec) / DAY_S);
        return terminalEmail3("not_due", `nenhuma — D+10 ainda não venceu (faltam ${diasFaltando} dia(s)).`);
      }
      const toleranceEndSec = anchor + (email3Days + email3GraceDays) * DAY_S;
      const beyondTolerance = nowSec >= toleranceEndSec;
      return {
        stage: "aguardando_dados",
        provider: null,
        campaignOrBroadcastId: null,
        createdAt: null,
        ageDays: null,
        stale: beyondTolerance,
        nextAction: beyondTolerance
          ? "vencido além da janela de tolerância sem decisão — rodar o executor (onboarding-welcome-run.ts --send) ou investigar stats ausentes"
          : "nenhuma — D+10 venceu, aguardando dados de abertura da próxima rodada do executor",
      };
    }

    default:
      return assertNeverEmail3State(entry.email3_state);
  }
}

// ---------------------------------------------------------------------------
// Entrada consolidada por assinante
// ---------------------------------------------------------------------------

export interface OnboardingApoiadorLink {
  linked: boolean;
  firstConfirmedAt: string | null;
  /** `daysBetweenIso(detected_at, firstConfirmedAt)` — pode ser negativo
   *  (já apoiava antes de assinar, ver `apoiador-link.ts`); `null` sem
   *  vínculo ou data inválida. */
  daysToFirstApoio: number | null;
}

export interface OnboardingFunnelEntry {
  subscriptionId: string;
  email: string;
  /** Rótulo de recuperação manual (#7665/#7675/#7674) — presente = esta
   *  entrada NÃO nasceu da detecção automática e é excluída dos agregados
   *  de funil por padrão (`summarizeOnboardingFunnel`). */
  seededBy: string | null;
  detectedAt: string;
  /** ISO da confirmação (âncora da régua) — `null` enquanto pendente. */
  confirmedAt: string | null;
  email1: OnboardingTransactionalStepInfo;
  email2: OnboardingTransactionalStepInfo;
  email3: OnboardingEmail3Info;
  /** `null` quando `apoiadorIndex` não foi injetado (issue: nunca fabricar
   *  `{ linked: false }` como se a checagem tivesse ocorrido). */
  apoiador: OnboardingApoiadorLink | null;
}

export interface BuildFunnelEntryOptions extends Email3ResolutionInput {
  apoiadorIndex?: ReadonlyMap<string, LinkableApoiador>;
  /** Dias até o e-mail 2 vencer (mesmo default de `dueForEmail2`/`onboarding-state.ts`). */
  email2Days?: number;
}

export function buildOnboardingFunnelEntry(entry: OnboardingEntry, opts: BuildFunnelEntryOptions): OnboardingFunnelEntry {
  const anchor = reguaAnchorSec(entry);
  const confirmedAt = anchor != null ? new Date(anchor * 1000).toISOString() : null;
  const isNovo = entry.email1_sent_at == null && entry.email2_sent_at == null && entry.email3_state === "pending";

  const email1 = buildTransactionalStep(entry.email1_sent_at, entry.email1_brevo_id, isNovo && entry.status_detectado !== "active");
  // #7917 item 2 (fleet review PR #8955): antes, `email2Due` só checava
  // "tem âncora e ainda não enviado" — sem o gate de tempo de
  // `dueForEmail2` (nowSec >= anchor + email2Days*DAY_S), uma entrada
  // recém-confirmada e ainda inativa reportava `blocked_not_active` MUITO
  // antes de D+3 vencer de verdade. Reusa `dueForEmail2` (mesma régua que
  // `onboarding-state.ts` usa pra decidir o envio real) em vez de
  // reimplementar o cálculo aqui.
  const email2Due = dueForEmail2(entry, opts.nowSec, opts.email2Days ?? 3);
  const email2 = buildTransactionalStep(entry.email2_sent_at, entry.email2_brevo_id, email2Due && entry.status_detectado !== "active");

  const email3 = buildEmail3Info(entry, opts);

  let apoiador: OnboardingApoiadorLink | null = null;
  if (opts.apoiadorIndex) {
    const match = linkSubscriberToApoiador([entry.email], opts.apoiadorIndex);
    apoiador = match
      ? { linked: true, firstConfirmedAt: match.firstConfirmedAt, daysToFirstApoio: safeDaysBetween(entry.detected_at, match.firstConfirmedAt) }
      : { linked: false, firstConfirmedAt: null, daysToFirstApoio: null };
  }

  return {
    subscriptionId: entry.subscription_id,
    email: entry.email,
    seededBy: entry.seeded_by ?? null,
    detectedAt: entry.detected_at,
    confirmedAt,
    email1,
    email2,
    email3,
    apoiador,
  };
}

function safeDaysBetween(fromIso: string, toIso: string): number | null {
  const days = daysBetweenIso(fromIso, toIso);
  return Number.isNaN(days) ? null : days;
}

// ---------------------------------------------------------------------------
// Agregado por coorte
// ---------------------------------------------------------------------------

export interface OnboardingFunnelSummary {
  total: number;
  /** Entradas semeadas manualmente (#7665/#7675/#7674) — contadas aqui,
   *  excluídas do resto do agregado (issue: essas recuperações "mantêm suas
   *  próprias prioridades e execução", não devem inflar a métrica do funil
   *  automático). */
  seededExcluded: number;
  /** Contagem por `email3.stage`, só sobre entradas NÃO semeadas. */
  byEmail3Stage: Record<OnboardingEmail3Stage, number>;
  /** Rascunhos/lotes parados (`stale: true`) — idade + próxima ação, pronto
   *  pra render de tabela (issue: "rascunhos pendentes mostram idade e
   *  próxima ação"). Ordenado por idade decrescente (mais velho primeiro). */
  staleDrafts: Array<{
    subscriptionId: string;
    email: string;
    provider: OnboardingProvider | null;
    stage: OnboardingEmail3Stage;
    ageDays: number | null;
    campaignOrBroadcastId: string | number | null;
    nextAction: string;
  }>;
  /** Comparação de coorte (issue: "elegíveis, convites enviados, cliques e
   *  primeiros apoios confirmados"). */
  cohort: {
    elegiveis: number;
    convitesCriados: number;
    convitesEnviados: number;
    /** `null` — nenhuma fonte de clique por destinatário do convite D+10
     *  existe hoje (ver docstring do módulo); lacuna de atribuição
     *  explícita, nunca `0` fabricado. */
    cliquesRastreados: null;
    primeirosApoiosConfirmados: number;
    /** `true` quando `apoiadorIndex` não foi passado a NENHUMA entrada —
     *  a UI deve avisar que a comparação de apoio está indisponível nesta
     *  consulta, não mostrar `0` como se tivesse medido. */
    semIndiceApoiador: boolean;
  };
}

const EMAIL3_STAGES: OnboardingEmail3Stage[] = [
  "aguardando_confirmacao",
  "not_due",
  "aguardando_dados",
  "rascunho_criado",
  "agendado",
  "enviado",
  "cancelado",
  "skipped_no_open",
  "skipped_inactive",
  "skipped_sem_dados",
  "falha_consulta",
  "estado_ambiguo",
];

/**
 * #7917 item 3 (fleet review PR #8955): `apoiadorIndexProvided` é passado
 * EXPLICITAMENTE pelo caller (derivado de "o índice foi de fato montado" —
 * `apoiadorIndex !== undefined`/`apoiadorDataError == null` em
 * `buildOnboardingFunnelData`), em vez de ser INFERIDO escaneando se alguma
 * entrada tinha `apoiador != null`. A inferência por scan quebrava com ZERO
 * entradas não-semeadas: o loop nunca setava a flag, e a UI reportava
 * "apoia.se indisponível" mesmo quando o índice foi injetado com sucesso
 * (só não havia ninguém pra casar). O default (baseado no scan) existe só
 * pra compatibilidade com callers/testes que não passam o parâmetro — o
 * caminho de produção (`buildOnboardingFunnelData`) sempre passa o valor
 * explícito.
 */
export function summarizeOnboardingFunnel(
  entries: readonly OnboardingFunnelEntry[],
  apoiadorIndexProvided: boolean = entries.some((e) => e.apoiador != null),
): OnboardingFunnelSummary {
  const byEmail3Stage = Object.fromEntries(EMAIL3_STAGES.map((s) => [s, 0])) as Record<OnboardingEmail3Stage, number>;
  const staleDrafts: OnboardingFunnelSummary["staleDrafts"] = [];
  let seededExcluded = 0;
  let elegiveis = 0;
  let convitesCriados = 0;
  let convitesEnviados = 0;
  let primeirosApoiosConfirmados = 0;

  for (const e of entries) {
    if (e.seededBy != null) {
      seededExcluded++;
      continue;
    }
    byEmail3Stage[e.email3.stage]++;

    // "elegível" = a régua D+10 já venceu e a entrada não ficou travada
    // esperando confirmação de assinatura.
    if (e.email3.stage !== "aguardando_confirmacao" && e.email3.stage !== "not_due") elegiveis++;
    if (e.email3.stage === "rascunho_criado" || e.email3.stage === "agendado" || e.email3.stage === "enviado" || e.email3.stage === "estado_ambiguo")
      convitesCriados++;
    if (e.email3.stage === "enviado") convitesEnviados++;

    if (e.apoiador != null && e.apoiador.linked && e.apoiador.firstConfirmedAt != null) primeirosApoiosConfirmados++;

    if (e.email3.stale) {
      staleDrafts.push({
        subscriptionId: e.subscriptionId,
        email: e.email,
        provider: e.email3.provider,
        stage: e.email3.stage,
        ageDays: e.email3.ageDays,
        campaignOrBroadcastId: e.email3.campaignOrBroadcastId,
        nextAction: e.email3.nextAction,
      });
    }
  }

  staleDrafts.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));

  return {
    total: entries.length,
    seededExcluded,
    byEmail3Stage,
    staleDrafts,
    cohort: {
      elegiveis,
      convitesCriados,
      convitesEnviados,
      cliquesRastreados: null,
      primeirosApoiosConfirmados,
      semIndiceApoiador: !apoiadorIndexProvided,
    },
  };
}
