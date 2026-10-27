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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isGhPrMergeCommand,
  extractGhPrMergeTargetPr,
  findGhPrMergeInvocations,
  ghConfigPath,
  loadGhAliases,
  mergeTargetHints,
  parseGhAliasesYaml,
  parseShellCommands,
} from "../.claude/hooks/lib/gh-pr-merge-command.mjs";
import * as targetRepo from "../.claude/hooks/lib/gh-target-repo.mjs";
import {
  RESOLVE_MUTATION,
  THREADS_QUERY,
  buildResolveArgs,
  buildThreadsQueryArgs,
} from "../scripts/resolve-review-threads.ts";

// O hook do guard não tem `.d.mts`: import por URL computada (mesmo padrão do teste do #10681).
type Resolution = { mode: string; targets: string[]; grantRepo: string | null; indeterminate?: boolean };
const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  sessionsDir: (root: string) => string;
  machineTag: () => string;
  detectMergeForGuard: (
    command: unknown,
    o?: { detect?: (c: unknown, opts: unknown) => boolean },
  ) => { isMerge: boolean; error: string | null; diagnostics: Array<{ kind: string }> };
  strictAllReposResolution: (allowed?: Set<string>) => Resolution;
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
  it("a invocação carrega o repo quando o caminho traz o repo literal", () => {
    // Forma desde o #10751 (união discriminada); antes: [["-R", "vjpixel/diaria-design", "7"]] e [["7"]].
    assert.deepEqual(findGhPrMergeInvocations("gh api -X PUT repos/vjpixel/diaria-design/pulls/7/merge", opts), [
      { via: "api-rest", repo: { kind: "literal", slug: "vjpixel/diaria-design" }, pr: 7 },
    ]);
    assert.deepEqual(findGhPrMergeInvocations("gh api -X PUT repos/{owner}/{repo}/pulls/7/merge", opts), [
      { via: "api-rest", repo: { kind: "cwd" }, pr: 7 },
    ]);
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

// ─── Fleet review da PR #10743: fail-opens A–P ───────────────────────────
// Cada caso abaixo passava LIVRE antes da correção (sonda reproduzida contra o
// detector da 1ª versão da PR) e mergeia de verdade — tem que contar.

/** [item do review, comando, PR alvo esperado]. */
const FLEET_POSITIVES: Array<[string, string, number | undefined]> = [
  // A — expansão de alias vinda do shell.
  ["A", 'gh alias set m2 "$X" && gh m2 5', undefined],
  ["A", "gh alias set m2 $X; gh m2 5", undefined],
  ["A", 'gh alias set "$N" \'pr merge\'; gh qualquer 5', undefined],
  // B — `--shell=true`/`-s=true`.
  ["B", "gh alias set --shell=true xm 'gh pr merge 5'; gh xm", 5],
  ["B", "gh alias set -s=true xm 'gh pr merge 6'; gh xm", 6],
  // C — argumento opaco não implica GET.
  ["C", 'F="-X PUT"; gh api $F repos/o/r/pulls/5/merge', 5],
  ["C", 'gh api "$@"', undefined],
  ["C", 'gh api "${ARGS[@]}"', undefined],
  ["C", "echo '-X PUT' | xargs gh api repos/o/r/pulls/5/merge", 5],
  // D — fim de endpoint opaco sem `pulls` literal.
  ["D", 'gh api -X PUT "$P/$E"', undefined],
  ["D", 'gh api -X PUT "repos/$R/$P"', undefined],
  ["D", 'gh api -X PUT "repos/o/r/pul$X/5/merg$E"', undefined],
  // E — placeholder do xargs/find no caminho.
  ["E", "echo repos/o/r/pulls/5/merge | xargs -I{} gh api -X PUT {}", undefined],
  ["E", "echo merge | xargs -I{} gh api -X PUT repos/o/r/pulls/5/{}", undefined],
  ["E", "echo merge | xargs -I % gh api -X PUT repos/o/r/pulls/5/%", undefined],
  ["E", "find . -maxdepth 0 -exec gh api -X PUT repos/o/r/pulls/5/merge \\;", 5],
  ["E", "find . -maxdepth 0 -exec gh pr merge 7 \\;", 7],
  // F — o comando redefine de onde o gh lê o config.
  ["F", "GH_CONFIG_DIR=/tmp/x gh outro 5", undefined],
  ["F", "env GH_CONFIG_DIR=/tmp/x gh outro 5", undefined],
  ["F", "export GH_CONFIG_DIR=/tmp/x; gh outro 5", undefined],
  ["F", "XDG_CONFIG_HOME=/tmp/x gh outro 5", undefined],
  ["F", "HOME=/tmp/x gh outro 5", undefined],
  ["F", "APPDATA=C:/x gh outro 5", undefined],
  ["F", "unset GH_CONFIG_DIR; gh outro 5", undefined],
  ["F", "env -u HOME gh outro 5", undefined],
  ["F", "env -i gh outro 5", undefined],
  ["F", "GH_CONFIG_DIR=/tmp/x gh co 5", undefined], // até alias conhecido deixa de valer
  // G — ANSI-C `$'…'`.
  ["G", "gh api -X PUT $'repos/o/r/pulls/5/merg\\x65'", 5],
  ["G", "gh api -X PUT repos/o/r/pulls/5/$'merg\\145'", 5],
  ["G", "gh api graphql -f query=$'mutation { merge\\x50ullRequest(input:{pullRequestId:\"x\"}){clientMutationId} }'", undefined],
  // H — query GraphQL com expansão do shell.
  ['H', 'gh api graphql -f query="$A$B"', undefined],
  ['H', 'gh api graphql -f query="$Q "', undefined],
  ['H', 'gh api graphql -f query="${Q:-x}"', undefined],
  ['H', 'gh api graphql -f query="mutation { ${M}(input:{pullRequestId:\\"x\\"}){clientMutationId} }"', undefined],
  ['H', 'gh api graphql -f "$K=mutation"', undefined],
  // K — merge por outra rota.
  ["K", "gh api -X POST repos/vjpixel/diaria-studio/merges -f base=master -f head=x", undefined],
  ["K", "gh api -X PATCH repos/o/r/git/refs/heads/master -f sha=abc -F force=true", undefined],
  ["K", "gh api repos/o/r/git/refs/heads/main -f sha=abc", undefined],
  ["K", "gh api graphql -f query='mutation { mergeBranch(input:{repositoryId:\"x\",base:\"master\",head:\"f\"}) { clientMutationId } }'", undefined],
  ["K", "gh api graphql -f query='mutation { updateRef(input:{refId:\"x\",oid:\"y\"}) { clientMutationId } }'", undefined],
  ["K", "gh api graphql -f query='mutation { updateRefs(input:{repositoryId:\"x\",refUpdates:[]}) { clientMutationId } }'", undefined],
  // N — aninhamento além do teto acusa.
  ["N", `${"$(".repeat(12)}gh pr view 1${")".repeat(12)}`, undefined],
  // O — subcomando opaco.
  ["O", "gh $S merge 5", undefined],
  ["O", 'gh pr "$M" 5', 5],
  ["O", "echo merge | xargs -I{} gh pr {} 5", 5],
  // P — percent-encoding e normalização do caminho.
  ["P", "gh api -X PUT repos/o/r/pulls/5/merg%65", 5],
  ["P", "gh api -X PUT repos/o/r/pulls/5%2Fmerge", 5],
  ["P", "gh api -X PUT repos/o/r/pulls/5/merge/.", 5],
  ["P", "gh api -X PUT repos/o/r/pulls/5/merge%3F", 5],
];

/** Comandos comuns das rodadas que têm que continuar livres. */
const FLEET_NEGATIVES: string[] = [
  // GET.
  'gh api "$URL"',
  "gh api -X get repos/o/r/pulls/5/merge",
  'gh api "repos/o/r/pulls/$N"',
  'gh api --paginate "repos/o/r/pulls/$N/comments"',
  'gh api "repos/o/r/pulls/$N" --jq .merged',
  "gh api -X GET search/issues -f q=x",
  // Escritas em PR/issue que não mergeiam.
  'gh api "repos/o/r/pulls/$N/comments" -f body=x',
  "gh api -X POST \"repos/o/r/pulls/$N/requested_reviewers\" -f 'reviewers[]=x'",
  'gh api -X PATCH "repos/$REPO/issues/$N" -f body=x',
  "gh api -X PATCH repos/o/r/pulls/comments/$ID -f body=x",
  "gh api -X DELETE repos/o/r/git/refs/heads/feature",
  // GraphQL: variáveis entre aspas SIMPLES, resolveReviewThread inline.
  `gh api graphql --paginate -f query='query($endCursor: String) { viewer { repositories(after: $endCursor) { nodes { name } } } }'`,
  `gh api graphql -f query='query($owner: String!) { repository(owner: $owner, name: "r") { id } }' -f owner=o`,
  `gh api graphql -f query='mutation($T: ID!) { resolveReviewThread(input: {threadId: $T}) { thread { isResolved } } }' -f T="$TID"`,
  `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "PRRT_x"}) { thread { isResolved } } }'`,
  `gh api graphql -f query='query { repository(owner: "o", name: "r") { pullRequest(number: 5) { mergeStateStatus } } }' -F n="$N"`,
  // Mutations parecidas que não mergeiam.
  `gh api graphql -f query='mutation { disablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }'`,
  `gh api graphql -f query='mutation { dequeuePullRequest(input: {id: "x"}) { clientMutationId } }'`,
  `gh api graphql -f query='mutation { updatePullRequestBranch(input: {pullRequestId: "x"}) { clientMutationId } }'`,
  // Comentários, consultas e aliases não-merge.
  'gh pr comment 5 --body "pode mergear com gh api -X PUT repos/o/r/pulls/5/merge"',
  "gh issue comment 10689 --body-file /tmp/x.md",
  "gh pr view 5 --json state,mergeable",
  "gh pr checks 5",
  "gh pr list --state open",
  "gh pr diff 5",
  "gh co 5",
  "cd $HOME && gh co 5",
  'echo "$HOME" && gh pv 5',
  "gh alias set co2 'pr checkout $1'",
];

describe("#10689 fleet review — fail-opens A–P agora contam como merge", () => {
  for (const [item, cmd, pr] of FLEET_POSITIVES) {
    it(`${item}: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isGhPrMergeCommand(cmd, opts), true, cmd);
      assert.equal(extractGhPrMergeTargetPr(cmd, opts), pr, cmd);
    });
  }
});

describe("#10689 fleet review — comandos comuns seguem livres", () => {
  for (const cmd of FLEET_NEGATIVES) {
    it(`não é merge: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isGhPrMergeCommand(cmd, opts), false, cmd);
    });
  }
});

