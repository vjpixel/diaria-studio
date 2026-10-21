/**
 * #10689 — o guard de merge do #5716 (`block-gh-pr-merge-subagent.mjs`) só
 * reconhecia `gh pr merge`. Outros caminhos que mergeiam a PR passavam sem o
 * guard rodar:
 *
 *   gh api -X PUT repos/vjpixel/diaria-studio/pulls/123/merge -f merge_method=squash
 *   gh api graphql -f query='mutation { mergePullRequest(...) { ... } }'
 *   gh m 123   (com `gh alias set m 'pr merge'`)
 *
 * Tudo sintético: nenhum merge é executado; `data/sessions/` e o config do gh
 * vivem em diretórios temporários.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isGhPrMergeCommand,
  extractGhPrMergeTargetPr,
  findGhPrMergeInvocations,
  parseGhAliasesYaml,
} from "../.claude/hooks/lib/gh-pr-merge-command.mjs";

// Sem `.d.mts` nesses módulos: import por URL computada (mesmo padrão do teste do #10681).
type TargetRepoLib = {
  reposMentioned: (command: string, allowed?: Set<string>) => Set<string>;
  resolveMergeTargets: (
    command: string,
    cwd: string | undefined,
    opts?: { execFn?: () => string; allowed?: Set<string>; env?: Record<string, string> },
  ) => { mode: string; targets: string[]; grantRepo: string | null };
};
const targetRepo = (await import(
  new URL("../.claude/hooks/lib/gh-target-repo.mjs", import.meta.url).href
)) as TargetRepoLib;
const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  sessionsDir: (root: string) => string;
  machineTag: () => string;
};

/** Aliases fixos: o teste nunca depende do `config.yml` do gh da máquina. */
const ALIASES = new Map<string, string | null>([
  ["m", "pr merge"],
  ["mq", "pr merge --squash"],
  ["am", "api -X PUT repos/vjpixel/diaria-studio/pulls/$1/merge"],
  ["sm", "!gh pr merge $1 --squash"],
  ["co", "pr checkout"],
  ["pv", "pr view"],
  ["blk", null],
]);
const opts = { aliases: ALIASES };

/** [comando, PR alvo esperado] — todos mergeiam uma PR. */
const POSITIVES: Array<[string, number | undefined]> = [
  // REST: as formas da issue e do dispatch.
  ["gh api -X PUT repos/vjpixel/diaria-studio/pulls/123/merge -f merge_method=squash", 123],
  ["gh api --method PUT repos/vjpixel/diaria-studio/pulls/124/merge", 124],
  ["gh api --method=PUT repos/vjpixel/diaria-studio/pulls/125/merge", 125],
  ["gh api -XPUT repos/vjpixel/diaria-studio/pulls/126/merge", 126],
  ["gh api -X=PUT repos/o/r/pulls/127/merge", 127],
  ["gh api -X put repos/o/r/pulls/128/merge", 128],
  ["gh api -X PUT /repos/vjpixel/diaria-studio/pulls/129/merge", 129],
  ["gh api -X PUT repos/{owner}/{repo}/pulls/130/merge", 130],
  ["gh api -X PUT https://api.github.com/repos/vjpixel/diaria-studio/pulls/131/merge", 131],
  ["gh api -X PUT https://ghe.example.com/api/v3/repos/o/r/pulls/132/merge", 132],
  ["gh api -X PUT repos/o/r/pulls/133/merge/", 133],
  ["gh api -X PUT 'repos/o/r/pulls/134/merge?x=1'", 134],
  ["gh api -X POST repos/o/r/pulls/135/merge", 135],
  // Sem -X: com campo/corpo o gh usa POST — conta (fail-closed).
  ["gh api repos/o/r/pulls/136/merge -f merge_method=squash", 136],
  ["gh api repos/o/r/pulls/137/merge -F merge_method=squash", 137],
  ["gh api repos/o/r/pulls/138/merge --input body.json", 138],
  ["gh api repos/o/r/pulls/139/merge --raw-field=merge_method=squash", 139],
  // Flags antes do endpoint, cluster de flag curta.
  ["gh api -H 'Accept: application/vnd.github+json' -X PUT repos/o/r/pulls/140/merge", 140],
  ["gh api -iXPUT repos/o/r/pulls/141/merge", 141],
  ["gh api --hostname github.com -X PUT -- repos/o/r/pulls/142/merge", 142],
  // Prefixos/wrappers do #10681 continuam valendo.
  ["GH_TOKEN=x gh api -X PUT repos/o/r/pulls/143/merge", 143],
  ["env FOO=1 gh api -X PUT repos/o/r/pulls/144/merge", 144],
  ["command gh api -X PUT repos/o/r/pulls/145/merge", 145],
  ["/usr/bin/gh api -X PUT repos/o/r/pulls/146/merge", 146],
  ["gh.exe api -X PUT repos/o/r/pulls/147/merge", 147],
  ["timeout 30 gh api -X PUT repos/o/r/pulls/148/merge", 148],
  ["bash -c 'gh api -X PUT repos/o/r/pulls/149/merge'", 149],
  ["echo $(gh api -X PUT repos/o/r/pulls/150/merge)", 150],
  ["cd wt && gh api -X PUT repos/o/r/pulls/151/merge 2>&1 | tail -5", 151],
  // Nº/caminho opaco: conta como merge, PR indeterminada.
  ["gh api -X PUT repos/o/r/pulls/$N/merge", undefined],
  ["gh api -X PUT repos/o/r/pulls/{number}/merge", undefined],
  ['gh api -X PUT "$URL"', undefined],
  ['gh api -X PUT "$(echo repos/o/r/pulls/5/merge)"', undefined],
  ["gh api -X PATCH repos/o/r/pulls/$N -f x=1", undefined],
  ["gh api -X $METHOD repos/o/r/pulls/152/merge", 152],
  ["echo repos/o/r/pulls/5/merge | xargs gh api -X PUT", undefined],
  // GraphQL.
  [`gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_x", mergeMethod: SQUASH}) { clientMutationId } }'`, undefined],
  [`gh api graphql -f query='mutation($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }' -f id=PR_x`, undefined],
  [`gh api graphql -f query='mutation { enqueuePullRequest(input: {pullRequestId: "PR_x"}) { clientMutationId } }'`, undefined],
  [`gh api graphql --raw-field 'query=mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`, undefined],
  [`gh api https://api.github.com/graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`, undefined],
  // GraphQL com query ilegível: fail-closed.
  ["gh api graphql -F query=@merge.graphql", undefined],
  ["gh api graphql --input body.json", undefined],
  ['gh api graphql -f query="$Q"', undefined],
  ['gh api graphql -f query="$(cat q.graphql)"', undefined],
  // Aliases do gh (config.yml e `gh alias set` no próprio comando).
  ["gh m 160", 160],
  ["gh mq 161", 161],
  ["gh am 162", undefined],
  ["gh sm 163", undefined],
  ["gh blk 164", undefined],
  ["GH_REPO=x gh m 165", 165],
  ["gh alias set mm 'pr merge' && gh mm 166", 166],
  ["gh alias set --shell xm 'gh pr merge 5' ; gh xm", 5],
  ["gh alias import aliases.yml && gh qualquer 167", undefined],
];

