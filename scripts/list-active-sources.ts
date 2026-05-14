#!/usr/bin/env tsx
/**
 * list-active-sources.ts (#1270)
 *
 * Parsea `context/sources.md` (formato canônico gerado por
 * `npm run sync-sources` a partir de `seed/sources.csv`) e emite a lista
 * de fontes em formatos compatíveis com os scripts downstream.
 *
 * Uso:
 *   # Lista todas as fontes RSS pra fetch-rss-batch.ts:
 *   npx tsx scripts/list-active-sources.ts --format json --rss-only \
 *     --out data/editions/{AAMMDD}/_internal/rss-batch.json
 *
 *   # Lista todas as fontes (com ou sem RSS) em texto:
 *   npx tsx scripts/list-active-sources.ts --format text
 *
 * Razão (#1270): orchestrator stage-1 dependia de workaround inline em
 * .cjs ad-hoc pra construir rss-batch.json — frágil e não-reproduzível
 * entre sessões. Centraliza o parser num único script reusável.
 *
 * Schema de output (--format json):
 *   [
 *     { "name": "Canaltech (IA)", "rss": "https://...", "filter": "AI,IA,..." },
 *     { "name": "OpenAI", "rss": "https://openai.com/news/rss.xml" },
 *     ...
 *   ]
 *
 * Compatível direto com `fetch-rss-batch.ts --sources <out>`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runMain } from "./lib/exit-handler.ts";

export interface Source {
  name: string;
  url?: string;
  site_query?: string;
  rss?: string;
  filter?: string;
}

/**
 * Parse `context/sources.md` extraindo cada fonte. Formato:
 *
 *   ### {name}
 *   - URL: {url}
 *   - Site query: `site:{query}`
 *   - RSS: {rss_url}
 *   - Topic filter: term1,term2,...
 *
 * Seções podem aparecer agrupadas em h2 (`## Brasil`, `## Primária`, etc.).
 * H2 é ignorado — só h3 (`###`) delimita fontes.
 */
export function parseSourcesMd(md: string): Source[] {
  const lines = md.split(/\r?\n/);
  const sources: Source[] = [];
  let current: Source | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Fonte nova
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      if (current) sources.push(current);
      current = { name: h3[1].trim() };
      continue;
    }

    if (!current) continue;

    // Bullets dentro da seção atual
    const url = line.match(/^-\s+URL:\s*(.+?)\s*$/i);
    if (url) {
      current.url = url[1].trim();
      continue;
    }

    const site = line.match(/^-\s+Site query:\s*`?([^`]+)`?\s*$/i);
    if (site) {
      current.site_query = site[1].trim();
      continue;
    }

    const rss = line.match(/^-\s+RSS:\s*(.+?)\s*$/i);
    if (rss) {
      current.rss = rss[1].trim();
      continue;
    }

    const filter = line.match(/^-\s+Topic filter:\s*(.+?)\s*$/i);
    if (filter) {
      current.filter = filter[1].trim();
      continue;
    }
  }

  if (current) sources.push(current);
  return sources;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const format = (args.format as string) ?? "json";
  const rssOnly = args["rss-only"] === true;
  const outPath = args.out as string | undefined;
  const sourcesMdPath = (args.sources as string) ?? "context/sources.md";

  const md = readFileSync(resolve(process.cwd(), sourcesMdPath), "utf8");
  let sources = parseSourcesMd(md);

  if (rssOnly) sources = sources.filter((s) => !!s.rss);

  // Shape compatível com fetch-rss-batch.ts quando --rss-only:
  // remove campos não-RSS pra reduzir noise.
  const formatted = rssOnly
    ? sources.map((s) => {
        const { name, rss, filter } = s;
        return filter ? { name, rss, filter } : { name, rss };
      })
    : sources;

  if (format === "json") {
    const json = JSON.stringify(formatted, null, 2);
    if (outPath) {
      writeFileSync(resolve(process.cwd(), outPath), json, "utf8");
      console.error(
        `[list-active-sources] ${formatted.length} fonte(s)${rssOnly ? " (RSS-only)" : ""} → ${outPath}`,
      );
    } else {
      process.stdout.write(json + "\n");
    }
  } else if (format === "text") {
    for (const s of sources) {
      const hasRss = s.rss ? " [RSS]" : "";
      process.stdout.write(`${s.name}${hasRss}\n`);
    }
    console.error(
      `[list-active-sources] ${sources.length} fonte(s) total, ${sources.filter((x) => x.rss).length} com RSS`,
    );
  } else {
    console.error(`Format desconhecido: ${format}. Use 'json' ou 'text'.`);
    process.exit(1);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  runMain(main);
}