describe("#10689 — recursão de alias", () => {
  it("alias que volta a si mesmo termina e acusa (fail-closed)", () => {
    const aliases = new Map<string, string | null>([
      ["a", "b"],
      ["b", "a"],
      ["self", "self 1"],
    ]);
    assert.equal(isGhPrMergeCommand("gh a 5", { aliases }), true);
    assert.equal(isGhPrMergeCommand("gh self", { aliases }), true);
  });

  it("cadeia de aliases que termina em pr merge é lida até o fim", () => {
    const aliases = new Map<string, string | null>([
      ["x", "y --squash"],
      ["y", "pr merge"],
    ]);
    assert.equal(extractGhPrMergeTargetPr("gh x 9", { aliases }), 9);
  });

  it("alias de shell que se chama sem fim é cortado pelo teto e acusa", () => {
    const aliases = new Map<string, string | null>([["loop", "!gh loop"]]);
    assert.equal(isGhPrMergeCommand("gh loop", { aliases }), true);
  });
});

describe("#10689 — opts.aliases que não é Map", () => {
  it("lança TypeError (nunca cai silenciosamente no config da máquina)", () => {
    assert.throws(
      () => isGhPrMergeCommand("gh m 5", { aliases: { m: "pr merge" } as unknown as Map<string, string> }),
      TypeError,
    );
  });
});

