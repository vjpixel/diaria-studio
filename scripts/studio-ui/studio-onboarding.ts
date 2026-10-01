/**
 * studio-onboarding.ts (#7917)
 *
 * Camada de leitura pra `GET /api/onboarding/funnel` e
 * `POST /api/onboarding/funnel/refresh-brevo` — monta o snapshot do funil de
 * onboarding (`scripts/lib/onboarding-funnel-report.ts`) sobre o store real
 * (`data/onboarding/store.json`, #5908) + apoiadores vinculados (reusa
 * `loadLinkableApoiadores` de `studio-subscribers.ts`, #7916 fatia 5/N —
 * mesma fonte, mesmas limitações documentadas, sem duplicar). Mesmo padrão
 * de `studio-ads.ts`/`studio-subscribers.ts`: `server.ts` só roteia, este
 * arquivo monta o snapshot.
 *
 * ## Read-only por construção (issue #7917, "Consultas e reconciliações são
 * somente observacionais: não criam/agendam broadcasts, alteram tags de
 * destinatários nem enviam e-mails")
 *
 * Nenhuma função aqui escreve no store nem chama endpoint de escrita da
 * Brevo/Kit. `refreshBrevoCampaignStates` faz GET puro
 * (`brevoGetCampaign`) — não altera nada na conta Brevo.
 *
 * ## Por que o GET padrão NUNCA consulta a Brevo ao vivo
 *
 * `GET /v3/emailCampaigns*` está no MESMO balde de rate limit de
 * 100 requisições/HORA por CONTA (`docs/brevo-rate-limits.md`,
 * CLAUDE.md) que o resto do pipeline de publicação já disputa. Um painel
 * que consultasse a Brevo a cada carregamento de página competiria por essa
 * cota com o envio real. Por isso:
 *   - `buildOnboardingFunnelData` (GET, sem parâmetro de refresh) usa só o
 *     estado LOCAL do store — o que já é o objetivo certo da issue: mostrar
 *     que `campaign_created` "confirma preparação, nunca envio" é
 *     justamente distinguir "rascunho local" de "confirmado no provedor".
 *   - `refreshBrevoCampaignStates` (POST, ação explícita do editor — mesmo
 *     padrão do botão "Atualizar" em `cohort-origem`/`/api/painel/eia/refresh`)
 *     faz UMA consulta por CAMPANHA distinta (nunca por assinante — o cohort
 *     D+10 inteiro cabe numa única campanha na maioria dos casos), com
 *     dedup explícito.
 *
 * ## Lotes Kit e piloto (#7922, §3 de docs/onboarding-kit-cutover.md)
 *
 * `kitLots` lista os lotes de `store.kit_transport.lots` (status, broadcast,
 * nº de destinatários, último erro) + o registro da última rodada `--send`
 * do executor Kit (`last_send_run`). Lote de PILOTO (tag `onboarding-pilot-*`
 * ou destinatário `pilot:*`, `onboarding-kit-pilot.ts`) e entrada sintética de
 * piloto (`subscription_id` `pilot:*`) nunca entram no funil de produção nem
 * na resolução do e-mail 3 — ficam numa lista própria, identificada. O piloto
 * roda num store ISOLADO por construção (`assertPilotStoreIsolated`), então
 * no store real isso só aparece se alguém copiar/mesclar à mão; a separação
 * aqui garante que, se acontecer, o painel não mistura.
 *
 * ## Fail-soft
 *
 * `data/` ausente (sessão cloud sem junction) ou store inexistente (nenhuma
 * rodada de onboarding rodou ainda) degradam pra `available: false` — nunca
 * lança. Falha de rede no refresh vira `falha_consulta` por entrada afetada
 * (nunca 500 pro painel inteiro).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readStore } from "../lib/onboarding-store.ts";
import type { OnboardingEntry } from "../lib/onboarding-store.ts";
import type { OnboardingKitLot, KitSendRunRecord, KitTransportHealthBlock } from "../lib/onboarding-kit-transport.ts";
import { PILOT_TAG_PREFIX, PILOT_SUBSCRIPTION_PREFIX, redactEmails } from "../lib/onboarding-kit-pilot.ts";
import {
  buildOnboardingFunnelEntry,
  summarizeOnboardingFunnel,
  findKitLotForEntry,
  type OnboardingFunnelEntry,
  type OnboardingFunnelSummary,
  type BuildFunnelEntryOptions,
} from "../lib/onboarding-funnel-report.ts";
import { buildApoiadorEmailIndex, type LinkableApoiador } from "../lib/metrics/apoiador-link.ts";
import { brevoGetCampaign } from "../lib/brevo-client.ts";
import { loadLinkableApoiadores } from "./studio-subscribers.ts";

export interface OnboardingFunnelDbLayer {
  storePath: string;
  hasDataDir: boolean;
  /** `false` quando `data/onboarding/store.json` não existe OU quando existe
   *  mas está corrompido (`corrupted: true`, ver abaixo) — nesses dois
   *  casos o snapshot degrada pra vazio, mas os MOTIVOS são bem diferentes:
   *  "nenhuma rodada rodou ainda" (arquivo ausente, estado natural) vs.
   *  "tem dado, mas ele é ilegível" (arquivo corrompido, estado anormal que
   *  merece alarme, não silêncio — #7917 item 1, fleet review PR #8955). */
  available: boolean;
  /** `true` quando `data/onboarding/store.json` existe mas `JSON.parse`
   *  falhou (`readStore` já loga em stderr e degrada pra store vazio) —
   *  distinto de "arquivo ausente": aqui HÁ dado, só que ilegível. A UI
   *  nunca deve renderizar isto como "onboarding vazio". */
  corrupted: boolean;
}

