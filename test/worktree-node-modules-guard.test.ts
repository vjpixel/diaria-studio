// Regressão #7763: symlink node_modules → fora do worktree + npm ci = principal vazio
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNodeModulesSymlink, guardBeforeNpmInstall } from "../scripts/lib/worktree-node-modules-guard.ts";

function withTmp(fn: (dir: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "wt-7763-"));
  try {
    fn(tmp);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

test("bloqueia symlink apontando para fora do worktree", () => {
  withTmp((tmp) => {
    const outside = mkdtempSync(join(tmpdir(), "wt-7763-principal-"));
    try {
      mkdirSync(join(outside, "node_modules"), { recursive: true });
      symlinkSync(join(outside, "node_modules"), join(tmp, "node_modules"), "junction");
      const r = checkNodeModulesSymlink(tmp);
      assert.equal(r.blocked, true);
      assert.match(r.reason, /fora do worktree/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("aceita diretório real", () => {
  withTmp((tmp) => {
    mkdirSync(join(tmp, "node_modules"), { recursive: true });
    const r = checkNodeModulesSymlink(tmp);
    assert.equal(r.blocked, false);
  });
});

test("aceita node_modules ausente (instalação necessária)", () => {
  withTmp((tmp) => {
    const r = checkNodeModulesSymlink(tmp);
    assert.equal(r.blocked, false);
    assert.match(r.reason, /ausente/);
  });
});

test("aceita symlink intra-worktree (self-referente)", () => {
  withTmp((tmp) => {
    const inner = join(tmp, "vendor-node-modules");
    mkdirSync(inner, { recursive: true });
    symlinkSync(inner, join(tmp, "node_modules"), "junction");
    const r = checkNodeModulesSymlink(tmp);
    assert.equal(r.blocked, false);
    assert.match(r.reason, /intra-worktree/);
  });
});

test("lança no guardBeforeNpmInstall quando bloqueado", () => {
  withTmp((tmp) => {
    const outside = mkdtempSync(join(tmpdir(), "wt-7763-principal-"));
    try {
      mkdirSync(join(outside, "node_modules"), { recursive: true });
      symlinkSync(join(outside, "node_modules"), join(tmp, "node_modules"), "junction");
      assert.throws(() => guardBeforeNpmInstall(tmp), /\[GUARD #7763\]/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// Achado do review da PR #7774: erro de inspeção que NÃO seja ENOENT (EACCES,
// EPERM) não pode virar "não bloqueado" — mascarar falha de inspeção é
// exatamente o caminho que o guard existe para fechar.
test("erro de inspeção não-ENOENT bloqueia em vez de mascarar", { skip: process.platform === "win32" ? "chmod não restringe leitura no Windows" : process.getuid?.() === 0 ? "root ignora permissão de diretório" : false }, () => {
  withTmp((tmp) => {
    const locked = join(tmp, "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const r = checkNodeModulesSymlink(locked);
      assert.equal(r.blocked, true);
      assert.match(r.reason, /não foi possível inspecionar/);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
