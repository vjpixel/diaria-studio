/**
 * #11562 — regressão: em 28/10/2026 (edição 261029) o ff do sync-code abortou
 * por colisão com a página da edição gerada no checkout
 * (`workers/site/public/p/{slug}/index.html` untracked) e o `sitemap.xml`
 * modificado — os dois idênticos ao que já estava em origin/master. Com
 * `platform.config.json` editado, o fluxo caía em `protected_config_dirty`
 * (#9276) e o checkout ficava defasado. Agora: cópia local idêntica ao master
 * é descartada sem perda e o ff é re-tentado.
 *
 * Inclui um caso com git REAL (repositório temporário), além dos mocks.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import {
  syncCode,
  identicalDiscardCandidates,
  parseLsTreeBlobs,
  discardCollisionsIdenticalToUpstream,
  classifyFfRefusal,
  type SpawnFn,
  type SpawnResult,
  type SyncLock,
} from "../scripts/lib/git-sync.ts";

const ok = (stdout = ""): SpawnResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = ""): SpawnResult => ({ status: 1, stdout: "", stderr });
const NOOP_LOCK: SyncLock = { path: "(noop)", acquire: () => true, release: () => {} };

const SITEMAP = "workers/site/public/sitemap.xml";
const PAGE = "workers/site/public/p/lula-promete-uma-ia-brasileira/index.html";
const REFUSAL_STDERR =
  `error: Your local changes to the following files would be overwritten by merge:\n\t${SITEMAP}\n` +
  `Please commit your changes or stash them before you merge.\n` +
  `error: The following untracked working tree files would be overwritten by merge:\n\t${PAGE}\n` +
  `Please move or remove them before you merge.\nAborting\n`;
const PORCELAIN = ` M platform.config.json\n M ${SITEMAP}\n?? workers/site/public/p/lula-promete-uma-ia-brasileira/\n`;

describe("#11562 — identicalDiscardCandidates (puro)", () => {
  it("separa rastreado ` M` de untracked (exato ou sob diretório colapsado); ignora config protegida, staged e aspas", () => {
    const r = identicalDiscardCandidates(
      [SITEMAP, PAGE, "platform.config.json", "staged.ts", '"a b.txt"', "fantasma.ts"],
      `${PORCELAIN}M  staged.ts\n?? "a b.txt"\n`,
    );
    assert.deepEqual(r.tracked, [SITEMAP]);
    assert.deepEqual(r.untracked, [PAGE]);
  });

  it("parseLsTreeBlobs: só blobs, por caminho", () => {
    const m = parseLsTreeBlobs(`100644 blob aaa\t${SITEMAP}\x00040000 tree bbb\tdir\x00`);
    assert.equal(m.get(SITEMAP), "aaa");
    assert.equal(m.has("dir"), false);
  });
});

describe("#11562 — discardCollisionsIdenticalToUpstream (mock)", () => {
  it("só descarta o que bate com o blob de origin/master", () => {
    const calls: string[] = [];
    const spawn: SpawnFn = (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      if (key === `git hash-object -- ${SITEMAP} ${PAGE}`) return ok("s1\np-local\n");
      if (key.startsWith("git ls-tree")) return ok(`100644 blob s1\t${SITEMAP}\x00100644 blob p-master\t${PAGE}\x00`);
      return ok("");
    };
    const r = discardCollisionsIdenticalToUpstream(spawn, classifyFfRefusal(REFUSAL_STDERR), PORCELAIN);
    assert.deepEqual(r.discarded, [SITEMAP]);
    assert.ok(calls.includes(`git checkout -- :(literal)${SITEMAP}`));
    assert.ok(!calls.some((c) => c.startsWith("git clean")), "página diferente do master nunca é apagada");
  });

  it("falha de medição → nada descartado, nenhum clean/checkout", () => {
    const calls: string[] = [];
    const spawn: SpawnFn = (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      if (key.startsWith("git hash-object")) return fail("boom");
      return ok("");
    };
    const r = discardCollisionsIdenticalToUpstream(spawn, classifyFfRefusal(REFUSAL_STDERR), PORCELAIN);
    assert.deepEqual(r.discarded, []);
    assert.ok(!calls.some((c) => c.startsWith("git clean") || c.startsWith("git checkout")));
  });

  it("recusa por divergência (sem caminhos) → nenhum spawn", () => {
    let n = 0;
    const r = discardCollisionsIdenticalToUpstream(
      () => {
        n++;
        return ok("");
      },
      classifyFfRefusal("fatal: Not possible to fast-forward, aborting."),
      PORCELAIN,
    );
    assert.deepEqual(r.discarded, []);
    assert.equal(n, 0);
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

/** origin com master avançado (página + sitemap novos) e clone local 1 commit atrás. */
function setupRepos(): { tmp: string; local: string } {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "git-sync-11562-"));
  const origin = join(tmp, "origin");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "master");
  git(origin, "config", "user.email", "t@t");
  git(origin, "config", "user.name", "t");
  write(origin, SITEMAP, "<urlset>v1</urlset>\n");
  write(origin, "platform.config.json", '{"a":1}\n');
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "1");
  git(tmp, "clone", "-q", "origin", "local");
  const local = join(tmp, "local");
  git(local, "config", "user.email", "t@t");
  git(local, "config", "user.name", "t");
  write(origin, SITEMAP, "<urlset>v2</urlset>\n");
  write(origin, PAGE, "<html>edicao</html>\n");
  write(origin, "scripts/lib/official-domains.ts", "export const X = ['replit.com/blog/'];\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "2");
  git(local, "fetch", "-q", "origin");
  return { tmp, local };
}

function realSpawn(cwd: string): SpawnFn {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

describe("#11562 — syncCode com git real", () => {
  it("página untracked + sitemap modificado idênticos ao master, com config editada → synced, config preservada", () => {
    const { tmp, local } = setupRepos();
    try {
      write(local, SITEMAP, "<urlset>v2</urlset>\n");
      write(local, PAGE, "<html>edicao</html>\n");
      write(local, "platform.config.json", '{"a":2}\n');
      const r = syncCode(realSpawn(local), NOOP_LOCK, local);
      assert.equal(r.outcome, "synced", r.message);
      assert.equal(r.up_to_date, true);
      assert.equal(r.preserved_stash, null);
      assert.deepEqual([...(r.discarded_identical_paths ?? [])].sort(), [PAGE, SITEMAP].sort());
      assert.ok(fs.existsSync(join(local, "scripts/lib/official-domains.ts")), "código novo do master chegou");
      assert.equal(fs.readFileSync(join(local, "platform.config.json"), "utf8"), '{"a":2}\n', "config do editor intacta");
      assert.equal(git(local, "stash", "list"), "", "nenhum stash criado (#8719)");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("página local DIFERENTE do master → não descarta (comportamento anterior: protected_config_dirty, arquivo intacto)", () => {
    const { tmp, local } = setupRepos();
    try {
      write(local, PAGE, "<html>versao local editada</html>\n");
      write(local, "platform.config.json", '{"a":2}\n');
      const r = syncCode(realSpawn(local), NOOP_LOCK, local);
      assert.equal(r.outcome, "protected_config_dirty", r.message);
      assert.equal(r.discarded_identical_paths, undefined);
      assert.equal(fs.readFileSync(join(local, PAGE), "utf8"), "<html>versao local editada</html>\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
