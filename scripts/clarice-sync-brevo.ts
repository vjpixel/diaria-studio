#!/usr/bin/env node
/**
 * clarice-sync-brevo.ts — sincroniza engajamento/supressão do Brevo pro store
 * único de usuários da Clarice (#2647 follow-up). Fecha o gap que deixava
 * `send_eligible` não-autoritativo (descadastro/bounce ficavam no default).
 *
 * Por contato (GET /contacts/{id}): opens/clicks/sends, hard/soft bounces,
 * unsub, complaints, last_*_at, blacklist, RECENCY_QUARTIL, listIds, timestamps.
 * Parsing puro em `lib/brevo-stats.ts`; upsert em `lib/clarice-db.ts`.
 *
 * ⚠️ PESADO + RATE-LIMITED: a base toda são dezenas de milhares de contatos =
 * 1 GET por contato. A Brevo tem limite HORÁRIO (memória `brevo-hourly-ratelimit`)
 * — o `brevoGet` reusado respeita `Retry-After`, mas um run completo pode esgotar
 * a cota. Por isso o run é **checkpoint-resumável**: o progresso é durável no
 * próprio DB (upsert incremental em transações de BATCH) + um checkpoint de ids
 * já processados. Se cair (rate-limit/Ctrl+C), re-rodar continua de onde parou.
 *
 * Uso:
 *   npx tsx scripts/clarice-sync-brevo.ts [--db <p>] [--concurrency N] [--limit N]
 *   (--limit: processa só os N primeiros contatos — sync parcial / teste)
 *
 * INCREMENTAL (#2928): --incremental sincroniza SÓ os contatos modificados desde
 * o último sync (deriva de MAX(brevo_modified_at) − 5min), via `modifiedSince` da
 * Brevo → uma fração das chamadas, sem hammering do teto horário. --modified-since
 * <ISO> força uma data explícita. Sem nenhum dos dois = full (comportamento antigo).
 *
 * OPENS CATCH-UP (#4688): abrir um e-mail NÃO toca `modifiedAt` do contato na
 * Brevo — só clique/outras mutações tocam. Isso faz `--incremental` (que
 * enumera contatos via `modifiedSince`) nunca re-visitar quem só abre sem
 * clicar, e `opens_count` degrada continuamente (medido ao vivo em 260806:
 * ~32% de subcontagem agregada antes de um full resync manual). Em vez de
 * depender do `modifiedAt` do contato, o modo incremental TAMBÉM varre os
 * destinatários das campanhas enviadas numa janela recente
 * (`--opens-window-days`, default 7 dias — encolhida de 30 no #5946 pra
 * caber no teto de 100 req/hora da Brevo (ver docstring de
 * `DEFAULT_OPENS_CATCHUP_WINDOW_DAYS` abaixo para o histórico completo)) e
 * fatiando QUANTAS dentro da janela são forçadas a re-exportar POR RUN
 * (`--opens-max-refresh`, default 20 — ver docstring de
 * `DEFAULT_OPENS_CATCHUP_MAX_REFRESH_PER_RUN`, #5946 follow-up: a janela
 * sozinha não bastou, o volume DENTRO dela continuou crescendo com a
 * cadência de envio),
 * reusando a MESMA infra de export por campanha, já validada ao vivo em
 * 260802) via `POST /emailCampaigns/{id}/exportRecipients`, que reporta
 * `Total Opens` por destinatário independente de `modifiedAt`. Os e-mails com
 * abertura registrada nessa janela são re-buscados individualmente
 * (`GET /contacts/{email}`, mesmo parsing/upsert do loop principal — MAX-merge
 * em `opens_count`, nunca regride). Roda só quando `modifiedSince` é
 * conhecido (modo incremental ou `--modified-since` explícito) — o modo full
 * já pega todo mundo com stats exatos, catch-up seria redundante ali.
 * Desligável via `--no-catch-opens`. FAIL-SOFT: uma falha no catch-up (rede,
 * rate-limit) vira warning no stderr + `opens_catchup: { ok: false, error }`
 * no summary (união discriminada, #4722 item 1 — `ok: true` sempre carrega
 * `result` completo, `ok: false` só a mensagem) — nunca reprova o sync
 * principal, que já persistiu com sucesso. O cache de
 * campanha do catch-up vive em `OPENS_CATCHUP_CACHE_DIR`, subdiretório
 * PRÓPRIO (nunca o `CAMPAIGN_CACHE_DIR` real da #4451, #4717 follow-up
 * achado 5) — `--cache-dir <dir>` sobrescreve pra isolamento em teste.
 *
 * Requer BREVO_CLARICE_API_KEY no env. Stdout: JSON summary. Stderr: progresso.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { brevoGetWithNetworkRetry, BrevoRateLimitError } from "./lib/brevo-client.ts";
import { PollBudgetExhaustedError, type PollOptions } from "./lib/brevo-process-poll.ts";
import { pool, poolAbortOnError } from "./lib/pool.ts";
import { parseBrevoContact, type BrevoColumns } from "./lib/brevo-stats.ts";
import {
  openClariceDb,
  makeBrevoUpsert,
  recomputeDerived,
  DEFAULT_DB_PATH,
} from "./lib/clarice-db.ts";
import { getArg, getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { retryOnSqliteBusy } from "./lib/sqlite-busy-retry.ts";
import { ISO_LIKE_DATE_RE } from "./lib/iso-like-date.ts";
import {
  makeRealCampaignExportClient,
  isWithinRefetchWindow,
  loadCampaignCache,
  saveCampaignCache,
  campaignCacheFromCsv,
  pollExportUntilDone,
  CAMPAIGN_CACHE_DIR,
  type CampaignExportClient,
  type CampaignCache,
  type SentCampaignRef,
} from "./clarice-engagement-cohorts-v2.ts"; // #4688: reusa a infra de export por campanha (#4451)

/**
 * #4205: caminho dos 2 arquivos de checkpoint (full + incremental — #2928,
 * SEPARADOS pra não clobberar o resume um do outro), derivado do DIRETÓRIO do
 * `--db` em vez de um `ROOT`/`data/` fixo. Antes eram consts hardcoded
 * ancoradas em `data/clarice-subscribers/` do repo real — impossível de
 * injetar em teste (um `main()` de teste escreveria fora do tmpdir isolado,
 * em `data/`, que num worktree fresco/cloud nem existe). Como o checkpoint já
 * sempre viveu ao LADO do `.db` (mesma pasta `data/clarice-subscribers/` do
 * `DEFAULT_DB_PATH`), co-localizar com `dbPath` preserva o comportamento de
 * produção (`--db` omitido → mesmo path de sempre) e torna o par
 * db+checkpoint isolável junto num `--db <tmp>/store.db` de teste. Pura/testável.
 */
export function checkpointPathsForDb(dbPath: string): {
  checkpoint: string;
  checkpointInc: string;
  watermark: string;
} {
  const dir = resolve(dbPath, "..");
  return {
    checkpoint: resolve(dir, ".brevo-sync-checkpoint.json"),
    checkpointInc: resolve(dir, ".brevo-sync-checkpoint-inc.json"),
    // #9762: marca d'água do incremental — ver `anchorForIncremental`.
    watermark: resolve(dir, ".brevo-sync-watermark.json"),
  };
}
const BATCH = 200; // flush no DB + checkpoint a cada N contatos (durabilidade)
const PAGE_PACING_MS = 250; // pacing leve entre páginas do listing (memória brevo-hourly-ratelimit)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Checkpoint {
  listingComplete: boolean;
  ids: Array<{ id: number; email: string }>;
  doneIds: number[];
  // #2928: qual modifiedSince gerou esta enumeração (null = full). Resume só é
  // válido pra mesma data; datas/modos diferentes descartam o checkpoint.
  modifiedSince?: string | null;
  /**
   * #9762: instante (relógio local, ISO) em que a enumeração DESTE run
   * começou. Vira a marca d'água do próximo incremental quando o run termina
   * — ver `anchorForIncremental`. Ausente em checkpoint legado.
   */
  listingStartedAt?: string;
  /**
   * #9783: a enumeração veio de `--modified-since` explícito. Um resume por
   * `--incremental` herda esse cutoff (possivelmente posterior à marca d'água)
   * e por isso NÃO pode avançar a marca ao concluir.
   */
  explicit?: boolean;
}

