/**
 * test/publish-edition-site-page-fresh-code-fallback-9963.test.ts (#9963)
 *
 * Incidente 261009 (Stage 6): o guard #9821 recusou a página (checkout 38
 * commits atrás, `sync-code.ts` travado pelo `nul` do #9960) e não havia saída
 * documentada — o workaround foi criar à mão um worktree em `origin/master`,
 * linkar `node_modules` e rodar o script de lá (PR #9951). Agora o próprio
 * script faz isso (`runWithFreshCodeWorktree`).
 *
 * Garante: argv do filho (edition-dir absoluto + anti-recursão), ordem da
 * limpeza (links ANTES do worktree — remoção recursiva com junction no lugar
 * esvazia o alvo, classe do #7763), recusa original preservada quando o
 * fallback não roda, waiter do #9593 lançado do hospedeiro, e um caminho com
 * git + fs REAIS (worktree nasce em origin/master, hospedeiro intacto depois).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultFreshCodeFallbackDeps,
  FRESH_CODE_HOST_ROOT_ENV,
  freshCodeChildArgv,
  resolveWaiterLaunch,
  runWithFreshCodeWorktree,
  type FreshCodeFallbackDeps,
} from "../scripts/publish-edition-site-page.ts";

const cleanup: string[] = [];
after(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

describe("#9963 freshCodeChildArgv — puro", () => {
  it("troca --edition-dir relativo pelo absoluto (as duas formas) e acrescenta a flag anti-recursão uma vez", () => {
    assert.deepEqual(freshCodeChildArgv(["--edition-dir", "data/editions/261009", "--slug", "x", "--sitemap", "s.xml"], "/abs/261009"), [
      "--edition-dir",
      "/abs/261009",
      "--slug",
      "x",
      "--sitemap",
      "s.xml",
      "--no-fresh-code-fallback",
    ]);
    assert.deepEqual(freshCodeChildArgv(["--edition-dir=data/e", "--no-fresh-code-fallback"], "/abs/e"), [
      "--edition-dir",
      "/abs/e",
      "--no-fresh-code-fallback",
    ]);
  });
});

describe("#9963 resolveWaiterLaunch — puro", () => {
  it("dentro do worktree fresco → waiter roda do hospedeiro (o worktree some quando o filho termina)", () => {
    const r = resolveWaiterLaunch("/tmp/wt", "/tmp/wt/scripts/publish-edition-site-page.ts", { [FRESH_CODE_HOST_ROOT_ENV]: "/host" }, () => true);
    assert.deepEqual(r, { rootDir: "/host", scriptPath: join("/host", "scripts", "publish-edition-site-page.ts") });
  });
  it("sem a env, ou hospedeiro sem o script → comportamento de sempre", () => {
    const self = "/r/scripts/publish-edition-site-page.ts";
    assert.deepEqual(resolveWaiterLaunch("/r", self, {}, () => true), { rootDir: "/r", scriptPath: self });
    assert.deepEqual(resolveWaiterLaunch("/r", self, { [FRESH_CODE_HOST_ROOT_ENV]: "/host" }, () => false), { rootDir: "/r", scriptPath: self });
  });
});

function fakeDeps(over: Partial<FreshCodeFallbackDeps> = {}) {
  const events: string[] = [];
  const childCalls: Array<{ cwd: string; scriptPath: string; argv: string[]; hostRoot: string }> = [];
  const deps: FreshCodeFallbackDeps = {
    git: (args) => {
      events.push(`git ${args.join(" ")}`);
      return "";
    },
    mkTemp: () => "/tmp/wt",
    exists: () => true,
    link: (target, linkPath) => {
      events.push(`link ${linkPath} -> ${target}`);
    },
    unlink: (linkPath) => {
      events.push(`unlink ${linkPath}`);
      return true;
    },
    runChild: (a) => {
      events.push("child");
      childCalls.push(a);
      return 0;
    },
    rmDir: (p) => {
      events.push(`rm ${p}`);
    },
    log: () => {},
    ...over,
  };
  return { deps, events, childCalls };
}

describe("#9963 runWithFreshCodeWorktree — orquestração (fakes)", () => {
  it("cria worktree em origin/master, linka node_modules+data, roda o filho e desfaz os links ANTES de remover o worktree", () => {
    const { deps, events, childCalls } = fakeDeps({ runChild: (a) => (childCalls.push(a), events.push("child"), 4) });
    const r = runWithFreshCodeWorktree("/host", ["--edition-dir", "data/editions/261009"], "/host/data/editions/261009", deps);

    assert.deepEqual(r, { ran: true, exitCode: 4 }, "exit do filho repassado");
    assert.equal(events[0], "git worktree add --detach /tmp/wt origin/master");
    assert.equal(childCalls[0].cwd, "/tmp/wt");
    assert.equal(childCalls[0].hostRoot, "/host");
    assert.equal(childCalls[0].scriptPath, join("/tmp/wt", "scripts", "publish-edition-site-page.ts"));
    assert.ok(childCalls[0].argv.includes("--no-fresh-code-fallback"));
    assert.ok(childCalls[0].argv.includes("/host/data/editions/261009"));
    const iChild = events.indexOf("child");
    const iUnlinkNm = events.indexOf(`unlink ${join("/tmp/wt", "node_modules")}`);
    const iUnlinkData = events.indexOf(`unlink ${join("/tmp/wt", "data")}`);
    const iRemove = events.indexOf("git worktree remove --force /tmp/wt");
    assert.ok(events.includes(`link ${join("/tmp/wt", "node_modules")} -> ${join("/host", "node_modules")}`));
    assert.ok(iChild < iUnlinkNm && iUnlinkNm < iRemove && iUnlinkData < iRemove, events.join("\n"));
  });

  it("worktree add falha → ran:false, filho nunca roda", () => {
    const { deps, events } = fakeDeps({
      git: (args) => {
        if (args[1] === "add") throw new Error("invalid reference: origin/master");
        return "";
      },
    });
    const r = runWithFreshCodeWorktree("/host", [], "/e", deps);
    assert.equal(r.ran, false);
    assert.match((r as { reason: string }).reason, /invalid reference/);
    assert.ok(!events.includes("child"));
  });

  it("node_modules ausente no hospedeiro → ran:false e o worktree é removido", () => {
    const { deps, events } = fakeDeps({ exists: (p) => !p.endsWith("node_modules") });
    const r = runWithFreshCodeWorktree("/host", [], "/e", deps);
    assert.equal(r.ran, false);
    assert.ok(!events.includes("child"));
    assert.ok(events.includes("git worktree remove --force /tmp/wt"));
  });

  it("filho não iniciou (null) → ran:false (o chamador devolve a recusa original)", () => {
    const { deps } = fakeDeps({ runChild: () => null });
    assert.equal(runWithFreshCodeWorktree("/host", [], "/e", deps).ran, false);
  });

  it("link não sai → worktree MANTIDO (nunca remoção que atravesse o link)", () => {
    const logs: string[] = [];
    const { deps, events } = fakeDeps({ unlink: (l) => !l.endsWith("node_modules"), log: (s) => logs.push(s) });
    const r = runWithFreshCodeWorktree("/host", [], "/e", deps);
    assert.deepEqual(r, { ran: true, exitCode: 0 });
    assert.ok(!events.some((e) => e.startsWith("git worktree remove") || e.startsWith("rm ")), events.join("\n"));
    assert.ok(logs.some((l) => /mantido no disco/.test(l)));
  });
});

// ── git + fs REAIS ─────────────────────────────────────────────────────────
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}
function commit(cwd: string, file: string, content: string): void {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), content);
  git(["add", file], cwd);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", file], cwd);
}

describe("#9963 runWithFreshCodeWorktree — git e fs reais", () => {
  it("checkout defasado: filho roda em origin/master com node_modules/data linkados; hospedeiro intacto e worktree removido depois", () => {
    const origin = tmp("diaria-9963-origin-");
    git(["init", "-q", "--bare", "-b", "master", origin], origin);
    const other = tmp("diaria-9963-other-");
    git(["clone", "-q", origin, other], other);
    git(["checkout", "-q", "-b", "master"], other);
    commit(other, "scripts/publish-edition-site-page.ts", "// gerador v1\n");
    git(["push", "-q", "origin", "master"], other);
    const host = tmp("diaria-9963-host-");
    git(["clone", "-q", origin, host], host);
    commit(other, "scripts/publish-edition-site-page.ts", "// gerador v2 (sem seta)\n");
    git(["push", "-q", "origin", "master"], other);
    git(["fetch", "-q", "origin"], host);
    // Fora do git no hospedeiro (o que o filho precisa enxergar).
    mkdirSync(join(host, "node_modules", "tsx"), { recursive: true });
    writeFileSync(join(host, "node_modules", "tsx", "package.json"), "{}");
    mkdirSync(join(host, "data", "editions"), { recursive: true });
    writeFileSync(join(host, "data", "editions", "marker"), "dado do hospedeiro");

    const seen: { generator?: string; nm?: boolean; data?: string; cwd?: string } = {};
    const deps: FreshCodeFallbackDeps = {
      ...defaultFreshCodeFallbackDeps(git),
      log: () => {},
      runChild: ({ cwd, scriptPath }) => {
        seen.cwd = cwd;
        seen.generator = readFileSync(scriptPath, "utf8");
        seen.nm = existsSync(join(cwd, "node_modules", "tsx", "package.json"));
        seen.data = readFileSync(join(cwd, "data", "editions", "marker"), "utf8");
        return 0;
      },
    };
    const r = runWithFreshCodeWorktree(host, ["--edition-dir", "data/editions/x"], join(host, "data", "editions", "x"), deps);

    assert.deepEqual(r, { ran: true, exitCode: 0 });
    assert.equal(seen.generator, "// gerador v2 (sem seta)\n", "filho roda o gerador de origin/master");
    assert.equal(readFileSync(join(host, "scripts", "publish-edition-site-page.ts"), "utf8"), "// gerador v1\n", "hospedeiro segue defasado, intocado");
    assert.equal(seen.nm, true);
    assert.equal(seen.data, "dado do hospedeiro");
    assert.ok(seen.cwd && !existsSync(seen.cwd), "worktree temporário removido");
    assert.ok(existsSync(join(host, "node_modules", "tsx", "package.json")), "node_modules do hospedeiro intacto (#7763)");
    assert.ok(existsSync(join(host, "data", "editions", "marker")), "data/ do hospedeiro intacto");
    assert.doesNotMatch(git(["worktree", "list"], host), /diaria-site-page-code-/);
  });
});
