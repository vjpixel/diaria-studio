/**
 * #10681 — o guard de merge do #5716 (`block-gh-pr-merge-subagent.mjs`) e o
 * consumidor de concessão (`consume-merge-grant-on-merge.mjs`) só reconheciam
 * `gh pr merge` no início do comando ou depois de separador. Formas que o
 * shell executa como merge passavam sem o guard rodar:
 *
 *   GH_REPO=x gh pr merge 5 · env FOO=1 gh pr merge 5 · command gh pr merge 5
 *   /usr/bin/gh pr merge 5 · gh pr -R x merge 5
 *
 * Todos os testes usam entradas sintéticas e um `data/sessions/` em diretório
 * temporário — nenhum `gh pr merge` é executado.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isGhPrMergeCommand,
  extractGhPrMergeTargetPr,
  findGhPrMergeInvocations,
} from "../.claude/hooks/lib/gh-pr-merge-command.mjs";

// Os dois hooks não têm `.d.mts`; o import por URL computada evita um TS7016
// novo na catraca de tipos (`tsc-baseline.json`) sem perder a checagem do
// que o teste usa.
type Detector = { isGhPrMergeCommand: unknown; extractGhPrMergeTargetPr: unknown };
const guard = (await import(
  new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href
)) as Detector & { sessionsDir: (root: string) => string; machineTag: () => string };
const consume = (await import(
  new URL("../.claude/hooks/consume-merge-grant-on-merge.mjs", import.meta.url).href
)) as Detector & {
  decideConsumeAfterBash: (
    command: string,
    deps: { findLiveGrant: (pr: number | undefined) => unknown; execFn?: () => never },
  ) => { consume: boolean; targetPr: number | undefined; reason: string };
};

/** [comando, PR alvo esperado] — todas executam um merge de verdade. */
const POSITIVES: Array<[string, number | undefined]> = [
  // As 5 formas da issue.
  ["GH_REPO=vjpixel/diaria-studio gh pr merge 5 --squash", 5],
  ["env FOO=1 gh pr merge 5", 5],
  ["command gh pr merge 5", 5],
  ["/usr/bin/gh pr merge 5", 5],
  ["gh pr -R x merge 5", 5],
  // Variantes da mesma classe.
  ['GH_REPO="vjpixel/diaria studio" GH_TOKEN=abc gh pr merge 6 --squash', 6],
  ["env -i PATH=/usr/bin gh pr merge 7", 7],
  ["env -u GH_TOKEN gh pr merge 8", 8],
  ["env -- gh pr merge 9", 9],
  ["exec gh pr merge 10", 10],
  ["exec -a nome gh pr merge 11", 11],
  ["command -p gh pr merge 12", 12],
  ["nohup gh pr merge 13 &", 13],
  ["nice -n 5 gh pr merge 14", 14],
  ["time gh pr merge 15", 15],
  ["timeout 300 gh pr merge 16", 16],
  ["timeout --signal=KILL 5m gh pr merge 17", 17],
  ["sudo -u vjpixel gh pr merge 18", 18],
  ["sudo -E gh pr merge 19", 19],
  ["stdbuf -oL gh pr merge 20", 20],
  ["echo 21 | xargs gh pr merge", undefined],
  ["xargs -I {} gh pr merge {} < prs.txt", undefined],
  ["FOO=1 BAR=2 env -i nice -n 5 command gh pr merge 22", 22],
  ["./gh pr merge 23", 23],
  ["~/bin/gh pr merge 24", 24],
  ["gh.exe pr merge 25", 25],
  ["gh --repo x pr merge 26", 26],
  ["gh pr --repo=vjpixel/diaria-studio merge 27", 27],
  ["gh pr --repo x merge --squash 28", 28],
  ['"gh" pr merge 29', 29],
  ["g\\h pr merge 30", 30],
  ["(cd wt && gh pr merge 31)", 31],
  ["{ gh pr merge 32; }", 32],
  ["if true; then gh pr merge 33; fi", 33],
  ["echo $(gh pr merge 34)", 34],
  ['echo "$(GH_REPO=x gh pr merge 35)"', 35],
  ["echo `gh pr merge 36`", 36],
  ["bash -c 'gh pr merge 37 --squash'", 37],
  ['sh -lc "GH_REPO=x gh pr merge 38"', 38],
  ["eval gh pr merge 39", 39],
  ["env -S 'gh pr merge 40'", 40],
  ["> out.log gh pr merge 41", 41],
  ["GH_REPO=x gh pr merge 42 2>&1 | tail -5", 42],
  ["git fetch && GH_REPO=x gh pr merge 43", 43],
  // Formas canônicas que já eram detectadas continuam.
  ["gh pr merge 5713", 5713],
  ["gh pr merge --squash --auto 6303", 6303],
  ["cd worktree && gh pr merge 42 --squash", 42],
  ["git fetch\ngh pr merge 123 --squash", 123],
  ["gh pr merge \\\n123 --squash", 123],
  ['gh pr merge --body "encerrado depois de 100 dias" 6303', 6303],
  ["gh pr merge --subject 5 6", 6],
  ["gh pr merge --squash", undefined],
];

