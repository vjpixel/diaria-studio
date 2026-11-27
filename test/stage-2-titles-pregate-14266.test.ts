/**
 * #14266 — `check-invariants --stage 2` barrava o pré-gate com
 * `reviewed-titles-per-highlight`: antes do gate o `02-reviewed.md` tem 3
 * opções de título por destaque POR DESENHO (#159/#589), então o
 * `stage-2-run.ts --phase post-checks` saía com exit 3 em toda edição, e o
 * `post-gate` (onde o title-picker roda) recusava sem um `post-checks` que
 * passou — deadlock.
 *
 * Fix: a checagem de 1 título por destaque virou a regra própria
 * `reviewed-titles-per-highlight` com `postGateOnly: true`; o `post-checks`
 * roda `check-invariants --stage 2 --phase pre-gate`, que a pula. O sentinel
 * pós-gate (`getRulesForStage(2, { phase: "pre-dispatch" })`) e o
 * `check-invariants --stage 2` sem `--phase` continuam rodando a regra.
 *
 * Os testes do runner usam o lint REAL (`countTitlesPerHighlight`) e o
 * registry REAL de regras: o handler de `check-invariants.ts` só falha se a
 * fase pedida pelo runner incluir a regra de títulos e o arquivo tiver ≠1
 * título — exatamente o que o `check-invariants` faria com esse arquivo.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStage2, readRunState, type Stage2RunDeps, type StepResult } from "../scripts/stage-2-run.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";
import { countTitlesPerHighlight } from "../scripts/lib/lint-checks/titles-per-highlight.ts";

const TITLES_RULE = "reviewed-titles-per-highlight";

function destaque(n: number, titles: string[]): string {
  return [
    `**DESTAQUE ${n} | 🚀 LANÇAMENTO**`,
    "",
    ...titles.flatMap((t) => [`**[${t}](https://openai.com/n${n})**`, ""]),
    "A OpenAI lançou um modelo novo para agentes, com preço menor e janela maior.",
    "",
    "Por que isso importa:",
    "",
    "Muda o custo de rodar agente em produção.",
    "",
    "---",
    "",
  ].join("\n");
}

const THREE_TITLES =
  destaque(1, ["OpenAI lança modelo novo para agentes", "Modelo novo da OpenAI mira agentes", "A OpenAI aposta em agentes"]) +
  destaque(2, ["Europa aprova regra de IA", "Regra europeia de IA sai do papel", "UE fecha texto sobre IA"]);
const ONE_TITLE = destaque(1, ["OpenAI lança modelo novo para agentes"]) + destaque(2, ["Europa aprova regra de IA"]);

type Handler = (args: string[]) => StepResult;
interface Call {
  script: string;
  args: string[];
}
const ok = (stdout = ""): StepResult => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stdout = "", stderr = ""): StepResult => ({ code, stdout, stderr });

let dir: string;
const E = "261127";

function argOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Lint real `--check titles-per-highlight` sobre o arquivo passado. */
const realTitlesLint: Handler = (args) => {
  if (argOf(args, "--check") !== "titles-per-highlight") return ok();
  const r = countTitlesPerHighlight(readFileSync(argOf(args, "--md")!, "utf8"));
  return r.ok ? ok(JSON.stringify(r)) : fail(1, JSON.stringify(r), r.errors.join("\n"));
};

/** `check-invariants --stage 2` com o registry real, restrito à regra de títulos. */
const realInvariantsTitlesOnly: Handler = (args) => {
  const phase = argOf(args, "--phase") as "pre-dispatch" | "pre-gate" | undefined;
  const ids = getRulesForStage(2, { phase }).map((r) => r.id);
  if (!ids.includes(TITLES_RULE)) return ok();
  const r = countTitlesPerHighlight(readFileSync(join(argOf(args, "--edition-dir")!, "02-reviewed.md"), "utf8"));
  return r.ok ? ok() : fail(1, JSON.stringify({ passed: false, violations: [{ rule: TITLES_RULE }] }));
};

function makeDeps(handlers: Record<string, Handler> = {}): { deps: Stage2RunDeps; calls: Call[] } {
  const calls: Call[] = [];
  const all: Record<string, Handler> = {
    "find-current-edition.ts": () => ok(dir + "\n"),
    "lint-social-md.ts": () => ok(JSON.stringify({ passed: true, checks: [] })),
    "lint-newsletter-md.ts": realTitlesLint,
    "check-invariants.ts": realInvariantsTitlesOnly,
    ...handlers,
  };
  return {
    calls,
    deps: {
      now: () => new Date(Date.now() - 60_000),
      exec: (script, args) => {
        calls.push({ script, args });
        const h = all[script.split("/").pop() ?? script];
        return h ? h(args) : ok();
      },
    },
  };
}

function write(rel: string, text: string): void {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text, "utf8");
}

function highlights(n: number): string {
  return JSON.stringify({
    highlights: Array.from({ length: n }, (_, i) => ({
      bucket: "radar",
      article: { url: `https://ex.com/${i + 1}`, title: `T${i + 1}`, category: "noticias" },
    })),
  });
}

