/**
 * scripts/ai-fetch-report.ts (#4902 item 3)
 *
 * Lê os contadores de FETCH por bot de recuperação (OAI-SearchBot,
 * ChatGPT-User, Claude-User, Claude-SearchBot, PerplexityBot,
 * Perplexity-User, Googlebot, bingbot) + de hit de Referer de assistente
 * (chatgpt.com, perplexity.ai, claude.ai, gemini.google.com) do KV
 * `CURSOS_SUBSCRIBERS` — mesmo namespace de `workers/cursos`, prefixo
 * `counter:ai-fetch:` (ver `scripts/lib/shared/ai-fetch-counters.ts`, que
 * o Worker `arquivo` incrementa a cada request casada).
 *
 * Leitura via `getTextFromWorkerKV` (`scripts/lib/cloudflare-kv-upload.ts`,
 * HTTP fetch injetável) — exatamente como `scripts/cursos-error-alarm.ts`
 * já faz pro par irmão de contadores. Nunca usa o binding KV nativo do
 * runtime Workers (isto roda em Node, fora do Worker).
 *
 * **Sem endpoint de LIST**: a Cloudflare KV REST API tem um endpoint de
 * listagem por prefixo, mas `cloudflare-kv-upload.ts` não o expõe hoje (só
 * get/put/delete de 1 chave). Como o conjunto de bots/hosts é FIXO e
 * pequeno (8 + 4 = 12), este script simplesmente monta as 12 chaves de cada
 * dia pedido e faz 1 GET por chave — mais simples que adicionar um novo
 * método de LIST pra um caso de uso só, e o volume de chamadas (12 × dias
 * pedidos) fica bem dentro de qualquer limite de rate da API.
 *
 * Saída: 1 registro por dia consultado, anexado (append-only, JSONL) em
 * `data/ai-fetch/history.jsonl` — mesmo molde de
 * `DEFAULT_GEO_CITATIONS_LOG_PATH` (`scripts/lib/geo-citation-monitor.ts`).
 *
 * Uso:
 *   npx tsx scripts/ai-fetch-report.ts [--date YYYY-MM-DD] [--days N]
 *     [--out data/ai-fetch/history.jsonl] [--dry-run]
 *
 *   --date     dia mais recente a consultar (default: hoje, UTC).
 *   --days     quantos dias consultar, terminando em --date e indo pra
 *              trás (default: 1 — só o dia pedido).
 *   --out      path do JSONL de saída.
 *   --dry-run  não escreve o arquivo — só imprime o resultado no console.
 *
 * Env (obrigatórios, exceto em --dry-run com credencial ausente — nesse
 * caso o script aborta com erro explícito, igual a cursos-error-alarm.ts):
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_WORKERS_TOKEN, CURSOS_KV_NAMESPACE_ID
 *   (mesmas 3 vars já usadas por scripts/cursos-error-alarm.ts — mesmo
 *   namespace KV, prefixo distinto de chave).
 *
 * **Não executado ao vivo nesta sessão** (#4902) — worktree isolado sem as
 * credenciais Cloudflare reais, mesma disciplina dos #4320/#4382/#4490/#4534.
 * Rodar 1× com credenciais reais (`curl -A "OAI-SearchBot/1.0"
 * https://arquivo.diar.ia.br/temas/anthropic-claude` seguido deste script)
 * é ação pendente do editor — ver item 4 do corpo da issue (2-3 semanas de
 * dado antes de qualquer leitura).
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { getTextFromWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { appendFileWithRetry } from "./lib/source-runs.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  AI_FETCH_BOTS,
  aiFetchBotCounterKey,
  aiFetchReferrerCounterKey,
  type AiFetchBot,
} from "./lib/shared/ai-fetch-counters.ts";
import { AI_REFERRER_HOSTS, type AiReferrerHost } from "./lib/shared/ai-referrer-log.ts";

loadProjectEnv();

/** Path default do JSONL de saída — mesmo molde de
 * `DEFAULT_GEO_CITATIONS_LOG_PATH` (`scripts/lib/geo-citation-monitor.ts`). */
export const DEFAULT_AI_FETCH_LOG_PATH = "data/ai-fetch/history.jsonl";

/** Converte o valor cru lido do KV (string ou `null`, miss = "0") num
 * inteiro não-negativo. Nunca lança — corpo corrompido/negativo vira 0
 * (mesma filosofia fail-soft de `scripts/cursos-error-alarm.ts::parseCounterValue`). */
