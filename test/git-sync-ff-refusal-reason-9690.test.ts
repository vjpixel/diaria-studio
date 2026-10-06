/**
 * #9690 — regressão: checkout 33 commits atrás de origin/master com
 * `platform.config.json` editado e 15 autostashes acumulados, sem nenhum
 * registro de POR QUE o `merge --ff-only` direto recusou (o stderr era
 * descartado). Agora `syncCode()` classifica a recusa (`ff_refusal`) e, no
 * outcome `protected_config_dirty` (#9276), diz se a config é a colisão ou se
 * o bloqueio está em outro arquivo. Nada disso cria, aplica ou apaga stash
 * (#8719).
 *
 * Duas camadas: classificador puro (inclui pt-BR) e git REAL num par
 * origin(bare)+clone temporário — o formato do stderr do git é o que importa,
 * e um mock não prova isso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyFfRefusal,
  describeFfRefusal,
  FF_REFUSAL_DESCRIBE_MAX,
  syncCode,
  type SpawnFn,
  type SpawnResult,
  type SyncLock,
} from "../scripts/lib/git-sync.ts";

const NOOP_LOCK: SyncLock = { path: "(noop)", acquire: () => true, release: () => {} };
const MAIN_CHECKOUT = "/home/editor/diaria-studio";

describe("#9690 classifyFfRefusal — puro", () => {
  it("mudança local rastreada colide → local_changes_collide com os caminhos", () => {
    const r = classifyFfRefusal(
      "error: Your local changes to the following files would be overwritten by merge:\n" +
        "\tplatform.config.json\n\tscripts/foo.ts\n" +
        "Please commit your changes or stash them before you merge.\nAborting\n",
    );
    assert.equal(r.kind, "local_changes_collide");
    assert.deepEqual(r.paths, ["platform.config.json", "scripts/foo.ts"]);
  });

  it("untracked colide → untracked_collide", () => {
    const r = classifyFfRefusal(
      "error: The following untracked working tree files would be overwritten by merge:\n\tnovo.txt\n" +
        "Please move or remove them before you merge.\nAborting\n",
    );
    assert.equal(r.kind, "untracked_collide");
    assert.deepEqual(r.paths, ["novo.txt"]);
  });

  it("divergência → diverged", () => {
    assert.equal(classifyFfRefusal("fatal: Not possible to fast-forward, aborting.\n").kind, "diverged");
  });

  it("pt-BR é reconhecido", () => {
    const r = classifyFfRefusal(
      "error: As suas alterações locais aos seguintes arquivos seriam sobrescritas por mesclar:\n\tplatform.config.json\nAbortando\n",
    );
    assert.equal(r.kind, "local_changes_collide");
    assert.deepEqual(r.paths, ["platform.config.json"]);
    assert.equal(classifyFfRefusal("fatal: Não é possível avançar rapidamente, abortando.").kind, "diverged");
  });

  it("formato desconhecido → unknown, stderr cru preservado na descrição", () => {
    const r = classifyFfRefusal("fatal: algo inesperado");
    assert.equal(r.kind, "unknown");
    assert.match(describeFfRefusal(r), /algo inesperado/);
  });

  it("unknown com stderr longo → descrição truncada, stderr completo preservado no FfRefusal", () => {
    const long = "fatal: " + "x".repeat(1500);
    const r = classifyFfRefusal(long);
    assert.equal(r.kind, "unknown");
    assert.equal(r.stderr, long, "texto completo continua em ff_refusal.stderr");
    const d = describeFfRefusal(r);
    assert.ok(d.length < FF_REFUSAL_DESCRIBE_MAX + 150, `descrição longa demais: ${d.length}`);
    assert.match(d, /completo em ff_refusal\.stderr/);
  });
});

// ── git REAL ───────────────────────────────────────────────────────────────
function realPair(): { root: string; spawn: SpawnFn; git: (...a: string[]) => SpawnResult; up: (...a: string[]) => SpawnResult; upDir: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "git-sync-9690-"));
  const env = { ...process.env, LC_ALL: "C", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", HOME: root };
  const run = (cwd: string) => (...args: string[]): SpawnResult => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const bare = join(root, "origin.git");
  run(root)("init", "-q", "--bare", "-b", "master", bare);
  const upDir = join(root, "up");
  run(root)("clone", "-q", bare, upDir);
  const up = run(upDir);
  up("config", "user.email", "t@t");
  up("config", "user.name", "t");
  writeFileSync(join(upDir, "platform.config.json"), '{"a":1}\n');
  writeFileSync(join(upDir, "foo.ts"), "export const x = 1;\n");
  up("add", ".");
  up("commit", "-qm", "init");
  up("push", "-q", "origin", "master");
  const dir = join(root, "local");
  run(root)("clone", "-q", bare, dir);
  const git = run(dir);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  return { root, spawn: (cmd, args) => (cmd === "git" ? git(...args) : { status: 1, stdout: "", stderr: "só git" }), git, up, upDir, dir };
}

const stashCount = (git: (...a: string[]) => SpawnResult) => git("stash", "list").stdout.split("\n").filter(Boolean).length;

describe("#9690 syncCode — motivo da recusa registrado (git real)", () => {
  it("config editada e o upstream também mexeu nela → diz que a config é a colisão, sem stash", () => {
    const p = realPair();
    try {
      writeFileSync(join(p.upDir, "platform.config.json"), '{"a":2}\n');
      p.up("commit", "-qam", "upstream config");
      p.up("push", "-q", "origin", "master");
      writeFileSync(join(p.dir, "platform.config.json"), '{"a":"local"}\n');

      const r = syncCode(p.spawn, NOOP_LOCK, MAIN_CHECKOUT);
      assert.equal(r.outcome, "protected_config_dirty");
      assert.equal(r.ff_refusal?.kind, "local_changes_collide");
      assert.deepEqual(r.ff_refusal?.paths, ["platform.config.json"]);
      assert.match(r.message, /A própria config colide/);
      assert.ok(r.warnings.some((w) => /ff-only direto recusou \(#9690\)/.test(w)));
      assert.equal(r.commits_behind, 1);
      assert.equal(stashCount(p.git), 0, "nunca cria stash com config protegida suja (#9276)");
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });

  it("config editada mas a colisão é em OUTRO arquivo → aponta o arquivo, não a config", () => {
    const p = realPair();
    try {
      writeFileSync(join(p.upDir, "foo.ts"), "export const x = 2;\n");
      p.up("commit", "-qam", "upstream foo");
      p.up("push", "-q", "origin", "master");
      writeFileSync(join(p.dir, "platform.config.json"), '{"a":"local"}\n');
      appendFileSync(join(p.dir, "foo.ts"), "// local\n");

      const r = syncCode(p.spawn, NOOP_LOCK, MAIN_CHECKOUT);
      assert.equal(r.outcome, "protected_config_dirty");
      assert.deepEqual(r.ff_refusal?.paths, ["foo.ts"]);
      assert.match(r.message, /config NÃO é a colisão — o bloqueio está em: foo\.ts/);
      assert.equal(stashCount(p.git), 0);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });

  it("colisão sem caminhos extraídos (lista vazia) → não afirma que a config NÃO é a colisão", () => {
    const p = realPair();
    try {
      writeFileSync(join(p.upDir, "foo.ts"), "export const x = 5;\n");
      p.up("commit", "-qam", "upstream foo");
      p.up("push", "-q", "origin", "master");
      writeFileSync(join(p.dir, "platform.config.json"), '{"a":"local"}\n');
      // Cabeçalho reconhecido, mas sem linhas indentadas de caminho (formato inesperado).
      const spawn: SpawnFn = (cmd, args) =>
        cmd === "git" && args.includes("--ff-only")
          ? { status: 1, stdout: "", stderr: "error: Your local changes to the following files would be overwritten by merge:\nAborting\n" }
          : p.spawn(cmd, args);

      const r = syncCode(spawn, NOOP_LOCK, MAIN_CHECKOUT);
      assert.equal(r.outcome, "protected_config_dirty");
      assert.equal(r.ff_refusal?.kind, "local_changes_collide");
      assert.deepEqual(r.ff_refusal?.paths, []);
      assert.doesNotMatch(r.message, /config NÃO é a colisão/);
      assert.doesNotMatch(r.message, /A própria config colide/);
      assert.match(r.message, /Motivo da recusa: /);
      assert.equal(stashCount(p.git), 0);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });

  it("divergência (commit local) com tree suja → ff_refusal diverged anexado mesmo no caminho que stasha", () => {
    const p = realPair();
    try {
      writeFileSync(join(p.upDir, "foo.ts"), "export const x = 3;\n");
      p.up("commit", "-qam", "upstream foo");
      p.up("push", "-q", "origin", "master");
      writeFileSync(join(p.dir, "outro.ts"), "x\n");
      p.git("add", "outro.ts");
      p.git("commit", "-qm", "local");
      appendFileSync(join(p.dir, "outro.ts"), "y\n");

      const r = syncCode(p.spawn, NOOP_LOCK, MAIN_CHECKOUT);
      assert.equal(r.outcome, "ff_failed");
      assert.equal(r.ff_refusal?.kind, "diverged");
      assert.ok(r.preserved_stash, "stash preservado, nunca despopado (#8719)");
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });

  it("tree limpa → sem ff_refusal (campo só existe quando o ff direto recusou)", () => {
    const p = realPair();
    try {
      writeFileSync(join(p.upDir, "foo.ts"), "export const x = 4;\n");
      p.up("commit", "-qam", "upstream foo");
      p.up("push", "-q", "origin", "master");
      const r = syncCode(p.spawn, NOOP_LOCK, MAIN_CHECKOUT);
      assert.equal(r.outcome, "synced");
      assert.equal(r.ff_refusal, undefined);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });
});
