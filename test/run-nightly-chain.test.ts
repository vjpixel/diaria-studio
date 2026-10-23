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
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AGENDADO_FLAG,
  DAILY_REVIEW_SCRIPT,
  DEFAULT_DEPS,
  EXIT_OVERNIGHT_FAILED,
  EXIT_OVERNIGHT_NO_TRACE,
  EXIT_REVIEW_FAILED,
  REVIEW_OUTPUT_REL,
  TAIL_LINE_MAX_CHARS,
  extractReviewSummary,
  findRoundTraceSince,
  parseStreamResult,
  readReviewSummary,
  readableTail,
  LIVE_LOG_PREV_SUFFIX,
  LIVE_LOG_REL,
  NIGHTLY_CHAIN_TASK_NAME,
  NIGHTLY_OVERNIGHT_EFFORT,
  NIGHTLY_OVERNIGHT_MODEL,
  PERSISTED_OUTPUT_TAIL_BYTES,
  buildOvernightClaudeArgs,
  buildOvernightEnv,
  buildReviewEnv,
  chainExitCode,
  classifyReviewResult,
  formatLiveLogLine,
  liveLogRelFromLogPath,
  main,
  readFileTail,
  rotateLiveLog,
  spawnWithPersistentOutput,
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
    assert.equal(
      classifyReviewResult({ status: 0, signal: null, stderr: "[daily-review] nada novo desde o último review (abc123) — noop" }),
      "noop",
    );
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

// #10672 — o task-runner só grava `.nightly-chain.log` quando o processo
// termina; numa cadeia de 16h morta por reboot/OOM/`systemctl stop`, nada
// sobrava. O log incremental recebe cada linha na hora.
describe("run-nightly-chain — log incremental sobrevive a processo morto (#10672)", () => {
  const liveLogPath = (root: string) => join(root, "data", ...LIVE_LOG_REL.split("/"));

  it("início e veredito do review já estão em disco quando o overnight sobe", () => {
    const root = makeRepo();
    mkdirSync(join(root, "data"));
    const { deps } = harness({ status: 0, stderr: "[daily-review] concluído" }, { status: 0, stdout: "{}" });
    deps.appendLiveLog = DEFAULT_DEPS.appendLiveLog;
    const realSpawn = deps.spawn as unknown as (c: string, a: string[], o: unknown) => unknown;
    let onDiskAtOvernight = "";
    deps.spawn = ((cmd: string, args: string[], o: unknown) => {
      if (cmd !== "bash") onDiskAtOvernight = readFileSync(liveLogPath(root), "utf8");
      return realSpawn(cmd, args, o);
    }) as unknown as NightlyChainDeps["spawn"];
    assert.equal(main(root, deps), 0);
    assert.match(onDiskAtOvernight, /cadeia noturna: início/);
    assert.match(onDiskAtOvernight, /review: ok exit=0/);
    assert.match(onDiskAtOvernight, /overnight: claude --print/);
    const final = readFileSync(liveLogPath(root), "utf8");
    assert.match(final, /cadeia noturna: fim review=ok overnight=ok exit=0/);
    for (const line of final.trimEnd().split("\n")) assert.match(line, /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] /);
  });

  it("linhas emitidas por runOvernight (falha) também vão pro log incremental", () => {
    const root = makeRepo();
    mkdirSync(join(root, "data"));
    const { deps } = harness({ status: 0 }, { status: 9, stderr: "boom" });
    deps.appendLiveLog = DEFAULT_DEPS.appendLiveLog;
    assert.equal(main(root, deps), EXIT_OVERNIGHT_FAILED);
    assert.match(readFileSync(liveLogPath(root), "utf8"), /overnight: FALHOU exit=9/);
  });

  it("sem data/ (clone fresco) não cria nada nem lança", () => {
    const root = makeRepo();
    const { deps } = harness({ status: 0 }, { status: 0 });
    deps.appendLiveLog = DEFAULT_DEPS.appendLiveLog;
    assert.equal(main(root, deps), 0);
    assert.ok(!existsSync(join(root, "data")));
  });

  it("formatLiveLogLine: prefixo ISO e quebra de linha", () => {
    assert.equal(formatLiveLogLine("x", new Date("2026-10-21T03:15:00.000Z")), "[2026-10-21T03:15:00.000Z] x\n");
  });

  it("processo morto por SIGKILL no meio do overnight deixa as linhas já emitidas", { skip: process.platform === "win32" }, () => {
    const root = makeRepo();
    mkdirSync(join(root, "data"));
    const scriptsDir = mkdtempSync(join(tmpdir(), "nightly-chain-kill-"));
    const mod = pathToFileURL(join(import.meta.dirname, "..", "scripts", "overnight", "run-nightly-chain.ts")).href;
    const child = join(scriptsDir, "child.ts");
    writeFileSync(
      child,
      [
        `import { main, DEFAULT_DEPS } from ${JSON.stringify(mod)};`,
        `main(process.argv[2], {`,
        `  ...DEFAULT_DEPS,`,
        `  resolveClaudeBin: () => "/opt/claude",`,
        `  hasActiveOvernight: () => false,`,
        `  log: () => {},`,
        `  spawn: ((cmd: string) => {`,
        `    if (cmd !== "bash") process.kill(process.pid, "SIGKILL");`,
        `    return { pid: 1, output: [], stdout: "", stderr: "[daily-review] concluído", status: 0, signal: null };`,
        `  }) as never,`,
        `});`,
        ``,
      ].join("\n"),
    );
    const r = spawnSync(process.execPath, ["--import", "tsx", child, root], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.signal, "SIGKILL", `esperava morte por SIGKILL: status=${r.status} stderr=${r.stderr}`);
    const live = readFileSync(liveLogPath(root), "utf8");
    assert.match(live, /cadeia noturna: início/);
    assert.match(live, /review: ok exit=0/);
    assert.match(live, /overnight: claude --print/);
    assert.doesNotMatch(live, /cadeia noturna: fim/);
  });
});

