/**
 * test/stage4-pregate-14034.test.ts (#14034)
 *
 * Pré-gate da Etapa 4 headless: o `/diaria-edicao` roda §4a–§4c num
 * `claude -p` próprio e a sessão do editor abre já no gate.
 *
 * O que estes testes protegem, em ordem de importância:
 *   1. O spawn do pré-gate NUNCA recebe `--no-gates` (auto-aprovaria o gate
 *      de revisão, um dos dois gates humanos de projeto) e o runner recusa o
 *      spawn que tenha escrito o sentinel do Stage 4.
 *   2. O marcador só abre o gate direto para o conteúdo em que o resumo foi
 *      feito: edição posterior de `02-reviewed.md`/`03-social.md` invalida.
 *   3. Pré-gate bloqueado (pede o editor) não abre o gate direto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { writeSentinel } from "../scripts/lib/pipeline-state.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEADLESS_FLAGS,
  STAGE4_PREGATE_FLAG,
  buildStagePrompt,
  runEditionStages,
  releaseOrphanPregateLock,
  PREGATE_SENTINEL_REJECTED_EXIT,
  PREGATE_REJECTED_SENTINEL_REL,
  STAGE_PLAN,
} from "../scripts/lib/edition-stage-runner.ts";
import {
  checkStage4Pregate,
  writeStage4Pregate,
  snapshotStage4Pregate,
  deterministicBlocking,
  contentFiles,
  type CheckRunner,
  main as pregateMain,
  PREGATE_SUMMARY_REL,
  PREGATE_MARKER_REL,
} from "../scripts/lib/stage4-pregate.ts";
import { main as cliMain } from "../scripts/run-edition-stages.ts";
import { resolveEditionDir } from "../scripts/lib/find-current-edition.ts";

function tmpEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "pregate-14034-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "# edição\nD1 texto\n");
  writeFileSync(join(dir, "03-social.md"), "## d1\npost\n");
  return dir;
}

function writeSummary(dir: string, text = "## fact_check_block\n✅ ok\n"): void {
  writeFileSync(join(dir, PREGATE_SUMMARY_REL), text);
}

/** Checks determinísticos todos limpos (fake: nenhum processo real). */
const CLEAN: CheckRunner = (script) =>
  script === "lint-newsletter-md.ts"
    ? { status: 0, stdout: JSON.stringify({ stage: 4, passed: true, checks: [] }), stderr: "" }
    : { status: 0, stdout: "", stderr: "" };

/** snapshot + write, como o playbook faz no fim do pré-gate. */
function seal(dir: string, opts: { blocking?: string[]; runCheck?: CheckRunner } = {}) {
  snapshotStage4Pregate(dir);
  return writeStage4Pregate(dir, { runCheck: CLEAN, ...opts });
}