/** Não mergeiam — o guard não pode passar a bloquear nada disso. */
const NEGATIVES: string[] = [
  // GET em …/merge só consulta se a PR foi mergeada (204/404).
  "gh api repos/vjpixel/diaria-studio/pulls/123/merge",
  "gh api -X GET repos/vjpixel/diaria-studio/pulls/123/merge",
  "gh api --method=GET repos/o/r/pulls/5/merge -f x=1",
  "gh api -X HEAD repos/o/r/pulls/5/merge",
  // Leitura e escrita em outros endpoints de PR/issue.
  "gh api repos/x/y/pulls/123",
  "gh api repos/vjpixel/diaria-studio/pulls/123 --jq .merged",
  "gh api repos/vjpixel/diaria-studio/pulls/123/files --paginate",
  "gh api -X PATCH repos/vjpixel/diaria-studio/pulls/123 -f title=x",
  "gh api -X POST repos/vjpixel/diaria-studio/pulls/123/comments -f body=x",
  "gh api -X POST repos/vjpixel/diaria-studio/merges -f base=master -f head=x",
  "gh api -X POST repos/o/r/merge-upstream -f branch=main",
  "gh api -X PATCH repos/o/r/issues/$N -f body=x",
  "gh api -X POST repos/$REPO/issues/$N/comments -f body=x",
  "gh api -X DELETE repos/o/r/git/refs/heads/branch-merge",
  "gh api -X PUT repos/o/r/pulls/5/requested_reviewers -f reviewers[]=x",
  // GraphQL que não mergeia (o coordenador resolve review threads assim).
  `gh api graphql -f query='query { repository(owner: "vjpixel", name: "diaria-studio") { pullRequest(number: 5) { reviewThreads(first: 20) { nodes { id isResolved } } } } }'`,
  `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "ID"}) { thread { isResolved } } }'`,
  `gh api graphql -f query='query { viewer { login } }' --jq .data.viewer.login`,
  // Menção sem execução.
  "echo 'gh api -X PUT repos/o/r/pulls/1/merge'",
  'gh issue comment 10689 --body "gh api -X PUT repos/o/r/pulls/1/merge"',
  "grep -n 'pulls/{n}/merge' .claude/hooks/lib/gh-pr-merge-command.mjs",
  "gh api",
  // Comandos builtin comuns e aliases que não mergeiam.
  "gh pr view 5",
  "gh pr checks 5 --watch",
  "gh pr list --state open",
  "gh co 5",
  "gh pv 5",
  "gh dash",
  "gh alias list",
  "gh alias set m2 'pr view'",
  "gh alias set m3 'pr merge'",
  "gh issue view 10689 --comments",
  "gh run list --limit 5",
];

describe("#10689 — gh api / alias do gh contam como merge", () => {
  for (const [cmd, pr] of POSITIVES) {
    it(`merge: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isGhPrMergeCommand(cmd, opts), true, cmd);
      assert.equal(extractGhPrMergeTargetPr(cmd, opts), pr, cmd);
    });
  }
});

describe("#10689 — sem falso positivo novo", () => {
  for (const cmd of NEGATIVES) {
    it(`não é merge: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isGhPrMergeCommand(cmd, opts), false, cmd);
    });
  }
});

