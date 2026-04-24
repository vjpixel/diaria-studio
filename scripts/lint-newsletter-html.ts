/**
 * lint-newsletter-html.ts
 *
 * Valida HTML da newsletter antes de colar no Beehiiv Custom HTML block (#74).
 * Pega bugs de email rendering em build-time — economiza round-trips do
 * loop verify-test-email.
 *
 * Checks bloqueantes (exit 2):
 *   - Placeholders não-resolvidas ({{IMG:...}} no HTML final)
 *   - Links quebrados (href="", href="#", href="javascript:")
 *   - Seções duplicadas (mesmo h2/h3)
 *   - Caracteres mojibake (Ã£, Ã§, etc — sinal de encoding quebrado)
 *
 * Checks warning (exit 0 + log):
 *   - Tables > 600px de width
 *   - <img> sem alt text
 *   - target="_blank" sem rel="noopener noreferrer"
 *
 * Uso:
 *   npx tsx scripts/lint-newsletter-html.ts --html <path> [--strict]
 *
 * --strict: exit 2 em qualquer warning também.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface LintIssue {
  rule: string;
  severity: "error" | "warning";
  message: string;
  count?: number;
  samples?: string[];
}

export interface LintResult {
  errors: LintIssue[];
  warnings: LintIssue[];
  checked_rules: string[];
}

// ------------------------------------------------------------------------
// Check functions — cada uma recebe HTML e retorna issues[]
// ------------------------------------------------------------------------

export function checkUnresolvedPlaceholders(html: string): LintIssue[] {
  const matches = html.match(/\{\{IMG:[^}]+\}\}/g);
  if (!matches) return [];
  return [
    {
      rule: "unresolved_placeholders",
      severity: "error",
      message: `${matches.length} placeholder(s) {{IMG:...}} não resolvida(s) no HTML final`,
      count: matches.length,
      samples: [...new Set(matches)].slice(0, 5),
    },
  ];
}

export function checkBrokenLinks(html: string): LintIssue[] {
  const issues: LintIssue[] = [];
  // href vazio, apenas "#", ou javascript:
  const brokenMatches = [...html.matchAll(/<a[^>]+href=["']([^"']*)["'][^>]*>/gi)];
  const broken: string[] = [];
  for (const m of brokenMatches) {
    const href = m[1].trim();
    if (!href || href === "#" || href.startsWith("javascript:")) {
      broken.push(href || "(empty)");
    }
  }
  if (broken.length > 0) {
    issues.push({
      rule: "broken_links",
      severity: "error",
      message: `${broken.length} link(s) com href inválido`,
      count: broken.length,
      samples: [...new Set(broken)].slice(0, 5),
    });
  }
  return issues;
}

export function checkDuplicateHeadings(html: string): LintIssue[] {
  // Match <h1-h6>text</h1-h6>
  const matches = [...html.matchAll(/<h([1-6])[^>]*>([^<]+)<\/h\1>/gi)];
  const seen: Record<string, number> = {};
  for (const m of matches) {
    const text = m[2].trim().toLowerCase();
    seen[text] = (seen[text] ?? 0) + 1;
  }
  const dups = Object.entries(seen).filter(([, n]) => n > 1);
  if (dups.length === 0) return [];
  return [
    {
      rule: "duplicate_headings",
      severity: "error",
      message: `${dups.length} heading(s) duplicado(s)`,
      count: dups.length,
      samples: dups.map(([text, n]) => `"${text}" (${n}x)`).slice(0, 5),
    },
  ];
}

export function checkMojibake(html: string): LintIssue[] {
  // Padrões típicos de encoding quebrado: UTF-8 bytes vistos como Latin-1
  // Ã£ (ã), Ã§ (ç), Ã© (é), Ãª (ê), Ã§Ã£o (ção), etc.
  const patterns = [/Ã£/g, /Ã§/g, /Ã©/g, /Ãª/g, /Ã³/g, /Ã­/g, /Ãº/g, /Ã¡/g, /Ã´/g, /Ã¢/g];
  let total = 0;
  const samples: string[] = [];
  for (const p of patterns) {
    const found = html.match(p);
    if (found) {
      total += found.length;
      if (samples.length < 5) samples.push(p.source.replace(/\\/g, ""));
    }
  }
  if (total === 0) return [];
  return [
    {
      rule: "mojibake",
      severity: "error",
      message: `${total} ocorrência(s) de encoding quebrado (UTF-8 visto como Latin-1)`,
      count: total,
      samples,
    },
  ];
}

export function checkWideTables(html: string): LintIssue[] {
  // <table ... width="XXX"> ou style="width: XXXpx"
  const issues: string[] = [];
  const tableMatches = [...html.matchAll(/<table[^>]*>/gi)];
  for (const m of tableMatches) {
    const tag = m[0];
    const widthAttr = tag.match(/width=["']?(\d+)/i);
    if (widthAttr && Number(widthAttr[1]) > 600) {
      issues.push(`width=${widthAttr[1]}px`);
      continue;
    }
    const styleWidth = tag.match(/style=["'][^"']*width\s*:\s*(\d+)px/i);
    if (styleWidth && Number(styleWidth[1]) > 600) {
      issues.push(`style width=${styleWidth[1]}px`);
    }
  }
  if (issues.length === 0) return [];
  return [
    {
      rule: "wide_tables",
      severity: "warning",
      message: `${issues.length} <table> com width > 600px (email clients cortam)`,
      count: issues.length,
      samples: [...new Set(issues)].slice(0, 5),
    },
  ];
}

export function checkImgsWithoutAlt(html: string): LintIssue[] {
  // <img ... sem alt= ou com alt=""
  const imgMatches = [...html.matchAll(/<img\s[^>]*>/gi)];
  const missing: number[] = [];
  for (let i = 0; i < imgMatches.length; i++) {
    const tag = imgMatches[i][0];
    const altMatch = tag.match(/\salt=["']([^"']*)["']/i);
    if (!altMatch || altMatch[1].trim() === "") {
      missing.push(i);
    }
  }
  if (missing.length === 0) return [];
  return [
    {
      rule: "img_without_alt",
      severity: "warning",
      message: `${missing.length} <img> sem alt (acessibilidade + clients que bloqueiam imagens)`,
      count: missing.length,
    },
  ];
}

export function checkUnsafeTargetBlank(html: string): LintIssue[] {
  // target="_blank" sem rel="noopener" ou "noreferrer"
  const anchorMatches = [...html.matchAll(/<a\s[^>]*target=["']_blank["'][^>]*>/gi)];
  const unsafe: string[] = [];
  for (const m of anchorMatches) {
    const tag = m[0];
    if (!/rel=["'][^"']*noopener/i.test(tag) && !/rel=["'][^"']*noreferrer/i.test(tag)) {
      const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
      unsafe.push(hrefMatch ? hrefMatch[1].slice(0, 40) : "(no href)");
    }
  }
  if (unsafe.length === 0) return [];
  return [
    {
      rule: "unsafe_target_blank",
      severity: "warning",
      message: `${unsafe.length} <a target="_blank"> sem rel="noopener noreferrer" (reverse tabnabbing risk)`,
      count: unsafe.length,
      samples: unsafe.slice(0, 5),
    },
  ];
}

const ALL_CHECKS = [
  { fn: checkUnresolvedPlaceholders, rule: "unresolved_placeholders" },
  { fn: checkBrokenLinks, rule: "broken_links" },
  { fn: checkDuplicateHeadings, rule: "duplicate_headings" },
  { fn: checkMojibake, rule: "mojibake" },
  { fn: checkWideTables, rule: "wide_tables" },
  { fn: checkImgsWithoutAlt, rule: "img_without_alt" },
  { fn: checkUnsafeTargetBlank, rule: "unsafe_target_blank" },
];

export function lintHtml(html: string): LintResult {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  for (const check of ALL_CHECKS) {
    const issues = check.fn(html);
    for (const issue of issues) {
      if (issue.severity === "error") errors.push(issue);
      else warnings.push(issue);
    }
  }
  return {
    errors,
    warnings,
    checked_rules: ALL_CHECKS.map((c) => c.rule),
  };
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--strict") {
      out.strict = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const htmlArg = args.html;
  if (typeof htmlArg !== "string") {
    console.error("Uso: lint-newsletter-html.ts --html <path> [--strict]");
    process.exit(1);
  }
  const htmlPath = resolve(ROOT, htmlArg);
  const html = readFileSync(htmlPath, "utf8");
  const result = lintHtml(html);

  console.log(JSON.stringify(result, null, 2));

  if (result.errors.length > 0) {
    console.error(`\n❌ ${result.errors.length} erro(s) bloqueante(s).`);
    process.exit(2);
  }
  if (args.strict && result.warnings.length > 0) {
    console.error(`\n⚠️ ${result.warnings.length} warning(s) em modo --strict.`);
    process.exit(2);
  }
  console.error(`\n✓ HTML ok (${result.warnings.length} warning(s) não-bloqueante[s]).`);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
