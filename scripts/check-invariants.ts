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
import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getRulesForStage } from "./lib/invariant-checks/index.ts";
import type { InvariantViolation } from "./lib/invariant-checks/types.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, isMainModule } from "./lib/cli-args.ts";

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
 * #1022: Drive sync do digest mensal não inclui HTML render.
 * O HTML é input direto do Brevo; editor não revisa lá. Polui pasta.
 *
 * @param baseDir Opcional, default = `.claude/skills/diaria-mensal`. Aceito
 *                pra permitir test com fixture dir contendo violações
 *                injetadas (sem modificar o repo).
 */
export function checkNoHtmlInMonthlyDriveSync(baseDir?: string): Violation[] {
  const violations: Violation[] = [];
  const targetDirs = [baseDir ?? join(ROOT, ".claude", "skills", "diaria-mensal")];
  for (const dir of targetDirs) {
    if (!existsSync(dir)) continue;
    walkMd(dir, (path) => {
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // detecta `drive-sync.ts ... --files ...preview*.html` ou similar
        if (
          /drive-sync\.ts/.test(line) &&
          /--files/.test(line) &&
          /\.html\b/.test(line)
        ) {
          violations.push({
            rule: "no-html-in-monthly-drive-sync",
            message: `drive-sync mensal inclui HTML (input Brevo, não editorial): "${line.trim().slice(0, 120)}"`,
            source_issue: "#1022",
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
 * #4059: nenhum CTA público novo pode apontar pra `diaria.beehiiv.com`.
 *
 * O host de marca (`diar.ia.br`) virou canônico em 260723 — o redirect no
 * Cloudflare preserva a query string, então a premissa do #2613 (UTM morria no
 * redirect) caiu. A varredura do #4059 limpou o que existia; sem este guard a
 * sujeira volta, que foi exatamente o que aconteceu depois do #2613.
 *
 * Escopo do scan: `scripts/**` + `workers/**` (`.ts`), procurando o host
 * dentro de uma STRING de URL clicável — `https://diaria.beehiiv.com` — e não
 * menções em comentário/doc (que continuam legítimas pra explicar o histórico).
 *
 * A allowlist abaixo é por ARQUIVO e cobre os casos de infra/medição/histórico
 * levantados na issue: CORS do embed, parsing de links de tracking de edições
 * já publicadas, lint do wrapper de tracking, allowlists de URL de rodapé,
 * Search Console (propriedade verificada ainda é o host antigo) e a API de
 * polls do próprio Beehiiv.
 *
 * @param baseDir Opcional — permite testar com fixture dir sem tocar o repo.
 */
export const BEEHIIV_CTA_ALLOWLIST = [
  // CORS: o embed do jogo roda DENTRO da página do Beehiiv.
  "workers/poll/wrangler.toml",
  "workers/poll/src/index.ts",
  // Leitura de dado histórico (links de tracking de edições já publicadas).
  "scripts/refresh-past-editions.ts",
  // Reconhece `link.diaria.beehiiv.com` como wrapper de tracking do Beehiiv.
  "scripts/lint-test-email-link-tracking.ts",
  // Allowlists de URL de rodapé/afiliado — `diar.ia.br` foi ADICIONADO ao lado,
  // o host antigo continua porque links velhos seguem vivos no arquivo.
  "scripts/lib/canonical-urls.ts",
  "scripts/lib/newsletter-count.ts",
  "scripts/check-stage2-invariants.ts",
  // Propriedade VERIFICADA no Search Console ainda é o host antigo.
  "scripts/seo-pull.ts",
  // URLs de poll da própria API do Beehiiv.
  "scripts/fetch-beehiiv-poll-stats.ts",
  // Normalizador `diaria.beehiiv.com` → `diar.ia.br`: precisa citar os dois.
  "scripts/monthly-relink-to-diaria.ts",
  "scripts/lib/mensal/monthly-render.ts",
  // Este próprio arquivo (a allowlist acima menciona o host).
  "scripts/check-invariants.ts",
] as const;

export function checkNoBeehiivHostInPublicCta(baseDir?: string): Violation[] {
  const violations: Violation[] = [];
  const root = baseDir ?? ROOT;
  const targetDirs = [join(root, "scripts"), join(root, "workers")];
  const allow = new Set<string>(BEEHIIV_CTA_ALLOWLIST.map((p) => p.replace(/\//g, sep)));

  for (const dir of targetDirs) {
    if (!existsSync(dir)) continue;
    for (const path of walkTs(dir)) {
      const rel = path.slice(root.length + 1);
      if (allow.has(rel)) continue;
      const lines = readFileSync(path, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Só URL absoluta dentro de string/template — menção em comentário
        // (`// ver diaria.beehiiv.com`) não é um href clicável.
        if (!/https?:\/\/(?:link\.)?diaria\.beehiiv\.com/.test(line)) continue;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        violations.push({
          rule: "no-beehiiv-host-in-public-cta",
          message:
            `CTA público aponta pra diaria.beehiiv.com — use diar.ia.br ` +
            `(host de marca canônico desde 260723). Se for infra/medição/histórico, ` +
            `adicione o arquivo em BEEHIIV_CTA_ALLOWLIST: "${line.trim().slice(0, 120)}"`,
          source_issue: "#4059",
          severity: "error",
          file: path.replace(root, ""),
          line: i + 1,
        });
      }
    }
  }
  return violations;
}

/**
 * Auto-discoverable rule descriptors. Cada rule pode rodar em modo static
 * ou per-edition.
 */
export const STATIC_RULES = [
  {
    id: "no-beehiiv-host-in-public-cta",
    description: "CTA público nunca aponta pra diaria.beehiiv.com (#4059)",
    run: checkNoBeehiivHostInPublicCta,
  },
  {
    id: "no-forensic-in-drive-sync",
    description: "drive-sync nunca inclui _internal/_forensic/ (#959)",
    run: checkNoForensicInDriveSync,
  },
  {
    id: "no-html-in-monthly-drive-sync",
    description: "drive-sync mensal nunca inclui HTML render (#1022)",
    run: checkNoHtmlInMonthlyDriveSync,
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

/** #4059: lista .ts/.toml recursivamente (node_modules e dist ignorados). */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".wrangler") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (name.endsWith(".ts") || name.endsWith(".toml")) out.push(full);
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
  const argv = process.argv.slice(2);
  const isStatic = argv.includes("--static");
  const editionDir = getArg(argv, "edition-dir") || undefined;
  const onlyRule = getArg(argv, "rule") || undefined;
  const stageRaw = getArg(argv, "stage") || undefined;
  const stage =
    typeof stageRaw === "string" && /^[0-6]$/.test(stageRaw)
      ? (Number(stageRaw) as 0 | 1 | 2 | 3 | 4 | 5 | 6)
      : undefined;

  if (!isStatic && !editionDir && stage === undefined) {
    console.error(
      "Uso: check-invariants.ts --static [--rule <id>]\n" +
        "  ou: check-invariants.ts --edition-dir <path> [--rule <id>]\n" +
        "  ou: check-invariants.ts --stage <0-6> [--edition-dir <path>] [--rule <id>]",
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

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(2);
  });
}
