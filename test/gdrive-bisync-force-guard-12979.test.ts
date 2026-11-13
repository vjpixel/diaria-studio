/**
 * test/gdrive-bisync-force-guard-12979.test.ts (#12979, #12590)
 *
 * #12979: `gdrive-bisync.sh --force` (o destrave do "too many deletes")
 * apagaria do Drive arquivos de OUTRA conta quando uma pasta compartilhada
 * some do espelho (sessão de 12/11/2026: 57 arquivos, 29 GiB). O script agora
 * roda antes a mesma rodada com `--dry-run`, lê as exclusões do lado do Drive
 * (Path1) e recusa se alguma for de arquivo cujo dono não é a conta do remote
 * (dona da sentinela do Drive), salvo `--allow-foreign-deletes`.
 *
 * #12590: resync automático do 401 (#12412) que falha (rede caiu no meio)
 * deixava o bisync travado para sempre; agora fica pendente e a próxima rodada
 * do timer o retoma, com teto.
 *
 * Roda o script real com um `rclone` falso (nunca o Drive). Um caso extra usa
 * o rclone de verdade entre duas pastas temporárias, quando ele existe na
 * máquina, para travar o formato real do log do `--dry-run`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "systemd", "gdrive-bisync.sh");
const ESC = "\u001b";
const ACCOUNT = "dono@exemplo.test";

/** Linha de exclusão no formato real do rclone 1.75 (com cores ANSI). */
function deleteLine(side: "Path1" | "Path2", path: string): string {
  return `2026/11/13 20:16:58 NOTICE: - ${ESC}[36m${side}${ESC}[0m    ${ESC}[35m${ESC}[31mQueue delete${ESC}[0m${ESC}[0m              - ${ESC}[36m${path}${ESC}[0m`;
}

