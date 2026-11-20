/**
 * test/gdrive-bisync-signal-restore-13724.test.ts (#13724)
 *
 * Regressão: o `--resync` de `scripts/systemd/gdrive-bisync.sh` guarda o par
 * instalado (filtro + `.md5`) em `.prev` e só o devolvia no fim do script
 * (#13688). Se o systemd matasse o script no meio do rclone (stop timeout,
 * SIGTERM, reboot), o restore nunca rodava e o filtro novo ficava instalado
 * sem o estado do bisync que o acompanha. Agora um trap em TERM/INT/HUP/EXIT
 * chama o restore enquanto o par anterior estiver guardado.
 *
 * Roda o script real com um `rclone` falso que grava o `.md5` como o bisync
 * faria, avisa que começou e fica dormindo até receber o sinal. Nunca toca o
 * remote real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "systemd", "gdrive-bisync.sh");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runAndSignal(opts: {
  /** Quanto o rclone falso dorme depois de começar (segundos). */
  rcloneSleep: number;
  /** Exit do rclone falso se ele não for morto. */
  rcloneExit: number;
  /** "group" = o cgroup inteiro (como o systemd); "shell" = só o script. */
  target: "group" | "shell";
  args: string[];
}) {
  const sb = mkdtempSync(join(tmpdir(), "gdrive-bisync-13724-"));
  const local = join(sb, "GoogleDrive");
  mkdirSync(local);
  writeFileSync(join(local, ".diaria-bisync-sentinel"), "");
  const stateDir = join(sb, "state");
  mkdirSync(stateDir);
  const installed = join(stateDir, "filters.txt");
  writeFileSync(installed, "- velho\n");
  writeFileSync(`${installed}.md5`, "md5-de-- velho\n");
  // Exit 0 de uma rodada anterior: não pode passar por sucesso do resync.
  writeFileSync(join(stateDir, "last-rclone.rc"), "0\n");
  const src = join(sb, "checkout-filters.txt");
  writeFileSync(src, "- novo\n");
  const started = join(sb, "rclone.started");
  const fakeRclone = join(sb, "rclone");
  writeFileSync(
    fakeRclone,
    `#!/bin/sh
ff=""; prev=""
for a in "$@"; do
  [ "$prev" = "--filters-file" ] && ff="$a"
  prev="$a"
done
[ -n "$ff" ] && printf 'md5-de-%s\\n' "$(cat "$ff")" > "$ff.md5"
: > "${started}"
sleep ${opts.rcloneSleep}
exit ${opts.rcloneExit}
`,
  );
  chmodSync(fakeRclone, 0o755);
  const child = spawn("/bin/sh", [SCRIPT, ...opts.args], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sb,
      GDRIVE_MOUNT: sb,
      GDRIVE_LOCAL: local,
      RCLONE_BIN: fakeRclone,
      GDRIVE_MOUNTPOINT_CMD: "true",
      GDRIVE_STATE_DIR: stateDir,
      GDRIVE_FILTERS: src,
      GDRIVE_AUTH_RETRY_DELAY: "0",
    },
  });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  // Depois do restore o script morre pelo próprio SIGTERM (parada limpa pro
  // systemd), então o resultado esperado é o sinal, não um exit code.
  const exited = new Promise<string>((resolve) => child.on("close", (code, signal) => resolve(signal ?? `exit ${code}`)));
  for (let i = 0; i < 250 && !existsSync(started); i++) await sleep(20);
  assert.equal(existsSync(started), true, "rclone falso não começou");
  // Com o rclone já rodando, o filtro novo está instalado: é a janela do bug.
  assert.equal(readFileSync(installed, "utf8"), opts.args.includes("--resync") ? "- novo\n" : "- velho\n");
  process.kill(opts.target === "group" ? -child.pid! : child.pid!, "SIGTERM");
  const status = await exited;
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const out = {
    status,
    stderr,
    installed: read(installed),
    md5: read(`${installed}.md5`),
    prevLeft: existsSync(`${installed}.prev`) || existsSync(`${installed}.md5.prev`),
  };
  rmSync(sb, { recursive: true, force: true });
  return out;
}

describe("gdrive-bisync.sh — SIGTERM no meio do --resync devolve o filtro anterior (#13724)", { skip: process.platform === "win32" ? "script POSIX-only" : false }, () => {
  it("SIGTERM no cgroup inteiro (rclone morre junto) → filtro e .md5 antigos de volta, morre por SIGTERM", async () => {
    const r = await runAndSignal({ rcloneSleep: 30, rcloneExit: 0, target: "group", args: ["--resync"] });
    assert.equal(r.status, "SIGTERM", r.stderr);
    assert.equal(r.installed, "- velho\n");
    assert.equal(r.md5, "md5-de-- velho\n");
    assert.equal(r.prevLeft, false);
    assert.match(r.stderr, /filtro anterior restaurado/);
  });

  it("SIGTERM só no script, rclone termina o resync com 0 → filtro novo fica, sem .prev", async () => {
    const r = await runAndSignal({ rcloneSleep: 2, rcloneExit: 0, target: "shell", args: ["--resync"] });
    assert.equal(r.status, "SIGTERM", r.stderr);
    assert.equal(r.installed, "- novo\n");
    assert.equal(r.md5, "md5-de-- novo\n");
    assert.equal(r.prevLeft, false);
    assert.doesNotMatch(r.stderr, /restaurado/);
  });

  it("SIGTERM só no script, rclone termina o resync com 1 → filtro antigo de volta", async () => {
    const r = await runAndSignal({ rcloneSleep: 2, rcloneExit: 1, target: "shell", args: ["--resync"] });
    assert.equal(r.status, "SIGTERM", r.stderr);
    assert.equal(r.installed, "- velho\n");
    assert.equal(r.md5, "md5-de-- velho\n");
    assert.equal(r.prevLeft, false);
  });

  it("SIGTERM numa rodada sem --resync → filtro instalado intocado, sem restore", async () => {
    const r = await runAndSignal({ rcloneSleep: 30, rcloneExit: 0, target: "group", args: [] });
    assert.equal(r.status, "SIGTERM", r.stderr);
    assert.equal(r.installed, "- velho\n");
    assert.equal(r.prevLeft, false);
    assert.doesNotMatch(r.stderr, /restaurado/);
  });
});
