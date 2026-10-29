#!/usr/bin/env -S npx tsx
/**
 * scripts/lib/gh-pr-safe-edit.ts (#6292)
 *
 * `gh pr edit --body`/`--add-label` roda uma mutação GraphQL que consulta
 * `projectCards` (campo DEPRECADO do GitHub) ao montar o request — e falha
 * NESSA consulta, não na edição em si, imprimindo um aviso em stderr sobre
 * `projectCards`/Projects (classic) e saindo com **exit 0** mesmo assim. O
 * corpo/label do PR fica INALTERADO. Medido ao vivo 2× na rodada
 * `/diaria-overnight` 260826: `gh pr edit 6290 --body-file ...` (corpo) e
 * `gh pr edit 6257 --add-label no-regression-test` (label) — os dois
 * reportaram sucesso sem mudar nada (`gh pr view --json body|labels`
 * confirmou o estado pré-chamada intocado nos dois casos).
 *
 * Isto quebra justamente o caminho do #5010 (marcador `Closes`/`REFS` por
 * issue no corpo do PR, guard "antes do merge" da SKILL do overnight): o
 * coordenador detecta um `Closes` superdimensionado, "corrige" via `gh pr
 * edit`, o comando reporta sucesso, e o merge fecha uma issue que não devia
 * fechar — silenciosamente, porque não há nenhum sinal de erro além de uma
 * linha de stderr sobre um campo deprecado que ninguém lê como "sua edição
 * falhou".
 *
 * A escrita funciona normalmente pela API REST (`PATCH /repos/{o}/{r}/pulls/{n}`
 * pro corpo, `POST /repos/{o}/{r}/issues/{n}/labels` pras labels) — é o que
 * este módulo usa, SEMPRE seguido de releitura pós-escrita comparando o
 * valor esperado contra o que o GitHub de fato gravou. Se a releitura não
 * bater, a função falha alto (`ok: false` + `error` explicando o que foi
 * pedido vs. o que foi lido de volta) — nunca reporta sucesso sem confirmar.
 *
 * `gh api repos/{owner}/{repo}/...` aceita os placeholders `{owner}`/`{repo}`
 * literalmente quando rodado dentro do checkout do repo (o `gh` os resolve
 * a partir do remote `origin`) — não precisamos descobrir o slug à mão.
 *
 * **#10618 (fatia 4, review B):** PR de OUTRO repo da allowlist
 * (`vjpixel/diaria-design`) precisa de `repo` explícito (`--repo owner/name`
 * no CLI): sem ele, os placeholders e o `gh pr view` sem `-R` resolveriam o
 * PR #N do diaria-studio a partir do cwd — e a escrita cairia no PR errado.
 * Com `repo`, todo caminho vira `repos/{repo}/...` e toda leitura `-R repo`.
 *
 * Mesmo padrão de dependency injection de `scripts/route-issue.ts`/
 * `scripts/lib/wait-until-sync.ts`/`scripts/lib/alarm-issues.ts`: `ghRun`
 * injetável (default `spawnGhSync`), testável sem `gh`/rede real.
 */
import { spawnGhSync, type GhSpawnResult } from "./shared/gh-run.ts";
import { isMainModule, parseArgs } from "./cli-args.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prLabelInRepo, resolveRepoFlag } from "./issue-repos.ts";

/**
 * Raiz do checkout do diaria-studio ONDE ESTE SCRIPT MORA (review 2, item 5
 * da #10618): a allowlist `issue_repos` vem do `platform.config.json` daqui,
 * não do cwd — o helper é rodado de dentro do worktree do diaria-design
 * (`--repo vjpixel/diaria-design`), que não tem esse config, e resolver pelo
 * cwd recusaria o repo legítimo.
 */
export const SAFE_EDIT_CONFIG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `--repo` do CLI resolvido contra a allowlist do checkout do script. */
export function resolveSafeEditRepo(
  values: Record<string, string | undefined>,
  flags: ReadonlySet<string>,
  configRoot: string = SAFE_EDIT_CONFIG_ROOT,
): { repo: string | undefined } | { error: string } {
  return resolveRepoFlag(values, flags, configRoot);
}

export type GhRunFn = (args: string[], cwd: string) => GhSpawnResult;

export interface SafeEditResult {
  ok: boolean;
  error?: string;
}

/** `repos/{owner}/{repo}` (do remote do cwd) ou `repos/owner/name` explícito. */
function repoPath(repo?: string): string {
  return `repos/${repo ?? "{owner}/{repo}"}`;
}