function loadCheckpoint(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(cp: Checkpoint, path: string): void {
  writeFileSync(path, JSON.stringify(cp), "utf8");
}

/**
 * #2928: path do listing de contatos (limit 500 + offset), com `modifiedSince`
 * opcional encodado. Pure/testável.
 */
export function contactsListPath(offset: number, modifiedSince: string | null): string {
  const since = modifiedSince ? `&modifiedSince=${encodeURIComponent(modifiedSince)}` : "";
  return `/contacts?limit=500&offset=${offset}${since}`;
}

/**
 * #2928: deriva o `modifiedSince` do incremental a partir de MAX(brevo_modified_at)
 * menos um buffer (default 5min, pra não perder contatos na fronteira do último
 * sync). Devolve ISO UTC, ou null se a data for ausente/inválida (→ cai pra full).
 * Pure/testável.
 */
export function deriveIncrementalSince(
  maxBrevoModifiedAt: string | null | undefined,
  bufferMs = 5 * 60_000,
): string | null {
  if (!maxBrevoModifiedAt) return null;
  const t = new Date(maxBrevoModifiedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - bufferMs).toISOString();
}

/**
 * #2929 review: âncora do incremental, ESTÁVEL entre resumes. RESUME (checkpoint
 * incremental pendente com cutoff) → REUSA o cutoff do checkpoint. **Não re-derivar
 * num resume**: `MAX(brevo_modified_at)` avança conforme sincronizamos (flush por
 * batch), então re-derivar estreitaria a janela e PULARIA os contatos ainda
 * pendentes de `[cutoff_antigo, cutoff_novo)` — quebrando a resumibilidade sob
 * rate-limit. Run novo (sem checkpoint) → deriva de MAX − buffer. Pure/testável.
 */
export function anchorForIncremental(
  checkpointModifiedSince: string | null | undefined,
  maxBrevoModifiedAt: string | null | undefined,
  bufferMs = 5 * 60_000,
  watermark?: string | null,
): string | null {
  if (checkpointModifiedSince) return checkpointModifiedSince;
  // #9762: a marca d'água (início da enumeração do último run CONCLUÍDO) vence
  // o MAX(brevo_modified_at). O MAX avança com contatos buscados DEPOIS da
  // listagem (o catch-up re-busca dezenas de milhares de contatos minutos ou
  // horas mais tarde), então derivar dele pulava todo contato modificado
  // entre o fim da listagem e o último GET do run — medido no log do `300`:
  // run de 03/10 às 11:30 → âncora do dia seguinte em 13:22; run de 05/10 às
  // 11:30 → âncora em 13:54. Um descadastro/blacklist nessa faixa, de quem não
  // estava entre os destinatários re-buscados pelo catch-up, nunca chegava ao
  // store (`send_eligible` seguia 1). Sem marca d'água (1º run pós-deploy,
  // checkpoint legado) → cai no MAX, comportamento anterior.
  const fromWatermark = deriveIncrementalSince(watermark, bufferMs);
  if (fromWatermark) return fromWatermark;
  return deriveIncrementalSince(maxBrevoModifiedAt, bufferMs);
}

/**
 * #9762: lê a marca d'água gravada pelo último run concluído. null se ausente
 * — ou se o arquivo existe mas é ilegível/inválido, caso em que loga ⚠️ (a
 * âncora cai no MAX(brevo_modified_at), que pode pular contatos).
 */
export function loadWatermark(path: string): string | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))?.listingStartedAt;
    if (typeof raw === "string" && ISO_LIKE_DATE_RE.test(raw) && Number.isFinite(Date.parse(raw))) return raw;
  } catch (e) {
    raw = `ilegível: ${(e as Error).message}`;
  }
  console.error(
    `⚠️  marca d'água ${path} inválida (${String(raw).slice(0, 80)}) — incremental cai no MAX(brevo_modified_at).`,
  );
  return null;
}

/** #9762: grava a marca d'água (atômico — um arquivo truncado viraria "inválida" e cairia no MAX). */
export function saveWatermark(path: string, listingStartedAt: string): void {
  writeFileAtomic(path, JSON.stringify({ listingStartedAt }), { fsync: false });
}

// ─── Opens catch-up (#4688) ──────────────────────────────────────────────
//
// Abrir um e-mail não toca `modifiedAt` — o incremental (que enumera por
// `modifiedSince`) nunca revisita esses contatos, então `opens_count`
// degrada continuamente pra quem abre sem clicar. Em vez disso, varremos os
// destinatários das campanhas ENVIADAS numa janela recente via
// `exportRecipients` (`Total Opens` por destinatário, independe de
// `modifiedAt` do contato) e re-buscamos cada opener individualmente — mesmo
// caminho preciso de sempre (`GET /contacts/{email}`, MAX-merge no upsert).

/** Janela default (dias). Era 30 (mesma ordem de grandeza do
 * DEFAULT_REFETCH_WINDOW_DAYS de clarice-engagement-cohorts-v2.ts, #4451,
 * "chute inicial" nunca recalibrado empiricamente) — encolhida para 7 no
 * #5946 (decisão do editor, 260823): com 30 dias o volume de campanhas na
 * janela cresceu para ~121, sozinho estourando o teto de 100 req/hora da
 * Brevo (docs/brevo-rate-limits.md) e causando falhas parciais em streak no
 * job diário. Override via --opens-window-days. */
export const DEFAULT_OPENS_CATCHUP_WINDOW_DAYS = 7;

/**
 * #4717 follow-up (achado 5): subdiretório PRÓPRIO do catch-up, irmão de
 * `CAMPAIGN_CACHE_DIR` (não o mesmo diretório). `CAMPAIGN_CACHE_DIR` é o
 * cache que `clarice-engagement-cohorts-v2.ts` (#4451) usa como artefato
 * ESTÁVEL pro cutover v1-vs-v2 ainda em dry-run — o catch-up roda diariamente
 * (task `Diaria-Clarice-Sync`, 08:30) com `forceRefresh: true` e sobrescreve
 * o cache de cada campanha na janela a cada execução; compartilhar o mesmo
 * diretório acoplaria essas duas features sem documentação (a #4451 acabaria
 * vendo o cache re-escrito por uma rotina que ela não conhece). Separar em
 * `opens-catchup/` evita a colisão sem exigir coordenação entre as duas.
 */
export const OPENS_CATCHUP_CACHE_DIR = resolve(CAMPAIGN_CACHE_DIR, "..", "opens-catchup");

/**
 * #5946: teto de quantas campanhas JÁ CACHEADAS este RUN força re-export
 * (`forceRefresh: true`). Antes desta issue, TODA campanha na janela era
 * forçada todo dia (`forceRefresh: true` incondicional) — quando a janela
 * cresceu (~62-121 campanhas, ver diagnóstico da issue), isso sozinho
 * excede o teto de 100 req/hora/CONTA da família `/v3/emailCampaigns*`
 * (`docs/brevo-rate-limits.md`), compartilhado com `clarice-build-segment.ts`/
 * `clarice-plan-wave.ts` na mesma hora.
 *
 * A janela (#5946, PR #5971) já foi encolhida de 30→7 dias, mas o volume de
 * campanhas DENTRO da janela continua crescendo com a cadência de envio —
 * encolher a janela de novo penaliza a cobertura de opens tardios. Em vez
 * disso, fatia-se o TRABALHO por execução: só as `maxRefreshPerRun`
 * campanhas mais "estagnadas" (sem export, ou com o `exportedAt` mais
 * antigo — `pickCampaignsToRefresh` abaixo) são forçadas a re-exportar
 * nesta run; as demais reusam o cache em disco já existente (sem chamada de
 * rede — `getOrFetchCampaignCache` com `forceRefresh: false` só busca se
 * NÃO houver cache, então uma campanha nunca vista ainda é sempre buscada,
 * independente do teto).
 *
 * Progresso é DURÁVEL sem precisar de um checkpoint dedicado: o
 * `exportedAt` de cada `CampaignCache` já persiste em disco
 * (`OPENS_CATCHUP_CACHE_DIR`) entre execuções — a campanha refrescada hoje
 * fica com `exportedAt` recente e cai para o fim da fila de prioridade
 * amanhã; a que não coube hoje (a mais antiga) sobe pro topo. Rotação
 * auto-corretiva: uma campanha que falhar o export mantém o `exportedAt`
 * velho (ou ausente) e continua prioritária nas próximas execuções, até
 * conseguir. 20 campanhas ≈ 2 chamadas Brevo cada (export + poll) ≈ 40
 * requisições — cabe com folga no teto de 100/h mesmo somando a paginação
 * do listing e outros consumidores da mesma hora.
 */
export const DEFAULT_OPENS_CATCHUP_MAX_REFRESH_PER_RUN = 20;

/**
 * #5946: decide QUAIS campanhas (dentre as `recent`, já filtradas pela
 * janela) ganham `forceRefresh: true` nesta execução. Pura/testável — sem
 * I/O, recebe o `exportedAt` já lido do cache em disco pelo chamador.
 *
 * Prioridade: campanha SEM cache (nunca exportada — `undefined`) sempre
 * vem antes de qualquer campanha já cacheada (precisa de baseline antes de
 * mais nada); entre as já cacheadas, a de `exportedAt` mais ANTIGO (a mais
 * estagnada, a que há mais tempo não recebe re-export) vem primeiro. Ordem
 * estável por id em empates (determinístico p/ teste). `max <= 0` ou
 * `recent.length <= max` → sem corte, refresca todas (comportamento
 * anterior preservado quando o volume já cabe no orçamento).
 */
export function pickCampaignsToRefresh(
  recent: SentCampaignRef[],
  exportedAtById: Map<number, string | undefined>,
  max: number,
): Set<number> {
  if (max <= 0 || recent.length <= max) return new Set(recent.map((c) => c.id));
  const ranked = [...recent].sort((a, b) => {
    const ea = exportedAtById.get(a.id);
    const eb = exportedAtById.get(b.id);
    if (ea === undefined && eb === undefined) return a.id - b.id;
    if (ea === undefined) return -1; // nunca exportada → prioridade máxima
    if (eb === undefined) return 1;
    const ta = Date.parse(ea);
    const tb = Date.parse(eb);
    if (ta !== tb) return ta - tb; // mais antigo primeiro
    return a.id - b.id;
  });
  return new Set(ranked.slice(0, max).map((c) => c.id));
}