/** Mencionam `gh pr merge` sem executar — nunca podem virar merge. */
const NEGATIVES: string[] = [
  'echo "gh pr merge 5"',
  "echo gh pr merge 5",
  "grep 'gh pr merge' .claude/hooks/block-gh-pr-merge-subagent.mjs",
  'gh issue create --body "gh pr merge bloqueado pelo guard do overnight"',
  'gh issue create --title "Teste" --body "Comando:\ngh pr merge 5713 --squash\nfoi bloqueado" --label bug',
  "gh pr comment 5805 --body 'linha 1\ngh pr merge citado aqui\nlinha 3'",
  "printf '%s\\n' 'GH_REPO=x gh pr merge 5'",
  'git commit -m "GH_REPO=x gh pr merge 5"',
  "bash -c 'echo gh pr merge 5'",
  "command -v gh pr merge",
  "echo ok # ; gh pr merge 5",
  "GH_REPO=x gh pr view 5",
  "env FOO=1 gh pr checks 5 --watch",
  "/usr/bin/gh pr list",
  "gh pr -R x view 5",
  "gh pr create --title x --body y",
  "git merge origin/master",
  "bash script.sh gh pr merge",
  "npx tsx scripts/lib/session-registry.ts check-merge-grant",
  "gh pr merge-x",
  "gh-pr merge 5",
];

describe("#10681 — detector reconhece gh pr merge com prefixos", () => {
  for (const [cmd, pr] of POSITIVES) {
    it(`merge: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isGhPrMergeCommand(cmd), true);
      assert.equal(extractGhPrMergeTargetPr(cmd), pr);
    });
  }
});

describe("#10681 — menção a gh pr merge continua livre (sem falso positivo novo)", () => {
  for (const cmd of NEGATIVES) {
    it(`não é merge: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isGhPrMergeCommand(cmd), false);
      assert.equal(extractGhPrMergeTargetPr(cmd), undefined);
    });
  }
  it("entrada não-string", () => {
    for (const v of [undefined, null, 42, {}]) {
      assert.equal(isGhPrMergeCommand(v), false);
      assert.equal(extractGhPrMergeTargetPr(v), undefined);
    }
  });
});

describe("#10681 — PR alvo é o da ÚLTIMA invocação", () => {
  it("dois merges no mesmo comando", () => {
    const cmd = "gh pr merge 1 --squash && GH_REPO=x gh pr merge 2";
    assert.equal(findGhPrMergeInvocations(cmd).length, 2);
    assert.equal(extractGhPrMergeTargetPr(cmd), 2);
  });
});

describe("#10681 — os dois hooks usam o MESMO detector", () => {
  it("guard e consumidor exportam as funções da lib (sem cópia que possa divergir)", () => {
    assert.equal(guard.isGhPrMergeCommand, isGhPrMergeCommand);
    assert.equal(guard.extractGhPrMergeTargetPr, extractGhPrMergeTargetPr);
    assert.equal(consume.isGhPrMergeCommand, isGhPrMergeCommand);
    assert.equal(consume.extractGhPrMergeTargetPr, extractGhPrMergeTargetPr);
  });

  it("o consumidor consome a concessão depois de um merge com prefixo", () => {
    const decision = consume.decideConsumeAfterBash("GH_REPO=x gh pr merge 5 --squash", {
      // Concessão genérica (sem --pr): consome sem consultar o GitHub.
      findLiveGrant: () => ({ sessionId: "s" }),
      execFn: () => {
        throw new Error("não deveria consultar o GitHub");
      },
    });
    assert.equal(decision.consume, true);
    assert.equal(decision.targetPr, 5);
  });

  it("settings.json não restringe o consumidor a comandos que COMEÇAM com gh pr merge", () => {
    const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
    const entries = (settings.hooks.PostToolUse as Array<{ hooks: Array<Record<string, unknown>> }>)
      .flatMap((m) => m.hooks)
      .filter((h) => JSON.stringify(h.args ?? []).includes("consume-merge-grant-on-merge.mjs"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].if, undefined, "filtro `if` prefixado reabre o furo do #10681 no consumidor");
  });
});

describe("#10681 — entrypoint CLI do guard bloqueia as formas com prefixo", () => {
  const HOOK_PATH = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function makeRootWithCoordinator(): string {
    const root = join(tmpdir(), `merge-guard-10681-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    const dir = guard.sessionsDir(root);
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });
    const tag = guard.machineTag();
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `overnight-${tag}-coord-10681.json`),
      JSON.stringify({ kind: "overnight", sessionId: "coord-10681", machineTag: tag, startedAt: now, lastHeartbeat: now }),
      "utf8",
    );
    return root;
  }

  function runHook(root: string, command: string) {
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      cwd: root,
      input: JSON.stringify({ session_id: "subagente-10681", tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
      timeout: 10_000,
    });
    return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: r.stderr ?? "" };
  }

  const root = makeRootWithCoordinator();

  for (const cmd of [
    "gh pr merge 5 --squash",
    "GH_REPO=vjpixel/diaria-studio gh pr merge 5 --squash",
    "env FOO=1 gh pr merge 5",
    "command gh pr merge 5",
    "/usr/bin/gh pr merge 5",
    "gh pr -R x merge 5",
  ]) {
    it(`nega: ${JSON.stringify(cmd)}`, () => {
      const res = runHook(root, cmd);
      assert.equal(res.status, 0);
      assert.ok(res.stdout !== "", "esperava hookSpecificOutput de bloqueio");
      assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, "deny");
    });
  }

  for (const cmd of ['echo "GH_REPO=x gh pr merge 5"', "GH_REPO=x gh pr view 5"]) {
    it(`não interfere: ${JSON.stringify(cmd)}`, () => {
      const res = runHook(root, cmd);
      assert.equal(res.status, 0);
      assert.equal(res.stdout, "");
    });
  }
});
