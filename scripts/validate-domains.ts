/**
 * validate-domains.ts (#701)
 *
 * Cross-check de URLs do MD final contra listas de:
 * - Paywalls hard (`scripts/lib/paywalls.ts`)
 * - Agregadores/roundups (`scripts/lib/aggregators.ts`)
 *
 * `editorial-rules.md:11-12` proíbe ambos. Antes deste script, só
 * self-validation do writer LLM e revisão visual do editor pegavam — sem
 * rede de segurança automática. `verify-accessibility.ts` checa HTTP
 * status, não domínio.
 *
 * Uso:
 *   npx tsx scripts/validate-domains.ts <md-path>
 *
 * Exit codes:
 *   0  Nenhum paywall ou agregador encontrado
 *   1  ≥1 URL bloqueada — newsletter NÃO pode publicar como está
 *   2  Erro de leitura
 *
 * Output JSON em stdout: { ok, paywall_violations[], aggregator_violations[] }
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isPaywall } from "./lib/paywalls.ts";
import { isAggregator } from "./lib/aggregators.ts";

const URL_RE = /https?:\/\/[^\s)\]>]+/g;

export interface DomainViolation {
  url: string;
  line: number;
  reason: "paywall" | "aggregator";
}

export interface DomainReport {
  ok: boolean;
  paywall_violations: DomainViolation[];
  aggregator_violations: DomainViolation[];
}

/**
 * Extrai todas URLs do MD com número de linha. Dedup por URL canônica
 * (preserva primeira ocorrência) — markdown link `[url](url)` produz 2
 * matches da mesma URL e devem contar como 1.
 */
export function extractUrlsWithLines(md: string): Array<{ url: string; line: number }> {
  const lines = md.split("\n");
  const out: Array<{ url: string; line: number }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].matchAll(URL_RE);
    for (const m of matches) {
      const url = m[0].replace(/[).,;]+$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, line: i + 1 });
    }
  }
  return out;
}

export function validateDomains(md: string): DomainReport {
  const urls = extractUrlsWithLines(md);
  const paywall_violations: DomainViolation[] = [];
  const aggregator_violations: DomainViolation[] = [];

  for (const { url, line } of urls) {
    if (isPaywall(url)) {
      paywall_violations.push({ url, line, reason: "paywall" });
    } else if (isAggregator(url)) {
      // else-if: paywall tem precedência se ambos casarem (não acontece hoje
      // mas evita double-count se algum dia entrar overlap).
      aggregator_violations.push({ url, line, reason: "aggregator" });
    }
  }

  return {
    ok: paywall_violations.length === 0 && aggregator_violations.length === 0,
    paywall_violations,
    aggregator_violations,
  };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const mdArg = process.argv[2];
  if (!mdArg) {
    console.error("Uso: validate-domains.ts <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(ROOT, mdArg);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const report = validateDomains(md);
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    if (report.paywall_violations.length > 0) {
      console.error(`\n❌ ${report.paywall_violations.length} URL(s) atrás de paywall hard:`);
      for (const v of report.paywall_violations) {
        console.error(`  linha ${v.line}: ${v.url}`);
      }
    }
    if (report.aggregator_violations.length > 0) {
      console.error(`\n❌ ${report.aggregator_violations.length} URL(s) de agregador:`);
      for (const v of report.aggregator_violations) {
        console.error(`  linha ${v.line}: ${v.url}`);
      }
    }
    console.error(
      `\nSubstituir por fonte primária equivalente (ver editorial-rules.md §1).`,
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
