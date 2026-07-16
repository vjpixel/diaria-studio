/**
 * apoia-se.ts (#3500)
 *
 * Client pra API pública da apoia.se (crowdfunding — campanha ativa da
 * diar.ia.br). Superfície confirmada na doc oficial (v0.1,
 * https://apoiase.notion.site/APOIA-se-API-4b87651821884061a7532abfd7f26087):
 * um ÚNICO endpoint, consulta por e-mail conhecido (NÃO existe endpoint de
 * listagem de apoiadores):
 *
 *   GET https://api.apoia.se/backers/charges/<email>
 *     headers: x-api-key: <APOIA_SE_API_KEY>, authorization: Bearer <APOIA_SE_API_SECRET>
 *
 * Resposta 200: { isBacker, isPaidThisMonth, thisMonthPaidValue? } — e-mail
 * não encontrado retorna 200 com `{ isBacker:false, isPaidThisMonth:false }`
 * (sem `thisMonthPaidValue`). Chave errada → 401.
 *
 * **Guard de segredo:** as 3 credenciais (`APOIA_SE_API_KEY`,
 * `APOIA_SE_API_SECRET`, `APOIA_SE_CAMPAIGN`) são lidas SÓ de env var — nunca
 * hardcoded aqui, nunca logadas (nem em erro: mensagens citam só o NOME da
 * var ausente, nunca o valor).
 *
 * **Rate limit (5.000 req/mês, 5 req/s):** `RateLimiter` espaça o INÍCIO de
 * cada chamada em ≤5/s. O teto mensal é protegido pelo cache por mês abaixo —
 * ver #1297/verify-emails-mv.ts pro precedente do mesmo padrão nesta base
 * (throttle + cache + fixture-only tests).
 *
 * **Cache por mês-competência** (`data/apoia-se/{campaign}/{YYYY-MM}.json`,
 * dentro do blanket-gitignore de `data/`): a doc afirma que o status é
 * ESTÁVEL dentro do mês (uma vez pago, não muda até virar o mês) — então
 * `checkBacker` consulta o cache do mês corrente (BRT) antes de bater na
 * API; hit → devolve sem rede; miss → fetch + grava. **Semântica de
 * invalidação:** o cache é chaveado pelo mês de competência (BRT) — virar o
 * mês muda a chave do arquivo (`{YYYY-MM}.json` novo), então a próxima
 * consulta do mês novo é sempre um miss (re-consulta obrigatória; nunca
 * carrega o arquivo do mês anterior). Não há expiração dentro do mesmo mês —
 * intencional, dado o teto de 5k req/mês e a doc dizer que o status não muda
 * intra-mês.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.ts";
import { BRT_TIMEZONE, datePartsInTz } from "./next-edition-date.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..", "..");

const API_BASE = "https://api.apoia.se";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

export interface ApoiaSeEnv {
  apiKey: string;
  apiSecret: string;
  campaign: string;
}

/**
 * Lê as 3 env vars obrigatórias. Erro claro (nomes das vars ausentes, NUNCA
 * valores) se alguma faltar — nunca cai silenciosamente num default.
 */
export function readApoiaSeEnv(env: NodeJS.ProcessEnv = process.env): ApoiaSeEnv {
  const apiKey = (env.APOIA_SE_API_KEY ?? "").trim();
  const apiSecret = (env.APOIA_SE_API_SECRET ?? "").trim();
  const campaign = (env.APOIA_SE_CAMPAIGN ?? "").trim();

  const missing: string[] = [];
  if (!apiKey) missing.push("APOIA_SE_API_KEY");
  if (!apiSecret) missing.push("APOIA_SE_API_SECRET");
  if (!campaign) missing.push("APOIA_SE_CAMPAIGN");

  if (missing.length > 0) {
    throw new Error(
      `apoia.se: variável(is) de ambiente ausente(s): ${missing.join(", ")}. ` +
        `Configure em .env.local (ver .env.example) — nunca hardcode a credencial no código.`,
    );
  }
  return { apiKey, apiSecret, campaign };
}