// #10699 itens 2 e 3 — caminho do log vivo derivado do registro e rotação por run.
describe("run-nightly-chain — log incremental derivado do registro e rotacionado (#10699)", () => {
  const liveLogPath = (root: string) => join(root, "data", ...LIVE_LOG_REL.split("/"));

  it("LIVE_LOG_REL deriva do logPath da task Diaria-Nightly-Chain", () => {
    const task = getScheduledTaskByName(NIGHTLY_CHAIN_TASK_NAME);
    assert.ok(task, "task do registro sumiu ou foi renomeada");
    assert.equal(LIVE_LOG_REL, liveLogRelFromLogPath(task.logPath));
    assert.equal(LIVE_LOG_REL, "overnight/.nightly-chain.live.log");
  });

  it("liveLogRelFromLogPath troca .log por .live.log e acrescenta quando não há .log", () => {
    assert.equal(liveLogRelFromLogPath("a/b.log"), "a/b.live.log");
    assert.equal(liveLogRelFromLogPath("a/b.txt"), "a/b.txt.live.log");
  });

  it("cada run começa com o log vivo novo; a run anterior fica em .prev (uma geração só)", () => {
    const root = makeRepo();
    mkdirSync(join(root, "data"));
    const run = (stderr: string) => {
      const { deps } = harness({ status: 0, stderr }, { status: 0, stdout: "{}" });
      deps.appendLiveLog = DEFAULT_DEPS.appendLiveLog;
      deps.rotateLiveLog = DEFAULT_DEPS.rotateLiveLog;
      assert.equal(main(root, deps), 0);
    };
    run("[daily-review] concluído");
    run("[daily-review] nada novo desde o último review (x) — noop");
    run("[daily-review] concluído");
    const current = readFileSync(liveLogPath(root), "utf8");
    const prev = readFileSync(`${liveLogPath(root)}${LIVE_LOG_PREV_SUFFIX}`, "utf8");
    assert.equal(current.match(/cadeia noturna: início/g)?.length, 1, "log vivo acumulou runs anteriores");
    assert.match(current, /review: ok/);
    assert.equal(prev.match(/cadeia noturna: início/g)?.length, 1);
    assert.match(prev, /review: noop/);
  });

  it("rotateLiveLog sem data/ ou sem arquivo não lança nem cria nada", () => {
    const root = makeRepo();
    rotateLiveLog(root);
    assert.ok(!existsSync(join(root, "data")));
    mkdirSync(join(root, "data"));
    rotateLiveLog(root);
    assert.ok(!existsSync(`${liveLogPath(root)}${LIVE_LOG_PREV_SUFFIX}`));
  });
});

