#!/usr/bin/env node
/**
 * scripts/dump-worker-logs.ts (#6318 — Passo 1)
 *
 * Congela em disco a janela retida dos Cloudflare Workers Logs dos workers
 * de cadastro (`poll`, `cursos`, `reativar`), ANTES que ela expire.
 *
 * ## Por que existe
 *
 * Com o switchover pro Kit (#6048/#6114), todo cadastro novo passou a entrar
 * sem atribuição: os `KIT_UTM_*_FIELD` nunca foram ligados, e a atribuição
 * NATIVA do Kit é inalcançável por quem cria subscriber via API. Nada no
 * nosso lado persiste o UTM — nem KV, nem D1, nem Analytics Engine, nem o
 * payload da Meta CAPI (medido no #6318).
 *
 * A ÚNICA fonte que ainda tem esse dado são os Workers Logs, que registram a
 * URL completa do request com query string:
 *
 *     GET https://eia.diar.ia.br/jogar?utm_source=facebook&utm_medium=organic_social&...
 *
 * Isso é mais rico que o dado que o código teria gravado (o triplo derivado
 * da superfície, `SUBSCRIBE_UTM_BY_SOURCE`): é o UTM real da visita.
 *
 * **A retenção varia por worker e NÃO foi medida até o limite.** Na captura
 * de 26/08 com `--days 7`: `poll` reteve desde 23/08 (3 dias), `cursos`
 * desde 19/08 — ou seja, a janela inteira que foi pedida, sem atingir a
 * fronteira real. Não generalizar um número de retenção a partir disso; o
 * que vale é a disciplina de capturar cedo.
 *
 * Este script não interpreta nada — só baixa os eventos crus em JSONL pra
 * `data/worker-logs-snapshot/{data}/{worker}.jsonl`,
 * pra que a reconstrução (#6318 Passo 4) possa acontecer com calma depois
 * que a janela já tiver fechado. Separar captura de interpretação é
 * deliberado: interpretação errada se refaz, dado expirado não volta.
 *
 * ## Cobertura, e o buraco conhecido
 *
 * `poll` (`[observability] enabled=true, head_sampling_rate=1`) e `cursos`
 * (`enabled=true`) logam. **`reativar` não tem bloco `[observability]`
 * nenhum** — dele não há o que baixar (corrigido no mesmo PR, mas não
 * retroage). O script reporta explicitamente quando um worker devolve zero
 * eventos, em vez de deixar o silêncio parecer sucesso.
 *
 * ## Ruído de imagem
 *
 * O `poll` também serve as imagens das edições (`/img/...`), que dominam o
 * volume e não carregam atribuição nenhuma. `--include-assets` mantém tudo;
 * o default descarta esses requests DEPOIS de baixá-los (o filtro é
 * client-side de propósito — o servidor não oferece "not includes", e um
 * filtro server-side errado descartaria dado que não dá pra rebaixar).
 *
 * Uso:
 *   npx tsx scripts/dump-worker-logs.ts --dry-run
 *   npx tsx scripts/dump-worker-logs.ts
 *   npx tsx scripts/dump-worker-logs.ts --days 7 --include-assets
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, parseArgs as parseCliArgs } from "./lib/cli-args.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Workers de cadastro. `reativar` entra mesmo sem observability hoje — se
 *  vier vazio, isso é reportado como buraco, não como sucesso silencioso. */
export const SIGNUP_WORKERS = ["poll", "cursos", "reativar"] as const;
export type SignupWorker = (typeof SIGNUP_WORKERS)[number];

const OBSERVABILITY_QUERY_PATH = "/workers/observability/telemetry/query";
/** Teto por página aceito pela API; a paginação abaixo estreita a janela. */
const PAGE_LIMIT = 1000;
/** Trava contra loop infinito se a API parar de estreitar a janela. */
const MAX_PAGES = 60;

export interface RawLogEvent {
  timestamp?: number;
  source?: { message?: string };
  [k: string]: unknown;
}

/** Pura — a mensagem do evento é `"{METHOD} {url}"`; devolve a URL ou null. */
export function extractUrl(event: RawLogEvent): string | null {
  const msg = event?.source?.message;
  if (typeof msg !== "string") return null;
  const m = msg.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
}

/**
 * Pura — request de asset estático (imagem/favicon) do worker `poll`, que
 * nunca carrega atribuição. Separada e exportada pra ser testável sem rede.
 */
export function isAssetRequest(event: RawLogEvent): boolean {
  const url = extractUrl(event);
  if (!url) return false;
  return /\/img\//.test(url) || /\/favicon\.ico/.test(url);
}

/** Pura — nome do diretório do snapshot a partir de um instante. */
export function snapshotDirName(now: Date): string {
  return now.toISOString().slice(0, 10);
}

