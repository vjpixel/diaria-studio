/**
 * Regressão do #9962: subagente (writer-destaque) reportou Write com sucesso
 * mas o arquivo não existia — ou existia só a versão ANTIGA (troca de destaque
 * no Stage 4). O check precisa falhar alto nos dois casos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  checkAgentOutputs,
  parseSince,
  MTIME_SLACK_MS,
  type StatFn,
} from "../scripts/verify-agent-outputs.ts";

const DISPATCH = Date.parse("2026-10-09T03:00:00.000Z");

function fakeStat(files: Record<string, { size: number; mtimeMs: number }>): StatFn {
  return (p) => files[p] ?? null;
}

test("arquivo ausente apesar do 'gravei' do agente → missing (cenário 261009)", () => {
  const r = checkAgentOutputs(["/e/_internal/02-d3-prompt.md"], DISPATCH, fakeStat({}));
  assert.equal(r[0].status, "missing");
  assert.equal(r[0].mtime, null);
});

test("arquivo antigo do destaque que saiu (mtime antes do dispatch) → stale", () => {
  const r = checkAgentOutputs(
    ["/e/_internal/02-d1-draft.md"],
    DISPATCH,
    fakeStat({ "/e/_internal/02-d1-draft.md": { size: 900, mtimeMs: DISPATCH - 60 * 60 * 1000 } }),
  );
  assert.equal(r[0].status, "stale");
});

test("arquivo gravado depois do dispatch → ok", () => {
  const r = checkAgentOutputs(
    ["/e/a.md"],
    DISPATCH,
    fakeStat({ "/e/a.md": { size: 10, mtimeMs: DISPATCH + 30_000 } }),
  );
  assert.equal(r[0].status, "ok");
});

test("folga de mtime: gravado dentro da folga antes do --since ainda é ok", () => {
  const r = checkAgentOutputs(
    ["/e/a.md"],
    DISPATCH,
    fakeStat({ "/e/a.md": { size: 10, mtimeMs: DISPATCH - MTIME_SLACK_MS + 1 } }),
  );
  assert.equal(r[0].status, "ok");
});

test("arquivo vazio → empty, mesmo fresco", () => {
  const r = checkAgentOutputs(["/e/a.md"], DISPATCH, fakeStat({ "/e/a.md": { size: 0, mtimeMs: DISPATCH + 1 } }));
  assert.equal(r[0].status, "empty");
});

test("sem --since: só existência + não-vazio, arquivo antigo passa", () => {
  const r = checkAgentOutputs(["/e/a.md"], null, fakeStat({ "/e/a.md": { size: 10, mtimeMs: 0 } }));
  assert.equal(r[0].status, "ok");
});

test("checa cada path independentemente (draft ok, prompt ausente)", () => {
  const r = checkAgentOutputs(
    ["/e/d.md", "/e/p.md"],
    DISPATCH,
    fakeStat({ "/e/d.md": { size: 10, mtimeMs: DISPATCH + 5 } }),
  );
  assert.deepEqual(r.map((x) => x.status), ["ok", "missing"]);
});

test("parseSince aceita ISO e epoch ms, rejeita lixo", () => {
  assert.equal(parseSince("2026-10-09T03:00:00.000Z"), DISPATCH);
  assert.equal(parseSince(String(DISPATCH)), DISPATCH);
  assert.equal(parseSince("ontem"), null);
  assert.equal(parseSince("true"), null);
  assert.equal(parseSince(""), null);
});

const SCRIPT = resolve(import.meta.dirname, "../scripts/verify-agent-outputs.ts");

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { encoding: "utf8" });
}

test("CLI: exit 1 + stderr nomeando o arquivo quando ausente/defasado; exit 0 quando fresco", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-agent-outputs-"));
  try {
    const fresh = join(dir, "02-d1-draft.md");
    const old = join(dir, "02-d1-prompt.md");
    const missing = join(dir, "02-d3-prompt.md");
    writeFileSync(fresh, "texto");
    writeFileSync(old, "prompt antigo");
    const past = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(old, past, past);
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const bad = run(["--agent", "writer-destaque", "--since", since, "--paths", `${fresh},${old},${missing}`]);
    assert.equal(bad.status, 1, bad.stderr);
    const out = JSON.parse(bad.stdout);
    assert.equal(out.ok, false);
    assert.deepEqual(
      out.results.map((r: { status: string }) => r.status),
      ["ok", "stale", "missing"],
    );
    assert.match(bad.stderr, /02-d3-prompt\.md: AUSENTE/);
    assert.match(bad.stderr, /02-d1-prompt\.md: DEFASADO/);

    const good = run(["--agent", "writer-destaque", "--since", since, "--paths", fresh]);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).ok, true);

    const usage = run(["--since", since]);
    assert.equal(usage.status, 2);

    const now = run(["--now"]);
    assert.equal(now.status, 0);
    assert.ok(!Number.isNaN(Date.parse(now.stdout.trim())));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