/** `-R owner/name` quando o PR é de outro repo; vazio no default. */
function repoArgs(repo?: string): string[] {
  return repo ? ["-R", repo] : [];
}

/**
 * Sobrescreve o corpo de um PR via REST + verifica pós-escrita. Nunca usa
 * `gh pr edit` — ver docstring do módulo pro porquê.
 */
export function setPrBodyRest(
  pr: number,
  body: string,
  cwd: string,
  ghRun: GhRunFn = spawnGhSync,
  repo?: string,
): SafeEditResult {
  const write = ghRun(
    ["api", "-X", "PATCH", `${repoPath(repo)}/pulls/${pr}`, "-f", `body=${body}`],
    cwd,
  );
  if (write.status !== 0) {
    return { ok: false, error: `gh api PATCH pulls/${pr} falhou: ${write.stderr.trim() || write.stdout.trim() || "sem saída"}` };
  }

  const verify = ghRun(["pr", "view", String(pr), ...repoArgs(repo), "--json", "body", "--jq", ".body"], cwd);
  if (verify.status !== 0) {
    return { ok: false, error: `escrita OK mas releitura pós-escrita falhou: ${verify.stderr.trim() || "gh pr view falhou"}` };
  }
  // `gh --jq .body` devolve a string com um `\n` final — normalizar antes de comparar.
  const readBack = verify.stdout.replace(/\n$/, "");
  if (readBack !== body) {
    return {
      ok: false,
      error:
        `PATCH reportou sucesso (exit 0) mas o corpo lido de volta NÃO bate com o esperado — ` +
        `mesmo modo de falha silenciosa que este módulo existe pra evitar (#6292). ` +
        `Esperado ${body.length} chars, lido ${readBack.length} chars.`,
    };
  }
  return { ok: true };
}

/**
 * Aplica labels a um PR via REST (endpoint de labels é compartilhado com
 * issues — PRs SÃO issues na API do GitHub) + verifica pós-escrita. Nunca
 * usa `gh pr edit --add-label` — mesmo modo de falha do corpo, confirmado
 * ao vivo com a label `no-regression-test` no PR #6257 (#6292).
 */
export function addPrLabelsRest(
  pr: number,
  labels: readonly string[],
  cwd: string,
  ghRun: GhRunFn = spawnGhSync,
  repo?: string,
): SafeEditResult {
  if (labels.length === 0) return { ok: true };

  const args = ["api", "-X", "POST", `${repoPath(repo)}/issues/${pr}/labels`];
  for (const label of labels) args.push("-f", `labels[]=${label}`);
  const write = ghRun(args, cwd);
  if (write.status !== 0) {
    return { ok: false, error: `gh api POST issues/${pr}/labels falhou: ${write.stderr.trim() || write.stdout.trim() || "sem saída"}` };
  }

  const verify = ghRun(["pr", "view", String(pr), ...repoArgs(repo), "--json", "labels", "--jq", ".labels[].name"], cwd);
  if (verify.status !== 0) {
    return { ok: false, error: `escrita OK mas releitura pós-escrita falhou: ${verify.stderr.trim() || "gh pr view falhou"}` };
  }
  const current = new Set(
    verify.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const missing = labels.filter((l) => !current.has(l));
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `POST reportou sucesso (exit 0) mas ${missing.length} label(s) não apareceram na releitura: ` +
        `${missing.join(", ")} — mesmo modo de falha silenciosa que este módulo existe pra evitar (#6292).`,
    };
  }
  return { ok: true };
}

// ─── Corpo cita as issues da PR (#10698) ─────────────────────────────────
//
// Rodada overnight 261021: dois implementadores paralelos usaram o mesmo nome
// de arquivo temporário pro corpo de PR, e as PRs #10643/#10644 nasceram com o
// corpo uma da outra. O sinal mecânico desse cruzamento é o corpo não citar a
// issue da própria branch (`Closes #N` ou `REFS #N`): é isso que estas funções
// conferem, antes de escrever (`--body-file`) ou logo depois do `gh pr create`
// (`--verify-body`).

/**
 * Números de issue que o nome da branch declara, pela convenção das trilhas
 * autônomas (`overnight/fix-N-slug`, `develop/fix-N`, `develop/blast-N`,
 * `continuo/fix-N-slug`, `feat-N`). Branch de lote (`overnight/batch-{slug}`)
 * não carrega número: devolve `[]` e a conferência precisa de `--issues`.
 */