interface QueryDeps {
  accountId: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * Erro de FORMA da resposta (200 com envelope irreconhecível) — distinto de
 * "zero eventos". Sem isso, uma mudança de contrato da Cloudflare viraria
 * `[]`, indistinguível de "este worker não teve tráfego", e o operador leria
 * "sem observability" quando na verdade a leitura quebrou.
 */
export class ObservabilityShapeError extends Error {
  constructor(service: string, recebido: string) {
    super(`resposta da observability para "${service}" em formato desconhecido: ${recebido}`);
    this.name = "ObservabilityShapeError";
  }
}

/** Pura — extrai os eventos do envelope, ou lança se a forma for desconhecida. */
export function extractEvents(body: unknown, service: string): RawLogEvent[] {
  const result = (body as { result?: unknown })?.result;
  if (result === undefined || result === null) {
    throw new ObservabilityShapeError(service, JSON.stringify(body ?? null).slice(0, 200));
  }
  const events = (result as { events?: unknown }).events;
  if (Array.isArray(events)) return events as RawLogEvent[];
  const aninhado = (events as { events?: unknown } | undefined)?.events;
  if (Array.isArray(aninhado)) return aninhado as RawLogEvent[];
  throw new ObservabilityShapeError(service, JSON.stringify(result).slice(0, 200));
}

async function queryPage(
  deps: QueryDeps,
  service: string,
  from: number,
  to: number,
): Promise<RawLogEvent[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(
    `https://api.cloudflare.com/client/v4/accounts/${deps.accountId}${OBSERVABILITY_QUERY_PATH}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        queryId: `dump-${service}`,
        timeframe: { from, to },
        datasets: ["cloudflare-workers"],
        limit: PAGE_LIMIT,
        view: "events",
        parameters: {
          filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: service }],
        },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Cloudflare observability ${service} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return extractEvents(await res.json(), service);
}

/**
 * Baixa TODA a janela retida de um worker, estreitando o `to` a cada página
 * (a API devolve do mais recente pro mais antigo). Para quando uma página
 * vem incompleta ou quando o instante mais antigo para de recuar — este
 * segundo caso é a trava contra loop quando há empate de timestamp.
 */
export async function fetchAllEvents(
  deps: QueryDeps,
  service: string,
  from: number,
  to: number,
): Promise<{ events: RawLogEvent[]; truncado: boolean }> {
  const all: RawLogEvent[] = [];
  let cursor = to;
  let truncado = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await queryPage(deps, service, from, cursor);
    if (batch.length === 0) break;
    all.push(...batch);
    const oldest = Math.min(...batch.map((e) => (typeof e.timestamp === "number" ? e.timestamp : Infinity)));
    if (!Number.isFinite(oldest) || oldest <= from || oldest >= cursor) break;
    cursor = oldest - 1;
    if (batch.length < PAGE_LIMIT) break;
    // Ainda havia página cheia e progresso possível, mas o cap acabou: o
    // resultado é PARCIAL. Devolver isso em silêncio seria a mesma classe de
    // bug que esta captura existe pra remediar — e pior, porque a janela
    // expira e ninguém descobre depois. Ver achado P1 do review da PR #6324.
    if (page === MAX_PAGES - 1) truncado = true;
  }
  return { events: all, truncado };
}

export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const includeAssets = hasFlag(argv, "include-assets");
  const days = Number(parseCliArgs(argv).values.days ?? 7);
  const log = (m: string) => process.stderr.write(`[dump-worker-logs] ${m}\n`);

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    log("ERRO: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN ausentes no ambiente.");
    process.exitCode = 2;
    return;
  }

  const now = Date.now();
  const from = now - days * 24 * 60 * 60 * 1000;
  const outDir = resolve(rootDir, "data", "worker-logs-snapshot", snapshotDirName(new Date(now)));
  const vazios: string[] = [];
  const anomalias: string[] = [];

  for (const service of SIGNUP_WORKERS) {
    const { events, truncado } = await fetchAllEvents({ accountId, token }, service, from, now);
    if (truncado) {
      anomalias.push(`${service}: paginacao truncada em MAX_PAGES=${MAX_PAGES}`);
      log(`${service}: ATENCAO — paginacao truncada em ${MAX_PAGES} paginas. HA eventos mais antigos NAO capturados. Reduza --days e rode de novo.`);
    }
    const kept = includeAssets ? events : events.filter((e) => !isAssetRequest(e));
    const timestamps = kept.map((e) => e.timestamp).filter((t): t is number => typeof t === "number");

    if (events.length === 0) {
      vazios.push(service);
      // `reativar` sem `[observability]` era o buraco conhecido do #6318 e foi
      // fechado no mesmo PR. Zero eventos em QUALQUER worker agora e' anomalia,
      // nao estado esperado — precisa de exit code, nao so de texto no stderr.
      anomalias.push(`${service}: zero eventos`);
      log(`${service}: ZERO eventos retidos — observability desligada, fora da retencao, ou leitura quebrada. Nada a congelar.`);
      continue;
    }
    const janela =
      timestamps.length > 0
        ? `${new Date(Math.min(...timestamps)).toISOString()} -> ${new Date(Math.max(...timestamps)).toISOString()}`
        : "(sem timestamps)";
    log(`${service}: ${events.length} eventos crus, ${kept.length} apos filtro de asset. Janela: ${janela}`);

    if (!dryRun) {
      mkdirSync(outDir, { recursive: true });
      const path = resolve(outDir, `${service}.jsonl`);
      writeFileSync(path, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length > 0 ? "\n" : ""));
      log(`${service}: gravado em ${path}`);
    }
  }

  if (dryRun) log("[dry-run] nada gravado.");
  if (vazios.length > 0) {
    log(`ATENCAO: sem dado nenhum para: ${vazios.join(", ")}. Esses funis nao tem como ser reconstruidos.`);
  }
  // Exit code, nao so stderr: esta captura corre contra uma janela que expira,
  // entao um wrapper/cron precisa conseguir DETECTAR captura incompleta sem
  // depender de um humano lendo o log na hora certa.
  if (anomalias.length > 0) {
    log(`CAPTURA INCOMPLETA (${anomalias.length}): ${anomalias.join("; ")}`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[dump-worker-logs] erro fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  });
}
