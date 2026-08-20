/**
 * validate-domain-diversity.ts (#5735)
 *
 * Regra editorial: uma edição tem no máximo 2 URLs do mesmo domínio
 * registrável (eTLD+1), contando TODOS os links da edição somados —
 * destaques (D1/D2/D3) + RADAR + USE MELHOR + LANÇAMENTOS + vídeo, não por
 * seção. Ver `context/editorial-rules.md` (seção de links) para o texto
 * completo da regra e o racional.
 *
 * Mesmo contrato de `scripts/validate-lancamentos.ts`/`validate-domains.ts`:
 * lê um MD, extrai URLs com número de linha, agrupa por domínio registrável
 * (`scripts/lib/registrable-domain.ts` — `blog.openai.com` e `openai.com`
 * contam como o mesmo domínio, sem allowlist de exceção pra plataformas).
 *
 * Uso:
 *   npx tsx scripts/validate-domain-diversity.ts <md-path>
 *   npx tsx scripts/validate-domain-diversity.ts <md-path> --max 3   # override (default 2)
 *
 * Exit codes:
 *   0  Nenhum domínio excede o limite
 *   1  ≥1 domínio com mais URLs que o limite — newsletter NÃO pode publicar como está
 *   2  Erro de leitura/uso
 *
 * Output JSON em stdout: { ok, max_per_domain, violations[] }
 *
 * Integração no gate do Stage 1 (seleção) e no `validate-stage-4-completeness.ts`
 * do Stage 4 é trabalho de playbook, deixado como próximo passo — este
 * script é o validador standalone que esses pontos de integração chamam.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractUrlsWithLines } from "./validate-domains.ts";
import { registrableDomain } from "./lib/registrable-domain.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";

export const DEFAULT_MAX_PER_DOMAIN = 2;

export interface DomainDiversityViolation {
  domain: string;
  urls: Array<{ url: string; line: number }>;
}

export interface DomainDiversityReport {
  ok: boolean;
  max_per_domain: number;
  violations: DomainDiversityViolation[];
}

/**
 * Agrupa URLs (já extraídas com linha) por domínio registrável e reporta
 * qualquer grupo que exceda `maxPerDomain`. URLs que não parseiam (host
 * inválido) são ignoradas — mesma postura fail-soft de `validate-domains.ts`
 * pro que não é uma URL http(s) reconhecível.
 * @pure
 */
export function validateDomainDiversity(
  md: string,
  maxPerDomain: number = DEFAULT_MAX_PER_DOMAIN,
): DomainDiversityReport {
  const urls = extractUrlsWithLines(md);
  const byDomain = new Map<string, Array<{ url: string; line: number }>>();

  for (const entry of urls) {
    const domain = registrableDomain(entry.url);
    if (!domain) continue;
    const list = byDomain.get(domain) ?? [];
    list.push(entry);
    byDomain.set(domain, list);
  }

  const violations: DomainDiversityViolation[] = [];
  for (const [domain, entries] of byDomain) {
    if (entries.length > maxPerDomain) {
      violations.push({ domain, urls: entries });
    }
  }
  // Ordem determinística no report (o Map preserva ordem de inserção, que já
  // é a ordem de aparição no texto — mas ordenar por domínio deixa o output
  // estável entre rodadas com a mesma composição em ordem diferente).
  violations.sort((a, b) => a.domain.localeCompare(b.domain));

  return { ok: violations.length === 0, max_per_domain: maxPerDomain, violations };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values, positional } = parseCliArgs(process.argv.slice(2));
  const mdArg = values["md"] ?? positional[0];
  if (!mdArg) {
    console.error("Uso: validate-domain-diversity.ts <md-path> [--max N]");
    process.exit(2);
  }
  const mdPath = resolve(ROOT, mdArg);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const maxPerDomain = values["max"] ? Number(values["max"]) : DEFAULT_MAX_PER_DOMAIN;
  if (!Number.isFinite(maxPerDomain) || maxPerDomain < 1) {
    console.error(`--max inválido: ${values["max"]}`);
    process.exit(2);
  }

  const md = readFileSync(mdPath, "utf8");
  const report = validateDomainDiversity(md, maxPerDomain);
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    console.error(`\n❌ ${report.violations.length} domínio(s) excedem o limite de ${maxPerDomain} URL(s) por edição:`);
    for (const v of report.violations) {
      console.error(`  ${v.domain} (${v.urls.length} URLs):`);
      for (const u of v.urls) {
        console.error(`    linha ${u.line}: ${u.url}`);
      }
    }
    console.error(
      `\nSubstituir os excedentes por link de outro domínio (ver editorial-rules.md → "no máximo ${maxPerDomain} URLs do mesmo domínio").`,
    );
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
