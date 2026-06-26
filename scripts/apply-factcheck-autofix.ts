/**
 * apply-factcheck-autofix.ts (#2598)
 *
 * Pré-aplica correções determinísticas de claims DIVERGENT do fact-checker em
 * `02-reviewed.md` e `03-social.md` ANTES de montar o gate do Stage 4.
 *
 * Regras de aplicação:
 *   1. Só claims com `verdict === "DIVERGENT"` E `suggested_fix` presente.
 *   2. Nunca auto-corrigir claims do tipo `superlative` (são de ineditismo/tom,
 *      não divergências factuais determísticas).
 *   3. NOT_FOUND_IN_SOURCE nunca recebe suggested_fix → não é processado.
 *   4. Pular claim cujo `destaque` bate com o destaque do `intentional_error`
 *      declarado no frontmatter de `02-reviewed.md` (não tocar erro intencional).
 *   5. Substituição é cirúrgica: substitui a primeira ocorrência de `claim.text`
 *      nos arquivos relevantes (sources: newsletter, social, ou ambos).
 *
 * Output:
 *   `_internal/fact-check-autofix.json` — log de cada correção aplicada/pulada.
 *
 * Uso:
 *   npx tsx scripts/apply-factcheck-autofix.ts --edition-dir data/editions/AAMMDD/
 *   npx tsx scripts/apply-factcheck-autofix.ts --edition-dir data/editions/AAMMDD/ --dry-run
 *
 * Exit codes:
 *   0 — sucesso (inclui o caso onde não há nada a corrigir)
 *   1 — erro de args ou arquivo ausente
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { FactClaim, FactCheckResult } from "./run-fact-checker.ts";
import { extractFrontmatter } from "./lib/lint-checks/intentional-error.ts";
import { destaqueFromLocation } from "./lib/intentional-errors.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutofixStatus =
  | "applied"       // substituição feita
  | "skipped_intentional_error"  // claim pertence ao destaque do erro intencional
  | "skipped_superlative"        // claim_type superlative — nunca auto-fix
  | "skipped_no_fix"             // sem suggested_fix no claim
  | "skipped_text_not_found";    // texto do claim não encontrado nos arquivos

export interface AutofixEntry {
  destaque: number;
  claim_type: FactClaim["claim_type"];
  text: string;
  suggested_fix: string | undefined;
  sources: Array<"newsletter" | "social">;
  status: AutofixStatus;
  /** Arquivo(s) modificado(s), preenchido quando status="applied" */
  files_modified?: string[];
  note?: string;
}