function runForce(opts: {
  /** Saída do `bisync --dry-run` da pré-checagem. */
  dryRunOut: string;
  dryRunExit?: number;
  /** caminho → dono (lsjson -M). Caminho sem entrada = dono ilegível. */
  owners: Record<string, string>;
  args: string[];
  env?: Record<string, string>;
}) {
  const sb = mkdtempSync(join(tmpdir(), "gdrive-bisync-12979-"));
  const local = join(sb, "GoogleDrive");
  mkdirSync(local);
  writeFileSync(join(local, ".diaria-bisync-sentinel"), "");
  const stateDir = join(sb, "state");
  const calls = join(sb, "calls.log");
  const dryOut = join(sb, "dry.out");
  writeFileSync(dryOut, opts.dryRunOut);
  const ownersFile = join(sb, "owners.tsv");
  writeFileSync(ownersFile, Object.entries(opts.owners).map(([p, o]) => `${p}\t${o}\n`).join(""));
  const fake = join(sb, "rclone");
  writeFileSync(
    fake,
    [
      "#!/bin/sh",
      `echo "$@" >> "${calls}"`,
      'if [ "$1" = lsjson ]; then',
      '  for last; do :; done',
      `  o=$(awk -F '\\t' -v p="$last" '$1==p{print $2}' "${ownersFile}")`,
      '  if [ -n "$o" ]; then echo "{\\"Path\\":\\"x\\",\\"Metadata\\":{\\"owner\\":\\"$o\\"}}"; else echo "{\\"Path\\":\\"x\\"}"; fi',
      "  exit 0",
      "fi",
      'case " $* " in',
      `  *" --dry-run "*) cat "${dryOut}"; exit ${opts.dryRunExit ?? 0} ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  const r = spawnSync("/bin/sh", [SCRIPT, ...opts.args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sb,
      GDRIVE_MOUNT: sb,
      GDRIVE_LOCAL: local,
      RCLONE_BIN: fake,
      GDRIVE_MOUNTPOINT_CMD: "true",
      GDRIVE_STATE_DIR: stateDir,
      ...(opts.env ?? {}),
    },
  });
  const lines = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  const bisyncCalls = lines.filter((l) => l.startsWith("bisync "));
  const out = {
    status: r.status,
    stderr: r.stderr,
    bisyncCalls,
    realRun: bisyncCalls.some((l) => !/ --dry-run( |$)/.test(l)),
    lastRunStamped: existsSync(join(stateDir, "last-run.json")),
  };
  rmSync(sb, { recursive: true, force: true });
  return out;
}

const SENTINEL_PATH = "gdrive:.diaria-bisync-sentinel";

describe("gdrive-bisync.sh --force: guard contra apagar arquivo de outro dono (#12979)", { skip: process.platform === "win32" ? "script POSIX-only" : false }, () => {
  it("cenário da issue: pasta compartilhada sumiu do espelho → --force recusa (exit 75), lista o arquivo e nunca roda de verdade", () => {
    const r = runForce({
      dryRunOut: [
        deleteLine("Path1", "gdrive:/Work/Mentoria/YouTube/aula1.mp4"),
        deleteLine("Path1", "gdrive:/Work/Mentoria/YouTube/aula2.mp4"),
      ].join("\n"),
      owners: {
        [SENTINEL_PATH]: ACCOUNT,
        "gdrive:/Work/Mentoria/YouTube/aula1.mp4": "terceira@outra.test",
        "gdrive:/Work/Mentoria/YouTube/aula2.mp4": "terceira@outra.test",
      },
      args: ["--force"],
    });
    assert.equal(r.status, 75, r.stderr);
    assert.equal(r.realRun, false, "o --force não pode rodar sem --dry-run");
    assert.equal(r.bisyncCalls.length, 1);
    assert.match(r.bisyncCalls[0], / --force .*--dry-run|--dry-run.* --force/);
    assert.match(r.stderr, /RECUSADO/);
    assert.match(r.stderr, /terceira@outra\.test\tgdrive:\/Work\/Mentoria\/YouTube\/aula1\.mp4/);
    assert.equal(r.lastRunStamped, false, "recusa não é rodada do timer: não carimba");
  });

  it("todas as exclusões no Drive são da conta do remote (dona da sentinela) → segue com a rodada real", () => {
    const r = runForce({
      dryRunOut: deleteLine("Path1", "gdrive:/Pessoal/velho.txt"),
      owners: { [SENTINEL_PATH]: ACCOUNT, "gdrive:/Pessoal/velho.txt": "Dono@Exemplo.test" },
      args: ["--force"],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.realRun, true);
    assert.match(r.bisyncCalls.at(-1) ?? "", / --force/);
    assert.doesNotMatch(r.bisyncCalls.at(-1) ?? "", /--dry-run|--allow-foreign-deletes/);
  });

  it("dono ilegível conta como alheio (fail-closed)", () => {
    const r = runForce({
      dryRunOut: deleteLine("Path1", "gdrive:/sem-metadata.bin"),
      owners: { [SENTINEL_PATH]: ACCOUNT },
      args: ["--force"],
    });
    assert.equal(r.status, 75);
    assert.equal(r.realRun, false);
    assert.match(r.stderr, /dono-ilegivel/);
  });

  it("sentinela sem dono legível e sem GDRIVE_ACCOUNT_OWNER → recusa", () => {
    const r = runForce({
      dryRunOut: deleteLine("Path1", "gdrive:/a.txt"),
      owners: { "gdrive:/a.txt": ACCOUNT },
      args: ["--force"],
    });
    assert.equal(r.status, 75);
    assert.equal(r.realRun, false);
  });

  it("GDRIVE_ACCOUNT_OWNER no ambiente vale no lugar do dono da sentinela", () => {
    const r = runForce({
      dryRunOut: deleteLine("Path1", "gdrive:/a.txt"),
      owners: { "gdrive:/a.txt": ACCOUNT },
      args: ["--force"],
      env: { GDRIVE_ACCOUNT_OWNER: ACCOUNT },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.realRun, true);
  });

  it("--allow-foreign-deletes libera e nunca chega ao rclone como flag", () => {
    const r = runForce({
      dryRunOut: deleteLine("Path1", "gdrive:/Work/x.mp4"),
      owners: { [SENTINEL_PATH]: ACCOUNT, "gdrive:/Work/x.mp4": "terceira@outra.test" },
      args: ["--force", "--allow-foreign-deletes"],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.realRun, true);
    for (const c of r.bisyncCalls) assert.doesNotMatch(c, /allow-foreign-deletes/);
  });

  it("exclusões só do lado do disco (Path2) não contam como exclusão no Drive", () => {
    const r = runForce({
      dryRunOut: deleteLine("Path2", "/mnt/hd-sata/GoogleDrive/apagado-na-nuvem.txt"),
      owners: {},
      args: ["--force"],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.realRun, true);
    assert.match(r.stderr, /nenhuma exclusao no Drive/);
  });

  it("pré-checagem que falha → recusa, sem rodada real", () => {
    const r = runForce({ dryRunOut: "ERROR : boom\n", dryRunExit: 7, owners: {}, args: ["--force"] });
    assert.equal(r.status, 75);
    assert.equal(r.realRun, false);
    assert.match(r.stderr, /pre-checagem/);
  });

  it("mais exclusões que o teto de consulta → recusa sem consultar dono por dono", () => {
    const r = runForce({
      dryRunOut: [deleteLine("Path1", "gdrive:/a"), deleteLine("Path1", "gdrive:/b"), deleteLine("Path1", "gdrive:/c")].join("\n"),
      owners: { [SENTINEL_PATH]: ACCOUNT, "gdrive:/a": ACCOUNT, "gdrive:/b": ACCOUNT, "gdrive:/c": ACCOUNT },
      args: ["--force"],
      env: { GDRIVE_FORCE_OWNER_CHECK_MAX: "2" },
    });
    assert.equal(r.status, 75);
    assert.equal(r.realRun, false);
    assert.match(r.stderr, /acima do teto/);
  });

  it("--dry-run --force não passa pelo guard (já é só pré-visualização)", () => {
    const r = runForce({
      dryRunOut: deleteLine("Path1", "gdrive:/Work/x.mp4"),
      owners: {},
      args: ["--dry-run", "--force"],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.bisyncCalls.length, 1);
  });

  it("sem --force, nenhuma pré-checagem", () => {
    const r = runForce({ dryRunOut: deleteLine("Path1", "gdrive:/x"), owners: {}, args: [] });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.bisyncCalls.length, 1);
    assert.doesNotMatch(r.bisyncCalls[0], /--dry-run/);
  });
});

// Formato real do log: o rclone de verdade entre duas pastas locais
// temporárias (nada de Drive). Pasta local não tem `owner` no metadata, então
// toda exclusão do lado Path1 conta como dono ilegível e o --force recusa.
const REAL_RCLONE = process.env.RCLONE_BIN ?? join(homedir(), ".local", "bin", "rclone");
const realRcloneOk = existsSync(REAL_RCLONE) && spawnSync(REAL_RCLONE, ["version"], { encoding: "utf8" }).status === 0;

describe("gdrive-bisync.sh --force com o rclone real em pastas temporárias (#12979)", { skip: process.platform === "win32" ? "script POSIX-only" : !realRcloneOk ? "rclone ausente nesta máquina" : false }, () => {
  function setup() {
    const sb = mkdtempSync(join(tmpdir(), "gdrive-bisync-12979-real-"));
    const p1 = join(sb, "nuvem");
    const p2 = join(sb, "espelho");
    mkdirSync(join(p1, "Compartilhada"), { recursive: true });
    mkdirSync(p2);
    for (let i = 1; i <= 6; i++) writeFileSync(join(p1, "Compartilhada", `f${i}.txt`), String(i));
    writeFileSync(join(p1, ".diaria-bisync-sentinel"), "");
    writeFileSync(join(p2, ".diaria-bisync-sentinel"), "");
    const filters = join(sb, "filters.txt");
    writeFileSync(filters, "- *.tmp\n");
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sb,
      GDRIVE_MOUNT: sb,
      GDRIVE_LOCAL: p2,
      GDRIVE_REMOTE: `${p1}/`,
      GDRIVE_FILTERS: filters,
      GDRIVE_STATE_DIR: join(sb, "state"),
      GDRIVE_WORKDIR: join(sb, "workdir"),
      RCLONE_BIN: REAL_RCLONE,
      GDRIVE_MOUNTPOINT_CMD: "true",
    };
    // Carga inicial: o resync copia tudo (inclusive a sentinela) para o espelho.
    const init = spawnSync("/bin/sh", [SCRIPT, "--resync"], { encoding: "utf8", env });
    assert.equal(init.status, 0, init.stderr);
    // A pasta compartilhada some do espelho: 6 de 7 arquivos, acima do --max-delete.
    rmSync(join(p2, "Compartilhada"), { recursive: true });
    return { sb, p1, env };
  }

  it("--force recusa e a pasta segue na 'nuvem'; --allow-foreign-deletes apaga", () => {
    const { sb, p1, env } = setup();
    try {
      const refused = spawnSync("/bin/sh", [SCRIPT, "--force"], { encoding: "utf8", env });
      assert.equal(refused.status, 75, refused.stderr);
      // 6 arquivos + a pasta (o bisync roda com --create-empty-src-dirs).
      assert.match(refused.stderr, /7 exclusao\(oes\) no Drive/);
      assert.match(refused.stderr, /dono-ilegivel\t\S+\/nuvem\/Compartilhada\/f1\.txt/);
      assert.ok(existsSync(join(p1, "Compartilhada", "f1.txt")), "o --force recusado não pode apagar nada");

      const allowed = spawnSync("/bin/sh", [SCRIPT, "--force", "--allow-foreign-deletes"], { encoding: "utf8", env });
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.equal(existsSync(join(p1, "Compartilhada", "f1.txt")), false);
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});

/** Rclone falso com sequência de exits programada (mesmo molde do teste do #12412). */
function runSeq(opts: { seq: string[]; args?: string[]; pending?: string; env?: Record<string, string> }) {
  const sb = mkdtempSync(join(tmpdir(), "gdrive-bisync-12590-"));
  const local = join(sb, "GoogleDrive");
  mkdirSync(local);
  writeFileSync(join(local, ".diaria-bisync-sentinel"), "");
  const stateDir = join(sb, "state");
  mkdirSync(stateDir);
  if (opts.pending !== undefined) writeFileSync(join(stateDir, "resync-pending"), opts.pending);
  const calls = join(sb, "calls.log");
  const counter = join(sb, "counter");
  const fake = join(sb, "rclone");
  writeFileSync(
    fake,
    [
      "#!/bin/sh",
      `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
      "n=$((n + 1))",
      `echo "$n" > "${counter}"`,
      `echo "$@" >> "${calls}"`,
      `spec=$(echo "${opts.seq.join(",")}" | cut -d, -f"$n")`,
      '[ -n "$spec" ] || spec=0',
      'case "$spec" in *:auth) echo "ERROR : x: googleapi: Error 401: Invalid Credentials, authError" >&2 ;; esac',
      'exit "${spec%%:*}"',
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  const r = spawnSync("/bin/sh", [SCRIPT, ...(opts.args ?? [])], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sb,
      GDRIVE_MOUNT: sb,
      GDRIVE_LOCAL: local,
      RCLONE_BIN: fake,
      GDRIVE_MOUNTPOINT_CMD: "true",
      GDRIVE_STATE_DIR: stateDir,
      GDRIVE_AUTH_RETRY_DELAY: "0",
      ...(opts.env ?? {}),
    },
  });
  const pendingPath = join(stateDir, "resync-pending");
  const out = {
    status: r.status,
    stderr: r.stderr,
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    pending: existsSync(pendingPath) ? readFileSync(pendingPath, "utf8") : null,
  };
  rmSync(sb, { recursive: true, force: true });
  return out;
}