/**
 * Extrai o conjunto de e-mails normalizados com abertura registrada em
 * QUALQUER dos caches de campanha passados (union — um opener em 2
 * campanhas diferentes entra 1x). Pura — testável sem rede (#633).
 */
export function collectOpenedEmails(caches: CampaignCache[]): Set<string> {
  const out = new Set<string>();
  for (const cache of caches) {
    for (const [email, flags] of Object.entries(cache.recipients)) {
      if (flags.opened) out.add(email);
    }
  }
  return out;
}

interface DeliveredStats {
  count: number;
  lastSentAt: string | null;
}

/**
 * #8033: `Delivered_Date`/`sentDate` do export de campanha da Brevo devem vir
 * no formato `AAAA-MM-DD[ HH:MM:SS]` (confirmado em `test/clarice-engagement-
 * cohorts-v2.test.ts`) — mas achado ao vivo (ciclo 2608-09, 4 contatos)
 * mostrou a Brevo devolvendo, nalgumas linhas, `DD-MM-AAAA HH:MM:SS`
 * (dia-mês-ano). `Date.parse`/`new Date(...)` do JS trata qualquer string
 * ambígua como MM-DD-AAAA (americano) — `"03-09-2026"` virava 9 de MARÇO, não
 * 3 de setembro. O guard do #6887 só rejeitava `NaN` (data ilegível); uma
 * string ambígua MAS parseável (dia ≤12, então "faz sentido" nos dois
 * formatos) passava direto e corrompia `last_sent_at` em silêncio. Este
 * regex (`ISO_LIKE_DATE_RE`, `lib/iso-like-date.ts` — fonte única, reusada
 * também pelo reparo em `repair-clarice-last-sent-at-format.ts`) exige o
 * formato ISO-like ANTES de sequer chamar `Date.parse` — qualquer outro
 * formato (incluindo o ambíguo DD-MM) é tratado como inválido/descartado,
 * nunca "adivinhado".
 */

/** #6814: agrega entregas por contato a partir dos exports de campanha. */
export function collectDeliveredStats(caches: CampaignCache[]): Map<string, DeliveredStats> {
  const out = new Map<string, DeliveredStats>();
  for (const cache of caches) {
    for (const [email, flags] of Object.entries(cache.recipients)) {
      if (!flags.delivered) continue;
      const current = out.get(email) ?? { count: 0, lastSentAt: null };
      current.count += 1;
      // #6887 (review, P2 média confiança): `isFilled()` só checa string
      // não-vazia, não valida formato de data — uma `Delivered_Date`
      // malformada (locale diferente, "N/A", etc.) que fosse o PRIMEIRO
      // candidato processado passava direto (`!current.lastSentAt` curto-
      // circuita antes de comparar), corrompendo `lastSentAt` com um valor
      // não-parseável que nenhum candidato válido posterior corrigiria
      // (`Date.parse` de um valor corrompido é sempre NaN, então
      // `candidateTime > currentTime` nunca mais seria true). Validar
      // `Date.parse` explicitamente ANTES de aceitar qualquer candidato —
      // nunca aceitar NaN, seja como candidato novo ou como base de
      // comparação.
      //
      // #8033: `Date.parse` sozinho não bastava — aceitava strings AMBÍGUAS
      // mas mal-formatadas (DD-MM-AAAA lido como MM-DD-AAAA americano).
      // `ISO_LIKE_DATE_RE` exige o formato esperado ANTES de chamar
      // `Date.parse`; qualquer outro formato (incluindo o ambíguo) é
      // descartado como se fosse `NaN` — mesma categoria de "não confiável"
      // do guard do #6887, não uma exceção nova.
      //
      // #9762: `??` só cai pra `cache.sentDate` quando `deliveredAt` é
      // null/undefined — mas a Brevo devolve `Delivered_Date` em DD-MM-AAAA
      // em TODAS as linhas dos exports de 2609-10 (medido ao vivo), que o
      // regex rejeita; o candidato virava null e `last_sent_at` nunca era
      // preenchido. Fallback agora por VALIDADE: primeiro candidato ISO-like
      // entre `deliveredAt` e `sentDate` (a data de envio da campanha).
      const candidate =
        [flags.deliveredAt, cache.sentDate].find((d): d is string => !!d && ISO_LIKE_DATE_RE.test(d)) ?? null;
      const candidateTime = candidate ? Date.parse(candidate) : NaN;
      if (!Number.isNaN(candidateTime)) {
        const currentTime = current.lastSentAt ? Date.parse(current.lastSentAt) : NaN;
        if (Number.isNaN(currentTime) || candidateTime > currentTime) {
          current.lastSentAt = candidate;
        }
      }
      out.set(email, current);
    }
  }
  return out;
}

// ─── Export pendente retomável (#9762) ─────────────────────────────────────
//
// Log do `300` (30/09–04/10): de 6 a 16 campanhas por run caíam em
// `PollBudgetExhaustedError` (90 polls × 2s sem status terminal — inclusive
// campanhas de 17 destinatários, então não é tamanho: é a FILA de export da
// conta) e outras em `Download do CSV ... (404)` logo após o processo
// completar. O run seguinte disparava um export NOVO pra cada uma — mais um
// POST na família de 100 req/h e mais um processo na mesma fila que já não
// andava, enquanto o export anterior terminava sozinho e ninguém o lia.
//
// Agora o `processId` de todo export disparado é gravado em disco ANTES do
// poll. Se o run não o vê terminar, ele continua PENDENTE: a campanha conta
// como falha (o alarme do #5339 segue vendo), o `exportedAt` não é tocado
// (nunca vira "sincronizada"), e o próximo run consulta o MESMO processo
// antes de pensar em disparar outro — mesmo que a campanha já tenha saído da
// janela de dias, que não pode mais engolir um export que nunca foi lido.

/** Idade máxima de um export pendente antes de ser descartado e redisparado. */
export const PENDING_EXPORT_MAX_AGE_MS = 7 * 86_400_000;

/**
 * Quantos runs seguidos um export pendente aguenta 5xx da Brevo ao ser
 * consultado antes de ser descartado (e, dentro da janela, redisparado).
 * Curto de propósito: 5xx não é a fila andando devagar (isso é
 * `PollBudgetExhaustedError`, que não conta aqui) — é o endpoint do processo
 * falhando, e um processo que dá 5xx em 2 runs seguidos provavelmente não
 * volta.
 */
export const PENDING_EXPORT_MAX_5XX_RUNS = 2;

/** Espera entre tentativas de baixar o CSV quando o link assinado ainda devolve 404. */
export const CSV_404_RETRY_DELAYS_MS = [5_000, 15_000];

export interface PendingExport {
  campaignId: number;
  processId: number | string;
  requestedAt: string;
  /** Runs seguidos em que a consulta do processo esgotou o retry com 5xx. */
  serverErrors?: number;
}

export function pendingExportPath(campaignId: number, cacheDir: string): string {
  return resolve(cacheDir, "pending", `${campaignId}.json`);
}

/**
 * Lê o export pendente da campanha. `null` se ausente — ou se o arquivo
 * existe mas é ilegível/inválido (JSON corrompido, `campaignId` de outra
 * campanha, `requestedAt` que não é data, `processId` ausente): nesse caso
 * loga ⚠️ — o chamador (`fetchCampaignForCatchup`) descarta o arquivo.
 */
export function loadPendingExport(campaignId: number, cacheDir: string): PendingExport | null {
  const path = pendingExportPath(campaignId, cacheDir);
  if (!existsSync(path)) return null;
  let reason: string;
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Partial<PendingExport> | null;
    const pidOk = typeof p?.processId === "number" || (typeof p?.processId === "string" && p.processId !== "");
    if (
      p &&
      p.campaignId === campaignId &&
      pidOk &&
      typeof p.requestedAt === "string" &&
      Number.isFinite(Date.parse(p.requestedAt))
    ) {
      return p as PendingExport;
    }
    reason = `conteúdo inválido (${JSON.stringify(p).slice(0, 120)})`;
  } catch (e) {
    reason = `ilegível: ${(e as Error).message}`;
  }
  console.error(`⚠️  catch-up: export pendente da campanha ${campaignId} em ${path} ${reason} — descartado.`);
  return null;
}

function savePendingExport(p: PendingExport, cacheDir: string): void {
  mkdirSync(resolve(cacheDir, "pending"), { recursive: true });
  writeFileAtomic(pendingExportPath(p.campaignId, cacheDir), JSON.stringify(p), { fsync: false });
}

function clearPendingExport(campaignId: number, cacheDir: string): void {
  const path = pendingExportPath(campaignId, cacheDir);
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Varre `pending/*.json` e apaga o que passou de `PENDING_EXPORT_MAX_AGE_MS`
 * — independente da lista de campanhas (uma campanha que sumiu da listagem
 * da Brevo deixaria o arquivo órfão pra sempre). Idade por `requestedAt`;
 * arquivo ilegível usa o mtime. Fail-soft: erro de I/O vira warning.
 */
export function sweepExpiredPendingExports(cacheDir: string, nowMs: number): number {
  const dir = resolve(cacheDir, "pending");
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = resolve(dir, name);
    try {
      let requestedMs = NaN;
      try {
        requestedMs = Date.parse(JSON.parse(readFileSync(path, "utf8"))?.requestedAt);
      } catch {
        // ilegível — cai no mtime abaixo
      }
      if (!Number.isFinite(requestedMs)) requestedMs = statSync(path).mtimeMs;
      if (nowMs - requestedMs > PENDING_EXPORT_MAX_AGE_MS) {
        unlinkSync(path);
        removed++;
        console.error(
          `⚠️  catch-up: export pendente ${name} expirado (> ${PENDING_EXPORT_MAX_AGE_MS / 86_400_000}d) — descartado.`,
        );
      }
    } catch (e) {
      console.error(`⚠️  catch-up: varredura de pendente ${name} falhou: ${(e as Error).message}`);
    }
  }
  return removed;
}

