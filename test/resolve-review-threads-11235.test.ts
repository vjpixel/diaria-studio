/**
 * test/resolve-review-threads-11235.test.ts
 *
 * Helper que substitui o `gh api graphql` à mão do merge gate (#11235, review
 * da PR #11250): só a query `reviewThreads` e a mutation `resolveReviewThread`,
 * nunca outra mutation; erro de query nunca vira "0 threads"; FORBIDDEN não
 * bloqueia; a contagem final vem de uma query FRESCA pós-loop.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_BLOCKING,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PAGINATION,
  RESOLVE_MUTATION,
  THREADS_QUERY,
  buildResolveArgs,
  buildThreadsQueryArgs,
  classifyResolveResult,
  parseThreadsResponse,
  resolveReviewThreads,
  type GhRunFn,
} from "../scripts/resolve-review-threads.ts";

const threadsJson = (nodes: Array<{ id: string; isResolved: boolean }>, hasNextPage = false) =>
  JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor: null } } } } } });
const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
const resolvedJson = (id: string) => JSON.stringify({ data: { resolveReviewThread: { thread: { id, isResolved: true } } } });
const forbiddenJson = JSON.stringify({ data: { resolveReviewThread: null }, errors: [{ type: "FORBIDDEN", message: "x" }] });

/** Fake do `gh`: devolve a 1ª/2ª resposta de query em ordem e registra cada chamada. */
function fakeGh(queries: string[], resolveFor: (id: string) => { status: number; stdout: string; stderr: string }) {
  const calls: string[][] = [];
  let q = 0;
  const run: GhRunFn = (args) => {
    calls.push(args);
    const tid = args.find((a) => a.startsWith("tid="));
    if (tid) return resolveFor(tid.slice(4));
    return ok(queries[q++] ?? "");
  };
  return { run, calls };
}

describe("resolve-review-threads (#11235)", () => {
  it("só emite a query de threads e a mutation resolveReviewThread", () => {
    assert.match(THREADS_QUERY, /^query\(/);
    assert.doesNotMatch(THREADS_QUERY, /mutation/);
    const mutations = RESOLVE_MUTATION.match(/\b(\w+)\(input:/g) ?? [];
    assert.deepEqual(mutations, ["resolveReviewThread(input:"]);
    assert.deepEqual(buildThreadsQueryArgs("vjpixel/diaria-design", 7).slice(0, 8), [
      "api", "graphql", "-f", "owner=vjpixel", "-f", "name=diaria-design", "-F", "pr=7",
    ]);
    assert.deepEqual(buildResolveArgs("PRRT_1").slice(-2), ["-f", "tid=PRRT_1"]);
  });

  it("resposta inválida é erro, nunca 0 threads", () => {
    assert.equal(parseThreadsResponse("").ok, false);
    assert.equal(parseThreadsResponse('{"errors":[{"message":"x"}]}').ok, false);
    assert.equal(parseThreadsResponse(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 1 }] } } } } })).ok, false);
  });

  it("pageInfo ausente conta como próxima página", () => {
    const p = parseThreadsResponse(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }));
    assert.ok(p.ok && p.hasNextPage);
  });

  it("FORBIDDEN vem do campo estruturado, não de texto solto", () => {
    assert.equal(classifyResolveResult({ status: 1, stdout: forbiddenJson, stderr: "" }), "forbidden");
    assert.equal(classifyResolveResult({ status: 0, stdout: resolvedJson("a"), stderr: "" }), "resolved");
    assert.equal(classifyResolveResult({ status: 1, stdout: '{"errors":[{"message":"FORBIDDEN"}]}', stderr: "" }), "error");
    assert.equal(classifyResolveResult({ status: 1, stdout: "", stderr: "boom" }), "error");
  });

  it("resolve as não-resolvidas, desconta FORBIDDEN e decide pela query fresca", () => {
    const gh = fakeGh(
      [
        threadsJson([{ id: "a", isResolved: false }, { id: "b", isResolved: false }, { id: "c", isResolved: true }]),
        threadsJson([{ id: "a", isResolved: true }, { id: "b", isResolved: false }, { id: "c", isResolved: true }]),
      ],
      (id) => (id === "b" ? { status: 1, stdout: forbiddenJson, stderr: "" } : ok(resolvedJson(id))),
    );
    const r = resolveReviewThreads("vjpixel/diaria-studio", 5, gh.run);
    assert.deepEqual([r.resolved, r.forbidden, r.failed, r.remainingBlocking, r.exitCode], [["a"], ["b"], [], 0, EXIT_OK]);
    assert.equal(gh.calls.length, 4, "query + 2 resoluções + query fresca");
  });

  it("thread que segue aberta na query fresca bloqueia (exit 1)", () => {
    const open = threadsJson([{ id: "a", isResolved: false }]);
    const gh = fakeGh([open, open], () => ({ status: 1, stdout: "", stderr: "rede" }));
    const r = resolveReviewThreads("vjpixel/diaria-studio", 5, gh.run);
    assert.deepEqual([r.failed, r.remainingBlocking, r.exitCode], [["a"], 1, EXIT_BLOCKING]);
  });

  it("--thread restringe o que é resolvido", () => {
    const gh = fakeGh(
      [threadsJson([{ id: "a", isResolved: false }, { id: "b", isResolved: false }]), threadsJson([{ id: "a", isResolved: true }, { id: "b", isResolved: false }])],
      (id) => ok(resolvedJson(id)),
    );
    const r = resolveReviewThreads("vjpixel/diaria-studio", 5, gh.run, new Set(["a"]));
    assert.deepEqual([r.resolved, r.remainingBlocking, r.exitCode], [["a"], 1, EXIT_BLOCKING]);
  });

  it(">100 threads aborta sem resolver nada; erro de query é exit 3", () => {
    const pag = fakeGh([threadsJson([{ id: "a", isResolved: false }], true)], () => ok(resolvedJson("a")));
    const r1 = resolveReviewThreads("vjpixel/diaria-studio", 5, pag.run);
    assert.equal(r1.exitCode, EXIT_PAGINATION);
    assert.equal(pag.calls.length, 1);
    const bad = fakeGh(["not json"], () => ok(""));
    assert.equal(resolveReviewThreads("vjpixel/diaria-studio", 5, bad.run).exitCode, EXIT_ERROR);
  });
});