describe("#10689 M — repo do alvo indeterminado ou só no config", () => {
  const allowed = new Set(["vjpixel/diaria-design"]);
  const noGit = () => {
    throw new Error("sem git");
  };
  const resolve = (cmd: string, aliases: Map<string, string | null> = ALIASES) =>
    targetRepo.resolveMergeTargets(cmd, undefined, { allowed, env: {}, execFn: noGit, aliases });

  it("alias cujo -R só existe no config.yml entra no conjunto de locks", () => {
    const aliases = new Map<string, string | null>([["md", "pr merge -R vjpixel/diaria-design"]]);
    assert.deepEqual(mergeTargetHints("gh md 5", { aliases }), { repos: ["vjpixel/diaria-design"], unknown: false });
    const res = resolve("gh md 5", aliases);
    assert.equal(res.mode, "strict");
    assert.ok(res.targets.includes("vjpixel/diaria-design"), res.targets.join(","));
  });

  for (const cmd of [
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
    'gh api -X PUT "$URL"',
    "gh api -X PUT repos/$R/pulls/5/merge",
    'gh pr merge 5 -R "$REPO"',
    'gh pr merge "$PR_URL"',
    'GH_REPO="$R" gh pr merge 5',
    "gh blk 5",
  ]) {
    it(`indeterminado → todo repo de issue_repos: ${JSON.stringify(cmd)}`, () => {
      const res = resolve(cmd);
      assert.equal(res.mode, "strict");
      assert.equal(res.grantRepo, null);
      assert.equal(res.indeterminate, true);
      assert.ok(res.targets.includes("vjpixel/diaria-studio"));
      assert.ok(res.targets.includes("vjpixel/diaria-design"), `${cmd} → ${res.targets.join(",")}`);
    });
  }

  it("repo literal no caminho não é indeterminado", () => {
    const res = resolve("gh api -X PUT repos/vjpixel/diaria-studio/pulls/5/merge");
    assert.ok(res.mode === "strict");
    assert.equal(res.indeterminate, false);
    assert.deepEqual(res.targets, ["vjpixel/diaria-studio"]);
  });

  it("exceção do detector dentro da resolução → indeterminado (todos os repos)", () => {
    const res = targetRepo.resolveMergeTargets("gh api graphql -f query=x", undefined, {
      allowed,
      env: {},
      execFn: noGit,
      aliases: { nao: "map" } as unknown as Map<string, string>,
    });
    assert.equal(res.mode, "strict");
    assert.ok(res.targets.includes("vjpixel/diaria-design"));
  });
});

