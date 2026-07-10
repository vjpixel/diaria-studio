/**
 * merge-local-pending.ts (#325)
 *
 * Injeta edições locais aprovadas-mas-não-publicadas no `data/past-editions.md`
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
 * Apenas faz append de seções `## YYYY-MM-DD` em `data/past-editions.md`
 * pra edições pending, com flag `(pending_publish)` no título pra distinguir.
 *
 * #3207: `--past-raw` é lido e usado como cross-check em `isPublished()` —
 * uma edição só é reportada como `pending_publish` se NÃO aparecer publicada
 * nem localmente (`_internal/05-published.json`) nem no raw (fonte Beehiiv
 * REST). Sem esse cross-check, uma edição publicada em outra sessão/máquina
 * (cujo `05-published.json` local nunca é escrito) gerava falso-positivo de
 * "pending" mesmo já publicada de verdade — ver incidente 260710.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractUrlsFromBuckets } from "./lib/approved-urls.ts"; // #1678
import { parseArgsSimple as parseArgs } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { aammddFromIso, type Post } from "./refresh-past-editions.ts"; // #3207

// #3024: fileURLToPath (não `.pathname` cru) — `.pathname` produz path
// malformado no Windows (ex: `C:\C:\Users\...`), quebrando qualquer resolve()
// subsequente baseado em ROOT (editionsDir, MD_PATH).
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MD_PATH = resolve(ROOT, "data/past-editions.md");
const DEFAULT_PAST_RAW_PATH = resolve(ROOT, "data/past-editions-raw.json");

interface ApprovedJson {
  highlights?: Array<{ url?: string; article?: { url?: string } }>;
  runners_up?: Array<{ url?: string; article?: { url?: string } }>;
  lancamento?: Array<{ url?: string }>;
  // #1629: buckets renomeados (pesquisa+noticias → radar, tutorial → use_melhor)
  radar?: Array<{ url?: string }>;
  use_melhor?: Array<{ url?: string }>;
  video?: Array<{ url?: string }>;
  // Legacy (parsear edições históricas pré-#1629)
  pesquisa?: Array<{ url?: string }>;
  noticias?: Array<{ url?: string }>;
  tutorial?: Array<{ url?: string }>;
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

export function extractUrlsFromApproved(approvedPath: string): string[] {
  if (!existsSync(approvedPath)) return [];
  let parsed: ApprovedJson;
  try {
    parsed = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
  } catch {
    return [];
  }
  // #1678: bucket-walk delegado ao helper compartilhado (single-source da lista
  // de buckets — a duplicação aqui vs refresh-past-editions causou o #1659).
  return extractUrlsFromBuckets(parsed);
}

function isPublishedLocally(editionDir: string): boolean {
  const publishedPath = join(editionDir, "05-published.json");
  if (!existsSync(publishedPath)) return false;
  try {
    const data = JSON.parse(readFileSync(publishedPath, "utf8")) as { status?: string };
    return data.status === "published";
  } catch {
    return false;
  }
}

/**
 * #3207: carrega `data/past-editions-raw.json` (fonte canônica do Beehiiv,
 * gerada por `refresh-past-editions.ts`) e retorna o Set de AAMMDD já
 * publicados. Matching key = `published_at` convertido pra AAMMDD via
 * `aammddFromIso` (mesma conversão timezone-aware `America/Sao_Paulo` usada
 * pelo resto do pipeline pra mapear posts Beehiiv → pasta de edição local —
 * reusar em vez de duplicar evita divergência tipo #1659).
 *
 * Fail-soft: arquivo ausente ou JSON inválido → Set vazio (script cai de
 * volta no comportamento local-only pré-#3207).
 */
export function loadPublishedAammddFromRaw(pastRawPath: string): Set<string> {
  if (!existsSync(pastRawPath)) return new Set();
  let posts: Post[];
  try {
    posts = JSON.parse(readFileSync(pastRawPath, "utf8")) as Post[];
  } catch {
    return new Set();
  }
  const published = new Set<string>();
  for (const p of posts) {
    if (!p?.published_at) continue;
    const yymmdd = aammddFromIso(p.published_at);
    if (yymmdd) published.add(yymmdd);
  }
  return published;
}

/**
 * #3207: uma edição é considerada publicada se OU o `05-published.json`
 * local disser `status: "published"`, OU ela já aparecer no
 * `past-editions-raw.json` (source-of-truth Beehiiv via REST). O segundo
 * caso cobre edições publicadas em outra sessão/máquina — o `05-published.json`
 * local nunca é escrito/sincronizado nesse cenário, então depender só dele
 * gera falso-positivo de "pending_publish" (#3207).
 */
export function isPublished(
  editionDir: string,
  yymmdd: string,
  publishedInRaw: Set<string>,
): boolean {
  if (publishedInRaw.has(yymmdd)) return true;
  return isPublishedLocally(editionDir);
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
  // #3207: --past-raw cross-check contra a fonte canônica do Beehiiv. Se
  // omitido, cai no default (mesmo path que refresh-past-editions.ts usa);
  // se o arquivo não existir, loadPublishedAammddFromRaw retorna Set vazio
  // e o comportamento é idêntico ao pré-#3207 (só local 05-published.json).
  const pastRawPath = args["past-raw"] ? resolve(ROOT, args["past-raw"]) : DEFAULT_PAST_RAW_PATH;

  if (!current) {
    console.error("Uso: merge-local-pending.ts --current AAMMDD [--editions-dir data/editions/] [--window-days 5] [--anchor-iso YYYY-MM-DD] [--past-raw data/past-editions-raw.json]");
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

  // Listar pastas de edições (#2463: ambos os layouts — flat legado + nested novo)
  if (!existsSync(editionsDir)) {
    // diretório não existe ainda — normal em primeiros runs
    console.log(JSON.stringify({ pending_found: 0, injected: 0 }));
    return;
  }
  const editionDirsByAammdd = enumerateEditionDirs(editionsDir);
  const editionDirs = [...editionDirsByAammdd.keys()];
  const publishedInRaw = loadPublishedAammddFromRaw(pastRawPath); // #3207

  const pendingEditions: Array<{ yymmdd: string; iso: string; urls: string[]; daysAgo: number }> = [];

  for (const yymmdd of editionDirs) {
    if (yymmdd === current) continue; // pular edição atual

    const editionIso = aammddToIso(yymmdd);
    const editionMs = new Date(editionIso).getTime();
    if (editionMs < cutoffMs) continue; // fora da janela
    if (editionMs >= new Date(currentIso).getTime()) continue; // futura

    const editionDir = editionDirsByAammdd.get(yymmdd)!;
    const approvedPath = join(editionDir, "_internal", "01-approved.json");

    if (!existsSync(approvedPath)) continue; // stage 1 não completou
    if (isPublished(editionDir, yymmdd, publishedInRaw)) continue; // já publicada no Beehiiv (local ou raw #3207) — dedup-runner já cobre

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