describe("stage4-pregate — marcador (#14034)", () => {
  it("sem marcador = absent, não usável", () => {
    const dir = tmpEdition();
    try {
      const c = checkStage4Pregate(dir);
      assert.equal(c.usable, false);
      assert.equal(c.reason, "absent");
      assert.equal(c.completed, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write recusa sem resumo (gate sem lints nem fact-check é pior que o fluxo inline)", () => {
    const dir = tmpEdition();
    try {
      assert.throws(() => seal(dir), /resumo do pré-gate ausente/);
      writeSummary(dir, "   \n");
      assert.throws(() => seal(dir), /ausente ou vazio/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write + check = usable para o conteúdo atual", () => {
    const dir = tmpEdition();
    try {
      writeSummary(dir);
      seal(dir);
      const c = checkStage4Pregate(dir);
      assert.equal(c.usable, true);
      assert.equal(c.reason, "ok");
      assert.equal(c.summary_path, PREGATE_SUMMARY_REL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição de 02-reviewed.md ou 03-social.md depois do pré-gate = stale (resumo é de outro texto)", () => {
    for (const file of ["02-reviewed.md", "03-social.md"]) {
      const dir = tmpEdition();
      try {
        writeSummary(dir);
        seal(dir);
        writeFileSync(join(dir, file), "conteúdo editado pelo editor\n");
        const c = checkStage4Pregate(dir);
        assert.equal(c.usable, false, file);
        assert.equal(c.completed, false, file);
        assert.equal(c.reason, "stale", file);
        assert.deepEqual(c.changed_files, [file]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("bloqueio registrado = concluído mas não usável", () => {
    const dir = tmpEdition();
    try {
      writeSummary(dir);
      seal(dir, { blocking: ["fact-check exit 2: D2 claim sem fonte", "  "] });
      const c = checkStage4Pregate(dir);
      assert.equal(c.usable, false);
      assert.equal(c.completed, true);
      assert.equal(c.reason, "blocked");
      assert.deepEqual(c.blocking, ["fact-check exit 2: D2 claim sem fonte"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marcador corrompido ou resumo apagado não abre o gate", () => {
    const dir = tmpEdition();
    try {
      writeFileSync(join(dir, PREGATE_MARKER_REL), "{nao json");
      assert.equal(checkStage4Pregate(dir).reason, "corrupt");
      writeSummary(dir);
      seal(dir);
      rmSync(join(dir, PREGATE_SUMMARY_REL));
      assert.equal(checkStage4Pregate(dir).reason, "summary_missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI: write com --blocking repetido, check sai 0/1", () => {
    const dir = tmpEdition();
    const out: string[] = [];
    const err: string[] = [];
    try {
      assert.equal(pregateMain(["check", "--edition-dir", dir], (s) => out.push(s), (s) => err.push(s), CLEAN), 1);
      writeSummary(dir);
      assert.equal(pregateMain(["write", "--edition-dir", dir], (s) => out.push(s), (s) => err.push(s), CLEAN), 2, "sem snapshot, recusa");
      assert.equal(pregateMain(["snapshot", "--edition-dir", dir], (s) => out.push(s), (s) => err.push(s), CLEAN), 0);
      assert.equal(pregateMain(["write", "--edition-dir", dir], (s) => out.push(s), (s) => err.push(s), CLEAN), 0);
      assert.equal(pregateMain(["check", "--edition-dir", dir], (s) => out.push(s), (s) => err.push(s), CLEAN), 0);
      assert.equal(
        pregateMain(["write", "--edition-dir", dir, "--blocking", "a", "--blocking", "b"], (s) => out.push(s), (s) => err.push(s), CLEAN),
        0,
      );
      assert.deepEqual(JSON.parse(readFileSync(join(dir, PREGATE_MARKER_REL), "utf8")).blocking, ["a", "b"]);
      assert.equal(pregateMain(["check", "--edition-dir", dir], (s) => out.push(s), (s) => err.push(s), CLEAN), 1);
      assert.equal(pregateMain(["write", "--edition-dir"], (s) => out.push(s), (s) => err.push(s), CLEAN), 2);
      assert.equal(pregateMain(["check", "--edition-dir", dir, "--blocking", "x"], (s) => out.push(s), (s) => err.push(s), CLEAN), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stage4-pregate — snapshot depois da última autocorreção (P2 do review da #14103)", () => {
  it("write sem snapshot recusa e não grava marcador", () => {
    const dir = tmpEdition();
    try {
      writeSummary(dir);
      assert.throws(() => writeStage4Pregate(dir, { runCheck: CLEAN }), /snapshot do conteúdo ausente/);
      assert.ok(!existsSync(join(dir, PREGATE_MARKER_REL)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("texto mudado entre o snapshot e o write = recusa, sem marcador", () => {
    const dir = tmpEdition();
    try {
      writeSummary(dir);
      snapshotStage4Pregate(dir);
      writeFileSync(join(dir, "03-social.md"), "editado depois do snapshot\n");
      assert.throws(() => writeStage4Pregate(dir, { runCheck: CLEAN }), /mudou depois do snapshot \(03-social\.md\)/);
      assert.ok(!existsSync(join(dir, PREGATE_MARKER_REL)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("texto mudado DURANTE os checks também recusa", () => {
    const dir = tmpEdition();
    try {
      writeSummary(dir);
      snapshotStage4Pregate(dir);
      const mutating: CheckRunner = (script, args) => {
        if (script === "check-invariants.ts") writeFileSync(join(dir, "02-reviewed.md"), "mexido\n");
        return CLEAN(script, args);
      };
      assert.throws(() => writeStage4Pregate(dir, { runCheck: mutating }), /mudou durante os checks/);
      assert.ok(!existsSync(join(dir, PREGATE_MARKER_REL)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stage4-pregate — bloqueios determinísticos (P2 do review da #14103)", () => {
  const dir = "/x/edicao";
  const runner = (over: Record<string, Partial<{ status: number; stdout: string; stderr: string }>>): CheckRunner =>
    (script, args) => ({ ...CLEAN(script, args), ...(over[script] ?? {}) }) as ReturnType<CheckRunner>;

  it("tudo limpo = nenhum bloqueio, e o fact-check roda com --check-blocking sobre o fact-check.json", () => {
    const calls: Array<[string, string[]]> = [];
    const r = deterministicBlocking(dir, (s, a) => (calls.push([s, a]), CLEAN(s, a)));
    assert.deepEqual(r, []);
    const fc = calls.find(([s]) => s === "run-fact-checker.ts");
    assert.ok(fc && fc[1].includes("--check-blocking") && fc[1].some((a) => a.endsWith("fact-check.json")));
    assert.deepEqual(
      calls.map(([s]) => s),
      ["run-fact-checker.ts", "check-invariants.ts", "lint-newsletter-md.ts", "validate-lancamentos.ts", "validate-domain-diversity.ts", "validate-amazon-affiliate-tags.ts"],
    );
  });

  it("fact-check exit 2 e exit 1 DEFASADO bloqueiam; exit 1 comum (indisponível) não", () => {
    assert.match(deterministicBlocking(dir, runner({ "run-fact-checker.ts": { status: 2 } })).join(), /NOT_FOUND_IN_SOURCE/);
    assert.match(
      deterministicBlocking(dir, runner({ "run-fact-checker.ts": { status: 1, stderr: "FACT-CHECK DEFASADO (#11685)" } })).join(),
      /DEFASADO/,
    );
    assert.deepEqual(deterministicBlocking(dir, runner({ "run-fact-checker.ts": { status: 1, stderr: "fact-check.json ausente" } })), []);
  });

  it("lint GATE-BLOCKING, invariante e validate-* com exit != 0 bloqueiam; lint ilegível também", () => {
    const lintFail = JSON.stringify({
      stage: 4,
      passed: false,
      checks: [
        { id: "no-xml-artifacts", severity: "gate-blocking", ok: false },
        { id: "algum-warn", severity: "warn", ok: false },
      ],
    });
    const r = deterministicBlocking(
      dir,
      runner({
        "lint-newsletter-md.ts": { status: 1, stdout: lintFail },
        "check-invariants.ts": { status: 1 },
        "validate-domain-diversity.ts": { status: 1 },
      }),
    );
    assert.equal(r.length, 3, r.join(" | "));
    assert.match(r.join(), /no-xml-artifacts/);
    assert.ok(!r.join().includes("algum-warn"));
    assert.match(deterministicBlocking(dir, runner({ "lint-newsletter-md.ts": { status: 1, stdout: "crash" } })).join(), /sem JSON legível/);
  });

  it("write grava os bloqueios do disco mesmo sem --blocking, e soma o --blocking do playbook", () => {
    const d = tmpEdition();
    try {
      writeSummary(d);
      snapshotStage4Pregate(d);
      const m = writeStage4Pregate(d, { runCheck: runner({ "run-fact-checker.ts": { status: 2 } }), blocking: ["halt banner"] });
      assert.equal(m.blocking.length, 2);
      assert.equal(checkStage4Pregate(d).reason, "blocked");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("stage4-pregate — o hash cobre imagens, 01-approved.json e 01-eia.md (P3 do review da #14103)", () => {
  function prepared() {
    const dir = tmpEdition();
    writeFileSync(join(dir, "01-eia.md"), "eia\n");
    writeFileSync(join(dir, "_internal", "01-approved.json"), "{}\n");
    writeFileSync(join(dir, "04-d1-2x1.jpg"), "img1");
    writeFileSync(join(dir, "04-d1-carousel-p1-4x5.jpg"), "card1");
    writeFileSync(join(dir, "01-eia-A.jpg"), "a");
    writeFileSync(join(dir, "04-livros-promo.jpg"), "fora");
    writeSummary(dir);
    seal(dir);
    return dir;
  }

  it("lista de arquivos cobertos", () => {
    const dir = prepared();
    try {
      const files = contentFiles(dir);
      for (const f of ["02-reviewed.md", "03-social.md", "01-eia.md", "_internal/01-approved.json", "04-d1-2x1.jpg", "04-d1-carousel-p1-4x5.jpg", "01-eia-A.jpg"]) {
        assert.ok(files.includes(f), f);
      }
      assert.ok(!files.includes("04-livros-promo.jpg"), "promo de livros não é imagem de destaque");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [what, mutate] of [
    ["imagem de destaque trocada", (d: string) => writeFileSync(join(d, "04-d1-2x1.jpg"), "img nova")],
    ["card do carrossel novo", (d: string) => writeFileSync(join(d, "04-d2-carousel-p2-4x5.jpg"), "novo")],
    ["imagem removida", (d: string) => rmSync(join(d, "04-d1-carousel-p1-4x5.jpg"))],
    ["01-approved.json mudou", (d: string) => writeFileSync(join(d, "_internal", "01-approved.json"), '{"x":1}\n')],
    ["01-eia.md mudou", (d: string) => writeFileSync(join(d, "01-eia.md"), "outro\n")],
  ] as const) {
    it(`${what} = stale`, () => {
      const dir = prepared();
      try {
        assert.equal(checkStage4Pregate(dir).usable, true);
        mutate(dir);
        assert.equal(checkStage4Pregate(dir).reason, "stale");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("edition-stage-runner — prompt do pré-gate (#14034)", () => {
  const base = { aammdd: "261127", sessionSupervised: false, editionDirNote: "DIR" };

  it("Stage 4 em pré-gate leva --pre-gate-only e NUNCA --no-gates", () => {
    const p = buildStagePrompt({ ...base, stage: 4, skill: "diaria-4-revisao", stage4PreGate: true });
    assert.ok(p.startsWith(`/diaria-4-revisao 261127 ${STAGE4_PREGATE_FLAG} `), p);
    assert.ok(!p.includes(HEADLESS_FLAGS), `pré-gate com --no-gates auto-aprovaria o gate: ${p}`);
  });

  it("Stages 1-3 e o Stage 4 sem pré-gate seguem com --no-gates", () => {
    for (const { stage, skill } of STAGE_PLAN) {
      const pre = stage < 4;
      const p = buildStagePrompt({ ...base, stage, skill, stage4PreGate: pre });
      assert.ok(p.includes(HEADLESS_FLAGS), p);
      assert.ok(!p.includes(STAGE4_PREGATE_FLAG), p);
    }
    const p4 = buildStagePrompt({ ...base, stage: 4, skill: "diaria-4-revisao", stage4PreGate: false });
    assert.ok(p4.includes(HEADLESS_FLAGS) && !p4.includes(STAGE4_PREGATE_FLAG), p4);
  });
});

describe("edition-stage-runner — pós-condição do pré-gate (#14034)", () => {
  function world(opts: { gateDone?: boolean; pregateBefore?: boolean; spawnWrites?: "marker" | "sentinel" | "nothing" }) {
    let gateDone = opts.gateDone ?? false;
    let pregate = opts.pregateBefore ?? false;
    const prompts: string[] = [];
    const execFn = ((_cmd: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      if (opts.spawnWrites === "marker") pregate = true;
      if (opts.spawnWrites === "sentinel") gateDone = true;
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;
    const runOpts = {
      aammdd: "261127",
      editionDir: "/fake/data/editions/2611/261127",
      repoRootAbs: "/fake/repo",
      resolveClaudeBin: () => "/fake/bin/claude",
      env: {} as NodeJS.ProcessEnv,
      plan: [{ stage: 4, skill: "diaria-4-revisao" }],
      stage4PreGate: true,
      execFn,
      nowMs: () => 0,
      assertSentinelFn: (_d: string, step: number) =>
        step === 4 && gateDone ? { ok: true as const } : { ok: false as const, reason: "sentinel_missing" as const },
      checkPregateFn: () => ({
        usable: pregate,
        completed: pregate,
        reason: (pregate ? "ok" : "absent") as "ok" | "absent",
        blocking: [],
        summary_path: PREGATE_SUMMARY_REL,
      }),
    };
    return { prompts, runOpts };
  }

  it("spawn que grava o marcador = ok", () => {
    const { prompts, runOpts } = world({ spawnWrites: "marker" });
    const r = runEditionStages(runOpts);
    assert.equal(r.exitCode, 0);
    assert.equal(r.outcomes[0].status, "ok");
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes(STAGE4_PREGATE_FLAG) && !prompts[0].includes(HEADLESS_FLAGS));
  });

  it("spawn que sai 0 sem o marcador = falha (sessão interativa cai no fluxo inline)", () => {
    const { runOpts } = world({ spawnWrites: "nothing" });
    const r = runEditionStages(runOpts);
    assert.equal(r.exitCode, 1);
    assert.equal(r.failedStage, 4);
    assert.match(r.outcomes[0].failureTail ?? "", /marcador do pré-gate não foi escrito/);
  });

  it("spawn que escreve o sentinel do Stage 4 = falha alta (gate aprovado sem o editor)", () => {
    const { runOpts } = world({ spawnWrites: "sentinel" });
    const quarantined: string[] = [];
    const r = runEditionStages({ ...runOpts, quarantineSentinelFn: (d) => (quarantined.push(d), "q") });
    assert.equal(r.exitCode, PREGATE_SENTINEL_REJECTED_EXIT);
    assert.equal(r.outcomes.length, 1);
    assert.equal(r.outcomes[0].exitCode, PREGATE_SENTINEL_REJECTED_EXIT);
    assert.match(r.outcomes[0].failureTail ?? "", /gate aprovado sem o editor.*PARAR/);
    assert.deepEqual(quarantined, [runOpts.editionDir]);
  });

  it("P1 (#14103): sentinel do pré-gate vai para quarentena em disco e a reexecução mostra o gate de novo", () => {
    const dir = mkdtempSync(join(tmpdir(), "pregate-q-14034-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "02-reviewed.md"), "x\n");
      writeFileSync(join(dir, "03-social.md"), "y\n");
      const prompts: string[] = [];
      let spawnWritesSentinel = true;
      const execFn = ((_c: string, args: string[]) => {
        prompts.push(args[args.length - 1]);
        if (spawnWritesSentinel) {
          writeSentinel(dir, 4, ["02-reviewed.md", "03-social.md"]);
          throw Object.assign(new Error("crash depois de aprovar"), { status: 1 });
        }
        writeSummary(dir);
        seal(dir);
        return "";
      }) as unknown as typeof import("node:child_process").execFileSync;
      const base = {
        aammdd: "261127",
        editionDir: dir,
        repoRootAbs: dir,
        resolveClaudeBin: () => "/fake/bin/claude",
        env: {} as NodeJS.ProcessEnv,
        plan: [{ stage: 4, skill: "diaria-4-revisao" }],
        stage4PreGate: true,
        execFn,
        nowMs: () => 0,
        readEditionLockFn: () => null,
      };
      const r1 = runEditionStages(base);
      assert.equal(r1.exitCode, PREGATE_SENTINEL_REJECTED_EXIT);
      assert.ok(!existsSync(join(dir, "_internal", ".step-4-done.json")), "sentinel não pode ficar no lugar");
      assert.ok(existsSync(join(dir, PREGATE_REJECTED_SENTINEL_REL)));
      spawnWritesSentinel = false;
      const r2 = runEditionStages(base);
      assert.equal(prompts.length, 2, "a reexecução tem de spawnar o pré-gate de novo, não pular como 'gate aprovado'");
      assert.equal(r2.exitCode, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gate já aprovado ou pré-gate já feito para o conteúdo atual = SKIP, sem spawn", () => {
    for (const w of [world({ gateDone: true }), world({ pregateBefore: true })]) {
      const r = runEditionStages(w.runOpts);
      assert.equal(r.outcomes[0].status, "skipped");
      assert.equal(w.prompts.length, 0);
    }
  });
});

describe("trava órfã do spawn do pré-gate (#14034, P2 do self-review da #14103)", () => {
  const lock = (session_id: string, released = false) => ({
    session_id,
    host: "neo",
    stage: 4,
    acquired_at: "2026-11-26T10:00:00.000Z",
    heartbeat_at: "2026-11-26T10:00:00.000Z",
    ...(released ? { released_at: "2026-11-26T10:05:00.000Z" } : {}),
  });

  function run(opts: { lockOwner?: string; spawnThrows?: boolean; releaseThrows?: boolean; stage4PreGate?: boolean }) {
    const released: string[] = [];
    const progress: string[] = [];
    const calls: string[][] = [];
    const execFn = ((_cmd: string, args: string[]) => {
      calls.push(args);
      if (opts.spawnThrows) {
        const e = new Error("killed") as Error & { status?: number };
        e.status = 137;
        throw e;
      }
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;
    const r = runEditionStages({
      aammdd: "261127",
      editionDir: "/fake/data/editions/2611/261127",
      repoRootAbs: "/fake/repo",
      resolveClaudeBin: () => "/fake/bin/claude",
      env: {} as NodeJS.ProcessEnv,
      plan: [{ stage: 4, skill: "diaria-4-revisao" }],
      stage4PreGate: opts.stage4PreGate ?? true,
      execFn,
      nowMs: () => 0,
      onProgress: (m) => progress.push(m),
      assertSentinelFn: () => ({ ok: false as const, reason: "sentinel_missing" as const }),
      checkPregateFn: () => ({ usable: false, completed: false, reason: "absent" as const, blocking: [], summary_path: PREGATE_SUMMARY_REL }),
      randomUuidFn: () => "uuid-pregate-1",
      readEditionLockFn: () => (opts.lockOwner ? lock(opts.lockOwner) : null),
      releaseEditionLockFn: (_d, id) => {
        if (opts.releaseThrows) throw new Error("EBUSY");
        released.push(id);
      },
    });
    return { r, released, progress, calls };
  }

  it("spawn morto com a trava dele = runner solta a trava (sessão do editor não sai com exit 3)", () => {
    const { r, released, calls } = run({ lockOwner: "uuid-pregate-1", spawnThrows: true });
    assert.equal(r.failedStage, 4);
    assert.deepEqual(released, ["uuid-pregate-1"]);
    const args = calls[0];
    assert.equal(args[args.indexOf("--session-id") + 1], "uuid-pregate-1", "o spawn tem de rodar com o id que o runner conhece");
  });

  it("trava de OUTRA sessão nunca é tocada", () => {
    const { released } = run({ lockOwner: "sessao-do-editor", spawnThrows: true });
    assert.deepEqual(released, []);
  });

  it("sem trava ou trava já solta pelo playbook = nada a fazer", () => {
    assert.deepEqual(run({}).released, []);
    const released: string[] = [];
    const out = releaseOrphanPregateLock("/x", ["a"], {
      readLockFn: () => lock("a", true),
      releaseFn: (_d, id) => released.push(id),
      onProgress: () => {},
    });
    assert.equal(out, null);
    assert.deepEqual(released, []);
  });

  it("release que falha vira aviso com o comando, nunca exceção", () => {
    const { progress, released } = run({ lockOwner: "uuid-pregate-1", spawnThrows: true, releaseThrows: true });
    assert.deepEqual(released, []);
    assert.ok(progress.some((m) => /não consegui soltar a trava.*--session-id uuid-pregate-1/.test(m)), progress.join(" | "));
    assert.equal(
      releaseOrphanPregateLock("/x", ["a"], {
        readLockFn: () => {
          throw new Error("EACCES");
        },
        releaseFn: () => {},
        onProgress: () => {},
      }),
      null,
    );
  });

  it("fora do pré-gate (Stage 4 agendado) o spawn não ganha --session-id nem release", () => {
    const { calls, released } = run({ lockOwner: "uuid-pregate-1", stage4PreGate: false });
    assert.ok(!calls[0].includes("--session-id"));
    assert.deepEqual(released, []);
  });
});

describe("run-edition-stages CLI — --stage4-pre-gate (#14034)", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "pregate-cli-14034-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    const editionDir = resolveEditionDir(join(root, "data", "editions"), "261127");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(join(editionDir, "02-reviewed.md"), "x\n");
    writeFileSync(join(editionDir, "03-social.md"), "y\n");
    const prompts: string[] = [];
    const done = new Set<number>();
    const execFn = ((_cmd: string, args: string[]) => {
      const prompt = args[args.length - 1];
      prompts.push(prompt);
      const m = prompt.match(/diaria-(\d)-/);
      const stage = m ? Number(m[1]) : 0;
      if (stage === 4) {
        // o spawn do pré-gate grava resumo + marcador (o que o playbook manda)
        writeFileSync(join(editionDir, PREGATE_SUMMARY_REL), "## violations_block\n✅\n");
        snapshotStage4Pregate(editionDir);
        writeStage4Pregate(editionDir, { runCheck: CLEAN });
      } else {
        done.add(stage);
      }
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;
    const err: string[] = [];
    const deps = {
      execFn,
      resolveClaudeBinFn: () => "/fake/bin/claude",
      authPreflightFn: () => ({ error: null, warning: null }),
      assertSentinelFn: (_d: string, step: number) =>
        done.has(step) ? { ok: true as const } : { ok: false as const, reason: "sentinel_missing" as const },
      env: {} as NodeJS.ProcessEnv,
      stdout: () => {},
      stderr: (l: string) => err.push(l),
      repoRootAbs: root,
    };
    return { root, editionDir, prompts, deps, err };
  }

  it("sem --through implica --through 4, com o Stage 4 em pré-gate", () => {
    const s = setup();
    try {
      const code = cliMain(["--edition", "261127", "--stage4-pre-gate"], s.deps);
      assert.equal(code, 0, s.err.join("\n"));
      assert.deepEqual(
        s.prompts.map((p) => p.split(" ").slice(0, 3).join(" ")),
        ["/diaria-1-pesquisa 261127 --no-gates", "/diaria-2-escrita 261127 --no-gates", "/diaria-3-imagens 261127 --no-gates", "/diaria-4-revisao 261127 --pre-gate-only"],
      );
      assert.ok(!s.prompts[3].includes(HEADLESS_FLAGS));
      assert.equal(checkStage4Pregate(s.editionDir).usable, true);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("--through menor que 4 com --stage4-pre-gate = exit 2 sem spawnar", () => {
    const s = setup();
    try {
      const code = cliMain(["--edition", "261127", "--through", "3", "--stage4-pre-gate"], s.deps);
      assert.equal(code, 2);
      assert.match(s.err.join("\n"), /--stage4-pre-gate exige --through 4/);
      assert.equal(s.prompts.length, 0);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});

describe("wiring dos playbooks (#14034)", () => {
  const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", ...p), "utf8");

  it("/diaria-edicao manda --stage4-pre-gate com o editor presente e mantém --through 3 no --no-gates", () => {
    const skill = read(".claude", "skills", "diaria-edicao", "SKILL.md");
    assert.match(skill, /run-edition-stages\.ts --edition \$1 --stage4-pre-gate --session-supervised/);
    assert.match(skill, /run-edition-stages\.ts --edition \$1 --through 3/);
  });

  it("pré-gate grava resumo + marcador, solta a trava e não aprova o gate; a sessão interativa checa o marcador", () => {
    const pb = read(".claude", "agents", "orchestrator-stage-4.md");
    assert.match(pb, /stage4-pregate\.ts write --edition-dir/);
    assert.match(pb, /edition-lock\.ts release --edition-dir/);
    assert.match(pb, /stage4-pregate\.ts check --edition-dir/);
    assert.match(pb, /04-pregate-summary\.md/);
    const rev = read(".claude", "skills", "diaria-4-revisao", "SKILL.md");
    assert.match(rev, /--pre-gate-only/);
    assert.match(rev, /Não combinar com `--no-gates`/);
  });
});
