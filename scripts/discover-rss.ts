#!/usr/bin/env npx tsx
/**
 * discover-rss.ts (#225)
 *
 * Tenta descobrir feed RSS/Atom pra cada fonte em `seed/sources.csv`
 * que está com a coluna RSS vazia. Atualiza o CSV in-place e reporta.
 *
 * Heurísticas (em ordem, primeira validação válida ganha):
 *   1. URL da fonte + sufixos comuns (/feed, /feed/, /rss, /rss.xml, /atom.xml, /index.xml)
 *   2. Origin (root do domínio) + mesmos sufixos
 *   3. HTML link discovery: parsear a página fonte e extrair
 *      <link rel="alternate" type="application/rss+xml" href="..."> ou atom+xml
 *
 * Validação de candidato: chama `fetchRss` (mesma função que o
 * source-researcher usa). Aceita se: status ok, sem `error`, e
 * `articles.length > 0` quando filtrado por janela ampla (90 dias —
 * cobre fontes que publicam baixa frequência).
 *
 * Uso:
 *   npx tsx scripts/discover-rss.ts                    # roda em todas
 *   npx tsx scripts/discover-rss.ts --dry-run          # não escreve CSV
 *   npx tsx scripts/discover-rss.ts --source "Canaltech (IA)"
 *   npx tsx scripts/discover-rss.ts --csv custom/path.csv
 *
 * Output:
 *   - stdout: JSON com { total, attempted, discovered, results[] }
 *   - stderr: progress por fonte (1 linha por tentativa)
 *
 * Defesa: pula fontes em domínios sem suporte de RSS (twitter/linkedin/etc).
 * Timeout 10s por candidato pra não pendurar em fontes lentas.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { fetchRss } from "./fetch-rss.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CSV = resolve(ROOT, "seed/sources.csv");

const CANDIDATE_SUFFIXES = [
  "/feed",
  "/feed/",
  "/rss",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
  "/feed.xml",
  "/feeds/all.atom.xml",
];

// Domínios sem RSS conhecido — pula descoberta pra não desperdiçar requests.
const SKIP_HOSTS = new Set([
  "twitter.com",
  "x.com",
  "linkedin.com",
  "instagram.com",
  "facebook.com",
  "tiktok.com",
]);

const DEFAULT_TIMEOUT_MS = 10_000;
const VALIDATION_WINDOW_DAYS = 90; // cobre fontes de baixa frequência

export interface SourceRow {
  Nome: string;
  Tipo: string;
  URL: string;
  RSS?: string;
}

export interface DiscoveryResult {
  source: string;
  url: string;
  status: "discovered" | "no_feed_found" | "skipped" | "already_has_rss";
  rss?: string;
  candidates_tried?: number;
  reason?: string;
}

/**
 * Gera lista de candidatos de URL pra uma fonte. Ordem importa —
 * candidatos mais prováveis primeiro pra reduzir requests.
 */
export function generateCandidates(sourceUrl: string): string[] {
  const candidates: string[] = [];
  let u: URL;
  try {
    u = new URL(sourceUrl);
  } catch {
    return [];
  }

  const origin = `${u.protocol}//${u.host}`;
  const pathStripped = u.pathname.replace(/\/$/, "");
  const sourceWithoutTrailingSlash = origin + pathStripped;

  // 1. URL da fonte + sufixos (ex: /inteligencia-artificial/feed)
  for (const suffix of CANDIDATE_SUFFIXES) {
    if (pathStripped) {
      candidates.push(sourceWithoutTrailingSlash + suffix);
    }
  }

  // 2. Origin + sufixos (ex: site.com/feed)
  for (const suffix of CANDIDATE_SUFFIXES) {
    candidates.push(origin + suffix);
  }

  // Dedup preservando ordem
  return Array.from(new Set(candidates));
}

/**
 * Extrai feeds anunciados via <link rel="alternate" type="application/rss+xml">
 * no HTML da página. Retorna array de URLs absolutos.
 */
export function extractFeedsFromHtml(html: string, baseUrl: string): string[] {
  const feeds: string[] = [];
  // Regex permissiva — atributos podem vir em qualquer ordem.
  // Captura tags <link ...> com rel=alternate + type=rss/atom.
  const linkRe = /<link\s+([^>]+)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null) {
    const attrs = match[1];
    const isAlternate = /\brel\s*=\s*["']?alternate["']?/i.test(attrs);
    const isFeed = /\btype\s*=\s*["']?application\/(rss|atom)\+xml["']?/i.test(
      attrs,
    );
    if (!isAlternate || !isFeed) continue;
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    try {
      const absolute = new URL(hrefMatch[1], baseUrl).toString();
      if (!feeds.includes(absolute)) feeds.push(absolute);
    } catch {
      // ignore invalid href
    }
  }
  return feeds;
}

/**
 * Faz fetch da página HTML pra discovery (heurística 3). Falha de rede
 * retorna [] silenciosamente — heurísticas 1 e 2 já tentaram URLs diretas.
 */
async function fetchHtmlFeeds(url: string, timeoutMs: number): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "DiariaBot/1.0 (+https://diar.ia.br) RSS discovery",
        Accept: "text/html, */*",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return [];
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html") && !ct.includes("xml")) return [];
    const html = await res.text();
    return extractFeedsFromHtml(html, url);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Valida um candidato. Retorna feed_url se válido, null caso contrário.
 * Critério: fetchRss não retornou error E retornou ≥1 article (na janela
 * ampla de 90 dias).
 */