export interface BuildOnboardingFunnelOptions {
  storePath?: string;
  nowSec?: number;
  email3Days?: number;
  email3GraceDays?: number;
  /** Live states já resolvidos, chave = `email3_campaign_id` — usado pelo
   *  refresh (nunca preenchido no GET padrão, ver docstring do módulo). */
  brevoCampaignStates?: ReadonlyMap<number, { status?: string; scheduledAt?: string | null }>;
  /** Ids de campanha cuja consulta ao vivo foi TENTADA e FALHOU nesta
   *  rodada de refresh — essas entradas viram `falha_consulta` mesmo que
   *  `brevoCampaignStates` não tenha entrada pra elas. */
  brevoFailedCampaignIds?: ReadonlySet<number>;
  /** Injetável pra teste — evita `contacts.jsonl`/`.env`/cache real da
   *  apoia.se (mesmo padrão de `ApoiadorCohortOptions`). */
  apoiadores?: LinkableApoiador[];
}

/** #7922: um lote Kit pronto pra render — sem a lista de e-mails (só a
 *  contagem), `lastError` com e-mails mascarados. */
export interface OnboardingKitLotView {
  lotId: string;
  kind: OnboardingKitLot["kind"];
  status: OnboardingKitLot["status"];
  tagName: string;
  broadcastId: number | null;
  recipients: number;
  createdAt: string;
  sendAt: string | null;
  lastError: string | null;
  pilot: boolean;
}

export interface OnboardingKitLotsView {
  /** Lotes de produção, mais novo primeiro. */
  production: OnboardingKitLotView[];
  /** Lotes de piloto (`onboarding-pilot-*`) — nunca misturados com produção. */
  pilot: OnboardingKitLotView[];
  /** Entradas sintéticas de piloto (`pilot:*`) excluídas do funil. */
  pilotEntriesExcluded: number;
  /** Última rodada `--send` do executor Kit (`store.kit_transport.last_send_run`)
   *  — `null` = nunca registrada (kill switch desligado, ou executor anterior
   *  ao campo). */
  lastSendRun: KitSendRunRecord | null;
  consecutiveFailedSendRuns: number;
}

/** Lote de piloto: tag com o prefixo do piloto OU algum destinatário
 *  sintético do piloto. Qualquer dos dois sinais basta (um lote de produção
 *  nunca tem nenhum deles). */