/**
 * 429 REAL da conta (rate limit por CONTA/HORA) — o único sinal que abre o
 * circuito de "exports novos suspensos". `brevoGet` lança o mesmo
 * `BrevoRateLimitError` para 5xx repetidos; esses NÃO contam (`status`
 * distingue). `status` null = construção legada sem a informação → tratado
 * como 429 (comportamento anterior, conservador).
 */
export function isAccountRateLimit(e: unknown): boolean {
  return e instanceof BrevoRateLimitError && (e.status === 429 || e.status == null);
}

/**
 * 5xx repetido da Brevo (retry de `brevoGet` esgotado sem nenhum 429) ou falha
 * de rede (`TypeError` do fetch/undici — #9783: `pollProcess`/download não têm
 * retry de rede; um blip não pode descartar o pendente de uma campanha fora da
 * janela, que nunca mais seria exportada). Mesmo contador do 5xx.
 */
function isBrevoServerError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  return e instanceof BrevoRateLimitError && e.status != null && e.status >= 500;
}

/**
 * Falha LOCAL depois de o CSV já ter sido baixado (parse, gravação do cache):
 * o export do lado da Brevo está bom — o pendente fica, e o próximo run o lê
 * de novo em vez de disparar outro.
 */
export class CatchupLocalError extends Error {
  constructor(campaignId: number, cause: unknown) {
    super(`campanha ${campaignId}: falha local ao processar o export (${(cause as Error)?.message ?? String(cause)})`);
    this.name = "CatchupLocalError";
  }
}

/** Erro que deixa o export PENDENTE (o processo pode ainda terminar do lado da Brevo). */
function keepsExportPending(e: unknown): boolean {
  return e instanceof PollBudgetExhaustedError || isAccountRateLimit(e) || e instanceof CatchupLocalError;
}

/** Circuito aberto: a conta já devolveu 429 neste run — nenhum export NOVO é disparado nem pendente consultado. */
export class CatchupRateLimitedError extends Error {
  constructor(campaignId: number) {
    super(
      `campanha ${campaignId}: export não disparado/consultado — a Brevo já devolveu 429 neste run ` +
        `(rate limit por CONTA/HORA, docs/brevo-rate-limits.md); fica para o próximo run.`,
    );
    this.name = "CatchupRateLimitedError";
  }
}

