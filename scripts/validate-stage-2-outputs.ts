/**
 * validate-stage-2-outputs.ts (#872)
 *
 * Verifica que os 3 agents paralelos do Stage 2 (writer, social-linkedin,
 * social-facebook) escreveram seus outputs com sucesso antes de prosseguir
 * pra etapas que assumem isso (merge social, processamento newsletter).
 *
 * Bug que motivou (#872): se algum dos 3 agents falhasse silenciosamente
 * (timeout, retorno mal-formado), o merge em `03-social.md` crashava
 * lendo arquivo ausente, deixando a edição em estado quebrado sem rollback.
 *
 * Uso:
 *   npx tsx scripts/validate-stage-2-outputs.ts --edition-dir data/editions/260507/
 *
 * Exit codes:
 *   0 — todos os 3 outputs OK
 *   1 — algum output ausente/vazio (FATAL); stderr indica qual + sugestão de fix
 */

import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface OutputCheck {
  agent: string;
  path: string;
  resumeCmd: string;
}

function parseArgs(argv: string[]): { editionDir?: string } {
  const args: { editionDir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--edition-dir" && i + 1 < argv.length) {
      args.editionDir = argv[i + 1];
      i++;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.editionDir) {
    console.error("Erro: --edition-dir obrigatório.");
    process.exit(1);
  }

  const editionDir = resolve(ROOT, args.editionDir);
  const editionDate = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop()!;

  const checks: OutputCheck[] = [
    {
      agent: "writer",
      path: resolve(editionDir, "_internal/02-draft.md"),
      resumeCmd: `/diaria-2-escrita ${editionDate} newsletter`,
    },
    {
      agent: "social-linkedin",
      path: resolve(editionDir, "_internal/03-linkedin.tmp.md"),
      resumeCmd: `/diaria-2-escrita ${editionDate} social`,
    },
    {
      agent: "social-facebook",
      path: resolve(editionDir, "_internal/03-facebook.tmp.md"),
      resumeCmd: `/diaria-2-escrita ${editionDate} social`,
    },
  ];

  const failures: { check: OutputCheck; reason: string }[] = [];

  for (const check of checks) {
    if (!existsSync(check.path)) {
      failures.push({ check, reason: "ausente" });
      continue;
    }
    const size = statSync(check.path).size;
    if (size === 0) {
      failures.push({ check, reason: "vazio (0 bytes)" });
    }
  }

  if (failures.length === 0) {
    console.log("validate-stage-2-outputs: OK — 3/3 agents escreveram outputs.");
    process.exit(0);
  }

  console.error(
    `validate-stage-2-outputs: FALHOU — ${failures.length}/${checks.length} agent(s) com output inválido:\n`,
  );
  for (const { check, reason } of failures) {
    console.error(`  - ${check.agent}: ${check.path} ${reason}`);
    console.error(`    Re-rodar: ${check.resumeCmd}`);
  }
  console.error(
    `\nNão prosseguir com merge ou Clarice — outputs incompletos resultam em edição quebrada.`,
  );
  process.exit(1);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