// ---------------------------------------------------------------------------
// Tipos + erros
// ---------------------------------------------------------------------------

export interface BackerStatus {
  isBacker: boolean;
  isPaidThisMonth: boolean;
  /** Ausente quando o e-mail não é encontrado (doc: "sem thisMonthPaidValue"). */
  thisMonthPaidValue?: number;
}

/** 401 — chave/segredo incorretos. Distinto de outros erros HTTP pra permitir
 *  o caller (probe/CLI) dar uma mensagem de auth específica. */
export class ApoiaSeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApoiaSeAuthError";
  }
}

/** Qualquer outro erro HTTP não-2xx (exceto 401). */
export class ApoiaSeApiError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`apoia.se GET /backers/charges → HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "ApoiaSeApiError";
    this.status = status;
  }
}

interface RawBackerResponse {
  isBacker?: boolean;
  isPaidThisMonth?: boolean;
  thisMonthPaidValue?: number;
  message?: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Rate limiter — ≤5 req/s (espaça o INÍCIO de cada chamada)
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  /** Teto de chamadas por segundo (default 5 — limite documentado da apoia.se). */
  maxPerSecond?: number;
  /** Injetável para testes determinísticos (default: Date.now). */
  now?: () => number;
  /** Injetável para testes determinísticos (default: setTimeout real). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Limitador de taxa por janela fixa: garante que o INÍCIO de cada chamada
 * respeita `maxPerSecond`. Não serializa a EXECUÇÃO de `fn` (várias podem
 * estar em voo simultaneamente) — só o espaçamento entre disparos, suficiente
 * pra respeitar o rate limit de um endpoint simples como este.
 *
 * Implementação: fila de reservas encadeada via Promise (`chain`) — cada
 * `throttle()` reserva o próximo slot disponível (`nextAvailableAt`) na ORDEM
 * de chamada (preserva FIFO mesmo sob concorrência), depois aguarda até esse
 * instante antes de rodar `fn`.
 */
export class RateLimiter {
  private readonly minIntervalMs: number;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private nextAvailableAt = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions = {}) {
    const maxPerSecond = opts.maxPerSecond ?? 5;
    if (!(maxPerSecond > 0)) {
      throw new Error("RateLimiter: maxPerSecond deve ser > 0");
    }
    this.minIntervalMs = 1000 / maxPerSecond;
    this.nowFn = opts.now ?? Date.now;
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async throttle<T>(fn: () => Promise<T>): Promise<T> {
    const runAt = await this.reserveSlot();
    const wait = runAt - this.nowFn();
    if (wait > 0) await this.sleepFn(wait);
    return fn();
  }

  private reserveSlot(): Promise<number> {
    let resolveSlot!: (t: number) => void;
    const slot = new Promise<number>((res) => {
      resolveSlot = res;
    });
    this.chain = this.chain.then(() => {
      const now = this.nowFn();
      const runAt = Math.max(now, this.nextAvailableAt);
      this.nextAvailableAt = runAt + this.minIntervalMs;
      resolveSlot(runAt);
    });
    return slot;
  }
}

let sharedLimiter: RateLimiter | null = null;
function getDefaultLimiter(): RateLimiter {
  if (!sharedLimiter) sharedLimiter = new RateLimiter();
  return sharedLimiter;
}

// ---------------------------------------------------------------------------
// Cache por mês-competência (BRT)
// ---------------------------------------------------------------------------

/** Mês de competência (BRT) no formato YYYY-MM — chave do arquivo de cache. */
export function competenceMonth(now: Date = new Date(), timeZone: string = BRT_TIMEZONE): string {
  const { year, month } = datePartsInTz(now, timeZone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Diretório de cache default: `data/apoia-se/{campaign}/` (namespaced por
 *  campanha — a apoia.se hoje só tem "diaria", mas evita colisão futura). */
export function defaultCacheDir(campaign: string): string {
  return resolve(REPO_ROOT, "data", "apoia-se", campaign);
}

type MonthCache = Record<string, BackerStatus>;

function loadMonthCache(path: string): MonthCache {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MonthCache;
  } catch {
    console.error(`⚠️  apoia.se: cache corrompido em ${path} — ignorando (será regravado)`);
    return {};
  }
}

function saveMonthCache(path: string, cache: MonthCache): void {
  writeFileAtomic(path, JSON.stringify(cache, null, 2));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchBackerStatus(
  email: string,
  env: ApoiaSeEnv,
  fetchImpl: typeof fetch,
  limiter: RateLimiter,
): Promise<BackerStatus> {
  return limiter.throttle(async () => {
    const url = `${API_BASE}/backers/charges/${encodeURIComponent(email)}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json",
          "x-api-key": env.apiKey,
          authorization: `Bearer ${env.apiSecret}`,
        },
      });
    } catch (e) {
      throw new Error(`apoia.se: falha de rede consultando ${email}: ${(e as Error).message}`);
    }

    if (res.status === 401) {
      const body = await res.text().catch(() => "");
      let message = "não autorizado";
      try {
        const parsed = JSON.parse(body) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // corpo não-JSON — mantém a mensagem default
      }
      throw new ApoiaSeAuthError(
        `apoia.se: 401 (${message}) — verifique APOIA_SE_API_KEY/APOIA_SE_API_SECRET em .env.local.`,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ApoiaSeApiError(res.status, body);
    }

    let json: RawBackerResponse;
    try {
      json = (await res.json()) as RawBackerResponse;
    } catch (e) {
      throw new Error(`apoia.se: resposta não-JSON para ${email}: ${(e as Error).message}`);
    }

    const status: BackerStatus = {
      isBacker: Boolean(json.isBacker),
      isPaidThisMonth: Boolean(json.isPaidThisMonth),
    };
    // Doc: "sem thisMonthPaidValue" quando não encontrado — só inclui o campo
    // quando a API de fato devolveu um número.
    if (typeof json.thisMonthPaidValue === "number") {
      status.thisMonthPaidValue = json.thisMonthPaidValue;
    }
    return status;
  });
}