describe("#10689 L — exceção na detecção não é fail-open", () => {
  it("detectMergeForGuard: detector que lança → isMerge true com o erro", () => {
    const r = guard.detectMergeForGuard("gh qualquer", {
      detect: () => {
        throw new Error("boom");
      },
    });
    assert.equal(r.isMerge, true);
    assert.equal(r.error, "boom");
  });

  it("detectMergeForGuard: detector normal segue o veredito", () => {
    assert.equal(guard.detectMergeForGuard("gh pr view 5").isMerge, false);
    assert.equal(guard.detectMergeForGuard("gh pr merge 5").isMerge, true);
    assert.equal(guard.detectMergeForGuard("gh pr merge 5").error, null);
  });

  it("strictAllReposResolution: estrito, sem concessão, studio + todo repo permitido", () => {
    const res = guard.strictAllReposResolution(new Set(["vjpixel/diaria-design"]));
    assert.equal(res.mode, "strict");
    assert.equal(res.grantRepo, null);
    assert.deepEqual(res.targets, ["vjpixel/diaria-studio", "vjpixel/diaria-design"]);
  });
});

describe("#10689 I/J — config do gh não confiável é fail-closed", () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "gh-cfg-10689-"));
    dirs.push(d);
    return d;
  };

  it("I: config.yml que existe mas não abre (EISDIR) → loadError e todo nome desconhecido é merge", () => {
    const dir = tmp();
    mkdirSync(join(dir, "config.yml")); // diretório no lugar do arquivo
    const a = loadGhAliases({ GH_CONFIG_DIR: dir });
    assert.ok(a.loadError, "esperava loadError");
    assert.notEqual(a.loadError?.code, "ENOENT");
    const prev = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = dir;
    try {
      const seen: string[] = [];
      assert.equal(isGhPrMergeCommand("gh outro 5", { onDiagnostic: (k) => seen.push(k) }), true);
      assert.deepEqual(seen, ["gh_alias_config_unreadable"]);
      assert.equal(isGhPrMergeCommand("gh pr view 5"), false, "builtin segue livre");
    } finally {
      if (prev === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = prev;
    }
  });

  it("I: config ausente (ENOENT) → nenhum alias, nome desconhecido livre", () => {
    const dir = tmp();
    const a = loadGhAliases({ GH_CONFIG_DIR: dir });
    assert.equal(a.size, 0);
    assert.equal(a.loadError, undefined);
    assert.equal(isGhPrMergeCommand("gh outro 5", { aliases: a }), false);
  });

  it("J: aliases em flow style / anchor / chave ilegível → unparsed, nome desconhecido é merge", () => {
    for (const yaml of [
      "aliases: {m: pr merge}\n",
      "aliases: &a\n    co: pr checkout\n",
      "aliases:\n    'ab: pr merge\n",
      "aliases:\n    co: pr checkout\n    - m\n",
      "aliases:\n    <<: *base\n",
    ]) {
      const a = parseGhAliasesYaml(yaml);
      assert.ok(a.unparsed && a.unparsed.length > 0, JSON.stringify(yaml));
      assert.equal(isGhPrMergeCommand("gh m 5", { aliases: a }), true, JSON.stringify(yaml));
    }
  });

  it("J: BOM no início não esconde a seção aliases:", () => {
    const a = parseGhAliasesYaml("\uFEFFaliases:\n    m: pr merge\n");
    assert.equal(a.get("m"), "pr merge");
    assert.equal(a.unparsed, undefined);
  });

  it("J: corpo de bloco (`|`) e continuação de escalar não viram falso 'unparsed'", () => {
    const a = parseGhAliasesYaml("aliases:\n    blk: |\n        pr merge\n    co: pr checkout\n");
    assert.equal(a.unparsed, undefined);
    assert.equal(a.get("blk"), null);
    assert.equal(a.get("co"), "pr checkout");
    const cont = parseGhAliasesYaml("aliases:\n    m: pr\n        merge\n");
    assert.equal(cont.get("m"), null, "plain scalar de várias linhas é ilegível");
  });
});

