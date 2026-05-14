#!/usr/bin/env tsx
/**
 * lint-test-email-link-tracking.ts (#1248, follow-up de #1212)
 *
 * Verifica se todos os URLs no email respondem 200. Decoda redirects
 * de Gmail Image Proxy (`google.com/url?q=...`) e Beehiiv tracking
 * (`link.diaria.beehiiv.com/...`) antes do HEAD.
 *
 * Estratégia:
 * 1. Extrai URLs de hrefs no HTML do email.
 * 2. Para cada URL única, resolve até 3 redirects + HEAD.
 * 3. Reporta:
 *    - `link_dead`: HEAD final retorna 4xx/5xx
 *    - `link_timeout`: HEAD demora >5s
 *    - `link_redirect_chain_long`: >3 hops até 200
 *
 * Whitelist: domínios que retornam 4xx pra bots mesmo quando OK
 * (linkedin.com, facebook.com — exigem login). Reportados como
 * `link_skip_auth_required` (info).
 *
 * Uso:
 *   npx tsx scripts/lint-test-email-link-tracking.ts \
 *     --email-file /tmp/email-260514.txt \
 *     --out /tmp/lint-link-tracking.json
 *
 * Exit codes:
 *   0 = nenhum link_dead/link_timeout (auth-required skipped não conta)
 *   1 = pelo menos 1 link_dead OU link_timeout
 *   2 = erro de uso
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface LinkIssue {
  type: "link_dead" | "link_timeout" | "link_redirect_chain_long";
  url: string;
  /** URL final após redirects (se aplicável). */
  final_url?: string;
  /** Status HTTP final (null se timeout). */
  status: number | null;
  /** Quantos hops de redirect. */
  hops: number;
  details: string;
}

export interface LinkSkip {
  url: string;
  reason: "auth_required" | "non_http" | "tel_mailto";
  domain?: string;
}

export interface LinkTrackingResult {
  total_urls_extracted: number;
  total_urls_checked: number;
  issues: LinkIssue[];
  skipped: LinkSkip[];
  passed: number;
}

const AUTH_REQUIRED_DOMAINS = new Set([
  "linkedin.com",
  "www.linkedin.com",
  "facebook.com",
  "www.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "twitter.com",
  "x.com",
]);

const MAX_REDIRECTS = 3;
const HEAD_TIMEOUT_MS = 5000;

/**
 * Extrai todos URLs de hrefs no HTML/text do email.
 */
export function extractEmailUrls(content: string): string[] {
  const urls = new Set<string>();
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(content)) !== null) {
    urls.add(m[1]);
  }
  // Também captura URLs nuas no texto (plain emails)
  const bareRe = /https?:\/\/[^\s"'<>)]+/gi;
  while ((m = bareRe.exec(content)) !== null) {
    urls.add(m[0]);
  }
  return [...urls];
}

/**
 * Decoda redirect wrappers conhecidos:
 * - Gmail Image Proxy: `https://www.google.com/url?q={encoded}&sa=U...`
 * - Beehiiv tracking: `https://link.diaria.beehiiv.com/.../?l={encoded}` ou
 *   versão proprietária (não decodificável sem fetch).
 *
 * Retorna a URL "limpa" pra HEAD. Se não reconhece wrapper, retorna tal qual.
 */
export function decodeRedirectWrapper(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "www.google.com" && u.pathname === "/url") {
      const q = u.searchParams.get("q");
      if (q) return q;
    }
    // Beehiiv não expõe target em query — fica como está (HEAD do tracking).
    return url;
  } catch {
    return url;
  }
}

/**
 * Categoriza URL pra decisão de skip:
 * - non_http: protocolos não-http (mailto, tel, javascript) — skip silencioso
 * - auth_required: domínios que exigem login (skip + info)
 * - null: deve fazer HEAD
 */
export function categorizeUrl(url: string): "non_http" | "auth_required" | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "non_http";
  }
  if (!/^https?:$/.test(parsed.protocol)) return "non_http";
  if (AUTH_REQUIRED_DOMAINS.has(parsed.hostname.toLowerCase())) {
    return "auth_required";
  }
  return null;
}

interface HeadResult {
  status: number | null;
  hops: number;
  final_url: string;
  timed_out: boolean;
}

/**
 * Faz HEAD com follow-redirect manual (até MAX_REDIRECTS).
 * Retorna status final, hops, URL final.
 */
