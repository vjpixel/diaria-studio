// Regressão #7763: symlink node_modules → fora do worktree + npm ci = principal vazio
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkNodeModulesSymlink, guardBeforeNpmInstall } from "../scripts/lib/worktree-node-modules-guard";

describe("worktree-node-modules-guard #7763", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "wt-7763-")); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it("bloqueia symlink apontando para checkout principal", () => {
    mkdirSync(join(tmp, "node_modules"), { recursive: true }); // placeholder
    rmSync(join(tmp, "node_modules"), { recursive: true, force: true });
    // Simula symlink pro principal (fora do tmp)
    symlinkSync("/home/vjpixel/diaria-studio/node_modules", join(tmp, "node_modules"));
    const r = checkNodeModulesSymlink(tmp);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("fora do worktree");
  });

  it("aceita diretório real", () => {
    mkdirSync(join(tmp, "node_modules"), { recursive: true });
    const r = checkNodeModulesSymlink(tmp);
    expect(r.blocked).toBe(false);
  });

  it("lança no guardBeforeNpmInstall quando bloqueado", () => {
    symlinkSync("/tmp/fake-principal", join(tmp, "node_modules"));
    expect(() => guardBeforeNpmInstall(tmp)).toThrow("[GUARD #7763]");
  });
});
