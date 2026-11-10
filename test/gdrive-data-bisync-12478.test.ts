/**
 * test/gdrive-data-bisync-12478.test.ts (#12478, épica #12353)
 *
 * Bisync DEDICADO de `data/` no `300` (`diaria-gdrive-data-bisync.{service,timer}`
 * + `scripts/systemd/gdrive-data-bisync.sh`). O bisync do Drive inteiro leva
 * ~34 min por rodada; o de `data/` roda o MESMO `gdrive-bisync.sh` com remote,
 * pasta local, filtro, state dir e workdir do rclone próprios. Trava aqui:
 *
 *   1. Regressão do bisync GRANDE (ele roda ao vivo a partir deste checkout):
 *      com os defaults, a invocação do rclone, o filtro instalado e os
 *      carimbos são exatamente os de antes da #12478 — e nenhuma variável
 *      `GDRIVE_DATA_*` vaza para ele.
 *   2. O wrapper de `data/`: defaults (`gdrive-diaria:diaria-studio-data` ↔
 *      `/mnt/hd-sata/GoogleDrive-diaria/diaria-studio-data`), trava de
 *      sobreposição com o espelho do Drive inteiro (exit 78), override pelo arquivo
 *      `~/.config/diaria/gdrive-data-bisync.env` (só chaves conhecidas, nunca
 *      executado como shell) e pelo ambiente, estado separado, retry de 401.
 *   3. As units: mesmo padrão das do bisync grande, apontando para o wrapper.
 *
 * Roda os scripts reais com um `rclone` falso que só grava a invocação.
 * Nunca toca o remote real nem o HD.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateGdriveSync,
  describeGdriveSyncVerdict,
  DATA_GDRIVE_SYNC_TOLERANCES,
  DEFAULT_GDRIVE_SYNC_TOLERANCES,
  FULL_DRIVE_BISYNC_TARGET,
  DATA_BISYNC_TARGET,
  dataBisyncTarget,
} from "../scripts/lib/gdrive-sync-alarm.ts";
import {
  parseDataBisyncEnvFile,
  resolveDataBisyncConfig,
  DATA_BISYNC_ENV_KEYS,
  DEFAULT_DATA_BISYNC_REMOTE,
  DEFAULT_DATA_BISYNC_MOUNT,
  DEFAULT_DATA_BISYNC_LOCAL_REL,
} from "../scripts/lib/gdrive-data-bisync-config.ts";
import { readBisyncStamp } from "../scripts/gdrive-sync-alarm.ts";
import { evaluateGdriveQuota } from "../scripts/lib/gdrive-quota.ts";

/** Ambiente do CLI do alarme sem nenhuma GDRIVE_* da máquina e com um arquivo
 * de env de TESTE (nunca o ~/.config real). */
function cliEnv(sb: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GDRIVE_")) env[k] = v;
  const envFile = join(sb, "teste-gdrive-data-bisync.env");
  if (!existsSync(envFile)) writeFileSync(envFile, "");
  env.GDRIVE_DATA_ENV_FILE = envFile;
  return { ...env, ...extra };
}
import {
  toSyncAlarmFinding,
  toDataSyncAlarmFinding,
  absenceUnmeasured,
  buildGdriveAlarmEmail,
  defaultGdriveDataStateDir,
  collectGdriveAlarmFindings,
  dataDirDependsOnDataBisync,
  DATA_SYNC_CHECK,
  DATA_QUOTA_CHECK,
  DATA_CONFIG_CHECK,
  DATA_BISYNC_MISSING,
  SYNC_CHECK,
} from "../scripts/gdrive-sync-alarm.ts";
import { alarmIssueStateKey, type AlarmFindingOutcome } from "../scripts/lib/alarm-issues.ts";
import type { GdriveQuotaEvaluation } from "../scripts/lib/gdrive-quota.ts";

const ROOT = join(import.meta.dirname, "..");
const SYSTEMD = join(ROOT, "scripts", "systemd");
const BIG_SCRIPT = join(SYSTEMD, "gdrive-bisync.sh");
const DATA_SCRIPT = join(SYSTEMD, "gdrive-data-bisync.sh");
const BIG_FILTERS = join(SYSTEMD, "gdrive-bisync-filters.txt");
const DATA_FILTERS = join(SYSTEMD, "gdrive-data-bisync-filters.txt");
const AUTH_LINE = "ERROR : x: error reading source directory: googleapi: Error 401: Invalid Credentials, authError";

/** Flags fixas do `run_bisync` antes da #12478, na ordem (o bisync grande tem
 * que continuar recebendo exatamente isto). */
const FIXED_FLAGS_BEFORE_12478 =
  "--check-access --check-filename .diaria-bisync-sentinel --max-delete 5 --filters-file {FILTERS} --ignore-case " +
  "--drive-skip-gdocs --drive-skip-dangling-shortcuts --create-empty-src-dirs --resilient --recover --max-lock 15m " +
  "--conflict-resolve newer --conflict-loser num --log-level NOTICE";

interface RunResult {
  status: number | null;
  stderr: string;
  calls: string[];
  sb: string;
  exists: (rel: string) => boolean;
  read: (rel: string) => string | null;
}

/**
 * Roda `script` num sandbox com HOME próprio. `seq`: um item por chamada do
 * rclone, `"{exit}"` ou `"{exit}:auth"` (imprime a linha de 401 antes).
 * `localRel`: pasta local (relativa ao sandbox) onde nasce a sentinela.
 */
function run(
  script: string,
  opts: { env?: Record<string, string>; args?: string[]; seq?: string[]; localRel: string; envFile?: string },
): RunResult {
  const sb = mkdtempSync(join(tmpdir(), "gdrive-data-bisync-12478-"));
  const local = join(sb, opts.localRel);
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, ".diaria-bisync-sentinel"), "");
  if (opts.envFile !== undefined) {
    mkdirSync(join(sb, ".config", "diaria"), { recursive: true });
    writeFileSync(join(sb, ".config", "diaria", "gdrive-data-bisync.env"), opts.envFile.replaceAll("{SB}", sb));
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
      `spec=$(echo "${(opts.seq ?? []).join(",")}" | cut -d, -f"$n")`,
      '[ -n "$spec" ] || spec=0',
      'case "$spec" in *:auth) echo "' + AUTH_LINE + '" >&2 ;; esac',
      'exit "${spec%%:*}"',
      "",
    ].join("\n"),
  );
  chmodSync(fakeRclone, 0o755);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: sb,
    RCLONE_BIN: fakeRclone,
    GDRIVE_MOUNTPOINT_CMD: "true",
    GDRIVE_AUTH_RETRY_DELAY: "0",
    // O wrapper de data/ ignora as duas de cima (isolamento, #12478) e lê estas.
    GDRIVE_DATA_MOUNTPOINT_CMD: "true",
    GDRIVE_DATA_AUTH_RETRY_DELAY: "0",
  };
  for (const [k, v] of Object.entries(opts.env ?? {})) env[k] = v.replaceAll("{SB}", sb);
  const r = spawnSync("/bin/sh", [script, ...(opts.args ?? [])], { encoding: "utf8", env });
  const callLines = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
  return {
    status: r.status,
    stderr: r.stderr,
    calls: callLines,
    sb,
    exists: (rel) => existsSync(join(sb, rel)),
    read: (rel) => (existsSync(join(sb, rel)) ? readFileSync(join(sb, rel), "utf8") : null),
  };
}

const posixOnly = { skip: process.platform === "win32" ? "script POSIX-only" : false };

