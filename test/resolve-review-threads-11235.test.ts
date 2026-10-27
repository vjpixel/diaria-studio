/**
 * test/resolve-review-threads-11235.test.ts
 *
 * Helper que substitui o `gh api graphql` à mão do merge gate (#11235, review
 * da PR #11250): só a query `reviewThreads` e a mutation `resolveReviewThread`;
 * erro de query nunca vira "0 threads"; FORBIDDEN só não bloqueia quando a
 * thread diz `viewerCanResolve: false`; falha de infra sai exit 3; a decisão
 * vem da query FRESCA pós-loop; o CLI nunca muda de modo em silêncio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_BLOCKING,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PAGINATION,
  EXIT_USAGE,
  RESOLVE_MUTATION,
  THREADS_QUERY,
  buildResolveArgs,
  buildThreadsQueryArgs,
  classifyResolveResult,
  parseThreadsResponse,
  resolveReviewThreads,
  runCli,
  type GhRunFn,
} from "../scripts/resolve-review-threads.ts";

type T = { id: string; isResolved: boolean; viewerCanResolve?: boolean };
const threadsJson = (nodes: T[], hasNextPage: unknown = false) =>
  JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor: null } } } } } });
const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
const resolvedJson = (id: string) => JSON.stringify({ data: { resolveReviewThread: { thread: { id, isResolved: true } } } });
const forbidden = { status: 1, stdout: JSON.stringify({ data: { resolveReviewThread: null }, errors: [{ type: "FORBIDDEN", message: "x" }] }), stderr: "" };
const net = { status: 1, stdout: "", stderr: "HTTP 502" };
const open = (id: string, viewerCanResolve: boolean | undefined = true): T => ({ id, isResolved: false, viewerCanResolve });
const done = (id: string): T => ({ id, isResolved: true, viewerCanResolve: true });

/** Fake do `gh`: devolve as respostas de query em ordem e registra cada chamada. */
function fakeGh(queries: string[], resolveFor: (id: string) => { status: number; stdout: string; stderr: string } = (id) => ok(resolvedJson(id))) {
  const calls: string[][] = [];
  let q = 0;
  const run: GhRunFn = (args) => {
    calls.push(args);
    const tid = args.find((a) => a.startsWith("tid="));
    if (tid) return resolveFor(tid.slice(4));
    return ok(queries[q++] ?? "");
  };
  return { run, calls, mutations: () => calls.filter((c) => c.some((a) => a.startsWith("tid="))).length };
}

describe("resolve-review-threads: operações GraphQL", () => {
  it("só emite a query de threads (com viewerCanResolve) e a mutation resolveReviewThread", () => {
    assert.match(THREADS_QUERY, /^query\(/);
    assert.doesNotMatch(THREADS_QUERY, /mutation/);
    assert.match(THREADS_QUERY, /viewerCanResolve/);
    assert.deepEqual(RESOLVE_MUTATION.match(/\b(\w+)\(input:/g), ["resolveReviewThread(input:"]);
    assert.deepEqual(buildThreadsQueryArgs("vjpixel/diaria-design", 7), [
      "api", "graphql", "-f", "owner=vjpixel", "-f", "name=diaria-design", "-F", "pr=7", "-f", `query=${THREADS_QUERY}`,
    ]);
    assert.deepEqual(buildResolveArgs("PRRT_1"), ["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-f", "tid=PRRT_1"]);
  });
});

describe("resolve-review-threads: parse e classificação", () => {
  it("payload inválido é erro, nunca 0 threads", () => {
    assert.equal(parseThreadsResponse("").ok, false);
    assert.equal(parseThreadsResponse('{"errors":[{"message":"x"}]}').ok, false);
    assert.equal(parseThreadsResponse(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 1 }] } } } } })).ok, false);
  });

  it("errors[] não vazio com data presente também é erro", () => {
    const withErrors = JSON.parse(threadsJson([done("a")]));
    withErrors.errors = [{ message: "partial" }];
    assert.equal(parseThreadsResponse(JSON.stringify(withErrors)).ok, false);
  });

  it("hasNextPage não booleano (ou ausente) é payload malformado, não paginação", () => {
    assert.equal(parseThreadsResponse(threadsJson([], "true")).ok, false);
    assert.equal(parseThreadsResponse(threadsJson([], null)).ok, false);
    assert.equal(parseThreadsResponse(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } })).ok, false);
    const p = parseThreadsResponse(threadsJson([open("a", false)], true));
    assert.ok(p.ok && p.hasNextPage && p.threads[0].viewerCanResolve === false);
  });

  it("FORBIDDEN só pelo campo estruturado; outro errors[] com data é erro", () => {
    assert.equal(classifyResolveResult(forbidden).outcome, "forbidden");
    assert.equal(classifyResolveResult(ok(resolvedJson("a"))).outcome, "resolved");
    assert.equal(classifyResolveResult({ status: 1, stdout: '{"errors":[{"message":"FORBIDDEN"}]}', stderr: "" }).outcome, "error");
    const partial = JSON.parse(resolvedJson("a"));
    partial.errors = [{ message: "rate limited" }];
    assert.equal(classifyResolveResult(ok(JSON.stringify(partial))).outcome, "error");
    assert.equal(classifyResolveResult(net).outcome, "error");
  });
});

