/**
 * test/serve-preview-orphans-9700.test.ts (#9700)
 *
 * Regressão dos 3 caminhos de servidor órfão achados no review do #9678
 * (`scripts/serve-preview.ts --detach/--ensure`):
 *   (a) `--ensure` com PID vivo mas URL muda subia outro servidor e
 *       sobrescrevia o persist — o antigo ficava vivo, fora do alcance de
 *       `--stop-pid`. Agora o antigo é encerrado antes;
 *   (b) filho do `--detach` que não gravava o ready-file a tempo ficava vivo
 *       depois do pai lançar. Agora o pai mata o `child.pid`;
 *   (c) sem teardown (sessão caiu), o filho com `--watch` vivia até o reboot —
 *       agora há idle-exit/TTL, com default injetado no filho desanexado; e
 *       `--stop-pid` com PID reaproveitado atingia processo alheio — agora a
 *       linha de comando é validada antes do sinal.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  isPidAlive,
  readPersistedPreview,
  readProcessCmdline,
  stopPreviewPid,
  reapUnresponsivePersisted,
  spawnDetachedPreview,
  startPreviewServer,
  withDetachedLifetimeDefaults,
  DETACHED_DEFAULT_IDLE_EXIT_MIN,
  DETACHED_DEFAULT_TTL_MIN,
} from "../scripts/serve-preview.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "serve-preview.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: ROOT,
    shell: false,
    encoding: "utf8",
    timeout: 30_000,
  });
}

/** Processo-dublê de vida longa; `marker` entra no argv (= na linha de comando). */
function spawnSleeper(marker: string): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  assert.ok(child.pid);
  return child.pid;
}

/**
 * Dublê de um serve-preview REAL do ponto de vista da linha de comando
 * (#9705): processo node cujo script é um arquivo chamado `serve-preview.ts`
 * (em dir temporário, só um `setInterval`) — o que `isServePreviewCmdline`
 * exige. Substring solta no argv não basta mais.
 */
const fakeDirs: string[] = [];
function spawnFakeServePreview(): number {
  const dir = mkdtempSync(join(tmpdir(), "serve-preview-9705-fake-"));
  fakeDirs.push(dir);
  const script = join(dir, "serve-preview.ts");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, ["--import", "tsx", script, "--file", "x.html"], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  assert.ok(child.pid);
  return child.pid;
}

function killQuietly(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // já morto
  }
}

async function waitDead(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isPidAlive(pid);
}

/** Linha de comando do PID fica legível alguns ms depois do spawn. */
async function waitCmdline(pid: number, includes: string, timeoutMs = 5000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = readProcessCmdline(pid);
    if (c && c.includes(includes)) return c;
    await new Promise((r) => setTimeout(r, 50));
  }
  return readProcessCmdline(pid);
}

const spawned: number[] = [];
after(() => {
  for (const pid of spawned) killQuietly(pid);
  for (const d of fakeDirs) rmSync(d, { recursive: true, force: true });
});

describe("stopPreviewPid — valida a linha de comando antes do SIGTERM (#9700 c)", () => {
  it("linha de comando sem o marcador (PID reaproveitado) → NÃO sinaliza", () => {
    let killed = false;
    const r = stopPreviewPid(42, { readCmdline: () => "/usr/bin/postgres -D /var/lib", kill: () => void (killed = true) });
    assert.equal(r.outcome, "not-serve-preview");
    assert.equal(killed, false);
  });

  it("linha de comando com o marcador → sinaliza", () => {
    let sig: string | null = null;
    const r = stopPreviewPid(42, {
      readCmdline: () => "node --import tsx scripts/serve-preview.ts --file x.html",
      kill: (_p, s) => void (sig = s),
    });
    assert.equal(r.outcome, "stopped");
    assert.equal(sig, "SIGTERM");
  });

  it("linha de comando ilegível → NÃO sinaliza (#9705; antes do #9705 sinalizava às cegas)", () => {
    let killed = false;
    const r = stopPreviewPid(42, { readCmdline: () => null, kill: () => void (killed = true) });
    assert.equal(r.outcome, "unverifiable");
    assert.equal(killed, false);
  });

  it("CLI --stop-pid em processo ALHEIO vivo não o mata (cenário real do PID reaproveitado)", async () => {
    const pid = spawnSleeper("processo-alheio-9700");
    spawned.push(pid);
    const cmd = await waitCmdline(pid, "processo-alheio-9700");
    if (cmd === null) return; // plataforma sem leitura de cmdline — coberto pelos casos puros acima
    const r = runCli(["--stop-pid", String(pid)]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /not-serve-preview/);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(isPidAlive(pid), true, "processo alheio deveria continuar vivo");
  });

  it("CLI --stop-pid num serve-preview encerra", async () => {
    const pid = spawnFakeServePreview();
    spawned.push(pid);
    await waitCmdline(pid, "serve-preview.ts");
    const r = runCli(["--stop-pid", String(pid)]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"stopped"/);
    assert.equal(await waitDead(pid), true);
  });
});