describe("#10689 — ghConfigPath (ordem) e cache de loadGhAliases", () => {
  it("ordem: GH_CONFIG_DIR > XDG_CONFIG_HOME > AppData (win32) > home", () => {
    const all = { GH_CONFIG_DIR: "/g", XDG_CONFIG_HOME: "/x", APPDATA: "/a", HOME: "/h", USERPROFILE: "/u" };
    assert.equal(ghConfigPath(all, "linux"), join("/g", "config.yml"));
    assert.equal(ghConfigPath({ ...all, GH_CONFIG_DIR: "" }, "linux"), join("/x", "gh", "config.yml"));
    assert.equal(ghConfigPath({ ...all, GH_CONFIG_DIR: "", XDG_CONFIG_HOME: "" }, "win32"), join("/a", "GitHub CLI", "config.yml"));
    assert.equal(
      ghConfigPath({ GH_CONFIG_DIR: "", XDG_CONFIG_HOME: "", AppData: "/aa" }, "win32"),
      join("/aa", "GitHub CLI", "config.yml"),
    );
    assert.equal(ghConfigPath({ HOME: "/h", APPDATA: "/a" }, "linux"), join("/h", ".config", "gh", "config.yml"));
    assert.equal(ghConfigPath({ USERPROFILE: "/u" }, "win32"), join("/u", ".config", "gh", "config.yml"));
  });

  it("cache por caminho: mesmo caminho não relê; caminho novo lê", () => {
    const d1 = mkdtempSync(join(tmpdir(), "gh-cache-10689-"));
    const d2 = mkdtempSync(join(tmpdir(), "gh-cache-10689-"));
    try {
      writeFileSync(join(d1, "config.yml"), "aliases:\n    m: pr merge\n");
      writeFileSync(join(d2, "config.yml"), "aliases:\n    v: pr view\n");
      assert.equal(loadGhAliases({ GH_CONFIG_DIR: d1 }).get("m"), "pr merge");
      writeFileSync(join(d1, "config.yml"), "aliases:\n    m: pr view\n");
      assert.equal(loadGhAliases({ GH_CONFIG_DIR: d1 }).get("m"), "pr merge", "mesmo caminho: cacheado");
      assert.equal(loadGhAliases({ GH_CONFIG_DIR: d2 }).get("v"), "pr view", "caminho novo: lido");
      assert.equal(loadGhAliases({ GH_CONFIG_DIR: d1 }).get("m"), "pr view", "voltou ao 1º: relido");
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });
});

describe("#10689 — hooks: coordenadora, sem coordenadora e concessão no modo estrito", () => {
  const HOOK_PATH = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));
  const CONSUME_PATH = fileURLToPath(new URL("../.claude/hooks/consume-merge-grant-on-merge.mjs", import.meta.url));
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  const NEW_FORMS = [
    "gh api -X PUT repos/vjpixel/diaria-studio/pulls/123/merge -f merge_method=squash",
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_x"}) { clientMutationId } }'`,
    "gh m 123",
    "gh api -X POST repos/vjpixel/diaria-studio/merges -f base=master -f head=x",
  ];

  /** Checkout temporário do studio; `withCoord` registra uma coordenadora overnight com concessão pra `benef`. */
  function makeRoot(withCoord: boolean, lockHolder?: string): { root: string; ghConfig: string } {
    const root = mkdtempSync(join(tmpdir(), "merge-guard-10689-hooks-"));
    roots.push(root);
    mkdirSync(guard.sessionsDir(root), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "diaria-studio" }));
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/vjpixel/diaria-studio.git"], { cwd: root });
    const ghConfig = join(root, "gh-config");
    mkdirSync(ghConfig, { recursive: true });
    writeFileSync(join(ghConfig, "config.yml"), "aliases:\n    m: pr merge\n", "utf8");
    if (withCoord) {
      const tag = guard.machineTag();
      const now = new Date().toISOString();
      writeFileSync(
        join(guard.sessionsDir(root), `overnight-${tag}-coord-10689h.json`),
        JSON.stringify({
          kind: "overnight",
          sessionId: "coord-10689h",
          machineTag: tag,
          startedAt: now,
          lastHeartbeat: now,
          merge_grant: { grantedTo: "benef-10689", grantedBy: "coord-10689h", grantedAt: now, pr: 123 },
        }),
        "utf8",
      );
    }
    if (lockHolder) {
      // Lock do studio com a beneficiária: a única coisa que pode negar o merge é a concessão não valer.
      writeFileSync(
        join(guard.sessionsDir(root), ".merge-lock.json"),
        JSON.stringify({ heldBy: lockHolder, acquiredAt: new Date().toISOString(), pr: 123 }),
        "utf8",
      );
    }
    return { root, ghConfig };
  }

  function run(hook: string, root: string, ghConfig: string, sessionId: string, command: string) {
    const env: Record<string, string | undefined> = { ...process.env, GH_CONFIG_DIR: ghConfig, GH_HOST: "github.invalid" };
    delete env.GH_REPO;
    const r = spawnSync(process.execPath, [hook], {
      cwd: root,
      input: JSON.stringify({ session_id: sessionId, tool_name: "Bash", cwd: root, tool_input: { command } }),
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      env,
    });
    return { status: r.status, stdout: (r.stdout ?? "").trim() };
  }

  const coordFile = (root: string) => join(guard.sessionsDir(root), `overnight-${guard.machineTag()}-coord-10689h.json`);

  for (const cmd of NEW_FORMS) {
    it(`a coordenadora segue podendo: ${JSON.stringify(cmd)}`, () => {
      const { root, ghConfig } = makeRoot(true);
      const res = run(HOOK_PATH, root, ghConfig, "coord-10689h", cmd);
      assert.equal(res.status, 0);
      assert.equal(res.stdout, "", res.stdout);
    });

    it(`sem coordenadora ativa nada bloqueia: ${JSON.stringify(cmd)}`, () => {
      const { root, ghConfig } = makeRoot(false);
      const res = run(HOOK_PATH, root, ghConfig, "interativa-10689", cmd);
      assert.equal(res.status, 0);
      assert.equal(res.stdout, "", res.stdout);
    });
  }

  it("controle: a concessão viva libera o `gh pr merge 123` da forma estrita", () => {
    const { root, ghConfig } = makeRoot(true, "benef-10689");
    const res = run(HOOK_PATH, root, ghConfig, "benef-10689", "gh pr merge 123 --squash");
    assert.equal(res.stdout, "", res.stdout);
  });

  for (const cmd of NEW_FORMS) {
    it(`guard: concessão viva NÃO vale no modo estrito: ${JSON.stringify(cmd)}`, () => {
      const { root, ghConfig } = makeRoot(true, "benef-10689");
      const res = run(HOOK_PATH, root, ghConfig, "benef-10689", cmd);
      assert.equal(res.status, 0);
      assert.ok(res.stdout !== "", "esperava bloqueio");
      assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, "deny");
    });

    it(`consumo: forma estrita não consome a concessão: ${JSON.stringify(cmd)}`, () => {
      const { root, ghConfig } = makeRoot(true);
      run(CONSUME_PATH, root, ghConfig, "benef-10689", cmd);
      const grant = JSON.parse(readFileSync(coordFile(root), "utf8")).merge_grant;
      assert.equal(grant.consumedAt, undefined, "concessão não pode ter sido consumida");
      const logPath = join(root, "data", "run-log.jsonl");
      assert.ok(existsSync(logPath), "esperava o log da resolução");
      const entries = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const target = entries.find((e) => e.message === "merge_target_repo");
      assert.ok(target, "esperava merge_target_repo no log");
      assert.equal(target.details.mode, "strict");
      assert.equal(target.details.grantRepo, null);
    });
  }
});