export interface AutofixResult {
  edition: string;
  applied_at: string;
  dry_run: boolean;
  intentional_error_destaque: number | string | null;
  entries: AutofixEntry[];
  summary: {
    total_divergent: number;
    applied: number;
    skipped: number;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — exportados para teste
// ---------------------------------------------------------------------------

/**
 * Extrai o destaque do `intentional_error` do frontmatter de `02-reviewed.md`.
 * Retorna null se não houver frontmatter ou intentional_error declarado.
 */
export function extractIntentionalErrorDestaque(md: string): number | string | null {
  const fm = extractFrontmatter(md);
  if (!fm) return null;
  if (!/intentional_error\s*:/i.test(fm)) return null;

  // Aceitar `intentional_error: none` (#2016)
  if (/intentional_error\s*:\s*(none|null)\s*(\n|$)/i.test(fm)) return null;

  // Extrair location do bloco mapping
  const locationMatch = fm.match(/location\s*:\s*(.+)/);
  if (!locationMatch) return null;

  const location = locationMatch[1].trim();
  const destaque = destaqueFromLocation(location);
  return destaque !== "" ? destaque : null;
}

/**
 * Determina se um claim deve ser pulado por ser do destaque do erro intencional.
 * Match é feito pela igualdade numérica do destaque (normalizado para número).
 */
export function isIntentionalErrorClaim(
  claim: FactClaim,
  intentionalDestaque: number | string | null,
): boolean {
  if (intentionalDestaque === null) return false;
  const claimStr = String(claim.destaque);
  const intentionalStr = String(intentionalDestaque);
  return claimStr === intentionalStr;
}

/**
 * Aplica substituição cirúrgica de `oldText` por `newText` em `content`.
 * Substitui apenas a primeira ocorrência — conservador para evitar side effects.
 * Retorna { changed: boolean; content: string }.
 */
export function applyTextSubstitution(
  content: string,
  oldText: string,
  newText: string,
): { changed: boolean; content: string } {
  const idx = content.indexOf(oldText);
  if (idx === -1) return { changed: false, content };
  const updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
  return { changed: true, content: updated };
}

/**
 * Processa a lista de claims e determina ação para cada um.
 * Pure: não lê/escreve arquivos — lógica de decisão testável.
 *
 * @param claims - Lista de claims do fact-check.json
 * @param intentionalDestaque - Destaque do erro intencional (null se ausente)
 * @returns Array de AutofixEntry com status e reason para cada claim DIVERGENT
 */
export function planAutofixes(
  claims: FactClaim[],
  intentionalDestaque: number | string | null,
): AutofixEntry[] {
  const divergent = claims.filter((c) => c.verdict === "DIVERGENT");
  return divergent.map((c): AutofixEntry => {
    // Regra 2: superlativos nunca recebem auto-fix (são de tom)
    if (c.claim_type === "superlative") {
      return {
        destaque: c.destaque,
        claim_type: c.claim_type,
        text: c.text,
        suggested_fix: c.suggested_fix,
        sources: c.sources,
        status: "skipped_superlative",
        note: "Superlativos de ineditismo não recebem auto-fix — revisão editorial manual.",
      };
    }

    // Regra 3/4 (combinadas): sem suggested_fix = não há correção disponível
    if (!c.suggested_fix) {
      return {
        destaque: c.destaque,
        claim_type: c.claim_type,
        text: c.text,
        suggested_fix: undefined,
        sources: c.sources,
        status: "skipped_no_fix",
        note: "Sem suggested_fix — fact-checker não identificou correção determinística.",
      };
    }

    // Regra 4: pular se o claim pertence ao destaque do erro intencional
    if (isIntentionalErrorClaim(c, intentionalDestaque)) {
      return {
        destaque: c.destaque,
        claim_type: c.claim_type,
        text: c.text,
        suggested_fix: c.suggested_fix,
        sources: c.sources,
        status: "skipped_intentional_error",
        note: `Claim no D${c.destaque} — mesmo destaque do intentional_error declarado. Não auto-corrigir.`,
      };
    }

    // Candidato para aplicação — status final determinado pelo caller (que tem acesso aos arquivos)
    return {
      destaque: c.destaque,
      claim_type: c.claim_type,
      text: c.text,
      suggested_fix: c.suggested_fix,
      sources: c.sources,
      status: "applied", // provisório; caller corrige para skipped_text_not_found se não encontrar
    };
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        out[key] = argv[i + 1];
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function extractEditionId(editionDir: string): string {
  const parts = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "unknown";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args["edition-dir"]) {
    console.error("Uso: apply-factcheck-autofix.ts --edition-dir data/editions/AAMMDD/ [--dry-run]");
    process.exit(1);
  }

  const editionDir = resolve(process.cwd(), args["edition-dir"]);
  const edition = args.edition ?? extractEditionId(editionDir);
  const isDryRun = args["dry-run"] === "true";

  const factCheckPath = join(editionDir, "_internal", "fact-check.json");
  const newsletterPath = join(editionDir, "02-reviewed.md");
  const socialPath = join(editionDir, "03-social.md");
  const internalDir = join(editionDir, "_internal");
  const outPath = join(internalDir, "fact-check-autofix.json");

  // Pré-condições
  if (!existsSync(factCheckPath)) {
    console.error(`[apply-factcheck-autofix] ERRO: fact-check.json não encontrado em ${factCheckPath}`);
    console.error("  Rodar o subagente fact-checker antes do apply-factcheck-autofix.");
    process.exit(1);
  }
  for (const [label, p] of [
    ["02-reviewed.md", newsletterPath],
    ["03-social.md", socialPath],
  ] as const) {
    if (!existsSync(p)) {
      console.error(`[apply-factcheck-autofix] ERRO: ${label} não encontrado em ${p}`);
      process.exit(1);
    }
  }

  mkdirSync(internalDir, { recursive: true });

  // Ler inputs
  const factCheck = JSON.parse(readFileSync(factCheckPath, "utf8")) as FactCheckResult;
  let newsletter = readFileSync(newsletterPath, "utf8");
  let social = readFileSync(socialPath, "utf8");

  // Extrair destaque do erro intencional do frontmatter
  const intentionalDestaque = extractIntentionalErrorDestaque(newsletter);

  // Planejar autofixes
  const entries = planAutofixes(factCheck.claims, intentionalDestaque);

  // Aplicar substituições (exceto dry-run)
  const filesModifiedSet = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== "applied") continue;
    if (!entry.suggested_fix) continue; // guard (planAutofixes garante, mas TS)

    const filesToCheck: Array<{ label: "newsletter" | "social"; content: string; path: string }> = [];
    if (entry.sources.includes("newsletter")) {
      filesToCheck.push({ label: "newsletter", content: newsletter, path: newsletterPath });
    }
    if (entry.sources.includes("social")) {
      filesToCheck.push({ label: "social", content: social, path: socialPath });
    }

    let foundInAny = false;
    const modifiedFiles: string[] = [];

    for (const file of filesToCheck) {
      const { changed, content: newContent } = applyTextSubstitution(
        file.content,
        entry.text,
        entry.suggested_fix,
      );
      if (changed) {
        foundInAny = true;
        modifiedFiles.push(file.label);
        if (!isDryRun) {
          if (file.label === "newsletter") newsletter = newContent;
          else social = newContent;
          filesModifiedSet.add(file.path);
        }
      }
    }

    if (!foundInAny) {
      entry.status = "skipped_text_not_found";
      entry.note = `Texto "${entry.text}" não encontrado em ${entry.sources.join(", ")}.`;
    } else {
      entry.files_modified = modifiedFiles;
    }
  }

  // Gravar arquivos modificados (não dry-run)
  if (!isDryRun) {
    for (const path of filesModifiedSet) {
      if (path === newsletterPath) writeFileSync(path, newsletter, "utf8");
      else if (path === socialPath) writeFileSync(path, social, "utf8");
    }
  }

  // Montar resultado
  const applied = entries.filter((e) => e.status === "applied").length;
  const skipped = entries.length - applied;

  const result: AutofixResult = {
    edition,
    applied_at: new Date().toISOString(),
    dry_run: isDryRun,
    intentional_error_destaque: intentionalDestaque,
    entries,
    summary: {
      total_divergent: entries.length,
      applied,
      skipped,
    },
  };

  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");

  // Saída para o orchestrator
  if (applied > 0) {
    console.log(`[apply-factcheck-autofix] ${isDryRun ? "[DRY-RUN] " : ""}${applied} correção(ões) aplicada(s) automaticamente:`);
    for (const e of entries.filter((x) => x.status === "applied")) {
      console.log(`  D${e.destaque} [${e.claim_type}] "${e.text}" → "${e.suggested_fix}" (${(e.files_modified ?? []).join(", ")})`);
    }
  } else {
    console.log(`[apply-factcheck-autofix] Nenhuma correção automática disponível (${skipped} claim(s) pulado(s)).`);
  }

  if (skipped > 0) {
    for (const e of entries.filter((x) => x.status !== "applied")) {
      console.log(`  ⏭  D${e.destaque} [${e.claim_type}] "${e.text}" — ${e.status}${e.note ? ": " + e.note : ""}`);
    }
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error("[apply-factcheck-autofix] ERRO:", e);
    process.exit(1);
  });
}
