/**
 * lint-agent-md.ts (#297)
 *
 * Rejeita `${VAR:+...}`, `${VAR:-...}`, `${VAR}` em blocos bash dentro de
 * `.claude/agents/*.md` quando VAR é uma input variable do agent (não env var real).
 *
 * Problema: agent inputs (ex: `schedule_day_offset`) são variáveis do Claude, não
 * env vars do shell. Usar `${schedule_day_offset:+--day-offset $schedule_day_offset}`
 * em bash block do .md silently falha em runtime — shell não conhece a var.
 *
 * Uso:
 *   npx tsx scripts/lint-agent-md.ts [--dir .claude/agents]
 *
 * Exit codes:
 *   0 = sem erros
 *   1 = erros encontrados
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Env vars do sistema que são legítimas em blocos bash — não flagar essas.
const ALLOWED_ENV_VARS = new Set([
  "HOME", "PATH", "USER", "TMPDIR", "TMP", "TEMP", "SHELL",
  "PWD", "OLDPWD", "LOGNAME", "HOSTNAME", "TERM",
  "NODE_ENV", "BEEHIIV_API_KEY", "BEEHIIV_PUBLICATION_ID",
  "FACEBOOK_PAGE_ACCESS_TOKEN", "GEMINI_API_KEY",
  "CLARICE_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "EDITION", "PREV_POST_ID", // vars setadas com command substitution no mesmo bloco
]);

interface LintError {
  file: string;
  line: number;
  var_name: string;
  pattern: string;
  message: string;
}

/**
 * Extrai input variables de um arquivo .md de agent. Procura por linhas como:
 *   - `schedule_day_offset`: optional — ...
 *   - `edition_dir`: ex: `data/editions/...`
 */
function extractInputVars(content: string): Set<string> {
  const vars = new Set<string>();
  // Procura em seções ## Input, ## Entrada, ## Argumentos, e similares
  const backtickVar = /`([a-z][a-z0-9_]+)`/g;
  for (const m of content.matchAll(backtickVar)) {
    const name = m[1];
    // Só vars snake_case que parecem input (não paths, comandos, etc.)
    if (/^[a-z][a-z0-9_]{2,}$/.test(name) && !name.includes("_ts_") && name !== "null") {
      vars.add(name);
    }
  }
  return vars;
}

/**
 * Extrai blocos ```bash...``` de um arquivo .md.
 */
function extractBashBlocks(content: string): Array<{ start_line: number; code: string }> {
  const blocks: Array<{ start_line: number; code: string }> = [];
  const lines = content.split("\n");
  let inBlock = false;
  let blockStart = 0;
  const blockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock && /^```bash\s*$/.test(line)) {
      inBlock = true;
      blockStart = i + 1;
      blockLines.length = 0;
    } else if (inBlock && /^```\s*$/.test(line)) {
      inBlock = false;
      blocks.push({ start_line: blockStart, code: blockLines.join("\n") });
    } else if (inBlock) {
      blockLines.push(line);
    }
  }
  return blocks;
}

function lintFile(filePath: string): LintError[] {
  const content = readFileSync(filePath, "utf8");
  const inputVars = extractInputVars(content);
  const bashBlocks = extractBashBlocks(content);
  const errors: LintError[] = [];
  const relPath = filePath.replace(ROOT + "/", "").replace(ROOT + "\\", "");

  for (const block of bashBlocks) {
    const lines = block.code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = block.start_line + i;

      // Detectar ${VAR}, ${VAR:+...}, ${VAR:-...}
      const expansionRe = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)([^}]*)}/g;
      for (const m of line.matchAll(expansionRe)) {
        const varName = m[1];
        const modifier = m[2];
        const fullPattern = m[0];

        // Pular vars de env system
        if (ALLOWED_ENV_VARS.has(varName)) continue;
        // Pular vars de loop ($var sem expansão complexa) — só flagar ${VAR:+/-}
        if (modifier && !modifier.startsWith(":") && modifier !== "") continue;

        // Verificar se é uma input variable do agent
        if (inputVars.has(varName.toLowerCase())) {
          const suggestion =
            modifier.startsWith(":+")
              ? `Use an inline if instead: if [ -n "$VAR" ]; then ... fi`
              : `Agent inputs are Claude variables, not shell env vars — cannot use \${${varName}} in bash blocks`;
          errors.push({
            file: relPath,
            line: lineNum,
            var_name: varName,
            pattern: fullPattern,
            message: `${fullPattern} — '${varName}' é input variable do agent, não env var do shell. ${suggestion} (#297)`,
          });
        }
      }
    }
  }
  return errors;
}

function main() {
  const args = process.argv.slice(2);
  const agentsDir = resolve(ROOT, args.find((a, i) => args[i - 1] === "--dir") ?? ".claude/agents");

  let files: string[];
  try {
    files = readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(agentsDir, f));
  } catch (e) {
    console.error(`lint-agent-md: cannot read ${agentsDir}: ${(e as Error).message}`);
    process.exit(1);
  }

  const allErrors: LintError[] = [];
  for (const f of files) {
    allErrors.push(...lintFile(f));
  }

  if (allErrors.length === 0) {
    console.log(`lint-agent-md: ${files.length} arquivos verificados, 0 erros.`);
    process.exit(0);
  }

  console.error(`lint-agent-md: ${allErrors.length} erro(s) encontrado(s) em ${files.length} arquivos:`);
  for (const err of allErrors) {
    console.error(`  ${err.file}:${err.line}: ${err.message}`);
  }
  console.log(JSON.stringify({ errors: allErrors }, null, 2));
  process.exit(1);
}

main();
