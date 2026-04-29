/**
 * merge-local-pending.ts (#325)
 *
 * Injeta edições locais aprovadas-mas-não-publicadas no `context/past-editions.md`
 * para evitar que suas URLs vazem pra edição atual via dedup.
 *
 * Problema: `refresh-dedup-runner` só vê posts `published` no Beehiiv. Edições
 * aprovadas localmente (Stage 1 completo) mas ainda em rascunho no Beehiiv
 * ficam invisíveis ao dedup → URLs repetem em edições consecutivas.
 *
 * Uso:
 *   npx tsx scripts/merge-local-pending.ts \
 *     --current 260429 \
 *     --editions-dir data/editions/ \
 *     --window-days 5 \
 *     --past-raw data/past-editions-raw.json
 *
 * O script NÃO modifica `data/past-editions-raw.json` (fonte canônica do Beehiiv).
 * Apenas faz append de seções `## YYYY-MM-DD` em `context/past-editions.md`
 * pra edições pending, com flag `(pending_publish)` no título pra distinguir.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const MD_PATH = resolve(ROOT, "context/past-editions.md");

interface ApprovedJson {
  highlights?: Array<{ url?: string; article?: { url?: string } }>;
  runners_up?: Array<{ url?: string; article?: { url?: string } }>;
  lancamento?: Array<{ url?: string }>;
  pesquisa?: Array<{ url?: string }>;
  noticias?: Array<{ url?: string }>;
  tutorial?: Array<{ url?: string }>;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function aammddToIso(yymmdd: string): string {
  return `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

function extractUrlsFromApproved(approvedPath: string): string[] {
  if (!existsSync(approvedPath)) return [];
  let parsed: ApprovedJson;
  try {
    parsed = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
  } catch {
    return [];
  }
  const urls = new Set<string>();
  for (const a of parsed.lancamento ?? []) if (a.url) urls.add(a.url);
  for (const a of parsed.pesquisa ?? []) if (a.url) urls.add(a.url);
  for (const a of parsed.noticias ?? []) if (a.url) urls.add(a.url);
  for (const a of parsed.tutorial ?? []) if (a.url) urls.add(a.url);
  for (const h of parsed.highlights ?? []) {
    const url = h.url ?? h.article?.url;
    if (url) urls.add(url);
  }
  for (const h of parsed.runners_up ?? []) {
    const url = h.url ?? h.article?.url;
    if (url) urls.add(url);
  }
  return [...urls];
}

function isPublished(editionDir: string): boolean {
  const publishedPath = join(editionDir, "05-published.json");
  if (!existsSync(publishedPath)) return false;
  try {
    const data = JSON.parse(readFileSync(publishedPath, "utf8")) as { status?: string };
    return data.status === "published";
  } catch {
    return false;
  }
}

function isAlreadyInMd(md: string, isoDate: string): boolean {
  return md.includes(`## ${isoDate}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const current = args["current"] ?? "";
  const editionsDir = resolve(ROOT, args["editions-dir"] ?? "data/editions/");
  const windowDays = parseInt(args["window-days"] ?? "5", 10);

  if (!current) {
    console.error("Uso: merge-local-pending.ts --current AAMMDD [--editions-dir data/editions/] [--window-days 5]");
    process.exit(1);
  }

  const currentIso = aammddToIso(current);
  const cutoffMs = new Date(currentIso).getTime() - windowDays * 24 * 60 * 60 * 1000;

  // Carregar past-editions.md atual
  let md = "";
  if (existsSync(MD_PATH)) {
    md = readFileSync(MD_PATH, "utf8");
  }

  // Listar pastas de edições
  let editionDirs: string[] = [];
  try {
    editionDirs = readdirSync(editionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{6}$/.test(d.name))
      .map((d) => d.name);
  } catch {
    // diretório não existe ainda — normal em primeiros runs
    console.log(JSON.stringify({ pending_found: 0, injected: 0 }));
    return;
  }

  const pendingEditions: Array<{ yymmdd: string; iso: string; urls: string[]; daysAgo: number }> = [];

  for (const yymmdd of editionDirs) {
    if (yymmdd === current) continue; // pular edição atual

    const editionIso = aammddToIso(yymmdd);
    const editionMs = new Date(editionIso).getTime();
    if (editionMs < cutoffMs) continue; // fora da janela
    if (editionMs >= new Date(currentIso).getTime()) continue; // futura

    const editionDir = join(editionsDir, yymmdd);
    const approvedPath = join(editionDir, "_internal", "01-approved.json");

    if (!existsSync(approvedPath)) continue; // stage 1 não completou
    if (isPublished(editionDir)) continue; // já publicada no Beehiiv — dedup-runner já cobre

    const urls = extractUrlsFromApproved(approvedPath);
    if (urls.length === 0) continue;

    const daysAgo = Math.round((new Date(currentIso).getTime() - editionMs) / (24 * 60 * 60 * 1000));
    pendingEditions.push({ yymmdd, iso: editionIso, urls, daysAgo });
  }

  if (pendingEditions.length === 0) {
    console.log(JSON.stringify({ pending_found: 0, injected: 0 }));
    return;
  }

  // Alertar sobre pending há > 2 dias
  const stale = pendingEditions.filter((e) => e.daysAgo > 2);
  for (const e of stale) {
    console.error(
      `🟡 Edição ${e.yymmdd} aprovada local há ${e.daysAgo} dia(s) mas ainda draft no Beehiiv.\n` +
      `   ${e.urls.length} URLs bloqueadas no dedup de hoje. Considere publicar antes de prosseguir.`
    );
  }

  // Injetar no past-editions.md seções pending que ainda não estão lá
  let injected = 0;
  const appendLines: string[] = [];

  for (const e of pendingEditions) {
    if (isAlreadyInMd(md, e.iso)) continue; // já existe (de um run anterior)

    appendLines.push(
      `## ${e.iso} — (pending_publish — edição ${e.yymmdd} aprovada mas não publicada no Beehiiv)`,
      "",
      "Links usados:",
      ...e.urls.map((u) => `- ${u}`),
      "",
      "---",
      "",
    );
    injected++;
  }

  if (appendLines.length > 0) {
    // Appenda ao final do MD sem alterar o conteúdo existente
    const separator = md.endsWith("\n") ? "" : "\n";
    writeFileSync(MD_PATH, md + separator + appendLines.join("\n"), "utf8");
  }

  console.log(
    JSON.stringify({
      pending_found: pendingEditions.length,
      injected,
      editions: pendingEditions.map((e) => ({
        yymmdd: e.yymmdd,
        days_ago: e.daysAgo,
        url_count: e.urls.length,
      })),
    })
  );
}

main();
