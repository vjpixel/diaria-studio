import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activeSessionPath, machineTag, startSession, endSession } from "../scripts/overnight-session-marker.ts";

// #3322: write/remove side do marker que .claude/hooks/pr-create-review.mjs
// (isOvernightRoundActive) consome — ver docblock de overnight-session-marker.ts
// pro racional do split write-side/read-side.

describe("machineTag (#3322)", () => {
  it("nunca lança, retorna string não-vazia", () => {
    const tag = machineTag();
    assert.equal(typeof tag, "string");
    assert.ok(tag.length > 0);
  });

  it("só contém caracteres seguros pra nome de arquivo", () => {
    assert.match(machineTag(), /^[a-zA-Z0-9_-]+$/);
  });
});

describe("activeSessionPath (#3322)", () => {
  it("monta o path esperado sob data/overnight/", () => {
    const path = activeSessionPath("/repo", "my-host");
    assert.equal(path, join("/repo", "data", "overnight", ".active-session-my-host.json"));
  });

  it("usa machineTag() como default quando tag não é passado", () => {
    const path = activeSessionPath("/repo");
    assert.match(path, /\.active-session-[a-zA-Z0-9_-]+\.json$/);
  });
});

describe("startSession / endSession (#3322)", () => {
  const roots = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(tmpdir(), `overnight-session-marker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    return root;
  }

  it("startSession cria data/overnight/ se não existir, e grava started_at", () => {
    const root = freshRoot();
    assert.equal(existsSync(join(root, "data", "overnight")), false);

    startSession(root, "2026-07-11T02:00:00.000Z");

    const path = activeSessionPath(root);
    assert.ok(existsSync(path));
    const content = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(content.started_at, "2026-07-11T02:00:00.000Z");
  });

  it("startSession é idempotente — segunda chamada sobrescreve started_at", () => {
    const root = freshRoot();
    startSession(root, "2026-07-11T02:00:00.000Z");
    startSession(root, "2026-07-11T05:00:00.000Z");

    const content = JSON.parse(readFileSync(activeSessionPath(root), "utf8"));
    assert.equal(content.started_at, "2026-07-11T05:00:00.000Z");
  });

  it("endSession remove o marker", () => {
    const root = freshRoot();
    startSession(root, "2026-07-11T02:00:00.000Z");
    assert.ok(existsSync(activeSessionPath(root)));

    endSession(root);

    assert.equal(existsSync(activeSessionPath(root)), false);
  });

  it("endSession é idempotente — no-op se o marker já não existe", () => {
    const root = freshRoot();
    assert.doesNotThrow(() => endSession(root));
    assert.equal(existsSync(activeSessionPath(root)), false);
  });

  it("startSession não mexe em outros arquivos já presentes em data/overnight/", () => {
    const root = freshRoot();
    mkdirSync(join(root, "data", "overnight", "260710"), { recursive: true });
    const otherFile = join(root, "data", "overnight", "260710", "plan.json");
    writeFileSync(otherFile, "{}", "utf8");

    startSession(root, "2026-07-11T02:00:00.000Z");

    assert.ok(existsSync(otherFile));
    assert.ok(existsSync(activeSessionPath(root)));
  });
});