describe("resolve-review-threads: decisão", () => {
  it("resolve as abertas e desconta FORBIDDEN de revisor externo (viewerCanResolve=false)", () => {
    const gh = fakeGh(
      [threadsJson([open("a"), open("b", false), done("c")]), threadsJson([done("a"), open("b", false), done("c")])],
      (id) => (id === "b" ? forbidden : ok(resolvedJson(id))),
    );
    const r = resolveReviewThreads("vjpixel/diaria-studio", 5, gh.run);
    assert.deepEqual([r.resolved, r.forbidden, r.failed, r.remainingBlocking, r.exitCode], [["a"], ["b"], [], 0, EXIT_OK]);
    assert.equal(gh.calls.length, 4, "query + 2 resoluções + query fresca");
  });

  it("FORBIDDEN com viewerCanResolve true ou ausente é permissão do token: exit 3", () => {
    for (const vcr of [true, undefined]) {
      const gh = fakeGh([threadsJson([open("a", vcr)]), threadsJson([open("a", vcr)])], () => forbidden);
      const r = resolveReviewThreads("vjpixel/diaria-studio", 5, gh.run);
      assert.equal(r.exitCode, EXIT_ERROR, `viewerCanResolve=${vcr}`);
      assert.deepEqual(r.forbidden, []);
      assert.equal(r.failed[0].id, "a");
      assert.match(r.failed[0].reason, /FORBIDDEN/);
    }
  });

  it("falha de rede com a thread ainda aberta é infra (exit 3), com {id, status, reason}", () => {
    const gh = fakeGh([threadsJson([open("a")]), threadsJson([open("a")])], () => net);
    const r = resolveReviewThreads("vjpixel/diaria-studio", 5, gh.run);
    assert.equal(r.exitCode, EXIT_ERROR);
    assert.deepEqual(r.failed, [{ id: "a", status: 1, reason: "gh exit 1: HTTP 502" }]);
  });

  it("decide pela query fresca: mutation ok mas thread segue aberta = exit 1", () => {
    const gh = fakeGh([threadsJson([open("a")]), threadsJson([open("a")])]);
    const r = resolveReviewThreads("vjpixel/diaria-studio", 5, gh.run);
    assert.deepEqual([r.resolved, r.remainingBlocking, r.exitCode], [["a"], 1, EXIT_BLOCKING]);
  });

  it("decide pela query fresca: mutation falha mas thread aparece resolvida = exit 0", () => {
    const gh = fakeGh([threadsJson([open("a")]), threadsJson([done("a")])], () => net);
    const r = resolveReviewThreads("vjpixel/diaria-studio", 5, gh.run);
    assert.equal(r.failed.length, 1);
    assert.equal(r.exitCode, EXIT_OK);
  });

  it("thread fora de --thread segue aberta: exit 1", () => {
    const gh = fakeGh([threadsJson([open("a"), open("b")]), threadsJson([done("a"), open("b")])]);
    const r = resolveReviewThreads("vjpixel/diaria-studio", 5, gh.run, new Set(["a"]));
    assert.deepEqual([r.resolved, r.remainingBlocking, r.exitCode], [["a"], 1, EXIT_BLOCKING]);
    assert.equal(gh.mutations(), 1);
  });

  it(">100 threads no pré-loop aborta sem resolver; erro no pré-loop é exit 3", () => {
    const pag = fakeGh([threadsJson([open("a")], true)]);
    assert.equal(resolveReviewThreads("vjpixel/diaria-studio", 5, pag.run).exitCode, EXIT_PAGINATION);
    assert.equal(pag.mutations(), 0);
    assert.equal(resolveReviewThreads("vjpixel/diaria-studio", 5, fakeGh(["not json"]).run).exitCode, EXIT_ERROR);
  });

  it("query pós-loop com erro é exit 3; com hasNextPage é exit 4", () => {
    const err = fakeGh([threadsJson([open("a")]), "not json"]);
    assert.equal(resolveReviewThreads("vjpixel/diaria-studio", 5, err.run).exitCode, EXIT_ERROR);
    const pag = fakeGh([threadsJson([open("a")]), threadsJson([done("a")], true)]);
    assert.equal(resolveReviewThreads("vjpixel/diaria-studio", 5, pag.run).exitCode, EXIT_PAGINATION);
  });

  it("gh com exit != 0 na query é erro mesmo com JSON válido no stdout", () => {
    const run: GhRunFn = () => ({ status: 1, stdout: threadsJson([]), stderr: "boom" });
    assert.equal(resolveReviewThreads("vjpixel/diaria-studio", 5, run).exitCode, EXIT_ERROR);
  });
});

