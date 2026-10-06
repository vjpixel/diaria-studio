/**
 * test/serve-preview-kill-seguro-9705.test.ts (#9705)
 *
 * Regressão dos 3 achados do review do #9700 em `scripts/serve-preview.ts`:
 *   1. linha de comando ilegível (`null`) liberava o SIGTERM — no `--stop-pid`
 *      e, pior, no reap AUTOMÁTICO do `--ensure` (sem pedido humano). Agora
 *      `null` = não sinaliza;
 *   2. o marcador era a substring solta `serve-preview` — `tail -f
 *      diaria-serve-preview-*.log`, `grep`, `node --test test/serve-preview-*`
 *      com PID reaproveitado passavam. Agora exige `serve-preview.ts` como o
 *      SCRIPT de um processo node/tsx;
 *   3. `--ttl-min`/`--idle-exit-min` acima de ~35.791 min estouravam o limite
 *      de 2^31-1 ms do `setTimeout` (o Node troca por 1 ms → o servidor saía
 *      logo após subir). Agora o CLI rejeita, e o timer de idle é limitado.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  isPidAlive,
  isServePreviewCmdline,
  tokenizeCmdline,
  readProcessCmdline,
  stopPreviewPid,
  reapUnresponsivePersisted,
  parseLifetimeMinutes,
  startPreviewServer,
  MAX_LIFETIME_MIN,
  MAX_TIMEOUT_MS,
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

const spawned: number[] = [];
const dirs: string[] = [];
after(() => {
  for (const pid of spawned) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // já morto
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function waitCmdline(pid: number, includes: string, timeoutMs = 5000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = readProcessCmdline(pid);
    if (c && c.includes(includes)) return c;
    await new Promise((r) => setTimeout(r, 50));
  }
  return readProcessCmdline(pid);
}

describe("isServePreviewCmdline — script node/tsx, não substring (#9705 item 2)", () => {
  const LINUX_REAL =
    "/home/u/.nvm/versions/node/v24.19.0/bin/node --require /r/node_modules/tsx/dist/preflight.cjs " +
    "--import file:///r/node_modules/tsx/dist/loader.mjs /r/scripts/serve-preview.ts --file /tmp/p.html " +
    "--ttl-min 1 --ready-file /tmp/diaria-serve-preview-1-2.ready.json --idle-exit-min 720";

  const yes: Array<[string, string]> = [
    ["linha real do filho do --detach (Linux, medida ao vivo)", LINUX_REAL],
    ["node --import tsx relativo", "node --import tsx scripts/serve-preview.ts --file x.html"],
    [
      "Windows com aspas e espaço no path",
      '"C:\\Program Files\\nodejs\\node.exe" --import tsx "C:\\Users\\a b\\diaria\\scripts\\serve-preview.ts" --file a.html',
    ],
    ["flag com = antes do script", "node --import=tsx --max-old-space-size=4096 scripts/serve-preview.ts"],
    ["binário tsx", "/usr/local/bin/tsx scripts/serve-preview.ts --file a.html"],
  ];
  for (const [name, cmd] of yes) {
    it(`reconhece: ${name}`, () => assert.equal(isServePreviewCmdline(cmd), true, cmd));
  }

  const no: Array<[string, string]> = [
    ["tail -f no log do --detach", "tail -f /tmp/diaria-serve-preview-1910041-1791251134645.log"],
    ["grep pelo nome", "grep -r serve-preview scripts"],
    ["node --test nos testes do serve-preview", "node --import tsx --test test/serve-preview-orphans-9700.test.ts"],
    ["node -e com serve-preview.ts como argumento", 'node -e "setInterval(()=>{},1000)" scripts/serve-preview.ts'],
    ["outro script com serve-preview.ts como VALOR", "node --import tsx scripts/other.ts --file scripts/serve-preview.ts"],
    ["script de nome parecido", "node --import tsx scripts/serve-preview-helper.ts"],
    ["valor de --import não é o script", "node --import /x/serve-preview.ts other.mjs"],
    ["vim editando o arquivo", "vim scripts/serve-preview.ts"],
    ["só o binário", "node"],
    ["vazia", ""],
  ];
  for (const [name, cmd] of no) {
    it(`rejeita: ${name}`, () => assert.equal(isServePreviewCmdline(cmd), false, cmd));
  }

  it("tokenizeCmdline respeita aspas", () => {
    assert.deepEqual(tokenizeCmdline('"C:\\a b\\node.exe" x  "y z"'), ["C:\\a b\\node.exe", "x", "y z"]);
  });

  it("stopPreviewPid: cmdline com a substring mas que não é o script → NÃO sinaliza", () => {
    let killed = false;
    const r = stopPreviewPid(42, {
      readCmdline: () => "tail -f /tmp/diaria-serve-preview-1-2.log",
      kill: () => void (killed = true),
    });
    assert.equal(r.outcome, "not-serve-preview");
    assert.equal(killed, false);
  });

  it("CLI --stop-pid num processo REAL com 'serve-preview' no argv (não o script) não o mata", async () => {
    // Cenário da issue: PID reaproveitado por um processo cujo argv contém a
    // substring (o nome do log do --detach), mas que não é o servidor.
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "/tmp/diaria-serve-preview-9705.log"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    assert.ok(child.pid);
    spawned.push(child.pid);
    const cmd = await waitCmdline(child.pid, "diaria-serve-preview-9705");
    if (cmd === null) return; // plataforma sem leitura de cmdline — coberto pelos casos puros
    const r = runCli(["--stop-pid", String(child.pid)]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /not-serve-preview/);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(isPidAlive(child.pid), true, "processo alheio deveria continuar vivo");
  });
});

describe("cmdline ilegível nunca libera o sinal (#9705 item 1)", () => {
  it("reap automático do --ensure: cmdline null → não sinaliza e devolve null", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-preview-9705-reap-"));
    dirs.push(dir);
    const p = join(dir, "persist.json");
    writeFileSync(p, JSON.stringify({ u: "http://127.0.0.1:1/a.html", u_pid: "4242" }));
    let killed = false;
    const reaped = reapUnresponsivePersisted(p, "u", {
      isAlive: () => true,
      stop: (pid) => stopPreviewPid(pid, { readCmdline: () => null, kill: () => void (killed = true) }),
    });
    assert.equal(reaped, null);
    assert.equal(killed, false, "reap automático não pode matar PID que não deu pra validar");
  });

  it("CLI --stop-pid num PID inexistente: recusa como unverifiable, sai 0", () => {
    // PID alto e quase certamente livre; /proc/{pid} não existe → null.
    const r = runCli(["--stop-pid", "4194000"]);
    assert.equal(r.status, 0, r.stderr);
    if (readProcessCmdline(4194000) === null) {
      assert.match(r.stdout, /"unverifiable"/);
      assert.match(r.stderr, /NÃO sinalizado/);
    }
  });
});

describe("--ttl-min/--idle-exit-min acima do limite do setTimeout (#9705 item 3)", () => {
  it("MAX_LIFETIME_MIN cabe no setTimeout e o próximo minuto não", () => {
    assert.equal(MAX_LIFETIME_MIN, 35791);
    assert.ok(MAX_LIFETIME_MIN * 60_000 <= MAX_TIMEOUT_MS);
    assert.ok((MAX_LIFETIME_MIN + 1) * 60_000 > MAX_TIMEOUT_MS);
  });

  it("parseLifetimeMinutes: ausente=0, teto aceito, acima do teto/negativo/lixo rejeitados", () => {
    assert.deepEqual(parseLifetimeMinutes("ttl-min", undefined), { ok: true, minutes: 0 });
    assert.deepEqual(parseLifetimeMinutes("ttl-min", "0"), { ok: true, minutes: 0 });
    assert.deepEqual(parseLifetimeMinutes("ttl-min", String(MAX_LIFETIME_MIN)), { ok: true, minutes: MAX_LIFETIME_MIN });
    for (const bad of ["35792", "40000", "1e9", "-1", "abc", "", "Infinity"]) {
      const r = parseLifetimeMinutes("ttl-min", bad);
      assert.equal(r.ok, false, `deveria rejeitar ${JSON.stringify(bad)}`);
    }
    const over = parseLifetimeMinutes("idle-exit-min", "40000");
    assert.ok(!over.ok && /teto/.test(over.error) && /--idle-exit-min/.test(over.error));
  });

  it("CLI --ttl-min 40000 sai 2 com o teto na mensagem (em vez de o servidor morrer em 1 ms)", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-preview-9705-ttl-"));
    dirs.push(dir);
    const htmlPath = join(dir, "p.html");
    writeFileSync(htmlPath, "<html><body>ttl</body></html>");
    const r = runCli(["--file", htmlPath, "--port", "0", "--ttl-min", "40000"]);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /teto de 35791 min/);
  });

  it("CLI --detach --idle-exit-min 40000 rejeita no PAI, sem subir filho", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-preview-9705-idle-"));
    dirs.push(dir);
    const htmlPath = join(dir, "p.html");
    writeFileSync(htmlPath, "<html><body>idle</body></html>");
    const r = runCli(["--file", htmlPath, "--port", "0", "--detach", "--idle-exit-min", "40000"]);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /--idle-exit-min 40000 acima do teto/);
    assert.doesNotMatch(r.stdout, /"pid"/);
  });

  it("startPreviewServer com idleExitMs acima de 2^31-1 não dispara o onIdle logo após subir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-preview-9705-prog-"));
    dirs.push(dir);
    const htmlPath = join(dir, "p.html");
    writeFileSync(htmlPath, "<html><body>prog</body></html>");
    let idleCalls = 0;
    const server = await startPreviewServer({
      filePath: htmlPath,
      port: 0,
      idleExitMs: 40_000 * 60_000,
      onIdle: () => idleCalls++,
    });
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(idleCalls, 0, "delay acima do teto virava 1 ms no Node — o servidor saía logo");
    } finally {
      await server.close();
    }
  });
});
