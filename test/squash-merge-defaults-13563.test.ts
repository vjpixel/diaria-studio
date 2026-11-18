/**
 * test/squash-merge-defaults-13563.test.ts (#13563, regressão #633)
 *
 * O squash pelo caminho padrão do GitHub (UI, `gh pr merge --squash` sem
 * `--body`) repetia o `Co-Authored-By` uma vez por commit da PR, porque os
 * repos estavam em `COMMIT_MESSAGES`. Trava: (1) o plano só dá `ok` com
 * PR_TITLE + PR_BODY lidos de verdade; (2) o CLI só grava com `--apply` e
 * julga pela releitura, nunca pelo 2xx do PATCH; (3) o caminho do trem, que
 * monta o body sozinho, continua emitindo o trailer uma vez só.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SQUASH_REPOS,
  SQUASH_MESSAGE_TARGET,
  SQUASH_TITLE_TARGET,
  buildSquashPatchArgs,
  planSquashDefaults,
} from "../scripts/lib/squash-merge-defaults.ts";
import { main, type GhRunner } from "../scripts/set-squash-merge-defaults.ts";
import { buildSoloSquashBody } from "../scripts/lib/merge-train.ts";

const FACTORY = { allow_squash_merge: true, squash_merge_commit_title: "COMMIT_OR_PR_TITLE", squash_merge_commit_message: "COMMIT_MESSAGES" };
const TARGET = { allow_squash_merge: true, squash_merge_commit_title: SQUASH_TITLE_TARGET, squash_merge_commit_message: SQUASH_MESSAGE_TARGET };

describe("planSquashDefaults (#13563)", () => {
  it("padrão de fábrica do GitHub precisa mudar", () => {
    const plan = planSquashDefaults("vjpixel/diaria-studio", FACTORY);
    assert.deepEqual(plan, {
      repo: "vjpixel/diaria-studio",
      verdict: "change",
      from: { title: "COMMIT_OR_PR_TITLE", message: "COMMIT_MESSAGES" },
    });
  });

  it("PR_TITLE + PR_BODY já está ok", () => {
    assert.equal(planSquashDefaults("a/b", TARGET).verdict, "ok");
  });

  it("só o título certo ainda muda (a mensagem é o que repete o trailer)", () => {
    assert.equal(planSquashDefaults("a/b", { ...TARGET, squash_merge_commit_message: "COMMIT_MESSAGES" }).verdict, "change");
  });

  it("campos ausentes (token sem admin) saem unreadable, nunca ok", () => {
    assert.equal(planSquashDefaults("a/b", { allow_squash_merge: true }).verdict, "unreadable");
    assert.equal(planSquashDefaults("a/b", null).verdict, "unreadable");
  });

  it("squash desligado no repo é sinalizado", () => {
    assert.equal(planSquashDefaults("a/b", { ...FACTORY, allow_squash_merge: false }).verdict, "squash-disabled");
  });
});

describe("buildSquashPatchArgs", () => {
  it("monta o PATCH com os dois campos do alvo", () => {
    assert.deepEqual(buildSquashPatchArgs("vjpixel/tekoa"), [
      "api",
      "-X",
      "PATCH",
      "repos/vjpixel/tekoa",
      "-f",
      "squash_merge_commit_title=PR_TITLE",
      "-f",
      "squash_merge_commit_message=PR_BODY",
    ]);
  });

  it("recusa repo malformado", () => {
    assert.throws(() => buildSquashPatchArgs("vjpixel/tekoa; rm -rf"));
    assert.throws(() => buildSquashPatchArgs("tekoa"));
  });

  it("os 7 repos da issue estão na lista padrão", () => {
    assert.equal(DEFAULT_SQUASH_REPOS.length, 7);
    assert.ok(DEFAULT_SQUASH_REPOS.includes("vjpixel/diaria-studio"));
  });
});

/** gh falso: estado por repo, PATCH muda o estado a menos que `ignorePatch`. */
function fakeGh(initial: Record<string, object>, opts: { ignorePatch?: boolean } = {}) {
  const state = { ...initial };
  const calls: string[][] = [];
  const runner: GhRunner = (args) => {
    calls.push(args);
    const repo = args.find((a) => a.startsWith("repos/"))!.slice("repos/".length);
    if (args.includes("PATCH")) {
      if (!opts.ignorePatch) state[repo] = { ...TARGET };
      return { status: 0, stdout: "{}", stderr: "" };
    }
    if (!(repo in state)) return { status: 1, stdout: "", stderr: "HTTP 404" };
    return { status: 0, stdout: JSON.stringify(state[repo]), stderr: "" };
  };
  return { runner, calls };
}

function silenced<T>(fn: () => T): T {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe("set-squash-merge-defaults main (#13563)", () => {
  it("dry-run não grava nada", () => {
    const gh = fakeGh({ "a/b": FACTORY });
    const code = silenced(() => main(["--repos", "a/b"], gh.runner));
    assert.equal(code, 0);
    assert.equal(gh.calls.filter((c) => c.includes("PATCH")).length, 0);
  });

  it("--apply grava só onde precisa e confere pela releitura", () => {
    const gh = fakeGh({ "a/b": FACTORY, "a/c": TARGET });
    const code = silenced(() => main(["--repos", "a/b,a/c", "--apply"], gh.runner));
    assert.equal(code, 0);
    const patches = gh.calls.filter((c) => c.includes("PATCH"));
    assert.equal(patches.length, 1);
    assert.ok(patches[0].includes("repos/a/b"));
  });

  it("PATCH 2xx que não persistiu sai exit 1 (#573)", () => {
    const gh = fakeGh({ "a/b": FACTORY }, { ignorePatch: true });
    assert.equal(silenced(() => main(["--repos", "a/b", "--apply"], gh.runner)), 1);
  });

  it("repo ilegível sai exit 1, mesmo em dry-run", () => {
    const gh = fakeGh({});
    assert.equal(silenced(() => main(["--repos", "a/inexistente"], gh.runner)), 1);
  });

  it("--repos inválido sai exit 2 sem chamar o gh", () => {
    const gh = fakeGh({});
    assert.equal(silenced(() => main(["--repos", "semdono"], gh.runner)), 2);
    assert.equal(gh.calls.length, 0);
  });
});

describe("caminho do trem segue com 1 trailer por PR de N commits (#13563)", () => {
  it("3 commits com o mesmo Co-Authored-By viram uma linha só", () => {
    const trailer = "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>";
    const commits = [
      { messageHeadline: "fix: a", messageBody: `Corpo.\n\n${trailer}` },
      { messageHeadline: "fix do review", messageBody: trailer },
      { messageHeadline: "fix do review 2", messageBody: trailer.replace("Co-Authored-By", "Co-authored-by") },
    ];
    const out = buildSoloSquashBody("Closes #13563", commits);
    assert.equal(out.match(/co-authored-by:/gi)?.length, 1);
    assert.ok(!out.includes("fix do review"));
  });
});
