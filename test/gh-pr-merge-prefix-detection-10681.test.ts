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
    deps: { findLiveGrant: (pr: number | undefined) => unknown; execFn?: () => never; targetPr?: number },
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
  // Self-review F3: cluster de flags curtas com S.
  ["env -iS 'gh pr merge 52'", 52],
  ["env -iS'gh pr merge 53'", 53],
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
  // Heredoc: o corpo é texto, mas o que vem DEPOIS do delimitador é comando.
  ["cat <<'EOF' > f.txt\ngh pr merge 7\nEOF\ngh pr merge 44", 44],
  ["cat <<-EOF\n\tgh pr merge 7\n\tEOF\ngh pr merge 45", 45],
  ["cat <<EOF; gh pr merge 46\ncorpo\nEOF", 46],
  // Fail-closed: delimitador sem aspas expande `$(...)` no corpo (executa).
  ["cat <<EOF\n$(gh pr merge 47)\nEOF", 47],
  // Fail-closed: shell na linha do heredoc executa o corpo.
  ["bash <<'EOF'\ngh pr merge 48\nEOF", 48],
  ["cat <<'EOF' | sh\ngh pr merge 49\nEOF", 49],
  ["/bin/bash -s <<EOF\nGH_REPO=x gh pr merge 50\nEOF", 50],
  // Self-review F2: aspa solta no corpo (prosa) não esconde o merge depois dele.
  ["cat <<'EOF' > nota.md\nit's a note\nEOF\ngh pr merge 51", 51],
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
  // Comentário na #10681: mensagem de commit em heredoc que CITA o merge.
  // O regex antigo não via (tudo dentro de "..."); o lexer, antes de pular o
  // corpo do heredoc, via — e o guard negava o commit de um subagente.
  `git commit -m "$(cat <<'EOF'\nfix: x\n\nrodar && gh pr merge 5 depois\ngh pr merge 6\nEOF\n)"`,
  "git commit -F - <<'EOF'\nfix: x\n\n&& gh pr merge 5\nEOF",
  // Whitelist de heredoc-como-dado (fora dela o corpo é lido como comandos).
  "git commit -q --no-verify -F - <<'EOF' && git push -u origin HEAD\nfix\ngh pr merge 5\nEOF",
  `git commit -m "$(cat <<'MSG'\nfix && gh pr merge 5\nMSG\n)" --no-verify && git push origin HEAD`,
  `gh pr create --title "fix(#1): x" --base master --body "$(cat <<'EOF'\nCloses #1\n\nrodar && gh pr merge 5 depois\n$(gh pr merge 6)\nEOF\n)"`,
  `gh pr comment 10688 --body "$(cat <<'EOF'\n\`gh pr merge 5\`\nEOF\n)"`,
  `gh issue comment 10681 --body "$(cat <<'EOF'\neval gh pr merge 5\nEOF\n)"`,
  `gh issue create --title "x" --label bug --label P2 --body "$(cat <<'EOF'\n| sh\ngh pr merge 5\nEOF\n)"`,
];

