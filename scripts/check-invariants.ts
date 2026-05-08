/**
 * check-invariants.ts (#965 / #966)
 *
 * Pre-flight executável de invariantes editoriais. Roda checks determinísticos
 * contra output da edição (ou contra o repo em modo `--static`) e falha
 * (exit 1) quando alguma regra é violada.
 *
 * Hoje invariantes vivem em CLAUDE.md como prosa — não há check automático
 * que valide. Resultado: 5+ regressões em ~6 meses (#895, #316, #273, #213,
 * #718). Este script é o single source of enforcement.
 *
 * Uso:
 *   # Modo per-edition (rodado pelo orchestrator antes de cada gate):
 *   npx tsx scripts/check-invariants.ts --edition-dir data/editions/260508
 *
 *   # Modo per-stage (rodado pelo orchestrator pré-gate de cada stage; #1007):
 *   npx tsx scripts/check-invariants.ts --stage 1 --edition-dir data/editions/260508
 *   npx tsx scripts/check-invariants.ts --stage 0  # Stage 0 = global, sem editionDir
 *
 *   # Modo static (rodado em CI ou pre-commit; valida regras estruturais):
 *   npx tsx scripts/check-invariants.ts --static
 *
 *   # Modo único (só roda 1 check específico):
 *   npx tsx scripts/check-invariants.ts --static --rule no-internal-in-drive-sync
 *
 * Output (stdout): JSON `{ passed, violations: [{ rule, message, source_issue, severity }] }`.
 * Stderr: relatório human-readable.
 *
 * Exit codes:
 *   0 — todos os checks passaram (ou só warnings em modo não-strict)
 *   1 — pelo menos 1 violation com severity=error
 *   2 — argumentos inválidos
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRulesForStage } from "./lib/invariant-checks/index.ts";
import type { InvariantViolation } from "./lib/invariant-checks/types.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Violation {
  rule: string;
  message: string;
  source_issue: string;
  severity: "error" | "warning";
  file?: string;
  line?: number;
}

export interface InvariantReport {
  passed: boolean;
  violations: Violation[];
  rules_run: string[];
}

// ---------------------------------------------------------------------------
// Static checks — rodados sem edition (validam estrutura do repo)
// ---------------------------------------------------------------------------

/**
 * #959: Drive sync nunca inclui paths que começam com `_internal/_forensic/`.
 * Forensic é convenção de subdir pra debug pesado (link-verify-bodies, raw
 * HTMLs) que NÃO deve ir pro Drive — agentes nem mesmo devem ler.
 */
export function checkNoForensicInDriveSync(): Violation[] {
  const violations: Violation[] = [];
  const targetDirs = [
    join(ROOT, ".claude", "agents"),
    join(ROOT, ".claude", "skills"),
  ];
  for (const dir of targetDirs) {
    if (!existsSync(dir)) continue;
    walkMd(dir, (path) => {
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // detecta `drive-sync.ts ... --files ... _internal/_forensic` ou
        // `_forensic/link-verify-bodies` em listas de --files
        if (
          /drive-sync\.ts/.test(line) &&
          /_forensic\//.test(line) &&
          /--files/.test(line)
        ) {
          violations.push({
            rule: "no-forensic-in-drive-sync",
            message: `drive-sync push inclui path forensic: "${line.trim().slice(0, 120)}"`,
            source_issue: "#959",
            severity: "error",
            file: path.replace(ROOT, ""),
            line: i + 1,
          });
        }
      }
    });
  }
  return violations;
}

/**
 * Auto-discoverable rule descriptors. Cada rule pode rodar em modo static
 * ou per-edition.
 */
export const STATIC_RULES = [
  {
    id: "no-forensic-in-drive-sync",
    description: "drive-sync nunca inclui _internal/_forensic/ (#959)",
    run: checkNoForensicInDriveSync,
  },
] as const;

// ---------------------------------------------------------------------------
// Per-edition checks — rodados com --edition-dir
// ---------------------------------------------------------------------------

/**
 * Editorial rules: output sem markdown bruto (`**`, `#`, `- ` em destaques).
 * Apenas warning porque o lint completo já cobre via outras regras — guarda
 * defensivo só pra catch obvio.
 */