export function isPilotKitLot(lot: OnboardingKitLot): boolean {
  // `?? ""`/`?? []`: store é JSON editável à mão — lote sem um campo não pode derrubar o painel.
  return (
    (lot.tag_name ?? "").startsWith(PILOT_TAG_PREFIX) ||
    (lot.recipient_subscription_ids ?? []).some((id) => String(id).startsWith(PILOT_SUBSCRIPTION_PREFIX))
  );
}

export function isPilotEntry(entry: OnboardingEntry): boolean {
  return entry.subscription_id.startsWith(PILOT_SUBSCRIPTION_PREFIX);
}

function toKitLotView(lot: OnboardingKitLot): OnboardingKitLotView {
  return {
    lotId: lot.lot_id,
    kind: lot.kind,
    status: lot.status,
    tagName: lot.tag_name ?? "",
    broadcastId: lot.broadcast_id,
    recipients: (lot.recipient_subscription_ids ?? []).length,
    createdAt: lot.created_at ?? "",
    sendAt: lot.send_at,
    lastError: lot.last_error != null ? redactEmails(String(lot.last_error)) : null,
    pilot: isPilotKitLot(lot),
  };
}

/** Separa lotes de produção/piloto e monta a visão do painel. @pure */
export function buildKitLotsView(
  lots: readonly OnboardingKitLot[],
  pilotEntriesExcluded: number,
  kitTransport: KitTransportHealthBlock | undefined,
): OnboardingKitLotsView {
  const byNewest = (a: OnboardingKitLotView, b: OnboardingKitLotView) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  const views = lots.map(toKitLotView);
  return {
    production: views.filter((v) => !v.pilot).sort(byNewest),
    pilot: views.filter((v) => v.pilot).sort(byNewest),
    pilotEntriesExcluded,
    lastSendRun: kitTransport?.last_send_run ?? null,
    consecutiveFailedSendRuns: kitTransport?.consecutive_failed_send_runs ?? 0,
  };
}

export interface OnboardingFunnelData {
  generatedAt: string;
  db: OnboardingFunnelDbLayer;
  entries: OnboardingFunnelEntry[];
  summary: OnboardingFunnelSummary;
  /** #7922: lotes do transporte Kit (produção e piloto separados). */
  kitLots: OnboardingKitLotsView;
  apoiadorDataError: string | null;
  liveBrevoChecked: boolean;
  note: string;
}

const NOTE =
  "campaign_created (Brevo) e lote Kit created/pending confirmam só PREPARAÇÃO do convite D+10 — " +
  "nunca envio/entrega/conversão (#7917). Sem refresh ao vivo, o estado mostrado é o LOCAL do store " +
  "(o mesmo que onboarding-welcome-run.ts/onboarding-kit-transport-run.ts gravaram na última rodada). " +
  "cliquesRastreados é sempre null — nenhuma API expõe clique por destinatário deste convite hoje " +
  "(lacuna de atribuição documentada, não medição zerada).";

function resolveStorePath(rootDir: string, opts: BuildOnboardingFunnelOptions): string {
  return opts.storePath ?? resolve(rootDir, "data", "onboarding", "store.json");
}

/**
 * `GET /api/onboarding/funnel` — snapshot do funil sobre o estado LOCAL do
 * store (sem chamada de rede — ver docstring do módulo). Sempre retorna
 * `db.available`/`apoiadorDataError` explícitos em vez de lançar.
 */
