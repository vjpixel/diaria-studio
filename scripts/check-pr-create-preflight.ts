#!/usr/bin/env npx tsx
/**
 * scripts/check-pr-create-preflight.ts (#14216)
 *
 * Chamado pelo hook PreToolUse `.claude/hooks/block-pr-create-preflight.mjs`
 * antes de cada `gh pr create` do diaria-studio. Confere, no checkout onde ele
 * mora (o worktree da PR):
 *
 * 1. `docs/editorial-invariants.md` igual ao markdown gerado do registry
 *    (`generateInvariantsMarkdown`, o mesmo do `list-invariants.ts --check`);
 * 2. diff `BASE...HEAD` (merge-base, como o gate do CI, #9403) acima de 500
 *    adições sem `removal-declaration:` no corpo (#7115).
 *
 * Decisão pura em `scripts/lib/pr-create-preflight.ts`.
 *
 * Uso:
 *   npx tsx scripts/check-pr-create-preflight.ts [--base origin/master] [--body-stdin | --body-file F]
 *       [--body-unknown MOTIVO]   (ou DIARIA_PREFLIGHT_BODY_UNKNOWN no ambiente)
 *
 * Sem `--body-stdin`/`--body-file`, o corpo conta como não determinável
 * (`--body-unknown` diz por quê): a falta da declaração vira aviso.
 *
 * Saída: JSON `{ deny, warn, removal }` no stdout.
 * Exit: 0 = nada a negar (pode haver aviso); 1 = negar; 2 = uso inválido.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { getDiffLineStats, type DiffLineStats } from "./lib/diff-line-stats.ts";
import {
  INVARIANTS_DOC_PATH,
  compareInvariantsDoc,
  decidePrCreatePreflight,
  type InvariantsDocStatus,
  type PrCreatePreflightResult,
} from "./lib/pr-create-preflight.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function invariantsStatus(root: string): Promise<InvariantsDocStatus> {
  try {
    // Import dinâmico: um registry que não carrega (erro de módulo) vira aviso, não exceção do guard.
    const { generateInvariantsMarkdown } = await import("./list-invariants.ts");
    const path = resolve(root, INVARIANTS_DOC_PATH);
    return compareInvariantsDoc(generateInvariantsMarkdown(), existsSync(path) ? readFileSync(path, "utf8") : null);
  } catch (e) {
    return { status: "unavailable", detail: (e as Error).message.slice(0, 300) };
  }
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export async function runPreflight(argv: string[], root = ROOT): Promise<{ code: number; result: PrCreatePreflightResult }> {
  const { values, flags } = parseArgs(argv);
  const base = values["base"] ?? "origin/master";

  let body: string | null = null;
  // O hook passa o motivo por ambiente: o spawn usa shell (npx .cmd no Windows) e o texto tem espaço.
  let bodyUnknownReason: string | null = values["body-unknown"] ?? process.env.DIARIA_PREFLIGHT_BODY_UNKNOWN ?? "corpo não informado ao guard";
  if (flags.has("body-stdin")) {
    body = readStdin();
    bodyUnknownReason = null;
  } else if (values["body-file"]) {
    try {
      body = readFileSync(resolve(values["body-file"]), "utf8");
      bodyUnknownReason = null;
    } catch (e) {
      bodyUnknownReason = `--body-file ilegível: ${(e as Error).message}`;
    }
  }

  let stats: DiffLineStats | null = null;
  let statsError: string | null = null;
  try {
    stats = getDiffLineStats(base, "HEAD", { cwd: root, mergeBase: true });
  } catch (e) {
    statsError = (e as Error).message.slice(0, 300);
  }

  const result = decidePrCreatePreflight({
    invariants: await invariantsStatus(root),
    stats,
    statsError,
    body,
    bodyUnknownReason,
  });
  return { code: result.deny.length ? 1 : 0, result };
}

if (isMainModule(import.meta.url)) {
  runPreflight(process.argv.slice(2)).then(
    ({ code, result }) => {
      process.stdout.write(JSON.stringify(result) + "\n");
      process.exit(code);
    },
    (e) => {
      console.error("check-pr-create-preflight:", e instanceof Error ? e.message : e);
      process.exit(2);
    },
  );
}
