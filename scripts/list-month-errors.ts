#!/usr/bin/env npx tsx
/**
 * list-month-errors.ts (#754)
 *
 * Lista todos os erros intencionais declarados em um mês. Usado pela
 * skill `/diaria-mes-erros` pra ajudar o editor a rodar o concurso
 * mensal sem garimpar manualmente cada `02-reviewed.md`.
 *
 * Uso:
 *   npx tsx scripts/list-month-errors.ts --month YYMM
 *   npx tsx scripts/list-month-errors.ts --month YYMM --json (output estruturado)
 *
 * Lista edições no mês (`data/editions/{YYMM}*`), extrai frontmatter
 * `intentional_error` de cada `02-reviewed.md`, agrega.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { checkIntentionalError } from "./lint-newsletter-md.ts";

interface MonthError {
  edition: string;
  declared: boolean;
  category?: string;
  location?: string;
  description?: string;
  correct_value?: string;
  reason?: string; // when declared=false
}

function listEditionsForMonth(monthYYMM: string): string[] {
  const editionsDir = resolve(process.cwd(), "data/editions");
  if (!existsSync(editionsDir)) return [];
  const all = readdirSync(editionsDir);
  // Match `YYMMdd` format (6 digits, starts with monthYYMM)
  return all
    .filter((name) => /^\d{6}$/.test(name) && name.startsWith(monthYYMM))
    .sort();
}

function extractError(editionDir: string, edition: string): MonthError {
  const mdPath = join(editionDir, "02-reviewed.md");
  if (!existsSync(mdPath)) {
    return { edition, declared: false, reason: "02-reviewed.md ausente" };
  }
  const result = checkIntentionalError(mdPath);
  if (!result.ok) {
    return { edition, declared: false, reason: result.label };
  }
  const p = result.parsed!;
  return {
    edition,
    declared: true,
    category: p.category,
    location: p.location,
    description: p.description,
    correct_value: p.correct_value,
  };
}

function formatMarkdown(month: string, errors: MonthError[]): string {
  const declared = errors.filter((e) => e.declared);
  const undeclared = errors.filter((e) => !e.declared);

  const lines: string[] = [];
  const monthLabel = `20${month.slice(0, 2)}-${month.slice(2)}`;
  lines.push(`# Erros intencionais — ${monthLabel} (${errors.length} edições)`);
  lines.push("");

  if (declared.length > 0) {
    lines.push("| Edição | Categoria | Localização | Descrição | Valor correto |");
    lines.push("|---|---|---|---|---|");
    for (const e of declared) {
      lines.push(
        `| ${e.edition} | ${e.category} | ${e.location} | ${e.description} | ${e.correct_value ?? ""} |`,
      );
    }
    lines.push("");
  }

  if (undeclared.length > 0) {
    lines.push(`## Edições sem declaração (${undeclared.length})`);
    for (const e of undeclared) {
      lines.push(`- **${e.edition}**: ${e.reason ?? "motivo desconhecido"}`);
    }
    lines.push("");
  }

  // Estatísticas por categoria
  if (declared.length > 0) {
    const counts: Record<string, number> = {};
    for (const e of declared) {
      const c = e.category ?? "unknown";
      counts[c] = (counts[c] ?? 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    lines.push("## Estatística por categoria");
    for (const [cat, n] of sorted) {
      lines.push(`- **${cat}**: ${n}`);
    }
  }

  return lines.join("\n");
}

function parseArgs(argv: string[]): { month: string; json: boolean } | null {
  let month: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--month" && i + 1 < argv.length) {
      month = argv[i + 1];
      i++;
    } else if (a === "--json") {
      json = true;
    }
  }
  if (!month || !/^\d{4}$/.test(month)) return null;
  return { month, json };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(
      "Uso: list-month-errors.ts --month YYMM [--json]\n",
    );
    return 2;
  }

  const editions = listEditionsForMonth(args.month);
  if (editions.length === 0) {
    process.stderr.write(
      `Nenhuma edição encontrada em data/editions/ pra mês ${args.month}\n`,
    );
    process.stdout.write(
      JSON.stringify({ month: args.month, editions: [] }, null, 2) + "\n",
    );
    return 0;
  }

  const errors = editions.map((edition) =>
    extractError(resolve(process.cwd(), "data/editions", edition), edition),
  );

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ month: args.month, errors }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(formatMarkdown(args.month, errors) + "\n");
  }
  return 0;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  process.exit(main());
}
