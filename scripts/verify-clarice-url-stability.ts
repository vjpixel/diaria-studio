/**
 * verify-clarice-url-stability.ts (#873)
 *
 * Compara as URLs em duas versões de um MD da newsletter (pré-Clarice
 * vs pós-Clarice/pós-humanize) e verifica que nenhuma URL na seção
 * LANÇAMENTOS foi alterada por Clarice. URL "limpa" pelo Clarice (ex:
 * remoção de query params, normalização de path, trailing slash) é
 * detectada como mudança e reportada.
 *
 * Para LANÇAMENTOS, qualquer alteração é tratada como erro fatal — a
 * regra "LANÇAMENTOS só com link oficial" (#160) depende de match
 * exato com whitelist; uma URL "normalizada" pode passar a não bater
 * mais e quebrar a validação.
 *
 * Para outras seções (PESQUISAS, NOTÍCIAS), URLs adicionadas/removidas
 * geram apenas warning (informativo, exit 0).
 *
 * Uso:
 *   npx tsx scripts/verify-clarice-url-stability.ts \
 *     --pre <pre-clarice.md> --post <reviewed.md>
 *
 * Exit codes:
 *   0  Todas URLs em LANÇAMENTOS estáveis (warnings em outras seções
 *      são informativos)
 *   1  URL em LANÇAMENTOS mudou — diff impresso em stderr
 *   2  Erro de leitura/argumento
 *
 * Output JSON em stdout:
 *   {
 *     status: "ok" | "error",
 *     lancamento_changes: [{ before, after }],
 *     other_changes: [{ section, kind: "added"|"removed", url }]
 *   }
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type Section = "LANCAMENTOS" | "PESQUISAS" | "NOTICIAS" | "OUTRAS";

const URL_RE = /https?:\/\/\S+/g;

// List item line — bullet marker (`-`, `*`, `+`) or numbered (`1.`, `2.`).
// URLs only count when they appear in a list item; URLs in narrative
// paragraphs are intentionally ignored to avoid false positives when
// the humanizer reorders prose around URLs.
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+/;

// Headers — accept "## Header" (Stage 1) or plain caps (Stage 2).
const SECTION_PATTERNS: Array<{ section: Section; re: RegExp }> = [
  { section: "LANCAMENTOS", re: /^(?:##\s+)?lan[çc]amentos\s*$/i },
  { section: "PESQUISAS", re: /^(?:##\s+)?pesquisas\s*$/i },
  { section: "NOTICIAS", re: /^(?:##\s+)?(?:outras\s+)?not[íi]cias\s*$/i },
];

const SECTION_BREAK_RE = /^---\s*$/;

function trimUrl(url: string): string {
  return url.replace(/[).,;]+$/, "");
}

function detectSection(line: string): Section | null {
  const trimmed = line.trim();
  for (const { section, re } of SECTION_PATTERNS) {
    if (re.test(trimmed)) return section;
  }
  return null;
}

function isSectionBoundary(line: string): boolean {
  const trimmed = line.trim();
  if (SECTION_BREAK_RE.test(trimmed)) return true;
  // Plain-caps header (>5 chars, e.g. "DESTAQUE 1") signals section change too.
  const isPlainCaps = /^[A-ZÇÃÕÁÉÍÓÚÊÔ ]+$/.test(trimmed) && trimmed.length > 5;
  const isMdHeader = /^##\s+\S/.test(trimmed);
  return isPlainCaps || isMdHeader;
}

/**
 * Extrai URLs de cada seção do MD, dedupadas por URL string.
 * Retorna mapa section -> URLs[] na ordem em que aparecem.
 */
export function extractUrlsBySection(text: string): Record<Section, string[]> {
  const lines = text.split("\n");
  const out: Record<Section, string[]> = {
    LANCAMENTOS: [],
    PESQUISAS: [],
    NOTICIAS: [],
    OUTRAS: [],
  };
  const seen: Record<Section, Set<string>> = {
    LANCAMENTOS: new Set(),
    PESQUISAS: new Set(),
    NOTICIAS: new Set(),
    OUTRAS: new Set(),
  };
  let current: Section = "OUTRAS";

  for (const line of lines) {
    const detected = detectSection(line);
    if (detected) {
      current = detected;
      continue;
    }
    // A header for one of the known sections always sets `current`. Any
    // other section boundary (---, plain caps that's not a known section,
    // or a markdown ## header that's not a known section) resets to OUTRAS.
    if (isSectionBoundary(line)) {
      current = "OUTRAS";
      continue;
    }
    // Only extract URLs from list-item lines. URLs embedded in narrative
    // paragraphs are ignored — Clarice/humanizer reorder prose freely
    // and that motion would otherwise produce false-positive add/remove
    // diffs across sections (#889 review P2).
    if (!LIST_ITEM_RE.test(line)) continue;
    const matches = line.matchAll(URL_RE);
    for (const m of matches) {
      const url = trimUrl(m[0]);
      if (!seen[current].has(url)) {
        seen[current].add(url);
        out[current].push(url);
      }
    }
  }

  return out;
}