// ---------------------------------------------------------------------------
// API pública do módulo
// ---------------------------------------------------------------------------

export interface CheckBackerOptions {
  /** Env já resolvido (default: `readApoiaSeEnv()`). Injetável pra testes. */
  env?: ApoiaSeEnv;
  /** Implementação de fetch (default: fetch global). Injetável pra testes — NUNCA bater na API real em teste. */
  fetchImpl?: typeof fetch;
  /** Rate limiter compartilhado (default: singleton do módulo, 5 req/s). */
  limiter?: RateLimiter;
  /** Diretório de cache (default: `data/apoia-se/{campaign}`). Injetável pra isolar testes do `data/` real. */
  cacheDir?: string;
  /** Ponto de referência pra calcular o mês-competência (default: `new Date()`). Injetável pra testar virada de mês. */
  now?: Date;
}

/**
 * Verifica se `email` é apoiador pagante da campanha no mês corrente.
 * Consulta o cache do mês-competência (BRT) antes de bater na API; em cache
 * miss, faz o fetch (respeitando o rate limiter) e grava o resultado.
 */
export async function checkBacker(
  email: string,
  opts: CheckBackerOptions = {},
): Promise<BackerStatus> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new Error("apoia.se: email vazio");
  }

  const env = opts.env ?? readApoiaSeEnv();
  const now = opts.now ?? new Date();
  const month = competenceMonth(now);
  const cacheDir = opts.cacheDir ?? defaultCacheDir(env.campaign);
  const cachePath = resolve(cacheDir, `${month}.json`);

  const cache = loadMonthCache(cachePath);
  const cached = cache[normalized];
  if (cached) return cached;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const limiter = opts.limiter ?? getDefaultLimiter();
  const status = await fetchBackerStatus(normalized, env, fetchImpl, limiter);

  cache[normalized] = status;
  mkdirSync(cacheDir, { recursive: true });
  saveMonthCache(cachePath, cache);

  return status;
}
