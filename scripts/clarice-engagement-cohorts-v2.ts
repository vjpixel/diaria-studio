/**
 * clarice-engagement-cohorts-v2.ts (#4451 Fase 1)
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
 * ESCOPO DESTE ARQUIVO — só a Fase 1 do plano de execução da issue:
 *   1. Backfill completo por campanha + cache local permanente. ← AQUI
 *   2. Comparar output de computeCohorts() do v2 contra o v1 (empírico).
 *   3. Trocar a task agendada `DiariaCohortsCrawl` pro script novo.
 *   4. Aposentar v1 (mantido como fallback documentado por um tempo).
 * Fases 2-4 são follow-up (recomendado via `/diaria-develop`, supervisionado
 * — precisam de validação empírica que este script sozinho não produz).
 *
 * `computeCohorts()` (de clarice-engagement-cohorts.ts) NÃO MUDA — só a
 * ORIGEM do `ContactEngagement` por e-mail muda (per-campanha em vez de
 * per-contato). v1 não é tocado por este arquivo.
 *
 * SEMPRE DRY-RUN NESTA FASE: este script NUNCA escreve no KV do worker
 * `clarice-dashboard` nem troca a task agendada `DiariaCohortsCrawl` — só
 * produz output local (stdout + opcionalmente `--out arquivo.json`) pro
 * editor inspecionar. Cutover real é Fase 3, fora deste arquivo.
 *
 * CACHE "SKIP FOREVER" (mesma semântica de `scripts/verify-emails-mv.ts`):
 * campanha já cacheada em `data/clarice-subscribers/cohorts/campaign-cache/
 * {campaignId}.json` NUNCA é re-exportada nesta fase — campanha enviada é
 * imutável em CONTEÚDO, mesmo que o engajamento (abertura/clique) ainda
 * acumule por um tempo depois do envio.
 *
 * TODO (#4451 Fase 2 — NÃO implementado aqui, precisa validação empírica
 * antes de escrever código): janela de re-fetch de N dias (chute inicial: 30)
 * pra campanhas recentes, capturando engajamento tardio sem re-exportar a
 * história inteira. Até lá, o cache é 100% permanente — inclusive campanhas
 * enviadas ontem. Validar comparando `uniqueViews` do mesmo `campaignId` em
 * snapshots de idades diferentes antes de implementar.
 *
 * GAP CONHECIDO (documentado, não resolvido nesta fase): blacklist
 * administrativo sem evento de `Unsubscribe_Date` em NENHUMA campanha
 * específica não aparece em nenhum export — só o crawl per-contato (v1, via
 * `emailBlacklisted`) capturava esse sinal. Ver tabela de mapeamento de
 * campos na issue #4451. Fase 2/3 precisa de uma chamada complementar
 * (paginar contatos com filtro de blacklist, ou reusar o que
 * `clarice-sync-brevo.ts` já traz do store) antes do cutover.
 *
 * THROTTLING: a Brevo não documenta rate limit específico pra
 * `exportRecipients`/`processes` (diferente de `/v3/contacts/*`, 10 req/s
 * documentado). Concorrência default BAIXA (2) — nunca dispara exports de
 * várias campanhas em paralelo sem limite.
 *
 * Env:
 *   BREVO_CLARICE_API_KEY  obrigatório
 *
 * Uso CLI (sempre dry-run, nunca grava KV nem toca a task agendada):
 *   npx tsx scripts/clarice-engagement-cohorts-v2.ts [--concurrency N] [--limit N] [--out arquivo.json]
 *
 *   --concurrency  campanhas processadas em paralelo (default 2 — throttling conservador).
 *   --limit        processa só as N campanhas mais recentes (útil pra validar sem rodar a história inteira).
 *   --out          além do stdout, grava o JSON de coortes neste path.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { brevoGet, brevoPost } from "./lib/brevo-client.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import {
  computeCohorts,
  COHORTS_STATE_DIR,
  type ContactEngagement,
  type EngagementCohorts,
} from "./clarice-engagement-cohorts.ts";

loadProjectEnv();

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
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Download do CSV de export falhou (${res.status}): ${url}`);
      }
      return await res.text();
    },
  };
}

// ─── Poll até completar ───────────────────────────────────────────────────────

export interface PollOptions {
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxAttempts?: number;
}

/**
 * Poll `GET /processes/{id}` até `status` terminal. Testado ao vivo: a
 * campanha de 116 destinatários completou em ~4s — default de 2s/attempt,
 * 30 tentativas (~1min de teto), generoso o bastante pra campanhas maiores
 * (3-9k destinatários da rampa atual) sem pendurar o processo indefinidamente.
 */