// #10699 item 4: exercita o spawn real, sem serviço externo ou Claude pago.
describe("saída dos filhos persiste antes de o runner morrer", () => {
  it("spawn persistente mantém stdout/stderr e exit code no término normal", () => {
    const root = makeRepo();
    mkdirSync(join(root, "data"));
    const r = spawnWithPersistentOutput(process.execPath, ["-e", "process.stdout.write('result'); process.stderr.write('error'); process.exit(7)"], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 7);
    assert.equal(r.stdout, "result");
    assert.equal(r.stderr, "error");
  });

  // #10748: o stream-json do overnight não tem teto; ler o arquivo inteiro de
  // volta lançava acima do limite de string do V8 e virava "overnight: FALHOU"
  // num overnight que terminou bem. Só a cauda volta pra memória.
  it("spawn persistente devolve só a cauda de uma saída maior que o teto, e o arquivo fica inteiro no disco", () => {
    const root = makeRepo();
    mkdirSync(join(root, "data"));
    const total = PERSISTED_OUTPUT_TAIL_BYTES + 512 * 1024;
    const script = `const s = "x".repeat(${total - 4}) + "FIM\\n"; process.stdout.write(s); process.stderr.write("e".repeat(${total - 4}) + "ERR\\n");`;
    const r = spawnWithPersistentOutput(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.length, PERSISTED_OUTPUT_TAIL_BYTES, "stdout devolvido inteiro em vez da cauda");
    assert.ok(r.stdout.endsWith("FIM\n"));
    assert.equal(r.stderr.length, PERSISTED_OUTPUT_TAIL_BYTES);
    assert.ok(r.stderr.endsWith("ERR\n"));
    assert.equal(statSync(join(root, "data", "overnight", ".nightly-chain-last-overnight.json")).size, total);
  });

  it("readFileTail: arquivo menor que o teto volta inteiro; corte no meio de multibyte não deixa U+FFFD", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightly-tail-"));
    const small = join(dir, "small.txt");
    writeFileSync(small, "ação\n");
    assert.equal(readFileTail(small, 1024), "ação\n");
    const cut = join(dir, "cut.txt");
    writeFileSync(cut, "çabc"); // "ç" = 2 bytes; teto de 4 bytes corta no meio dele
    assert.equal(readFileTail(cut, 4), "abc");
    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "");
    assert.equal(readFileTail(empty, 4), "");
  });

  for (const phase of ["review", "overnight"] as const) {
    it(`${phase}: SIGKILL preserva stdout/stderr e a geração anterior`, { skip: process.platform === "win32" }, () => {
      const root = makeRepo();
      const dir = join(root, "data", "overnight");
      mkdirSync(dir, { recursive: true });
      const output = join(dir, `.nightly-chain-last-${phase}.${phase === "overnight" ? "json" : "log"}`);
      writeFileSync(output, "previous run");
      const mod = pathToFileURL(join(import.meta.dirname, "..", "scripts", "overnight", "run-nightly-chain.ts")).href;
      const killer = join(root, "killer.cjs");
      writeFileSync(killer, `require('node:fs').writeSync(1, '{"type":"assistant"}\\n'); require('node:fs').writeSync(2, 'diagnostic\\n'); process.kill(process.ppid, 'SIGKILL');`);
      const runner = join(root, "runner.ts");
      writeFileSync(runner, [
        `import { spawnWithPersistentOutput } from ${JSON.stringify(mod)};`,
        phase === "review"
          ? `spawnWithPersistentOutput('bash', ['-c', 'exec "$1" "$2"', 'bash', process.execPath, process.argv[3]], {cwd: process.argv[2], encoding: 'utf8'});`
          : `spawnWithPersistentOutput(process.execPath, [process.argv[3]], {cwd: process.argv[2], encoding: 'utf8'});`,
      ].join("\n"));
      const r = spawnSync(process.execPath, ["--import", "tsx", runner, root, killer], { encoding: "utf8", timeout: 60_000 });
      assert.equal(r.signal, "SIGKILL", r.stderr);
      assert.equal(readFileSync(output, "utf8"), '{"type":"assistant"}\n');
      assert.equal(readFileSync(`${output}.prev`, "utf8"), "previous run");
      assert.equal(readFileSync(join(dir, `.nightly-chain-last-${phase}.stderr.log`), "utf8"), "diagnostic\n");
    });
  }

  it("overnight emite eventos em stream-json com --verbose", () => {
    const args = buildOvernightClaudeArgs("/repo", (p) => p);
    assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
    assert.ok(args.includes("--verbose"));
  });

  it("review persiste eventos e valida apenas o resultado final", () => {
    const script = readFileSync(join(import.meta.dirname, "..", DAILY_REVIEW_SCRIPT), "utf8");
    assert.match(script, /--output-format stream-json --verbose \| tee "\$STREAM_FILE"/);
    const parser = script.match(/node -e '([\s\S]*?)' "\$STREAM_FILE"/);
    assert.ok(parser);
    const root = makeRepo();
    const stream = join(root, "review.jsonl");
    const run = (events: unknown[]) => {
      writeFileSync(stream, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      return spawnSync(process.execPath, ["-e", parser[1], stream], { encoding: "utf8" });
    };
    assert.equal(run([{ type: "assistant", text: "RESUMO-DAILY-REVIEW: fake" }]).status, 4);
    assert.equal(run([{ type: "result", is_error: true, result: "RESUMO-DAILY-REVIEW: fake" }]).status, 4);
    const ok = run([{ type: "system" }, { type: "result", result: "RESUMO-DAILY-REVIEW: findings=0" }]);
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, "RESUMO-DAILY-REVIEW: findings=0");
  });
});

