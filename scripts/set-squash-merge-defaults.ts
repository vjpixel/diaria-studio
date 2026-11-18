/**
 * scripts/set-squash-merge-defaults.ts (#13563)
 *
 * Troca a mensagem padrão do squash merge dos repos do editor para
 * `PR_TITLE` + `PR_BODY`, para o commit de squash deixar de repetir o
 * trailer `Co-Authored-By` uma vez por commit da PR. Racional e efeitos
 * colaterais: `scripts/lib/squash-merge-defaults.ts`.
 *
 * Uso:
 *   npx tsx scripts/set-squash-merge-defaults.ts                 # dry-run, repos padrão
 *   npx tsx scripts/set-squash-merge-defaults.ts --apply
 *   npx tsx scripts/set-squash-merge-defaults.ts --repos vjpixel/tekoa,vjpixel/memelab --apply
 *
 * Sem `--apply` só lê e imprime o plano. Com `--apply`, faz o PATCH nos
 * repos que precisam e relê cada um: o resultado vem da releitura, nunca do
 * 2xx do PATCH (#573). Idempotente.
 *
 * Saída: JSON com o veredito por repo. Exit 0 = todos `ok` (ou `change` em
 * dry-run); 1 = algum repo ilegível, com squash desligado, ou que não ficou
 * no alvo depois do `--apply`; 2 = uso incorreto.
 */
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { spawnGhSync, type GhSpawnResult } from "./lib/shared/gh-run.ts";
import {
  DEFAULT_SQUASH_REPOS,
  buildSquashPatchArgs,
  buildSquashReadArgs,
  isValidRepoRef,
  planSquashDefaults,
  type SquashPlan,
} from "./lib/squash-merge-defaults.ts";

export type GhRunner = (args: string[]) => GhSpawnResult;

const defaultRunner: GhRunner = (args) => spawnGhSync(args, process.cwd(), 30_000);

function readPlan(repo: string, gh: GhRunner): SquashPlan {
  const res = gh(buildSquashReadArgs(repo));
  if (res.status !== 0) return { repo, verdict: "unreadable", reason: (res.stderr || res.stdout).trim() || `gh saiu ${res.status}` };
  try {
    return planSquashDefaults(repo, JSON.parse(res.stdout));
  } catch (err) {
    return { repo, verdict: "unreadable", reason: `JSON inválido: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface RepoOutcome {
  repo: string;
  before: SquashPlan["verdict"];
  after?: SquashPlan["verdict"];
  from?: { title: string; message: string };
  error?: string;
}

export function main(argv: string[], gh: GhRunner = defaultRunner): number {
  const { flags, values } = parseArgs(argv);
  const apply = flags.has("apply");
  let repos: string[] = [...DEFAULT_SQUASH_REPOS];
  if (values.repos !== undefined) {
    repos = String(values.repos)
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    const bad = repos.filter((r) => !isValidRepoRef(r));
    if (repos.length === 0 || bad.length > 0) {
      console.error(`[set-squash-merge-defaults] --repos inválido: ${bad.join(", ") || "(vazio)"} (esperado owner/name,...)`);
      return 2;
    }
  }

  const outcomes: RepoOutcome[] = [];
  let failed = false;
  for (const repo of repos) {
    const plan = readPlan(repo, gh);
    const outcome: RepoOutcome = { repo, before: plan.verdict };
    if (plan.verdict === "change") outcome.from = plan.from;
    if (plan.verdict === "unreadable") outcome.error = plan.reason;
    if (plan.verdict === "unreadable" || plan.verdict === "squash-disabled") failed = true;
    if (apply && plan.verdict === "change") {
      const patch = gh(buildSquashPatchArgs(repo));
      const reread = readPlan(repo, gh);
      outcome.after = reread.verdict;
      if (reread.verdict !== "ok") {
        failed = true;
        outcome.error =
          patch.status !== 0
            ? `PATCH falhou: ${(patch.stderr || patch.stdout).trim()}`
            : `PATCH respondeu ${patch.status}, mas a releitura deu ${reread.verdict}`;
      }
    }
    outcomes.push(outcome);
  }
  console.log(JSON.stringify({ apply, outcomes }, null, 2));
  if (!apply && outcomes.some((o) => o.before === "change")) {
    console.error("[set-squash-merge-defaults] dry-run: rode com --apply para gravar.");
  }
  return failed ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
