/**
 * clarice-engagement-cohorts-v2.ts (#4451 Fase 1 + Fase 2)
 *
 * Redesenho estrutural de `clarice-engagement-cohorts.ts`: em vez de 1 `GET
 * /contacts/{id}` por CONTATO (hoje ~129k contatos, ~21,5h de crawl, travado
 * desde 260729), este script inverte o eixo — para cada CAMPANHA enviada
 * (dezenas/poucas centenas na história do projeto), exporta TODOS os
 * destinatários numa chamada (`POST /emailCampaigns/{id}/exportRecipients`,
 * `recipientsType: "all"` → `GET /processes/{processId}` até `completed` →
 * baixa o CSV assinado em `export_url`) e agrega localmente por `Email_ID`.
 *
 * Testado AO VIVO em 260802 contra a campanha id 40 ("Clarice News 2605
 * d01-C", 116 destinatários): completou em ~4s. Ver issue #4451 pro achado
 * completo, o mapeamento de campos e os riscos em aberto.
 *
 * ESCOPO DESTE ARQUIVO:
 *   1. Backfill completo por campanha + cache local permanente. (Fase 1, #4457)
 *   2. Janela de re-fetch de campanhas recentes + fechamento do gap de
 *      blacklist administrativo via store local. ← AQUI (Fase 2, #4451)
 *   3. Comparar output de computeCohorts() do v2 contra o v1 (empírico) —
 *      tooling pronta em `scripts/compare-cohorts.ts`, mas a EXECUÇÃO ao
 *      vivo (rodar v1 --dry-run e v2 lado a lado contra a Brevo real) fica
 *      pendente — precisa de sessão com `BREVO_CLARICE_API_KEY` e tempo pro
 *      v1 (ainda ~21h de crawl) completar, ou pelo menos uma amostra
 *      representativa. Não executado nesta sessão (guard de dispatch: sem
 *      chamada de rede à Brevo além de leitura documentada).
 *   4. Trocar a task agendada `DiariaCohortsCrawl` pro script novo + aposentar
 *      v1 — SÓ depois do passo 3 bater. Não feito.
 * Fases 3-4 continuam follow-up, agora com a tooling de comparação pronta
 * (`scripts/compare-cohorts.ts`) — falta só a RODADA empírica supervisionada.
 *
 * `computeCohorts()` (de clarice-engagement-cohorts.ts) NÃO MUDA — só a
 * ORIGEM do `ContactEngagement` por e-mail muda (per-campanha em vez de
 * per-contato). v1 não é tocado por este arquivo.
 *
 * SEMPRE DRY-RUN: este script NUNCA escreve no KV do worker
 * `clarice-dashboard` nem troca a task agendada `DiariaCohortsCrawl` — só
 * produz output local (stdout + opcionalmente `--out arquivo.json`) pro
 * editor inspecionar. Cutover real é Fase 4, fora deste arquivo.
 *
 * CACHE "SKIP FOREVER" COM JANELA DE RE-FETCH (#4451 Fase 2): campanha fora
 * da janela de re-fetch (`--refetch-window-days`, default 30 — chute inicial
 * da issue, não validado empiricamente ainda) usa o cache permanente em
 * `data/clarice-subscribers/cohorts/campaign-cache/{campaignId}.json` sem
 * nunca re-exportar — campanha enviada é imutável em CONTEÚDO. Campanha
 * DENTRO da janela (enviada há menos de N dias) é SEMPRE re-exportada a cada
 * run, mesmo se já tiver cache — captura engajamento tardio (aberturas que
 * ainda acontecem depois do envio) sem re-processar a história inteira. Uma
 * campanha sem `sentDate` (ou com data inválida) é tratada como DENTRO da
 * janela por padrão conservador (nunca assume cache permanente sem saber a
 * idade real).
 *
 * GAP DE BLACKLIST ADMINISTRATIVO — FECHADO via store local (#4451 Fase 2):
 * blacklist/unsub que não aparece em NENHUM export de campanha (ex:
 * descadastro fora do contexto de uma campanha específica, ou supressão
 * administrativa) não tem como ser capturado só com `exportRecipients` — mas
 * `clarice-sync-brevo.ts` já sincroniza `email_blacklisted`/`unsubscribed`
 * pra `data/clarice-subscribers/clarice-users.db` diariamente (08:30 BRT, ver
 * CLAUDE.md), então lemos ESSE store local em vez de fazer uma chamada nova à
 * Brevo (zero custo de API adicional). `fetchAdminOptOutEmails` é FAIL-SOFT:
 * se o store não existir (sessão cloud sem junction `data/`, ou task de sync
 * ainda não rodou), loga aviso e segue sem esse sinal em vez de abortar —
 * mesma postura de `exec-mode.ts`/`studio-chat-enabled.ts`. Escopado a
 * `sends_count > 0` (achado 3 do fleet review #4479, fechado nesta sessão) —
 * ver docstring de `fetchAdminOptOutEmails`.
 *
 * THROTTLING: a Brevo não documenta rate limit específico pra
 * `exportRecipients`/`processes` (diferente de `/v3/contacts/*`, 10 req/s
 * documentado). Concorrência default BAIXA (2) — nunca dispara exports de
 * várias campanhas em paralelo sem limite.
 *
 * FLEET REVIEW #4479 — achados corrigidos SEM exigir API real (ver issue
 * #4451 pra lista completa): (3) `fetchAdminOptOutEmails` agora escopa a
 * `sends_count > 0` (fechado nesta sessão, `/diaria-develop` 260808 — ver
 * docstring da função); (4) `--refetch-window-days` não colapsa mais
 * silenciosamente pro default em valor "0"/inválido (`getIntArg`, mesmo fix
 * já aplicado a `--limit` em #4497); (5) `downloadCsv` tem timeout explícito
 * (`DOWNLOAD_CSV_TIMEOUT_MS`, `AbortController`); (6) `--out` grava
 * cohorts+diagnostics (`scripts/lib/cohorts-v2-artifact.ts`), e
 * `compare-cohorts.ts` recusa comparar por padrão quando o lado v2 tem sinal
 * administrativo degradado; (7) os 2 testes sugeridos (forceRefresh com
 * export falhando sobre cache pré-existente; diffCohorts com campo ausente de
 * um lado) já existem em `test/clarice-engagement-cohorts-v2.test.ts` e
 * `test/compare-cohorts.test.ts`. Achados 1-2 continuam documentados como
 * estão (decisão de comportamento / validação pendente de dado real da Fase
 * 3 — ver comentários locais em `getOrFetchCampaignCache`/
 * `isWithinRefetchWindow`).
 *
 * Env:
 *   BREVO_CLARICE_API_KEY  obrigatório
 *
 * Uso CLI (sempre dry-run, nunca grava KV nem toca a task agendada):
 *   npx tsx scripts/clarice-engagement-cohorts-v2.ts [--concurrency N] [--limit N] [--out arquivo.json] [--refetch-window-days N] [--no-admin-optouts]
 *
 *   --concurrency        campanhas processadas em paralelo (default 2 — throttling conservador).
 *   --limit               processa só as N campanhas mais recentes (útil pra validar sem rodar a história inteira).
 *   --out                 além do stdout, grava cohorts+diagnostics (CohortsV2Artifact) neste path.
 *   --refetch-window-days janela (dias) de campanhas recentes sempre re-exportadas (default 30; aceita 0; valor inválido lança).
 *   --no-admin-optouts    desliga o merge do gap de blacklist administrativo via store local.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { brevoGet, brevoPost } from "./lib/brevo-client.ts";
import { pollProcessUntilTerminal, type PollOptions } from "./lib/brevo-process-poll.ts"; // #4577
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { buildCohortsV2Artifact } from "./lib/cohorts-v2-artifact.ts";
import {
  computeCohorts,
  COHORTS_STATE_DIR,
  type ContactEngagement,
  type EngagementCohorts,
} from "./clarice-engagement-cohorts.ts";

loadProjectEnv();

/** Janela default (dias) de campanhas "recentes" sempre re-exportadas (#4451 Fase 2). */
export const DEFAULT_REFETCH_WINDOW_DAYS = 30;

