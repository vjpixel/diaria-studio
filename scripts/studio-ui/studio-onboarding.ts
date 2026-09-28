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
 * ## Fail-soft
 *
 * `data/` ausente (sessão cloud sem junction) ou store inexistente (nenhuma
 * rodada de onboarding rodou ainda) degradam pra `available: false` — nunca
 * lança. Falha de rede no refresh vira `falha_consulta` por entrada afetada
 * (nunca 500 pro painel inteiro).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readStore, DEFAULT_STORE_PATH } from "../lib/onboarding-store.ts";
import type { OnboardingEntry } from "../lib/onboarding-store.ts";
import type { OnboardingKitLot } from "../lib/onboarding-kit-transport.ts";
import {
  buildOnboardingFunnelEntry,
  summarizeOnboardingFunnel,
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
  /** `false` quando `data/onboarding/store.json` não existe — nenhuma
   *  rodada do executor rodou ainda nesta máquina/sessão. */
  available: boolean;
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

export interface OnboardingFunnelData {
  generatedAt: string;
  db: OnboardingFunnelDbLayer;
  entries: OnboardingFunnelEntry[];
  summary: OnboardingFunnelSummary;
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
  const { store } = readStore(storePath);

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const email3Days = opts.email3Days ?? 10;
  const email3GraceDays = opts.email3GraceDays ?? 3;
  const kitLots: OnboardingKitLot[] = Object.values(store.kit_transport?.lots ?? {});

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
  const entries: OnboardingEntry[] = Object.values(store.entries);
  const funnelEntries = entries.map((entry) => {
    const campaignId = entry.email3_campaign_id;
    const perEntryOpts: BuildFunnelEntryOptions = {
      ...funnelOpts,
      brevoCampaignState: campaignId != null ? opts.brevoCampaignStates?.get(campaignId) ?? null : null,
      brevoQueryFailed: campaignId != null ? (opts.brevoFailedCampaignIds?.has(campaignId) ?? false) : false,
    };
    return buildOnboardingFunnelEntry(entry, perEntryOpts);
  });

  const summary = summarizeOnboardingFunnel(funnelEntries);

  return {
    generatedAt: new Date(nowSec * 1000).toISOString(),
    db: { storePath, hasDataDir, available: storeExists },
    entries: funnelEntries,
    summary,
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
 *  precisa consultar (nunca a base inteira de campanhas da conta). */
export function pendingBrevoCampaignIds(entries: readonly OnboardingEntry[]): number[] {
  const ids = new Set<number>();
  for (const e of entries) {
    if (e.email3_state === "campaign_created" && e.email3_campaign_id != null) ids.add(e.email3_campaign_id);
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
  return pendingBrevoCampaignIds(Object.values(store.entries));
}
