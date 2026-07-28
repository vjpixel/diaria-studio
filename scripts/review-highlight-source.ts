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
 * #4135 item 2: além do sinal de `detectLaunchCandidate` (verbo de lançamento +
 * empresa + domínio não-oficial), destaques cujo `bucket` já é `lancamento`
 * (classificação prévia do categorizer) também passam por
 * `detectDomainMismatchCandidate` — mesma checagem de empresa+domínio, mas
 * SEM exigir verbo. O scoping por bucket é a mitigação de falso-positivo
 * (análise/opinião não cai em `lancamento`); ver launch-detect.ts para a
 * nota de calibragem completa. `match_type` no resultado distingue os dois
 * mecanismos ("verb" vs "domain_mismatch").
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
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { detectLaunchCandidate, detectDomainMismatchCandidate } from "./lib/launch-detect.ts";
import { isOfficialLancamentoUrl } from "./categorize.ts";

export interface HighlightArticle {
  url?: string;
  title?: string;
  summary?: string | null;
  [k: string]: unknown;
}

export interface HighlightEntry {
  /** Categoria atribuída pelo categorizer (#4135 item 2 checa "lancamento"). */
  bucket?: string;
  article?: HighlightArticle;
  [k: string]: unknown;
}

export interface FlaggedHighlight {
  url: string;
  title?: string;
  matched_keyword?: string;
  matched_company?: string;
  suggested_domain?: string;
  /** #4135 item 2: qual mecanismo flagou — verbo de lançamento ou só domínio. */
  match_type: "verb" | "domain_mismatch";
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
    const title = typeof a.title === "string" ? a.title : undefined;

    const det = detectLaunchCandidate({ title: a.title, summary: a.summary, url });
    if (det.is_candidate && !isOfficialLancamentoUrl(url)) {
      flagged.push({
        url,
        title,
        matched_keyword: det.matched_keyword,
        matched_company: det.matched_company,
        suggested_domain: det.suggested_domain,
        match_type: "verb",
      });
      continue;
    }

    // #4135 item 2: sem verbo de lançamento, mas o categorizer já classificou
    // este destaque como `lancamento` — checa só empresa+domínio (scoping por
    // bucket é a mitigação de falso-positivo, ver launch-detect.ts).
    if (h?.bucket === "lancamento") {
      const dm = detectDomainMismatchCandidate({ title: a.title, summary: a.summary, url });
      if (dm.is_candidate && !isOfficialLancamentoUrl(url)) {
        flagged.push({
          url,
          title,
          matched_company: dm.matched_company,
          suggested_domain: dm.suggested_domain,
          match_type: "domain_mismatch",
        });
      }
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
      const mechanism = f.match_type === "domain_mismatch" ? " [sem verbo, bucket=lancamento, #4135]" : "";
      console.error(`  ${f.url}${titleHint}${sug}${mechanism}`);
    }
    console.error(
      "Revise no gate: lançamento deve linkar a newsroom/site oficial, não cobertura de terceiro (#160 estendido a destaques).",
    );
  }
  // Warn-only: nunca bloqueia (exit 0).
}

if (isMainModule(import.meta.url)) {
  main();
}
