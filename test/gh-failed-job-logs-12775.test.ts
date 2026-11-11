import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { intFlag, jobsApiPath, parseCliNumbers } from "../scripts/gh-failed-job-logs.ts";

// #12775: `--attempt 0` era aceito e tratado como flag ausente (consultava a
// tentativa mais recente, a que o rerun deixou verde); `--run 0`/`--job 0`
// viravam consulta inválida em vez de erro de uso.

describe("intFlag / parseCliNumbers (#12775)", () => {
  it("--run, --attempt e --job 0 são erro de uso", () => {
    for (const flag of ["run", "attempt", "job"]) {
      assert.throws(() => parseCliNumbers({ run: "42", [flag]: "0" }), new RegExp(`--${flag} inválido: 0`));
    }
  });
  it("--tail 0 continua valendo (log inteiro); padrão 100", () => {
    assert.equal(parseCliNumbers({ run: "42", tail: "0" }).tail, 0);
    assert.equal(parseCliNumbers({ run: "42" }).tail, 100);
  });
  it("negativo, fracionário e vazio são recusados", () => {
    assert.throws(() => intFlag("-1", "tail", 0), /inválido/);
    assert.throws(() => intFlag("1.5", "run", 1), /inválido/);
    assert.throws(() => intFlag("", "attempt", 1), /inválido/);
    assert.throws(() => intFlag(" ", "attempt", 1), /inválido/);
  });
  it("valores válidos passam; ausente fica undefined", () => {
    assert.deepEqual(parseCliNumbers({ run: "42", attempt: "1", job: "7", tail: "5" }), {
      run: 42,
      attempt: 1,
      job: 7,
      tail: 5,
    });
    assert.equal(parseCliNumbers({ run: "42" }).attempt, undefined);
  });
  it("jobsApiPath só ignora a tentativa quando ela é ausente", () => {
    assert.match(jobsApiPath(42, undefined, 1), /\/attempts\/1\/jobs/);
    assert.doesNotMatch(jobsApiPath(42, undefined), /attempts/);
  });
});

describe("CLI (#12775)", () => {
  const script = fileURLToPath(new URL("../scripts/gh-failed-job-logs.ts", import.meta.url));
  for (const args of [["--run", "42", "--attempt", "0"], ["--run", "0"], ["--job", "0"]]) {
    it(`${args.join(" ")} sai 3 sem consultar o GitHub`, () => {
      const r = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
        encoding: "utf8",
        timeout: 60_000,
        // `gh` fora do PATH: se o script chegasse a consultar, o erro seria outro.
        env: { ...process.env, PATH: "/nonexistent" },
      });
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stderr, /inválido: 0/);
    });
  }
});