async function downloadCsvWithRetry(
  client: CampaignExportClient,
  url: string,
  sleepFn: (ms: number) => Promise<void>,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.downloadCsv(url);
    } catch (e) {
      // 404 logo após o processo completar = arquivo ainda não publicado no
      // storage (visto em 01/10: 8 campanhas). Outros erros não se resolvem esperando.
      if (attempt >= CSV_404_RETRY_DELAYS_MS.length || !/\(404\)/.test((e as Error).message)) throw e;
      await sleepFn(CSV_404_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export interface CatchupFetchOptions {
  cacheDir: string;
  forceRefresh: boolean;
  /**
   * false = circuito aberto (429 já visto neste run) ou campanha fora da
   * janela: nunca dispara export NOVO — só retoma pendente / lê cache.
   */
  allowNewExport: boolean;
  /** false = circuito aberto: nem consulta o pendente (o GET /processes também gasta quota). */
  allowPoll?: boolean;
  /** Campanha dentro da janela de dias? Fora dela só um pendente é retomado — nunca export novo. */
  inWindow?: boolean;
  nowMs: number;
  now?: () => string;
  poll?: PollOptions;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Busca o export de UMA campanha para o catch-up. Ordem:
 *   1. export PENDENTE de um run anterior → consulta o mesmo processo;
 *   2. sem refresh forçado e com cache em disco → cache;
 *   3. export novo (gravando o `processId` como pendente antes do poll).
 * Lança se não conseguiu um export FRESCO quando precisava de um — inclusive
 * quando um pendente falhou e não há como redisparar (o chamador conta a
 * falha e decide se cai no cache antigo).
 */
export async function fetchCampaignForCatchup(
  client: CampaignExportClient,
  campaign: SentCampaignRef,
  opts: CatchupFetchOptions,
): Promise<{ cache: CampaignCache; source: "cache" | "pending" | "export" }> {
  const { cacheDir } = opts;
  const sleepFn = opts.sleep ?? sleep;
  const allowPoll = opts.allowPoll ?? true;
  const inWindow = opts.inWindow ?? true;
  const finish = async (processId: number | string, exportedAt: string): Promise<CampaignCache> => {
    const exportUrl = await pollExportUntilDone(client, processId, opts.poll);
    const csvText = await downloadCsvWithRetry(client, exportUrl, sleepFn);
    let cache: CampaignCache;
    try {
      cache = campaignCacheFromCsv(csvText, campaign, exportedAt);
      saveCampaignCache(cache, cacheDir);
    } catch (e) {
      throw new CatchupLocalError(campaign.id, e);
    }
    // O cache já está gravado: falhar aqui não pode derrubar a campanha. O
    // pendente que sobrar é retomado no próximo run (idempotente).
    try {
      clearPendingExport(campaign.id, cacheDir);
    } catch (e) {
      console.error(
        `⚠️  catch-up: cache da campanha ${campaign.id} gravado, mas o pendente não foi limpo: ${(e as Error).message}`,
      );
    }
    return cache;
  };

  let pendingFailed = false;
  const pendingFileExists = existsSync(pendingExportPath(campaign.id, cacheDir));
  const pending = pendingFileExists ? loadPendingExport(campaign.id, cacheDir) : null;
  if (pending) {
    const age = opts.nowMs - Date.parse(pending.requestedAt);
    if (age <= PENDING_EXPORT_MAX_AGE_MS) {
      if (!allowPoll) throw new CatchupRateLimitedError(campaign.id);
      try {
        // exportedAt = quando o export foi PEDIDO: o snapshot da Brevo é desse
        // instante, não de agora (senão a rotação do #5946 o trataria como
        // mais fresco do que é).
        return { cache: await finish(pending.processId, pending.requestedAt), source: "pending" };
      } catch (e) {
        // Ainda processando, 429, ou falha local: continua pendente, NÃO
        // dispara outro export na mesma fila — tenta de novo no próximo run.
        if (keepsExportPending(e)) throw e;
        if (isBrevoServerError(e)) {
          const serverErrors = (pending.serverErrors ?? 0) + 1;
          if (serverErrors < PENDING_EXPORT_MAX_5XX_RUNS) {
            savePendingExport({ ...pending, serverErrors }, cacheDir);
            throw e;
          }
        }
        // Processo falhou/sumiu/CSV inacessível (ou 5xx persistente): descarta.
        console.error(
          `⚠️  catch-up: export pendente da campanha ${campaign.id} (processo ${pending.processId}) ` +
            `descartado: ${(e as Error).message}`,
        );
        pendingFailed = true;
      }
    } else {
      console.error(
        `⚠️  catch-up: export pendente da campanha ${campaign.id} (processo ${pending.processId}, ` +
          `pedido em ${pending.requestedAt}) expirado — descartado.`,
      );
    }
  }
  if (pendingFileExists) clearPendingExport(campaign.id, cacheDir);

  if (!inWindow) {
    // Fora da janela só um pendente justifica processar a campanha — nunca
    // um export novo. Chegar aqui é perda: contar como falha (alarme vê).
    throw new Error(
      `campanha ${campaign.id} fora da janela: export pendente ${pendingFailed ? "falhou" : "expirado/inválido"} ` +
        `e não é redisparado.`,
    );
  }
  // Pendente que FALHOU não cai no cache antigo como se fosse sucesso: a
  // campanha precisa de um export fresco (ou conta como falha).
  if (!opts.forceRefresh && !pendingFailed) {
    const cached = loadCampaignCache(campaign.id, cacheDir);
    if (cached) return { cache: cached, source: "cache" };
  }
  if (!opts.allowNewExport) throw new CatchupRateLimitedError(campaign.id);

  const { processId } = await client.exportRecipients(campaign.id);
  const requestedAt = new Date(opts.nowMs).toISOString();
  savePendingExport({ campaignId: campaign.id, processId, requestedAt }, cacheDir);
  try {
    return { cache: await finish(processId, (opts.now ?? (() => new Date().toISOString()))()), source: "export" };
  } catch (e) {
    if (isBrevoServerError(e)) {
      savePendingExport({ campaignId: campaign.id, processId, requestedAt, serverErrors: 1 }, cacheDir);
    } else if (!keepsExportPending(e)) {
      clearPendingExport(campaign.id, cacheDir);
    }
    throw e;
  }
}

/**
 * #9762: destinatários com SUPRESSÃO registrada no export da campanha (hard/soft
 * bounce ou descadastro). Quem dá bounce não aparece como entregue nem como
 * abertura — antes ficava fora da re-busca do catch-up, e um hard bounce vira
 * `emailBlacklisted=true` na Brevo sem necessariamente passar pelo
 * `modifiedSince` do incremental: `send_eligible` seguia 1 no store. Pura.
 */
export function collectSuppressedEmails(caches: CampaignCache[]): Set<string> {
  const out = new Set<string>();
  for (const cache of caches) {
    for (const [email, flags] of Object.entries(cache.recipients)) {
      if (flags.bounced || flags.unsubscribed) out.add(email);
    }
  }
  return out;
}

export interface OpensCatchupDeps {
  /** Cliente de export de campanha — real (`makeRealCampaignExportClient`) ou fake em teste. */
  client: CampaignExportClient;
  /** Busca 1 contato por identificador (email ou id) — devolve o body cru da Brevo. */
  fetchContact: (identifier: string) => Promise<Record<string, any>>;
  /** Upsert no store — mesma função usada pelo loop principal (MAX-merge, nunca regride). */
  upsert: (cols: BrevoColumns) => void;
  cacheDir?: string;
  windowDays?: number;
  nowMs?: number;
  /**
   * #6352: gerador do `exportedAt` gravado em disco a cada export real
   * (repassado a `getOrFetchCampaignCache`'s `opts.now`, que só grava o
   * relógio de parede se ninguém injetar nada). Sem este wiring, `nowMs`
   * acima só afetava o filtro de janela (`isWithinRefetchWindow`) — a
   * gravação do `exportedAt` que decide a ROTAÇÃO (`pickCampaignsToRefresh`)
   * sempre caía no `Date.now()` real, então 2 execuções sequenciais rápidas
   * o bastante (comum em CI) podiam colidir no mesmo milissegundo e reabrir
   * o empate por id em vez de rotacionar (achado ao vivo #6352: `run 3`
   * exigia `exportedAt` da campanha 1 estritamente mais recente que o da
   * campanha 2, mas as duas chamadas de `runOpensCatchup` em sequência
   * rápida gravavam o mesmo instante). Produção nunca passa isto — cai no
   * default real; só o teste precisa de um relógio determinístico.
   */
  now?: () => string;
  concurrency?: number;
  /** #9762: opções de poll do processo de export (teste injeta sleep/maxAttempts). */
  poll?: PollOptions;
  /** #9762: sleep injetável (retry de download 404). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * #5946: teto de campanhas JÁ CACHEADAS forçadas a re-exportar nesta run
   * (ver docstring de `DEFAULT_OPENS_CATCHUP_MAX_REFRESH_PER_RUN`). Campanha
   * sem cache ainda é sempre buscada, independente deste teto — só o
   * RE-fetch de quem já tem baseline é fatiado. `undefined` cai no default;
   * `<= 0` desliga o fatiamento (refresca todas, comportamento pré-#5946).
   */
  maxRefreshPerRun?: number;
  /**
   * #4722 item 2: mesma semântica do `--limit` do loop principal — trunca
   * quantos openers são de fato re-buscados/upsertados (debug/teste rápido).
   * Antes o `--limit N` do CLI só cobria o loop principal; o catch-up sempre
   * varria TODAS as campanhas na janela + TODOS os openers, mesmo com
   * `--limit 10`. `openersFound` no resultado continua reportando o total
   * REAL de openers na janela (pré-limite) — só o processamento é truncado,
   * pra não mascarar quantos openers de fato existiam. undefined/0/negativo =
   * sem limite (comportamento anterior, default de produção).
   */
  limit?: number;
  /**
   * #4722 item 3: agrupa as escritas do catch-up em batches de `batchSize`
   * (default 200, mesmo `BATCH` do loop principal), opcionalmente dentro de
   * uma transação real fornecida pelo chamador — mesmo padrão do
   * `flush()`/BEGIN-COMMIT do loop principal (menos overhead de N transações
   * implícitas do SQLite pra volumes grandes de openers, e durabilidade em
   * lote em vez de 1 `deps.upsert` isolado por contato). `main()` sempre
   * passa a wrapper real (`db.exec("BEGIN")`/COMMIT/ROLLBACK); testes que
   * omitirem só chamam `fn()` direto (sem atomicidade real, mas sem exigir
   * um DB de verdade no fake).
   */
  transaction?: (fn: () => void) => void;
  batchSize?: number;
}

export interface OpensCatchupResult {
  campaignsConsidered: number;
  campaignsInWindow: number;
  /**
   * #5946: campanhas na janela que NÃO foram re-exportadas nesta execução por
   * causa do teto `maxRefreshPerRun` — leram do cache em disco. Sem este
   * número, um streak que persista depois do fatiamento é indiagnosticável:
   * `campaignsInWindow` conta todas as campanhas da janela (refrescadas ou
   * não), então não distingue "o teto está grande demais pra cota do momento"
   * de "o problema não era volume de re-export". É a primeira pergunta de
   * quem for investigar o próximo streak do alarme #5339.
   */
  campaignsSkippedRefresh: number;
  campaignsFailed: number;
  /**
   * #9762: das `campaignsFailed`, quantas tiveram os destinatários lidos do
   * cache ANTIGO em disco (o export fresco falhou, mas os dados de envio já
   * conhecidos continuam valendo). O `exportedAt` não muda — a campanha segue
   * no topo da fila do próximo run.
   */
  campaignsStaleFallback: number;
  /** #9762: exports que seguem pendentes do lado da Brevo — retomados no próximo run. */
  campaignsPending: number;
  /** #9762: campanhas fora da janela de dias processadas só porque tinham export pendente. */
  campaignsPendingOutsideWindow: number;
  /** #9762: o run viu 429 e parou de disparar exports novos. */
  rateLimited: boolean;
  openersFound: number;
  deliveredFound: number;
  /** #9762: destinatários com bounce/descadastro no export, re-buscados pra trazer a supressão ao store. */
  suppressedFound: number;
  deliveredBackfilled: number;
  contactsUpdated: number;
  contactsFailed: number;
}

/**
 * #4722 item 1: união discriminada pro shape do resultado do catch-up no
 * summary JSON — antes era `(OpensCatchupResult & { error?: string }) | null`
 * montado ad-hoc em `main()`, deixando "sucesso com contadores reais" e
 * "falha total com contadores zerados + erro" indistinguíveis no TIPO (só na
 * leitura de `error` em runtime). `ok: true` sempre carrega um `result`
 * completo; `ok: false` carrega só a mensagem — não finge contadores.
 */
export type OpensCatchupOutcome =
  | { ok: true; result: OpensCatchupResult }
  | { ok: false; error: string };

/**
 * Roda o catch-up: campanhas recentes → destinatários com abertura → re-busca
 * individual + upsert. FAIL-SOFT por campanha (uma campanha que falhar no
 * export não aborta as demais) e por contato (um 404/erro pontual não aborta
 * o catch-up inteiro) — o chamador (`main`) decide se uma falha TOTAL vira
 * warning ou propaga.
 */
export async function runOpensCatchup(deps: OpensCatchupDeps): Promise<OpensCatchupResult> {
  const windowDays = deps.windowDays ?? DEFAULT_OPENS_CATCHUP_WINDOW_DAYS;
  const nowMs = deps.nowMs ?? Date.now();
  // #4717 follow-up (achado 5, hardening): o default cai no subdiretório
  // PRÓPRIO do catch-up, nunca em CAMPAIGN_CACHE_DIR (produção compartilhada
  // com a #4451) — `main()` já passa `deps.cacheDir` sempre explicitamente
  // (achado 1), este fallback é só defesa em profundidade pra qualquer
  // caller futuro de runOpensCatchup que esqueça de passar cacheDir.
  const cacheDir = deps.cacheDir ?? OPENS_CATCHUP_CACHE_DIR;
  const concurrency = deps.concurrency ?? 4;
  // #4722 item 3: batch size do flush + wrapper de transação (default: chama
  // fn() direto, sem BEGIN/COMMIT real — testes sem `db` de verdade continuam
  // funcionando; main() sempre passa a wrapper real).
  const batchSize = deps.batchSize ?? BATCH;
  const runInTransaction = deps.transaction ?? ((fn: () => void) => fn());

  const campaigns = await deps.client.listSentCampaigns();
  const recent = campaigns.filter((c) => isWithinRefetchWindow(c, nowMs, windowDays));
  // #9762: pendente velho demais sai antes de tudo — inclusive de campanha que
  // nem aparece mais na listagem (senão o arquivo ficava órfão pra sempre).
  sweepExpiredPendingExports(cacheDir, nowMs);
  const hasPending = (id: number): boolean => existsSync(pendingExportPath(id, cacheDir));
  // #9762: export pendente de um run anterior não some porque a campanha saiu
  // da janela — senão uma campanha que falhou 7 dias seguidos nunca seria lida.
  const recentIds = new Set(recent.map((c) => c.id));
  const pendingOutside = campaigns.filter((c) => !recentIds.has(c.id) && hasPending(c.id));
  const pendingInWindow = recent.filter((c) => hasPending(c.id));

  // #5946: fatia QUAIS campanhas da janela são forçadas a re-exportar nesta
  // run (ver docstring de DEFAULT_OPENS_CATCHUP_MAX_REFRESH_PER_RUN/
  // pickCampaignsToRefresh) — o teto protege a cota compartilhada da família
  // /v3/emailCampaigns* sem encolher a janela em si. Lê o `exportedAt` já
  // persistido em disco (fonte de progresso durável entre execuções, sem
  // checkpoint dedicado).
  const maxRefreshPerRun = deps.maxRefreshPerRun ?? DEFAULT_OPENS_CATCHUP_MAX_REFRESH_PER_RUN;
  const exportedAtById = new Map<number, string | undefined>(
    recent.map((c) => [c.id, loadCampaignCache(c.id, cacheDir)?.exportedAt]),
  );
  // #9762: retomar um pendente também gasta requisições da mesma família
  // (GET /processes) — pendentes (dentro e fora da janela) consomem o teto
  // antes das re-exportações forçadas. Campanha com pendente não entra na
  // seleção: o pendente é o export dela neste run.
  const pendingCount = pendingInWindow.length + pendingOutside.length;
  const refreshCandidates = recent.filter((c) => !hasPending(c.id));
  const toForceRefresh =
    maxRefreshPerRun > 0 && pendingCount >= maxRefreshPerRun
      ? new Set<number>()
      : pickCampaignsToRefresh(
          refreshCandidates,
          exportedAtById,
          maxRefreshPerRun > 0 ? maxRefreshPerRun - pendingCount : 0,
        );

  const caches: CampaignCache[] = [];
  let campaignsFailed = 0;
  let campaignsStaleFallback = 0;
  let campaignsPending = 0;
  let rateLimited = false;
  // #5401: era um `for` SEQUENCIAL — 1 export+poll+download de CSV por vez.
  // Quando a feature nasceu (#4688) a janela de 30 dias cobria ~8 campanhas;
  // medido ao vivo em 260816, a mesma janela hoje cobre 49 (a cadência de
  // envio por cohort/dia cresceu bem além do "chute inicial" da janela — ver
  // docstring de DEFAULT_OPENS_CATCHUP_WINDOW_DAYS). Processadas uma a uma em
  // ordem DESC por data, as campanhas mais ANTIGAS da janela — as que mais
  // precisam do catch-up antes de sair dela pra sempre — ficam no fim da fila
  // e sistematicamente não são alcançadas a tempo (confirmado ao vivo: a
  // campanha "envio 6" — 2606, a mais antiga ainda na janela — nunca teve
  // `brevo_modified_at` tocado por NENHUM catch-up em 27 dias; reproduzido
  // isolando o export dela, que funciona corretamente quando alcançado — o
  // gap é só de ALCANÇAR, não de lógica). `pool()` (mesmo padrão já usado
  // logo abaixo pro re-fetch por contato) reduz o wall-clock total em
  // ~`concurrency`× sem aumentar o volume de chamadas à Brevo — o rate-limit
  // já é respeitado por `brevoGet`/`brevoPost` via `Retry-After`, não pelo
  // loop estar sequencial.
  await pool([...recent, ...pendingOutside], concurrency, async (campaign) => {
    try {
      // #5946: só as `maxRefreshPerRun` campanhas mais estagnadas (ou sem
      // cache ainda) forçam re-export nesta run — as demais reusam o cache
      // em disco (forceRefresh: false só bate a rede se NÃO houver cache,
      // então uma campanha nova é sempre buscada mesmo fora do teto).
      // #9762: export pendente de run anterior é retomado antes de tudo.
      const inWindow = recentIds.has(campaign.id);
      const { cache } = await fetchCampaignForCatchup(deps.client, campaign, {
        cacheDir,
        forceRefresh: toForceRefresh.has(campaign.id),
        allowNewExport: !rateLimited && inWindow,
        allowPoll: !rateLimited,
        inWindow,
        nowMs,
        now: deps.now,
        poll: deps.poll,
        sleep: deps.sleep,
      });
      caches.push(cache);
    } catch (e) {
      campaignsFailed++;
      // Só 429 REAL abre o circuito — 5xx repetido também chega como
      // BrevoRateLimitError, mas não diz nada sobre a quota da conta.
      if (isAccountRateLimit(e)) rateLimited = true;
      if (hasPending(campaign.id)) campaignsPending++;
      // #9762: o export fresco falhou, mas o cache antigo em disco (se houver)
      // ainda diz quem recebeu/abriu — usá-lo mantém o backfill de envios
      // desses destinatários. `exportedAt` intocado: a campanha não conta
      // como sincronizada e segue prioritária no próximo run.
      const stale = loadCampaignCache(campaign.id, cacheDir);
      if (stale) {
        caches.push(stale);
        campaignsStaleFallback++;
      }
      // #4717 follow-up (achado 2): logar a mensagem, não só incrementar o
      // contador — um contador anônimo esconderia erro real (escrita SQLite,
      // regressão de escopo OAuth, timeout de polling) atrás de um número,
      // a mesma classe de subcontagem silenciosa que esta feature existe
      // pra corrigir.
      console.error(
        `⚠️  catch-up: export da campanha ${campaign.id} (${campaign.name}) falhou: ${(e as Error).message}`,
      );
    }
  });

  const openersFull = collectOpenedEmails(caches);
  const deliveredStats = collectDeliveredStats(caches);
  // #4722 item 2: --limit trunca o PROCESSAMENTO (fetch+upsert), não a
  // contagem reportada — openersFound/deliveredFound usam os conjuntos completos.
  const suppressed = collectSuppressedEmails(caches);
  // Supressões primeiro: com --limit, são elas que mudam `send_eligible`.
  const allContacts = new Set([...suppressed, ...openersFull, ...deliveredStats.keys()]);
  const contactEmails =
    deps.limit && deps.limit > 0 ? new Set([...allContacts].slice(0, deps.limit)) : allContacts;

  let contactsUpdated = 0;
  let contactsFailed = 0;
  let deliveredBackfilled = 0;

  // #4722 item 3: escrita em BATCH (mesmo padrão do flush()/BEGIN-COMMIT do
  // loop principal) — o fetch (I/O de rede) segue concorrente via pool();
  // só o upsert (I/O local) é buffered e batelado, opcionalmente dentro de
  // uma transação real (deps.transaction).
  let buffer: BrevoColumns[] = [];
  // #4722 item 3, achado de self-review corrigido pelo coordenador: `flush()`
  // NUNCA deixa uma exceção escapar — se ela escapasse, o catch por-contato
  // do pool() abaixo (pensado só pra falha de BUSCA) capturaria uma falha de
  // ESCRITA em lote e misatribuiria: (a) a mensagem de log culparia o e-mail
  // que só disparou o flush, não o batch inteiro que falhou; (b)
  // `contactsFailed` só seria incrementado em 1, enquanto `contactsUpdated`
  // já tinha sido incrementado otimisticamente pra cada item do batch (até
  // `batchSize`) ANTES do flush — resultando em "N atualizados" pra
  // contatos que na verdade nunca foram persistidos (a transação reverteu).
  // Corrigido: o próprio flush() desfaz o incremento otimista e reatribui o
  // batch inteiro a `contactsFailed`, com log identificando explicitamente
  // uma falha de ESCRITA (não de busca).
  const flush = (): void => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    try {
      runInTransaction(() => {
        for (const cols of batch) deps.upsert(cols);
      });
    } catch (e) {
      contactsUpdated -= batch.length;
      contactsFailed += batch.length;
      console.error(
        `⚠️  catch-up: escrita em lote falhou (${batch.length} contato(s), transação revertida): ${(e as Error).message}`,
      );
    }
  };

  await pool(Array.from(contactEmails), concurrency, async (email) => {
    try {
      const contact = await deps.fetchContact(email);
      const cols = parseBrevoContact(contact);
      if (!cols.email) {
        contactsFailed++; // 404/corpo vazio (contato sumiu entre o export e a re-busca)
        return;
      }
      const delivery = deliveredStats.get(email);
      if (delivery && delivery.count > cols.sends_count) {
        cols.sends_count = delivery.count;
        // #6887 (review, P2 média confiança): este ramo sobrescrevia
        // `cols.last_sent_at` (vindo do GET AO VIVO do contato, sem limite
        // de janela) incondicionalmente por `delivery.lastSentAt`
        // (derivado dos exports de campanha, limitado à janela do
        // catch-up — default 7 dias). Se o GET ao vivo já tivesse um envio
        // MAIS RECENTE que qualquer coisa na janela do catch-up, este ramo
        // regredia o dado. O ramo `else if` abaixo já era defensivo
        // (só preenche se vazio); aplicar o mesmo "mais recente vence" aqui
        // também, em vez de sobrescrita cega.
        if (delivery.lastSentAt && (!cols.last_sent_at || Date.parse(delivery.lastSentAt) > Date.parse(cols.last_sent_at))) {
          cols.last_sent_at = delivery.lastSentAt;
        }
        deliveredBackfilled++;
      } else if (delivery?.lastSentAt && !cols.last_sent_at) {
        cols.last_sent_at = delivery.lastSentAt;
        deliveredBackfilled++;
      }
      buffer.push(cols);
      contactsUpdated++;
    } catch (e) {
      contactsFailed++;
      // #4717 follow-up (achado 2): diferente do `!cols.email` acima (404
      // esperado — contato sumiu entre export e re-busca, não logado), este
      // catch pega falha REAL de BUSCA (rede, parse) — logar sempre. Falha de
      // escrita/upsert nunca chega aqui — `flush()` acima trata a si mesmo,
      // fora deste catch por-contato (achado de self-review, #4722).
      console.error(`⚠️  catch-up: re-busca de ${email} falhou: ${(e as Error).message}`);
    }
    // Fora do try/catch por-contato de propósito — o flush intermediário
    // (buffer cheio) não é parte do resultado desta busca específica, e
    // agora nunca lança (ver comentário do flush acima). Roda mesmo quando
    // a busca deste e-mail falhou, pra não atrasar o batelamento.
    if (buffer.length >= batchSize) flush();
  });
  flush(); // drena o resto do buffer (< batchSize) ao final do pool

  return {
    campaignsConsidered: campaigns.length,
    campaignsInWindow: recent.length,
    // Só conta quem REALMENTE leu do cache: campanha sem `exportedAt` é
    // sempre exportada (não há baseline em disco pra reusar), esteja ela no
    // teto ou não — `recent.length - toForceRefresh.size` contaria essas
    // erradamente como puladas.
    campaignsSkippedRefresh: recent.filter(
      (c) => exportedAtById.get(c.id) !== undefined && !toForceRefresh.has(c.id),
    ).length,
    campaignsFailed,
    campaignsStaleFallback,
    campaignsPending,
    campaignsPendingOutsideWindow: pendingOutside.length,
    rateLimited,
    openersFound: openersFull.size,
    deliveredFound: deliveredStats.size,
    suppressedFound: suppressed.size,
    deliveredBackfilled,
    contactsUpdated,
    contactsFailed,
  };
}

/**
 * Enumera contatos (id + email) paginando /contacts. Resumível.
 * #2928: com `modifiedSince` (ISO), enumera SÓ os contatos modificados desde
 * então (Brevo `modifiedSince`) — o incremental. null = full.
 */
async function enumerateContacts(
  apiKey: string,
  existing: Checkpoint | null,
  modifiedSince: string | null,
  checkpointPath: string,
  explicit = false,
): Promise<Checkpoint> {
  if (existing?.listingComplete) return existing;
  explicit = explicit || !!existing?.explicit;
  const ids: Array<{ id: number; email: string }> = existing?.ids ?? [];
  const doneIds = existing?.doneIds ?? [];
  // #9762: retomada preserva o início ORIGINAL da enumeração (é ele que cobre
  // os contatos já listados); run novo marca agora.
  const listingStartedAt = existing ? existing.listingStartedAt : new Date().toISOString();
  let offset = ids.length;
  for (;;) {
    const { body } = await brevoGetWithNetworkRetry(apiKey, contactsListPath(offset, modifiedSince));
    const cs = body?.contacts ?? [];
    for (const c of cs)
      ids.push({ id: c.id, email: String(c.email ?? "").toLowerCase() });
    const complete = cs.length < 500;
    // checkpoint POR PÁGINA → se o listing cair no meio (rate-limit), re-rodar
    // retoma de offset=ids.length em vez de re-enumerar do zero.
    saveCheckpoint({ listingComplete: complete, ids, doneIds, modifiedSince, listingStartedAt, explicit }, checkpointPath);
    console.error(`📇 listando contatos${modifiedSince ? " (incremental)" : ""}… ${ids.length}`);
    if (complete) break;
    offset += 500;
    await sleep(PAGE_PACING_MS);
  }
  return { listingComplete: true, ids, doneIds, modifiedSince, listingStartedAt, explicit };
}


export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  loadProjectEnv();
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("❌ BREVO_CLARICE_API_KEY ausente no env.");
    process.exit(1);
  }

  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  // getIntArg (#4497/#4573) — ausente vira o default 4; typo no VALOR (ex:
  // "--concurrency abc") ou "--concurrency 0" agora LANÇAM em vez de colapsar
  // silenciosamente (antes: Number(getArg(...)) || 4 não distinguia "flag
  // ausente" de "valor inválido/vazio", e concorrência 0 travaria o pool()).
  const concurrency = getIntArg(argv, "concurrency", { min: 1 }) ?? 4;
  // getIntArg (#4497) — ausente vira 0 ("sem limite", comportamento normal do
  // sync agendado); um typo no VALOR (ex: "--limit abc") agora LANÇA em vez
  // de colapsar no mesmo 0 silenciosamente (antes: Number(getArg(...)) || 0
  // não distinguia "flag ausente" de "valor inválido" — mesma classe do
  // incidente #4476/#4496).
  const limitArg = getIntArg(argv, "limit") ?? 0;
  // #4688: catch-up de opens via export de campanha, ligado por padrão em modo
  // incremental (ver bloco "Opens catch-up" acima); --no-catch-opens desliga.
  const catchOpensEnabled = !hasFlag(argv, "no-catch-opens");
  const opensWindowDays =
    getIntArg(argv, "opens-window-days") ?? DEFAULT_OPENS_CATCHUP_WINDOW_DAYS;
  // #5946: teto de campanhas JÁ CACHEADAS forçadas a re-exportar por run —
  // ver docstring de DEFAULT_OPENS_CATCHUP_MAX_REFRESH_PER_RUN.
  // `--opens-max-refresh 0` desliga o fatiamento (comportamento pré-#5946).
  const opensMaxRefreshPerRun =
    getIntArg(argv, "opens-max-refresh", { min: 0 }) ?? DEFAULT_OPENS_CATCHUP_MAX_REFRESH_PER_RUN;
  // #4717 follow-up (achado 1): SEMPRE passado explicitamente pro
  // runOpensCatchup abaixo — nunca deixar o default implícito de dentro de
  // runOpensCatchup decidir. `--cache-dir` existe só pra teste isolar o
  // diretório (mkdtempSync); em produção cai no subdiretório próprio do
  // catch-up (achado 5), nunca no CAMPAIGN_CACHE_DIR real compartilhado.
  const opensCatchupCacheDir = getArg(argv, "cache-dir") || OPENS_CATCHUP_CACHE_DIR;
  const { checkpoint: CHECKPOINT, checkpointInc: CHECKPOINT_INC, watermark: WATERMARK } =
    checkpointPathsForDb(dbPath);

  const db = openClariceDb(dbPath);
  const upsertBrevo = makeBrevoUpsert(db);

  // #2928: modo incremental — --modified-since <ISO> explícito, ou --incremental
  // deriva de MAX(brevo_modified_at) − 5min (buffer contra perder a fronteira).
  const explicitSince = getArg(argv, "modified-since");
  let modifiedSince: string | null = explicitSince || null;
  if (!modifiedSince && hasFlag(argv, "incremental")) {
    // RESUME: reusa o cutoff do checkpoint incremental pendente; senão deriva de
    // MAX − buffer. anchorForIncremental encapsula (não re-derivar num resume —
    // review #2929, o MAX avança com o flush e pularia contatos pendentes).
    const incCp = loadCheckpoint(CHECKPOINT_INC);
    const row = db
      .prepare("SELECT MAX(brevo_modified_at) AS m FROM clarice_users")
      .get() as { m: string | null };
    const watermark = loadWatermark(WATERMARK);
    modifiedSince = anchorForIncremental(incCp?.modifiedSince, row?.m, undefined, watermark);
    if (incCp?.modifiedSince) {
      console.error(`⏩ incremental: retomando modifiedSince=${modifiedSince} (do checkpoint)`);
    } else if (watermark && modifiedSince) {
      console.error(
        `⏩ incremental: modifiedSince=${modifiedSince} (marca d'água: listagem do último run concluído − 5min)`,
      );
    } else if (modifiedSince) {
      console.error(`⏩ incremental: modifiedSince=${modifiedSince} (MAX(brevo_modified_at) − 5min)`);
    } else {
      console.error("⚠️  --incremental mas store sem brevo_modified_at — caindo pra sync FULL.");
    }
  }
  const checkpointPath = modifiedSince ? CHECKPOINT_INC : CHECKPOINT;

  // Fase 1 — enumerar ids (resumível). Checkpoint de outra data/modo → descarta.
  let loaded = loadCheckpoint(checkpointPath);
  if (loaded && (loaded.modifiedSince ?? null) !== modifiedSince) {
    console.error("ℹ️  checkpoint de outra data/modo — recomeçando enumeração.");
    loaded = null;
  }
  let cp = await enumerateContacts(apiKey, loaded, modifiedSince, checkpointPath, !!explicitSince);
  const explicitRun = !!explicitSince || !!cp.explicit;
  const done = new Set<number>(cp.doneIds);
  let pending = cp.ids.filter((c) => c.id && c.email && !done.has(c.id));
  if (limitArg > 0) pending = pending.slice(0, limitArg);
  console.error(
    `🔎 ${cp.ids.length} contatos · ${done.size} já feitos · ${pending.length} a processar`,
  );

  // Fase 2 — per-id GET + parse + upsert, em batches transacionais duráveis.
  let buffer: Array<{ id: number; cols: ReturnType<typeof parseBrevoContact> }> =
    [];
  let processed = 0;

  // #6035: BEGIN/COMMIT roda com retry-com-backoff quando falha por
  // contenção SQLite ("database is locked"/SQLITE_BUSY) — o busy_timeout do
  // driver (`resolveBusyTimeoutMs`) já cobre colisões curtas, mas uma
  // transação concorrente que segura o lock além disso (achado ao vivo:
  // `diaria-clarice-sync.service` colidindo com `diaria-clarice-novos.timer`
  // 2min antes da falha) esgotava o busy_timeout e caía direto no catch
  // externo, abortando o run inteiro por uma colisão passageira. Retry
  // FINITO (`retryOnSqliteBusy`, delays default 1s/3s/6s) — nunca infinito,
  // decisão documentada no PR: um lock genuinamente preso não deve travar o
  // processo pra sempre, e o systemd timer já reroda no dia seguinte.
  //
  // #8091: esse retry finito pode levar até ~10s pra desistir — durante
  // contenção SUSTENTADA de lock (o cenário que motivou o #6035), mais de uma
  // lane do pool() abaixo pode estar no meio desse retry ao mesmo tempo. O
  // pool() abaixo é `poolAbortOnError` (não o `pool()` simples) por isso: ao
  // primeiro flush() que esgota os retries e lança, as demais lanes param de
  // puxar itens novos em vez de continuar martelando Brevo/SQLite num run já
  // fadado a abortar. (Investigado e descartado: o `pool()` simples NÃO
  // produz "unhandled rejection" aqui — `Promise.all` se inscreve em todas as
  // lanes de forma síncrona antes de qualquer uma rejeitar, então nenhuma
  // rejeição fica sem handler; ver docstring de `poolAbortOnError` em
  // `lib/pool.ts`. O ganho real do abort é evitar trabalho desperdiçado
  // contra uma API/DB já em contenção, não evitar crash.)
  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    await retryOnSqliteBusy(
      () => {
        db.exec("BEGIN");
        try {
          for (const b of batch) upsertBrevo(b.cols);
          db.exec("COMMIT");
        } catch (e) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // BEGIN pode ter sido o que falhou (lock na abertura da transação) —
            // nesse caso não há transação ativa pra desfazer; ignorar.
          }
          // batch NÃO entra em done → re-run re-busca (idempotente). Não re-bufferiza
          // pra não arriscar loop no mesmo erro persistente.
          throw e;
        }
      },
      {
        onRetry: ({ error, attemptIndex, delayMs }) =>
          console.error(
            `⚠️  flush colidiu com lock (${error.message}) — retry ${attemptIndex + 1} em ${delayMs}ms`,
          ),
      },
    );
    // done/checkpoint só APÓS o COMMIT durável (senão um COMMIT que falha deixaria
    // ids "feitos" sem linha no DB).
    for (const b of batch) done.add(b.id);
    cp.doneIds = [...done];
    saveCheckpoint(cp, checkpointPath);
  };

  try {
    await poolAbortOnError(pending, concurrency, async (c) => {
      const { body } = await brevoGetWithNetworkRetry(apiKey, `/contacts/${c.id}`);
      // 404 (sumiu entre listar e buscar) → body {} → parse vira tudo-zero; marca
      // como done mesmo assim pra não re-tentar em loop.
      buffer.push({ id: c.id, cols: parseBrevoContact(body) });
      processed++;
      if (buffer.length >= BATCH) await flush();
      if (processed % BATCH === 0)
        console.error(`  …${processed}/${pending.length}`);
    });
    await flush();
  } catch (e) {
    // persiste o que já veio antes de abortar; um flush que TAMBÉM falhe não pode
    // escapar daqui (senão db.close()/exitCode 2 + return não rodam → uncaught
    // exception derruba com exit 1 e stack, mascarando o exit code do erro real).
    try {
      await flush();
    } catch (flushErr) {
      console.error(`⚠️  flush final falhou: ${(flushErr as Error).message}`);
    }
    console.error(
      `⚠️  sync interrompido (${(e as Error).message}). ${done.size}/${cp.ids.length} ` +
        `salvos no DB + checkpoint. Re-rode pra continuar de onde parou.`,
    );
    db.close();
    // Windows fix (#4689, mesma classe do #4651/#4638/#1401): este catch só é
    // alcançado depois de pelo menos um `await brevoGet(...)` (pool acima) —
    // process.exit() aqui derrubaria o processo via libuv (UV_HANDLE_CLOSING)
    // antes do flush dos streams, no MESMO caminho de erro que mais precisa
    // do log. process.exitCode + return deixa o event loop drenar sozinho.
    process.exitCode = 2;
    return;
  }

  // #4688: catch-up de opens via export de campanha — só faz sentido em modo
  // incremental (full já pega stats exatos de todo mundo via GET /contacts/{id}).
  // FAIL-SOFT: uma falha aqui não derruba o sync principal, que já persistiu.
  let opensCatchup: OpensCatchupOutcome | null = null;
  if (modifiedSince && catchOpensEnabled) {
    console.error(
      `🔄 catch-up de opens (janela ${opensWindowDays}d, até ${opensMaxRefreshPerRun || "∞"} ` +
        `re-export(s)/run) — campanhas enviadas recentemente…`,
    );
    try {
      const campaignClient = makeRealCampaignExportClient(apiKey);
      const result = await runOpensCatchup({
        client: campaignClient,
        fetchContact: async (identifier) => {
          const { body } = await brevoGetWithNetworkRetry(apiKey, `/contacts/${encodeURIComponent(identifier)}`);
          return body;
        },
        upsert: upsertBrevo,
        windowDays: opensWindowDays,
        concurrency, // #4688 self-review: reusa o mesmo --concurrency do loop principal (era hardcoded default 4)
        cacheDir: opensCatchupCacheDir, // #4717 follow-up (achado 1 + 5): nunca o default implícito
        maxRefreshPerRun: opensMaxRefreshPerRun, // #5946: fatia o re-export por run pra caber no rate limit
        limit: limitArg > 0 ? limitArg : undefined, // #4722 item 2: --limit agora também cobre o catch-up
        transaction: (fn) => {
          // #4722 item 3: mesmo padrão BEGIN/COMMIT/ROLLBACK do flush() do
          // loop principal acima — batches do catch-up ganham a mesma
          // durabilidade/atomicidade.
          db.exec("BEGIN");
          try {
            fn();
            db.exec("COMMIT");
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
        },
      });
      console.error(
        `✅ catch-up: ${result.campaignsInWindow}/${result.campaignsConsidered} campanhas na janela ` +
          `(${result.campaignsFailed} falharam — ${result.campaignsPending} pendente(s) pro próximo run, ` +
          `${result.campaignsStaleFallback} com cache antigo${result.rateLimited ? ", 429: exports novos suspensos" : ""}; ` +
          `${result.campaignsPendingOutsideWindow} pendente(s) fora da janela; ` +
          `${result.campaignsSkippedRefresh} do cache sem re-export) · ` +
          `${result.suppressedFound} com bounce/descadastro · ` +
          `${result.openersFound} openers · ` +
          `${result.deliveredFound} entregues · ` +
          `${result.deliveredBackfilled} envios backfilled · ` +
          `${result.contactsUpdated} contatos atualizados (${result.contactsFailed} falharam)`,
      );
      opensCatchup = { ok: true, result };
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`⚠️  catch-up de opens falhou (não afeta o sync principal, já persistido): ${msg}`);
      opensCatchup = { ok: false, error: msg };
    }
  }

  // Concluído: recompute global + limpa checkpoint.
  console.error(`⚙️  recomputando derivados (send_eligible + priority_points)…`);
  const derived = recomputeDerived(db);
  if (existsSync(checkpointPath)) unlinkSync(checkpointPath);

  // #9762: marca d'água = início da listagem deste run (não o MAX do que foi
  // buscado depois). Gravada só DEPOIS do recompute + limpeza do checkpoint
  // (um run que morre antes não pode avançá-la) e só quando o run cobriu o
  // intervalo inteiro desde a âncora derivada: nunca com `--limit` (processa
  // uma fatia) nem com `--modified-since` explícito (a âncora pode ser mais
  // recente que a marca atual — avançar pularia o intervalo entre as duas),
  // nem com checkpoint legado sem `listingStartedAt`. Falhar aqui não derruba
  // o run: o próximo cai na marca anterior (ou no MAX), só re-busca mais.
  if (cp.listingStartedAt && limitArg <= 0 && !explicitRun) {
    try {
      saveWatermark(WATERMARK, cp.listingStartedAt);
    } catch (e) {
      console.error(`⚠️  marca d'água não gravada (${(e as Error).message}) — o próximo incremental re-busca mais.`);
    }
  } else if (explicitRun) {
    console.error("ℹ️  --modified-since explícito: marca d'água do incremental não avançada.");
  }

  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM clarice_users").get() as { n: number }
  ).n;
  const suppressed = (
    db
      .prepare("SELECT COUNT(*) AS n FROM clarice_users WHERE send_eligible = 0")
      .get() as { n: number }
  ).n;
  db.close();

  console.log(
    JSON.stringify(
      {
        db: dbPath,
        mode: modifiedSince ? "incremental" : "full",
        modified_since: modifiedSince,
        contacts_listed: cp.ids.length,
        contacts_synced: processed,
        users_total: total,
        suppressed,
        derived_recomputed: derived,
        brevo_synced: true,
        opens_catchup: opensCatchup,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[clarice-sync-brevo] erro fatal: ${(e as Error).message}\n`);
    // Windows fix (#4651, mesma classe do #4638/#1401/#4689): main() pode
    // lançar fora do try/catch interno (ex: enumerateContacts na Fase 1,
    // antes do try; ou recomputeDerived/db.close() pós-sucesso) — depois de
    // já ter feito await fetch, então process.exit() aqui arriscaria o mesmo
    // crash libuv que o #4689 corrigiu no catch pós-await.
    process.exitCode = 1;
  });
}