/** Probes da verificação adversarial da PR #10688 @0e5a19f (bash real com gh falso): todos executam o merge. */
const HEREDOC_FAIL_OPEN_PROBES: string[] = [
  "cat <<EOF && gh pr merge 5\nbody\nEOF",
  "cat <<A <<'B'\na\nA\nb\nB\ngh pr merge 5",
  "cat <<'EOF' | sh\ngh pr merge 5\nEOF",
  "cat <<'EOF' | bash -\ngh pr merge 5\nEOF",
  "cat <<'EOF' | command sh\ngh pr merge 5\nEOF",
  "cat <<'EOF' | env bash\ngh pr merge 5\nEOF",
  "cat <<'EOF' | fish\ngh pr merge 5\nEOF",
  "cat <<'EOF' | busybox ash\ngh pr merge 5\nEOF",
  "cat <<'EOF' | pwsh -Command -\ngh pr merge 5\nEOF",
  "cat <<'EOF' | tee >(sh)\ngh pr merge 5\nEOF",
  "docker exec -i c sh <<'EOF'\ngh pr merge 5\nEOF",
  "ssh host <<'EOF'\ngh pr merge 5\nEOF",
  "sh <(cat <<'EOF'\ngh pr merge 5\nEOF\n)",
  "source <(cat <<'EOF'\ngh pr merge 5\nEOF\n)",
  `eval "$(cat <<'EOF'\ngh pr merge 5\nEOF\n)"`,
  `eval "$(cat <<EOF\ngh pr merge 5\nEOF\n)"`,
  `bash -c "$(cat <<'EOF'\ngh pr merge 5\nEOF\n)"`,
  "bash <<< 'gh pr merge 5'",
  "source /dev/stdin <<< 'gh pr merge 5'",
  "cat <<'EOF' |\ngh pr merge 5\nEOF\nsh",
  "{ cat <<'EOF'\ngh pr merge 5\nEOF\n} | sh",
  "( cat <<'EOF'\ngh pr merge 5\nEOF\n) | bash",
  `while read -r l; do\n  eval "$l"\ndone <<'EOF'\ngh pr merge 5\nEOF`,
  "cat <<EOF\n# $(gh pr merge 5)\nEOF",
  "cat <<EOF\nit's done: $(gh pr merge 5)\nEOF",
  "cat <<EOF\nit's `gh pr merge 5`\nEOF",
  "cat <<'EOF'\n$(gh pr merge 5)\nEOF",
  "echo $[1<<2]\ngh pr merge 5",
  `cat <<"$(x)"\nhi\n$(x)\ngh pr merge 5`,
  "cat <<$'EOF'\nhi\nEOF\ngh pr merge 5",
  "$SHELL <<'EOF'\ngh pr merge 5\nEOF",
  "${SHELL:-bash} <<'EOF'\ngh pr merge 5\nEOF",
  "sudo -s <<'EOF'\ngh pr merge 5\nEOF",
  "su root <<'EOF'\ngh pr merge 5\nEOF",
  "at now <<'EOF'\ngh pr merge 5\nEOF",
  "xargs -L1 gh <<'EOF'\npr merge 5\nEOF",
  "cat <<'EOF'\nbody\ngh pr merge 5",
  "cat <<'EOF'\nEOF \ngh pr merge 5\nEOF",
  "cat <<'EOF'\r\nb\r\nEOF\r\ngh pr merge 5\r\n",
  "cat <<E\"O\"F\nx\nEOF\ngh pr merge 5",
  "cat <<\\EOF\nx\nEOF\ngh pr merge 5",
  // Variações das formas da whitelist que saem dela (voltam pro fail-closed).
  "git commit -F - <<'EOF'\nfix\nEOF\ngh pr merge 5",
  `git commit -m "$(cat <<'EOF'\nfix\nEOF\n)" && gh pr merge 5`,
  `git commit -m "$(cat <<'EOF'\nfix\nEOF\ngh pr merge 5\nEOF\n)"`,
  "git commit -F - <<'EOF' | sh\ngh pr merge 5\nEOF",
  `gh pr create --body "$(cat <<'EOF'\nx\nEOF\n)" ; gh pr merge 5`,
  // Dentro de `$(...)` o bash fecha o heredoc em `D)` / `D )` antes do `D` exato.
  `git commit -m "$(cat <<'D'\nmsg\nD)"\ngh pr merge 5\nD\n)"`,
  `git commit -m "$(cat <<'D'\nmsg\nD )"\ngh pr merge 5\nD\n)"`,
  `git commit -m "$(cat <<'D'\nmsg\nD))"\ngh pr merge 5\nD\n)"`,
  `git commit -m "$(cat <<'D'\nmsg\nD)"; gh pr merge 5\nD\n)"`,
  `git commit -m "$(cat <<'D'\nmsg\nD)" && gh pr merge 5\nD\n)"`,
  `gh pr comment 1 --body "$(cat <<'D'\nmsg\nD)" && gh pr merge 5\nD\n)"`,
  "git commit -F - <<'D'\nmsg\nD \ngh pr merge 5\nD",
];

describe("#10681 — heredoc FAIL-CLOSED: probes da verificação adversarial", () => {
  for (const cmd of HEREDOC_FAIL_OPEN_PROBES) {
    it(`merge: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isGhPrMergeCommand(cmd), true, cmd);
    });
  }
});

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

  it("nº da PR: o consumidor usa o mesmo que o guard (resolveMergeTargets), inclusive de URL canônica", () => {
    // `extractGhPrMergeTargetPr` não lê nº de URL; o guard (via
    // `resolveMergeTargets`) lê. Sem o `targetPr` repassado, o consumidor via
    // `undefined` e consumia como `pr-undetermined` uma concessão escopada.
    const url = "gh pr merge https://github.com/vjpixel/diaria-studio/pull/77 --squash";
    assert.equal(extractGhPrMergeTargetPr(url), undefined);
    const seen: Array<number | undefined> = [];
    const decision = consume.decideConsumeAfterBash(url, {
      targetPr: 77,
      findLiveGrant: (pr) => {
        seen.push(pr);
        return { pr: 99 }; // concessão de OUTRA PR: não casa
      },
      execFn: () => {
        throw new Error("não deveria consultar o GitHub");
      },
    });
    assert.deepEqual(seen, [77]);
    assert.equal(decision.targetPr, 77);
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

  for (const cmd of [
    'echo "GH_REPO=x gh pr merge 5"',
    "GH_REPO=x gh pr view 5",
    `git commit -m "$(cat <<'EOF'\nfix: x\n\nrodar && gh pr merge 5 depois\nEOF\n)"`,
    "git commit -F - <<'EOF'\nfix: x\n\n&& gh pr merge 5\nEOF",
  ]) {
    it(`não interfere: ${JSON.stringify(cmd)}`, () => {
      const res = runHook(root, cmd);
      assert.equal(res.status, 0);
      assert.equal(res.stdout, "");
    });
  }
});
