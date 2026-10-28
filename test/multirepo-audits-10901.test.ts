/**
 * test/multirepo-audits-10901.test.ts (#10901)
 *
 * Os scripts de auditoria/reconciliação de backlog que ainda eram só-studio
 * passam a cobrir os repos de `platform.config.json → issue_repos`:
 *   - `reconcile-issue-dependencies.ts --repos` (depends-on por repo, -R por repo);
 *   - `check-issue-file-collisions.ts --repos` (colisão só dentro do repo);
 *   - `check-dependency-prose-lint.ts --repos`;
 *   - `check-continuo-escalate-label.ts --repo`;
 *   - `desbloqueia-scan.ts --repo` (`runDesbloqueioScan({ repo })`).
 * Sem `--repos`/`--repo`, o comportamento de sempre (só o studio). Todo `gh`
 * aqui é falso — nenhuma chamada real a nenhum repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listOpenIssuesByRepo, resolveReposCliArg, type GhRunFn } from "../scripts/lib/open-issues-by-repo.ts";
import { main as collisionsMain, computeCollisionsByRepo } from "../scripts/check-issue-file-collisions.ts";
import { main as proseLintMain } from "../scripts/check-dependency-prose-lint.ts";
import { main as reconcileMain, buildReconcileReport } from "../scripts/reconcile-issue-dependencies.ts";
import { runDesbloqueioScan } from "../scripts/desbloqueia-scan.ts";
import { ensureContinuoLabel, CONTINUO_ESCALATED_LABEL_SPEC } from "../scripts/lib/continuo-labels.ts";

/** #11243: pulado só no Windows (Neo); no CI Linux e no `300` roda normal. */
const SKIP_WIN32 = process.platform === "win32" && "#11243: CLI do continuo testado com gh falso (shim bash + PATH com ':'); no Windows o gh.exe real vence o shim. O CLI só roda no 300";

const STUDIO = "vjpixel/diaria-studio";
const DESIGN = "vjpixel/diaria-design";
const ALLOWED = [STUDIO, DESIGN];

function repoOf(args: string[]): string | undefined {
  const i = args.indexOf("-R");
  return i === -1 ? undefined : args[i + 1];
}

/** `gh issue list` falso por repo (`-R`); `null` = aquele repo falha. */
function listGh(byRepo: Record<string, unknown[] | null>, calls: string[][] = []): GhRunFn {
  return (args) => {
    calls.push(args);
    const data = byRepo[repoOf(args) ?? "(cwd)"];
    if (data === null || data === undefined) return { status: 1, stdout: "", stderr: "boom" };
    return { status: 0, stdout: JSON.stringify(data), stderr: "" };
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), errFn: (l: string) => err.push(l) };
}

describe("#10901 — listOpenIssuesByRepo / resolveReposCliArg", () => {
  it("sempre -R, default primeiro; falha do default é fatal, de repo extra vira repoErrors", () => {
    const calls: string[][] = [];
    const ok = listOpenIssuesByRepo<{ number: number }>({
      cwd: "/tmp",
      repos: [DESIGN],
      fields: "number",
      limit: 2,
      ghRun: listGh({ [STUDIO]: [{ number: 1 }, { number: 2 }], [DESIGN]: [{ number: 1 }] }, calls),
    });
    assert.deepEqual(calls.map(repoOf), [STUDIO, DESIGN]);
    assert.deepEqual(ok.issues, [
      { number: 1, repo: STUDIO },
      { number: 2, repo: STUDIO },
      { number: 1, repo: DESIGN },
    ]);
    assert.deepEqual(ok.truncated, [STUDIO]);

    const extraFails = listOpenIssuesByRepo({ cwd: "/tmp", repos: [DESIGN], fields: "number", limit: 9, ghRun: listGh({ [STUDIO]: [], [DESIGN]: null }) });
    assert.equal(extraFails.error, undefined);
    assert.equal(extraFails.repoErrors[0]?.repo, DESIGN);

    const defaultFails = listOpenIssuesByRepo({ cwd: "/tmp", repos: [DESIGN], fields: "number", limit: 9, ghRun: listGh({ [STUDIO]: null, [DESIGN]: [] }) });
    assert.match(defaultFails.error ?? "", /status 1/);
  });

  it("--repos: ausente = só default; sem valor/fora da allowlist = erro; all = allowlist", () => {
    assert.deepEqual(resolveReposCliArg({}, new Set(), ALLOWED), { repos: undefined });
    assert.ok("error" in resolveReposCliArg({}, new Set(["repos"]), ALLOWED));
    assert.ok("error" in resolveReposCliArg({ repos: "fork/x" }, new Set(), ALLOWED));
    assert.deepEqual(resolveReposCliArg({ repos: "all" }, new Set(), ALLOWED), { repos: ALLOWED });
  });
});

