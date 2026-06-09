import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_CSV = resolve(ROOT, "seed/sources.csv");
const OUT = resolve(ROOT, "context/sources.md");

import { isUseMelhorSource } from "./lib/use-melhor-sources.ts"; // #1899

type Source = { Nome: string; Tipo: string; URL: string; RSS?: string; topic_filter?: string; use_melhor?: string; low_cadence?: string };

const csv = readFileSync(SOURCES_CSV, "utf8");
const { data, errors } = Papa.parse<Source>(csv, { header: true, skipEmptyLines: true });

// TooFewFields is expected when rows predate a new optional column (e.g. low_cadence).
// Only hard-fail on structural errors that produce incorrect data (#1992).
const hardErrors = errors.filter((e) => e.code !== "TooFewFields");
if (hardErrors.length) {
  console.error("CSV parse errors:", hardErrors);
  process.exit(1);
}

const byType = new Map<string, Source[]>();
for (const row of data) {
  if (!row.Nome || !row.URL) continue;
  const type = row.Tipo?.trim() || "Outras";
  if (!byType.has(type)) byType.set(type, []);
  byType.get(type)!.push(row);
}

// #1987: hosts MULTI-TENANT — o path é load-bearing (host-only retornaria
// conteúdo de OUTROS usuários/orgs). Code-review pegou github.com (Anthropic
// Cookbook → todo o GitHub) e wandb.ai (projetos de qualquer usuário). Pra esses,
// manter o path-scoping (status quo) é melhor que floodar de conteúdo errado.
const SHARED_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "wandb.ai",
  "medium.com",
  "substack.com",
  "youtube.com",
  "reddit.com",
  "kaggle.com",
]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * #1987: `site:{host}` SEM path quando o host é DEDICADO a uma única fonte — o
 * `site:{host}/path` path-scoped sub-retornava no backend (OpenAI Cookbook,
 * LangChain, Pinecone davam 0 apesar de vivas). Host-only retorna; relevância
 * vem da query (`AI OR …`) + topic_filter + categorize + score downstream.
 *
 * MANTÉM o path quando: (a) host multi-tenant (SHARED_HOSTS — host-only floodaria
 * de conteúdo de terceiros); ou (b) host aparece em >1 fonte cadastrada
 * (huggingface.co Blog+Learn, anthropic.com news+institute) — host-only colidiria
 * as queries (buscas Brave duplicadas + double-attribution). Code-review #1987.
 */
function siteQuery(url: string, hostCounts: Map<string, number>): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname.replace(/\/$/, "");
    const keepPath = SHARED_HOSTS.has(host) || (hostCounts.get(host) ?? 0) > 1;
    return path && path !== "/" && keepPath ? `site:${host}${path}` : `site:${host}`;
  } catch {
    return `site:${url}`;
  }
}

// Conta quantas fontes compartilham cada host (pra decidir keepPath por colisão).
const hostCounts = new Map<string, number>();
for (const row of data) {
  if (!row.Nome || !row.URL) continue;
  const h = hostOf(row.URL);
  if (h) hostCounts.set(h, (hostCounts.get(h) ?? 0) + 1);
}

const lines: string[] = [
  "# Fontes cadastradas — Diar.ia",
  "",
  `**Total:** ${data.length} fontes (${data.filter(isUseMelhorSource).length} marcadas Use Melhor). Gerado de \`seed/sources.csv\` via \`npm run sync-sources\`.`,
  "",
];

const order = ["Brasil", "Primária", "Secundária", "Pesquisa", "Tutoriais"];
const seenTypes = new Set<string>();

for (const t of order) {
  if (!byType.has(t)) continue;
  seenTypes.add(t);
  lines.push(`## ${t}`, "");
  for (const s of byType.get(t)!) {
    renderSource(s, lines);
  }
}

for (const [t, rows] of byType) {
  if (seenTypes.has(t)) continue;
  lines.push(`## ${t}`, "");
  for (const s of rows) {
    renderSource(s, lines);
  }
}

function renderSource(s: Source, out: string[]): void {
  out.push(`### ${s.Nome}`, `- URL: ${s.URL}`, `- Site query: \`${siteQuery(s.URL, hostCounts)}\``);
  const rss = s.RSS?.trim();
  if (rss) out.push(`- RSS: ${rss}`);
  const topicFilter = s.topic_filter?.trim();
  if (topicFilter) out.push(`- Topic filter: ${topicFilter}`);
  if (isUseMelhorSource(s)) out.push(`- Use Melhor: sim`); // #1899
  const lc = s.low_cadence?.trim();
  if (lc === "1" || lc?.toLowerCase() === "sim") out.push(`- Low cadence: sim`); // #1992
  out.push("");
}

writeFileSync(OUT, lines.join("\n"), "utf8");
console.log(`Wrote ${data.length} sources to ${OUT}`);