// ─── Comandos documentados de resolução de threads (#10689 H) ────────────
// Com o item H, `gh api graphql` cuja query tem um `$` que o SHELL expande é
// lido como merge (modo estrito). Os comandos que as rodadas copiam das
// skills/context têm que usar a query literal entre aspas simples e passar
// valores como variável do GraphQL (`-f tid="$tid"`), senão o coordenador
// cai no modo estrito (lock de todo repo) só pra resolver uma review thread.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = [".claude/skills", ".claude/agents", "context", "hermes"];
const SCAN_EXT = /\.(md|sh)$/;

function scanFiles(): string[] {
  const out: string[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const rel of readdirSync(abs, { recursive: true, encoding: "utf8" })) {
      if (SCAN_EXT.test(rel) && !rel.includes("node_modules")) out.push(join(abs, rel));
    }
  }
  return out;
}

/** Linhas com `gh api graphql` cujo campo `query` tem expansão do shell (`$` fora de aspas simples, `$(…)`). */
function shellExpandedGraphqlQueries(text: string): string[] {
  const hits: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("gh api graphql");
    if (at === -1) continue;
    for (const words of parseShellCommands(line.slice(at))) {
      for (let k = 0; k < words.length; k++) {
        const w = words[k];
        let field: string | null = null;
        if (["-f", "-F", "--field", "--raw-field"].includes(w)) field = words[k + 1] ?? "";
        else if (/^-[fF]query=/.test(w)) field = w.slice(2);
        else if (/^--(?:raw-)?field=query=/.test(w)) field = w.slice(w.indexOf("=") + 1);
        if (field !== null && field.startsWith("query=") && /[\u0000-\u0004]/.test(field)) hits.push(line.trim());
      }
    }
  }
  return hits;
}

