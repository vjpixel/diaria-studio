/**
 * test/gdrive-bisync-auth-retry-12412.test.ts (#12412)
 *
 * Regressão do abort do bisync por 401 na renovação do token OAuth: quando a
 * listagem do Drive passa de 1h, listagens concorrentes levam
 * `Error 401: Invalid Credentials, authError`, o rclone sai 7 ("Must run
 * --resync to recover") e o sync ficava parado até um resync manual.
 *
 * O wrapper `scripts/systemd/gdrive-bisync.sh` agora retenta com resync
 * automático SÓ nesse caso (exit 7 + 401/authError no log), com teto de
 * tentativas, `--check-access` e o filtro instalado (o `--max-delete` segue
 * na linha de comando, mas não protege num resync, #12444). Roda o script
 * real com um `rclone` falso que devolve uma
 * sequência de exits programada; nunca toca o remote real.
 *
 * Também trava o filtro global de `node_modules/` (frente 2 da issue).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "systemd", "gdrive-bisync.sh");
const AUTH_LINE =
  "ERROR : Work/x/node_modules/y: error reading source directory: googleapi: Error 401: Invalid Credentials, authError";

/**
 * `seq`: um item por chamada do rclone, `"{exit}"` ou `"{exit}:auth"` (imprime
 * a linha de 401 antes de sair). Chamada além da sequência sai 0.
 */