/** Cache permanente por campanha — irmão de checkpoint.json/status.json do v1. */
export const CAMPAIGN_CACHE_DIR = resolve(COHORTS_STATE_DIR, "campaign-cache");

export function campaignCachePath(campaignId: number, cacheDir: string = CAMPAIGN_CACHE_DIR): string {
  return resolve(cacheDir, `${campaignId}.json`);
}

// ─── Shape do CSV exportado (per-linha = 1 destinatário de 1 campanha) ───────

/**
 * Colunas relevantes confirmadas AO VIVO (260802, campanha id 40). Há também
 * N colunas dinâmicas (1 por link da campanha) — ignoradas aqui (o parser
 * lê tudo, só não lemos essas chaves).
 */
export interface CampaignRecipientRow {
  Email_ID?: string;
  Delivered_Date?: string;
  "Total Opens"?: string;
  Hard_Bounce_Date?: string;
  Soft_Bounce_Date?: string;
  Unsubscribe_Date?: string;
  [key: string]: string | undefined;
}

/** Flags derivados de UMA linha do CSV (1 destinatário, 1 campanha). Pura. */
export interface CampaignRecipientFlags {
  delivered: boolean;
  opened: boolean;
  bounced: boolean;
  unsubscribed: boolean;
}

function isFilled(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** Normaliza email (trim + lowercase) pra usar como chave de agregação. "" se ausente. */
export function normalizeEmail(v: string | undefined | null): string {
  return (v ?? "").trim().toLowerCase();
}

/**
 * Converte uma linha do CSV de `exportRecipients` em flags de engajamento
 * NAQUELA campanha. Pura — testável sem rede (#633).
 *
 * Mapeamento (ver tabela da issue #4451):
 *   - delivered    ← Delivered_Date preenchido (equivalente a messagesSent per-contato hoje)
 *   - opened       ← Total Opens > 0 NAQUELA campanha (equivalente a 1 entrada em statistics.opened)
 *   - bounced      ← Hard_Bounce_Date OU Soft_Bounce_Date preenchido
 *   - unsubscribed ← Unsubscribe_Date preenchido (gap: blacklist administrativo sem
 *                    evento de unsub não aparece aqui — ver comentário de topo do arquivo)
 */
export function csvRowToFlags(row: CampaignRecipientRow): CampaignRecipientFlags {
  const totalOpens = Number(row["Total Opens"]);
  return {
    delivered: isFilled(row.Delivered_Date),
    opened: !Number.isNaN(totalOpens) && totalOpens > 0,
    bounced: isFilled(row.Hard_Bounce_Date) || isFilled(row.Soft_Bounce_Date),
    unsubscribed: isFilled(row.Unsubscribe_Date),
  };
}

// ─── Cache por campanha ───────────────────────────────────────────────────────

export interface CampaignCache {
  campaignId: number;
  campaignName: string;
  /** ISO timestamp de quando o export foi feito (não de quando a campanha foi enviada). */
  exportedAt: string;
  /** email normalizado → flags agregados DENTRO desta campanha (OR-merge se duplicata). */
  recipients: Record<string, CampaignRecipientFlags>;
}

/**
 * Agrega as linhas de UM export de campanha num `CampaignCache`. Pura.
 * OR-merge defensivo se o mesmo email aparecer 2x na mesma campanha (não
 * esperado pela API, mas não custa nada blindar).
 */
export function buildCampaignCache(
  rows: CampaignRecipientRow[],
  campaignId: number,
  campaignName: string,
  exportedAt: string,
): CampaignCache {
  const recipients: Record<string, CampaignRecipientFlags> = {};
  for (const row of rows) {
    const email = normalizeEmail(row.Email_ID);
    if (!email) continue;
    const flags = csvRowToFlags(row);
    const prev = recipients[email];
    recipients[email] = prev
      ? {
          delivered: prev.delivered || flags.delivered,
          opened: prev.opened || flags.opened,
          bounced: prev.bounced || flags.bounced,
          unsubscribed: prev.unsubscribed || flags.unsubscribed,
        }
      : flags;
  }
  return { campaignId, campaignName, exportedAt, recipients };
}

/**
 * Agrega N `CampaignCache` (uma por campanha) num mapa email → `ContactEngagement`
 * (mesmo shape consumido por `computeCohorts`, sem mudança nela). Pura —
 * cobre o requisito "múltiplas linhas do mesmo email, 2 campanhas diferentes,
 * acumulam corretamente" (#4451).
 */
export function aggregateCampaignCaches(caches: CampaignCache[]): Map<string, ContactEngagement> {
  const agg = new Map<string, ContactEngagement>();
  for (const cache of caches) {
    for (const [email, flags] of Object.entries(cache.recipients)) {
      const prev = agg.get(email) ?? { received: 0, opened: 0, bounced: false, optedOut: false };
      agg.set(email, {
        received: prev.received + (flags.delivered ? 1 : 0),
        opened: prev.opened + (flags.opened ? 1 : 0),
        bounced: prev.bounced || flags.bounced,
        // optedOut aqui é só "unsub visto em alguma campanha" — não cobre o
        // gap de blacklist administrativo (ver comentário de topo).
        optedOut: prev.optedOut || flags.unsubscribed,
      });
    }
  }
  return agg;
}

function loadCampaignCache(campaignId: number, cacheDir: string): CampaignCache | null {
  try {
    const path = campaignCachePath(campaignId, cacheDir);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as CampaignCache;
  } catch {
    return null; // cache corrompido → re-busca (mesma postura defensiva do checkpoint do v1)
  }
}

function saveCampaignCache(cache: CampaignCache, cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileAtomic(campaignCachePath(cache.campaignId, cacheDir), JSON.stringify(cache), { fsync: false });
}

// ─── Cliente de export — injetável pra teste sem rede (#633) ────────────────

export interface SentCampaignRef {
  id: number;
  name: string;
  sentDate?: string;
}

export interface CampaignExportClient {
  listSentCampaigns(): Promise<SentCampaignRef[]>;
  exportRecipients(campaignId: number): Promise<{ processId: number | string }>;
  pollProcess(processId: number | string): Promise<{ status: string; exportUrl?: string }>;
  downloadCsv(url: string): Promise<string>;
}

/** Paginado, mesmo padrão de `fetchSentListIds` em clarice-engagement-cohorts.ts. */
async function fetchSentCampaigns(apiKey: string): Promise<SentCampaignRef[]> {
  const out: SentCampaignRef[] = [];
  let offset = 0;
  for (;;) {
    const { status, body } = await brevoGet(
      apiKey,
      `/emailCampaigns?status=sent&limit=100&offset=${offset}&sort=desc`,
    );
    if (status === 404) {
      throw new Error(
        "Brevo /emailCampaigns retornou 404 — abortando (verifique escopo/validade da BREVO_CLARICE_API_KEY).",
      );
    }
    const cs: any[] = body?.campaigns ?? [];
    for (const c of cs) out.push({ id: c.id, name: c.name, sentDate: c.sentDate });
    if (cs.length < 100) break;
    offset += 100;
  }
  return out;
}

/**
 * Cliente real, fino sobre `brevoPost`/`brevoGet` (retry-on-429/5xx já
 * embutido nelas — ver brevo-client.ts). `downloadCsv` é `fetch` puro: o
 * `export_url` é um link assinado S3, fora do domínio da Brevo, então não
 * compartilha o mesmo rate limit nem a mesma disciplina de retry.
 */
export function makeRealCampaignExportClient(apiKey: string): CampaignExportClient {
  return {
    listSentCampaigns: () => fetchSentCampaigns(apiKey),
    async exportRecipients(campaignId) {
      const body = (await brevoPost(apiKey, `/emailCampaigns/${campaignId}/exportRecipients`, {
        recipientsType: "all",
      })) as { processId?: number | string };
      if (body?.processId == null) {
        throw new Error(
          `exportRecipients campanha ${campaignId}: resposta sem processId (${JSON.stringify(body)})`,
        );
      }
      return { processId: body.processId };
    },
    async pollProcess(processId) {
      const { status, body } = await brevoGet(apiKey, `/processes/${processId}`);
      if (status === 404) {
        throw new Error(`GET /processes/${processId} retornou 404 (processo desconhecido).`);
      }
      // #4451: a issue documenta o campo como `export_url` (snake_case, forma
      // crua da API); aceita também `exportUrl` defensivamente caso a Brevo
      // sirva camelCase em alguma variação de endpoint.
      return { status: body?.status, exportUrl: body?.export_url ?? body?.exportUrl };
    },
    async downloadCsv(url) {
      // #4451 carry-forward (achado 5 do fleet review em #4479): sem timeout
      // explícito, um `export_url` (link assinado S3, fora do domínio da
      // Brevo — não passa pelo retry-on-429 de brevoGet/brevoPost) que
      // pendura a conexão travava o backfill inteiro sem sinal de erro.
      // Mesmo padrão de `AbortController` + `setTimeout` já usado em
      // verify-dates.ts/beehiiv-insert-text.ts (#4196) neste repo.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_CSV_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) {
          throw new Error(`Download do CSV de export falhou (${res.status}): ${url}`);
        }
        return await res.text();
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          throw new Error(`Download do CSV de export excedeu ${DOWNLOAD_CSV_TIMEOUT_MS}ms: ${url}`);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** #4451 carry-forward — timeout do download do CSV assinado (fora do domínio Brevo, sem retry embutido). */
export const DOWNLOAD_CSV_TIMEOUT_MS = 30_000;

// ─── Poll até completar ───────────────────────────────────────────────────────

// #4577: o loop de poll genérico (até status terminal) foi extraído pra
// scripts/lib/brevo-process-poll.ts — reusado por clarice-import-waves.ts,
// que precisava do mesmo poll pra confirmar `/contacts/import` (antes só
// disparava e assumia sucesso). `PollOptions` reexportado por compatibilidade
// — nenhum import externo deste módulo dependia do tipo até aqui, mas a
// assinatura pública (`pollExportUntilDone`) não muda.
export type { PollOptions };

/**
 * Poll `GET /processes/{id}` até `status` terminal, extraindo `exportUrl` do
 * resultado — wrapper fino sobre `pollProcessUntilTerminal` (genérico,
 * scripts/lib/brevo-process-poll.ts) especializado pro caso de uso de EXPORT.
 * Testado ao vivo: a campanha de 116 destinatários completou em ~4s.
 */
export async function pollExportUntilDone(
  client: Pick<CampaignExportClient, "pollProcess">,
  processId: number | string,
  opts: PollOptions = {},
): Promise<string> {
  const res = await pollProcessUntilTerminal(
    (pid) => client.pollProcess(pid),
    processId,
    opts,
  );
  if (!res.exportUrl) {
    throw new Error(`Processo ${processId} completou sem export_url.`);
  }
  return res.exportUrl as string;
}

// ─── Janela de re-fetch (#4451 Fase 2) ───────────────────────────────────────

/**
 * Campanha DENTRO da janela (enviada há menos de `windowDays`) é sempre
 * re-exportada, mesmo com cache existente — captura engajamento tardio (uma
 * abertura que acontece dias depois do envio). Fora da janela, o cache
 * permanente ("skip forever") vale.
 *
 * Sem `sentDate` confiável (ausente ou data inválida), trata como DENTRO da
 * janela por padrão conservador: nunca assume cache permanente pra uma
 * campanha cuja idade não sabemos calcular. Pura — testável sem rede.
 */
export function isWithinRefetchWindow(
  campaign: Pick<SentCampaignRef, "sentDate">,
  nowMs: number,
  windowDays: number = DEFAULT_REFETCH_WINDOW_DAYS,
): boolean {
  if (!campaign.sentDate) return true;
  const sentMs = Date.parse(campaign.sentDate);
  if (Number.isNaN(sentMs)) return true;
  const ageDays = (nowMs - sentMs) / 86_400_000;
  return ageDays < windowDays; // negativo (data futura, relógio divergente) também conta como "dentro"
}

// ─── Busca ou usa cache (skip-forever + janela de re-fetch) ─────────────────

export interface CampaignFetchResult {
  cache: CampaignCache;
  fromCache: boolean;
}

/**
 * Cache "skip forever" (#4451 Fase 1 — mesma semântica do MillionVerifier,
 * `scripts/verify-emails-mv.ts`) COM janela de re-fetch (Fase 2): campanha
 * cacheada só é reaproveitada sem nova chamada se `forceRefresh` for falso.
 * O chamador (`buildCohortsV2`) decide `forceRefresh` via
 * `isWithinRefetchWindow` — este helper não conhece `sentDate`, só executa a
 * decisão. Uma campanha re-exportada tem seu cache SOBRESCRITO (não faz
 * OR-merge com o cache antigo — o export novo é sempre a fonte de verdade
 * mais atual daquela campanha).
 */
export async function getOrFetchCampaignCache(
  client: CampaignExportClient,
  campaign: SentCampaignRef,
  opts: { cacheDir?: string; poll?: PollOptions; now?: () => string; forceRefresh?: boolean } = {},
): Promise<CampaignFetchResult> {
  const cacheDir = opts.cacheDir ?? CAMPAIGN_CACHE_DIR;
  if (!opts.forceRefresh) {
    const cached = loadCampaignCache(campaign.id, cacheDir);
    if (cached) return { cache: cached, fromCache: true };
  }

  const { processId } = await client.exportRecipients(campaign.id);
  const exportUrl = await pollExportUntilDone(client, processId, opts.poll);
  const csvText = await client.downloadCsv(exportUrl);
  const rows = Papa.parse<CampaignRecipientRow>(csvText, { header: true, skipEmptyLines: true }).data;
  const exportedAt = (opts.now ?? (() => new Date().toISOString()))();
  const cache = buildCampaignCache(rows, campaign.id, campaign.name, exportedAt);
  saveCampaignCache(cache, cacheDir);
  return { cache, fromCache: false };
}

// ─── Concorrência limitada, throttling conservador ──────────────────────────

/**
 * Pool minimalista com concorrência N — cópia deliberadamente pequena e
 * independente da `pool()` de clarice-engagement-cohorts.ts (não exportada
 * de lá, e este arquivo não toca o v1 — #4451 Fase 1 é escopo isolado).
 * Sem abort-on-first-error (diferente do v1): uma campanha que falhar no
 * export não deve derrubar o processamento das demais — o resultado agregado
 * reporta quais falharam via `errors`, e o chamador decide como reagir.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<{ index: number; result?: R; error?: unknown }[]> {
  const out: { index: number; result?: R; error?: unknown }[] = new Array(items.length);
  let i = 0;
  const run = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = { index: idx, result: await worker(items[idx]) };
      } catch (error) {
        out[idx] = { index: idx, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run));
  return out;
}

// ─── Gap de blacklist administrativo — fechado via store local (#4451 Fase 2) ─

/**
 * Union discriminada por `available`: quando `true`, `emails` (normalizados,
 * com email_blacklisted=1 OU unsubscribed=1 no store local) sempre existe;
 * quando `false` (store indisponível — sessão cloud sem `data/`, DB ainda não
 * gerado, etc. — fail-soft), `unavailableReason` sempre existe pra
 * diagnosticar sem lançar. Narrowing no `available` elimina a leitura direta
 * de `emails`/`unavailableReason` sem checar o discriminante primeiro.
 */
export type AdminOptOutsResult =
  | { available: true; emails: Set<string> }
  | { available: false; unavailableReason: string };

/**
 * Lê `email_blacklisted`/`unsubscribed` do store local (`clarice-db.ts`),
 * sincronizado diariamente de Brevo por `clarice-sync-brevo.ts` (08:30 BRT).
 * Fecha o gap documentado na issue #4451 (blacklist administrativo sem evento
 * de unsub em NENHUMA campanha específica) sem custo de chamada nova à Brevo.
 *
 * FAIL-SOFT (mesma postura de `exec-mode.ts`/`studio-chat-enabled.ts`): store
 * ausente ou inacessível NUNCA lança — retorna `available: false` e o
 * chamador decide como reagir (logar aviso, seguir sem o sinal). O universo
 * de coortes não deve depender de um recurso `local` pra rodar.
 *
 * ESCOPO FECHADO (#4451 fleet review #4479 achado 3, resolvido nesta sessão):
 * a 1ª versão lia o store INTEIRO (`clarice_users`), sem filtrar por "já
 * recebeu e-mail" — mais amplo que o escopo do v1 (`fetchEmailedContactIds`,
 * membros de listas de campanhas ENVIADAS), porque um contato pode entrar no
 * store (sync incremental da Brevo, #2932) sem nunca ter sido destinatário de
 * campanha alguma (ex: cadastro que nunca chegou a ser inserido numa lista
 * enviada, ou opt-out antes do 1º envio). O filtro `sends_count > 0` (coluna
 * já mantida por `clarice-sync-brevo.ts`, incrementada só por envio real de
 * campanha) restringe aos contatos que RECEBERAM ao menos 1 e-mail — mesma
 * semântica de universo do v1, sem custo de chamada nova à Brevo (dado já
 * sincronizado localmente). Fecha a fonte de divergência descrita no achado 3
 * do fleet review em #4479 (`exits`/`exitsBreakdown.optedOut` "batendo" ou
 * "divergindo" contra o v1 pela razão errada).
 */
export function fetchAdminOptOutEmails(dbPath: string = DEFAULT_DB_PATH): AdminOptOutsResult {
  if (!existsSync(dbPath)) {
    return { available: false, unavailableReason: `store não encontrado em ${dbPath}` };
  }
  try {
    const db = openClariceDb(dbPath);
    try {
      const rows = db
        .prepare(
          "SELECT email FROM clarice_users WHERE (email_blacklisted = 1 OR unsubscribed = 1) AND sends_count > 0",
        )
        .all() as Array<{ email: string }>;
      const emails = new Set(rows.map((r) => normalizeEmail(r.email)).filter((e) => e.length > 0));
      return { available: true, emails };
    } finally {
      db.close();
    }
  } catch (e) {
    return {
      available: false,
      unavailableReason: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Aplica o sinal de opt-out administrativo sobre o agregado por-campanha
 * (pura — testável sem DB/rede). Contato já presente no agregado (apareceu em
 * algum export) tem `optedOut` forçado a `true` (OR, nunca reverte um
 * `optedOut` já verdadeiro). Contato AUSENTE do agregado (nunca apareceu em
 * nenhum export de campanha — o próprio gap que este mecanismo fecha) entra
 * como entrada nova com `received:0, opened:0, bounced:false, optedOut:true`
 * — `computeCohorts` o conta em `exits` mesmo sem `received`/`opened`
 * (precedência de saída, ver `clarice-engagement-cohorts.ts`).
 */
export function applyAdminOptOuts(
  aggregate: Map<string, ContactEngagement>,
  optOutEmails: Set<string>,
): Map<string, ContactEngagement> {
  const out = new Map(aggregate);
  for (const email of optOutEmails) {
    const prev = out.get(email);
    out.set(email, prev ? { ...prev, optedOut: true } : { received: 0, opened: 0, bounced: false, optedOut: true });
  }
  return out;
}

// ─── Orquestração fim-a-fim ──────────────────────────────────────────────────

export interface BuildCohortsV2Result {
  cohorts: EngagementCohorts;
  campaignsTotal: number;
  campaignsFromCache: number;
  campaignsFetched: number;
  campaignsFailed: { campaignId: number; campaignName: string; error: string }[];
  /** #4451 Fase 2 — nº de e-mails do store local aplicados como opt-out administrativo. */
  adminOptOutsApplied: number;
  /** #4451 Fase 2 — false quando o sinal NÃO foi aplicado: store indisponível
   * (fail-soft) OU desligado explicitamente via `--no-admin-optouts`. */
  adminOptOutsAvailable: boolean;
  /** #4451 Fase 2 — motivo real (`unavailableReason` de `fetchAdminOptOutEmails`)
   * quando `adminOptOutsAvailable=false` por store indisponível — undefined
   * quando desligado via `--no-admin-optouts` (não é "indisponível", é opt-out
   * explícito do operador). Sem isto, o log genérico de `main()` esconde a
   * causa real (DB corrompido, SQLITE_BUSY por contenção com o sync das
   * 08:30, erro de permissão) atrás do mesmo aviso do caso esperado
   * "sessão cloud sem `data/`". */
  adminOptOutsUnavailableReason?: string;
}

export async function buildCohortsV2(
  client: CampaignExportClient,
  generatedAt: string,
  opts: {
    concurrency?: number;
    limit?: number;
    cacheDir?: string;
    poll?: PollOptions;
    /** default DEFAULT_REFETCH_WINDOW_DAYS (30) — ver isWithinRefetchWindow. */
    refetchWindowDays?: number;
    /** injeção de "agora" pra determinismo em teste; default Date.now(). */
    nowMs?: number;
    /** default true — desligar via --no-admin-optouts (ou opts.includeAdminOptOuts=false em teste). */
    includeAdminOptOuts?: boolean;
    /** injeção pra teste — default DEFAULT_DB_PATH. */
    dbPath?: string;
  } = {},
): Promise<BuildCohortsV2Result> {
  const concurrency = opts.concurrency ?? 2; // throttling conservador (#4451 — rate limit não documentado)
  const nowMs = opts.nowMs ?? Date.now();
  const refetchWindowDays = opts.refetchWindowDays ?? DEFAULT_REFETCH_WINDOW_DAYS;
  let campaigns = await client.listSentCampaigns();
  if (opts.limit && opts.limit > 0) campaigns = campaigns.slice(0, opts.limit);

  const results = await mapWithConcurrency(campaigns, concurrency, (c) =>
    getOrFetchCampaignCache(client, c, {
      cacheDir: opts.cacheDir,
      poll: opts.poll,
      forceRefresh: isWithinRefetchWindow(c, nowMs, refetchWindowDays),
    }),
  );

  const caches: CampaignCache[] = [];
  const campaignsFailed: BuildCohortsV2Result["campaignsFailed"] = [];
  let campaignsFromCache = 0;
  let campaignsFetched = 0;
  results.forEach((r, idx) => {
    if (r.error) {
      campaignsFailed.push({
        campaignId: campaigns[idx].id,
        campaignName: campaigns[idx].name,
        error: r.error instanceof Error ? r.error.message : String(r.error),
      });
      return;
    }
    caches.push(r.result!.cache);
    if (r.result!.fromCache) campaignsFromCache++;
    else campaignsFetched++;
  });

  let aggregate = aggregateCampaignCaches(caches);
  let adminOptOutsApplied = 0;
  let adminOptOutsAvailable = true;
  let adminOptOutsUnavailableReason: string | undefined;
  if (opts.includeAdminOptOuts ?? true) {
    const admin = fetchAdminOptOutEmails(opts.dbPath);
    adminOptOutsAvailable = admin.available;
    if (admin.available) {
      if (admin.emails.size > 0) {
        aggregate = applyAdminOptOuts(aggregate, admin.emails);
        adminOptOutsApplied = admin.emails.size;
      }
    } else {
      adminOptOutsUnavailableReason = admin.unavailableReason;
    }
  } else {
    adminOptOutsAvailable = false; // desligado explicitamente — não é "indisponível", mas o campo reporta "não aplicado"
  }

  const cohorts = computeCohorts(Array.from(aggregate.values()), generatedAt);

  return {
    cohorts,
    campaignsTotal: campaigns.length,
    campaignsFromCache,
    campaignsFetched,
    campaignsFailed,
    adminOptOutsApplied,
    adminOptOutsAvailable,
    adminOptOutsUnavailableReason,
  };
}

// ─── CLI (SEMPRE dry-run — não grava KV, não toca a task agendada) ──────────

// exportado (#4497) só pra permitir teste direto da validação de --limit sem
// invocar via CLI real — continua SEMPRE dry-run, nenhuma mudança de comportamento.
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const concurrency = Number(getArg(argv, "concurrency") || "2") || 2;
  // getIntArg (#4497) — ausente vira undefined ("sem limite", processa todas
  // as campanhas — script é SEMPRE dry-run, blast radius baixo); um typo no
  // VALOR (ex: "--limit abc") LANÇA (via main().catch no fim do arquivo) em
  // vez de colapsar silenciosamente no mesmo undefined (antes: `limitArg ?
  // Number(limitArg) : undefined` não validava o resultado de Number(), então
  // "--limit abc" virava NaN e, na prática, "processa tudo" sem aviso).
  const limit = getIntArg(argv, "limit");
  const outPath = getArg(argv, "out");
  // #4451 achado 4 do fleet review em #4479: o idioma antigo
  // (`Number(getArg(...) || default) || default`) tratava "0" como falsy e
  // colapsava silenciosamente pro default de 30d — um operador que passasse
  // `--refetch-window-days 0` de propósito (ex: "nunca reaproveitar cache
  // nesta rodada de validação") tinha o pedido ignorado sem aviso. Mesmo
  // idioma pré-existente em clarice-build-waves-store.ts/clarice-sync-brevo.ts/
  // cohort-order-dryrun.ts — não corrigido ali (fora de escopo desta issue),
  // só aqui. `getIntArg` distingue ausente (→ default) de presente-e-inválido
  // (→ lança, nunca "0 abc" virando NaN→default em silêncio).
  const refetchWindowDays = getIntArg(argv, "refetch-window-days") ?? DEFAULT_REFETCH_WINDOW_DAYS;
  const includeAdminOptOuts = !hasFlag(argv, "no-admin-optouts");

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida (veja .env.example).");
    process.exit(1);
  }

  console.error(
    `🚧 v2 (#4451 Fase 2) — SEMPRE dry-run: não grava KV, não altera a task agendada DiariaCohortsCrawl.`,
  );
  console.error(
    `🔎 Backfill por campanha (concorrência ${concurrency}${limit ? `, limit ${limit}` : ""}, ` +
      `janela de re-fetch ${refetchWindowDays}d${includeAdminOptOuts ? "" : ", sem opt-outs administrativos"})…`,
  );

  const generatedAt = new Date().toISOString();
  const client = makeRealCampaignExportClient(apiKey);

  const result = await buildCohortsV2(client, generatedAt, {
    concurrency,
    limit,
    refetchWindowDays,
    includeAdminOptOuts,
  });

  console.error(
    `\n✅ v2 (dry-run): universo ${result.cohorts.universe} — campanhas: ${result.campaignsTotal} ` +
      `(cache: ${result.campaignsFromCache}, novas: ${result.campaignsFetched}, falhas: ${result.campaignsFailed.length}).`,
  );
  console.error(
    result.adminOptOutsAvailable
      ? `📇 Opt-outs administrativos do store local aplicados: ${result.adminOptOutsApplied}.`
      : `⚠️  Opt-outs administrativos NÃO aplicados: ${result.adminOptOutsUnavailableReason ?? "--no-admin-optouts"}.`,
  );
  if (result.campaignsFailed.length > 0) {
    console.error("⚠️  Campanhas com falha (não entraram no agregado):");
    for (const f of result.campaignsFailed) {
      console.error(`   - ${f.campaignId} (${f.campaignName}): ${f.error}`);
    }
  }

  const output = JSON.stringify(result.cohorts, null, 2);
  console.log(output);

  if (outPath) {
    // #4451 achado 6 do fleet review em #4479: `--out` agora grava
    // cohorts+diagnostics (não só cohorts) — sem isso, uma rodada com o store
    // administrativo indisponível ficava indistinguível de uma rodada
    // completa quando lida de volta por compare-cohorts.ts. stdout continua
    // só cohorts (não muda) — o consumidor de `--out` é sempre
    // compare-cohorts.ts, que já sabe ler o wrapper.
    const artifact = buildCohortsV2Artifact(result);
    writeFileAtomic(resolve(outPath), JSON.stringify(artifact, null, 2), { fsync: false });
    console.error(`📝 Output também salvo em ${outPath} (cohorts + diagnostics; nada gravado no KV).`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
