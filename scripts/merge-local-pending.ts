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

export function aammddToIso(yymmdd: string): string {
  return `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

/**
 * Pure: decide se uma edição entra na janela de pending detection (#863).
 *
 * Regras:
 * - Janela ancorada em `anchorIso` (today UTC), não em `currentIso` (edition_date).
 *   Para test mode com edição futura, ancorar em today previne perda de pendings legítimos.
 * - Edição entra se: `cutoff <= editionDate < currentEdition`
 *   (não inclui a própria edição corrente nem futuras).
 *
 * Datas usam UTC midnight pra comparação consistente.
 */
export function isWithinPendingWindow(
  editionIso: string,
  currentIso: string,
  anchorIso: string,
  windowDays: number,
): boolean {
  const editionMs = new Date(editionIso + "T00:00:00Z").getTime();
  const cutoffMs = new Date(anchorIso + "T00:00:00Z").getTime() - windowDays * 24 * 60 * 60 * 1000;
  const currentMs = new Date(currentIso + "T00:00:00Z").getTime();
  if (editionMs < cutoffMs) return false; // fora da janela (anterior ao cutoff)
  if (editionMs >= currentMs) return false; // edição atual ou futura
  return true;
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
  // #863: anchor = data de execução (today), não edition_date. Alinha com
  // CLAUDE.md "Edição é sempre D+1" — a janela de pending é "últimos N dias
  // até hoje", não "últimos N dias até a edição". Para test mode com edição
  // futura, ancorar em today previne perda de pending legítimos.
  // Caller pode override via --anchor-iso. Default = today UTC.
  const anchorIso = args["anchor-iso"] ?? new Date().toISOString().split("T")[0];

  if (!current) {
    console.error("Uso: merge-local-pending.ts --current AAMMDD [--editions-dir data/editions/] [--window-days 5] [--anchor-iso YYYY-MM-DD]");
    process.exit(1);
  }

  const currentIso = aammddToIso(current);
  // Cutoff anchored em --anchor-iso (default today), não em current/edition.
  const cutoffMs = new Date(anchorIso + "T00:00:00Z").getTime() - windowDays * 24 * 60 * 60 * 1000;

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

    // #863: daysAgo computado contra anchor (today), não current (edition).
    // Stale check downstream alerta sobre pending há >2d, deve ser relativo
    // a "hoje" pra fazer sentido editorial.
    const anchorMs = new Date(anchorIso + "T00:00:00Z").getTime();
    const daysAgo = Math.round((anchorMs - editionMs) / (24 * 60 * 60 * 1000));
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

// Guard: roda main() só quando script é executado direto, não em import (testes).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