describe("gdrive-bisync.sh: resync automático que falha fica pendente (#12590)", { skip: process.platform === "win32" ? "script POSIX-only" : false }, () => {
  it("cenário de 13/11: 401 → resync automático cai (rede) → marcador gravado", () => {
    const r = runSeq({ seq: ["7:auth", "7"] });
    assert.equal(r.status, 7);
    assert.equal(r.pending, "attempts=0\n");
    assert.match(r.stderr, /proxima rodada do timer tenta de novo/);
  });

  it("rodada seguinte do timer com marcador → roda o resync (newer) e, com exit 0, apaga o marcador", () => {
    const r = runSeq({ seq: ["0"], pending: "attempts=0\n" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 1);
    assert.match(r.calls[0], /--resync --resync-mode newer/);
    assert.match(r.calls[0], /--check-access/);
    assert.equal(r.pending, null);
  });

  it("resync pendente que falha de novo conta a tentativa e mantém o marcador", () => {
    const r = runSeq({ seq: ["7"], pending: "attempts=1\n" });
    assert.equal(r.status, 7);
    assert.equal(r.pending, "attempts=2\n");
  });

  it("tentativas esgotadas → rodada normal, marcador fica, aviso pede resync manual", () => {
    const r = runSeq({ seq: ["7"], pending: "attempts=3\n" });
    assert.equal(r.status, 7);
    assert.doesNotMatch(r.calls[0], /--resync/);
    assert.equal(r.pending, "attempts=3\n");
    assert.match(r.stderr, /esgotou 3 tentativas/);
  });

  it("GDRIVE_PENDING_RESYNC_MAX=0 desliga a retomada", () => {
    const r = runSeq({ seq: ["7"], pending: "attempts=0\n", env: { GDRIVE_PENDING_RESYNC_MAX: "0" } });
    assert.doesNotMatch(r.calls[0], /--resync/);
  });

  it("--dry-run com marcador não faz resync nem mexe no marcador", () => {
    const r = runSeq({ seq: ["0"], pending: "attempts=1\n", args: ["--dry-run"] });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.calls[0], /--resync/);
    assert.equal(r.pending, "attempts=1\n");
  });

  it("rodada normal que sai 0 apaga um marcador velho; exit 7 sem 401 não cria marcador", () => {
    assert.equal(runSeq({ seq: ["0"], pending: "attempts=3\n" }).pending, null);
    assert.equal(runSeq({ seq: ["7"] }).pending, null);
  });

  it("resync manual (--resync) com marcador não dobra o --resync", () => {
    const r = runSeq({ seq: ["0"], pending: "attempts=0\n", args: ["--resync"] });
    assert.equal(r.status, 0);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].match(/--resync( |$)/g)?.length, 1);
    assert.equal(r.pending, null);
  });
});