export function issuesFromBranch(branch: string): number[] {
  const out: number[] = [];
  for (const m of branch.matchAll(/(?:^|[/-])(?:fix|feat|blast)-(\d+)(?!\d)/g)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Issues de `issues` que o corpo NÃO cita com marcador de fechamento
 * (`closes`/`fixes`/`resolves #N`) nem com `REFS #N`. Case-insensitive;
 * `#77` nunca casa com `#7788`.
 */
export function issuesMissingFromBody(body: string, issues: readonly number[]): number[] {
  return issues.filter((n) => {
    const re = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs)\\s+#${n}(?!\\d)`, "i");
    return !re.test(body);
  });
}

/**
 * Resolve as issues esperadas: `explicit` (de `--issues`) quando dado, senão
 * as do nome da branch da PR (`gh pr view N --json headRefName`). Falha de
 * consulta é erro (fail-closed): sem saber a branch não dá pra confirmar que o
 * corpo é desta PR.
 */
export function resolveExpectedIssues(
  pr: number,
  explicit: readonly number[] | null,
  cwd: string,
  ghRun: GhRunFn = spawnGhSync,
  repo?: string,
): { ok: true; issues: number[]; branch?: string } | { ok: false; error: string } {
  if (explicit && explicit.length > 0) return { ok: true, issues: [...explicit] };
  const r = ghRun(["pr", "view", String(pr), ...repoArgs(repo), "--json", "headRefName", "--jq", ".headRefName"], cwd);
  if (r.status !== 0) {
    return { ok: false, error: `não consegui ler a branch da ${prLabelInRepo(pr, repo)}: ${r.stderr.trim() || "gh pr view falhou"} — passe --issues N,M` };
  }
  const branch = r.stdout.trim();
  return { ok: true, issues: issuesFromBranch(branch), branch };
}

/** Confere o corpo contra as issues esperadas. Lista vazia = nada a conferir (ok). */
export function checkBodyCitesIssues(body: string, issues: readonly number[]): SafeEditResult {
  const missing = issuesMissingFromBody(body, issues);
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    error:
      `o corpo não cita ${missing.map((n) => `#${n}`).join(", ")} com \`Closes #N\` nem \`REFS #N\` — ` +
      `provável corpo de OUTRA PR (arquivo temporário de nome comum sobrescrito por outro implementador, #10698). ` +
      `Confira o arquivo; se a omissão é intencional, passe --allow-missing-issue-marker.`,
  };
}

// ─── HEAD da PR = HEAD local (#11566) ────────────────────────────────────
//
// /diaria-develop 261029: a branch `develop/fix-11467` da PR #11480 (mergeada
// por squash, sem `--delete-branch`, de propósito — ver "--delete-branch troca
// a checkout") ficou no remoto. A 2ª PR da mesma issue reaproveitou o nome, o
// `git push -u` foi recusado como non-fast-forward (só um `hint:` no stderr)
// e o `gh pr create` abriu a #11528 em cima do commit ANTIGO. O corpo citava a
// issue certa, então a conferência do #10698 passava. O sinal mecânico é o
// `headRefOid` da PR diferente do `HEAD` do checkout que acabou de abri-la.

/** Runner de `git` injetável (default: `spawnGhSync` com `bin = "git"`). */
export type GitRunFn = (args: string[], cwd: string) => GhSpawnResult;

const defaultGitRun: GitRunFn = (args, cwd) => spawnGhSync(args, cwd, undefined, "git");

export type HeadCheck =
  | { status: "match"; oid: string }
  /** O checkout local está noutra branch: não é o checkout da PR, nada a comparar. */
  | { status: "other-branch"; prBranch: string; localBranch: string }
  | { status: "mismatch"; branch: string; prOid: string; localOid: string }
  /** O diretório não é checkout git (ex.: cwd sem `.git`): nada a comparar. */
  | { status: "no-local-checkout"; dir: string; reason: string };

/** Comparação pura: mesma branch e mesmo commit → `match`. */
export function compareHeadWithLocal(
  pr: { branch: string; oid: string },
  local: { branch: string; oid: string },
): HeadCheck {
  if (pr.branch !== local.branch) {
    return { status: "other-branch", prBranch: pr.branch, localBranch: local.branch };
  }
  if (pr.oid.toLowerCase() !== local.oid.toLowerCase()) {
    return { status: "mismatch", branch: pr.branch, prOid: pr.oid, localOid: local.oid };
  }
  return { status: "match", oid: pr.oid };
}

