/**
 * test/serve-preview-detach.test.ts (#9678)
 *
 * Regressão do achado da edição 261006: no Stage 4 os dois preview servers
 * (`serve-preview.ts --watch`) subiam como background task do harness
 * (`run_in_background: true` + `&`), e o harness os matava no teto de tempo
 * da task (2h no máximo) — os links `127.0.0.1` do gate morriam com o editor
 * ainda revisando.
 *
 * O fix é `--detach` (o comando SAI sozinho em segundos, e o servidor vive
 * num processo desanexado, fora da árvore da task) + `--ensure` (re-servir
 * sob demanda, idempotente). Este arquivo trava:
 *   1. o CLI com `--detach` termina por conta própria (exit 0) e o servidor
 *      continua respondendo DEPOIS que o comando saiu — o cenário real da
 *      issue (antes, o processo que servia ERA o processo da task);
 *   2. `{field}_pid` gravado é o do FILHO (é ele que `--stop-pid` precisa matar);
 *   3. `--ensure` reusa um servidor vivo e sobe outro quando o persistido morreu;
 *   4. os helpers puros (argv do filho, leitura do persist, detecção de vivo).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  buildDetachedChildArgs,
  readPersistedPreview,
  findLivePersistedPreview,
  isPidAlive,
  pruneOldDetachedLogs,
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

function killQuietly(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // já morto
  }
}

async function waitDead(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("buildDetachedChildArgs (#9678)", () => {
  it("remove --detach/--ensure e acrescenta --ready-file", () => {
    const out = buildDetachedChildArgs(
      ["--file", "a.html", "--detach", "--port", "0", "--ensure", "--watch"],
      "/tmp/r.json",
    );
    assert.deepEqual(out, ["--file", "a.html", "--port", "0", "--watch", "--ready-file", "/tmp/r.json"]);
  });

  it("descarta --ready-file herdado (nas duas sintaxes) — o filho só recebe o novo", () => {
    const out = buildDetachedChildArgs(
      ["--file", "a.html", "--ready-file", "/velho", "--ready-file=/velho2", "--detach"],
      "/novo",
    );
    assert.deepEqual(out, ["--file", "a.html", "--ready-file", "/novo"]);
  });
});

describe("readPersistedPreview / findLivePersistedPreview (#9678)", () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-preview-persist-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("lê url + pid; null quando falta qualquer um ou o JSON é inválido", () => {
    const p = join(dir, "a.json");
    writeFileSync(p, JSON.stringify({ x: "http://127.0.0.1:1/a.html", x_pid: "123" }));
    assert.deepEqual(readPersistedPreview(p, "x"), { url: "http://127.0.0.1:1/a.html", pid: 123 });
    writeFileSync(p, JSON.stringify({ x: "http://127.0.0.1:1/a.html" }));
    assert.equal(readPersistedPreview(p, "x"), null);
    writeFileSync(p, "{nao é json");
    assert.equal(readPersistedPreview(p, "x"), null);
    assert.equal(readPersistedPreview(join(dir, "inexistente.json"), "x"), null);
  });

  it("vivo exige PID vivo E URL respondendo", async () => {
    const p = join(dir, "b.json");
    // PID do próprio processo de teste = garantidamente vivo.
    writeFileSync(p, JSON.stringify({ x: "http://127.0.0.1:1/a.html", x_pid: String(process.pid) }));
    assert.ok(await findLivePersistedPreview(p, "x", async () => true));
    assert.equal(await findLivePersistedPreview(p, "x", async () => false), null, "URL morta = não vivo");
    // PID que não existe (máximo comum de pid_max no Linux é bem menor).
    writeFileSync(p, JSON.stringify({ x: "http://127.0.0.1:1/a.html", x_pid: "2147483646" }));
    assert.equal(await findLivePersistedPreview(p, "x", async () => true), null, "PID morto = não vivo");
  });
});

describe("serve-preview.ts --detach / --ensure CLI (#9678)", () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-preview-detach-"));
  const htmlPath = join(dir, "preview.html");
  writeFileSync(htmlPath, "<html><body>detach</body></html>", "utf8");
  const persistPath = join(dir, "04-newsletter-url.json");
  const spawned: number[] = [];

  after(() => {
    for (const pid of spawned) killQuietly(pid);
    rmSync(dir, { recursive: true, force: true });
  });

  it("--detach: o comando SAI sozinho e o servidor continua vivo depois (cenário da issue)", async () => {
    const r = runCli([
      "--file", htmlPath, "--port", "0", "--watch", "--detach",
      "--persist-to", persistPath, "--field", "newsletter_url",
    ]);
    // spawnSync só retorna quando o processo sai — se o servidor ainda
    // pertencesse ao comando, isto bateria no timeout (status null).
    assert.equal(r.status, 0, `--detach deveria sair 0 sozinho; stderr: ${r.stderr}`);
    const json = JSON.parse(r.stdout);
    spawned.push(json.pid);
    assert.equal(json.detached, true);
    assert.ok(json.url.startsWith("http://127.0.0.1:"));

    const res = await fetch(json.url);
    assert.equal(res.status, 200, "servidor desanexado deveria responder depois que o comando saiu");
    assert.match(await res.text(), /detach/);

    const persisted = readPersistedPreview(persistPath, "newsletter_url");
    assert.ok(persisted);
    assert.equal(persisted.url, json.url);
    assert.equal(persisted.pid, json.pid, "{field}_pid deve ser o do FILHO, que é quem --stop-pid precisa matar");
  });

  it("--ensure: reusa o servidor vivo (mesmo PID, sem subir outro)", () => {
    const before = readPersistedPreview(persistPath, "newsletter_url");
    assert.ok(before);
    const r = runCli(["--file", htmlPath, "--watch", "--ensure", "--persist-to", persistPath, "--field", "newsletter_url"]);
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    assert.equal(json.reused, true);
    assert.equal(json.pid, before.pid);
    assert.equal(json.url, before.url);
  });

  it("--ensure: servidor persistido morto → sobe um novo e regrava o persist", async () => {
    const before = readPersistedPreview(persistPath, "newsletter_url");
    assert.ok(before);
    const stop = runCli(["--stop-pid", String(before.pid)]);
    assert.equal(stop.status, 0, stop.stderr);
    await waitDead(before.pid);

    const r = runCli(["--file", htmlPath, "--watch", "--ensure", "--persist-to", persistPath, "--field", "newsletter_url"]);
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    spawned.push(json.pid);
    assert.equal(json.reused, false);
    assert.notEqual(json.pid, before.pid);
    const res = await fetch(json.url);
    assert.equal(res.status, 200);
    assert.equal(readPersistedPreview(persistPath, "newsletter_url")?.pid, json.pid);
  });

  it("--ensure sem --persist-to é erro de uso (exit 2)", () => {
    const r = runCli(["--file", htmlPath, "--ensure"]);
    assert.equal(r.status, 2);
  });
});

describe("pruneOldDetachedLogs (self-review #4 do PR #9685)", () => {
  it("remove só logs diaria-serve-preview-*.log mais velhos que o limite", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-logs-"));
    try {
      const old = join(dir, "diaria-serve-preview-1-1.log");
      const fresh = join(dir, "diaria-serve-preview-2-2.log");
      const otherOld = join(dir, "outro.log");
      for (const f of [old, fresh, otherOld]) writeFileSync(f, "x");
      const tenDaysAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
      utimesSync(old, tenDaysAgo, tenDaysAgo);
      utimesSync(otherOld, tenDaysAgo, tenDaysAgo);
      assert.equal(pruneOldDetachedLogs(dir), 1);
      assert.equal(existsSync(old), false);
      assert.equal(existsSync(fresh), true);
      assert.equal(existsSync(otherOld), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diretório inexistente é fail-soft (0, sem lançar)", () => {
    assert.equal(pruneOldDetachedLogs(join(tmpdir(), "nao-existe-prune-9685")), 0);
  });
});
