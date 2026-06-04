/**
 * review-highlight-source.ts (#1699)
 *
 * Guard determinístico: avisa no gate quando um DESTAQUE é um lançamento mas
 * usa URL de cobertura de imprensa em vez da fonte primária (newsroom/site
 * oficial). A regra #160 só cobre a SEÇÃO LANÇAMENTOS — destaques que SÃO sobre
 * lançamentos escapavam (caso 260602: o RTX Spark da NVIDIA virou destaque com
 * link da Canaltech; o editor corrigiu manualmente pro nvidianews.nvidia.com).
 *
 * WARN-ONLY: não bloqueia nem reescreve a URL (isso é a busca ativa do #1699,
 * fase 2). Só surfa o suspeito com a fonte primária sugerida (suggested_domain),
 * pra o editor trocar no gate. É 'sinalizar melhor', não 'buscar ativamente'.
 *
 * Uso:
 *   npx tsx scripts/review-highlight-source.ts --approved data/editions/AAMMDD/_internal/01-approved.json
 *
 * Output JSON: { total, flagged: [{ url, title?, matched_keyword?, matched_company?, suggested_domain? }] }
 * Exit code: sempre 0 (warn-only). O orchestrator surfa `flagged[]` no gate.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { detectLaunchCandidate } from "./lib/launch-detect.ts";
import { isOfficialLancamentoUrl } from "./categorize.ts";

export interface HighlightArticle {
  url?: string;
  title?: string;
  summary?: string | null;
  [k: string]: unknown;
}

export interface HighlightEntry {
  article?: HighlightArticle;
  [k: string]: unknown;
}

export interface FlaggedHighlight {
  url: string;
  title?: string;
  matched_keyword?: string;
  matched_company?: string;
  suggested_domain?: string;
}

export interface ReviewResult {
  total: number;
  flagged: FlaggedHighlight[];
}

/**
 * Flag = destaque que é launch-candidate (verbo de anúncio + empresa conhecida)
 * E cujo URL NÃO é domínio oficial de lançamento. Pura e testável.
 */
export function reviewHighlightSource(highlights: HighlightEntry[]): ReviewResult {
  const flagged: FlaggedHighlight[] = [];
  for (const h of highlights) {
    // tolera tanto o shape com wrapper { article } quanto o artigo direto.
    const a: HighlightArticle = (h?.article ?? h) as HighlightArticle;
    const url = typeof a?.url === "string" ? a.url : "";
    if (!url) continue;
    const det = detectLaunchCandidate({ title: a.title, summary: a.summary, url });
    if (det.is_candidate && !isOfficialLancamentoUrl(url)) {
      flagged.push({
        url,
        title: typeof a.title === "string" ? a.title : undefined,
        matched_keyword: det.matched_keyword,
        matched_company: det.matched_company,
        suggested_domain: det.suggested_domain,
      });
    }
  }
  return { total: highlights.length, flagged };
}

interface ApprovedShape {
  highlights?: HighlightEntry[];
  [k: string]: unknown;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseCliArgs(process.argv.slice(2));
  const approvedArg = values["approved"];
  if (!approvedArg) {
    console.error("Uso: review-highlight-source.ts --approved <01-approved.json>");
    process.exit(2);
  }
  const approvedPath = resolve(ROOT, approvedArg);
  if (!existsSync(approvedPath)) {
    console.error(`Arquivo não existe: ${approvedPath}`);
    process.exit(2);
  }
  let approved: ApprovedShape;
  try {
    approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedShape;
  } catch (err) {
    console.error(`Falha ao parsear ${approvedPath}: ${(err as Error).message}`);
    process.exit(2);
  }

  const highlights = Array.isArray(approved.highlights) ? approved.highlights : [];
  const result = reviewHighlightSource(highlights);
  console.log(JSON.stringify(result, null, 2));

  if (result.flagged.length > 0) {
    console.error(
      `\n⚠️ ${result.flagged.length} destaque(s) parece(m) lançamento com URL de cobertura de imprensa, não fonte primária (#1699):`,
    );
    for (const f of result.flagged) {
      const titleHint = f.title ? ` ("${f.title.slice(0, 60)}")` : "";
      const sug = f.suggested_domain ? ` → fonte oficial provável: ${f.suggested_domain}` : "";
      console.error(`  ${f.url}${titleHint}${sug}`);
    }
    console.error(
      "Revise no gate: lançamento deve linkar a newsroom/site oficial, não cobertura de terceiro (#160 estendido a destaques).",
    );
  }
  // Warn-only: nunca bloqueia (exit 0).
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