/**
 * Lê `headRefName`/`headRefOid` da PR e o `HEAD` do checkout `localDir` e
 * compara. O git é lido primeiro: `localDir` que não é checkout git devolve
 * `no-local-checkout` sem consultar o gh (nada a comparar). Falha do gh é
 * erro (fail-closed, como em `resolveExpectedIssues`).
 */
export function checkPrHeadMatchesLocal(
  pr: number,
  cwd: string,
  localDir: string,
  ghRun: GhRunFn = spawnGhSync,
  gitRun: GitRunFn = defaultGitRun,
  repo?: string,
): { ok: true; check: HeadCheck } | { ok: false; error: string } {
  const branch = gitRun(["rev-parse", "--abbrev-ref", "HEAD"], localDir);
  const oid = gitRun(["rev-parse", "HEAD"], localDir);
  if (branch.status !== 0 || oid.status !== 0) {
    const reason = (branch.stderr || oid.stderr).trim() || "git rev-parse falhou";
    return { ok: true, check: { status: "no-local-checkout", dir: localDir, reason } };
  }
  const view = ghRun(
    ["pr", "view", String(pr), ...repoArgs(repo), "--json", "headRefName,headRefOid", "--jq", '.headRefName + " " + .headRefOid'],
    cwd,
  );
  if (view.status !== 0) {
    return { ok: false, error: `não consegui ler o HEAD da ${prLabelInRepo(pr, repo)}: ${view.stderr.trim() || "gh pr view falhou"}` };
  }
  const [prBranch, prOid] = view.stdout.trim().split(/\s+/);
  if (!prBranch || !prOid) {
    return { ok: false, error: `resposta inesperada do gh para headRefName/headRefOid: "${view.stdout.trim()}"` };
  }
  return {
    ok: true,
    check: compareHeadWithLocal({ branch: prBranch, oid: prOid }, { branch: branch.stdout.trim(), oid: oid.stdout.trim() }),
  };
}

/** Mensagem de erro do `mismatch` (exportada para o teste travar o texto útil). */
export function headMismatchError(pr: number, check: Extract<HeadCheck, { status: "mismatch" }>, repo?: string): string {
  return (
    `a ${prLabelInRepo(pr, repo)} aponta para ${check.prOid.slice(0, 9)}, mas o HEAD local da branch ` +
    `${check.branch} é ${check.localOid.slice(0, 9)} — o push não chegou ao remoto. O caso típico é push recusado ` +
    `(non-fast-forward) porque a branch remota sobrou de uma PR anterior já mergeada (#11566): feche esta PR, ` +
    `crie uma branch de nome novo (sufixo -2) e reabra; nunca force-push sobre branch de PR alheia.`
  );
}

