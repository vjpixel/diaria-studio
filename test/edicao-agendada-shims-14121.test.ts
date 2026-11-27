/**
 * test/edicao-agendada-shims-14121.test.ts (#14121)
 *
 * O runner da edição agendada saiu de `scripts/overnight/` para
 * `scripts/edicao-agendada/`. Units systemd, a task do Windows e textos
 * antigos citam os caminhos velhos, então cada um deles virou shim que só
 * chama o arquivo novo. Este teste prova que:
 *   1. todo `scripts/overnight/*` citado em qualquer arquivo versionado
 *      (registro de tasks, units geradas, skills, agents, docs) existe;
 *   2. os shims `.ts` re-exportam o módulo novo (mesmas funções, por
 *      identidade) e, rodados como script, executam o mesmo CLI;
 *   3. os shims `.ps1` apontam para um alvo que existe e repassam
 *      argumentos e exit code (comportamental só onde há PowerShell);
 *   4. units geradas a partir de agora apontam para o caminho novo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import { buildEdicaoSystemdUnitFiles } from "../scripts/lib/edicao-systemd-units.ts";
import { EXIT_WORKSPACE_UNTRUSTED } from "../scripts/lib/claude-workspace-trust.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OLD_DIR = join(ROOT, "scripts", "overnight");
const NEW_DIR = join(ROOT, "scripts", "edicao-agendada");

/** Arquivos que saíram de scripts/overnight/ no #14121 (todos viraram shim). */
const MOVED = [
  "run-scheduled-edicao.ts",
  "run-scheduled-edicao.ps1",
  "setup-edicao-schedule.ps1",
  "setup-edicao-schedule-systemd.ts",
  "arm-edicao-schedule-systemd.ts",
  "calc-next-edition-date.ts",
] as const;

/** Citações históricas de arquivos removidos ANTES do #14121 (não são do rename). */
const HISTORICAL_REMOVED = new Set([
  "scripts/overnight/setup-watchdog-schedule.ps1", // removido no #5115
  "scripts/overnight/run-resume-social-260827.ps1", // one-off de 260827, nunca versionado
]);

function trackedTextFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\0")
    .filter((p) => p && /\.(ts|mts|mjs|js|json|md|sh|ps1|ya?ml|txt|py|example)$|^CLAUDE\.md$|^\.env\.example$/.test(p));
}