async function headWithRedirects(url: string, fetchImpl: typeof fetch): Promise<HeadResult> {
  let current = url;
  let hops = 0;
  let lastStatus: number | null = null;
  while (hops <= MAX_REDIRECTS) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
    try {
      const res = await fetchImpl(current, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
      });
      lastStatus = res.status;
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) {
          return { status: res.status, hops, final_url: current, timed_out: false };
        }
        // Resolve relative location
        try {
          current = new URL(loc, current).toString();
        } catch {
          current = loc;
        }
        hops++;
        continue;
      }
      return { status: res.status, hops, final_url: current, timed_out: false };
    } catch (e) {
      const isAbort = (e as Error).name === "AbortError";
      return { status: lastStatus, hops, final_url: current, timed_out: isAbort };
    } finally {
      clearTimeout(t);
    }
  }
  // Excedeu MAX_REDIRECTS sem chegar a 200 final
  return { status: lastStatus, hops, final_url: current, timed_out: false };
}

export async function checkLinkTracking(
  emailContent: string,
  fetchImpl: typeof fetch = fetch,
  concurrency = 5,
): Promise<LinkTrackingResult> {
  const rawUrls = extractEmailUrls(emailContent);
  const issues: LinkIssue[] = [];
  const skipped: LinkSkip[] = [];
  let passed = 0;

  // Decoda redirect wrappers + dedup
  const queue: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawUrls) {
    const decoded = decodeRedirectWrapper(raw);
    if (seen.has(decoded)) continue;
    seen.add(decoded);
    const cat = categorizeUrl(decoded);
    if (cat === "non_http") {
      skipped.push({ url: decoded, reason: decoded.startsWith("mailto:") ? "tel_mailto" : "non_http" });
      continue;
    }
    if (cat === "auth_required") {
      const host = (() => { try { return new URL(decoded).hostname; } catch { return ""; } })();
      skipped.push({ url: decoded, reason: "auth_required", domain: host });
      continue;
    }
    queue.push(decoded);
  }

  // Processa em batches de `concurrency` pra não saturar rede
  for (let i = 0; i < queue.length; i += concurrency) {
    const batch = queue.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((u) => headWithRedirects(u, fetchImpl).then((r) => ({ url: u, r }))));
    for (const { url, r } of results) {
      if (r.timed_out) {
        issues.push({
          type: "link_timeout",
          url,
          status: null,
          hops: r.hops,
          details: `HEAD timeout após ${HEAD_TIMEOUT_MS}ms.`,
        });
      } else if (r.hops > MAX_REDIRECTS) {
        issues.push({
          type: "link_redirect_chain_long",
          url,
          final_url: r.final_url,
          status: r.status,
          hops: r.hops,
          details: `${r.hops} redirects (limite ${MAX_REDIRECTS}). Final URL: ${r.final_url}`,
        });
      } else if (r.status !== null && r.status >= 400) {
        issues.push({
          type: "link_dead",
          url,
          final_url: r.final_url !== url ? r.final_url : undefined,
          status: r.status,
          hops: r.hops,
          details: `HEAD retornou ${r.status} em ${r.final_url}`,
        });
      } else {
        passed++;
      }
    }
  }

  return {
    total_urls_extracted: rawUrls.length,
    total_urls_checked: queue.length,
    issues,
    skipped,
    passed,
  };
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function mainCli(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args["email-file"]) {
    console.error("Uso: lint-test-email-link-tracking.ts --email-file <file> [--out <json>]");
    return 2;
  }
  const emailFile = String(args["email-file"]);
  if (!existsSync(emailFile)) {
    console.error(`email-file não existe: ${emailFile}`);
    return 2;
  }
  const content = readFileSync(emailFile, "utf8");
  const result = await checkLinkTracking(content);
  if (args.out) writeFileSync(String(args.out), JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));

  if (result.issues.length > 0) {
    console.error(`[lint-test-email-link-tracking] ${result.issues.length} issue(s):`);
    for (const i of result.issues) {
      console.error(`  - [${i.type}] ${i.url} → ${i.details}`);
    }
    return 1;
  }
  return 0;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (/\/scripts\/lint-test-email-link-tracking\.ts$/.test(_argv1)) {
  mainCli().then((code) => process.exit(code));
}