describe("resolve-review-threads: runCli", () => {
  const ROOT = process.cwd();
  const cli = (argv: string[], gh = fakeGh([threadsJson([open("a"), done("b")])])) => ({ r: runCli(argv, gh.run, ROOT), gh });

  it("--list imprime o JSON e não chama mutation", () => {
    const { r, gh } = cli(["--pr", "5", "--list"]);
    assert.equal(r.exitCode, EXIT_OK);
    assert.deepEqual(JSON.parse(r.stdout), { repo: "vjpixel/diaria-studio", pr: 5, total: 2, unresolved: ["a"], hasNextPage: false });
    assert.equal(gh.mutations(), 0);
  });

  it("--list com >100 threads sai 4; com erro sai 3", () => {
    assert.equal(cli(["--pr", "5", "--list"], fakeGh([threadsJson([], true)])).r.exitCode, EXIT_PAGINATION);
    assert.equal(cli(["--pr", "5", "--list"], fakeGh(["x"])).r.exitCode, EXIT_ERROR);
  });

  it("--thread ID,ID restringe a resolução", () => {
    const gh = fakeGh([threadsJson([open("a"), open("b"), open("c")]), threadsJson([done("a"), open("b"), done("c")])]);
    const r = runCli(["--pr", "5", "--thread", "a, c"], gh.run, ROOT);
    assert.deepEqual(JSON.parse(r.stdout).resolved, ["a", "c"]);
    assert.equal(r.exitCode, EXIT_BLOCKING);
  });

  it("erros de uso nunca mudam de modo em silêncio (exit 5, sem chamar o gh)", () => {
    for (const argv of [
      ["--pr", "5", "--thread"],
      ["--pr", "5", "--thread="],
      ["--pr", "5", "--thread", ","],
      ["--pr", "5", "--list", "x"],
      ["--pr", "5", "--list", "--thread", "a"],
      ["--pr", "5", "--threads", "a"],
      ["--pr", "5", "--dry-run"],
      ["--pr", "5", "solto"],
      ["--pr"],
      ["--pr", "0"],
      ["--pr", "5x"],
      [],
    ]) {
      const { r, gh } = cli(argv);
      assert.equal(r.exitCode, EXIT_USAGE, JSON.stringify(argv));
      assert.equal(gh.calls.length, 0, JSON.stringify(argv));
    }
  });

  it("FORBIDDEN de token (viewerCanResolve true) e falha de rede chegam ao exit do CLI", () => {
    const f = fakeGh([threadsJson([open("a")]), threadsJson([open("a")])], () => forbidden);
    assert.equal(runCli(["--pr", "5"], f.run, ROOT).exitCode, EXIT_ERROR);
    const n = fakeGh([threadsJson([open("a")]), threadsJson([open("a")])], () => net);
    const r = runCli(["--pr", "5"], n.run, ROOT);
    assert.equal(r.exitCode, EXIT_ERROR);
    assert.equal(JSON.parse(r.stdout).failed[0].status, 1);
  });
});