async function validateCandidate(
  candidateUrl: string,
  sourceName: string,
  timeoutMs: number,
): Promise<{ valid: boolean; reason?: string }> {
  const result = await fetchRss({
    url: candidateUrl,
    sourceName,
    days: VALIDATION_WINDOW_DAYS,
    timeoutMs,
  });
  if (result.error) {
    return { valid: false, reason: result.error };
  }
  if (result.articles.length === 0) {
    return { valid: false, reason: "feed válido mas vazio (0 artigos em 90d)" };
  }
  return { valid: true };
}

export function shouldSkipHost(sourceUrl: string): boolean {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
    return SKIP_HOSTS.has(host);
  } catch {
    return true;
  }
}

/**
 * Tenta descobrir feed pra uma fonte. Tenta heurísticas em ordem; primeira
 * validação válida ganha. Retorna DiscoveryResult com status e RSS encontrado.
 */
export async function discoverFeedForSource(
  row: SourceRow,
  opts: { timeoutMs?: number; logger?: (msg: string) => void } = {},
): Promise<DiscoveryResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.logger ?? (() => {});

  if (row.RSS && row.RSS.trim()) {
    return {
      source: row.Nome,
      url: row.URL,
      status: "already_has_rss",
      rss: row.RSS,
    };
  }

  if (shouldSkipHost(row.URL)) {
    return {
      source: row.Nome,
      url: row.URL,
      status: "skipped",
      reason: "host sem suporte de RSS conhecido",
    };
  }

  // Heurística 1+2: candidatos por sufixo
  const directCandidates = generateCandidates(row.URL);
  let tried = 0;
  for (const candidate of directCandidates) {
    tried++;
    log(`[${row.Nome}] tentando: ${candidate}`);
    const r = await validateCandidate(candidate, row.Nome, timeoutMs);
    if (r.valid) {
      return {
        source: row.Nome,
        url: row.URL,
        status: "discovered",
        rss: candidate,
        candidates_tried: tried,
      };
    }
  }

  // Heurística 3: HTML link discovery
  log(`[${row.Nome}] HTML discovery em ${row.URL}`);
  const htmlFeeds = await fetchHtmlFeeds(row.URL, timeoutMs);
  for (const feed of htmlFeeds) {
    tried++;
    log(`[${row.Nome}] HTML announced: ${feed}`);
    const r = await validateCandidate(feed, row.Nome, timeoutMs);
    if (r.valid) {
      return {
        source: row.Nome,
        url: row.URL,
        status: "discovered",
        rss: feed,
        candidates_tried: tried,
      };
    }
  }

  return {
    source: row.Nome,
    url: row.URL,
    status: "no_feed_found",
    candidates_tried: tried,
  };
}

interface CliFlags {
  csvPath: string;
  dryRun: boolean;
  source?: string;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { csvPath: DEFAULT_CSV, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--csv" && argv[i + 1]) {
      flags.csvPath = resolve(ROOT, argv[i + 1]);
      i++;
    } else if (a === "--source" && argv[i + 1]) {
      flags.source = argv[i + 1];
      i++;
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const csv = readFileSync(flags.csvPath, "utf8");
  const parsed = Papa.parse<SourceRow>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length > 0) {
    console.error("CSV parse errors:", parsed.errors);
    process.exit(1);
  }
  const rows = parsed.data;

  const targets = flags.source
    ? rows.filter((r) => r.Nome === flags.source)
    : rows;

  if (flags.source && targets.length === 0) {
    console.error(`Nenhuma fonte com nome "${flags.source}" encontrada.`);
    process.exit(1);
  }

  const results: DiscoveryResult[] = [];
  for (const row of targets) {
    const result = await discoverFeedForSource(row, {
      logger: (msg) => process.stderr.write(msg + "\n"),
    });
    results.push(result);
    if (result.status === "discovered") {
      row.RSS = result.rss;
      process.stderr.write(`✓ ${row.Nome} → ${result.rss}\n`);
    } else if (result.status === "no_feed_found") {
      process.stderr.write(`✗ ${row.Nome} (${result.candidates_tried} tentativas)\n`);
    } else if (result.status === "skipped") {
      process.stderr.write(`- ${row.Nome} (skip: ${result.reason})\n`);
    }
  }

  if (!flags.dryRun) {
    const updated = Papa.unparse(rows, {
      columns: ["Nome", "Tipo", "URL", "RSS"],
      newline: "\n",
    });
    // Preserva a presença/ausência de newline final do arquivo original
    // pra evitar diff espúrio nas linhas que não foram tocadas.
    const trailingNewline = csv.endsWith("\n") ? "\n" : "";
    writeFileSync(flags.csvPath, updated + trailingNewline, "utf8");
    process.stderr.write(`\nCSV atualizado: ${flags.csvPath}\n`);
  } else {
    process.stderr.write("\n[dry-run] CSV não escrito.\n");
  }

  const summary = {
    total: rows.length,
    attempted: targets.length,
    discovered: results.filter((r) => r.status === "discovered").length,
    no_feed_found: results.filter((r) => r.status === "no_feed_found").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    already_has_rss: results.filter((r) => r.status === "already_has_rss").length,
    results,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
