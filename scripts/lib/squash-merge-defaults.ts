/**
 * scripts/lib/squash-merge-defaults.ts (#13563)
 *
 * Mensagem padrão do squash merge nos repos do editor. Com a configuração de
 * fábrica do GitHub (`squash_merge_commit_title=COMMIT_OR_PR_TITLE`,
 * `squash_merge_commit_message=COMMIT_MESSAGES`), a descrição do commit de
 * squash é a concatenação das mensagens de TODOS os commits da PR. Como todo
 * commit feito pelo Claude Code termina com `Co-Authored-By: ...`, uma PR de
 * N commits gera N trailers iguais, além dos títulos dos commits
 * intermediários ("fix do review"). Medido em 18/11/2026 no master: 101 dos
 * 400 últimos commits repetem a mesma linha `Co-Authored-By` (até 7 vezes),
 * de merges pelo caminho padrão (UI, `gh pr merge --squash` sem `--body`).
 *
 * O trem de merge (`run-merge-train.ts`) não sofre disso: passa `--subject` e
 * `--body` explícitos, e `buildSoloSquashBody` (`merge-train.ts`) já
 * deduplica os trailers de atribuição (#11236). Os outros caminhos não
 * conseguem passar um body montado: o guard do #5716 só aceita `--body "…"`
 * de uma linha, sem quebra real; a UI e o `continuo-pr-review.sh` usam o
 * padrão do repo. Por isso a correção é a configuração do repo, e este módulo
 * decide, sem I/O, o que precisa mudar.
 *
 * Alvo: `PR_TITLE` + `PR_BODY` (o corpo da PR já traz o resumo e o
 * `Closes #N` que os gates conferem, #5010). Efeitos colaterais, aceitos:
 * - o `Closes` deixa de poder vir de um commit intermediário (fonte do
 *   #11190): melhora;
 * - os trailers `This reverts commit <sha>.` e `Co-Authored-By:` dos
 *   commits deixam de entrar pelo caminho padrão (o trem segue trazendo os
 *   dois). A atribuição aparece se o corpo da PR a tiver.
 */

export const SQUASH_TITLE_TARGET = "PR_TITLE";
export const SQUASH_MESSAGE_TARGET = "PR_BODY";

/** Repos do editor conferidos na #13563 (todos com o padrão de fábrica). */
export const DEFAULT_SQUASH_REPOS: readonly string[] = [
  "vjpixel/diaria-studio",
  "vjpixel/tekoa",
  "vjpixel/edicao-video",
  "vjpixel/humanizador",
  "vjpixel/memelab",
  "vjpixel/clarice-mcp-plugin",
  "vjpixel/claude-config",
];

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidRepoRef(repo: string): boolean {
  return REPO_RE.test(repo);
}

/** Campos relevantes de `GET /repos/{owner}/{repo}`. */
export interface SquashSettings {
  allow_squash_merge?: unknown;
  squash_merge_commit_title?: unknown;
  squash_merge_commit_message?: unknown;
}

export type SquashPlan =
  | { repo: string; verdict: "ok" }
  | { repo: string; verdict: "change"; from: { title: string; message: string } }
  | { repo: string; verdict: "squash-disabled" }
  | { repo: string; verdict: "unreadable"; reason: string };

/**
 * Veredito para um repo a partir do JSON da API. Campo ausente ou de tipo
 * errado sai `unreadable`, nunca `ok`: sem ler o valor atual não há como
 * afirmar que o repo já está certo (#573).
 */
export function planSquashDefaults(repo: string, settings: SquashSettings | null | undefined): SquashPlan {
  if (!settings || typeof settings !== "object") return { repo, verdict: "unreadable", reason: "resposta vazia" };
  if (settings.allow_squash_merge === false) return { repo, verdict: "squash-disabled" };
  const title = settings.squash_merge_commit_title;
  const message = settings.squash_merge_commit_message;
  if (typeof title !== "string" || typeof message !== "string") {
    return { repo, verdict: "unreadable", reason: "squash_merge_commit_title/message ausentes (token sem acesso de admin?)" };
  }
  if (title === SQUASH_TITLE_TARGET && message === SQUASH_MESSAGE_TARGET) return { repo, verdict: "ok" };
  return { repo, verdict: "change", from: { title, message } };
}

/** Argumentos do `gh api` que aplica o alvo num repo. */
export function buildSquashPatchArgs(repo: string): string[] {
  if (!isValidRepoRef(repo)) throw new Error(`repo inválido: ${repo}`);
  return [
    "api",
    "-X",
    "PATCH",
    `repos/${repo}`,
    "-f",
    `squash_merge_commit_title=${SQUASH_TITLE_TARGET}`,
    "-f",
    `squash_merge_commit_message=${SQUASH_MESSAGE_TARGET}`,
  ];
}

/** Argumentos do `gh api` que lê a configuração atual de um repo. */
export function buildSquashReadArgs(repo: string): string[] {
  if (!isValidRepoRef(repo)) throw new Error(`repo inválido: ${repo}`);
  return ["api", `repos/${repo}`];
}
