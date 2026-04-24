/**
 * validate-feeds.ts
 *
 * Itera sobre fontes em `seed/sources.csv` que têm coluna `RSS` preenchida
 * e valida cada feed via HTTP real. Reporta quais funcionam e quais falham.
 *
 * Uso:
 *   npm run validate-feeds
 *
 * Requer acesso à internet. Timeout de 20s por feed. Faz em série pra não
 * sobrecarregar publishers pequenos.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { fetchRss } from "./fetch-rss.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_CSV = resolve(ROOT, "seed/sources.csv");

interface SourceRow {
  Nome: string;
  Tipo: string;
  URL: string;
  RSS?: string;
}

async function main() {
  const csv = readFileSync(SOURCES_CSV, "utf8");
  const { data } = Papa.parse<SourceRow>(csv, { header: true, skipEmptyLines: true });
  const withRss = data.filter((r) => r.RSS && r.RSS.trim());

  if (withRss.length === 0) {
    console.log("Nenhuma fonte com coluna RSS preenchida. Edite seed/sources.csv e rode de novo.");
    return;
  }

  console.log(`Validando ${withRss.length} feeds...\n`);

  const ok: Array<{ source: string; url: string; count: number }> = [];
  const fail: Array<{ source: string; url: string; error: string }> = [];

  for (const row of withRss) {
    const url = row.RSS!.trim();
    const result = await fetchRss({ url, sourceName: row.Nome, days: 30 });
    if (result.error) {
      console.log(`✗ ${row.Nome}\n  ${url}\n  ${result.error}\n`);
      fail.push({ source: row.Nome, url, error: result.error });
    } else if (result.articles.length === 0) {
      console.log(`⚠ ${row.Nome}\n  ${url}\n  feed válido mas vazio\n`);
      fail.push({ source: row.Nome, url, error: "feed vazio" });
    } else {
      console.log(`✓ ${row.Nome} (${result.articles.length} artigos)\n  ${url}\n`);
      ok.push({ source: row.Nome, url, count: result.articles.length });
    }
  }

  console.log("=".repeat(60));
  console.log(`OK: ${ok.length} / ${withRss.length}`);
  console.log(`FAIL: ${fail.length} / ${withRss.length}`);

  if (fail.length > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