function run(opts: {
  seq: string[];
  args?: string[];
  env?: Record<string, string>;
  installed?: string;
  srcFilters?: string;
}) {
  const sb = mkdtempSync(join(tmpdir(), "gdrive-bisync-12412-"));
  const local = join(sb, "GoogleDrive");
  mkdirSync(local);
  writeFileSync(join(local, ".diaria-bisync-sentinel"), "");
  const stateDir = join(sb, "state");
  if (opts.installed !== undefined) {
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "filters.txt"), opts.installed);
  }
  let srcFiltersPath: string | undefined;
  if (opts.srcFilters !== undefined) {
    srcFiltersPath = join(sb, "checkout-filters.txt");
    writeFileSync(srcFiltersPath, opts.srcFilters);
  }
  const calls = join(sb, "calls.log");
  const counter = join(sb, "counter");
  const fakeRclone = join(sb, "rclone");
  writeFileSync(
    fakeRclone,
    [
      "#!/bin/sh",
      `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
      "n=$((n + 1))",
      `echo "$n" > "${counter}"`,
      `echo "$@" >> "${calls}"`,
      `spec=$(echo "${opts.seq.join(",")}" | cut -d, -f"$n")`,
      '[ -n "$spec" ] || spec=0',
      'case "$spec" in *:auth) echo "' + AUTH_LINE + '" >&2 ;; esac',
      'exit "${spec%%:*}"',
      "",
    ].join("\n"),
  );
  chmodSync(fakeRclone, 0o755);
  const r = spawnSync("/bin/sh", [SCRIPT, ...(opts.args ?? [])], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sb,
      GDRIVE_MOUNT: sb,
      GDRIVE_LOCAL: local,
      RCLONE_BIN: fakeRclone,
      GDRIVE_MOUNTPOINT_CMD: "true",
      GDRIVE_STATE_DIR: stateDir,
      GDRIVE_AUTH_RETRY_DELAY: "0",
      ...(srcFiltersPath ? { GDRIVE_FILTERS: srcFiltersPath } : {}),
      ...(opts.env ?? {}),
    },
  });
  const callLines = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
  const readJson = (f: string) => (existsSync(join(stateDir, f)) ? JSON.parse(readFileSync(join(stateDir, f), "utf8")) : null);
  const installedPath = join(stateDir, "filters.txt");
  const out = {
    status: r.status,
    stderr: r.stderr,
    stdout: r.stdout,
    calls: callLines,
    lastRun: readJson("last-run.json"),
    lastSuccess: readJson("last-success.json"),
    installed: existsSync(installedPath) ? readFileSync(installedPath, "utf8") : null,
  };
  rmSync(sb, { recursive: true, force: true });
  return out;
}

describe("gdrive-bisync.sh — resync automático em 401/authError (#12412)", { skip: process.platform === "win32" ? "script POSIX-only" : false }, () => {
  it("exit 7 com 401 no log → 1 resync automático com as mesmas travas; sucesso carimba", () => {
    const r = run({ seq: ["7:auth", "0"] });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 2);
    assert.doesNotMatch(r.calls[0], /--resync/);
    const retry = r.calls[1];
    assert.match(retry, /--resync --resync-mode newer$/);
    assert.match(retry, /--check-access --check-filename \.diaria-bisync-sentinel/);
    assert.match(retry, /--max-delete 5 /);
    assert.match(retry, /--filters-file \S+\/state\/filters\.txt/);
    assert.match(r.stderr, /resync automatico 1\/1/);
    assert.match(r.stdout, /Error 401/, "saída do rclone continua no journal");
    assert.deepEqual(r.lastRun?.exit, 0);
    assert.ok(r.lastSuccess);
  });

  it("exit 7 sem erro de autenticação (ex.: too many deletes) → nenhum retry", () => {
    const r = run({ seq: ["7", "0"] });
    assert.equal(r.status, 7);
    assert.equal(r.calls.length, 1);
    assert.doesNotMatch(r.stderr, /resync automatico/);
    assert.equal(r.lastRun?.exit, 7);
    assert.equal(r.lastSuccess, null);
  });

  it("401 com exit diferente de 7 → nenhum retry", () => {
    const r = run({ seq: ["1:auth", "0"] });
    assert.equal(r.status, 1);
    assert.equal(r.calls.length, 1);
  });

  it("teto padrão é 1: 401 de novo no resync → para, sai 7 e manda resync manual", () => {
    const r = run({ seq: ["7:auth", "7:auth", "0"] });
    assert.equal(r.status, 7);
    assert.equal(r.calls.length, 2);
    assert.match(r.stderr, /se esgotaram — rode --resync a mao/);
    assert.equal(r.lastRun?.exit, 7);
  });

  it("GDRIVE_AUTH_RETRY_MAX=2 → até 2 resyncs", () => {
    const r = run({ seq: ["7:auth", "7:auth", "0"], env: { GDRIVE_AUTH_RETRY_MAX: "2" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 3);
    assert.match(r.stderr, /resync automatico 2\/2/);
  });

  it("GDRIVE_AUTH_RETRY_MAX=0 desliga o retry", () => {
    const r = run({ seq: ["7:auth", "0"], env: { GDRIVE_AUTH_RETRY_MAX: "0" } });
    assert.equal(r.status, 7);
    assert.equal(r.calls.length, 1);
  });

  it("GDRIVE_AUTH_RETRY_MAX não numérico cai no default 1 (o teto nunca some)", () => {
    const r = run({ seq: ["7:auth", "7:auth", "7:auth", "0"], env: { GDRIVE_AUTH_RETRY_MAX: "abc" } });
    assert.equal(r.status, 7);
    assert.equal(r.calls.length, 2);
  });

  it("--dry-run nunca retenta", () => {
    const r = run({ seq: ["7:auth", "0"], args: ["--dry-run"] });
    assert.equal(r.status, 7);
    assert.equal(r.calls.length, 1);
    assert.equal(r.lastRun, null);
  });

  it("rodada que já era --resync retenta com os mesmos argumentos, sem duplicar --resync", () => {
    const r = run({ seq: ["7:auth", "0"], args: ["--resync"] });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls[1], r.calls[0]);
    assert.doesNotMatch(r.calls[1], /--resync-mode/);
  });

  it("resync automático usa o filtro INSTALADO, nunca adota o do checkout (#12396)", () => {
    const r = run({ seq: ["7:auth", "0"], installed: "- velho\n", srcFilters: "- novo\n" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 2);
    assert.equal(r.installed, "- velho\n");
    assert.match(r.calls[1], /--filters-file \S+\/state\/filters\.txt/);
  });

  // #12444: resync não apaga, só une os dois lados — arquivo apagado durante a
  // rodada pode voltar. Cada resync automático termina com esse aviso.
  const RESURRECT_WARNING = /aviso — o resync automatico une os dois lados e nao apaga nada: arquivo apagado em um lado durante a rodada pode ter voltado do outro \(#12444\)/g;

  it("cada resync automático termina com o aviso de arquivo ressuscitado (#12444)", () => {
    const one = run({ seq: ["7:auth", "0"] });
    assert.equal(one.status, 0, one.stderr);
    assert.equal(one.stderr.match(RESURRECT_WARNING)?.length, 1);
    assert.ok(
      one.stderr.indexOf("terminou com exit 0") < one.stderr.search(RESURRECT_WARNING),
      "o aviso vem depois do resultado do resync",
    );

    const two = run({ seq: ["7:auth", "7:auth", "0"], env: { GDRIVE_AUTH_RETRY_MAX: "2" } });
    assert.equal(two.status, 0, two.stderr);
    assert.equal(two.stderr.match(RESURRECT_WARNING)?.length, 2);

    const failed = run({ seq: ["7:auth", "1"] });
    assert.equal(failed.status, 1);
    assert.equal(failed.stderr.match(RESURRECT_WARNING)?.length, 1, "resync que falhou também pode ter copiado antes de falhar");
  });

  it("sem resync automático, nenhum aviso de arquivo ressuscitado (#12444)", () => {
    for (const r of [run({ seq: ["0"] }), run({ seq: ["7", "0"] }), run({ seq: ["7:auth", "0"], args: ["--dry-run"] })]) {
      assert.doesNotMatch(r.stderr, RESURRECT_WARNING);
    }
  });
});

describe("documentação do resync automático (#12444)", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const registry = readFileSync(join(ROOT, "docs", "scheduled-tasks-registry.md"), "utf8");
  const block = registry.split("\n").find((l) => l.startsWith("**`diaria-gdrive-bisync`")) ?? "";

  it("o script não chama mais o --max-delete de trava do resync", () => {
    assert.doesNotMatch(script, /MESMAS travas/);
    assert.doesNotMatch(script, /mesmas travas/);
    assert.match(script, /resync não apaga/);
  });

  it("o registry diz que a exclusão de node_modules depende de um --resync manual com o timer parado", () => {
    assert.ok(block, "bloco diaria-gdrive-bisync no registry");
    assert.match(block, /node_modules[^*]*\*\*Essa exclusão só vale depois de `sh scripts\/systemd\/gdrive-bisync\.sh --resync` rodado uma vez no `300`, com o timer parado/);
  });

  it("o registry registra o trade-off do resync automático e não lista --max-delete como trava dele", () => {
    assert.match(block, /Trade-off do resync automático \(#12444\)/);
    assert.doesNotMatch(block, /mesmas travas \(`--check-access`, `--max-delete`/);
  });
});

describe("filtro global de node_modules (#12412)", () => {
  const f = readFileSync(join(ROOT, "scripts", "systemd", "gdrive-bisync-filters.txt"), "utf8");
  const rules = f.split("\n").filter((l) => /^[-+] /.test(l));

  it("exclui node_modules/ em qualquer profundidade, como diretório (/**)", () => {
    assert.ok(rules.includes("- node_modules/**"));
  });

  it("node_modules é global, antes do bloco gerado de data/", () => {
    assert.ok(f.indexOf("- node_modules/**") < f.indexOf("# BEGIN data-local-only"));
  });

  it("não exclui .git (decisão do editor: só node_modules)", () => {
    for (const r of rules) assert.doesNotMatch(r, /\.git/);
  });
});