export function buildOnboardingFunnelData(rootDir: string, opts: BuildOnboardingFunnelOptions = {}): OnboardingFunnelData {
  const storePath = resolveStorePath(rootDir, opts);
  const hasDataDir = existsSync(resolve(rootDir, "data"));
  const storeExists = existsSync(storePath);
  const { store, corrupted } = readStore(storePath);

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const email3Days = opts.email3Days ?? 10;
  const email3GraceDays = opts.email3GraceDays ?? 3;
  const allKitLots: OnboardingKitLot[] = Object.values(store.kit_transport?.lots ?? {});
  // #7922: lote de piloto nunca resolve o e-mail 3 de uma entrada de produção.
  const kitLots = allKitLots.filter((l) => !isPilotKitLot(l));

  let apoiadorIndex: ReadonlyMap<string, LinkableApoiador> | undefined;
  let apoiadorDataError: string | null = null;
  if (opts.apoiadores) {
    apoiadorIndex = buildApoiadorEmailIndex(opts.apoiadores);
  } else {
    const { apoiadores, error } = loadLinkableApoiadores(rootDir);
    apoiadorDataError = error;
    // #7917: mesmo com erro, `apoiadores` vem `[]` (fail-soft de
    // `loadLinkableApoiadores`) — construir o índice vazio é seguro (todo
    // `linkSubscriberToApoiador` devolve `null`, nunca fabrica match), mas
    // só o fazemos quando NÃO houve erro: com erro, `apoiadorIndex` fica
    // `undefined` de propósito, pra `buildOnboardingFunnelEntry` reportar
    // `apoiador: null` (checagem não tentada) em vez de `{linked:false}`
    // (checagem tentada e negativa) — a distinção que a issue exige (nunca
    // fabricar "não é apoiador" quando na verdade não sabemos).
    if (error == null) apoiadorIndex = buildApoiadorEmailIndex(apoiadores);
  }

  const funnelOpts: BuildFunnelEntryOptions = {
    nowSec,
    email3Days,
    email3GraceDays,
    kitLots,
    apoiadorIndex,
  };
  const allEntries: OnboardingEntry[] = Object.values(store.entries);
  // #7922: entrada sintética de piloto fica fora do funil de produção.
  const entries = allEntries.filter((e) => !isPilotEntry(e));
  const pilotEntriesExcluded = allEntries.length - entries.length;
  const funnelEntries = entries.map((entry) => {
    const campaignId = entry.email3_campaign_id;
    const perEntryOpts: BuildFunnelEntryOptions = {
      ...funnelOpts,
      brevoCampaignState: campaignId != null ? opts.brevoCampaignStates?.get(campaignId) ?? null : null,
      brevoQueryFailed: campaignId != null ? (opts.brevoFailedCampaignIds?.has(campaignId) ?? false) : false,
    };
    return buildOnboardingFunnelEntry(entry, perEntryOpts);
  });

  // #7917 item 3 (fleet review PR #8955): passa explicitamente se o índice
  // de apoiadores foi de fato montado, em vez de deixar `summarizeOnboardingFunnel`
  // inferir escaneando `entries` por `apoiador != null` — essa inferência
  // quebrava com ZERO entradas não-semeadas (loop nunca roda, flag nunca
  // vira `true`, UI reporta "apoia.se indisponível" mesmo com o índice OK).
  const apoiadorIndexProvided = apoiadorIndex !== undefined;
  const summary = summarizeOnboardingFunnel(funnelEntries, apoiadorIndexProvided);

  return {
    generatedAt: new Date(nowSec * 1000).toISOString(),
    // #7917 item 1 (fleet review PR #8955): `available` agora também exige
    // `!corrupted` — um store.json presente mas ilegível NUNCA deve ser
    // relatado como "disponível e vazio" (que a UI leria como "onboarding
    // nunca rodou"). `corrupted` viaja explícito pra UI distinguir os dois
    // casos (ver docstring de `OnboardingFunnelDbLayer`).
    db: { storePath, hasDataDir, available: storeExists && !corrupted, corrupted },
    entries: funnelEntries,
    summary,
    kitLots: buildKitLotsView(allKitLots, pilotEntriesExcluded, store.kit_transport),
    apoiadorDataError,
    liveBrevoChecked: (opts.brevoCampaignStates?.size ?? 0) > 0 || (opts.brevoFailedCampaignIds?.size ?? 0) > 0,
    note: NOTE,
  };
}

// ---------------------------------------------------------------------------
// Refresh ao vivo (POST) — 1 GET por campanha DISTINTA, nunca por assinante
// ---------------------------------------------------------------------------