export function parseCounterValue(raw: string | null): number {
  if (raw === null) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** "AAAA-MM-DD" válido (mesma granularidade de `GeoCitationRecord.date`). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pure: hoje em UTC, formato `YYYY-MM-DD`. Extraída pra ser sobrescrita em
 * teste sem mockar `Date` globalmente. */
export function todayUtc(now: () => Date = () => new Date()): string {
  return now().toISOString().slice(0, 10);
}

/**
 * Pure: gera `days` datas `YYYY-MM-DD` terminando em `endDate` (inclusive),
 * mais recente primeiro — ex: `listDatesBack("2026-08-11", 3)` →
 * `["2026-08-11", "2026-08-10", "2026-08-09"]`. `days < 1` vira 1 (sempre
 * pelo menos o próprio `endDate`). Lança se `endDate` não bater `YYYY-MM-DD`.
 */
export function listDatesBack(endDate: string, days: number): string[] {
  if (!DATE_RE.test(endDate)) throw new Error(`listDatesBack: endDate inválida: "${endDate}" (esperado YYYY-MM-DD)`);
  const n = Math.max(1, Math.floor(days));
  const [y, m, d] = endDate.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

export interface AiFetchDailyRecord {
  /** `YYYY-MM-DD`. */
  date: string;
  /** ISO 8601 completo — timestamp da LEITURA (não da contagem em si; os
   * contadores no KV não carregam timestamp próprio, só o valor cumulativo
   * do dia). */
  ts: string;
  byBot: Record<AiFetchBot, number>;
  byReferrerHost: Record<AiReferrerHost, number>;
  totalBotHits: number;
  totalReferrerHits: number;
}

/**
 * Lê os 8 contadores de bot + 4 de Referer pra 1 `date`, via
 * `getTextFromWorkerKV` (fetch injetável — nunca rede real em teste). Nunca
 * lança por causa de UMA chave ausente (`getTextFromWorkerKV` já devolve
 * `null` em 404, `parseCounterValue` já trata isso como 0) — só propaga
 * falha de credencial/rede real (mesma política de
 * `cursos-error-alarm.ts::fetchCurrentCounters`, que deixa o CALLER decidir).
 */
export async function fetchAiFetchCountersForDate(
  date: string,
  namespaceId: string,
  cfg: { accountId?: string; token?: string } = {},
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<AiFetchDailyRecord> {
  const botEntries = await Promise.all(
    AI_FETCH_BOTS.map(async (bot) => {
      const raw = await getTextFromWorkerKV(aiFetchBotCounterKey(bot, date), { kvNamespaceId: namespaceId, ...cfg }, fetchImpl);
      return [bot, parseCounterValue(raw)] as const;
    }),
  );
  const referrerEntries = await Promise.all(
    AI_REFERRER_HOSTS.map(async (host) => {
      const raw = await getTextFromWorkerKV(aiFetchReferrerCounterKey(host, date), { kvNamespaceId: namespaceId, ...cfg }, fetchImpl);
      return [host, parseCounterValue(raw)] as const;
    }),
  );
  const byBot = Object.fromEntries(botEntries) as Record<AiFetchBot, number>;
  const byReferrerHost = Object.fromEntries(referrerEntries) as Record<AiReferrerHost, number>;
  return {
    date,
    ts: now().toISOString(),
    byBot,
    byReferrerHost,
    totalBotHits: botEntries.reduce((sum, [, n]) => sum + n, 0),
    totalReferrerHits: referrerEntries.reduce((sum, [, n]) => sum + n, 0),
  };
}

/** Anexa os registros ao log JSONL — mesmo padrão de
 * `appendGeoCitationLog` (`scripts/lib/geo-citation-monitor.ts`). Cria o
 * diretório se não existir. `ioFns` injetável em teste. */
export function appendAiFetchLog(
  records: AiFetchDailyRecord[],
  logPath: string = DEFAULT_AI_FETCH_LOG_PATH,
  ioFns: {
    mkdirSync: (path: string, opts: { recursive: true }) => void;
    appendFileSync: (path: string, data: string) => void;
  } = {
    mkdirSync: (p, o) => mkdirSync(p, o),
    appendFileSync: (p, d) => appendFileWithRetry(p, d),
  },
): void {
  if (records.length === 0) return;
  ioFns.mkdirSync(dirname(logPath), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r) + "\n").join("");
  ioFns.appendFileSync(logPath, lines);
}

async function main(): Promise<number> {
  const { values, flags } = parseCliArgs(process.argv.slice(2));
  const dryRun = flags.has("dry-run");
  const endDate = values["date"] ? String(values["date"]) : todayUtc();
  const days = values["days"] ? Number(values["days"]) : 1;
  const outPath = values["out"] ? String(values["out"]) : DEFAULT_AI_FETCH_LOG_PATH;

  if (!DATE_RE.test(endDate)) {
    console.error(`[ai-fetch-report] --date inválida: "${endDate}" (esperado YYYY-MM-DD).`);
    return 2;
  }
  if (!Number.isFinite(days) || days < 1) {
    console.error(`[ai-fetch-report] --days inválido: "${values["days"]}" (esperado inteiro >= 1).`);
    return 2;
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const workersToken = process.env.CLOUDFLARE_WORKERS_TOKEN ?? "";
  const namespaceId = process.env.CURSOS_KV_NAMESPACE_ID ?? "";
  if (!accountId || !workersToken || !namespaceId) {
    console.error(
      "[ai-fetch-report] CLOUDFLARE_ACCOUNT_ID e/ou CLOUDFLARE_WORKERS_TOKEN e/ou CURSOS_KV_NAMESPACE_ID não definidos.",
    );
    return 1;
  }

  const dates = listDatesBack(endDate, days);
  const records: AiFetchDailyRecord[] = [];
  for (const date of dates) {
    try {
      const record = await fetchAiFetchCountersForDate(date, namespaceId, { accountId, token: workersToken });
      records.push(record);
      console.log(
        `[ai-fetch-report] ${date}: ${record.totalBotHits} fetch(es) de bot nomeado, ${record.totalReferrerHits} hit(s) de Referer de assistente.`,
      );
      for (const [bot, n] of Object.entries(record.byBot)) {
        if (n > 0) console.log(`  - bot ${bot}: ${n}`);
      }
      for (const [host, n] of Object.entries(record.byReferrerHost)) {
        if (n > 0) console.log(`  - referrer ${host}: ${n}`);
      }
    } catch (e) {
      console.error(`[ai-fetch-report] erro ao ler contadores de ${date}: ${(e as Error).message}`);
      return 1;
    }
  }

  if (dryRun) {
    console.log(`[ai-fetch-report] --dry-run: ${records.length} registro(s) NÃO escrito(s) em ${outPath}.`);
    return 0;
  }

  appendAiFetchLog(records, outPath);
  console.log(`[ai-fetch-report] ${records.length} registro(s) anexado(s) em ${outPath}.`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error("[ai-fetch-report] erro:", e);
      process.exit(1);
    });
}

export { main };