/** `"10698,10699"` → `[10698, 10699]`; `null` se ausente/vazio; lança se algum item não é inteiro positivo. */
export function parseIssuesFlag(raw: string | undefined): number[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  return raw.split(",").map((s) => {
    const n = Number(s.trim().replace(/^#/, ""));
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--issues inválido: "${s}"`);
    return n;
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────

function usage(): string {
  return (
    "Uso:\n" +
    "  npx tsx scripts/lib/gh-pr-safe-edit.ts --pr N [--repo owner/name] --body-file arquivo.md [--issues N,M] [--allow-missing-issue-marker]\n" +
    "  npx tsx scripts/lib/gh-pr-safe-edit.ts --pr N [--repo owner/name] --verify-body [--issues N,M] [--worktree DIR]\n" +
    "  npx tsx scripts/lib/gh-pr-safe-edit.ts --pr N [--repo owner/name] --add-label a,b,c\n" +
    "--repo: PR de outro repo de issue_repos (ex.: vjpixel/diaria-design, #10618); sem ele, o repo do cwd.\n" +
    "Substitui `gh pr edit --body`/`--add-label` (falha em silêncio, #6292) por REST + verificação pós-escrita.\n" +
    "--body-file recusa corpo que não cita (Closes/REFS) as issues da PR — da branch, ou de --issues (#10698).\n" +
    "--verify-body confere o corpo ATUAL da PR do mesmo jeito; rodar logo após `gh pr create`.\n" +
    "  Também confere que o headRefOid da PR é o HEAD local (#11566) — do checkout em --worktree (default cwd);\n" +
    "  checkout em outra branch ou fora do git só gera aviso."
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const { values, flags } = parseArgs(argv);
  const prRaw = values.pr;
  const pr = prRaw ? Number(prRaw) : NaN;
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error(`[gh-pr-safe-edit] --pr é obrigatório e precisa ser um inteiro positivo.\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  // #10618 (fatia 4, review B): PR de outro repo da allowlist. Sem `--repo`,
  // tudo resolve pelo remote do cwd (o diaria-studio). A allowlist vem do
  // checkout do script, não do cwd (review 2, item 5).
  const repoFlag = resolveSafeEditRepo(values, flags);
  if ("error" in repoFlag) {
    console.error(`[gh-pr-safe-edit] ${repoFlag.error}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  const repo = repoFlag.repo;

  let explicitIssues: number[] | null;
  try {
    explicitIssues = parseIssuesFlag(values.issues);
  } catch (e) {
    console.error(`[gh-pr-safe-edit] ${(e as Error).message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  // Conferência do corpo contra as issues da PR (#10698). Devolve `null` se ok.
  const citesCheck = (body: string): SafeEditResult | null => {
    const expected = resolveExpectedIssues(pr, explicitIssues, cwd, spawnGhSync, repo);
    if (!expected.ok) return { ok: false, error: expected.error };
    if (expected.issues.length === 0) {
      console.error(
        `[gh-pr-safe-edit] aviso: branch ${expected.branch ?? "?"} não declara issue (lote?) — corpo não conferido; passe --issues N,M para conferir (#10698).`,
      );
      return null;
    }
    const check = checkBodyCitesIssues(body, expected.issues);
    return check.ok ? null : check;
  };

  if (flags.has("verify-body")) {
    const view = spawnGhSync(["pr", "view", String(pr), ...repoArgs(repo), "--json", "body", "--jq", ".body"], cwd);
    if (view.status !== 0) {
      console.log(JSON.stringify({ ok: false, error: `gh pr view falhou: ${view.stderr.trim() || "sem saída"}` }));
      process.exitCode = 1;
      return;
    }
    const bodyResult = citesCheck(view.stdout) ?? { ok: true };
    // #11566: o corpo pode estar certo e a PR apontar para um commit antigo
    // (push recusado em branch que sobrou de PR mergeada). Compara o HEAD da PR
    // com o do checkout que a abriu (`--worktree`, default cwd).
    const localDir = values.worktree ? resolve(values.worktree) : cwd;
    const head = checkPrHeadMatchesLocal(pr, cwd, localDir, spawnGhSync, defaultGitRun, repo);
    const errors: string[] = [];
    if (!bodyResult.ok && bodyResult.error) errors.push(bodyResult.error);
    if (!head.ok) {
      errors.push(head.error);
    } else if (head.check.status === "mismatch") {
      errors.push(headMismatchError(pr, head.check, repo));
    } else if (head.check.status === "other-branch") {
      console.error(
        `[gh-pr-safe-edit] aviso: ${localDir} está na branch ${head.check.localBranch}, não na ${head.check.prBranch} da PR — HEAD não conferido; passe --worktree <checkout da PR> (#11566).`,
      );
    } else if (head.check.status === "no-local-checkout") {
      console.error(
        `[gh-pr-safe-edit] aviso: ${localDir} não é checkout git (${head.check.reason}) — HEAD da PR não conferido; passe --worktree <checkout da PR> (#11566).`,
      );
    }
    const result: SafeEditResult & { head?: string } =
      errors.length === 0 ? { ok: true } : { ok: false, error: errors.join(" | ") };
    if (head.ok) result.head = head.check.status;
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (values["body-file"]) {
    const { readFileSync } = await import("node:fs");
    const body = readFileSync(values["body-file"], "utf8");
    if (!flags.has("allow-missing-issue-marker")) {
      const refused = citesCheck(body);
      if (refused) {
        console.log(JSON.stringify(refused));
        process.exitCode = 1;
        return;
      }
    }
    const result = setPrBodyRest(pr, body, cwd, spawnGhSync, repo);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (values["add-label"]) {
    const labels = values["add-label"]
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    const result = addPrLabelsRest(pr, labels, cwd, spawnGhSync, repo);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.error(`[gh-pr-safe-edit] nada a fazer — passe --body-file ou --add-label.\n\n${usage()}`);
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main();
}
