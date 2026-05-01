import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_CSV = resolve(ROOT, "seed/sources.csv");
const OUT = resolve(ROOT, "context/sources.md");

type Source = { Nome: string; Tipo: string; URL: string; RSS?: string; topic_filter?: string };

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

function siteQuery(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname.replace(/\/$/, "");
    return path && path !== "/" ? `site:${host}${path}` : `site:${host}`;
  } catch {
    return `site:${url}`;
  }
}

const lines: string[] = [
  "# Fontes cadastradas — Diar.ia",
  "",
  `**Total:** ${data.length} fontes. Gerado de \`seed/sources.csv\` via \`npm run sync-sources\`.`,
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
  out.push("");
}

writeFileSync(OUT, lines.join("\n"), "utf8");
console.log(`Wrote ${data.length} sources to ${OUT}`);
