/**
 * validate-lancamentos.ts (#160, #876)
 *
 * Garante que a seção LANÇAMENTOS de um `02-reviewed.md` só contém
 * URLs de domínio oficial (whitelist em `categorize.ts`). Cobertura
 * de imprensa, blogs pessoais, agregadores e análise de terceiros vão
 * pra NOTÍCIAS — não pra LANÇAMENTOS, mesmo quando o tema é o
 * lançamento.
 *
 * Modo MD (#160, #902):
 *   npx tsx scripts/validate-lancamentos.ts <md-path>
 *   npx tsx scripts/validate-lancamentos.ts --in <md-path>
 *
 *   Output JSON: { lancamento_count, invalid_urls[], status }
 *
 * Modo approved-json (#876, usado em §2a do orchestrator-stage-2):
 *   npx tsx scripts/validate-lancamentos.ts \
 *     --approved <01-approved.json> \
 *     [--write-removed <_internal/02-lancamentos-removed.json>]
 *
 *   Valida cada URL em `approved.lancamento[]`. Quando `--write-removed`
 *   é passado, grava o resumo `{ removed[], original_count, final_count }`
 *   no path indicado para que `sync-intro-count.ts` ajuste menções
 *   narrativas a "X lançamentos" no intro pós-Clarice.
 *
 * Exit codes:
 *   0  Todas as URLs em LANÇAMENTOS são oficiais (ou seção vazia)
 *   1  Pelo menos 1 URL não-oficial em LANÇAMENTOS
 *   2  Erro de leitura/uso
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isOfficialLancamentoUrl } from "./categorize.ts";

export interface ValidationResult {
  lancamento_count: number;
  invalid_urls: Array<{ url: string; line: number }>;
  status: "ok" | "error";
}

// Match tanto formato Stage 2 (LANÇAMENTOS solo) quanto Stage 1 (## Lançamentos com markdown header) — #587.
const SECTION_LANCAMENTOS_RE = /^(?:##\s+)?lan[çc]amentos\s*$/im;
const SECTION_BREAK_RE = /^---\s*$/m;
const URL_RE = /https?:\/\/\S+/g;

/**
 * Extrai todas as URLs da seção LANÇAMENTOS do MD. Retorna array
 * de { url, line } onde line é 1-indexed.
 */
export function extractLancamentoUrls(
  text: string,
): Array<{ url: string; line: number }> {
  const lines = text.split("\n");
  let inSection = false;
  const out: Array<{ url: string; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SECTION_LANCAMENTOS_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && SECTION_BREAK_RE.test(line)) {
      // --- termina a seção
      inSection = false;
      continue;
    }
    if (inSection) {
      // Outro header de seção (ex: PESQUISAS, ## Pesquisas) também encerra.
      // #587: aceita formato Stage 1 (`## Header`) além de Stage 2 (`HEADER` solo).
      const trimmed = line.trim();
      const isPlainCaps = /^[A-ZÇÃÕÁÉÍÓÚÊÔ ]+$/.test(trimmed) && trimmed.length > 5;
      const isMdHeader = /^##\s+\S/.test(trimmed);
      if (isPlainCaps || isMdHeader) {
        inSection = false;
        continue;
      }
      const matches = line.matchAll(URL_RE);
      for (const m of matches) {
        // Trim trailing punctuation that often follows URLs in markdown
        const url = m[0].replace(/[).,;]+$/, "");
        out.push({ url, line: i + 1 });
      }
    }
  }

  return out;
}

export function validateLancamentos(text: string): ValidationResult {
  const urls = extractLancamentoUrls(text);
  // Markdown links [url](url) duplicate the URL — dedup by url string.
  const seen = new Set<string>();
  const unique = urls.filter((u) => {
    if (seen.has(u.url)) return false;
    seen.add(u.url);
    return true;
  });

  const invalid = unique.filter((u) => !isOfficialLancamentoUrl(u.url));
  return {
    lancamento_count: unique.length,
    invalid_urls: invalid,
    status: invalid.length === 0 ? "ok" : "error",
  };
}

// ---------------------------------------------------------------------------
// Modo approved-json (#876) — valida `lancamento[]` no 01-approved.json
// e devolve a lista de URLs removidas para que `sync-intro-count.ts` ajuste
// menções narrativas a "X lançamentos" no intro.
// ---------------------------------------------------------------------------

export interface LancamentoRemoved {
  url: string;
  title?: string;
  reason: string;
}

export interface LancamentosRemovedSummary {
  removed: LancamentoRemoved[];
  original_count: number;
  final_count: number;
}

interface ApprovedShape {
  lancamento?: Array<{ url?: string; title?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * Valida o array `lancamento[]` do 01-approved.json. URLs não-oficiais
 * vão para `removed` com a razão `non_official_domain`. URLs vazias são
 * ignoradas (não contam como original nem como removido).
 */
export function validateLancamentosFromApproved(
  approved: ApprovedShape,
): LancamentosRemovedSummary {
  const list = Array.isArray(approved.lancamento) ? approved.lancamento : [];
  const removed: LancamentoRemoved[] = [];
  let kept = 0;

  for (const item of list) {
    const url = typeof item.url === "string" ? item.url : "";
    if (!url) continue;
    if (isOfficialLancamentoUrl(url)) {
      kept++;
    } else {
      removed.push({
        url,
        title: typeof item.title === "string" ? item.title : undefined,
        reason: "non_official_domain",
      });
    }
  }

  const original_count = kept + removed.length;
  return { removed, original_count, final_count: kept };
}

function parseFlagArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function mainApproved(args: Record<string, string>, ROOT: string): void {
  const approvedPath = resolve(ROOT, args.approved);
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
  const summary = validateLancamentosFromApproved(approved);
  console.log(JSON.stringify(summary, null, 2));

  if (args["write-removed"]) {
    const outPath = resolve(ROOT, args["write-removed"]);
    writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  }

  if (summary.removed.length > 0) {
    console.error(
      `\n⚠️ ${summary.removed.length} de ${summary.original_count} lançamento(s) removido(s) (URL não-oficial):`,
    );
    for (const r of summary.removed) {
      const titleHint = r.title ? ` ("${r.title.slice(0, 60)}")` : "";
      console.error(`  ${r.url}${titleHint}`);
    }
    process.exit(1);
  }
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const flagArgs = parseFlagArgs(process.argv.slice(2));

  // Modo approved-json (#876)
  if (flagArgs.approved) {
    mainApproved(flagArgs, ROOT);
    return;
  }

  // #902: aceitar `--in <path>` além de positional pra alinhar com outros validators do projeto.
  const arg = flagArgs.in || process.argv[2];
  if (!arg || arg.startsWith("--")) {
    console.error(
      "Uso: validate-lancamentos.ts [--in <path> | <md-path>]\n" +
        "  ou: validate-lancamentos.ts --approved <01-approved.json> [--write-removed <path>]",
    );
    process.exit(2);
  }
  const path = resolve(ROOT, arg);
  if (!existsSync(path)) {
    console.error(`Arquivo não existe: ${path}`);
    process.exit(2);
  }
  const text = readFileSync(path, "utf8");
  const result = validateLancamentos(text);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "error") {
    console.error(
      `\n❌ ${result.invalid_urls.length} URL(s) em LANÇAMENTOS não bate(m) com whitelist oficial:`,
    );
    for (const u of result.invalid_urls) {
      console.error(`  linha ${u.line}: ${u.url}`);
    }
    console.error(
      "\nReclassifique como NOTÍCIAS ou substitua por link de domínio oficial. Veja editorial-rules.md → 'Lançamentos só com link oficial'.",
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
