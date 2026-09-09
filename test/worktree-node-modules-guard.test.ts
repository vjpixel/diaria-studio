// Regressão #7763: symlink node_modules → fora do worktree + npm ci = principal vazio
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, rmSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNodeModulesSymlink, guardBeforeNpmInstall } from "../scripts/lib/worktree-node-modules-guard.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

// #7774: o guard só fecha o #7763 se ALGUMA COISA o invocar antes do `npm ci`
// real. O enforcement é o `preinstall` do package.json — sem ele a função é
// biblioteca testável, não recusa mecânica (achado P1 do review da PR).
test("package.json declara o preinstall que invoca o guard", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const preinstall = pkg.scripts?.preinstall;
  assert.ok(preinstall, "package.json precisa de um script 'preinstall' — é o que faz o guard rodar antes do npm ci");
  assert.match(preinstall, /guard-node-modules-symlink\.ts/);
  // `node` puro, não `tsx`: no preinstall as dependências ainda não existem.
  assert.match(preinstall, /^node\s/);
  assert.ok(existsSync(join(repoRoot, "scripts/guard-node-modules-symlink.ts")), "CLI do preinstall precisa existir");
});

test("CLI do preinstall sai 1 quando node_modules é symlink externo", () => {
  withTmp((tmp) => {
    const outside = mkdtempSync(join(tmpdir(), "wt-7763-principal-"));
    try {
      mkdirSync(join(outside, "node_modules"), { recursive: true });
      symlinkSync(join(outside, "node_modules"), join(tmp, "node_modules"), "junction");
      const r = spawnSync(process.execPath, [join(repoRoot, "scripts/guard-node-modules-symlink.ts")], {
        cwd: tmp,
        encoding: "utf8",
      });
      assert.equal(r.status, 1, `esperado exit 1; stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stderr, /\[GUARD #7763\]/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("CLI do preinstall sai 0 quando node_modules é diretório real", () => {
  withTmp((tmp) => {
    mkdirSync(join(tmp, "node_modules"), { recursive: true });
    const r = spawnSync(process.execPath, [join(repoRoot, "scripts/guard-node-modules-symlink.ts")], {
      cwd: tmp,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `esperado exit 0; stderr=${r.stderr}`);
  });
});
