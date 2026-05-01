/**
 * sync-eai-used.ts (#369)
 *
 * Sincroniza `data/eia-used.json` a partir dos arquivos `_internal/01-eia-meta.json`
 * das edições locais. Garante que imagens já usadas — mesmo que o pipeline tenha
 * rodado em outra máquina ou o arquivo tenha sido apagado — sejam registradas
 * e não reusadas pelo eia-composer.
 *
 * Uso:
 *   npx tsx scripts/sync-eai-used.ts [--editions-dir data/editions/] [--dry-run]
 *
 * Output (stdout): JSON { scanned, added, already_present, skipped_no_meta }
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const EAI_USED_PATH = resolve(ROOT, "data", "eia-used.json");

interface EaiUsedEntry {
  edition_date: string;
  image_date: string;
  title: string;
  credit: string;
  url: string;
  used_at: string;
}

interface EaiMeta {
  edition: string;
  composed_at?: string;
  wikimedia?: {
    title?: string;
    image_url?: string;
    credit?: string;
    image_date_used?: string;
  };
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") {
      out["dry-run"] = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function loadEaiUsed(): EaiUsedEntry[] {
  if (!existsSync(EAI_USED_PATH)) return [];
  try {
    return JSON.parse(readFileSync(EAI_USED_PATH, "utf8")) as EaiUsedEntry[];
  } catch {
    return [];
  }
}

function isTitlePresent(entries: EaiUsedEntry[], title: string): boolean {
  const norm = title.toLowerCase().trim();
  return entries.some((e) => e.title.toLowerCase().trim() === norm);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const editionsDir = resolve(ROOT, (args["editions-dir"] as string) ?? "data/editions/");
  const dryRun = args["dry-run"] === true;

  let editionDirs: string[] = [];
  try {
    editionDirs = readdirSync(editionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{6}$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    console.log(JSON.stringify({ scanned: 0, added: 0, already_present: 0, skipped_no_meta: 0 }));
    return;
  }

  const existing = loadEaiUsed();
  const toAdd: EaiUsedEntry[] = [];

  let skipped = 0;
  let alreadyPresent = 0;

  for (const yymmdd of editionDirs) {
    const metaPath = join(editionsDir, yymmdd, "_internal", "01-eia-meta.json");
    if (!existsSync(metaPath)) {
      skipped++;
      continue;
    }

    let meta: EaiMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as EaiMeta;
    } catch {
      skipped++;
      continue;
    }

    const wiki = meta.wikimedia;
    if (!wiki?.title || !wiki?.image_date_used) {
      skipped++;
      continue;
    }

    const title = wiki.title;
    const allEntries = [...existing, ...toAdd];

    if (isTitlePresent(allEntries, title)) {
      alreadyPresent++;
      continue;
    }

    // Converter AAMMDD → ISO para edition_date
    const editionIso = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;

    toAdd.push({
      edition_date: editionIso,
      image_date: wiki.image_date_used,
      title,
      credit: wiki.credit ?? "",
      url: wiki.image_url ?? "",
      used_at: meta.composed_at ?? new Date().toISOString(),
    });
  }

  if (toAdd.length > 0 && !dryRun) {
    const updated = [...existing, ...toAdd];
    writeFileSync(EAI_USED_PATH, JSON.stringify(updated, null, 2) + "\n", "utf8");
  }

  const result = {
    scanned: editionDirs.length,
    added: toAdd.length,
    already_present: alreadyPresent,
    skipped_no_meta: skipped,
    dry_run: dryRun || undefined,
  };

  if (dryRun && toAdd.length > 0) {
    console.error(`[sync-eai-used] dry-run: ${toAdd.length} entradas seriam adicionadas:`);
    for (const e of toAdd) {
      console.error(`  + ${e.edition_date} — ${e.title} (${e.image_date})`);
    }
  }

  console.log(JSON.stringify(result));
}

main();