describe("#10689 — repo do caminho da API", () => {
  it("a invocação carrega -R owner/repo quando o caminho traz o repo literal", () => {
    assert.deepEqual(findGhPrMergeInvocations("gh api -X PUT repos/vjpixel/diaria-design/pulls/7/merge", opts), [
      ["-R", "vjpixel/diaria-design", "7"],
    ]);
    assert.deepEqual(findGhPrMergeInvocations("gh api -X PUT repos/{owner}/{repo}/pulls/7/merge", opts), [["7"]]);
  });

  it("reposMentioned enxerga o repo de fora no caminho repos/o/r/…", () => {
    const allowed = new Set(["vjpixel/diaria-design"]);
    const seen = targetRepo.reposMentioned("gh api -X PUT repos/vjpixel/diaria-design/pulls/7/merge", allowed);
    assert.ok(seen.has("vjpixel/diaria-design"), [...seen].join(","));
  });

  it("resolveMergeTargets: gh api cai no modo ESTRITO (lock dos dois repos, nenhuma concessão)", () => {
    const allowed = new Set(["vjpixel/diaria-design"]);
    const res = targetRepo.resolveMergeTargets("gh api -X PUT repos/vjpixel/diaria-design/pulls/7/merge", undefined, {
      allowed,
      env: {},
      execFn: () => {
        throw new Error("sem git");
      },
    });
    assert.equal(res.mode, "strict");
    assert.equal(res.grantRepo, null);
    assert.ok(res.targets.includes("vjpixel/diaria-studio"));
    assert.ok(res.targets.includes("vjpixel/diaria-design"));
  });
});

describe("#10689 — leitura do config.yml do gh", () => {
  it("parseGhAliasesYaml lê a seção aliases: (plain, aspas, bloco ilegível)", () => {
    const yaml = [
      "git_protocol: https",
      "aliases:",
      "    co: pr checkout",
      "    m: 'pr merge --squash'",
      '    \"x y\": "pr merge"',
      "    blk: |",
      "        pr merge",
      "    vazio:",
      "# comentário",
      "browser:",
      "    nao: pr merge",
    ].join("\n");
    const a = parseGhAliasesYaml(yaml);
    assert.equal(a.get("co"), "pr checkout");
    assert.equal(a.get("m"), "pr merge --squash");
    assert.equal(a.get("x y"), "pr merge");
    assert.equal(a.get("blk"), null);
    assert.equal(a.get("vazio"), null);
    assert.equal(a.has("nao"), false, "chave de outra seção não é alias");
  });

  it("sem seção aliases: → nenhum alias", () => {
    assert.equal(parseGhAliasesYaml("git_protocol: https\n").size, 0);
    assert.equal(parseGhAliasesYaml(undefined).size, 0);
  });
});

describe("#10689 — entrypoint CLI do guard", () => {
  const HOOK_PATH = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  const root = join(tmpdir(), `merge-guard-10689-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const dir = guard.sessionsDir(root);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: root });
  const tag = guard.machineTag();
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `overnight-${tag}-coord-10689.json`),
    JSON.stringify({ kind: "overnight", sessionId: "coord-10689", machineTag: tag, startedAt: now, lastHeartbeat: now }),
    "utf8",
  );
  // Config do gh isolado, com um alias de merge.
  const ghConfig = join(root, "gh-config");
  mkdirSync(ghConfig, { recursive: true });
  writeFileSync(join(ghConfig, "config.yml"), "aliases:\n    m: pr merge\n    co: pr checkout\n", "utf8");

  function runHook(command: string, sessionId = "subagente-10689") {
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      cwd: root,
      input: JSON.stringify({ session_id: sessionId, tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, GH_CONFIG_DIR: ghConfig },
    });
    return { status: r.status, stdout: (r.stdout ?? "").trim() };
  }

  for (const cmd of [
    "gh api -X PUT repos/vjpixel/diaria-studio/pulls/123/merge -f merge_method=squash",
    "GH_TOKEN=x gh api --method=PUT /repos/vjpixel/diaria-studio/pulls/123/merge",
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_x"}) { clientMutationId } }'`,
    "gh m 123",
  ]) {
    it(`nega pra subagente: ${JSON.stringify(cmd)}`, () => {
      const res = runHook(cmd);
      assert.equal(res.status, 0);
      assert.ok(res.stdout !== "", "esperava hookSpecificOutput de bloqueio");
      assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, "deny");
    });
  }

  for (const cmd of [
    "gh api repos/vjpixel/diaria-studio/pulls/123/merge",
    "gh api repos/x/y/pulls/123",
    "gh co 123",
    "gh pr view 123",
    `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "ID"}) { thread { isResolved } } }'`,
  ]) {
    it(`não interfere: ${JSON.stringify(cmd)}`, () => {
      const res = runHook(cmd);
      assert.equal(res.status, 0);
      assert.equal(res.stdout, "");
    });
  }
});
