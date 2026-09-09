// Regressão #7763: symlink node_modules → fora do worktree + npm ci = principal vazio
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, rmSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNodeModulesSymlink, guardBeforeNpmInstall } from "../scripts/lib/worktree-node-modules-guard.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK_BASENAME = "block-npm-install-node-modules-symlink.mjs";

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
// real. O `preinstall` do package.json foi TENTADO e não serve: medido ao vivo
// (npm 11, 09/09/2026), o `npm ci` remove a árvore antiga — seguindo a junction
// e esvaziando o alvo — ANTES de disparar lifecycle script algum; quando o
// preinstall roda, `node_modules` já é ENOENT e o guard legitimamente libera.
// O enforcement real é o PreToolUse hook, que roda antes do npm ser invocado.
test("o hook PreToolUse do guard está registrado em .claude/settings.json", () => {
  const settings = JSON.parse(readFileSync(join(repoRoot, ".claude/settings.json"), "utf8")) as {
    hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ args?: string[] }> }> };
  };
  const bashGroups = (settings.hooks?.PreToolUse ?? []).filter((g) => g.matcher === "Bash");
  const args = bashGroups.flatMap((g) => (g.hooks ?? []).flatMap((h) => h.args ?? []));
  assert.ok(
    args.some((a) => a.includes(HOOK_BASENAME)),
    `o hook ${HOOK_BASENAME} precisa estar no grupo PreToolUse/Bash — sem isso o guard não intercepta npm ci nenhum`,
  );
  assert.ok(existsSync(join(repoRoot, ".claude/hooks", HOOK_BASENAME)));
});

test("package.json NÃO declara preinstall pro guard (é inerte no npm ci)", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.ok(
    !/guard-node-modules-symlink|worktree-node-modules-guard/.test(pkg.scripts?.preinstall ?? ""),
    "preinstall roda DEPOIS de o npm ci apagar node_modules — não use esse caminho, o hook PreToolUse é o enforcement",
  );
});

test("hook nega npm ci quando node_modules escapa do diretório", async () => {
  const hook = await import(`../.claude/hooks/${HOOK_BASENAME}`);
  const inspect = (dir: string) => (dir === "/wt" ? "/principal/node_modules" : null);
  const hit = hook.findBlockedNpmInstall("npm ci", "/wt", inspect);
  assert.ok(hit);
  assert.match(hook.blockReason(hit), /\[GUARD #7763\]/);
  assert.equal(hook.findBlockedNpmInstall("npm ci", "/outro", inspect), null);
});

test("hook rastreia cd e --prefix, e ignora npm que não instala", async () => {
  const hook = await import(`../.claude/hooks/${HOOK_BASENAME}`);
  const inspect = (dir: string) => (dir.replaceAll("\\", "/").endsWith("/wt") ? "/principal/node_modules" : null);
  assert.ok(hook.findBlockedNpmInstall("cd /wt && npm ci", "/qualquer", inspect), "cd deve mover o alvo");
  assert.ok(hook.findBlockedNpmInstall("npm install --prefix /wt", "/qualquer", inspect), "--prefix deve mover o alvo");
  assert.equal(hook.findBlockedNpmInstall("cd /wt && npm run build", "/x", inspect), null, "npm run não reinstala");
  assert.equal(hook.findBlockedNpmInstall("cd /wt && npm test", "/x", inspect), null, "npm test não reinstala");
});

// O hook é self-contained (nenhum import de `.ts`, convenção dos hooks
// irmãos), então a paridade com a lib precisa ser travada por teste.
test("hook e lib concordam nos mesmos casos (paridade do guard duplicado)", async () => {
  const hook = await import(`../.claude/hooks/${HOOK_BASENAME}`);
  withTmp((tmp) => {
    const outside = mkdtempSync(join(tmpdir(), "wt-7763-principal-"));
    try {
      // 1. symlink externo → ambos bloqueiam
      mkdirSync(join(outside, "node_modules"), { recursive: true });
      symlinkSync(join(outside, "node_modules"), join(tmp, "node_modules"), "junction");
      assert.equal(checkNodeModulesSymlink(tmp).blocked, true);
      assert.ok(hook.nodeModulesEscapesDir(tmp));
      rmSync(join(tmp, "node_modules"), { recursive: true, force: true });

      // 2. ausente → ambos liberam
      assert.equal(checkNodeModulesSymlink(tmp).blocked, false);
      assert.equal(hook.nodeModulesEscapesDir(tmp), null);

      // 3. diretório real → ambos liberam
      mkdirSync(join(tmp, "node_modules"), { recursive: true });
      assert.equal(checkNodeModulesSymlink(tmp).blocked, false);
      assert.equal(hook.nodeModulesEscapesDir(tmp), null);
      rmSync(join(tmp, "node_modules"), { recursive: true, force: true });

      // 4. symlink intra-worktree → ambos liberam
      const inner = join(tmp, "vendor-node-modules");
      mkdirSync(inner, { recursive: true });
      symlinkSync(inner, join(tmp, "node_modules"), "junction");
      assert.equal(checkNodeModulesSymlink(tmp).blocked, false);
      assert.equal(hook.nodeModulesEscapesDir(tmp), null);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
