#!/usr/bin/env npx tsx
/**
 * scripts/check-pr-create-preflight.ts (#14216)
 *
 * Chamado pelo hook PreToolUse `.claude/hooks/block-pr-create-preflight.mjs`
 * antes de cada `gh pr create` do diaria-studio. Confere, no checkout onde ele
 * mora (o worktree da PR):
 *
 * 1. `docs/editorial-invariants.md` DO COMMIT (`git show HEAD:...`) igual ao
 *    markdown gerado do registry (`generateInvariantsMarkdown`, o mesmo do
 *    `list-invariants.ts --check`). Documento certo na árvore e defasado no
 *    HEAD é "regenerado mas não commitado" (recusa); registry com mudança não
 *    commitada não deixa conferir o commit (aviso).
 * 2. diff `BASE...HEAD` (merge-base, como o gate do CI, #9403) acima de 500
 *    adições sem `removal-declaration:` no corpo (#7115).
 *
 * Decisão pura em `scripts/lib/pr-create-preflight.ts`.
 *
 * Uso:
 *   npx tsx scripts/check-pr-create-preflight.ts [--base origin/master] [--body-stdin | --body-file F]
 *       [--body-unknown MOTIVO] [--warn-only MOTIVO]
 *
 * `DIARIA_PREFLIGHT_BODY_UNKNOWN` no ambiente vale como `--body-unknown` (é
 * por onde o hook passa o motivo). Sem
 * `--body-stdin`/`--body-file`, o corpo conta como não determinável: a falta
 * da declaração vira aviso. `--warn-only` transforma recusa em aviso (o hook
 * usa quando o `gh pr create` tem `--head` de outra branch).
 *
 * Saída: JSON `{ deny, warn, removal, body_unknown_reason }` na última linha do stdout.
 * Exit: 0 = nada a negar (pode haver aviso); 1 = negar; 2 = erro inesperado.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { getDiffLineStats, type DiffLineStats } from "./lib/diff-line-stats.ts";
import {
  INVARIANTS_DOC_PATH,
  INVARIANTS_REGISTRY_PATHS,
  assessInvariantsDoc,
  decidePrCreatePreflight,
  type InvariantsDocStatus,
  type PrCreatePreflightResult,
} from "./lib/pr-create-preflight.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  // Mensagens do git em inglês: o `show` distingue "arquivo fora do commit" pelo texto.
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error?.message ?? "") };
}

async function invariantsStatus(root: string): Promise<InvariantsDocStatus> {
  try {
    // Import dinâmico: um registry que não carrega (erro de módulo) vira aviso, não exceção do guard.
    const { generateInvariantsMarkdown } = await import("./list-invariants.ts");
    const generated = generateInvariantsMarkdown();
    const show = git(["show", `HEAD:${INVARIANTS_DOC_PATH}`], root);
    const headDoc: string | null = show.status === 0 ? show.stdout : null;
    // Só "o arquivo não está no commit" conta como ausente; outra falha do git (não é repo, sem HEAD) é indisponível.
    if (show.status !== 0 && !/does not exist in|exists on disk, but not in/i.test(show.stderr)) {
      return { status: "unavailable", detail: `git show HEAD:${INVARIANTS_DOC_PATH} falhou: ${show.stderr.slice(0, 200)}` };
    }
    const status = git(["status", "--porcelain", "--", ...INVARIANTS_REGISTRY_PATHS], root);
    if (status.status !== 0) return { status: "unavailable", detail: `git status falhou: ${status.stderr.slice(0, 200)}` };
    const diskPath = resolve(root, INVARIANTS_DOC_PATH);
    return assessInvariantsDoc({
      generated,
      headDoc,
      diskDoc: existsSync(diskPath) ? readFileSync(diskPath, "utf8") : null,
      registryDirty: status.stdout.trim() !== "",
    });
  } catch (e) {
    return { status: "unavailable", detail: (e as Error).message.slice(0, 300) };
  }
}

export interface PreflightIo {
  /** Lê o corpo do stdin; lança quando o stdin não pode ser lido. */
  readStdin: () => string;
  /** Motivo do corpo não determinável vindo do hook (`DIARIA_PREFLIGHT_BODY_UNKNOWN`). */
  bodyUnknownFromEnv: () => string | undefined;
}

const defaultIo: PreflightIo = {
  readStdin: () => readFileSync(0, "utf8"),
  bodyUnknownFromEnv: () => process.env.DIARIA_PREFLIGHT_BODY_UNKNOWN,
};

export async function runPreflight(
  argv: string[],
  root = ROOT,
  io: PreflightIo = defaultIo,
): Promise<{ code: number; result: PrCreatePreflightResult & { body_unknown_reason: string | null } }> {
  const { values, flags } = parseArgs(argv);
  const base = values["base"] ?? "origin/master";

  let body: string | null = null;
  let bodyUnknownReason: string | null = values["body-unknown"] ?? io.bodyUnknownFromEnv() ??"corpo não informado ao guard";
  if (flags.has("body-stdin")) {
    try {
      body = io.readStdin();
      bodyUnknownReason = null;
    } catch (e) {
      bodyUnknownReason = `stdin ilegível: ${(e as Error).message}`;
    }
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
    warnOnlyReason: values["warn-only"] ?? null,
  });
  return { code: result.deny.length ? 1 : 0, result: { ...result, body_unknown_reason: body === null ? bodyUnknownReason : null } };
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
