/**
 * test/register-pending-data-writes-12034.test.ts (#12034)
 *
 * PR do contínuo mergeada pelo `continuo-pr-review.sh` com a seção
 * `Escrita pendente em data/` (item 35, #11780) ficava sem ninguém aplicar a
 * escrita. `register-pending-data-writes.ts` abre uma issue de alarme com as
 * linhas. `gh` sempre fake: nenhuma issue real, nada em `data/`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  registerPendingDataWrites,
  buildPendingDataWritesFinding,
  exitCodeFor,
  PENDING_DATA_WRITES_CHECK,
} from "../scripts/register-pending-data-writes.ts";
import { alarmFindingMarker, type GhRunFn } from "../scripts/lib/alarm-issues.ts";

const BODY = [
  "Closes #9",
  "",
  "## Escrita pendente em `data/` (#11780)",
  "",
  "- `data/hubs/prose-review-state.json`: `x.proseReviewedDate` de `2026-09-17` para `2026-11-01`",
].join("\n");

function fakeGh(prView: { status: number; stdout: string; stderr?: string }, opts: { existing?: unknown[]; createFails?: boolean } = {}) {
  const calls: string[][] = [];
  const run: GhRunFn = (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") return { status: prView.status, stdout: prView.stdout, stderr: prView.stderr ?? "" };
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: JSON.stringify(opts.existing ?? []), stderr: "" };
    if (args[0] === "issue" && args[1] === "create") {
      return opts.createFails
        ? { status: 1, stdout: "", stderr: "HTTP 502" }
        : { status: 0, stdout: "https://github.com/vjpixel/diaria-studio/issues/777\n", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `chamada inesperada: ${args.join(" ")}` };
  };
  return { run, calls };
}

const merged = (body = BODY) =>
  ({ status: 0, stdout: JSON.stringify({ number: 42, title: "fix: hub", url: "https://github.com/vjpixel/diaria-studio/pull/42", state: "MERGED", body }) });

describe("registerPendingDataWrites (#12034)", () => {
  it("PR mergeada com a seção: cria a issue de alarme com as linhas e sai 0", () => {
    const { run, calls } = fakeGh(merged());
    const r = registerPendingDataWrites({ pr: 42, cwd: "/tmp", run });
    assert.equal(r.outcome, "registered");
    assert.equal(exitCodeFor(r), 0);
    if (r.outcome !== "registered") return;
    assert.equal(r.issue, 777);
    assert.equal(r.action, "created");
    const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
    assert.ok(create);
    const body = create[create.indexOf("--body") + 1];
    assert.ok(body.includes("`data/hubs/prose-review-state.json`: `x.proseReviewedDate`"), "a linha vai inteira pra issue");
    assert.ok(body.includes(alarmFindingMarker(PENDING_DATA_WRITES_CHECK, "pr-42")), "marcador de dedup por PR");
    const labels = create[create.indexOf("--label") + 1];
    assert.match(labels, /P2/);
    assert.match(labels, /alarm-evento/);
  });

  it("issue já existente com o marcador da PR: reusa, nunca duplica", () => {
    const marker = alarmFindingMarker(PENDING_DATA_WRITES_CHECK, "pr-42");
    const { run, calls } = fakeGh(merged(), { existing: [{ number: 555, url: "u/555", body: `x\n${marker}`, state: "OPEN" }] });
    const r = registerPendingDataWrites({ pr: 42, cwd: "/tmp", run });
    assert.equal(r.outcome, "registered");
    if (r.outcome === "registered") assert.equal(r.issue, 555);
    assert.ok(!calls.some((c) => c[1] === "create"));
  });

  it("corpo sem a seção: outcome none, nenhuma issue", () => {
    const { run, calls } = fakeGh(merged("Closes #9"));
    const r = registerPendingDataWrites({ pr: 42, cwd: "/tmp", run });
    assert.equal(r.outcome, "none");
    assert.ok(!calls.some((c) => c[0] === "issue"));
  });

  it("PR ainda não mergeada: não registra (a escrita é do estado pós-merge)", () => {
    const { run, calls } = fakeGh({ status: 0, stdout: JSON.stringify({ number: 42, title: "t", url: "u", state: "OPEN", body: BODY }) });
    const r = registerPendingDataWrites({ pr: 42, cwd: "/tmp", run });
    assert.equal(r.outcome, "not-merged");
    assert.ok(!calls.some((c) => c[0] === "issue"));
  });

  it("dry-run: não chama gh issue", () => {
    const { run, calls } = fakeGh(merged());
    const r = registerPendingDataWrites({ pr: 42, cwd: "/tmp", run, dryRun: true });
    assert.equal(r.outcome, "dry-run");
    assert.ok(!calls.some((c) => c[0] === "issue"));
  });

  it("criação da issue falhou: outcome failed, exit 1 (o chamador registra como erro de infra)", () => {
    const { run } = fakeGh(merged(), { createFails: true });
    const r = registerPendingDataWrites({ pr: 42, cwd: "/tmp", run });
    assert.equal(r.outcome, "failed");
    assert.equal(exitCodeFor(r), 1);
  });

  it("gh pr view falhou ou JSON ruim: unreadable, exit 3", () => {
    assert.equal(exitCodeFor(registerPendingDataWrites({ pr: 42, cwd: "/tmp", run: fakeGh({ status: 1, stdout: "", stderr: "rede" }).run })), 3);
    assert.equal(exitCodeFor(registerPendingDataWrites({ pr: 42, cwd: "/tmp", run: fakeGh({ status: 0, stdout: "{" }).run })), 3);
  });
});

describe("buildPendingDataWritesFinding (#12034)", () => {
  it("família evento (nunca auto-fecha), fingerprint por PR, prioridade P2", () => {
    const f = buildPendingDataWritesFinding({ number: 7, title: "t", url: "u" }, [{ line: "`data/a.json`: k de 1 para 2", path: "data/a.json" }]);
    assert.equal(f.family, "evento");
    assert.equal(f.fingerprint, "pr-7");
    assert.equal(f.priority, "P2");
    assert.match(f.title, /PR #7/);
  });
});
