/**
 * #13852 — regressão: em 22/11/2026 (/diaria-5-publicacao 261123, Neo) o
 * `sync-code.ts` terminou `fetch_failed` ("unable to update local ref" em
 * `master -> origin/master`) e o checkout ficou 35 commits atrás. À mão, o ff
 * recusou por `docs/audience-history/2026-11-19.md` untracked e
 * `context/audience-profile.md` modificado — snapshots de audiência gerados
 * pelo Stage 0 da máquina local, com números diferentes dos que entraram no
 * master pela PR rolante. O descarte do #11562 só aceitava bytes idênticos,
 * então eles iam para o stash (ou travavam o ff junto da config, #9276).
 *
 * Agora: (1) fetch recusado por lock de ref é re-tentado uma vez; (2) snapshot
 * de audiência local diferente do master é trocado pela versão do master,
 * com o conteúdo local guardado como blob no `.git`. Sujeira que não é
 * snapshot segue as regras de sempre (nunca descartada se difere).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import {
  syncCode,
  discardCollisionsIdenticalToUpstream,
  classifyFfRefusal,
  isFetchRefLockError,
  FETCH_REF_LOCK_RETRY_DELAY_MS,
  type SpawnFn,
  type SpawnResult,
  type SyncLock,
} from "../scripts/lib/git-sync.ts";
import { hasRecentLocalAudienceSnapshot, isAudienceSnapshotPath } from "../scripts/lib/audience-snapshot-pr.ts";

const ok = (stdout = ""): SpawnResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = ""): SpawnResult => ({ status: 1, stdout: "", stderr });
const NOOP_LOCK: SyncLock = { path: "(noop)", acquire: () => true, release: () => {} };
const MAIN_CHECKOUT = "/home/editor/diaria-studio";
const NO_SLEEP = () => {};

const PROFILE = "context/audience-profile.md";
const SNAP = "docs/audience-history/2026-11-19.md";
const REF_LOCK_STDERR =
  "error: cannot lock ref 'refs/remotes/origin/master': is at 1111111 but expected 2222222\n" +
  "From github.com:vjpixel/diaria-studio\n ! 2222222..3333333  master     -> origin/master  (unable to update local ref)\n";

// ── fetch: lock de ref ───────────────────────────────────────────────────────

describe("#13852 — isFetchRefLockError (puro)", () => {
  it("reconhece as duas formas do git; rede/credencial não", () => {
    assert.equal(isFetchRefLockError(REF_LOCK_STDERR), true);
    assert.equal(isFetchRefLockError("error: cannot lock ref 'refs/remotes/origin/master': Unable to create '.lock': File exists."), true);
    assert.equal(isFetchRefLockError("fatal: unable to access 'https://github.com/x/': Could not resolve host"), false);
    assert.equal(isFetchRefLockError("fatal: Authentication failed"), false);
  });
});

function fetchSpawn(fetchResults: SpawnResult[], calls: string[]): SpawnFn {
  let n = 0;
  return (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    if (key === "git rev-parse --abbrev-ref HEAD") return ok("master");
    if (key === "git fetch origin") return fetchResults[Math.min(n++, fetchResults.length - 1)];
    if (key === "git status --porcelain") return ok("");
    if (key === "git merge --ff-only origin/master") return ok("Fast-forward\n");
    if (key === "git rev-list --count HEAD..origin/master") return ok("0\n");
    return ok("");
  };
}

describe("#13852 — fetch recusado por lock de ref", () => {
  it("1ª tentativa 'unable to update local ref', 2ª ok → re-tenta uma vez, pausa, e sincroniza (antes: fetch_failed)", () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const r = syncCode(fetchSpawn([fail(REF_LOCK_STDERR), ok("")], calls), NOOP_LOCK, MAIN_CHECKOUT, (ms) => sleeps.push(ms));
    assert.equal(r.outcome, "synced", r.message);
    assert.equal(calls.filter((c) => c === "git fetch origin").length, 2);
    assert.deepEqual(sleeps, [FETCH_REF_LOCK_RETRY_DELAY_MS]);
    assert.ok(calls.includes("git merge --ff-only origin/master"), "o ff roda depois do fetch re-tentado");
    assert.ok(r.warnings.some((w) => w.includes("#13852") && w.includes("re-tentado com sucesso")));
  });

  it("lock persiste nas duas tentativas → fetch_failed com diagnóstico de lock (não 'offline'), sem ff", () => {
    const calls: string[] = [];
    const r = syncCode(fetchSpawn([fail(REF_LOCK_STDERR)], calls), NOOP_LOCK, MAIN_CHECKOUT, NO_SLEEP);
    assert.equal(r.outcome, "fetch_failed");
    assert.equal(calls.filter((c) => c === "git fetch origin").length, 2, "uma re-tentativa só");
    assert.match(r.message, /nem na re-tentativa/);
    assert.match(r.message, /\.lock/);
    assert.doesNotMatch(r.message, /offline/);
    assert.ok(!calls.includes("git merge --ff-only origin/master"));
  });

  it("erro de rede → sem re-tentativa, mensagem de sempre", () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const r = syncCode(
      fetchSpawn([fail("fatal: unable to access 'https://github.com/': Could not resolve host")], calls),
      NOOP_LOCK,
      MAIN_CHECKOUT,
      (ms) => sleeps.push(ms),
    );
    assert.equal(r.outcome, "fetch_failed");
    assert.equal(calls.filter((c) => c === "git fetch origin").length, 1);
    assert.deepEqual(sleeps, []);
    assert.match(r.message, /offline/);
  });
});

// ── snapshot de audiência: mock ──────────────────────────────────────────────

const SNAP_REFUSAL =
  `error: Your local changes to the following files would be overwritten by merge:\n\t${PROFILE}\n` +
  `Please commit your changes or stash them before you merge.\n` +
  `error: The following untracked working tree files would be overwritten by merge:\n\t${SNAP}\n` +
  `Please move or remove them before you merge.\nAborting\n`;
const SNAP_PORCELAIN = ` M ${PROFILE}\n?? ${SNAP}\n`;

function hashSpawn(local: Record<string, string>, upstream: Record<string, string>, calls: string[]): SpawnFn {
  return (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    if (args[0] === "hash-object") {
      const paths = args.slice(args.indexOf("--") + 1);
      return ok(paths.map((p) => local[p]).join("\n") + "\n");
    }
    if (args[0] === "ls-tree") {
      const paths = args.slice(args.indexOf("--") + 1);
      return ok(paths.filter((p) => upstream[p]).map((p) => `100644 blob ${upstream[p]}\t${p}\x00`).join(""));
    }
    return ok("");
  };
}

describe("#13852 — discardCollisionsIdenticalToUpstream com equivalência de snapshot (mock)", () => {
  it("snapshots diferentes do master → descartados, blob gravado (hash-object -w), blob devolvido", () => {
    const calls: string[] = [];
    const r = discardCollisionsIdenticalToUpstream(
      hashSpawn({ [PROFILE]: "pl", [SNAP]: "sl" }, { [PROFILE]: "pm", [SNAP]: "sm" }, calls),
      classifyFfRefusal(SNAP_REFUSAL),
      SNAP_PORCELAIN,
      false,
      isAudienceSnapshotPath,
    );
    assert.deepEqual([...r.discarded].sort(), [PROFILE, SNAP].sort());
    assert.deepEqual(
      [...r.snapshotCopies].sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: PROFILE, blob: "pl" },
        { path: SNAP, blob: "sl" },
      ],
    );
    assert.ok(calls.some((c) => c.startsWith("git hash-object -w --")), "conteúdo local gravado no .git antes do descarte");
    assert.ok(r.warnings.some((w) => w.includes("git cat-file -p sl")));
  });

  it("sem a equivalência (pull do trem, #12223) → snapshot diferente NÃO sai, e hash-object sem -w", () => {
    const calls: string[] = [];
    const r = discardCollisionsIdenticalToUpstream(
      hashSpawn({ [PROFILE]: "pl", [SNAP]: "sl" }, { [PROFILE]: "pm", [SNAP]: "sm" }, calls),
      classifyFfRefusal(SNAP_REFUSAL),
      SNAP_PORCELAIN,
    );
    assert.deepEqual(r.discarded, []);
    assert.ok(!calls.some((c) => c.includes("hash-object -w")));
  });

  it("arquivo que NÃO é snapshot e difere do master → nada descartado (tudo-ou-nada), nem o snapshot", () => {
    const other = "scripts/foo.ts";
    const refusal =
      `error: Your local changes to the following files would be overwritten by merge:\n\t${PROFILE}\n\t${other}\n` +
      `Please commit your changes or stash them before you merge.\nAborting\n`;
    const calls: string[] = [];
    const r = discardCollisionsIdenticalToUpstream(
      hashSpawn({ [PROFILE]: "pl", [other]: "ol" }, { [PROFILE]: "pm", [other]: "om" }, calls),
      classifyFfRefusal(refusal),
      ` M ${PROFILE}\n M ${other}\n`,
      false,
      isAudienceSnapshotPath,
    );
    assert.deepEqual(r.discarded, []);
    assert.ok(!calls.some((c) => c.startsWith("git checkout") || c.startsWith("git clean")));
  });

  it("allowPartial: snapshot sai, edição local real de outro arquivo fica (vai pro stash depois)", () => {
    const other = "scripts/foo.ts";
    const refusal =
      `error: Your local changes to the following files would be overwritten by merge:\n\t${PROFILE}\n\t${other}\n` +
      `Please commit your changes or stash them before you merge.\nAborting\n`;
    const calls: string[] = [];
    const r = discardCollisionsIdenticalToUpstream(
      hashSpawn({ [PROFILE]: "pl", [other]: "ol" }, { [PROFILE]: "pm", [other]: "om" }, calls),
      classifyFfRefusal(refusal),
      ` M ${PROFILE}\n M ${other}\n`,
      true,
      isAudienceSnapshotPath,
    );
    assert.deepEqual(r.discarded, [PROFILE]);
    assert.ok(calls.includes(`git checkout -- :(literal)${PROFILE}`));
    assert.ok(!calls.some((c) => c.includes(`:(literal)${other}`)), "edição local real nunca é descartada");
  });

  it("snapshot modificado localmente que o master APAGOU → não descarta (o ff apagaria a edição local)", () => {
    const refusal =
      `error: Your local changes to the following files would be overwritten by merge:\n\t${PROFILE}\n` +
      `Please commit your changes or stash them before you merge.\nAborting\n`;
    const r = discardCollisionsIdenticalToUpstream(
      hashSpawn({ [PROFILE]: "pl" }, {}, []),
      classifyFfRefusal(refusal),
      ` M ${PROFILE}\n`,
      true,
      isAudienceSnapshotPath,
    );
    assert.deepEqual(r.discarded, []);
  });
});

// ── git real ────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr}`);
  return r.stdout;
}

function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(join(root, rel, ".."), { recursive: true });
  fs.writeFileSync(join(root, rel), content);
}

function realSpawn(cwd: string): SpawnFn {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** origin com master avançado pela PR do snapshot (de OUTRA máquina) + código novo; clone 1 commit atrás. */
function setupRepos(): { tmp: string; local: string } {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "git-sync-13852-"));
  const origin = join(tmp, "origin");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "master");
  git(origin, "config", "user.email", "t@t");
  git(origin, "config", "user.name", "t");
  write(origin, PROFILE, "**subscribers ativos:** 1100\n");
  write(origin, "platform.config.json", '{"a":1}\n');
  write(origin, "scripts/keep.ts", "export const K = 1;\n");
  // Diretório já versionado, como no repo real: o `git status --porcelain`
  // lista cada snapshot untracked, não `?? docs/`.
  write(origin, "docs/audience-history/2026-11-01.md", "**subscribers ativos:** 1000\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "1");
  git(tmp, "clone", "-q", "origin", "local");
  const local = join(tmp, "local");
  git(local, "config", "user.email", "t@t");
  git(local, "config", "user.name", "t");
  write(origin, PROFILE, "**subscribers ativos:** 1195 (300)\n");
  write(origin, SNAP, "**subscribers ativos:** 1195 (300)\n");
  write(origin, "scripts/lib/novo-guard.ts", "export const G = true;\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "chore: snapshot de audiência 2026-11-19");
  git(local, "fetch", "-q", "origin");
  return { tmp, local };
}

describe("#13852 — syncCode com git real", () => {
  it("cenário da issue: snapshot untracked + profile modificado, DIFERENTES do master → synced, sem stash, local recuperável", () => {
    const { tmp, local } = setupRepos();
    try {
      write(local, PROFILE, "**subscribers ativos:** 1190 (Neo)\n");
      write(local, SNAP, "**subscribers ativos:** 1190 (Neo)\n");
      write(local, "scripts/keep.ts", "export const K = 2; // edição local real\n");
      write(local, "rascunho-solto.md", "nota\n");
      const r = syncCode(realSpawn(local), NOOP_LOCK, local, NO_SLEEP);
      assert.equal(r.outcome, "synced", r.message);
      assert.equal(r.up_to_date, true);
      assert.equal(r.preserved_stash, null);
      assert.equal(git(local, "stash", "list"), "", "nenhum stash criado");
      assert.ok(fs.existsSync(join(local, "scripts/lib/novo-guard.ts")), "código novo do master chegou");
      assert.equal(fs.readFileSync(join(local, PROFILE), "utf8"), "**subscribers ativos:** 1195 (300)\n");
      assert.equal(fs.readFileSync(join(local, SNAP), "utf8"), "**subscribers ativos:** 1195 (300)\n");
      // sujeira que não é snapshot e não colide: intacta
      assert.equal(fs.readFileSync(join(local, "scripts/keep.ts"), "utf8"), "export const K = 2; // edição local real\n");
      assert.equal(fs.readFileSync(join(local, "rascunho-solto.md"), "utf8"), "nota\n");
      // conteúdo local descartado continua recuperável pelo blob
      const copies = r.discarded_snapshot_copies ?? [];
      assert.deepEqual(copies.map((c) => c.path).sort(), [PROFILE, SNAP].sort());
      for (const c of copies) assert.equal(git(local, "cat-file", "-p", c.blob), "**subscribers ativos:** 1190 (Neo)\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("com platform.config.json editado (gate 4) → snapshots não travam mais o ff; config intacta", () => {
    const { tmp, local } = setupRepos();
    try {
      write(local, PROFILE, "**subscribers ativos:** 1190 (Neo)\n");
      write(local, SNAP, "**subscribers ativos:** 1190 (Neo)\n");
      write(local, "platform.config.json", '{"a":2}\n');
      const r = syncCode(realSpawn(local), NOOP_LOCK, local, NO_SLEEP);
      assert.equal(r.outcome, "synced", r.message);
      assert.equal(fs.readFileSync(join(local, "platform.config.json"), "utf8"), '{"a":2}\n');
      assert.ok(fs.existsSync(join(local, "scripts/lib/novo-guard.ts")));
      assert.equal(git(local, "stash", "list"), "");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("arquivo não-snapshot em colisão e diferente → nunca descartado (stash direcionado preserva, como antes)", () => {
    const { tmp, local } = setupRepos();
    try {
      write(local, SNAP, "**subscribers ativos:** 1190 (Neo)\n");
      write(local, "scripts/lib/novo-guard.ts", "export const G = 'versão local';\n");
      const r = syncCode(realSpawn(local), NOOP_LOCK, local, NO_SLEEP);
      assert.equal(r.outcome, "synced_stash_preserved", r.message);
      assert.deepEqual(r.discarded_identical_paths, [SNAP]);
      const stashed = git(local, "show", "--format=", "--name-only", `${r.preserved_stash!.ref}^3`);
      assert.match(stashed, /scripts\/lib\/novo-guard\.ts/, "a versão local do não-snapshot ficou no stash, recuperável");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── finding P2 da PR #13859: retomada de /diaria-edicao depois do 0i ─────────

describe("#13852 — hasRecentLocalAudienceSnapshot (puro)", () => {
  const NOW = new Date("2026-11-23T12:00:00Z");
  it("snapshot de hoje ou de ontem (UTC) untracked/modificado → true", () => {
    assert.equal(hasRecentLocalAudienceSnapshot(`?? docs/audience-history/2026-11-23.md\n`, NOW), true);
    assert.equal(hasRecentLocalAudienceSnapshot(` M docs/audience-history/2026-11-22.md\n`, NOW), true);
  });
  it("snapshot antigo (cenário da issue), removido, só o profile ou nada → false", () => {
    assert.equal(hasRecentLocalAudienceSnapshot(`?? ${SNAP}\n M ${PROFILE}\n`, NOW), false);
    assert.equal(hasRecentLocalAudienceSnapshot(` D docs/audience-history/2026-11-23.md\n`, NOW), false);
    assert.equal(hasRecentLocalAudienceSnapshot(` M ${PROFILE}\n`, NOW), false);
    assert.equal(hasRecentLocalAudienceSnapshot("", NOW), false);
  });
});

describe("#13852 — syncCode não troca o profile regenerado hoje pelo do master (git real)", () => {
  const TODAY_SNAP = "docs/audience-history/2026-11-23.md";
  const NOW = () => new Date("2026-11-23T12:00:00Z");

  it("retomada depois do 0i: snapshot de hoje untracked + profile modificado → synced, profile local devolvido", () => {
    const { tmp, local } = setupRepos();
    try {
      write(local, PROFILE, "**subscribers ativos:** 1210 (edição de hoje)\n");
      write(local, TODAY_SNAP, "**subscribers ativos:** 1210 (edição de hoje)\n");
      const r = syncCode(realSpawn(local), NOOP_LOCK, local, NO_SLEEP, NOW);
      assert.equal(r.outcome, "synced", r.message);
      assert.equal(r.up_to_date, true);
      assert.equal(git(local, "stash", "list"), "", "nenhum stash criado");
      assert.ok(fs.existsSync(join(local, "scripts/lib/novo-guard.ts")), "código novo do master chegou");
      assert.equal(
        fs.readFileSync(join(local, PROFILE), "utf8"),
        "**subscribers ativos:** 1210 (edição de hoje)\n",
        "a edição em curso segue lendo o profile que o 0i dela gerou",
      );
      assert.equal(r.restored_local_audience_profile, true);
      assert.equal(fs.readFileSync(join(local, TODAY_SNAP), "utf8"), "**subscribers ativos:** 1210 (edição de hoje)\n");
      assert.match(git(local, "status", "--porcelain"), /M context\/audience-profile\.md/, "profile segue sujo para a PR rolante");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("snapshot local antigo (cenário da issue) com o mesmo relógio → profile do master, sem devolução", () => {
    const { tmp, local } = setupRepos();
    try {
      write(local, PROFILE, "**subscribers ativos:** 1190 (Neo)\n");
      write(local, SNAP, "**subscribers ativos:** 1190 (Neo)\n");
      const r = syncCode(realSpawn(local), NOOP_LOCK, local, NO_SLEEP, NOW);
      assert.equal(r.outcome, "synced", r.message);
      assert.equal(fs.readFileSync(join(local, PROFILE), "utf8"), "**subscribers ativos:** 1195 (300)\n");
      assert.equal(r.restored_local_audience_profile, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