export function checkOutputNoMarkdown(editionDir: string): Violation[] {
  const violations: Violation[] = [];
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(reviewedPath)) return violations;
  // O lint canônico (lint-newsletter-md.ts) cobre validações detalhadas. Este
  // check só sinaliza ausência do arquivo — o restante fica delegado.
  return violations;
}

export function PER_EDITION_RULES(editionDir: string) {
  return [
    {
      id: "output-no-markdown",
      description: "Output final sem markdown bruto (editorial-rules.md)",
      run: () => checkOutputNoMarkdown(editionDir),
    },
  ] as const;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--static") out.static = true;
    else if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

function walkMd(dir: string, visit: (path: string) => void): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkMd(full, visit);
    else if (name.endsWith(".md")) visit(full);
  }
}

async function main(): Promise<void> {
  // Load .env.local antes de checar env vars (#923) — Stage 0 e 4 dependem
  // de BEEHIIV_API_KEY, FACEBOOK_*, DIARIA_LINKEDIN_CRON_*.
  // DIARIA_PROJECT_ROOT permite override pra teste e2e sem hijack do
  // `.env.local` real do projeto (#1010 item 4).
  loadProjectEnv(process.env.DIARIA_PROJECT_ROOT);
  const args = parseArgs(process.argv.slice(2));
  const isStatic = !!args.static;
  const editionDir = args["edition-dir"] as string | undefined;
  const onlyRule = args.rule as string | undefined;
  const stageRaw = args.stage;
  const stage =
    typeof stageRaw === "string" && /^[0-5]$/.test(stageRaw)
      ? (Number(stageRaw) as 0 | 1 | 2 | 3 | 4 | 5)
      : undefined;

  if (!isStatic && !editionDir && stage === undefined) {
    console.error(
      "Uso: check-invariants.ts --static [--rule <id>]\n" +
        "  ou: check-invariants.ts --edition-dir <path> [--rule <id>]\n" +
        "  ou: check-invariants.ts --stage <0-5> [--edition-dir <path>] [--rule <id>]",
    );
    process.exit(2);
  }

  const violations: Violation[] = [];
  const rulesRun: string[] = [];

  if (stage !== undefined) {
    // #1007: per-stage rules. Stage 0 não precisa editionDir.
    if (stage > 0 && !editionDir) {
      console.error(
        `Stage ${stage} requer --edition-dir <path>. Apenas Stage 0 pode rodar sem.`,
      );
      process.exit(2);
    }
    const editionDirAbs = editionDir ? resolve(ROOT, editionDir) : "";
    for (const rule of getRulesForStage(stage)) {
      if (onlyRule && rule.id !== onlyRule) continue;
      rulesRun.push(rule.id);
      const ruleViolations: InvariantViolation[] = rule.run(editionDirAbs);
      for (const v of ruleViolations) {
        violations.push({
          rule: v.rule,
          message: v.message,
          source_issue: v.source_issue,
          severity: v.severity,
          file: v.file,
          line: v.line,
        });
      }
    }
  } else if (isStatic) {
    for (const rule of STATIC_RULES) {
      if (onlyRule && rule.id !== onlyRule) continue;
      rulesRun.push(rule.id);
      violations.push(...rule.run());
    }
  } else if (editionDir) {
    const editionDirAbs = resolve(ROOT, editionDir);
    for (const rule of PER_EDITION_RULES(editionDirAbs)) {
      if (onlyRule && rule.id !== onlyRule) continue;
      rulesRun.push(rule.id);
      violations.push(...rule.run());
    }
  }

  const errors = violations.filter((v) => v.severity === "error");
  const passed = errors.length === 0;

  const report: InvariantReport = {
    passed,
    violations,
    rules_run: rulesRun,
  };

  console.log(JSON.stringify(report, null, 2));

  console.error(`\n=== check-invariants ===`);
  console.error(`Rules run: ${rulesRun.length}`);
  console.error(`Violations: ${violations.length} (${errors.length} error, ${violations.length - errors.length} warning)`);
  for (const v of violations) {
    const tag = v.severity === "error" ? "❌" : "⚠️";
    const loc = v.file ? ` (${v.file}${v.line ? `:${v.line}` : ""})` : "";
    console.error(`  ${tag} [${v.rule}/${v.source_issue}] ${v.message}${loc}`);
  }

  process.exit(passed ? 0 : 1);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(2);
  });
}
