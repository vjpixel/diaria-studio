/**
 * regen-invariants.ts (#969)
 *
 * Lê issues GitHub com label `convention` (closed por default), extrai
 * cada regra estabelecida e regenera `context/invariants.md` — doc curto
 * que lista todas as convenções vigentes do projeto.
 *
 * Source of truth: GitHub issues. CLAUDE.md continua sendo o tour guide
 * geral; `context/invariants.md` é a constituição (curta, indexada por
 * número de issue).
 *
 * Uso:
 *   npx tsx scripts/regen-invariants.ts
 *
 * Flags opcionais:
 *   --state open|closed|all   default: closed (regras vigentes; abertas = TBD)
 *   --out <path>              default: context/invariants.md
 *   --label <name>            default: convention
 *   --dry-run                 imprime sem gravar
 *
 * Pré-requisito: `gh` CLI autenticado.
 *
 * Output: regrava `context/invariants.md`. Não tem efeitos colaterais
 * fora isso. Stderr loga progress.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "context", "invariants.md");
const DEFAULT_LABEL = "convention";

export interface ConventionIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  closedAt?: string;
  labels: string[];
}

/**
 * Categorização heurística por keyword. Ordem importa — checks mais
 * específicos rodam primeiro. Retorna chave canônica usada como header de
 * seção no MD.
 */
export function categorize(issue: ConventionIssue): string {
  const t = issue.title.toLowerCase();
  // Checks específicos primeiro (palavras únicas).
  if (/\bMCP\b|disconnect|fail-fast|stall/i.test(issue.title)) return "Pipeline / MCP";
  if (/\beditorial|destaque|lan[çc]amento|imagem|cr[eé]dito|gabarito|É IA|categorized|reviewed/.test(t))
    return "Editorial";
  if (/\bdrive[-\s]?sync|integrity|edita.*drive|drive.*edit|push.*drive|pull.*drive/.test(t))
    return "Drive sync";
  if (/\bpublish|stage [4-6]|beehiiv|linkedin|facebook|kit\b/.test(t))
    return "Publicação";
  if (/\blint|validat|invariant|check[-_]invariant|pre-?flight/.test(t))
    return "Lint / Validação";
  if (/\bsprint|\bPR\b|review|merge|rebase|process|política|workflow/.test(t))
    return "Processo / PRs";
  if (/\binbox|sorteio|erro intencional|concurso/.test(t)) return "Inbox / Concurso";
  if (/\bedi[çc]ão.*curso|skill|edi[çc]ão.*atual/.test(t)) return "Pipeline / MCP";
  if (/\binfra|template|label\b/.test(t)) return "Processo / PRs";
  return "Outros";
}

/**
 * Tenta extrair seção `## Regra` do template (#968). Caso ausente OU vazia
 * após strip de comentários HTML (issue meta sobre o próprio template, ex:
 * #968), fallback pra título da issue.
 */
export function extractRule(issue: ConventionIssue): string {
  const titleFallback = issue.title
    .replace(/^(fix|feat|chore|infra|process|spike|test|docs|refactor)(\([^)]+\))?:\s*/i, "")
    .replace(/\s*\(closes\s+#\d+\).*$/i, "")
    .trim();

  const m = issue.body.match(/##\s+Regra\s*\n+([^\n]+(?:\n(?!##)[^\n]+)*)/);
  if (!m) return titleFallback;

  const cleaned = m[1]
    .trim()
    .replace(/\n+/g, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  // Empty-after-cleanup = template comentado (ex: #968 que descreve o próprio
  // template). Usa fallback de título.
  return cleaned.length > 0 ? cleaned : titleFallback;
}

/**
 * Renderiza markdown final agrupado por categoria. Cada item:
 *   - (#N) descrição da regra
 */
export function renderInvariants(
  issues: ConventionIssue[],
  generatedAt: Date = new Date(),
): string {
  const buckets = new Map<string, ConventionIssue[]>();
  for (const issue of issues) {
    const cat = categorize(issue);
    const list = buckets.get(cat) ?? [];
    list.push(issue);
    buckets.set(cat, list);
  }
  // Ordem das seções: estabilizar por nome canônico.
  const sectionOrder = [
    "Drive sync",
    "Publicação",
    "Lint / Validação",
    "Processo / PRs",
    "Editorial",
    "Pipeline / MCP",
    "Inbox / Concurso",
    "Outros",
  ];

  const lines: string[] = [];
  lines.push("# Invariantes do projeto Diar.ia");
  lines.push("");
  lines.push(
    "_Gerado automaticamente por `scripts/regen-invariants.ts` a partir de issues GitHub com label `convention`. Não editar diretamente — alterações são sobrescritas no próximo run._",
  );
  lines.push("");
  lines.push(`Última atualização: ${generatedAt.toISOString()}`);
  lines.push(`Fonte: ${issues.length} issue(s) com label \`convention\`.`);
  lines.push("");
  for (const cat of sectionOrder) {
    const items = buckets.get(cat);
    if (!items || items.length === 0) continue;
    lines.push(`## ${cat}`);
    lines.push("");
    // Ordenar por número decrescente (mais recente primeiro).
    items.sort((a, b) => b.number - a.number);
    for (const issue of items) {
      const rule = extractRule(issue);
      lines.push(`- (#${issue.number}) ${rule}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Carrega issues via gh CLI. Retorna array tipado.
 */
export function loadConventionIssues(label: string, state: string): ConventionIssue[] {
  const r = spawnSync(
    "gh",
    [
      "issue",
      "list",
      "--label", label,
      "--state", state,
      "--limit", "100",
      "--json", "number,title,body,state,closedAt,labels",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`gh issue list falhou: ${r.stderr}`);
  }
  const raw = JSON.parse(r.stdout) as Array<{
    number: number;
    title: string;
    body: string;
    state: string;
    closedAt?: string;
    labels: Array<{ name: string }>;
  }>;
  return raw.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    state: i.state,
    closedAt: i.closedAt,
    labels: i.labels.map((l) => l.name),
  }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out["dry-run"] = true;
    else if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const label = (args.label as string) ?? DEFAULT_LABEL;
  const state = (args.state as string) ?? "closed";
  const out = args.out ? resolve(ROOT, args.out as string) : DEFAULT_OUT;
  const dryRun = !!args["dry-run"];

  process.stderr.write(`[regen-invariants] Carregando issues label='${label}' state='${state}'...\n`);
  const issues = loadConventionIssues(label, state);
  process.stderr.write(`[regen-invariants] ${issues.length} issue(s) carregada(s).\n`);

  const md = renderInvariants(issues);
  if (dryRun) {
    process.stdout.write(md);
    return;
  }
  writeFileSync(out, md, "utf8");
  process.stderr.write(`[regen-invariants] Escrito em ${out}\n`);
  console.log(JSON.stringify({ out, count: issues.length }));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
