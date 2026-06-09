import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_CSV = resolve(ROOT, "seed/sources.csv");
const OUT = resolve(ROOT, "context/sources.md");

import { isUseMelhorSource } from "./lib/use-melhor-sources.ts"; // #1899

type Source = { Nome: string; Tipo: string; URL: string; RSS?: string; topic_filter?: string; use_melhor?: string };

const csv = readFileSync(SOURCES_CSV, "utf8");
const { data, errors } = Papa.parse<Source>(csv, { header: true, skipEmptyLines: true });

if (errors.length) {
  console.error("CSV parse errors:", errors);
  process.exit(1);
}

const byType = new Map<string, Source[]>();
for (const row of data) {
  if (!row.Nome || !row.URL) continue;
  const type = row.Tipo?.trim() || "Outras";
  if (!byType.has(type)) byType.set(type, []);
  byType.get(type)!.push(row);
}

/**
 * #1987: `site:{host}` SEM path. O `site:{host}/path` path-scoped sub-retornava
 * no backend de busca — fontes com path (OpenAI Cookbook /cookbook, LangChain
 * /blog, W&B /fully-connected, Pinecone /learn) davam 0 resultados apesar de
 * vivas. Host-only retorna; a relevância vem da query (`AI OR "inteligência
 * artificial"`) + topic_filter + categorize + score downstream. (Path-filter
 * estrito foi DESCARTADO: os tutoriais do W&B moram em sub-paths de autor
 * `wandb.ai/wandb_fc/...`, não só `/fully-connected` — um filtro de path os
 * excluiria. Auditoria #1971/#1987.)
 */
function siteQuery(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    return `site:${host}`;
  } catch {
    return `site:${url}`;
  }
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
  out.push(`### ${s.Nome}`, `- URL: ${s.URL}`, `- Site query: \`${siteQuery(s.URL)}\``);
  const rss = s.RSS?.trim();
  if (rss) out.push(`- RSS: ${rss}`);
  const topicFilter = s.topic_filter?.trim();
  if (topicFilter) out.push(`- Topic filter: ${topicFilter}`);
  if (isUseMelhorSource(s)) out.push(`- Use Melhor: sim`); // #1899
  out.push("");
}

writeFileSync(OUT, lines.join("\n"), "utf8");
console.log(`Wrote ${data.length} sources to ${OUT}`);
