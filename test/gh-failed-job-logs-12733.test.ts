import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  jobHeader,
  jobLogApiPath,
  jobsApiPath,
  selectFailedJobs,
  stripPostJobCleanup,
  tailLines,
} from "../scripts/gh-failed-job-logs.ts";

// #12733: o gh 2.46 do 300 devolve 0 linhas em `gh run view --log-failed`;
// o log do job que falhou vem pelo REST via este wrapper.

describe("jobsApiPath / jobLogApiPath (#12733)", () => {
  it("sem --attempt usa a lista de jobs da última tentativa", () => {
    assert.equal(jobsApiPath(42, undefined), "repos/{owner}/{repo}/actions/runs/42/jobs?per_page=100");
  });
  it("com --attempt usa a lista daquela tentativa (o vermelho que o rerun apagou)", () => {
    assert.equal(
      jobsApiPath(42, "vjpixel/diaria-design", 1),
      "repos/vjpixel/diaria-design/actions/runs/42/attempts/1/jobs?per_page=100",
    );
  });
  it("log do job pelo id", () => {
    assert.equal(jobLogApiPath(130034489377, undefined), "repos/{owner}/{repo}/actions/jobs/130034489377/logs");
  });
});

describe("selectFailedJobs (#12733)", () => {
  const json = JSON.stringify({
    total_count: 4,
    jobs: [
      { id: 1, name: "Shell tests (*.test.sh,", conclusion: "failure" },
      { id: 2, name: "Typecheck", conclusion: "success" },
      { id: 3, name: "Lento", conclusion: "timed_out" },
      { id: 4, name: "Rodando", conclusion: null },
      { id: 5, name: "Pulado", conclusion: "skipped" },
    ],
  });
  it("devolve só failure e timed_out, na ordem da API", () => {
    assert.deepEqual(
      selectFailedJobs(json).map((j) => j.id),
      [1, 3],
    );
  });
  it("resposta sem `jobs` é erro, nunca 'nenhuma falha'", () => {
    assert.throws(() => selectFailedJobs('{"message":"Not Found"}'), /jobs/);
  });
});

describe("stripPostJobCleanup + tailLines (#12733)", () => {
  const log = [
    "2026-11-10T18:23:31.0333598Z FAIL: fila eterna estoura o teto absoluto",
    "2026-11-10T18:23:34.3401745Z [run-shell-tests] fim: 19 ok, 1 falha(s).",
    "2026-11-10T18:23:34.3639509Z ##[error]Process completed with exit code 1.",
    "2026-11-10T18:23:34.3762793Z Post job cleanup.",
    "2026-11-10T18:23:34.4516287Z [command]/usr/bin/git version",
    "",
  ].join("\n");

  it("corta a limpeza pós-job, que empurraria a falha para fora do tail", () => {
    const out = tailLines(stripPostJobCleanup(log), 2);
    assert.match(out, /fim: 19 ok, 1 falha/);
    assert.match(out, /exit code 1/);
    assert.doesNotMatch(out, /git version/);
  });

  it("log sem a linha de limpeza volta inteiro", () => {
    assert.equal(stripPostJobCleanup("a\nb\n"), "a\nb\n");
  });

  it("tail 0 devolve tudo; tail maior que o log não corta", () => {
    assert.equal(tailLines("a\nb\nc\n", 0), "a\nb\nc");
    assert.equal(tailLines("a\nb\nc", 10), "a\nb\nc");
    assert.equal(tailLines("a\r\nb\r\nc\r\n", 2), "b\nc");
  });

  it("cabeçalho nomeia id, nome e conclusão", () => {
    assert.equal(
      jobHeader({ id: 7, name: "Shell tests", conclusion: "failure" }),
      "===== job 7 — Shell tests (failure) =====",
    );
  });
});
