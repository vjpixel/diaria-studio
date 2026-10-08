/**
 * #9911: script que usa `fetch` não pode sair via `process.exit(`.
 *
 * No Windows (Node 24), `process.exit(code)` logo depois de um `fetch` cai no
 * assert do libuv `!(handle->flags & UV_HANDLE_CLOSING)` e o processo sai 127
 * em vez do código pedido (medido 08/10/2026: `fetch` + `process.exit(4)` →
 * 127; `fetch` + `process.exitCode = 4` → 4). O #9884 corrigiu um caso
 * (publish-linkedin-personal); aqui entram o helper `runCli`, o guard de
 * conjunto e a migração do conjunto prioritário.
 *
 * O assert só reproduz no Windows. No CI Linux, este teste trava:
 *  1. o guard: nenhum script fora da allowlist combina fetch + process.exit,
 *     e a allowlist só encolhe (entrada obsoleta falha);
 *  2. o conjunto prioritário fora da allowlist (não volta a ser liberado);
 *  3. o contrato do `runCli` (grava exitCode, não encerra o processo);
 *  4. o código chegando ao processo pelos entry points migrados.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ALLOWLIST, scanProcessExitAfterFetch, scanSource } from "../scripts/lib/process-exit-fetch-scan.ts";
import { CliExit, runCli } from "../scripts/lib/cli-exit.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Migrados no #9911: LinkedIn pessoal, publishers diários, Stage 2/4/5/6. */
const PRIORITY = [
  "scripts/linkedin-personal-token-alarm.ts",
  "scripts/linkedin-personal-oauth.ts",
  "scripts/publish-facebook.ts",
  "scripts/publish-instagram.ts",
  "scripts/publish-linkedin.ts",
  "scripts/publish-threads.ts",
  "scripts/stitch-newsletter.ts",
  "scripts/upload-html-public.ts",
  "scripts/verify-social-worker-dispatch.ts",
  "scripts/verify-stage-4-dispatch.ts",
  "scripts/run-fact-checker.ts",
  "scripts/refresh-destaque-sources.ts",
  "scripts/select-use-melhor-post.ts",
  "scripts/fix-post-slug.ts",
  "scripts/late-refresh-candidates.ts",
  "scripts/verify-accessibility.ts",
  "scripts/prep-manual-publish.ts",
];

describe("guard fetch + process.exit (#9911)", () => {
  it("nenhum script fora da allowlist combina fetch e process.exit, e a allowlist não tem entrada obsoleta", () => {
    const r = scanProcessExitAfterFetch(ROOT);
    assert.deepEqual(r.violations, [], `migre para runCli (scripts/lib/cli-exit.ts): ${r.violations.join(", ")}`);
    assert.deepEqual(r.stale, [], `remova da ALLOWLIST (já não violam): ${r.stale.join(", ")}`);
  });

  it("o conjunto prioritário não está na allowlist", () => {
    for (const f of PRIORITY) assert.equal(ALLOWLIST.has(f), false, f);
  });

  it("scanSource: fetch chamado ou passado adiante conta; comentário, string e algo.fetch não", () => {
    const exit = "process.exit(1);\n";
    assert.deepEqual(scanSource(`await fetch(u);\n${exit}`), { usesFetch: true, callsProcessExit: true });
    assert.equal(scanSource(`await globalThis.fetch(u);`).usesFetch, true);
    assert.equal(scanSource(`await checkTokenRemote(fetch, t);`).usesFetch, true);
    assert.equal(scanSource(`run({ fetchFn: fetch });`).usesFetch, true);
    assert.equal(scanSource(`// fetch(u)\n/* fetch(u) */ const s = "fetch(u)";`).usesFetch, false);
    assert.equal(scanSource(`await env.ASSETS.fetch(req);`).usesFetch, false);
    assert.equal(scanSource(`function f(fetch: typeof globalThis.fetch) {}`).usesFetch, false);
    assert.equal(scanSource(`// process.exit(1)\nconst s = "process.exit(1)";`).callsProcessExit, false);
    assert.equal(scanSource(`process.exitCode = 1;`).callsProcessExit, false);
  });
});

describe("runCli (#9911)", () => {
  const withExitCode = async (fn: () => Promise<void>): Promise<number | string | undefined> => {
    const saved = process.exitCode;
    process.exitCode = undefined;
    try {
      await fn();
      return process.exitCode;
    } finally {
      process.exitCode = saved;
    }
  };

  it("grava o código devolvido por main", async () => {
    assert.equal(await withExitCode(() => runCli(async () => 4)), 4);
    assert.equal(await withExitCode(() => runCli(() => 0)), 0);
  });

  it("main sem retorno não mexe no exitCode", async () => {
    assert.equal(await withExitCode(() => runCli(async () => {})), undefined);
  });

  it("exceção chama onError e grava errorCode (default 1)", async () => {
    const seen: unknown[] = [];
    const boom = new Error("boom");
    assert.equal(await withExitCode(() => runCli(async () => { throw boom; }, { onError: (e) => seen.push(e) })), 1);
    assert.deepEqual(seen, [boom]);
    assert.equal(await withExitCode(() => runCli(async () => { throw boom; }, { onError: () => {}, errorCode: 2 })), 2);
  });

  it("CliExit grava o código sem passar por onError", async () => {
    const seen: unknown[] = [];
    assert.equal(await withExitCode(() => runCli(async () => { throw new CliExit(3); }, { onError: (e) => seen.push(e) })), 3);
    assert.deepEqual(seen, []);
  });

  it("o processo sai com o código de main e de CliExit (fixture)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-exit-9911-"));
    try {
      const helper = pathToFileURL(resolve(ROOT, "scripts/lib/cli-exit.ts")).href;
      const ret = join(dir, "ret.ts");
      writeFileSync(ret, `import { runCli } from ${JSON.stringify(helper)};\nrunCli(async () => 4);\n`);
      const thr = join(dir, "thr.ts");
      writeFileSync(thr, `import { CliExit, runCli } from ${JSON.stringify(helper)};\nrunCli(async () => { throw new CliExit(5); });\n`);
      for (const [file, code] of [[ret, 4], [thr, 5]] as const) {
        const r = spawnSync(process.execPath, ["--import", "tsx", file], { cwd: ROOT, encoding: "utf8" });
        assert.equal(r.status, code, r.stderr);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("entry points migrados propagam o código (#9911)", () => {
  // Só caminhos sem rede e sem efeito: erro de uso antes de qualquer I/O externo.
  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--import", "tsx", resolve(ROOT, script), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  it("refresh-destaque-sources sem --edition-dir sai 1", () => {
    const r = run("scripts/refresh-destaque-sources.ts", []);
    assert.equal(r.status, 1, r.stderr);
  });

  it("verify-stage-4-dispatch sem --edition-dir sai 2", () => {
    const r = run("scripts/verify-stage-4-dispatch.ts", []);
    assert.equal(r.status, 2, r.stderr);
  });

  it("fix-post-slug sem BEEHIIV_API_KEY sai 2 via CliExit (de dentro de loadConfig)", () => {
    // String vazia: loadProjectEnv não sobrescreve var já presente, então um
    // .env local com a key não transforma o teste em chamada de rede.
    const r = run("scripts/fix-post-slug.ts", ["--post-id", "x", "--slug", "y"], { BEEHIIV_API_KEY: "" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /BEEHIIV_API_KEY não definida/);
    assert.doesNotMatch(r.stderr, /Fatal/);
  });
});