describe("bisync do Drive inteiro: invocação idêntica à de antes da #12478", posixOnly, () => {
  it("defaults → mesma linha do rclone, mesmo filtro instalado, mesmos carimbos, sem --workdir", () => {
    // Só GDRIVE_MOUNT muda (a sentinela não pode viver em /mnt/hd-sata no
    // teste); LOCAL, REMOTE, filtro e state dir vêm dos defaults do script.
    const r = run(BIG_SCRIPT, { env: { GDRIVE_MOUNT: "{SB}" }, localRel: "GoogleDrive" });
    try {
      assert.equal(r.status, 0, r.stderr);
      const filters = join(r.sb, ".cache", "diaria", "gdrive-bisync", "filters.txt");
      assert.deepEqual(r.calls, [
        `bisync gdrive: ${join(r.sb, "GoogleDrive")} ${FIXED_FLAGS_BEFORE_12478.replace("{FILTERS}", filters)}`,
      ]);
      assert.equal(r.read(".cache/diaria/gdrive-bisync/filters.txt"), readFileSync(BIG_FILTERS, "utf8"));
      assert.ok(r.exists(".cache/diaria/gdrive-bisync/last-run.json"));
      assert.ok(r.exists(".cache/diaria/gdrive-bisync/last-success.json"));
      assert.ok(r.exists(".cache/diaria/gdrive-bisync/last-rclone.log"));
      assert.equal(r.exists(".cache/diaria/gdrive-data-bisync"), false, "o bisync grande nunca toca o state dir de data/");
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("variáveis GDRIVE_DATA_* no ambiente não mudam nada no bisync grande", () => {
    const r = run(BIG_SCRIPT, {
      env: {
        GDRIVE_MOUNT: "{SB}",
        GDRIVE_DATA_REMOTE: "outro:x",
        GDRIVE_DATA_LOCAL: "{SB}/outro",
        GDRIVE_DATA_STATE_DIR: "{SB}/outro-state",
        GDRIVE_DATA_WORKDIR: "{SB}/outro-wd",
        GDRIVE_DATA_FILTERS: DATA_FILTERS,
      },
      localRel: "GoogleDrive",
    });
    try {
      assert.equal(r.status, 0, r.stderr);
      const filters = join(r.sb, ".cache", "diaria", "gdrive-bisync", "filters.txt");
      assert.deepEqual(r.calls, [
        `bisync gdrive: ${join(r.sb, "GoogleDrive")} ${FIXED_FLAGS_BEFORE_12478.replace("{FILTERS}", filters)}`,
      ]);
      assert.equal(r.exists("outro-state"), false);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("retry de 401 do bisync grande segue sem --workdir", () => {
    const r = run(BIG_SCRIPT, { env: { GDRIVE_MOUNT: "{SB}" }, localRel: "GoogleDrive", seq: ["7:auth", "0"] });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.calls.length, 2);
      assert.match(r.calls[1], /--log-level NOTICE --resync --resync-mode newer$/);
      for (const c of r.calls) assert.doesNotMatch(c, /--workdir/);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("units do bisync grande seguem chamando gdrive-bisync.sh sem env de data/", () => {
    const svc = readFileSync(join(SYSTEMD, "diaria-gdrive-bisync.service"), "utf8");
    assert.match(svc, /^ExecStart=\/bin\/sh \/home\/vjpixel\/diaria-studio\/scripts\/systemd\/gdrive-bisync\.sh$/m);
    assert.doesNotMatch(svc, /^Environment/m);
    assert.doesNotMatch(svc, /gdrive-data-bisync/);
  });
});

describe("gdrive-data-bisync.sh — bisync dedicado de data/ (#12478)", posixOnly, () => {
  const DATA_DEFAULT_ENV = { GDRIVE_DATA_MOUNT: "{SB}", GDRIVE_DATA_LOCAL: "{SB}/GoogleDrive-diaria/diaria-studio-data" };

  it("defaults: remote gdrive-diaria:diaria-studio-data, pasta {mount}/GoogleDrive-diaria/diaria-studio-data, filtro, state dir e workdir próprios", () => {
    const r = run(DATA_SCRIPT, { env: { GDRIVE_DATA_MOUNT: "{SB}" }, localRel: "GoogleDrive-diaria/diaria-studio-data" });
    try {
      assert.equal(r.status, 0, r.stderr);
      const state = join(r.sb, ".cache", "diaria", "gdrive-data-bisync");
      assert.deepEqual(r.calls, [
        `bisync gdrive-diaria:diaria-studio-data ${join(r.sb, "GoogleDrive-diaria", "diaria-studio-data")} ` +
          `${FIXED_FLAGS_BEFORE_12478.replace("{FILTERS}", join(state, "filters.txt"))} --workdir ${join(state, "rclone-workdir")}`,
      ]);
      assert.equal(r.read(".cache/diaria/gdrive-data-bisync/filters.txt"), readFileSync(DATA_FILTERS, "utf8"));
      assert.ok(r.exists(".cache/diaria/gdrive-data-bisync/last-run.json"));
      assert.ok(r.exists(".cache/diaria/gdrive-data-bisync/last-success.json"));
      assert.ok(r.exists(".cache/diaria/gdrive-data-bisync/last-rclone.log"));
      assert.equal(r.exists(".cache/diaria/gdrive-bisync"), false, "o bisync de data/ nunca toca o state dir do Drive inteiro");
      assert.ok(r.exists(".cache/diaria/gdrive-data-bisync/rclone-workdir"), "o wrapper cria o --workdir");
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("trava de sobreposição: pasta de data/ dentro do espelho do Drive inteiro → exit 78, rclone nunca chamado", () => {
    for (const local of ["{SB}/GoogleDrive/diaria-studio-data", "{SB}/GoogleDrive", "{SB}/GoogleDrive/", "{SB}", "{SB}/x/../GoogleDrive/diaria-studio-data"]) {
      const r = run(DATA_SCRIPT, {
        env: { GDRIVE_DATA_MOUNT: "{SB}", GDRIVE_DATA_LOCAL: local, GDRIVE_DATA_FULL_DRIVE_LOCAL: "{SB}/GoogleDrive" },
        localRel: "GoogleDrive/diaria-studio-data",
      });
      try {
        assert.equal(r.status, 78, `${local}: ${r.stderr}`);
        assert.deepEqual(r.calls, [], local);
        assert.match(r.stderr, /se sobrepõe ao espelho do bisync do Drive inteiro/);
        assert.match(r.read(".cache/diaria/gdrive-data-bisync/last-run.json") ?? "", /"exit":78/);
        assert.equal(r.exists(".cache/diaria/gdrive-data-bisync/last-success.json"), false);
      } finally {
        rmSync(r.sb, { recursive: true, force: true });
      }
    }
  });

  it("trava de sobreposição compara por componente: GoogleDrive-diaria não está dentro de GoogleDrive", () => {
    const r = run(DATA_SCRIPT, {
      env: { GDRIVE_DATA_MOUNT: "{SB}", GDRIVE_DATA_FULL_DRIVE_LOCAL: "{SB}/GoogleDrive" },
      localRel: "GoogleDrive-diaria/diaria-studio-data",
    });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.calls.length, 1);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("trava de sobreposição também vale contra o GDRIVE_LOCAL do bisync grande vindo do ambiente", () => {
    const r = run(DATA_SCRIPT, {
      env: { GDRIVE_DATA_MOUNT: "{SB}", GDRIVE_LOCAL: "{SB}/GoogleDrive-diaria" },
      localRel: "GoogleDrive-diaria/diaria-studio-data",
    });
    try {
      assert.equal(r.status, 78, r.stderr);
      assert.deepEqual(r.calls, []);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("trava de sobreposição com a raiz real: /mnt/hd-sata/GoogleDrive/... aborta, sem tocar o HD", () => {
    const r = run(DATA_SCRIPT, {
      env: { GDRIVE_DATA_LOCAL: "/mnt/hd-sata/GoogleDrive/diaria-studio-data", GDRIVE_DATA_STATE_DIR: "{SB}/st" },
      localRel: "nada",
    });
    try {
      assert.equal(r.status, 78, r.stderr);
      assert.deepEqual(r.calls, []);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("GDRIVE_SENTINEL, GDRIVE_AUTH_RETRY_*, GDRIVE_MOUNTPOINT_CMD e GDRIVE_MAX_DELETE do bisync grande não vazam", () => {
    const r = run(DATA_SCRIPT, {
      env: {
        ...DATA_DEFAULT_ENV,
        GDRIVE_SENTINEL: "outra-sentinela",
        GDRIVE_AUTH_RETRY_MAX: "9",
        GDRIVE_AUTH_RETRY_DELAY: "abc",
        GDRIVE_MOUNTPOINT_CMD: "false",
        GDRIVE_MAX_DELETE: "50",
      },
      localRel: "GoogleDrive-diaria/diaria-studio-data",
      seq: ["7:auth", "7:auth", "7:auth"],
    });
    try {
      // Mountpoint do bisync grande ("false") ignorado; sentinela e max-delete default.
      assert.notEqual(r.status, 75, r.stderr);
      assert.match(r.calls[0], /--check-filename \.diaria-bisync-sentinel --max-delete 5 /);
      // Retry max default (1), não o 9 do bisync grande: 1 chamada + 1 resync.
      assert.equal(r.calls.length, 2);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("arquivo ~/.config/diaria/gdrive-data-bisync.env troca remote e pasta (destino da conta diaria.editor)", () => {
    const r = run(DATA_SCRIPT, {
      env: { GDRIVE_DATA_MOUNT: "{SB}" },
      localRel: "GoogleDrive-diaria/diaria-studio-data",
      envFile: [
        "# destino da #12575/#12576",
        "GDRIVE_DATA_REMOTE=gdrive-diaria:diaria-studio-data",
        "GDRIVE_DATA_LOCAL={SB}/GoogleDrive-diaria/diaria-studio-data",
        "",
      ].join("\n"),
    });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.calls.length, 1);
      assert.ok(
        r.calls[0].startsWith(`bisync gdrive-diaria:diaria-studio-data ${join(r.sb, "GoogleDrive-diaria", "diaria-studio-data")} `),
        r.calls[0],
      );
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("o arquivo de env nunca é executado como shell", () => {
    const r = run(DATA_SCRIPT, {
      env: DATA_DEFAULT_ENV,
      localRel: "GoogleDrive-diaria/diaria-studio-data",
      envFile: "GDRIVE_DATA_REMOTE=gdrive-diaria:x$(touch {SB}/pwned)\n",
    });
    try {
      assert.equal(r.exists("pwned"), false);
      // O valor chega literal ao rclone (e o rclone recusaria um remote assim).
      assert.ok(r.calls[0].startsWith(`bisync gdrive-diaria:x$(touch ${r.sb}/pwned) `), r.calls[0]);
      // Linha com crase é malformada: 78, e nada executa.
      const bad = run(DATA_SCRIPT, { env: DATA_DEFAULT_ENV, localRel: "GoogleDrive-diaria/diaria-studio-data", envFile: "`touch {SB}/pwned2`\n" });
      try {
        assert.equal(bad.status, 78);
        assert.equal(bad.exists("pwned2"), false);
      } finally {
        rmSync(bad.sb, { recursive: true, force: true });
      }
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("arquivo de env com CRLF: o \\r não vai colado no valor", () => {
    const r = run(DATA_SCRIPT, {
      env: { GDRIVE_DATA_MOUNT: "{SB}" },
      localRel: "GoogleDrive-diaria/diaria-studio-data",
      envFile: "GDRIVE_DATA_REMOTE=gdrive-diaria:diaria-studio-data\r\nGDRIVE_DATA_LOCAL={SB}/GoogleDrive-diaria/diaria-studio-data\r\n",
    });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.calls[0].startsWith(`bisync gdrive-diaria:diaria-studio-data ${join(r.sb, "GoogleDrive-diaria", "diaria-studio-data")} `), r.calls[0]);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("ambiente vence o arquivo de env", () => {
    const r = run(DATA_SCRIPT, {
      env: { ...DATA_DEFAULT_ENV, GDRIVE_DATA_REMOTE: "do-env:diaria-studio-data" },
      localRel: "GoogleDrive-diaria/diaria-studio-data",
      envFile: "GDRIVE_DATA_REMOTE=do-arquivo:diaria-studio-data\n",
    });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.calls[0].startsWith("bisync do-env:diaria-studio-data "), r.calls[0]);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("GDRIVE_REMOTE/GDRIVE_STATE_DIR do bisync grande no ambiente não vazam para o de data/", () => {
    const r = run(DATA_SCRIPT, {
      env: { ...DATA_DEFAULT_ENV, GDRIVE_REMOTE: "gdrive:", GDRIVE_STATE_DIR: "{SB}/big-state", GDRIVE_FILTERS: BIG_FILTERS },
      localRel: "GoogleDrive-diaria/diaria-studio-data",
    });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.calls[0].startsWith("bisync gdrive-diaria:diaria-studio-data "), r.calls[0]);
      assert.equal(r.exists("big-state"), false);
      assert.equal(r.read(".cache/diaria/gdrive-data-bisync/filters.txt"), readFileSync(DATA_FILTERS, "utf8"));
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("trava contra pasta vazia vale igual: desmontado ou sem sentinela → exit 75, rclone nunca chamado", () => {
    const unmounted = run(DATA_SCRIPT, {
      env: { ...DATA_DEFAULT_ENV, GDRIVE_DATA_MOUNTPOINT_CMD: "false" },
      localRel: "GoogleDrive-diaria/diaria-studio-data",
    });
    const noSentinel = run(DATA_SCRIPT, {
      env: { GDRIVE_DATA_MOUNT: "{SB}", GDRIVE_DATA_LOCAL: "{SB}/outra-pasta" },
      localRel: "GoogleDrive-diaria/diaria-studio-data",
    });
    try {
      assert.equal(unmounted.status, 75);
      assert.deepEqual(unmounted.calls, []);
      assert.match(unmounted.read(".cache/diaria/gdrive-data-bisync/last-run.json") ?? "", /"exit":75/);
      assert.equal(noSentinel.status, 75);
      assert.deepEqual(noSentinel.calls, []);
      assert.match(noSentinel.stderr, /sentinela/);
    } finally {
      rmSync(unmounted.sb, { recursive: true, force: true });
      rmSync(noSentinel.sb, { recursive: true, force: true });
    }
  });

  it("retry de 401 (#12412) mantém o --workdir próprio no resync automático", () => {
    const r = run(DATA_SCRIPT, { env: DATA_DEFAULT_ENV, localRel: "GoogleDrive-diaria/diaria-studio-data", seq: ["7:auth", "0"] });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.calls.length, 2);
      const wd = join(r.sb, ".cache", "diaria", "gdrive-data-bisync", "rclone-workdir");
      assert.match(r.calls[1], new RegExp(`--workdir ${wd.replaceAll("/", "\\/")} --resync --resync-mode newer$`));
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("filtro instalado só muda no --resync (#12396), no state dir de data/", () => {
    const r = run(DATA_SCRIPT, {
      env: { ...DATA_DEFAULT_ENV, GDRIVE_DATA_STATE_DIR: "{SB}/st" },
      localRel: "GoogleDrive-diaria/diaria-studio-data",
    });
    try {
      mkdirSync(join(r.sb, "st"), { recursive: true });
      writeFileSync(join(r.sb, "st", "filters.txt"), "- velho\n");
      const again = spawnSync("/bin/sh", [DATA_SCRIPT], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: r.sb,
          RCLONE_BIN: join(r.sb, "rclone"),
          GDRIVE_DATA_MOUNTPOINT_CMD: "true",
          GDRIVE_DATA_MOUNT: r.sb,
          GDRIVE_DATA_LOCAL: join(r.sb, "GoogleDrive-diaria", "diaria-studio-data"),
          GDRIVE_DATA_STATE_DIR: join(r.sb, "st"),
        },
      });
      assert.equal(again.status, 0, again.stderr);
      assert.equal(readFileSync(join(r.sb, "st", "filters.txt"), "utf8"), "- velho\n");
      assert.match(again.stderr, /difere do filtro instalado/);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("--dry-run não carimba nada", () => {
    const r = run(DATA_SCRIPT, { env: DATA_DEFAULT_ENV, localRel: "GoogleDrive-diaria/diaria-studio-data", args: ["--dry-run"] });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.calls[0], /--dry-run$/);
      assert.equal(r.exists(".cache/diaria/gdrive-data-bisync/last-run.json"), false);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });
});

describe("units diaria-gdrive-data-bisync (#12478)", () => {
  const svc = readFileSync(join(SYSTEMD, "diaria-gdrive-data-bisync.service"), "utf8");
  const timer = readFileSync(join(SYSTEMD, "diaria-gdrive-data-bisync.timer"), "utf8");

  it("service: oneshot, RequiresMountsFor, chama o wrapper de data/", () => {
    assert.match(svc, /^RequiresMountsFor=\/mnt\/hd-sata$/m);
    assert.match(svc, /^Type=oneshot$/m);
    assert.match(svc, /^ExecStart=\/bin\/sh \/home\/vjpixel\/diaria-studio\/scripts\/systemd\/gdrive-data-bisync\.sh$/m);
    // Teto da unit abaixo do stale do alarme de data/ (30 min): rodada lenta
    // vira timeout (falha) antes de virar "sem sucesso".
    const m = /^TimeoutStartSec=(\d+)min$/m.exec(svc);
    assert.ok(m, "TimeoutStartSec em minutos");
    assert.ok(Number(m![1]) * 60_000 < DATA_GDRIVE_SYNC_TOLERANCES.staleMs);
  });

  it("timer: 1 min depois do fim da rodada anterior, sem Persistent", () => {
    assert.match(timer, /^OnUnitInactiveSec=1min$/m);
    assert.match(timer, /^OnBootSec=/m);
    assert.match(timer, /^Persistent=false$/m);
    assert.match(timer, /^WantedBy=timers\.target$/m);
  });

  it("nenhuma das duas units define Environment= (a config vive no arquivo de env, lido pelo wrapper)", () => {
    assert.doesNotMatch(svc, /^Environment/m);
  });
});

describe("alarme do bisync de data/ (#12478)", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const evalData = (exit: number, successMinAgo: number) =>
    evaluateGdriveSync({ at: ago(1), exit }, { at: ago(successMinAgo), exit: 0 }, now, DATA_GDRIVE_SYNC_TOLERANCES);
  const QUOTA_OK = { verdict: "ok", usedPct: 10 } as unknown as GdriveQuotaEvaluation;

  it("limiar curto: sem sucesso há 30 min não alarma, 31 min alarma stale", () => {
    assert.equal(evalData(0, 30).verdict, "ok");
    assert.equal(evalData(0, 31).verdict, "alarm-sync-stale");
  });

  it("falha persistente alarma depois de 15 min, trava depois de 30 min", () => {
    assert.equal(evalData(3, 15).verdict, "ok");
    assert.equal(evalData(3, 16).verdict, "alarm-bisync-failed");
    assert.equal(evalData(75, 30).verdict, "ok");
    assert.equal(evalData(75, 31).verdict, "alarm-bisync-blocked");
  });

  it("as tolerâncias do Drive inteiro não mudaram (1h / 30 min / 6h)", () => {
    assert.deepEqual(DEFAULT_GDRIVE_SYNC_TOLERANCES, { blockedMs: 3_600_000, failedMs: 1_800_000, staleMs: 21_600_000 });
  });

  it("achado de data/: check próprio, título e texto com a unit e o wrapper de data/", () => {
    const ev = evalData(3, 60);
    const f = toDataSyncAlarmFinding(ev, "gdrive");
    assert.equal(f.check, DATA_SYNC_CHECK);
    assert.notEqual(f.check, SYNC_CHECK);
    assert.equal(f.title, "[diar.ia.br] Google Drive data/ sync: alarm-bisync-failed");
    assert.match(f.body, /diaria-gdrive-data-bisync/);
    assert.match(f.body, /sh scripts\/systemd\/gdrive-data-bisync\.sh --force/);
    assert.doesNotMatch(f.body, /\/gdrive-bisync\.sh --force/);
    assert.equal(f.priority, "P1");
    assert.equal(toDataSyncAlarmFinding(ev, "onedrive").priority, "P2");
  });

  it("texto da trava de data/ aponta para a sentinela da pasta de data/ e o arquivo de env", () => {
    const t = describeGdriveSyncVerdict(evalData(75, 60), DATA_BISYNC_TARGET);
    assert.match(t, /gdrive-data-bisync\.env/);
    assert.match(t, /journalctl --user -u diaria-gdrive-data-bisync -n 20/);
    assert.match(describeGdriveSyncVerdict(evalData(0, 60), DATA_BISYNC_TARGET), /^O `data\/` no Google Drive/);
  });

  it("texto do Drive inteiro é o mesmo com o target default e o explícito", () => {
    const cases = [
      evaluateGdriveSync({ at: ago(1), exit: 75 }, { at: ago(120), exit: 0 }, now),
      evaluateGdriveSync({ at: ago(1), exit: 3 }, { at: ago(120), exit: 0 }, now),
      evaluateGdriveSync({ at: ago(1), exit: 0 }, { at: ago(600), exit: 0 }, now),
    ];
    for (const big of cases) {
      assert.equal(describeGdriveSyncVerdict(big), describeGdriveSyncVerdict(big, FULL_DRIVE_BISYNC_TARGET));
      assert.equal(toSyncAlarmFinding(big, "gdrive").check, SYNC_CHECK);
    }
    assert.match(describeGdriveSyncVerdict(cases[0]), /a sentinela LOCAL `\/mnt\/hd-sata\/GoogleDrive\/\.diaria-bisync-sentinel` sumiu/);
    assert.match(describeGdriveSyncVerdict(cases[1]), /`rclone touch gdrive:\.diaria-bisync-sentinel`/);
    assert.match(describeGdriveSyncVerdict(cases[2]), /^O Google Drive não sincroniza/);
  });

  it("congelamento: data/ sem bisync congela só as chaves de data/", () => {
    const f = absenceUnmeasured({ sync: "ok", quota: "ok", dataSync: "not-installed", dataQuota: null });
    assert.equal(f(alarmIssueStateKey(DATA_SYNC_CHECK, "alarm-sync-stale")), true);
    assert.equal(f(alarmIssueStateKey(DATA_SYNC_CHECK, "alarm-stamp-unreadable")), true);
    assert.equal(f(alarmIssueStateKey(SYNC_CHECK, "alarm-sync-stale")), false);
    assert.equal(f(alarmIssueStateKey(DATA_QUOTA_CHECK, "quota-near")), true, "cota de data/ não medida congela");
    // O achado de "data/ depende e não há carimbo" é medido: nunca congela.
    assert.equal(f(alarmIssueStateKey(DATA_SYNC_CHECK, DATA_BISYNC_MISSING)), false);
    const g = absenceUnmeasured({ sync: "not-installed", quota: "ok", dataSync: "ok", dataQuota: "ok" });
    assert.equal(g(alarmIssueStateKey(SYNC_CHECK, "alarm-sync-stale")), true);
    assert.equal(g(alarmIssueStateKey(DATA_SYNC_CHECK, "alarm-sync-stale")), false);
    assert.equal(g(alarmIssueStateKey(DATA_QUOTA_CHECK, "quota-near")), false);
    const u = absenceUnmeasured({ sync: "ok", quota: "ok", dataSync: "ok", dataQuota: "unmeasured" });
    assert.equal(u(alarmIssueStateKey(DATA_QUOTA_CHECK, "quota-full")), true);
    assert.equal(u(alarmIssueStateKey(DATA_QUOTA_CHECK, "quota-unmeasured")), false);
  });

  it("e-mail junta os dois sinais de sync", () => {
    const big = evaluateGdriveSync({ at: ago(1), exit: 75 }, { at: ago(120), exit: 0 }, now);
    const data = evalData(0, 60);
    const outcomes = [
      { check: SYNC_CHECK, fingerprint: big.verdict, action: "created", issueNumber: 1, url: "u1" },
      { check: DATA_SYNC_CHECK, fingerprint: data.verdict, action: "created", issueNumber: 2, url: "u2" },
    ] as unknown as AlarmFindingOutcome[];
    const e = buildGdriveAlarmEmail(outcomes, big, QUOTA_OK, null, {
      sync: data,
      target: DATA_BISYNC_TARGET,
      missingText: null,
      configErrors: [],
      envFile: "/h/.config/diaria/gdrive-data-bisync.env",
      quota: null,
      quotaUnmeasuredReason: null,
      remoteName: "gdrive-diaria:",
    });
    assert.equal(e.subject, "⚠️ Google Drive: alarm-bisync-blocked + data/ alarm-sync-stale");
    assert.match(e.body, /Issue: #2 \(u2\)/);
    // Sem o 5º argumento (forma antiga), o e-mail do Drive inteiro é o de sempre.
    assert.equal(buildGdriveAlarmEmail(outcomes.slice(0, 1), big, QUOTA_OK).subject, "⚠️ Google Drive: alarm-bisync-blocked");
  });

  it("state dir de data/: ambiente > arquivo de env > ~/.cache/diaria/gdrive-data-bisync", () => {
    const noFile = () => null;
    const file = (text: string) => (p: string) => (p === "/h/.config/diaria/gdrive-data-bisync.env" ? text : null);
    assert.equal(defaultGdriveDataStateDir({ GDRIVE_DATA_STATE_DIR: "/x" }, noFile), "/x");
    assert.equal(defaultGdriveDataStateDir({ HOME: "/h" }, noFile), "/h/.cache/diaria/gdrive-data-bisync");
    assert.equal(defaultGdriveDataStateDir({ HOME: "/h" }, file("GDRIVE_DATA_STATE_DIR=/do-arquivo\n")), "/do-arquivo");
    assert.equal(defaultGdriveDataStateDir({ HOME: "/h", GDRIVE_DATA_STATE_DIR: "/do-env" }, file("GDRIVE_DATA_STATE_DIR=/do-arquivo\n")), "/do-env");
    // Definida no ambiente mesmo vazia vence o arquivo (`${CHAVE+x}` do wrapper) e cai no default.
    assert.equal(defaultGdriveDataStateDir({ HOME: "/h", GDRIVE_DATA_STATE_DIR: "" }, file("GDRIVE_DATA_STATE_DIR=/do-arquivo\n")), "/h/.cache/diaria/gdrive-data-bisync");
    // GDRIVE_DATA_ENV_FILE troca o arquivo.
    const other = (p: string) => (p === "/outro.env" ? "GDRIVE_DATA_STATE_DIR=/outro\n" : null);
    assert.equal(defaultGdriveDataStateDir({ HOME: "/h", GDRIVE_DATA_ENV_FILE: "/outro.env" }, other), "/outro");
  });

  it("parser do arquivo de env: comentário e CRLF ok; malformado, desconhecida e repetida são erro; nunca avalia", () => {
    const ok = parseDataBisyncEnvFile("# c\r\n\n   \nGDRIVE_DATA_REMOTE=a:b\r\nGDRIVE_DATA_LOCAL=/x/$(touch y)=z");
    assert.deepEqual(ok.values, { GDRIVE_DATA_REMOTE: "a:b", GDRIVE_DATA_LOCAL: "/x/$(touch y)=z" });
    assert.deepEqual(ok.errors, []);
    for (const [text, re] of [
      ["sem-igual\n", /sem '='/],
      ["export GDRIVE_DATA_REMOTE=a:b\n", /chave malformada/],
      ["GDRIVE_DATA_REMOTE =a:b\n", /chave malformada/],
      ["GDRIVE_DATA_REMOTE= a:b\n", /espaço depois/],
      ["\uFEFFGDRIVE_DATA_REMOTE=a:b\n", /BOM/],
      ["OUTRA=1\n", /desconhecida OUTRA/],
      ["GDRIVE_DATA_REMOTE=a:b\nGDRIVE_DATA_REMOTE=c:d\n", /repetida/],
    ] as const) {
      const r = parseDataBisyncEnvFile(text);
      assert.equal(r.errors.length, 1, text);
      assert.match(r.errors[0]!, re, text);
    }
  });

  it("config: arquivo ilegível, GDRIVE_DATA_ENV_FILE explícito inexistente ou relativo são erro; default ausente não", () => {
    assert.deepEqual(resolveDataBisyncConfig({ HOME: "/h" }, () => null).errors, []);
    const unreadable = resolveDataBisyncConfig({ HOME: "/h" }, () => {
      throw new Error("EACCES");
    });
    assert.match(unreadable.errors.join(" "), /não é um arquivo legível/);
    assert.match(resolveDataBisyncConfig({ HOME: "/h", GDRIVE_DATA_ENV_FILE: "/nao.env" }, () => null).errors.join(" "), /não existe/);
    assert.match(resolveDataBisyncConfig({ HOME: "/h", GDRIVE_DATA_ENV_FILE: "rel.env" }, () => null).errors.join(" "), /absoluto/);
  });

  it("config: caminhos relativos, remote sem ':' e remote igual ao do bisync grande são erro", () => {
    for (const k of ["GDRIVE_DATA_LOCAL", "GDRIVE_DATA_MOUNT", "GDRIVE_DATA_FILTERS", "GDRIVE_DATA_STATE_DIR", "GDRIVE_DATA_WORKDIR"]) {
      const c = resolveDataBisyncConfig({ HOME: "/h", [k]: "relativo/x" }, () => null);
      assert.match(c.errors.join(" "), new RegExp(`${k} precisa ser caminho absoluto`), k);
    }
    assert.match(resolveDataBisyncConfig({ HOME: "/h", GDRIVE_DATA_REMOTE: "semdoispontos" }, () => null).errors.join(" "), /remote:pasta/);
    assert.match(resolveDataBisyncConfig({ HOME: "/h", GDRIVE_DATA_REMOTE: "gdrive:diaria-studio-data" }, () => null).errors.join(" "), /mesmo do bisync/);
    assert.match(
      resolveDataBisyncConfig({ HOME: "/h", GDRIVE_REMOTE: "outro:", GDRIVE_DATA_REMOTE: "outro:x" }, () => null).errors.join(" "),
      /mesmo do bisync/,
    );
    assert.deepEqual(resolveDataBisyncConfig({ HOME: "/h", GDRIVE_REMOTE: "outro:", GDRIVE_DATA_REMOTE: "gdrive:x" }, () => null).errors, []);
    assert.equal(resolveDataBisyncConfig({ HOME: "/h" }, () => null).remoteName, "gdrive-diaria:");
  });

  it("config resolvida: defaults reais e workdir derivado do state dir", () => {
    const c = resolveDataBisyncConfig({ HOME: "/h" }, () => null);
    assert.equal(c.remote, "gdrive-diaria:diaria-studio-data");
    assert.equal(c.local, "/mnt/hd-sata/GoogleDrive-diaria/diaria-studio-data");
    assert.equal(c.workdir, "/h/.cache/diaria/gdrive-data-bisync/rclone-workdir");
    const m = resolveDataBisyncConfig({ HOME: "/h" }, () => "GDRIVE_DATA_MOUNT=/m\n");
    assert.equal(m.local, "/m/GoogleDrive-diaria/diaria-studio-data");
  });

  it("texto do alarme de data/ mostra o remote e a pasta efetivos, sem placeholder", () => {
    const t = dataBisyncTarget({ remote: "outro:pasta", local: "/l/data", stateDir: "/s" });
    const failed = describeGdriveSyncVerdict(evalData(3, 60), t);
    assert.match(failed, /`rclone touch outro:pasta\/\.diaria-bisync-sentinel`/);
    assert.doesNotMatch(failed, /\{GDRIVE_DATA_REMOTE\}/);
    assert.match(describeGdriveSyncVerdict(evalData(75, 60), t), /`\/l\/data\/\.diaria-bisync-sentinel`/);
    assert.match(describeGdriveSyncVerdict(evalData(3, 60), DATA_BISYNC_TARGET), /rclone touch gdrive-diaria:diaria-studio-data\/\.diaria-bisync-sentinel/);
    assert.equal(dataBisyncTarget({ remote: "gdrive:", local: "/l" }).remoteSentinelTouch, "rclone touch gdrive:.diaria-bisync-sentinel");
    assert.equal(t.stateDirHint, "/s/");
    const f = toDataSyncAlarmFinding(evalData(3, 60), "gdrive", t);
    assert.match(f.body, /rclone touch outro:pasta\//);
  });

  it(
    "CLI --dry-run: Drive inteiro ok + data/ sem sucesso há 1h → 1 ação, do sinal de data/",
    { skip: process.platform === "win32" ? "rclone falso é shell" : false },
    () => {
      const sb = mkdtempSync(join(tmpdir(), "gdrive-data-alarm-12478-"));
      try {
        const big = join(sb, "big");
        const data = join(sb, "data");
        mkdirSync(big);
        mkdirSync(data);
        const fresh = new Date().toISOString();
        const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
        writeFileSync(join(big, "last-run.json"), JSON.stringify({ at: fresh, exit: 0 }));
        writeFileSync(join(big, "last-success.json"), JSON.stringify({ at: fresh, exit: 0 }));
        writeFileSync(join(data, "last-run.json"), JSON.stringify({ at: fresh, exit: 0 }));
        writeFileSync(join(data, "last-success.json"), JSON.stringify({ at: hourAgo, exit: 0 }));
        const fake = join(sb, "rclone");
        writeFileSync(fake, `#!/bin/sh\necho '{"total":100,"used":10,"free":90}'\n`);
        chmodSync(fake, 0o755);
        const r = spawnSync(
          process.execPath,
          ["--import", "tsx", join(ROOT, "scripts", "gdrive-sync-alarm.ts"), "--dry-run", "--state-dir", big, "--data-state-dir", data, "--data-dir", join(sb, "sem-data")],
          { encoding: "utf8", cwd: ROOT, env: cliEnv(sb, { RCLONE_BIN: fake }) },
        );
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /sync: verdict=ok/);
        assert.match(r.stdout, /sync data\/: verdict=alarm-sync-stale/);
        assert.match(r.stdout, /--dry-run: 1 ação/);
      } finally {
        rmSync(sb, { recursive: true, force: true });
      }
    },
  );

  it(
    "CLI sem --data-state-dir acha o state dir de data/ pelo arquivo de env",
    { skip: process.platform === "win32" ? "rclone falso é shell" : false },
    () => {
      const sb = mkdtempSync(join(tmpdir(), "gdrive-data-alarm-envfile-12478-"));
      try {
        const big = join(sb, "big");
        const data = join(sb, "data-do-arquivo");
        mkdirSync(big);
        mkdirSync(data);
        const fresh = new Date().toISOString();
        const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
        writeFileSync(join(big, "last-run.json"), JSON.stringify({ at: fresh, exit: 0 }));
        writeFileSync(join(big, "last-success.json"), JSON.stringify({ at: fresh, exit: 0 }));
        writeFileSync(join(data, "last-run.json"), JSON.stringify({ at: fresh, exit: 0 }));
        writeFileSync(join(data, "last-success.json"), JSON.stringify({ at: hourAgo, exit: 0 }));
        const envFile = join(sb, "gdrive-data-bisync.env");
        writeFileSync(envFile, `GDRIVE_DATA_STATE_DIR=${data}\n`);
        const fake = join(sb, "rclone");
        writeFileSync(fake, `#!/bin/sh\necho '{"total":100,"used":10,"free":90}'\n`);
        chmodSync(fake, 0o755);
        const env = cliEnv(sb, { RCLONE_BIN: fake, GDRIVE_DATA_ENV_FILE: envFile });
        const r = spawnSync(
          process.execPath,
          ["--import", "tsx", join(ROOT, "scripts", "gdrive-sync-alarm.ts"), "--dry-run", "--state-dir", big, "--data-dir", join(sb, "sem-data")],
          { encoding: "utf8", cwd: ROOT, env },
        );
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /sync data\/: verdict=alarm-sync-stale/);
        assert.ok(r.stdout.includes(`stateDir=${data}`), r.stdout);
      } finally {
        rmSync(sb, { recursive: true, force: true });
      }
    },
  );
});

describe("gdrive-data-bisync.sh — configuração estrita (exit 78)", posixOnly, () => {
  const base = { GDRIVE_DATA_MOUNT: "{SB}", GDRIVE_DATA_LOCAL: "{SB}/GoogleDrive-diaria/diaria-studio-data" };
  const expect78 = (r: RunResult, re: RegExp, label: string) => {
    assert.equal(r.status, 78, `${label}: ${r.stderr}`);
    assert.deepEqual(r.calls, [], label);
    assert.match(r.stderr, re, label);
  };

  it("arquivo de env malformado, chave desconhecida ou repetida → 78 (nunca só aviso)", () => {
    const cases: [string, RegExp][] = [
      ["sem-igual\n", /sem '='/],
      ["export GDRIVE_DATA_REMOTE=gdrive-diaria:x\n", /chave malformada/],
      ["GDRIVE_DATA_REMOTE =gdrive-diaria:x\n", /chave malformada/],
      ["GDRIVE_DATA_REMOTE= gdrive-diaria:x\n", /espaço depois/],
      ["﻿GDRIVE_DATA_REMOTE=gdrive-diaria:x\n", /BOM/],
      ["CHAVE_DESCONHECIDA=1\n", /chave desconhecida CHAVE_DESCONHECIDA/],
      ["GDRIVE_DATA_REMOTE=gdrive-diaria:x\nGDRIVE_DATA_REMOTE=gdrive-diaria:y\n", /repetida/],
    ];
    for (const [envFile, re] of cases) {
      const r = run(DATA_SCRIPT, { env: base, localRel: "GoogleDrive-diaria/diaria-studio-data", envFile });
      try {
        expect78(r, re, JSON.stringify(envFile));
        assert.match(r.read(".cache/diaria/gdrive-data-bisync/last-run.json") ?? "", /"exit":78/);
      } finally {
        rmSync(r.sb, { recursive: true, force: true });
      }
    }
  });

  it("arquivo existente mas ilegível → 78", { skip: process.getuid?.() === 0 ? "root lê tudo" : false }, () => {
    const r0 = run(DATA_SCRIPT, { env: base, localRel: "GoogleDrive-diaria/diaria-studio-data", envFile: "GDRIVE_DATA_MAX_DELETE=5\n" });
    try {
      const f = join(r0.sb, ".config", "diaria", "gdrive-data-bisync.env");
      chmodSync(f, 0o000);
      const again = spawnSync("/bin/sh", [DATA_SCRIPT], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: r0.sb,
          RCLONE_BIN: join(r0.sb, "rclone"),
          GDRIVE_DATA_MOUNTPOINT_CMD: "true",
          GDRIVE_DATA_MOUNT: r0.sb,
          GDRIVE_DATA_LOCAL: join(r0.sb, "GoogleDrive-diaria", "diaria-studio-data"),
        },
      });
      chmodSync(f, 0o600);
      assert.equal(again.status, 78, again.stderr);
      assert.match(again.stderr, /não é um arquivo legível/);
    } finally {
      rmSync(r0.sb, { recursive: true, force: true });
    }
  });

  it("GDRIVE_DATA_ENV_FILE explícito inexistente → 78; arquivo default ausente → defaults", () => {
    const r = run(DATA_SCRIPT, { env: { ...base, GDRIVE_DATA_ENV_FILE: "{SB}/nao-existe.env" }, localRel: "GoogleDrive-diaria/diaria-studio-data" });
    try {
      expect78(r, /não existe/, "explícito inexistente");
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("caminho relativo em LOCAL, MOUNT, FILTERS, STATE_DIR, WORKDIR ou GDRIVE_DATA_ENV_FILE → 78", () => {
    for (const k of ["GDRIVE_DATA_LOCAL", "GDRIVE_DATA_MOUNT", "GDRIVE_DATA_FILTERS", "GDRIVE_DATA_STATE_DIR", "GDRIVE_DATA_WORKDIR", "GDRIVE_DATA_ENV_FILE"]) {
      const r = run(DATA_SCRIPT, { env: { ...base, [k]: "relativo/x" }, localRel: "GoogleDrive-diaria/diaria-studio-data" });
      try {
        expect78(r, new RegExp(`${k} precisa ser caminho absoluto`), k);
      } finally {
        rmSync(r.sb, { recursive: true, force: true });
      }
    }
  });

  it("trava pelo lado da nuvem: remote de data/ igual ao do bisync grande → 78", () => {
    const cases: [Record<string, string>, string][] = [
      [{ GDRIVE_DATA_REMOTE: "gdrive:diaria-studio-data" }, "gdrive: (default do bisync grande)"],
      [{ GDRIVE_DATA_REMOTE: "outro:x", GDRIVE_REMOTE: "outro:" }, "GDRIVE_REMOTE do ambiente"],
      [{ GDRIVE_DATA_REMOTE: "semdoispontos" }, "sem remote:"],
    ];
    for (const [env, label] of cases) {
      const r = run(DATA_SCRIPT, { env: { ...base, ...env }, localRel: "GoogleDrive-diaria/diaria-studio-data" });
      try {
        expect78(r, /mesmo do bisync do Drive inteiro|remote:pasta/, label);
      } finally {
        rmSync(r.sb, { recursive: true, force: true });
      }
    }
    // Remote diferente do grande passa.
    const ok = run(DATA_SCRIPT, { env: { ...base, GDRIVE_DATA_REMOTE: "gdrive:x", GDRIVE_REMOTE: "outro:" }, localRel: "GoogleDrive-diaria/diaria-studio-data" });
    try {
      assert.equal(ok.status, 0, ok.stderr);
    } finally {
      rmSync(ok.sb, { recursive: true, force: true });
    }
  });

  it("GDRIVE_DATA_FULL_DRIVE_LOCAL SOMA à raiz fixa: /mnt/hd-sata/GoogleDrive segue travada", () => {
    const r = run(DATA_SCRIPT, {
      env: { GDRIVE_DATA_LOCAL: "/mnt/hd-sata/GoogleDrive/x", GDRIVE_DATA_STATE_DIR: "{SB}/st", GDRIVE_DATA_FULL_DRIVE_LOCAL: "{SB}/outra-raiz" },
      localRel: "nada",
    });
    try {
      expect78(r, /se sobrepõe/, "raiz fixa");
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("sem realpath utilizável → 78 (nunca compara o caminho cru)", () => {
    const r0 = run(DATA_SCRIPT, { env: base, localRel: "GoogleDrive-diaria/diaria-studio-data", args: ["--dry-run"] });
    try {
      const bin = join(r0.sb, "bin");
      mkdirSync(bin);
      for (const tool of ["dirname", "mkdir", "date", "mv"]) {
        const which = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
        writeFileSync(join(bin, tool), `#!/bin/sh\nexec ${which} "$@"\n`);
        chmodSync(join(bin, tool), 0o755);
      }
      const r = spawnSync("/bin/sh", [DATA_SCRIPT], {
        encoding: "utf8",
        env: {
          PATH: bin,
          HOME: r0.sb,
          RCLONE_BIN: join(r0.sb, "rclone"),
          GDRIVE_DATA_MOUNTPOINT_CMD: "true",
          GDRIVE_DATA_MOUNT: r0.sb,
          GDRIVE_DATA_LOCAL: join(r0.sb, "GoogleDrive-diaria", "diaria-studio-data"),
        },
      });
      assert.equal(r.status, 78, r.stderr);
      assert.match(r.stderr, /canonizar/);
    } finally {
      rmSync(r0.sb, { recursive: true, force: true });
    }
  });

  it("contrato exit 78 → alarme: carimbo do wrapper vira achado com causa de configuração", () => {
    const r = run(DATA_SCRIPT, { env: { ...base, GDRIVE_DATA_REMOTE: "gdrive:x" }, localRel: "GoogleDrive-diaria/diaria-studio-data" });
    try {
      assert.equal(r.status, 78);
      const run78 = readBisyncStamp(join(r.sb, ".cache", "diaria", "gdrive-data-bisync", "last-run.json"));
      const success = readBisyncStamp(join(r.sb, ".cache", "diaria", "gdrive-data-bisync", "last-success.json"));
      assert.equal(run78.kind, "ok");
      const later = new Date(Date.now() + 16 * 60_000);
      const ev = evaluateGdriveSync(run78, success, later, DATA_GDRIVE_SYNC_TOLERANCES);
      assert.equal(ev.verdict, "alarm-bisync-failed");
      const t = describeGdriveSyncVerdict(ev, DATA_BISYNC_TARGET);
      assert.match(t, /configuração inválida ou sobreposição/);
      assert.match(t, /GDRIVE_DATA_\*/);
      assert.match(t, /gdrive-data-bisync\.env/);
      // No bisync grande o exit 78 não ganha esse texto (ele nunca sai 78).
      assert.doesNotMatch(describeGdriveSyncVerdict(ev), /configuração inválida/);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });
});

describe("gdrive-data-bisync.sh — repasse e isolamento", posixOnly, () => {
  const base = { GDRIVE_DATA_MOUNT: "{SB}", GDRIVE_DATA_LOCAL: "{SB}/GoogleDrive-diaria/diaria-studio-data" };
  const rel = "GoogleDrive-diaria/diaria-studio-data";

  it("GDRIVE_DATA_MAX_DELETE → --max-delete", () => {
    const r = run(DATA_SCRIPT, { env: { ...base, GDRIVE_DATA_MAX_DELETE: "9" }, localRel: rel });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.calls[0], / --max-delete 9 /);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("GDRIVE_DATA_AUTH_RETRY_MAX → número de resyncs automáticos", () => {
    const r = run(DATA_SCRIPT, { env: { ...base, GDRIVE_DATA_AUTH_RETRY_MAX: "2" }, localRel: rel, seq: ["7:auth", "7:auth", "7:auth", "7:auth"] });
    try {
      assert.equal(r.calls.length, 3);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("GDRIVE_DATA_WORKDIR → --workdir, criado pelo wrapper", () => {
    const r = run(DATA_SCRIPT, { env: { ...base, GDRIVE_DATA_WORKDIR: "{SB}/wd/fundo" }, localRel: rel });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.calls[0], new RegExp(`--workdir ${join(r.sb, "wd", "fundo").replaceAll("/", "\\/")}$`));
      assert.ok(r.exists("wd/fundo"));
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("GDRIVE_DATA_FILTERS → filtro instalado", () => {
    const sbFilter = mkdtempSync(join(tmpdir(), "gdrive-data-filter-12478-"));
    const custom = join(sbFilter, "f.txt");
    writeFileSync(custom, "- custom-only\n");
    const r = run(DATA_SCRIPT, { env: { ...base, GDRIVE_DATA_FILTERS: custom }, localRel: rel });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.read(".cache/diaria/gdrive-data-bisync/filters.txt"), "- custom-only\n");
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
      rmSync(sbFilter, { recursive: true, force: true });
    }
  });

  it("GDRIVE_AUTH_RETRY_DELAY do bisync grande não vaza: o sleep recebe o delay de data/ ou o default", () => {
    // `sleep` falso registra o argumento. GDRIVE_AUTH_RETRY_DELAY=7 (do bisync
    // grande) no ambiente: se vazasse, o sleep receberia 7.
    for (const [dataDelay, expected] of [
      ["", "60"],
      ["3", "3"],
    ] as const) {
      const sb = mkdtempSync(join(tmpdir(), "gdrive-data-sleep-12478-"));
      try {
        const bin = join(sb, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "sleep"), `#!/bin/sh\necho "$1" >> "${join(sb, "sleeps.log")}"\n`);
        chmodSync(join(bin, "sleep"), 0o755);
        const r = run(DATA_SCRIPT, {
          env: {
            ...base,
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            GDRIVE_AUTH_RETRY_DELAY: "7",
            GDRIVE_DATA_AUTH_RETRY_DELAY: dataDelay,
          },
          localRel: rel,
          seq: ["7:auth", "0"],
        });
        try {
          assert.equal(r.calls.length, 2, r.stderr);
          assert.equal(readFileSync(join(sb, "sleeps.log"), "utf8").trim(), expected);
        } finally {
          rmSync(r.sb, { recursive: true, force: true });
        }
      } finally {
        rmSync(sb, { recursive: true, force: true });
      }
    }
  });

  it("nenhuma regra de exclusão do filtro de data/ casa a sentinela .diaria-bisync-sentinel", () => {
    // rclone glob → RegExp (sem rclone no CI): `**` qualquer coisa, `*` sem
    // barra, `?` um caractere sem barra, `{a,b}` alternativa, `/` inicial
    // ancora na raiz; sem `/` inicial casa em qualquer profundidade.
    const toRe = (glob: string): RegExp => {
      let g = glob;
      const anchored = g.startsWith("/");
      if (anchored) g = g.slice(1);
      let out = "";
      for (let i = 0; i < g.length; i++) {
        const ch = g[i]!;
        if (ch === "*" && g[i + 1] === "*") {
          out += ".*";
          i++;
        } else if (ch === "*") out += "[^/]*";
        else if (ch === "?") out += "[^/]";
        else if (ch === "{") out += "(?:";
        else if (ch === "}") out += ")";
        else if (ch === "," && out.includes("(?:")) out += "|";
        else if (ch === "[") {
          const end = g.indexOf("]", i);
          out += g.slice(i, end + 1);
          i = end;
        } else out += ch.replace(/[.+^$()|\\]/g, "\\$&");
      }
      return new RegExp(`${anchored ? "^" : "(^|/)"}${out}(/.*)?$`, "i");
    };
    const rules = readFileSync(DATA_FILTERS, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());
    assert.ok(rules.length > 0);
    for (const rule of rules) {
      for (const path of [".diaria-bisync-sentinel", "sub/.diaria-bisync-sentinel"]) {
        assert.doesNotMatch(path, toRe(rule), `regra '- ${rule}' casa ${path}`);
      }
    }
    // Sanidade do conversor: uma regra que casaria é detectada.
    assert.match(".diaria-bisync-sentinel", toRe(".diaria-*"));
  });
});

describe("diferencial shell × TS da config do bisync de data/", posixOnly, () => {
  /** Roda o wrapper REAL (copiado ao lado de um gdrive-bisync.sh falso que só
   * imprime o que recebeu) e devolve exit + variáveis resolvidas. */
  function shellResolve(sb: string, env: Record<string, string>): { status: number | null; vars: Record<string, string>; stderr: string } {
    const w = join(sb, "w");
    mkdirSync(w, { recursive: true });
    writeFileSync(join(w, "gdrive-data-bisync.sh"), readFileSync(DATA_SCRIPT, "utf8"));
    writeFileSync(
      join(w, "gdrive-bisync.sh"),
      [
        "#!/bin/sh",
        "for v in GDRIVE_REMOTE GDRIVE_LOCAL GDRIVE_MOUNT GDRIVE_FILTERS GDRIVE_STATE_DIR GDRIVE_WORKDIR GDRIVE_MAX_DELETE; do",
        '  eval "printf \'%s=%s\\n\' $v \\"\\${$v-}\\""',
        "done",
        "",
      ].join("\n"),
    );
    const r = spawnSync("/bin/sh", [join(w, "gdrive-data-bisync.sh")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sb, ...env },
    });
    const vars: Record<string, string> = {};
    for (const line of r.stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) vars[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return { status: r.status, vars, stderr: r.stderr };
  }

  const ALL_FILE = (sb: string) =>
    [
      "GDRIVE_DATA_REMOTE=conta-x:pasta-x",
      `GDRIVE_DATA_LOCAL=${sb}/l`,
      `GDRIVE_DATA_MOUNT=${sb}/m`,
      `GDRIVE_DATA_FILTERS=${sb}/f.txt`,
      `GDRIVE_DATA_STATE_DIR=${sb}/st`,
      `GDRIVE_DATA_WORKDIR=${sb}/wd`,
      "GDRIVE_DATA_MAX_DELETE=12",
      "",
    ].join("\n");

  type Case = { name: string; file?: (sb: string) => string; env?: (sb: string) => Record<string, string>; invalid?: boolean };
  const cases: Case[] = [
    { name: "defaults (sem arquivo)" },
    { name: "arquivo com todas as chaves", file: ALL_FILE },
    { name: "arquivo com CRLF", file: (sb) => ALL_FILE(sb).replaceAll("\n", "\r\n") },
    {
      name: "ambiente com todas as chaves",
      env: (sb) => ({
        GDRIVE_DATA_REMOTE: "conta-y:pasta-y",
        GDRIVE_DATA_LOCAL: `${sb}/l2`,
        GDRIVE_DATA_MOUNT: `${sb}/m2`,
        GDRIVE_DATA_FILTERS: `${sb}/f2.txt`,
        GDRIVE_DATA_STATE_DIR: `${sb}/st2`,
        GDRIVE_DATA_WORKDIR: `${sb}/wd2`,
        GDRIVE_DATA_MAX_DELETE: "3",
      }),
    },
    { name: "ambiente vence arquivo", file: ALL_FILE, env: (sb) => ({ GDRIVE_DATA_REMOTE: "do-env:p", GDRIVE_DATA_STATE_DIR: `${sb}/st-env` }) },
    { name: "ambiente vazio vence arquivo e cai no default", file: ALL_FILE, env: () => ({ GDRIVE_DATA_STATE_DIR: "", GDRIVE_DATA_MOUNT: "" }) },
    { name: "só MOUNT no arquivo (LOCAL deriva dele)", file: (sb) => `GDRIVE_DATA_MOUNT=${sb}/m3\n` },
    { name: "valor com $() fica literal", file: (sb) => `GDRIVE_DATA_REMOTE=conta-z:$(touch ${sb}/pwned)\n` },
    { name: "chave desconhecida", file: () => "OUTRA=1\n", invalid: true },
    { name: "chave repetida", file: () => "GDRIVE_DATA_MAX_DELETE=1\nGDRIVE_DATA_MAX_DELETE=2\n", invalid: true },
    { name: "espaço em volta do =", file: () => "GDRIVE_DATA_MAX_DELETE = 1\n", invalid: true },
    { name: "LOCAL relativo", file: () => "GDRIVE_DATA_LOCAL=rel/x\n", invalid: true },
    { name: "remote igual ao grande", file: () => "GDRIVE_DATA_REMOTE=gdrive:x\n", invalid: true },
    { name: "pasta dentro do espelho", env: () => ({ GDRIVE_DATA_LOCAL: "/mnt/hd-sata/GoogleDrive/x" }), invalid: true },
    { name: "GDRIVE_DATA_ENV_FILE inexistente", env: (sb) => ({ GDRIVE_DATA_ENV_FILE: `${sb}/nao.env` }), invalid: true },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const sb = mkdtempSync(join(tmpdir(), "gdrive-data-diff-12478-"));
      try {
        if (c.file) {
          mkdirSync(join(sb, ".config", "diaria"), { recursive: true });
          writeFileSync(join(sb, ".config", "diaria", "gdrive-data-bisync.env"), c.file(sb));
        }
        const env = c.env ? c.env(sb) : {};
        const sh = shellResolve(sb, env);
        const ts = resolveDataBisyncConfig({ HOME: sb, ...env }, undefined, join(sb, "w"));
        assert.equal(sh.status === 78, ts.errors.length > 0, `shell exit ${sh.status} (${sh.stderr.trim()}) × TS ${JSON.stringify(ts.errors)}`);
        assert.equal(sh.status === 78, c.invalid === true, `${c.name}: shell exit ${sh.status} ${sh.stderr}`);
        assert.equal(existsSync(join(sb, "pwned")), false);
        if (c.invalid) return;
        assert.equal(sh.status, 0, sh.stderr);
        assert.deepEqual(sh.vars, {
          GDRIVE_REMOTE: ts.remote,
          GDRIVE_LOCAL: ts.local,
          GDRIVE_MOUNT: ts.mount,
          GDRIVE_FILTERS: ts.filters,
          GDRIVE_STATE_DIR: ts.stateDir,
          GDRIVE_WORKDIR: ts.workdir,
          GDRIVE_MAX_DELETE: ts.maxDelete ?? "",
        });
      } finally {
        rmSync(sb, { recursive: true, force: true });
      }
    });
  }

  it("a lista de chaves do wrapper (KEYS) é a do TS", () => {
    const m = /^KEYS="([A-Z_ ]+)"$/m.exec(readFileSync(DATA_SCRIPT, "utf8"));
    assert.deepEqual(m?.[1].split(" "), [...DATA_BISYNC_ENV_KEYS]);
    assert.equal(DEFAULT_DATA_BISYNC_REMOTE, "gdrive-diaria:diaria-studio-data");
    assert.equal(`${DEFAULT_DATA_BISYNC_MOUNT}/${DEFAULT_DATA_BISYNC_LOCAL_REL}`, "/mnt/hd-sata/GoogleDrive-diaria/diaria-studio-data");
  });
});

describe("alarme de data/: dependência, configuração, cota e textos (#12478)", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const ok = evaluateGdriveSync({ kind: "ok", stamp: { at: ago(1), exit: 0 } }, { kind: "ok", stamp: { at: ago(1), exit: 0 } }, now);
  const notInstalled = evaluateGdriveSync({ kind: "absent" }, { kind: "absent" }, now, DATA_GDRIVE_SYNC_TOLERANCES);
  const QUOTA_OK = evaluateGdriveQuota({ total: 100, used: 10, free: 90, trashed: 0, other: 0 }, 90);
  const LOCAL = "/mnt/hd-sata/GoogleDrive-diaria/diaria-studio-data";
  const baseInputs = {
    sync: ok,
    quota: QUOTA_OK,
    quotaError: null,
    backend: "gdrive" as const,
    dataCfg: { errors: [] as string[], envFile: "/h/.config/diaria/gdrive-data-bisync.env", local: LOCAL, remoteName: "gdrive-diaria:" },
    dataSync: notInstalled,
    dataTarget: DATA_BISYNC_TARGET,
    dataDirReal: null as string | null,
    dataQuota: null,
    dataQuotaError: null,
  };

  it("data/ dentro da pasta do bisync de data/ + sem carimbo → achado; fora dele → silêncio", () => {
    assert.equal(notInstalled.verdict, "not-installed");
    const dep = collectGdriveAlarmFindings({ ...baseInputs, dataDirReal: LOCAL });
    assert.deepEqual(dep.findings.map((f) => `${f.check}:${f.fingerprint}`), [`${DATA_SYNC_CHECK}:${DATA_BISYNC_MISSING}`]);
    assert.equal(dep.findings[0]!.priority, "P1");
    assert.equal(collectGdriveAlarmFindings({ ...baseInputs, dataDirReal: `${LOCAL}/sub` }).findings.length, 1);
    // Antes do cutover: data/ no OneDrive, ou não resolve.
    assert.equal(collectGdriveAlarmFindings({ ...baseInputs, dataDirReal: "/home/vj/OneDrive/diaria-studio-data" }).findings.length, 0);
    assert.equal(collectGdriveAlarmFindings({ ...baseInputs, dataDirReal: `${LOCAL}-outro` }).findings.length, 0);
    assert.equal(collectGdriveAlarmFindings({ ...baseInputs, dataDirReal: null }).findings.length, 0);
    assert.equal(dataDirDependsOnDataBisync("/x", "relativo"), false);
  });

  it("fiação: sem carimbo de data/ as issues de data/ congelam; com carimbo, não", () => {
    const frozen = collectGdriveAlarmFindings(baseInputs).isAbsenceUnmeasured;
    assert.equal(frozen(alarmIssueStateKey(DATA_SYNC_CHECK, "alarm-sync-stale")), true);
    assert.equal(frozen(alarmIssueStateKey(DATA_QUOTA_CHECK, "quota-near")), true);
    const live = collectGdriveAlarmFindings({ ...baseInputs, dataSync: ok, dataQuota: QUOTA_OK }).isAbsenceUnmeasured;
    assert.equal(live(alarmIssueStateKey(DATA_SYNC_CHECK, "alarm-sync-stale")), false);
    assert.equal(live(alarmIssueStateKey(DATA_QUOTA_CHECK, "quota-near")), false);
  });

  it("configuração inválida vira achado próprio, com os erros no corpo", () => {
    const r = collectGdriveAlarmFindings({ ...baseInputs, dataCfg: { ...baseInputs.dataCfg, errors: ["GDRIVE_DATA_LOCAL precisa ser caminho absoluto (x)"] } });
    const f = r.findings.find((x) => x.check === DATA_CONFIG_CHECK);
    assert.ok(f);
    assert.match(f!.body, /GDRIVE_DATA_LOCAL precisa ser caminho absoluto/);
    assert.match(f!.body, /gdrive-data-bisync\.env/);
  });

  it("cota da conta de data/: achado próprio com o remote de data/", () => {
    const near = evaluateGdriveQuota({ total: 100, used: 95, free: 5, trashed: 0, other: 0 }, 90);
    const r = collectGdriveAlarmFindings({ ...baseInputs, dataSync: ok, dataQuota: near });
    const f = r.findings.find((x) => x.check === DATA_QUOTA_CHECK);
    assert.ok(f, JSON.stringify(r.findings.map((x) => x.check)));
    assert.equal(f!.fingerprint, "quota-near");
    assert.match(f!.title, /gdrive-diaria:/);
    assert.match(f!.body, /gdrive-diaria:/);
    // Sem medida (instalado mas o about falhou) → quota-unmeasured de data/.
    const um = collectGdriveAlarmFindings({ ...baseInputs, dataSync: ok, dataQuota: evaluateGdriveQuota(null, 90), dataQuotaError: "token" });
    assert.equal(um.findings.find((x) => x.check === DATA_QUOTA_CHECK)?.fingerprint, "quota-unmeasured");
  });

  it("textos do alvo data/ usam unit, state dir, mount e arquivo de env efetivos — nunca os do bisync grande", () => {
    const t = dataBisyncTarget({ remote: "gdrive-diaria:diaria-studio-data", local: "/m/l", stateDir: "/s/gdrive-data-bisync", mount: "/m", envFile: "/cfg/x.env" });
    const evs = [
      evaluateGdriveSync({ kind: "unreadable", reason: "lixo" }, { kind: "absent" }, now, DATA_GDRIVE_SYNC_TOLERANCES),
      evaluateGdriveSync({ kind: "ok", stamp: { at: ago(1), exit: 75 } }, { kind: "ok", stamp: { at: ago(60), exit: 0 } }, now, DATA_GDRIVE_SYNC_TOLERANCES),
      evaluateGdriveSync({ kind: "ok", stamp: { at: ago(1), exit: 3 } }, { kind: "ok", stamp: { at: ago(60), exit: 0 } }, now, DATA_GDRIVE_SYNC_TOLERANCES),
      evaluateGdriveSync({ kind: "ok", stamp: { at: ago(1), exit: 0 } }, { kind: "ok", stamp: { at: ago(60), exit: 0 } }, now, DATA_GDRIVE_SYNC_TOLERANCES),
    ];
    assert.deepEqual(
      evs.map((e) => e.verdict),
      ["alarm-stamp-unreadable", "alarm-bisync-blocked", "alarm-bisync-failed", "alarm-sync-stale"],
    );
    for (const ev of evs) {
      const text = describeGdriveSyncVerdict(ev, t);
      assert.match(text, /diaria-gdrive-data-bisync/, ev.verdict);
      assert.doesNotMatch(text, /diaria-gdrive-bisync\.timer|diaria-gdrive-bisync[ `]/, ev.verdict);
      assert.doesNotMatch(text, /\.cache\/diaria\/gdrive-bisync\//, ev.verdict);
      assert.doesNotMatch(text, /\/mnt\/hd-sata/, ev.verdict);
      assert.doesNotMatch(text, /scripts\/systemd\/gdrive-bisync\.sh/, ev.verdict);
    }
    assert.match(describeGdriveSyncVerdict(evs[0]!, t), /ls -l \/s\/gdrive-data-bisync\//);
    assert.match(describeGdriveSyncVerdict(evs[1]!, t), /mountpoint \/m`/);
    assert.match(describeGdriveSyncVerdict(evs[1]!, t), /\/cfg\/x\.env/);
  });

  it(
    "CLI: issue de data/ aberta + state dir de data/ sumido → congelada (0 ação); com carimbo novo → comenta resolvido",
    { skip: process.platform === "win32" ? "rclone falso é shell" : false },
    () => {
      const sb = mkdtempSync(join(tmpdir(), "gdrive-data-alarm-freeze-12478-"));
      try {
        const big = join(sb, "big");
        mkdirSync(big);
        const fresh = new Date().toISOString();
        writeFileSync(join(big, "last-run.json"), JSON.stringify({ at: fresh, exit: 0 }));
        writeFileSync(join(big, "last-success.json"), JSON.stringify({ at: fresh, exit: 0 }));
        writeFileSync(
          join(big, ".gdrive-sync-alarm-issues.json"),
          JSON.stringify({
            [alarmIssueStateKey(DATA_SYNC_CHECK, "alarm-sync-stale")]: { issueNumber: 1, url: "u", missingStreak: 0, closedAt: null, family: "estado" },
          }),
        );
        const fake = join(sb, "rclone");
        writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${join(sb, "rclone.log")}"\necho '{"total":100,"used":10,"free":90}'\n`);
        chmodSync(fake, 0o755);
        const runCli = (dataState: string) =>
          spawnSync(
            process.execPath,
            ["--import", "tsx", join(ROOT, "scripts", "gdrive-sync-alarm.ts"), "--dry-run", "--state-dir", big, "--data-state-dir", dataState, "--data-dir", join(sb, "sem-data")],
            { encoding: "utf8", cwd: ROOT, env: cliEnv(sb, { RCLONE_BIN: fake }) },
          );
        const gone = runCli(join(sb, "data-sumiu"));
        assert.equal(gone.status, 0, gone.stderr);
        assert.match(gone.stdout, /sync data\/: verdict=not-installed/);
        assert.match(gone.stdout, /--dry-run: 0 ação/);
        // Sem carimbo de data/, a cota da conta de data/ não é medida.
        assert.doesNotMatch(readFileSync(join(sb, "rclone.log"), "utf8"), /gdrive-diaria:/);

        const data = join(sb, "data-ok");
        mkdirSync(data);
        writeFileSync(join(data, "last-run.json"), JSON.stringify({ at: fresh, exit: 0 }));
        writeFileSync(join(data, "last-success.json"), JSON.stringify({ at: fresh, exit: 0 }));
        const back = runCli(data);
        assert.equal(back.status, 0, back.stderr);
        assert.match(back.stdout, /--dry-run: 1 ação\(ões\) de issue seriam tomadas \(comment_resolved\)/);
        // Com carimbo, a cota da conta de data/ é medida no remote de data/.
        assert.match(readFileSync(join(sb, "rclone.log"), "utf8"), /about gdrive-diaria: /);
      } finally {
        rmSync(sb, { recursive: true, force: true });
      }
    },
  );
});
