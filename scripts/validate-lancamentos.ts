/**
 * validate-lancamentos.ts (#160)
 *
 * Garante que a seção LANÇAMENTOS de um `02-reviewed.md` só contém
 * URLs de domínio oficial (whitelist em `categorize.ts`). Cobertura
 * de imprensa, blogs pessoais, agregadores e análise de terceiros vão
 * pra NOTÍCIAS — não pra LANÇAMENTOS, mesmo quando o tema é o
 * lançamento.
 *
 * Uso:
 *   npx tsx scripts/validate-lancamentos.ts <md-path>
 *
 * Exit codes:
 *   0  Todas as URLs em LANÇAMENTOS são oficiais (ou seção vazia)
 *   1  Pelo menos 1 URL não-oficial em LANÇAMENTOS
 *   2  Erro de leitura do arquivo
 *
 * Output JSON em stdout:
 *   { lancamento_count: N, invalid_urls: [...], status: "ok" | "error" }
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isOfficialLancamentoUrl } from "./categorize.ts";

export interface ValidationResult {
  lancamento_count: number;
  invalid_urls: Array<{ url: string; line: number }>;
  status: "ok" | "error";
}

const SECTION_LANCAMENTOS_RE = /^LAN[ÇC]AMENTOS\s*$/m;
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
      // Outro header de seção (ex: PESQUISAS) também encerra
      if (/^[A-ZÇÃÕÁÉÍÓÚÊÔ ]+$/.test(line.trim()) && line.trim().length > 5) {
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

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const arg = process.argv[2];
  if (!arg) {
    console.error("Uso: validate-lancamentos.ts <md-path>");
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
