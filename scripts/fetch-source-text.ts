/**
 * fetch-source-text.ts (#8595)
 *
 * Baixa uma página e grava o TEXTO BRUTO do corpo (sem resumo de LLM) para o
 * fact-checker ler via Read. O WebFetch resume a página e omite detalhes, o que
 * gera falso NOT_FOUND_IN_SOURCE.
 *
 * Uso:
 *   npx tsx scripts/fetch-source-text.ts <url> [--out arquivo.txt]
 *   (sem --out: imprime o texto no stdout)
 *
 * Segurança: só http(s); bloqueia localhost/loopback/IP privado/link-local na
 * URL inicial e em CADA redirect (redirect manual, máx. 5). Não resolve DNS
 * (rebinding fora de escopo). O texto baixado é DADO NÃO CONFIÁVEL.
 *
 * Exit codes:
 *   0 — texto extraído (e gravado, se --out)
 *   1 — erro de args / URL inválida ou proibida
 *   2 — fonte bloqueada (HTTP 401/403/429/451): tente fonte equivalente
 *   3 — outro erro (HTTP != 2xx, rede, corpo vazio/não textual)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_CHARS = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
const BLOCKED_STATUSES = new Set([401, 403, 429, 451]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "�";
  return String.fromCodePoint(n);
}

/** HTML -> texto do corpo: remove script/style/nav/footer/aside/comentários/tags, decodifica entidades, normaliza espaços. */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|template|nav|footer|aside|form)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/\r?\n/g, " ");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)\s*>|<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)));
  s = s.replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** true se o host é localhost, loopback, privado, link-local ou não-roteável. */
export function isForbiddenHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 127 || a === 10 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
    const v4 = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) return isForbiddenHost(v4[1]);
  }
  return false;
}

/** Retorna mensagem de erro se a URL não pode ser buscada; null se ok. */
export function validateUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "URL inválida";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `esquema não permitido: ${u.protocol}`;
  if (isForbiddenHost(u.hostname)) return `host proibido (loopback/privado/link-local): ${u.hostname}`;
  return null;
}

export type FetchTextResult =
  | { ok: true; status: number; text: string; bytes: number; truncated: boolean }
  | { ok: false; kind: "blocked" | "error"; status?: number; message: string };

export function blockedMessage(status: number): string {
  return `HTTP ${status}: fonte bloqueada; tente equivalente`;
}

function charsetOf(ct: string): string {
  const m = ct.match(/charset\s*=\s*["']?([\w.-]+)/i);
  return m ? m[1].toLowerCase() : "utf-8";
}

function isTextual(ct: string): boolean {
  return !ct || /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json))|\+xml/i.test(ct);
}

export async function fetchSourceText(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchTextResult> {
  try {
    let current = url;
    let res: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const bad = validateUrl(current);
      if (bad) return { ok: false, kind: "error", message: bad };
      res = await fetchImpl(current, {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop === MAX_REDIRECTS) return { ok: false, kind: "error", message: "redirects demais" };
        current = new URL(res.headers.get("location")!, current).toString();
        continue;
      }
      break;
    }
    if (!res) return { ok: false, kind: "error", message: "sem resposta" };
    if (BLOCKED_STATUSES.has(res.status)) {
      return { ok: false, kind: "blocked", status: res.status, message: blockedMessage(res.status) };
    }
    if (!res.ok) return { ok: false, kind: "error", status: res.status, message: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    if (!isTextual(ct)) {
      return { ok: false, kind: "error", status: res.status, message: `conteúdo não textual (${ct.split(";")[0]})` };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    let truncated = buf.length > MAX_BODY_BYTES;
    const slice = truncated ? buf.subarray(0, MAX_BODY_BYTES) : buf;
    let body: string;
    try {
      body = new TextDecoder(charsetOf(ct)).decode(slice);
    } catch {
      body = new TextDecoder("utf-8").decode(slice);
    }
    let text = /html|xml/i.test(ct) || /^\s*</.test(body) ? htmlToText(body) : body.trim();
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
      truncated = true;
    }
    if (!text) return { ok: false, kind: "error", status: res.status, message: "corpo vazio" };
    return { ok: true, status: res.status, text, bytes: Buffer.byteLength(text, "utf8"), truncated };
  } catch (e) {
    return { ok: false, kind: "error", message: `erro: ${(e as Error).message}` };
  }
}

async function main(): Promise<void> {
  const { values, positional } = parseArgs(process.argv.slice(2));
  const url = positional[0];
  if (!url || validateUrl(url)) {
    console.error(`Uso: fetch-source-text.ts <url http(s) pública> [--out arquivo]${url ? ` — ${validateUrl(url)}` : ""}`);
    process.exit(1);
  }
  const r = await fetchSourceText(url);
  if (!r.ok) {
    console.error(`[fetch-source-text] ${r.message} (${url})`);
    process.exit(r.kind === "blocked" ? 2 : 3);
  }
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, r.text, "utf8");
    console.log(values.out);
  } else {
    console.log(r.text);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[fetch-source-text] ERRO:", e);
    process.exit(3);
  });
}