export async function pollExportUntilDone(
  client: Pick<CampaignExportClient, "pollProcess">,
  processId: number | string,
  opts: PollOptions = {},
): Promise<string> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = opts.intervalMs ?? 2000;
  const maxAttempts = opts.maxAttempts ?? 30;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await client.pollProcess(processId);
    if (res.status === "completed" || res.status === "success") {
      if (!res.exportUrl) {
        throw new Error(`Processo ${processId} completou sem export_url.`);
      }
      return res.exportUrl;
    }
    if (res.status === "failed" || res.status === "error") {
      throw new Error(`Processo ${processId} falhou (status=${res.status}).`);
    }
    if (attempt < maxAttempts - 1) await sleep(intervalMs);
  }
  throw new Error(`Processo ${processId} não completou após ${maxAttempts} tentativas de poll.`);
}

// ─── Busca ou usa cache (skip-forever) ──────────────────────────────────────

export interface CampaignFetchResult {
  cache: CampaignCache;
  fromCache: boolean;
}

/**
 * Cache "skip forever" (#4451 Fase 1 — mesma semântica do MillionVerifier,
 * `scripts/verify-emails-mv.ts`): campanha já cacheada NUNCA dispara novo
 * `exportRecipients` nesta fase. TODO Fase 2: janela de re-fetch pra
 * campanhas recentes (ver comentário de topo do arquivo) — até lá, mesmo uma
 * campanha enviada ontem usa o cache assim que existir.
 */
export async function getOrFetchCampaignCache(
  client: CampaignExportClient,
  campaign: SentCampaignRef,
  opts: { cacheDir?: string; poll?: PollOptions; now?: () => string } = {},
): Promise<CampaignFetchResult> {
  const cacheDir = opts.cacheDir ?? CAMPAIGN_CACHE_DIR;
  const cached = loadCampaignCache(campaign.id, cacheDir);
  if (cached) return { cache: cached, fromCache: true };

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

// ─── Orquestração fim-a-fim ──────────────────────────────────────────────────

export interface BuildCohortsV2Result {
  cohorts: EngagementCohorts;
  campaignsTotal: number;
  campaignsFromCache: number;
  campaignsFetched: number;
  campaignsFailed: { campaignId: number; campaignName: string; error: string }[];
}

export async function buildCohortsV2(
  client: CampaignExportClient,
  generatedAt: string,
  opts: { concurrency?: number; limit?: number; cacheDir?: string; poll?: PollOptions } = {},
): Promise<BuildCohortsV2Result> {
  const concurrency = opts.concurrency ?? 2; // throttling conservador (#4451 — rate limit não documentado)
  let campaigns = await client.listSentCampaigns();
  if (opts.limit && opts.limit > 0) campaigns = campaigns.slice(0, opts.limit);

  const results = await mapWithConcurrency(campaigns, concurrency, (c) =>
    getOrFetchCampaignCache(client, c, { cacheDir: opts.cacheDir, poll: opts.poll }),
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

  const aggregate = aggregateCampaignCaches(caches);
  const cohorts = computeCohorts(Array.from(aggregate.values()), generatedAt);

  return {
    cohorts,
    campaignsTotal: campaigns.length,
    campaignsFromCache,
    campaignsFetched,
    campaignsFailed,
  };
}

// ─── CLI (SEMPRE dry-run — não grava KV, não toca a task agendada) ──────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const concurrency = Number(getArg(argv, "concurrency") || "2") || 2;
  const limitArg = getArg(argv, "limit");
  const limit = limitArg ? Number(limitArg) : undefined;
  const outPath = getArg(argv, "out");

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida (veja .env.example).");
    process.exit(1);
  }

  console.error(
    `🚧 v2 (Fase 1, #4451) — SEMPRE dry-run: não grava KV, não altera a task agendada DiariaCohortsCrawl.`,
  );
  console.error(
    `🔎 Backfill por campanha (concorrência ${concurrency}${limit ? `, limit ${limit}` : ""})…`,
  );

  const generatedAt = new Date().toISOString();
  const client = makeRealCampaignExportClient(apiKey);

  const result = await buildCohortsV2(client, generatedAt, { concurrency, limit });

  console.error(
    `\n✅ v2 (dry-run): universo ${result.cohorts.universe} — campanhas: ${result.campaignsTotal} ` +
      `(cache: ${result.campaignsFromCache}, novas: ${result.campaignsFetched}, falhas: ${result.campaignsFailed.length}).`,
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
    writeFileAtomic(resolve(outPath), output, { fsync: false });
    console.error(`📝 Output também salvo em ${outPath} (nada gravado no KV).`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
