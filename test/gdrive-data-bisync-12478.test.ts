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
import {
  toSyncAlarmFinding,
  toDataSyncAlarmFinding,
  absenceUnmeasured,
  buildGdriveAlarmEmail,
  defaultGdriveDataStateDir,
  DATA_SYNC_CHECK,
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

  it("defaults do shell = defaults do lado TS (gdrive-diaria:diaria-studio-data, /mnt/hd-sata/GoogleDrive-diaria/diaria-studio-data)", () => {
    const sh = readFileSync(DATA_SCRIPT, "utf8");
    assert.equal(DEFAULT_DATA_BISYNC_REMOTE, "gdrive-diaria:diaria-studio-data");
    assert.equal(DEFAULT_DATA_BISYNC_MOUNT, "/mnt/hd-sata");
    assert.equal(DEFAULT_DATA_BISYNC_LOCAL_REL, "GoogleDrive-diaria/diaria-studio-data");
    assert.ok(sh.includes(`GDRIVE_DATA_REMOTE:-${DEFAULT_DATA_BISYNC_REMOTE}}`));
    assert.ok(sh.includes(`GDRIVE_DATA_LOCAL:-$MOUNT_DEFAULT/${DEFAULT_DATA_BISYNC_LOCAL_REL}}`));
    assert.ok(sh.includes(`GDRIVE_DATA_MOUNT:-${DEFAULT_DATA_BISYNC_MOUNT}}`));
    // A lista de chaves aceitas no arquivo é a mesma nos dois lados.
    const shKeys = /^\s*(GDRIVE_DATA_[A-Z_|]+)\)$/m.exec(sh)?.[1].split("|");
    assert.deepEqual(shKeys, [...DATA_BISYNC_ENV_KEYS]);
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
        "CHAVE_DESCONHECIDA=ignorada",
      ].join("\n"),
    });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.calls.length, 1);
      assert.ok(
        r.calls[0].startsWith(`bisync gdrive-diaria:diaria-studio-data ${join(r.sb, "GoogleDrive-diaria", "diaria-studio-data")} `),
        r.calls[0],
      );
      assert.match(r.stderr, /CHAVE_DESCONHECIDA/);
    } finally {
      rmSync(r.sb, { recursive: true, force: true });
    }
  });

  it("o arquivo de env nunca é executado como shell", () => {
    const r = run(DATA_SCRIPT, {
      env: DATA_DEFAULT_ENV,
      localRel: "GoogleDrive-diaria/diaria-studio-data",
      envFile: "GDRIVE_DATA_REMOTE=gdrive:x$(touch {SB}/pwned)\n`touch {SB}/pwned2`\n",
    });
    try {
      assert.equal(r.exists("pwned"), false);
      assert.equal(r.exists("pwned2"), false);
      // O valor chega literal ao rclone (e o rclone recusaria um remote assim).
      assert.ok(r.calls[0].startsWith(`bisync gdrive:x$(touch ${r.sb}/pwned) `), r.calls[0]);
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
    assert.match(svc, /^TimeoutStartSec=/m);
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
    const f = absenceUnmeasured("ok", "ok", "not-installed");
    assert.equal(f(alarmIssueStateKey(DATA_SYNC_CHECK, "alarm-sync-stale")), true);
    assert.equal(f(alarmIssueStateKey(DATA_SYNC_CHECK, "alarm-stamp-unreadable")), true);
    assert.equal(f(alarmIssueStateKey(SYNC_CHECK, "alarm-sync-stale")), false);
    const g = absenceUnmeasured("not-installed", "ok", "ok");
    assert.equal(g(alarmIssueStateKey(SYNC_CHECK, "alarm-sync-stale")), true);
    assert.equal(g(alarmIssueStateKey(DATA_SYNC_CHECK, "alarm-sync-stale")), false);
    // Forma antiga (sem o 3º argumento): nada de data/ congela.
    assert.equal(absenceUnmeasured("ok", "ok")(alarmIssueStateKey(DATA_SYNC_CHECK, "alarm-sync-stale")), false);
  });

  it("e-mail junta os dois sinais de sync", () => {
    const big = evaluateGdriveSync({ at: ago(1), exit: 75 }, { at: ago(120), exit: 0 }, now);
    const data = evalData(0, 60);
    const outcomes = [
      { check: SYNC_CHECK, fingerprint: big.verdict, action: "created", issueNumber: 1, url: "u1" },
      { check: DATA_SYNC_CHECK, fingerprint: data.verdict, action: "created", issueNumber: 2, url: "u2" },
    ] as unknown as AlarmFindingOutcome[];
    const e = buildGdriveAlarmEmail(outcomes, big, QUOTA_OK, null, data);
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

  it("parser do arquivo de env: mesmas regras do wrapper (comentário, CRLF, sem '=', chave desconhecida, 1ª vence, nunca avalia)", () => {
    const p = parseDataBisyncEnvFile(
      "# c\r\n\nGDRIVE_DATA_REMOTE=a:b\r\nsem-igual\nOUTRA=1\nGDRIVE_DATA_REMOTE=c:d\nGDRIVE_DATA_LOCAL=/x/$(touch y)=z",
    );
    assert.deepEqual(p.values, { GDRIVE_DATA_REMOTE: "a:b", GDRIVE_DATA_LOCAL: "/x/$(touch y)=z" });
    assert.equal(p.warnings.length, 2);
    assert.match(p.warnings.join(" "), /OUTRA/);
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
          ["--import", "tsx", join(ROOT, "scripts", "gdrive-sync-alarm.ts"), "--dry-run", "--state-dir", big, "--data-state-dir", data],
          { encoding: "utf8", cwd: ROOT, env: { ...process.env, RCLONE_BIN: fake, GDRIVE_DATA_ENV_FILE: join(sb, "nao-existe.env") } },
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
        const env: NodeJS.ProcessEnv = { ...process.env, RCLONE_BIN: fake, GDRIVE_DATA_ENV_FILE: envFile };
        delete env.GDRIVE_DATA_STATE_DIR;
        const r = spawnSync(
          process.execPath,
          ["--import", "tsx", join(ROOT, "scripts", "gdrive-sync-alarm.ts"), "--dry-run", "--state-dir", big],
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
