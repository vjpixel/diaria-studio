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
 * Lista edições no mês (`data/editions/{YYMM}*`), extrai `intentional_error`
 * de `_internal/intentional-error.json` de cada edição (#3222 — migrado do
 * antigo frontmatter YAML de `02-reviewed.md`; fallback pra
 * `data/intentional-errors.jsonl` em edições publicadas antes da migração),
 * agrega.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { checkIntentionalError } from "./lint-newsletter-md.ts";
import { loadIntentionalErrors } from "./lib/intentional-errors.ts";
import { parseArgs as parseArgsLib } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts"; // #2463/#3025: layout flat+nested

export interface MonthError {
  edition: string;
  declared: boolean;
  /** #2016: true when editor explicitly declared no intentional error */
  no_error?: boolean;
  category?: string;
  location?: string;
  description?: string;
  correct_value?: string;
  reason?: string; // when declared=false
}

// #2463/#3025: enumera AMBOS os layouts (flat legado + nested novo) via
// `enumerateEditionDirs` — antes um `readdirSync(editionsDir)` direto perdia
// edições no layout nested pós-#3023. `enumerateEditionDirs` já garante o
// formato `/^\d{6}$/`, então só falta o filtro por prefixo do mês.
function listEditionsForMonth(monthYYMM: string): string[] {
  const editionsDir = resolve(process.cwd(), "data/editions");
  return [...enumerateEditionDirs(editionsDir).keys()]
    .filter((name) => name.startsWith(monthYYMM))
    .sort();
}

/**
 * #3222: fallback pra `data/intentional-errors.jsonl` quando não há
 * `_internal/intentional-error.json` legível pra edição. Cobre 2 casos:
 *   1. MD ausente (e.g. post-archive) — comportamento pré-#3222 preservado.
 *   2. Edições PUBLICADAS ANTES da migração #3222 — a estrutura vivia em
 *      frontmatter YAML de `02-reviewed.md` (não em `_internal/*.json`), mas
 *      `sync-intentional-error.ts` já tinha sincronizado a entry pro JSONL na
 *      época. Sem este fallback, `/diaria-mes-erros` reportaria "sem
 *      declaração" pra todo mês anterior à migração mesmo com o dado intacto
 *      no JSONL — a estrutura YAML original não é mais lida (é exatamente o
 *      código fonte da corrupção #3205 que foi removido), mas o JSONL sincronizado
 *      continua sendo a fonte de fallback correta.
 */
function fallbackFromJsonl(edition: string, reason: string): MonthError {
  const jsonlPath = resolve(process.cwd(), "data/intentional-errors.jsonl");
  const entries = loadIntentionalErrors(jsonlPath);
  const entry = entries.find((e) => e.edition === edition);
  if (!entry) return { edition, declared: false, reason };
  if (entry.no_error) return { edition, declared: true, no_error: true };
  if (!entry.is_feature) return { edition, declared: false, reason };
  // Formata location no mesmo estilo do path não-fallback ("DESTAQUE N"), em
  // vez do dígito cru — a coluna "Localização" mistura os dois no output.
  const location =
    entry.destaque === undefined
      ? undefined
      : /^\d+$/.test(String(entry.destaque))
        ? `DESTAQUE ${entry.destaque}`
        : String(entry.destaque);
  return {
    edition,
    declared: true,
    category: entry.error_type,
    location,
    description: entry.detail,
    correct_value: entry.correct_value,
  };
}

export function extractError(editionDir: string, edition: string): MonthError {
  const mdPath = join(editionDir, "02-reviewed.md");
  if (!existsSync(mdPath)) {
    // #2016: fallback to JSONL when MD is absent (e.g., post-archive)
    return fallbackFromJsonl(edition, "02-reviewed.md ausente");
  }
  const result = checkIntentionalError(mdPath);
  // #2016: `intentional_error: none` — editor declared no error this edition.
  if (result.ok && result.no_error) {
    return { edition, declared: true, no_error: true };
  }
  if (!result.ok) {
    // #3222: sem `_internal/intentional-error.json` legível — tenta o JSONL
    // antes de declarar "sem declaração" (cobre edições pré-migração cuja
    // estrutura só existia no antigo frontmatter YAML, já sincronizado).
    return fallbackFromJsonl(edition, result.label ?? "intentional_error indisponível");
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
  // #2016: separate "no_error" editions from regular declared errors
  const noErrorEditions = errors.filter((e) => e.declared && e.no_error);
  const declared = errors.filter((e) => e.declared && !e.no_error);
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

  // #2016: editions without intentional error (valid reader answer: "não há erro")
  if (noErrorEditions.length > 0) {
    lines.push(`## Edições sem erro intencional (${noErrorEditions.length})`);
    lines.push(`> Resposta válida do leitor: **"não há erro"**`);
    lines.push("");
    for (const e of noErrorEditions) {
      lines.push(`- **${e.edition}**: sem erro intencional (resposta válida: 'não há erro')`);
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

  // Estatísticas por categoria (exclude no_error editions)
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
  // #2834: extração via parseArgs canônico; a validação regex abaixo garante
  // que qualquer divergência de borda (ex: "--month" sem valor seguido de
  // "--json") resulta em `month` inválido de qualquer forma → mesmo retorno
  // `null` do parser manual anterior.
  const { values, flags } = parseArgsLib(argv);
  const month = values["month"] ?? null;
  const json = flags.has("json");
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

  // #2463/#3025: resolve o path REAL (flat ou nested) de cada edição — nunca
  // `resolve(process.cwd(), "data/editions", edition)`, que assume flat.
  const editionDirsByAammdd = enumerateEditionDirs(resolve(process.cwd(), "data/editions"));
  const errors = editions.map((edition) =>
    // #3025 self-review: guard contra o dir sumir entre a varredura de
    // listEditionsForMonth() e esta (TOCTOU raro) — fallback pro path flat
    // legado, que extractError trata como "02-reviewed.md ausente" (mesmo
    // comportamento de uma edição sem artefato, não um crash).
    extractError(
      editionDirsByAammdd.get(edition) ?? resolve(process.cwd(), "data/editions", edition),
      edition,
    ),
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