// #10779 — desde o #10699 o stderr do review carrega o stream-json inteiro,
// inclusive os tool_result de `git diff`. Um diff contendo "— noop" rotulava
// o review completo como noop, e o tail do log virava eventos JSON gigantes.
describe("run-nightly-chain — classificação do review com stream-json no stderr (#10779)", () => {
  const diffEvent = JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          content:
            '+  echo "[daily-review] nada novo desde o último review ($HEAD_SHA) — noop" >&2\n+  return /— noop/.test(r.stderr) ? "noop" : "ok";\n',
        },
      ],
    },
  });
  const resultEvent = JSON.stringify({ type: "result", is_error: false, result: "x".repeat(50_000) });

  it("review completo cujo diff contém '— noop' num tool_result continua ok", () => {
    const stderr = ["[daily-review] revisando abc..def", diffEvent, resultEvent, "[daily-review] concluído — marco avançado para def"].join("\n");
    assert.equal(classifyReviewResult({ status: 0, signal: null, stderr }), "ok");
  });

  it("a linha exata do noop, entre outras linhas, ainda é noop", () => {
    const stderr = "[daily-review] preflight ok\n[daily-review] nada novo desde o último review (abc123) — noop\n";
    assert.equal(classifyReviewResult({ status: 0, signal: null, stderr }), "noop");
  });

  it("main: o mesmo stderr chega ao log como review: ok, com resumo e tail legível, sem eventos JSON", () => {
    const stderr = [diffEvent, resultEvent, "[daily-review] concluído — marco avançado para def"].join("\n");
    const { deps, logs } = harness({ status: 0, stderr }, { status: 0 });
    deps.readReviewSummary = () => "RESUMO-DAILY-REVIEW: commits=3 findings=1 issues_criadas=nenhuma issues_falharam=0";
    main(makeRepo(), deps);
    const line = logs.find((l) => l.startsWith("review: "));
    assert.ok(line);
    assert.match(line, /^review: ok exit=0 resumo=RESUMO-DAILY-REVIEW: commits=3 findings=1/);
    assert.match(line, /tail=\[daily-review\] concluído/);
    assert.doesNotMatch(line, /"type"/);
    assert.ok(line.length < 2000, `linha de log grande demais: ${line.length}`);
  });

  it("readableTail descarta eventos, fragmento final de evento e corta linhas longas", () => {
    const t = readableTail(['"fragmento","session_id":"s"}', '{"type":"system"}', "linha A", "y".repeat(TAIL_LINE_MAX_CHARS + 100)].join("\n"));
    assert.ok(!t.includes("fragmento"));
    assert.ok(!t.includes("system"));
    assert.ok(t.startsWith("linha A / "));
    assert.equal(t.length, "linha A / ".length + TAIL_LINE_MAX_CHARS + 1);
  });

  it("resumo lido de $OUT_FILE só no review ok; ausente/sem marcador → null", () => {
    const root = makeRepo();
    assert.equal(readReviewSummary(root), null);
    const out = join(root, "data", ...REVIEW_OUTPUT_REL.split("/"));
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, "texto\nRESUMO-DAILY-REVIEW: commits=1 findings=0\n");
    assert.equal(readReviewSummary(root), "RESUMO-DAILY-REVIEW: commits=1 findings=0");
    assert.equal(extractReviewSummary("sem marcador"), null);
    const noop = harness({ status: 0, stderr: "[daily-review] nada novo desde o último review (a) — noop" }, { status: 0 });
    let called = false;
    noop.deps.readReviewSummary = () => {
      called = true;
      return "x";
    };
    main(makeRepo(), noop.deps);
    assert.equal(called, false, "noop não deve ler o transcript (é da run anterior)");
  });
});