describe("--ensure com PID vivo mas URL muda (#9700 a)", () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-preview-9700-ensure-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reapUnresponsivePersisted encerra o PID persistido vivo; não toca PID morto", () => {
    const p = join(dir, "a.json");
    writeFileSync(p, JSON.stringify({ u: "http://127.0.0.1:1/a.html", u_pid: "777" }));
    const stoppedPids: number[] = [];
    const stop = (pid: number) => {
      stoppedPids.push(pid);
      return { outcome: "stopped" as const, cmdline: "serve-preview" };
    };
    assert.equal(reapUnresponsivePersisted(p, "u", { isAlive: () => true, stop }), 777);
    assert.equal(reapUnresponsivePersisted(p, "u", { isAlive: () => false, stop }), null);
    assert.deepEqual(stoppedPids, [777]);
  });

  it("CLI: o servidor antigo (vivo, sem responder) morre e o persist aponta pro novo", async () => {
    const htmlPath = join(dir, "preview.html");
    writeFileSync(htmlPath, "<html><body>ensure-9700</body></html>");
    const persistPath = join(dir, "persist.json");
    // "Servidor" travado: processo vivo, linha de comando de serve-preview,
    // mas a URL persistida não responde (porta 1 = nada escutando).
    const stuck = spawnFakeServePreview();
    spawned.push(stuck);
    await waitCmdline(stuck, "serve-preview.ts");
    writeFileSync(persistPath, JSON.stringify({ preview_url: "http://127.0.0.1:1/preview.html", preview_url_pid: String(stuck) }));

    const r = runCli(["--file", htmlPath, "--port", "0", "--ensure", "--persist-to", persistPath, "--field", "preview_url"]);
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    spawned.push(json.pid);
    assert.equal(json.reused, false);
    assert.equal(await waitDead(stuck), true, "o PID antigo deveria ter sido encerrado antes de re-servir");
    assert.equal(readPersistedPreview(persistPath, "preview_url")?.pid, json.pid);
    assert.equal((await fetch(json.url)).status, 200);
  });
});

describe("--detach: filho que não fica pronto é morto (#9700 b)", () => {
  it("timeout do ready-file mata o child.pid antes de lançar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-preview-9700-timeout-"));
    try {
      const pidFile = join(dir, "child.pid");
      const childScript = join(dir, "never-ready.mjs");
      writeFileSync(
        childScript,
        "import { writeFileSync } from 'node:fs';\n" +
          "const i = process.argv.indexOf('--pidfile');\n" +
          "writeFileSync(process.argv[i + 1], String(process.pid));\n" +
          "setInterval(() => {}, 1000);\n",
      );
      await assert.rejects(
        spawnDetachedPreview(["--pidfile", pidFile], { readyTimeoutMs: 1500, childScript }),
        /não ficou pronto/,
      );
      assert.ok(existsSync(pidFile), "o dublê deveria ter gravado o PID");
      const childPid = Number(readFileSync(pidFile, "utf8"));
      spawned.push(childPid);
      assert.equal(await waitDead(childPid), true, "filho que não ficou pronto não pode ficar órfão");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("idle-exit / TTL (#9700 c)", () => {
  it("withDetachedLifetimeDefaults injeta os defaults sem sobrescrever o do chamador", () => {
    assert.deepEqual(withDetachedLifetimeDefaults(["--file", "a.html"]), [
      "--file", "a.html",
      "--idle-exit-min", String(DETACHED_DEFAULT_IDLE_EXIT_MIN),
      "--ttl-min", String(DETACHED_DEFAULT_TTL_MIN),
    ]);
    assert.deepEqual(withDetachedLifetimeDefaults(["--idle-exit-min", "0", "--ttl-min=5"]), [
      "--idle-exit-min", "0", "--ttl-min=5",
    ]);
  });

  it("onIdle dispara sem request; aba conectada no live-reload adia", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-preview-9700-idle-"));
    const htmlPath = join(dir, "p.html");
    writeFileSync(htmlPath, "<html><body>idle</body></html>");
    let idleCalls = 0;
    const server = await startPreviewServer({
      filePath: htmlPath,
      port: 0,
      watch: true,
      idleExitMs: 250,
      onIdle: () => idleCalls++,
    });
    try {
      const ctrl = new AbortController();
      const sse = await fetch(`http://127.0.0.1:${server.port}/__live-reload`, { signal: ctrl.signal });
      assert.equal(sse.status, 200);
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(idleCalls, 0, "aba conectada = em uso, não ocioso");
      ctrl.abort();
      await sse.body?.cancel().catch(() => undefined);
      const deadline = Date.now() + 3000;
      while (idleCalls === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.ok(idleCalls >= 1, "sem aba e sem request, o idle deveria disparar");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI --detach com --idle-exit-min curto: o servidor desanexado sai sozinho", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-preview-9700-idlecli-"));
    try {
      const htmlPath = join(dir, "p.html");
      writeFileSync(htmlPath, "<html><body>idle-cli</body></html>");
      const r = runCli(["--file", htmlPath, "--port", "0", "--detach", "--idle-exit-min", "0.02"]);
      assert.equal(r.status, 0, r.stderr);
      const { pid } = JSON.parse(r.stdout);
      spawned.push(pid);
      assert.equal(await waitDead(pid), true, "servidor ocioso deveria ter saído sozinho");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI --detach com --ttl-min curto (idle desligado): sai pelo TTL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-preview-9700-ttl-"));
    try {
      const htmlPath = join(dir, "p.html");
      writeFileSync(htmlPath, "<html><body>ttl</body></html>");
      const r = runCli(["--file", htmlPath, "--port", "0", "--detach", "--idle-exit-min", "0", "--ttl-min", "0.03"]);
      assert.equal(r.status, 0, r.stderr);
      const { pid } = JSON.parse(r.stdout);
      spawned.push(pid);
      assert.equal(await waitDead(pid), true, "servidor deveria ter saído pelo TTL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