describe("#10901 — check-issue-file-collisions --repos", () => {
  const body = (p: string) => `## Escopo\n- \`${p}\`\n`;

  it("sem --repos: só o studio, com -R (comportamento de sempre)", () => {
    const calls: string[][] = [];
    const c = capture();
    const code = collisionsMain([], { ghRun: listGh({ [STUDIO]: [] }, calls), allowedRepos: ALLOWED, log: c.log, err: c.errFn });
    assert.equal(code, 0);
    assert.deepEqual(calls.map(repoOf), [STUDIO]);
  });

  it("--repos all: colisão só dentro do mesmo repo, rótulo owner/repo#N fora do default", () => {
    const c = capture();
    const code = collisionsMain(["--repos", "all"], {
      ghRun: listGh({
        [STUDIO]: [{ number: 21, title: "s", body: body("scripts/foo-bar.ts") }],
        [DESIGN]: [
          { number: 21, title: "d1", body: body("scripts/foo-bar.ts") },
          { number: 22, title: "d2", body: body("scripts/foo-bar.ts") },
        ],
      }),
      allowedRepos: ALLOWED,
      log: c.log,
      err: c.errFn,
    });
    assert.equal(code, 0);
    const text = c.out.join("\n");
    assert.match(text, /3 issue\(s\) aberta\(s\) verificada\(s\), 1 colisão/);
    assert.match(text, /vjpixel\/diaria-design#21 × vjpixel\/diaria-design#22/);
    // O #21 do studio cita o mesmo path, mas é outro arquivo (outro repo).
    assert.doesNotMatch(text, / #21 × /);
  });

  it("computeCollisionsByRepo nunca cruza repos", () => {
    const r = computeCollisionsByRepo([
      { repo: STUDIO, number: 1, body: body("scripts/x-y.ts") },
      { repo: DESIGN, number: 2, body: body("scripts/x-y.ts") },
    ]);
    assert.equal(r.collisions.length, 0);
  });

  it("--repos fora da allowlist → exit 2, nenhuma chamada gh", () => {
    const calls: string[][] = [];
    const c = capture();
    assert.equal(collisionsMain(["--repos", "fork/x"], { ghRun: listGh({}, calls), allowedRepos: ALLOWED, log: c.log, err: c.errFn }), 2);
    assert.equal(calls.length, 0);
  });
});

describe("#10901 — check-dependency-prose-lint --repos", () => {
  it("achado do design sai qualificado; sem --repos o design nem é listado", () => {
    const prose = "Só depois que o #5 fechar dá pra fazer isto. Pré-requisito: #5.";
    const byRepo = { [STUDIO]: [], [DESIGN]: [{ number: 7, body: prose }] };
    const c = capture();
    assert.equal(proseLintMain(["--repos", "all"], { ghRun: listGh(byRepo), allowedRepos: ALLOWED, log: c.log, err: c.errFn }), 0);
    assert.match(c.out.join("\n"), /^vjpixel\/diaria-design#7\t/m);

    const calls: string[][] = [];
    const c2 = capture();
    proseLintMain([], { ghRun: listGh(byRepo, calls), allowedRepos: ALLOWED, log: c2.log, err: c2.errFn });
    assert.deepEqual(calls.map(repoOf), [STUDIO]);
    assert.match(c2.out.join("\n"), /^ok/);
  });
});

describe("#10901 — reconcile-issue-dependencies --repos", () => {
  function run(argv: string[], issues: Array<{ repo: string; number: number; labels: string[]; body: string }>, states: Record<string, string>) {
    const calls: string[][] = [];
    const ghRun: GhRunFn = (args) => {
      calls.push(args);
      if (args[1] === "view") {
        const st = states[`${repoOf(args)}#${args[2]}`];
        return st ? { status: 0, stdout: JSON.stringify({ state: st }), stderr: "" } : { status: 1, stdout: "", stderr: "x" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    let fetchOpts: unknown;
    const fetchIssues = ((_cwd: string, opts: unknown) => {
      fetchOpts = opts;
      return { issues: issues.map((i) => ({ ...i, ref: `${i.repo}#${i.number}` })) };
    }) as never;
    const log = console.log;
    const errLog = console.error;
    const errs: string[] = [];
    console.log = () => {};
    console.error = (m: string) => errs.push(String(m));
    const prevExit = process.exitCode;
    let exitCode: typeof process.exitCode;
    return reconcileMain(argv, { ghRun, fetchIssues, cwd: "/tmp", allowedRepos: ALLOWED })
      .finally(() => {
        console.log = log;
        console.error = errLog;
        exitCode = process.exitCode;
        process.exitCode = prevExit;
      })
      .then(() => ({ calls, fetchOpts, errs, exitCode }));
  }

  it("--apply --repos all: depends-on #22 do design é o #22 DO DESIGN, label aplicada com -R design", async () => {
    const { calls, fetchOpts } = await run(
      ["--apply", "--repos", "all"],
      [
        { repo: STUDIO, number: 22, labels: [], body: "sem marcador" },
        { repo: DESIGN, number: 21, labels: [], body: "<!-- depends-on: #22 -->" },
      ],
      { [`${DESIGN}#22`]: "OPEN", [`${STUDIO}#22`]: "CLOSED" },
    );
    assert.deepEqual(fetchOpts, { repos: ALLOWED });
    const view = calls.find((c) => c[1] === "view");
    assert.deepEqual([view?.[2], repoOf(view ?? [])], ["22", DESIGN]);
    const edit = calls.find((c) => c[1] === "edit");
    assert.ok(edit, JSON.stringify(calls));
    assert.deepEqual([edit[2], repoOf(edit), edit.includes("--add-label")], ["21", DESIGN, true]);
  });

  it("sem --repos: o design nem entra (comportamento de sempre)", async () => {
    const { calls, fetchOpts } = await run(
      ["--apply"],
      [{ repo: DESIGN, number: 21, labels: [], body: "<!-- depends-on: #22 -->" }],
      { [`${DESIGN}#22`]: "OPEN" },
    );
    assert.deepEqual(fetchOpts, { repos: [STUDIO] });
    assert.equal(calls.length, 0);
  });

  it("--issue vjpixel/diaria-design#21 mira só aquela issue do design; repo fora da allowlist = exit 2", async () => {
    const issues = [
      { repo: DESIGN, number: 21, labels: ["dependencia-aberta"], body: "<!-- depends-on: #22 -->" },
      { repo: DESIGN, number: 30, labels: [], body: "<!-- depends-on: #31 -->" },
      { repo: STUDIO, number: 21, labels: [], body: "<!-- depends-on: #40 -->" },
    ];
    const { calls } = await run(["--apply", "--issue", `${DESIGN}#21`], issues, { [`${DESIGN}#22`]: "CLOSED" });
    assert.deepEqual(
      calls.map((c) => `${c[1]} ${c[2]} ${repoOf(c)}`),
      [`view 22 ${DESIGN}`, `edit 21 ${DESIGN}`],
    );
    const bad = await run(["--repos", "fork/x"], issues, {});
    assert.equal(bad.exitCode, 2);
    assert.equal(bad.calls.length, 0);
  });

  it("#10935: --repos só do design → fetch sem o studio (includeDefault=false), label no design", async () => {
    const { calls, fetchOpts } = await run(
      ["--apply", "--repos", DESIGN],
      [{ repo: DESIGN, number: 21, labels: [], body: "<!-- depends-on: #22 -->" }],
      { [`${DESIGN}#22`]: "OPEN" },
    );
    assert.deepEqual(fetchOpts, { repos: [DESIGN], includeDefault: false });
    const edit = calls.find((c) => c[1] === "edit");
    assert.ok(edit && repoOf(edit) === DESIGN, JSON.stringify(calls));
  });

  it("buildReconcileReport carimba o repo (default = studio)", () => {
    const issues = [{ number: 1, labels: [], body: "<!-- depends-on: #2 -->" }];
    assert.equal(buildReconcileReport(issues, {})[0]?.repo, STUDIO);
    assert.equal(buildReconcileReport(issues, {}, DESIGN)[0]?.repo, DESIGN);
  });
});

describe("#10901 — desbloqueia-scan --repo", () => {
  function gh(calls: string[][]): GhRunFn {
    return (args) => {
      calls.push(args);
      if (args[1] === "list") {
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 5, title: "t", labels: [{ name: "external-blocker" }], body: null, state: "OPEN", updatedAt: "2026-10-01T00:00:00Z" },
          ]),
          stderr: "",
        };
      }
      return { status: 0, stdout: JSON.stringify({ comments: [] }), stderr: "" };
    };
  }

  it("repo do design: toda chamada gh com -R design e relatório com repo", () => {
    const calls: string[][] = [];
    const report = runDesbloqueioScan(".", { runGh: gh(calls), repo: DESIGN });
    assert.ok(calls.length >= 2);
    for (const c of calls) assert.equal(repoOf(c), DESIGN, c.join(" "));
    assert.equal(report.repo, DESIGN);
  });

  it("#10935: cada candidata traz ref owner/repo#N do repo varrido (o playbook re-rotea por ela)", () => {
    type R = ReturnType<typeof runDesbloqueioScan>;
    const candidates = (r: R) => [
      ...r.jaDestravadas, ...r.bloqueioConfirmado, ...r.precisaPergunta, ...r.bloqueioObsoleto,
      ...r.semSinalNaoTriadas, ...r.acaoImediataCandidatas, ...r.acaoAdiada, ...r.erroLeitura,
    ];
    const design = candidates(runDesbloqueioScan(".", { runGh: gh([]), repo: DESIGN }));
    assert.ok(design.length >= 1);
    for (const c of design) assert.equal(c.ref, `${DESIGN}#${c.number}`);
    const studio = candidates(runDesbloqueioScan(".", { runGh: gh([]) }));
    assert.ok(studio.length >= 1);
    for (const c of studio) assert.equal(c.ref, `${STUDIO}#${c.number}`);
  });

  it("sem repo: -R studio e o JSON sem a chave repo (forma de sempre)", () => {
    const calls: string[][] = [];
    const report = runDesbloqueioScan(".", { runGh: gh(calls) });
    for (const c of calls) assert.equal(repoOf(c), STUDIO, c.join(" "));
    assert.equal("repo" in report, false);
  });
});

describe("#10901 — ensureContinuoLabel com repo", () => {
  it("cria o label no repo pedido; sem repo, {owner}/{repo} de sempre", () => {
    const calls: string[][] = [];
    const ghRun: GhRunFn = (args) => {
      calls.push(args);
      return { status: 0, stdout: "{}", stderr: "" };
    };
    ensureContinuoLabel(CONTINUO_ESCALATED_LABEL_SPEC, "/tmp", ghRun, DESIGN);
    ensureContinuoLabel(CONTINUO_ESCALATED_LABEL_SPEC, "/tmp", ghRun);
    assert.equal(calls[0]?.[3], `repos/${DESIGN}/labels`);
    assert.equal(calls[1]?.[3], "repos/{owner}/{repo}/labels");
  });
});

describe("#10901 — check-continuo-escalate-label --repo (CLI com gh falso)", { skip: SKIP_WIN32 }, () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const SCRIPT = "scripts/check-continuo-escalate-label.ts";
  const HEAD = "c".repeat(40);

  function withFakeGh(fn: (dir: string, log: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-10901-"));
    const log = join(dir, "calls.log");
    const fakeJs = [
      'import { appendFileSync } from "node:fs";',
      "const argv = process.argv.slice(2);",
      "appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(argv) + '\\n');",
      "const joined = argv.join(' ');",
      "if (argv[0] === 'pr' && argv[1] === 'view') {",
      "  if (joined.includes('--jq .labels[].name')) { process.stdout.write('continuo-escalado\\n'); process.exit(0); }",
      "  process.stdout.write(JSON.stringify([])); process.exit(0);",
      "}",
      "if (argv[0] === 'api') { process.stdout.write(joined.includes('POST') ? '{}' : ''); process.exit(0); }",
      "process.stderr.write('fake gh: nao previsto: ' + joined + '\\n'); process.exit(1);",
    ].join("\n");
    const fakeJsPath = join(dir, "fake-gh.mjs");
    writeFileSync(fakeJsPath, fakeJs, "utf8");
    const bin = join(dir, "gh");
    writeFileSync(bin, `#!/usr/bin/env bash\nexec node "${fakeJsPath}" "$@"\n`, "utf8");
    chmodSync(bin, 0o755);
    try {
      fn(dir, log);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function run(args: string[], dir: string, log: string): { stdout: string; status: number } {
    try {
      const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, FAKE_GH_CALLS: log, PATH: `${dir}:${process.env.PATH ?? ""}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, status: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      return { stdout: e.stdout ?? "", status: e.status ?? 1 };
    }
  }

  const readCalls = (log: string): string[][] =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];

  it("--repo vjpixel/diaria-design: label, releitura e marcador todos no design", () => {
    withFakeGh((dir, log) => {
      const { stdout, status } = run(["--pr", "12", "--head", HEAD, "--repo", DESIGN], dir, log);
      assert.equal(status, 0);
      assert.equal(JSON.parse(stdout.trim()).labelApplied, true);
      const calls = readCalls(log);
      assert.ok(calls.length >= 4, JSON.stringify(calls));
      for (const c of calls) {
        const scoped = repoOf(c) === DESIGN || c.some((a) => a.startsWith(`repos/${DESIGN}/`));
        assert.ok(scoped, `chamada fora do design: ${c.join(" ")}`);
      }
    });
  });

  it("sem --repo: nenhuma chamada com -R nem repo explícito (o de sempre)", () => {
    withFakeGh((dir, log) => {
      assert.equal(run(["--pr", "12", "--head", HEAD], dir, log).status, 0);
      for (const c of readCalls(log)) {
        assert.equal(repoOf(c), undefined, c.join(" "));
        assert.ok(!c.some((a) => a.includes(DESIGN)), c.join(" "));
      }
    });
  });

  it("--repo fora da allowlist → exit 2 sem chamar gh", () => {
    withFakeGh((dir, log) => {
      assert.equal(run(["--pr", "12", "--repo", "fork/x"], dir, log).status, 2);
      assert.equal(readCalls(log).length, 0);
    });
  });
});

describe("#10935 — playbook do /diaria-desbloqueia re-rotea pela referência completa", () => {
  const SKILL = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".claude/skills/diaria-desbloqueia/SKILL.md"), "utf8");

  it("nenhum comando route-issue.ts com --issue N pelado; todos com {ref}", () => {
    const cmds = SKILL.match(/route-issue\.ts\s+--issue\s+\S+/g) ?? [];
    assert.ok(cmds.length >= 3, `esperava os comandos de re-roteamento, achei ${cmds.length}`);
    // Exceções: a prosa que EXPLICA o erro (`--issue N` entre crases) e o
    // exemplo qualificado `owner/repo#N`.
    const bare = cmds.filter((c) => !/--issue\s+(\{ref\}|owner\/repo#N)/.test(c) && !/--issue\s+N`/.test(c));
    assert.deepEqual(bare, []);
    assert.match(SKILL, /`ref` que o scan devolve/);
    assert.match(SKILL, /gh issue comment\s+\{N\} -R/);
  });
});
