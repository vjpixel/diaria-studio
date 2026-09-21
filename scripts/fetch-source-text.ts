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
 * Exit codes:
 *   0 — texto extraído (e gravado, se --out)
 *   1 — erro de args / URL inválida
 *   2 — fonte bloqueada (HTTP 451/403): tente fonte equivalente
 *   3 — outro erro (HTTP != 2xx, rede, corpo vazio)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/** HTML -> texto do corpo: remove script/style/comentários/tags, decodifica entidades, normaliza espaços. */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/\r?\n/g, " ");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)\s*>|<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  s = s.replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function slugFromUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "source";
  }
  const raw = `${u.hostname}${u.pathname}`.toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "source";
}

export type FetchTextResult =
  | { ok: true; status: number; text: string }
  | { ok: false; kind: "blocked" | "error"; status?: number; message: string };

export function blockedMessage(status: number): string {
  return `HTTP ${status}: fonte bloqueada; tente equivalente`;
}

export async function fetchSourceText(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchTextResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { ok: false, kind: "error", message: `erro de rede: ${(e as Error).message}` };
  }
  if (res.status === 451 || res.status === 403) {
    return { ok: false, kind: "blocked", status: res.status, message: blockedMessage(res.status) };
  }
  if (!res.ok) {
    return { ok: false, kind: "error", status: res.status, message: `HTTP ${res.status}` };
  }
  const body = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  const text = /html|xml/i.test(ct) || /^\s*</.test(body) ? htmlToText(body) : body.trim();
  if (!text) return { ok: false, kind: "error", status: res.status, message: "corpo vazio" };
  return { ok: true, status: res.status, text };
}

async function main(): Promise<void> {
  const { values, positional } = parseArgs(process.argv.slice(2));
  const url = positional[0];
  if (!url || !/^https?:\/\//i.test(url)) {
    console.error("Uso: fetch-source-text.ts <url> [--out arquivo]");
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