async function upToPostChecks(): Promise<void> {
  const pre = makeDeps();
  assert.equal((await runStage2(["--phase", "pre-dispatch", "--edition", E], pre.deps)).code, 0);
  const st = readRunState(dir)!;
  writeFileSync(
    join(dir, "_internal", "02-stage2-run-state.json"),
    JSON.stringify({ ...st, clariceDone: { newsletter: "applied", social: "applied" } }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stage2-titles-14266-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  write("_internal/01-approved.json", highlights(2));
  write("_internal/01-approved-capped.json", highlights(2));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("fixture (#14266)", () => {
  it("o lint real conta 3 títulos por destaque no fixture pré-gate e 1 no podado", () => {
    const three = countTitlesPerHighlight(THREE_TITLES);
    assert.equal(three.ok, false);
    assert.deepEqual(three.destaques.map((d) => d.title_count), [3, 3]);
    assert.equal(countTitlesPerHighlight(ONE_TITLE).ok, true);
  });
});

describe("registry: reviewed-titles-per-highlight por fase (#14266)", () => {
  it("existe no Stage 2, marcada postGateOnly", () => {
    const rule = getRulesForStage(2).find((r) => r.id === TITLES_RULE);
    assert.ok(rule, "a regra continua registrada no Stage 2");
    assert.equal(rule!.postGateOnly, true);
  });

  it("--phase pre-gate pula a regra; sem fase e pre-dispatch (sentinel pós-gate) a mantêm", () => {
    assert.ok(!getRulesForStage(2, { phase: "pre-gate" }).some((r) => r.id === TITLES_RULE));
    assert.ok(getRulesForStage(2).some((r) => r.id === TITLES_RULE));
    assert.ok(getRulesForStage(2, { phase: "pre-dispatch" }).some((r) => r.id === TITLES_RULE), "pipeline-sentinel write --step 2 segue exigindo 1 título");
  });

  it("pre-gate só tira as regras postGateOnly (o resto do conjunto do Stage 2 fica igual)", () => {
    const full = getRulesForStage(2).map((r) => r.id);
    const pre = getRulesForStage(2, { phase: "pre-gate" }).map((r) => r.id);
    assert.deepEqual(pre, full.filter((id) => id !== TITLES_RULE));
    assert.ok(pre.includes("reviewed-passes-all-lints"));
  });

  it("a regra roda o lint real: 3 títulos → violação; 1 título → limpa", () => {
    const rule = getRulesForStage(2).find((r) => r.id === TITLES_RULE)!;
    write("02-reviewed.md", THREE_TITLES);
    const v = rule.run(dir);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, TITLES_RULE);
    assert.equal(v[0].severity, "error");
    write("02-reviewed.md", ONE_TITLE);
    assert.deepEqual(rule.run(dir), []);
  });

  it("nenhuma regra fora do Stage 2 ganhou postGateOnly (o Stage 4 segue exigindo 1 título)", () => {
    for (const s of [0, 1, 3, 4, 5, 6] as const) {
      assert.ok(!getRulesForStage(s).some((r) => r.postGateOnly), `stage ${s}`);
    }
  });
});

describe("stage-2-run com 3 títulos por destaque (#14266)", () => {
  it("post-checks NÃO sai com exit 3 por titles-per-highlight e grava postChecksDone", async () => {
    await upToPostChecks();
    write("02-reviewed.md", THREE_TITLES);
    const { deps, calls } = makeDeps();
    const r = await runStage2(["--phase", "post-checks", "--edition", E], deps);
    assert.equal(r.code, 0, JSON.stringify(r.fixes));
    assert.ok(!r.fixes.some((f) => /titles-per-highlight|check-invariants/.test(f.check)));
    const ci = calls.find((c) => c.script.endsWith("check-invariants.ts"));
    assert.equal(argOf(ci!.args, "--phase"), "pre-gate");
    assert.equal(readRunState(dir)?.postChecksDone, true);
  });

  it("post-gate sem title-picker continua recusando os 3 títulos (despacha o title-picker, sem sentinel)", async () => {
    await upToPostChecks();
    write("02-reviewed.md", THREE_TITLES);
    assert.equal((await runStage2(["--phase", "post-checks", "--edition", E], makeDeps().deps)).code, 0);
    const { deps, calls } = makeDeps();
    const r = await runStage2(["--phase", "post-gate", "--edition", E], deps);
    assert.equal(r.pendingAgentDispatch[0]?.agent, "title-picker");
    assert.ok(!calls.some((c) => c.script.includes("pipeline-sentinel")));

    // title-picker não podou: --after-title-picker com 3 títulos → code 3.
    const again = makeDeps();
    const r2 = await runStage2(["--phase", "post-gate", "--edition", E, "--after-title-picker"], again.deps);
    assert.equal(r2.code, 3);
    assert.ok(r2.fixes.some((f) => f.check === "titles-per-highlight"));
    assert.ok(!again.calls.some((c) => c.script.includes("pipeline-sentinel")));
  });

  it("post-gate com 1 título por destaque passa e grava o sentinel", async () => {
    await upToPostChecks();
    write("02-reviewed.md", THREE_TITLES);
    assert.equal((await runStage2(["--phase", "post-checks", "--edition", E], makeDeps().deps)).code, 0);
    write("02-reviewed.md", ONE_TITLE); // editor podou no gate
    const { deps, calls } = makeDeps();
    const r = await runStage2(["--phase", "post-gate", "--edition", E], deps);
    assert.equal(r.code, 0, JSON.stringify(r.fixes));
    assert.equal(r.pendingAgentDispatch.length, 0);
    assert.ok(calls.some((c) => c.script.includes("pipeline-sentinel") && c.args[0] === "write"));
  });
});
