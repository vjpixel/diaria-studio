/**
 * doh-fetch.ts (#1365 / #1377)
 *
 * Wrapper de fetch que cai num fallback DNS-over-HTTPS quando o resolver
 * native do Node falha (ENOTFOUND, UND_ERR_CONNECT_TIMEOUT, etc).
 *
 * Por que existe: em 260519, descobrimos que ISP/router local bloqueia
 * lookups DNS UDP/53 seletivamente pra `poll.diaria.workers.dev`
 * (mas resolve `google.com` no mesmo resolver). Chrome alcança pois usa
 * DoH built-in; Node não. Resultado: scripts que dependem do Worker poll
 * (close-poll, fetch-poll-stats, fetch-leaderboard-top1) falham
 * intermitente conforme cache state varia.
 *
 * Estratégia:
 * 1. Tenta `fetch(url)` normal — fast path quando DNS UDP funciona
 * 2. Em falha de conexão, resolve hostname via DoH HTTPS (1.1.1.1)
 * 3. Reconnecta usando o IP resolvido + Host header preservado pra SNI
 *
 * Uso:
 *   import { dohFetch } from "./lib/doh-fetch.ts";
 *   const res = await dohFetch("https://poll.diaria.workers.dev/stats?edition=260519");
 *
 * Limitações:
 *   - HTTPS-only (HTTP não passa por SNI rewrite necessário)
 *   - Tenta UDP primeiro; latência adicional só em fallback path
 *   - Cache de resolução TTL=300s in-memory (mata na próxima invocação)
 */

import { request } from "node:https";
import { connect as tlsConnect } from "node:tls";

const DOH_RESOLVER = "https://1.1.1.1/dns-query";
const DOH_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;
const RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000; // 5min

interface DohResolution {
  ip: string;
  resolved_at_ms: number;
}

const resolutionCache = new Map<string, DohResolution>();

/**
 * Resolve hostname via Cloudflare DoH (HTTPS 443). Bypassa UDP 53 que
 * pode estar bloqueado por ISP/router.
 *
 * Retorna primeira entry A record. Falha → lança Error.
 *
 * Cache TTL 5min in-memory pra evitar overhead em scripts que fazem
 * múltiplas chamadas no mesmo hostname.
 */
export async function resolveViaDoH(hostname: string): Promise<string> {
  const cached = resolutionCache.get(hostname);
  if (cached && Date.now() - cached.resolved_at_ms < RESOLUTION_CACHE_TTL_MS) {
    return cached.ip;
  }

  const url = `${DOH_RESOLVER}?name=${encodeURIComponent(hostname)}&type=A`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`DoH resolve ${hostname}: HTTP ${res.status}`);
  }

  const json = (await res.json()) as {
    Status?: number;
    Answer?: Array<{ name: string; type: number; TTL: number; data: string }>;
  };
  if (json.Status !== 0) {
    throw new Error(`DoH resolve ${hostname}: Status=${json.Status}`);
  }
  const aRecord = (json.Answer ?? []).find((a) => a.type === 1);
  if (!aRecord) {
    throw new Error(`DoH resolve ${hostname}: no A record`);
  }

  resolutionCache.set(hostname, { ip: aRecord.data, resolved_at_ms: Date.now() });
  return aRecord.data;
}

/**
 * Pure-ish: detecta se um erro de fetch é causado por DNS/connect timeout
 * que justificaria retry via DoH. Aceita Error.cause também (undici).
 */
export function isDnsOrConnectError(err: unknown): boolean {
  const codes = [
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "EAI_AGAIN",
  ];
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return (
    (e.code !== undefined && codes.includes(e.code)) ||
    (e.cause?.code !== undefined && codes.includes(e.cause.code))
  );
}

/**
 * Fetch HTTPS com fallback DoH. Tenta nativo primeiro; em falha de DNS/connect,
 * resolve via DoH e reconecta com IP + Host header.
 *
 * IMPORTANT: só HTTPS. HTTP precisaria de outra lógica (sem TLS SNI).
 *
 * Opções (sub-set de RequestInit):
 *   - method (default GET)
 *   - headers
 *   - body
 *   - signal (AbortSignal)
 *
 * Retorna objeto compatível com Response (status, headers, text(), json()).
 */
export interface DohFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

export interface DohFetchResponse {
  ok: boolean;
  status: number;
  headers: Map<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export async function dohFetch(url: string, init: DohFetchInit = {}): Promise<DohFetchResponse> {
  // Try native fetch first
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const linkedSignal = init.signal
      ? composeSignals(init.signal, controller.signal)
      : controller.signal;
    try {
      const res = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body as BodyInit | undefined,
        signal: linkedSignal,
      });
      return wrapResponse(res);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    if (!isDnsOrConnectError(err)) throw err;
    // Fallback path
    return dohFallback(url, init);
  }
}

function composeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (a.aborted || b.aborted) abort();
  else {
    a.addEventListener("abort", abort, { once: true });
    b.addEventListener("abort", abort, { once: true });
  }
  return ctrl.signal;
}

function wrapResponse(res: Response): DohFetchResponse {
  const headers = new Map<string, string>();
  res.headers.forEach((v, k) => headers.set(k, v));
  return {
    ok: res.ok,
    status: res.status,
    headers,
    text: () => res.text(),
    json: () => res.json(),
  };
}

/**
 * Fallback path: resolve hostname via DoH e usa node:https.request com
 * createConnection que conecta no IP resolvido + servername correto pra SNI.
 */
async function dohFallback(url: string, init: DohFetchInit): Promise<DohFetchResponse> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`dohFetch fallback só suporta HTTPS; recebido ${parsed.protocol}`);
  }
  const ip = await resolveViaDoH(parsed.hostname);

  return new Promise<DohFetchResponse>((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: parsed.host,
      ...(init.headers ?? {}),
    };
    if (init.body && !headers["Content-Length"]) {
      headers["Content-Length"] = String(
        typeof init.body === "string"
          ? Buffer.byteLength(init.body)
          : init.body.byteLength,
      );
    }

    const req = request(
      {
        method: init.method ?? "GET",
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 443,
        path: parsed.pathname + parsed.search,
        headers,
        // createConnection: conecta no IP resolvido via DoH, com servername
        // = hostname pra SNI/cert validation correto.
        createConnection: (opts) => {
          return tlsConnect({
            host: ip,
            port: Number(opts.port ?? 443),
            servername: parsed.hostname, // SNI + cert validation
          });
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          const respHeaders = new Map<string, string>();
          for (const [k, v] of Object.entries(response.headers)) {
            if (typeof v === "string") respHeaders.set(k.toLowerCase(), v);
            else if (Array.isArray(v)) respHeaders.set(k.toLowerCase(), v.join(", "));
          }
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: respHeaders,
            text: async () => body.toString("utf8"),
            json: async () => JSON.parse(body.toString("utf8")),
          });
        });
        response.on("error", reject);
      },
    );

    const timeout = setTimeout(() => {
      req.destroy(new Error("dohFetch fallback timeout"));
      reject(new Error("dohFetch fallback timeout"));
    }, FETCH_TIMEOUT_MS);

    req.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    req.on("close", () => clearTimeout(timeout));

    if (init.signal) {
      init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), {
        once: true,
      });
    }
    if (init.body) {
      req.write(init.body);
    }
    req.end();
  });
}