export interface RefreshBrevoResult {
  states: Map<number, { status?: string; scheduledAt?: string | null }>;
  failed: Set<number>;
  attempted: number;
  errors: Array<{ campaignId: number; message: string }>;
}

/**
 * Consulta a Brevo ao vivo SÓ pras campanhas `email3_campaign_id` distintas
 * que ainda estão em `campaign_created` no store local — dedup explícito
 * (o cohort D+10 inteiro tipicamente compartilha 1 campanha, ver
 * `onboarding-welcome-run.ts`: "UMA campanha-rascunho Brevo pro cohort
 * inteiro do dia"). Falha de rede/API em uma campanha NUNCA aborta as
 * demais nem vira exceção — entra em `failed`/`errors`, o caller
 * (`handleApiOnboardingFunnelRefresh`) repassa como `falha_consulta` só
 * pras entradas daquela campanha.
 */
export async function refreshBrevoCampaignStates(
  apiKey: string,
  campaignIds: readonly number[],
  getCampaignFn: typeof brevoGetCampaign = brevoGetCampaign,
): Promise<RefreshBrevoResult> {
  const distinct = Array.from(new Set(campaignIds));
  const states = new Map<number, { status?: string; scheduledAt?: string | null }>();
  const failed = new Set<number>();
  const errors: Array<{ campaignId: number; message: string }> = [];

  for (const campaignId of distinct) {
    try {
      const result = await getCampaignFn(apiKey, campaignId);
      states.set(campaignId, { status: result.status, scheduledAt: result.scheduledAt ?? null });
    } catch (e) {
      failed.add(campaignId);
      errors.push({ campaignId, message: (e as Error).message });
    }
  }

  return { states, failed, attempted: distinct.length, errors };
}

/** Ids de campanha `email3_campaign_id` distintos, não-nulos, ainda em
 *  `campaign_created` no store — o universo que `refreshBrevoCampaignStates`
 *  precisa consultar (nunca a base inteira de campanhas da conta).
 *
 *  #7917 item 10 (fleet review PR #8955): entradas cujo e-mail 3 já resolve
 *  via um lote KIT (`findKitLotForEntry`, mesma checagem de precedência de
 *  `buildEmail3Info`) são puladas aqui — consultar a Brevo pra uma campanha
 *  cujo estado real é decidido pelo Kit gastaria cota do balde de 100
 *  req/hora (CLAUDE.md) à toa. `kitLots` é opcional só pra não quebrar
 *  callers/testes que ainda não passam o array (comportamento sem ele:
 *  igual ao anterior, sem o skip). */
export function pendingBrevoCampaignIds(entries: readonly OnboardingEntry[], kitLots: readonly OnboardingKitLot[] = []): number[] {
  const ids = new Set<number>();
  for (const e of entries) {
    if (e.email3_state !== "campaign_created" || e.email3_campaign_id == null) continue;
    if (kitLots.length > 0 && findKitLotForEntry(kitLots, "email3", e.subscription_id) != null) continue;
    ids.add(e.email3_campaign_id);
  }
  return Array.from(ids);
}

/** Lê o store direto do disco só pra extrair os ids pendentes — usado pelo
 *  handler de refresh (`server.ts`) ANTES de consultar a Brevo, pra saber
 *  quais campanhas perguntar. Mantém `server.ts` sem importar
 *  `onboarding-store.ts` diretamente (fronteira "server.ts só roteia, este
 *  arquivo monta o snapshot" documentada no topo do módulo). */
export function listPendingBrevoCampaignIds(rootDir: string, opts: { storePath?: string } = {}): number[] {
  const storePath = opts.storePath ?? resolve(rootDir, "data", "onboarding", "store.json");
  const { store } = readStore(storePath);
  const kitLots: OnboardingKitLot[] = Object.values(store.kit_transport?.lots ?? {}).filter((l) => !isPilotKitLot(l));
  return pendingBrevoCampaignIds(Object.values(store.entries).filter((e) => !isPilotEntry(e)), kitLots);
}