describe("#10689 H — forma documentada de resolver review thread", () => {
  const DOC_FORMS = [
    `RESULT=$(gh api graphql -f query='mutation($tid: ID!) { resolveReviewThread(input:{threadId:$tid}){ thread{ id isResolved } } }' -f tid="$tid")`,
    `RESP=$(gh api graphql -f query='{ repository(owner:"vjpixel",name:"diaria-studio"){ pullRequest(number:{N}){ reviewThreads(first:100){ nodes{ id isResolved } pageInfo{ hasNextPage endCursor } } } } }')`,
    `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "ID"}) { thread { isResolved } } }'`,
    // #10618 (fatia 4, review A): owner/name do repo DO PR como variável do GraphQL.
    `RESP=$(gh api graphql -f owner={owner} -f name={name} -F pr={N} -f query='query($owner:String!,$name:String!,$pr:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$pr){ reviewThreads(first:100){ nodes{ id isResolved } pageInfo{ hasNextPage endCursor } } } } }')`,
    `gh api graphql -f owner=vjpixel -f name=diaria-design -F pr=23 -f query='query($owner: String!, $name: String!, $pr: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 20) { nodes { id isResolved path } } } } }'`,
    `gh api graphql -f tid=ID -f query='mutation($tid: ID!) { resolveReviewThread(input: {threadId: $tid}) { thread { isResolved } } }'`,
  ];
  for (const cmd of DOC_FORMS) {
    it(`não é merge: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isGhPrMergeCommand(cmd, opts), false, cmd);
    });
  }

  it("a forma antiga (threadId/query interpolados pelo shell) é lida como merge — por isso foi migrada", () => {
    const old = `RESULT=$(gh api graphql -f query="mutation { resolveReviewThread(input:{threadId:\\"$tid\\"}){ thread{ id isResolved } } }")`;
    assert.equal(isGhPrMergeCommand(old, opts), true);
    assert.deepEqual(shellExpandedGraphqlQueries(old), [old]);
    assert.equal(shellExpandedGraphqlQueries('RESP=$(gh api graphql -f query="$QUERY")').length, 1);
    assert.deepEqual(shellExpandedGraphqlQueries(DOC_FORMS.join("\n")), []);
  });

  it("o loop de resolução do overnight usa o helper, e as chamadas dele não são merge", () => {
    // #11235: o SKILL.md deixou de ter `gh api graphql` à mão (o allow list do
    // modo agendado não libera a regra) — a resolução mora em
    // scripts/resolve-review-threads.ts. As duas chamadas que ele monta,
    // escritas como linha de shell, seguem sem cara de merge pro guard.
    const skill = readFileSync(join(REPO_ROOT, ".claude/skills/diaria-overnight/SKILL.md"), "utf8");
    assert.match(skill, /npx tsx scripts\/resolve-review-threads\.ts --pr \{N\} \[--repo \{repo\}\]/);
    assert.equal(skill.split(/\r?\n/).filter((l) => l.includes("gh api graphql") && l.includes("-f query=")).length, 0);
    const shell = (args: string[]) => ["gh", ...args.map((a) => `'${a.replace(/'/g, "'\\''")}'`)].join(" ");
    for (const args of [buildThreadsQueryArgs("vjpixel/diaria-design", 23), buildResolveArgs("PRRT_x")]) {
      assert.equal(isGhPrMergeCommand(shell(args), opts), false, shell(args));
    }
    // #10618 (fatia 4, review A): a query de threads lê o repo DO PR (variáveis
    // owner/name), nunca o diaria-studio fixo.
    assert.doesNotMatch(THREADS_QUERY, /name:\s*"diaria-studio"/);
    assert.match(THREADS_QUERY, /repository\(owner:\$owner,name:\$name\)/);
    assert.match(RESOLVE_MUTATION, /resolveReviewThread\(input:\{threadId:\$tid\}\)/);
  });

  it("varredura: nenhum `gh api graphql` com $ de shell no texto da query em skills/agents/context/hermes", () => {
    const offenders: string[] = [];
    for (const file of scanFiles()) {
      for (const hit of shellExpandedGraphqlQueries(readFileSync(file, "utf8"))) {
        offenders.push(`${file.slice(REPO_ROOT.length)}: ${hit}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