describe("#14121 — caminhos antigos de scripts/overnight/ continuam resolvendo", () => {
  it("os arquivos movidos existem no diretório novo e como shim no antigo", () => {
    for (const f of MOVED) {
      assert.ok(existsSync(join(NEW_DIR, f)), `falta scripts/edicao-agendada/${f}`);
      assert.ok(existsSync(join(OLD_DIR, f)), `falta o shim scripts/overnight/${f}`);
    }
  });

  it("todo scripts/overnight/* citado num arquivo versionado existe (registro, units, skills, agents, docs)", () => {
    const missing: string[] = [];
    // `/` e `\` (forma Windows, ex.: `.\scripts\overnight\setup-edicao-schedule.ps1`).
    const re = /scripts[\\/]overnight[\\/][A-Za-z0-9_.-]+\.(?:ts|ps1|sh)/g;
    for (const rel of trackedTextFiles()) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, rel), "utf8");
      } catch {
        continue;
      }
      for (const m of text.matchAll(re)) {
        const cited = m[0].replace(/\\/g, "/");
        if (HISTORICAL_REMOVED.has(cited)) continue;
        if (!existsSync(join(ROOT, cited))) missing.push(`${m[0]} (citado em ${rel})`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it("todo script do registro SCHEDULED_TASKS sob scripts/overnight|edicao-agendada existe", () => {
    const scripts = SCHEDULED_TASKS.flatMap((t) => t.steps.map((s) => s.script)).filter((s) =>
      /^scripts\/(overnight|edicao-agendada)\//.test(s),
    );
    assert.ok(scripts.length > 0, "esperava ao menos a Diaria-Nightly-Chain");
    for (const s of scripts) assert.ok(existsSync(join(ROOT, s)), `script do registro ausente: ${s}`);
  });

  it("unit gerada aponta para o caminho novo, e o arquivo existe", () => {
    const { serviceContent } = buildEdicaoSystemdUnitFiles(ROOT.replace(/\\/g, "/"), process.execPath);
    const m = serviceContent.match(/--import tsx (\S+run-scheduled-edicao\.ts)$/m);
    assert.ok(m, "ExecStart sem run-scheduled-edicao.ts");
    assert.match(m![1], /\/scripts\/edicao-agendada\/run-scheduled-edicao\.ts$/);
    assert.ok(existsSync(m![1]), `ExecStart aponta para arquivo inexistente: ${m![1]}`);
  });
});

describe("#14121 — shims .ts re-exportam o módulo novo e rodam o mesmo CLI", () => {
  for (const f of ["run-scheduled-edicao.ts", "setup-edicao-schedule-systemd.ts", "arm-edicao-schedule-systemd.ts"]) {
    it(`${f}: mesmas exportações, por identidade, mais o runCli`, async () => {
      const oldMod = await import(pathToFileURL(join(OLD_DIR, f)).href);
      const newMod = await import(pathToFileURL(join(NEW_DIR, f)).href);
      assert.deepEqual(Object.keys(oldMod).sort(), Object.keys(newMod).sort());
      for (const k of Object.keys(newMod)) assert.equal(oldMod[k], newMod[k], `exportação ${k} diverge`);
      assert.equal(typeof newMod.runCli, "function");
      // Rodado como script, o shim chama o runCli do módulo novo.
      const src = readFileSync(join(OLD_DIR, f), "utf8");
      assert.match(src, /if \(isMainModule\(import\.meta\.url\)\) runCli\(\);/);
      assert.match(src, new RegExp(`from "\\.\\./edicao-agendada/${f.replace(".", "\\.")}"`));
    });
  }

  it("run-scheduled-edicao: o caminho antigo roda o mesmo CLI, com a raiz do repo vinda do arquivo novo", () => {
    // Cópia de scripts/ dentro de node_modules/.cache (resolve os pacotes pelo
    // node_modules da raiz sem symlink, e é gitignored). A raiz do repo da
    // cópia é a própria cópia, então o `data/` do runner é o da cópia, nunca o
    // real. HOME/CLAUDE_CONFIG_DIR vazios = workspace sem confiança: o runner
    // sai no preflight (#11383) antes de resolver ou chamar o `claude`.
    const cacheDir = join(ROOT, "node_modules", ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const copy = mkdtempSync(join(cacheDir, "shim-spawn-14121-"));
    try {
      cpSync(join(ROOT, "scripts"), join(copy, "scripts"), { recursive: true });
      for (const f of ["package.json", "tsconfig.json", "platform.config.json"]) cpSync(join(ROOT, f), join(copy, f));
      const home = join(copy, "home");
      mkdirSync(home);
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: home,
        CLAUDE_BIN: join(copy, "claude-inexistente"),
      };
      const run = (rel: string) =>
        spawnSync(process.execPath, ["--import", "tsx", join(copy, rel)], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
      const viaOld = run("scripts/overnight/run-scheduled-edicao.ts");
      const viaNew = run("scripts/edicao-agendada/run-scheduled-edicao.ts");
      assert.equal(viaNew.status, EXIT_WORKSPACE_UNTRUSTED, viaNew.stderr);
      assert.equal(viaOld.status, viaNew.status, viaOld.stderr);
      const norm = (s: string) =>
        s
          .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "TS")
          .replace(/pid=\d+/g, "pid=N");
      assert.equal(norm(viaOld.stderr), norm(viaNew.stderr));
      assert.equal(viaOld.stdout, viaNew.stdout);
      // A raiz usada é a da cópia (resolvida pelo arquivo novo). A cópia não
      // tem data/, e o runner não cria: nada é gravado em lugar nenhum.
      assert.ok(viaOld.stderr.includes(copy), "o runner não usou a raiz da cópia");
      assert.match(viaOld.stderr, /data\/ não encontrado/);
      assert.ok(!existsSync(join(copy, "data")), "o runner criou data/ na cópia");
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it("calc-next-edition-date: o caminho antigo imprime o mesmo AAMMDD do novo", () => {
    const run = (p: string) =>
      execFileSync(process.execPath, ["--import", "tsx", p], { cwd: ROOT, encoding: "utf8" });
    const viaOld = run(join(OLD_DIR, "calc-next-edition-date.ts"));
    const viaNew = run(join(NEW_DIR, "calc-next-edition-date.ts"));
    assert.match(viaOld, /^\d{6}$/);
    assert.equal(viaOld, viaNew);
  });

  it("arm-edicao-schedule-systemd: o caminho antigo roda o CLI (sem ação = uso + exit 2, nunca systemctl)", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", join(OLD_DIR, "arm-edicao-schedule-systemd.ts")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Uso: arm-edicao-schedule-systemd\.ts --arm \| --disarm/);
  });

  it("setup-edicao-schedule-systemd: o caminho antigo gera os units, com ExecStart no caminho novo", () => {
    const out = mkdtempSync(join(tmpdir(), "edicao-shim-14121-"));
    try {
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", join(OLD_DIR, "setup-edicao-schedule-systemd.ts"), "--out-dir", out, "--node-bin", process.execPath],
        { cwd: ROOT, encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const service = readFileSync(join(out, "diaria-edicao-diaria.service"), "utf8");
      assert.match(service, /\/scripts\/edicao-agendada\/run-scheduled-edicao\.ts$/m);
      assert.match(r.stdout, /scripts\/edicao-agendada\/arm-edicao-schedule-systemd\.ts --arm/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("#14121 — shims .ps1", () => {
  for (const f of ["run-scheduled-edicao.ps1", "setup-edicao-schedule.ps1"]) {
    it(`${f}: ASCII puro e aponta para o alvo que existe em scripts/edicao-agendada/`, () => {
      const buf = readFileSync(join(OLD_DIR, f));
      assert.ok(buf.every((b) => b < 0x80), "shim .ps1 deve ser ASCII puro (PS 5.1 sem BOM, #2825)");
      const m = buf.toString("utf8").match(/"\.\.\\edicao-agendada\\([^"]+)"/);
      assert.ok(m, "shim sem o caminho relativo do alvo");
      assert.equal(m![1], f);
      assert.ok(existsSync(join(NEW_DIR, m![1])));
    });
  }

  const ps = ["powershell", "pwsh"].find((bin) => {
    const r = spawnSync(bin, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" });
    return !r.error && r.status === 0;
  });

  it("repassam argumentos e exit code ao alvo (com alvo falso)", { skip: ps ? false : "sem PowerShell nesta máquina" }, () => {
    const tmp = mkdtempSync(join(tmpdir(), "ps1-shim-14121-"));
    try {
      mkdirSync(join(tmp, "overnight"));
      mkdirSync(join(tmp, "edicao-agendada"));
      for (const f of readdirSync(OLD_DIR).filter((n) => n.endsWith(".ps1"))) {
        copyFileSync(join(OLD_DIR, f), join(tmp, "overnight", f));
      }
      writeFileSync(join(tmp, "edicao-agendada", "run-scheduled-edicao.ps1"), 'Write-Output ("ARGS=" + ($args -join ","))\nexit 7\n');
      writeFileSync(
        join(tmp, "edicao-agendada", "setup-edicao-schedule.ps1"),
        'param([switch]$Unregister)\nWrite-Output ("UNREGISTER=" + $Unregister)\n',
      );
      const run = (f: string, args: string[]) =>
        spawnSync(ps!, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(tmp, "overnight", f), ...args], {
          encoding: "utf8",
        });
      const a = run("run-scheduled-edicao.ps1", ["x", "y"]);
      assert.equal(a.status, 7, a.stderr);
      assert.match(a.stdout, /ARGS=x,y/);
      const b = run("setup-edicao-schedule.ps1", ["-Unregister"]);
      assert.equal(b.status, 0, b.stderr);
      assert.match(b.stdout, /UNREGISTER=True/);
      const c = run("setup-edicao-schedule.ps1", []);
      assert.equal(c.status, 0, c.stderr);
      assert.match(c.stdout, /UNREGISTER=False/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