export interface UrlStabilityResult {
  status: "ok" | "error";
  lancamento_changes: Array<{ before: string; after: string }>;
  other_changes: Array<{
    section: Exclude<Section, "LANCAMENTOS">;
    kind: "added" | "removed";
    url: string;
  }>;
}

/**
 * Compara URLs pre/post na seção LANÇAMENTOS por posição (i-ésima URL
 * pre vs i-ésima URL post). Se diferente, é uma "alteração in-place"
 * (ex: trailing slash, remoção de query) — fatal.
 *
 * URLs adicionadas/removidas em LANÇAMENTOS também são fatais (Clarice
 * não deveria mexer em URLs).
 *
 * URLs em outras seções: changes geram warnings (não fatais).
 */
export function compareUrls(
  pre: Record<Section, string[]>,
  post: Record<Section, string[]>,
): UrlStabilityResult {
  const lancamento_changes: UrlStabilityResult["lancamento_changes"] = [];
  const other_changes: UrlStabilityResult["other_changes"] = [];

  // LANÇAMENTOS: bucket-a-bucket comparison. Treat reorder as fine
  // (compare set membership). Anything different is fatal.
  const preLanc = pre.LANCAMENTOS;
  const postLanc = post.LANCAMENTOS;
  const preLancSet = new Set(preLanc);
  const postLancSet = new Set(postLanc);

  // Find URLs that disappeared and matching ones that appeared.
  const removedFromLanc = preLanc.filter((u) => !postLancSet.has(u));
  const addedToLanc = postLanc.filter((u) => !preLancSet.has(u));

  // Pair removed/added by position to produce explicit before/after diffs
  // (typical Clarice corruption: same slot, different normalized URL).
  const pairCount = Math.min(removedFromLanc.length, addedToLanc.length);
  for (let i = 0; i < pairCount; i++) {
    lancamento_changes.push({ before: removedFromLanc[i], after: addedToLanc[i] });
  }
  // Any leftover removed-only or added-only entries also count as fatal.
  for (let i = pairCount; i < removedFromLanc.length; i++) {
    lancamento_changes.push({ before: removedFromLanc[i], after: "" });
  }
  for (let i = pairCount; i < addedToLanc.length; i++) {
    lancamento_changes.push({ before: "", after: addedToLanc[i] });
  }

  // Outras seções: só warnings.
  for (const section of ["PESQUISAS", "NOTICIAS", "OUTRAS"] as const) {
    const preSet = new Set(pre[section]);
    const postSet = new Set(post[section]);
    for (const url of pre[section]) {
      if (!postSet.has(url)) {
        other_changes.push({ section, kind: "removed", url });
      }
    }
    for (const url of post[section]) {
      if (!preSet.has(url)) {
        other_changes.push({ section, kind: "added", url });
      }
    }
  }

  return {
    status: lancamento_changes.length === 0 ? "ok" : "error",
    lancamento_changes,
    other_changes,
  };
}

export function verifyStability(preText: string, postText: string): UrlStabilityResult {
  return compareUrls(extractUrlsBySection(preText), extractUrlsBySection(postText));
}

function parseArgs(argv: string[]): { pre?: string; post?: string } {
  const out: { pre?: string; post?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pre") out.pre = argv[++i];
    else if (argv[i] === "--post") out.post = argv[++i];
  }
  return out;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { pre, post } = parseArgs(process.argv.slice(2));
  if (!pre || !post) {
    console.error(
      "Uso: verify-clarice-url-stability.ts --pre <pre-clarice.md> --post <reviewed.md>",
    );
    process.exit(2);
  }
  const prePath = resolve(ROOT, pre);
  const postPath = resolve(ROOT, post);
  if (!existsSync(prePath)) {
    console.error(`Arquivo pré-Clarice não existe: ${prePath}`);
    process.exit(2);
  }
  if (!existsSync(postPath)) {
    console.error(`Arquivo pós-Clarice não existe: ${postPath}`);
    process.exit(2);
  }

  const preText = readFileSync(prePath, "utf8");
  const postText = readFileSync(postPath, "utf8");
  const result = verifyStability(preText, postText);

  console.log(JSON.stringify(result, null, 2));

  if (result.other_changes.length > 0) {
    console.error(
      `\n⚠ ${result.other_changes.length} URL(s) mudou em outras seções (informativo):`,
    );
    for (const c of result.other_changes) {
      console.error(`  ${c.section} [${c.kind}]: ${c.url}`);
    }
  }

  if (result.status === "error") {
    console.error(
      `\n❌ Clarice alterou ${result.lancamento_changes.length} URL(s) em LANÇAMENTOS — risco de quebrar #160 (link oficial).`,
    );
    for (const c of result.lancamento_changes) {
      if (c.before && c.after) {
        console.error(`  antes:  ${c.before}`);
        console.error(`  depois: ${c.after}`);
        console.error("");
      } else if (c.before) {
        console.error(`  removida: ${c.before}`);
      } else {
        console.error(`  adicionada: ${c.after}`);
      }
    }
    console.error(
      "Restaure as URLs originais em `02-reviewed.md` antes de prosseguir, ou aceite explicitamente como caso de borda.",
    );
    process.exit(1);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