// #10808 — overnight agendado saiu em 29s, exit 0, sem plan.json/report.md, e
// o log da cadeia só dizia `overnight=ok`.
describe("run-nightly-chain — desfecho e rastro do overnight (#10808)", () => {
  const ev = (o: unknown) => JSON.stringify(o);
  const okResult = ev({ type: "result", subtype: "success", is_error: false, num_turns: 4, duration_ms: 29_000, result: "Fila vazia: 0 elegíveis de 12 varridas." });

  it("parseStreamResult pega o último evento result e ignora fragmento/linha inválida", () => {
    const r = parseStreamResult(['partial":1}', ev({ type: "system" }), "{quebrado", okResult, ""].join("\n"));
    assert.deepEqual(r, { subtype: "success", isError: false, numTurns: 4, durationMs: 29_000, result: "Fila vazia: 0 elegíveis de 12 varridas." });
    assert.equal(parseStreamResult(ev({ type: "assistant" })), null);
    assert.equal(parseStreamResult(""), null);
  });

  it("o resultado do claude vai pro log da cadeia", () => {
    const { deps, logs } = harness({ status: 0 }, { status: 0, stdout: okResult });
    deps.findRoundTrace = () => ["261022/plan.json"];
    assert.equal(main(makeRepo(), deps), 0);
    assert.ok(
      logs.some((l) => /^overnight: resultado subtype=success is_error=false turns=4 duracao_s=29 tail=Fila vazia: 0 elegíveis/.test(l)),
      logs.join("\n"),
    );
    assert.ok(logs.includes("overnight: rastro 261022/plan.json"));
  });

  it("exit 0 sem plan.json/report.md novo → no-trace, exit EXIT_OVERNIGHT_NO_TRACE (antes saía 'ok')", () => {
    const { deps, logs } = harness({ status: 0 }, { status: 0, stdout: okResult });
    deps.findRoundTrace = () => [];
    assert.equal(main(makeRepo(), deps), EXIT_OVERNIGHT_NO_TRACE);
    assert.ok(logs.some((l) => l.startsWith("overnight: SEM RASTRO")));
    assert.ok(logs.some((l) => /fim review=ok overnight=no-trace exit=4/.test(l)));
  });

  it("#10880: halt da sonda exige relatório antes do encerramento, sem apagar o erro", () => {
    const skill = readFileSync(join(import.meta.dirname, "..", ".claude/skills/diaria-overnight/SKILL.md"), "utf8");
    const halt = skill.split("\n").find((line) => line.startsWith("- **Sonda do par efetivo (passo 1):**"));
    assert.ok(halt);
    assert.match(halt, /Exit 1 ou 2 é HALT/);
    assert.match(halt, /coordinator_model_probe_failed.*--level error/);
    assert.match(halt, /Antes de encerrar, grave um \x60report\.md\x60 mínimo.*path.*passo 0/);
    assert.match(halt, /sufixo de colisão; nunca sobrescreva relatório de outra sessão/);
    assert.match(halt, /timestamp ISO real, exit code da sonda.*motivo\/diagnóstico/);
    assert.match(halt, /preserve o evento de erro.*Depois rode o encerramento/);
  });

  it("relatório mínimo em diretório sufixado é rastro válido no runner real", () => {
    const root = makeRepo();
    const dir = join(root, "data", "overnight", "261022b");
    mkdirSync(dir, { recursive: true });
    const { deps, logs } = harness({ status: 0 }, { status: 0 });
    const spawn = deps.spawn;
    deps.spawn = ((command, args, options) => {
      if (command !== "bash") {
        writeFileSync(join(dir, "report.md"),
          `coordinator_model_probe_failed\nTimestamp: ${new Date().toISOString()}\nExit: 1\nSonda inválida; fase autônoma não começou.\n`);
        // Evita depender da resolução de mtime do filesystem.
        const fresh = new Date(Date.now() + 1000);
        utimesSync(join(dir, "report.md"), fresh, fresh);
      }
      return spawn(command, args, options);
    }) as typeof deps.spawn;
    deps.findRoundTrace = findRoundTraceSince;
    assert.equal(main(root, deps), 0);
    assert.ok(logs.includes("overnight: rastro 261022b/report.md"));
    assert.ok(!logs.some((line) => line.startsWith("overnight: SEM RASTRO")));
  });

  it("evento result com is_error e exit 0 → falha do overnight", () => {
    const { deps } = harness({ status: 0 }, { status: 0, stdout: ev({ type: "result", subtype: "error_during_execution", is_error: true, result: "" }) });
    deps.findRoundTrace = () => ["x/plan.json"];
    assert.equal(main(makeRepo(), deps), EXIT_OVERNIGHT_FAILED);
  });

  it("no-trace não mascara falha do review, mas fica atrás da falha do overnight", () => {
    assert.equal(chainExitCode("failed", { status: "no-trace", exitCode: 0 }), EXIT_OVERNIGHT_NO_TRACE);
    assert.equal(chainExitCode("ok", { status: "failed", exitCode: 1 }), EXIT_OVERNIGHT_FAILED);
  });

  it("sem evento result: aviso explícito no log; rastro não verificável não reprova", () => {
    const { deps, logs } = harness({ status: 0 }, { status: 0, stdout: "" });
    deps.findRoundTrace = () => null;
    assert.equal(main(makeRepo(), deps), 0);
    assert.ok(logs.some((l) => l.startsWith("overnight: AVISO — sem evento result")));
    assert.ok(logs.some((l) => l.startsWith("overnight: AVISO — não deu pra verificar o rastro")));
  });

  it("findRoundTraceSince: só plan.json/report.md modificados desde o início contam", () => {
    const root = makeRepo();
    assert.equal(findRoundTraceSince(root, 0), null, "sem data/ não é verificável");
    const dir = join(root, "data", "overnight");
    mkdirSync(join(dir, "261021c"), { recursive: true });
    mkdirSync(join(dir, "261022"), { recursive: true });
    writeFileSync(join(dir, "261021c", "report.md"), "velho");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, "261021c", "report.md"), old, old);
    writeFileSync(join(dir, ".nightly-chain.log"), "x");
    const since = Date.now() - 60_000;
    assert.deepEqual(findRoundTraceSince(root, since), []);
    writeFileSync(join(dir, "261022", "plan.json"), "{}");
    assert.deepEqual(findRoundTraceSince(root, since), ["261022/plan.json"]);
  });

  it("DEFAULT_DEPS verifica o rastro e lê o resumo", () => {
    assert.equal(DEFAULT_DEPS.findRoundTrace, findRoundTraceSince);
    assert.equal(DEFAULT_DEPS.readReviewSummary, readReviewSummary);
  });
});
