/**
 * test/run-nightly-chain.test.ts (#10552)
 *
 * Trava o desenho da cadeia noturna: o overnight sobe QUALQUER que seja o
 * resultado do review (ok, noop, falha, timeout), a falha do review vira
 * exit code próprio só depois do overnight, e o `claude` do overnight nasce
 * sem as vars de auth da API (#5608/#6714), no par sonnet/medium (#9530),
 * com auto-updater desligado e com a flag explícita `--agendado`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENDADO_FLAG,
  DAILY_REVIEW_SCRIPT,
  EXIT_OVERNIGHT_FAILED,
  EXIT_REVIEW_FAILED,
  NIGHTLY_OVERNIGHT_EFFORT,
  NIGHTLY_OVERNIGHT_MODEL,
  buildOvernightClaudeArgs,
  buildOvernightEnv,
  buildReviewEnv,
  chainExitCode,
  classifyReviewResult,
  main,
  type NightlyChainDeps,
} from "../scripts/overnight/run-nightly-chain.ts";
import { CLAUDE_CLI_STRIPPED_ENV_VARS } from "../scripts/overnight/run-scheduled-edicao.ts";
import { SCHEDULED_TASKS, getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

interface FakeResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "nightly-chain-"));
  mkdirSync(join(root, "hermes", "scripts"), { recursive: true });
  writeFileSync(join(root, DAILY_REVIEW_SCRIPT), "#!/usr/bin/env bash\nexit 0\n");
  return root;
}

function harness(review: FakeResult, overnight: FakeResult, opts: { active?: boolean } = {}) {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const logs: string[] = [];
  const deps: NightlyChainDeps = {
    spawn: ((cmd: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
      calls.push({ cmd, args, env: o.env });
      const r = cmd === "bash" ? review : overnight;
      return { pid: 1, output: [], stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status, signal: r.signal ?? null, error: r.error };
    }) as unknown as NightlyChainDeps["spawn"],
    resolveClaudeBin: () => "/opt/claude-bin/claude",
    hasActiveOvernight: () => opts.active === true,
    env: { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "https://gw", ANTHROPIC_AUTH_TOKEN: "t", CLAUDECODE: "1", KEEP: "y" },
    log: (l) => logs.push(l),
    writeOvernightOutput: () => {},
  };
  return { deps, calls, logs };
}

describe("run-nightly-chain — o overnight sobe sempre (#10552)", () => {
  const cases: { name: string; review: FakeResult; expected: number }[] = [
    { name: "review ok", review: { status: 0, stderr: "[daily-review] concluído" }, expected: 0 },
    { name: "review noop", review: { status: 0, stderr: "[daily-review] nada novo desde o último review (abc) — noop" }, expected: 0 },
    { name: "review falhou (exit 4, sem marcador)", review: { status: 4, stderr: "ERRO" }, expected: EXIT_REVIEW_FAILED },
    {
      name: "review timeout",
      review: { status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync bash ETIMEDOUT"), { code: "ETIMEDOUT" }) },
      expected: EXIT_REVIEW_FAILED,
    },
  ];
  for (const c of cases) {
    it(`${c.name} → overnight roda mesmo assim, exit ${c.expected}`, () => {
      const { deps, calls } = harness(c.review, { status: 0, stdout: "{}" });
      assert.equal(main(makeRepo(), deps), c.expected);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].cmd, "bash");
      assert.equal(calls[1].cmd, "/opt/claude-bin/claude");
    });
  }

  it("review roda ANTES do overnight", () => {
    const { deps, calls } = harness({ status: 0 }, { status: 0 });
    main(makeRepo(), deps);
    assert.ok(calls[0].args[0].endsWith(DAILY_REVIEW_SCRIPT));
    assert.ok(calls[1].args.includes("--print"));
  });

  it("falha do overnight vence a falha do review no exit code", () => {
    const { deps } = harness({ status: 4 }, { status: 7, stderr: "boom" });
    assert.equal(main(makeRepo(), deps), EXIT_OVERNIGHT_FAILED);
  });

  it("overnight que sai 3 não se confunde com review falho", () => {
    const { deps } = harness({ status: 0 }, { status: 3 });
    assert.equal(main(makeRepo(), deps), EXIT_OVERNIGHT_FAILED);
  });

  it("script de review ausente não impede o overnight", () => {
    const root = mkdtempSync(join(tmpdir(), "nightly-chain-noscript-"));
    const { deps, calls } = harness({ status: 0 }, { status: 0 });
    assert.equal(main(root, deps), EXIT_REVIEW_FAILED);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "/opt/claude-bin/claude");
  });

  it("sessão overnight já ativa → pula o overnight, sem segunda rodada", () => {
    const { deps, calls, logs } = harness({ status: 0 }, { status: 0 }, { active: true });
    assert.equal(main(makeRepo(), deps), 0);
    assert.equal(calls.length, 1);
    assert.ok(logs.some((l) => l.includes("SKIP")));
  });

  it("binário claude ausente → falha dura antes de qualquer spawn", () => {
    const { deps, calls } = harness({ status: 0 }, { status: 0 });
    deps.resolveClaudeBin = () => {
      throw new Error("claude não encontrado");
    };
    assert.equal(main(makeRepo(), deps), 1);
    assert.equal(calls.length, 0);
  });
});

describe("run-nightly-chain — invocação headless do overnight", () => {
  it("par sonnet/medium do #9530 e flag --agendado explícita", () => {
    const args = buildOvernightClaudeArgs("/repo", (p) => p.replaceAll("\\", "/"));
    assert.equal(NIGHTLY_OVERNIGHT_MODEL, "claude-sonnet-5-5");
    assert.equal(NIGHTLY_OVERNIGHT_EFFORT, "medium");
    assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5-5");
    assert.equal(args[args.indexOf("--effort") + 1], "medium");
    const prompt = args[args.length - 1];
    assert.equal(args[args.length - 2], "--", "prompt posicional depois de -- (#9579)");
    assert.ok(prompt.startsWith(`/diaria-overnight ${AGENDADO_FLAG}`));
  });

  it("sem --no-session-persistence (a Fase 0 lê o próprio transcript) e sem --max-turns (sem teto, decisão do editor)", () => {
    const args = buildOvernightClaudeArgs("/repo", (p) => p.replaceAll("\\", "/"));
    assert.ok(!args.includes("--no-session-persistence"));
    assert.ok(!args.includes("--max-turns"));
  });

  it("env do overnight: remove TODAS as vars de CLAUDE_CLI_STRIPPED_ENV_VARS e liga DISABLE_AUTOUPDATER", () => {
    const src: NodeJS.ProcessEnv = { KEEP: "y" };
    for (const k of CLAUDE_CLI_STRIPPED_ENV_VARS) src[k] = "x";
    const env = buildOvernightEnv(src);
    for (const k of CLAUDE_CLI_STRIPPED_ENV_VARS) assert.equal(env[k], undefined, k);
    assert.equal(env.DISABLE_AUTOUPDATER, "1");
    assert.equal(env.KEEP, "y");
  });

  it("o env passado de fato ao spawn do overnight não carrega ANTHROPIC_API_KEY", () => {
    const { deps, calls } = harness({ status: 0 }, { status: 0 });
    main(makeRepo(), deps);
    const overnightEnv = calls[1].env;
    assert.equal(overnightEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(overnightEnv.ANTHROPIC_BASE_URL, undefined);
    assert.equal(overnightEnv.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(overnightEnv.CLAUDECODE, undefined);
    assert.equal(overnightEnv.DISABLE_AUTOUPDATER, "1");
  });

  it("env do review: diretório do binário claude à frente do PATH (systemd não tem ~/.npm-global/bin, #5549), sem duplicar", () => {
    const env = buildReviewEnv({ PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "x" }, "/home/u/.npm-global/bin/claude");
    assert.equal(env.PATH, "/home/u/.npm-global/bin:/usr/bin:/bin");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    const again = buildReviewEnv({ PATH: "/home/u/.npm-global/bin:/usr/bin" }, "/home/u/.npm-global/bin/claude");
    assert.equal(again.PATH, "/home/u/.npm-global/bin:/usr/bin");
  });
});

describe("Diaria-Nightly-Chain no registro (#10552)", () => {
  it("presente, diária às 00:15 BRT, step apontando pro runner, logPath próprio", () => {
    const task = getScheduledTaskByName("Diaria-Nightly-Chain");
    assert.ok(task);
    assert.deepEqual(task!.schedule, { kind: "daily", hour: 0, minute: 15 });
    assert.equal(task!.steps.length, 1);
    assert.equal(task!.steps[0].script, "scripts/overnight/run-nightly-chain.ts");
    assert.ok(!SCHEDULED_TASKS.some((t) => t !== task && t.logPath === task!.logPath));
  });

  it("está ligada (armada em 20/10/2026, job Hermes 645d5debb7f0 pausado)", () => {
    assert.notEqual(getScheduledTaskByName("Diaria-Nightly-Chain")!.enabled, false);
  });

  it("exit de review falho (3) fica fora de successExitCodes — a unit sai failed e o alarme avisa", () => {
    const codes = getScheduledTaskByName("Diaria-Nightly-Chain")!.successExitCodes ?? [];
    assert.ok(!codes.includes(EXIT_REVIEW_FAILED));
  });

  it("00:15 não colide com nenhuma outra daily do registro", () => {
    const clash = SCHEDULED_TASKS.filter(
      (t) => t.name !== "Diaria-Nightly-Chain" && t.schedule.kind === "daily" && t.schedule.hour === 0 && t.schedule.minute === 15,
    );
    assert.deepEqual(clash.map((t) => t.name), []);
  });
});

describe("run-nightly-chain — classificação e exit code", () => {
  it("classifyReviewResult distingue ok, noop, failed e timeout", () => {
    assert.equal(classifyReviewResult({ status: 0, signal: null, stderr: "" }), "ok");
    assert.equal(classifyReviewResult({ status: 0, signal: null, stderr: "x — noop" }), "noop");
    assert.equal(classifyReviewResult({ status: 1, signal: null, stderr: "" }), "failed");
    assert.equal(
      classifyReviewResult({ status: null, signal: "SIGTERM", stderr: "", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }),
      "timeout",
    );
  });

  it("chainExitCode: overnight pulado + review ok → 0; overnight pulado + review falho → EXIT_REVIEW_FAILED", () => {
    assert.equal(chainExitCode("ok", { status: "skipped-active-session", exitCode: null }), 0);
    assert.equal(chainExitCode("failed", { status: "skipped-active-session", exitCode: null }), EXIT_REVIEW_FAILED);
    assert.equal(chainExitCode("ok", { status: "failed", exitCode: null }), EXIT_OVERNIGHT_FAILED);
  });
});

// #10569 — mesmo fix do #9086 no runner da edição: no `300`, `data` é link pro
// OneDrive (fora do repo) e `acceptEdits` só aceita escrita dentro do
// diretório de trabalho. Sem `--add-dir`, o overnight agendado tinha o
// `plan.json`/`report.md` negados sem ninguém pra aprovar.
describe("run-nightly-chain — --add-dir de data/ fora do repo (#10569)", () => {
  const posix = (p: string) => p.replaceAll("\\", "/");
  const junction = (p: string) => (posix(p) === "/repo/data" ? "/onedrive/diaria/data" : posix(p));

  it("data/ link pra fora do repo -> --add-dir=<alvo real>, antes do --", () => {
    const args = buildOvernightClaudeArgs("/repo", junction);
    const i = args.indexOf("--add-dir=/onedrive/diaria/data");
    assert.ok(i >= 0, `esperava --add-dir no args: ${args.join(" ")}`);
    assert.ok(i < args.indexOf("--"), "--add-dir antes do -- (senão vira parte do prompt)");
    assert.ok(!args.includes("--add-dir"), "forma --add-dir=<path>, nunca separada (#9348)");
  });

  it("data/ dentro do repo -> nenhum --add-dir", () => {
    const args = buildOvernightClaudeArgs("/repo", posix);
    assert.ok(!args.some((a) => a.startsWith("--add-dir")));
  });

  it("spawn real do main(): data/ como symlink pra fora do repo chega ao claude como --add-dir", { skip: process.platform === "win32" }, () => {
    const root = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), "nightly-chain-data-"));
    symlinkSync(outside, join(root, "data"), "dir");
    const { deps, calls } = harness({ status: 0 }, { status: 0 });
    main(root, deps);
    const overnightArgs = calls[1].args;
    assert.ok(overnightArgs.includes(`--add-dir=${realpathSync(outside)}`), overnightArgs.join(" "));
  });
});
