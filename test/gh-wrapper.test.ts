/**
 * test/gh-wrapper.test.ts (#8884)
 *
 * Regressão do wrapper `hermes/scripts/gh-wrapper.mjs` — fecha as duas
 * brechas documentadas na #8827/#8880 que `.claude/hooks/block-gh-comment-
 * secrets.mjs` não cobre: corpo dinâmico (`--body "$VAR"`, argv já
 * expandido) e qualquer processo fora do Claude Code (agente Hermes, cron).
 *
 * Duas camadas: (1) `lib/gh-wrapper-core.mjs` — lógica pura, testada com
 * dependências injetadas, sem spawnar nada; (2) ponta a ponta — spawna o
 * script real via `node hermes/scripts/gh-wrapper.mjs`, com um `gh` FALSO no
 * PATH (nunca o real), pra provar que (a) segredo bloqueia antes de chamar o
 * `gh` falso, e (b) comando limpo passa argv/stdin intactos pro `gh` falso.
 *
 * Guard de publicação: nenhum teste roda `gh pr comment`/`gh issue comment`
 * de verdade — só o `gh` FALSO deste diretório de teste, e os segredos são
 * sintéticos montados em runtime (nunca um literal com formato real, pelo
 * mesmo motivo do `test/block-gh-comment-secrets.test.ts`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isPublishingInvocation,
  requiresStdin,
  collectTextsToCheck,
  evaluateGhInvocation,
} from "../hermes/scripts/lib/gh-wrapper-core.mjs";
import { findRealGh } from "../hermes/scripts/gh-wrapper.mjs";

// Sintético — nunca um literal com formato real (ver docstring acima).
const OR_KEY = "sk-or-v1-" + "a1b2c3d4".repeat(8);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_PATH = join(ROOT, "hermes/scripts/gh-wrapper.mjs");

describe("isPublishingInvocation (#8884)", () => {
  it("reconhece os subcomandos que publicam", () => {
    for (const argv of [
      ["pr", "comment", "1", "--body", "x"],
      ["issue", "comment", "1", "--body-file", "f.md"],
      ["pr", "create", "--title", "t", "--body", "b"],
      ["release", "create", "v1", "--notes-file", "n.md"],
      ["gist", "create", "a.txt"],
      ["api", "repos/o/r/issues/1/comments", "-f", "body=x"],
      ["api", "repos/o/r/pulls/1/reviews", "-X", "POST", "-f", "body=x"],
    ]) {
      assert.ok(isPublishingInvocation(argv), JSON.stringify(argv));
    }
  });
  it("ignora leitura", () => {
    assert.ok(!isPublishingInvocation(["pr", "view", "1"]));
    assert.ok(!isPublishingInvocation(["api", "repos/o/r/issues/1/comments", "--jq", ".[].id"]));
    assert.ok(!isPublishingInvocation(["issue", "list"]));
  });

  it("#8891: -X/--method ANTES do path não confunde o valor da flag com o path", () => {
    // Reprodução literal da issue: com "-X PATCH" antes do path posicional,
    // o path acabava sendo o token "PATCH" (1º sem "-"), então touchesTarget
    // dava false e o guard de segredo era pulado.
    assert.ok(
      isPublishingInvocation(["api", "-X", "PATCH", "repos/o/r/pulls/1", "-f", "body=x"]),
    );
    assert.ok(
      isPublishingInvocation(["api", "--method", "PATCH", "repos/o/r/pulls/1", "-f", "body=x"]),
    );
    assert.ok(
      isPublishingInvocation(["api", "-X", "POST", "repos/o/r/issues/1/labels", "-f", "labels[]=x"]),
    );
  });

  it("#8891: argv reais de setPrBodyRest e addPrLabelsRest (scripts/lib/gh-pr-safe-edit.ts)", () => {
    // setPrBodyRest
    assert.ok(
      isPublishingInvocation(["api", "-X", "PATCH", "repos/{owner}/{repo}/pulls/1", "-f", "body=x"]),
    );
    // addPrLabelsRest
    assert.ok(
      isPublishingInvocation([
        "api",
        "-X",
        "POST",
        "repos/{owner}/{repo}/issues/1/labels",
        "-f",
        "labels[]=P1",
        "-f",
        "labels[]=bug",
      ]),
    );
  });

  it("#8891: outras flags de valor do gh api também não viram o path por engano", () => {
    assert.ok(
      isPublishingInvocation([
        "api",
        "-H",
        "Accept: application/vnd.github+json",
        "repos/o/r/pulls/1",
        "-X",
        "PATCH",
        "-f",
        "body=x",
      ]),
    );
    // --flag=valor não consome o próximo token — path continua sendo achado corretamente
    assert.ok(
      isPublishingInvocation(["api", "--method=PATCH", "repos/o/r/pulls/1", "-f", "body=x"]),
    );
  });
});

describe("requiresStdin (#8884)", () => {
  it("detecta --body-file -, -F campo=@-, e gist create -", () => {
    assert.ok(requiresStdin(["pr", "comment", "1", "--body-file", "-"]));
    assert.ok(requiresStdin(["api", "x/comments", "-F", "body=@-"]));
    assert.ok(requiresStdin(["gist", "create", "-"]));
  });
  it("comando com arquivo/valor literal não precisa de stdin", () => {
    assert.ok(!requiresStdin(["pr", "comment", "1", "--body-file", "f.md"]));
    assert.ok(!requiresStdin(["pr", "comment", "1", "--body", "texto"]));
  });
});

describe("collectTextsToCheck / evaluateGhInvocation (#8884)", () => {
  it("resolve --body inline (o caso que o hook do Claude Code não cobre)", () => {
    // Simula `gh pr comment 1 --body "$X"` já EXPANDIDO pelo shell.
    const r = evaluateGhInvocation(["pr", "comment", "1", "--body", `log: ${OR_KEY}`], {});
    assert.ok(r.blocked);
    assert.ok(r.secrets?.includes("OpenRouter"));
  });
  it("resolve --body-file lendo o arquivo real", () => {
    const r = evaluateGhInvocation(["pr", "comment", "1", "--body-file", "s.txt"], {
      readFileSync: () => `dump ${OR_KEY}`,
    });
    assert.ok(r.blocked);
  });
  it("resolve stdin quando --body-file usa -", () => {
    const r = evaluateGhInvocation(["pr", "comment", "1", "--body-file", "-"], {
      stdinText: `via stdin: ${OR_KEY}`,
    });
    assert.ok(r.blocked);
  });
  it("resolve -F campo=@arquivo e -F campo=valor literal", () => {
    const withFile = evaluateGhInvocation(["api", "x/comments", "-F", "body=@s.txt"], {
      readFileSync: () => OR_KEY,
    });
    assert.ok(withFile.blocked);
    const clean = evaluateGhInvocation(["api", "x/comments", "-F", "n=1"], {});
    assert.equal(clean.blocked, false);
  });
  it("resolve posicional de gh gist create, ignorando a descrição", () => {
    const r = evaluateGhInvocation(["gist", "create", "-d", "minha desc", "a.txt"], {
      readFileSync: () => OR_KEY,
    });
    assert.ok(r.blocked);
    assert.deepEqual(collectTextsToCheck(["gist", "create", "-d", "minha desc", "a.txt"], {}), [""]);
  });
  it("comando limpo e comando que não publica não bloqueiam", () => {
    assert.equal(evaluateGhInvocation(["pr", "comment", "1", "--body", "LGTM"], {}).blocked, false);
    assert.equal(evaluateGhInvocation(["pr", "view", "1"], {}).blocked, false);
  });
  it("arquivo ilegível é fail-open (mesma filosofia do hook irmão)", () => {
    const r = evaluateGhInvocation(["pr", "comment", "1", "--body-file", "nope.md"], {
      readFileSync: () => {
        throw new Error("ENOENT");
      },
    });
    assert.equal(r.blocked, false);
  });
});

describe("findRealGh (#8884)", () => {
  it("pula a si mesmo e acha o próximo `gh` no PATH", () => {
    const calls: string[] = [];
    const real = findRealGh("/self/bin:/usr/bin", "/self/bin/gh", {
      exists: (p: string) => {
        calls.push(p);
        return true;
      },
      realpath: (p: string) => (p === "/self/bin/gh" ? "/self/bin/gh" : "/usr/bin/gh"),
    });
    assert.equal(real, "/usr/bin/gh");
    assert.deepEqual(calls, ["/self/bin/gh", "/usr/bin/gh"]);
  });
  it("retorna null quando só existe o próprio wrapper no PATH", () => {
    const real = findRealGh("/self/bin", "/self/bin/gh", {
      exists: () => true,
      realpath: () => "/self/bin/gh",
    });
    assert.equal(real, null);
  });
});

// --- Ponta a ponta: spawna o script real, com um `gh` FALSO no PATH. ---

function makeFakeGhDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-wrapper-test-"));
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.writeFileSync(process.env.FAKE_GH_OUT, JSON.stringify({ argv: process.argv.slice(2), stdin }));
process.exit(0);
`;
  const p = join(dir, "gh");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return dir;
}

function runWrapper(argv: string[], opts: { input?: string } = {}) {
  const fakeDir = makeFakeGhDir();
  const outFile = join(fakeDir, "out.json");
  const res = spawnSync(process.execPath, [WRAPPER_PATH, ...argv], {
    env: { ...process.env, PATH: `${fakeDir}:${process.env.PATH}`, FAKE_GH_OUT: outFile },
    input: opts.input ?? "",
    encoding: "utf8",
  });
  let fakeGhInvoked: { argv: string[]; stdin: string } | null = null;
  try {
    fakeGhInvoked = JSON.parse(readFileSync(outFile, "utf8"));
  } catch {
    fakeGhInvoked = null;
  }
  return { ...res, fakeGhInvoked };
}

describe("gh-wrapper.mjs — ponta a ponta (#8884)", () => {
  it("bloqueia --body com segredo expandido, sem chamar o gh real", () => {
    const r = runWrapper(["pr", "comment", "1", "--body", `log: ${OR_KEY}`]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /bloqueado.*#8884/i);
    assert.equal(r.fakeGhInvoked, null, "o `gh` (falso) nunca deveria ter sido chamado");
  });

  it("bloqueia segredo vindo via stdin (--body-file -)", () => {
    const r = runWrapper(["pr", "comment", "1", "--body-file", "-"], {
      input: `via stdin: ${OR_KEY}`,
    });
    assert.notEqual(r.status, 0);
    assert.equal(r.fakeGhInvoked, null);
  });

  it("bloqueia segredo em arquivo real passado via --body-file", () => {
    const fakeDir = makeFakeGhDir();
    const secretFile = join(fakeDir, "body.md");
    writeFileSync(secretFile, `contexto\n${OR_KEY}\n`);
    const outFile = join(fakeDir, "out.json");
    const res = spawnSync(process.execPath, [WRAPPER_PATH, "issue", "comment", "1", "--body-file", secretFile], {
      env: { ...process.env, PATH: `${fakeDir}:${process.env.PATH}`, FAKE_GH_OUT: outFile },
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0);
    assert.throws(() => readFileSync(outFile, "utf8"));
  });

  it("repassa argv intactos pro gh real quando o texto é limpo", () => {
    const r = runWrapper(["pr", "comment", "42", "--body", "LGTM, mergeando"]);
    assert.equal(r.status, 0);
    assert.ok(r.fakeGhInvoked);
    assert.deepEqual(r.fakeGhInvoked!.argv, ["pr", "comment", "42", "--body", "LGTM, mergeando"]);
  });

  it("repassa stdin intacto pro gh real quando o texto é limpo", () => {
    const r = runWrapper(["pr", "comment", "1", "--body-file", "-"], { input: "corpo limpo via stdin" });
    assert.equal(r.status, 0);
    assert.ok(r.fakeGhInvoked);
    assert.equal(r.fakeGhInvoked!.stdin, "corpo limpo via stdin");
  });

  it("comando de leitura passa direto, sem checagem nenhuma", () => {
    const r = runWrapper(["pr", "view", "1"]);
    assert.equal(r.status, 0);
    assert.ok(r.fakeGhInvoked);
    assert.deepEqual(r.fakeGhInvoked!.argv, ["pr", "view", "1"]);
  });

  it("gh real ausente no PATH sai com 127 e mensagem clara", () => {
    const res = spawnSync(process.execPath, [WRAPPER_PATH, "pr", "view", "1"], {
      env: { ...process.env, PATH: "/nonexistent-dir-for-test" },
      encoding: "utf8",
    });
    assert.equal(res.status, 127);
    assert.match(res.stderr, /não achei o `gh` real/);
  });
});

// Confirma que o wrapper nunca se resolve a si mesmo como "gh real" mesmo
// quando instalado por symlink (padrão de instalação real, ver
// hermes/README.md) — sem isso o wrapper recursaria infinitamente.
describe("realpath do próprio arquivo resolve de forma estável (#8884)", () => {
  it("realpathSync do wrapper não lança", () => {
    assert.doesNotThrow(() => realpathSync(WRAPPER_PATH));
  });
});

// Regressão #8900: instalado como documentado em hermes/README.md
// (`ln -sf .../gh-wrapper.mjs ~/.local/bin/gh`), o guard de módulo principal
// comparava import.meta.url (caminho REAL, resolvido pelo Node) contra
// process.argv[1] (o caminho do SYMLINK) — nunca batia, `main()` nunca
// rodava, e o processo saía silenciosamente com exit 0 sem invocar o `gh`
// real nem imprimir nada. Estes testes invocam o wrapper PELO SYMLINK (não
// pelo caminho direto, que já era coberto acima) e confirmam que a chamada
// realmente atravessa até o `gh` falso.
describe("gh-wrapper.mjs invocado via symlink (#8900)", () => {
  function runWrapperViaSymlink(argv: string[], opts: { input?: string } = {}) {
    const fakeDir = makeFakeGhDir();
    const outFile = join(fakeDir, "out.json");
    const symlinkDir = mkdtempSync(join(tmpdir(), "gh-wrapper-symlink-"));
    const symlinkPath = join(symlinkDir, "gh");
    symlinkSync(WRAPPER_PATH, symlinkPath);
    const res = spawnSync(process.execPath, [symlinkPath, ...argv], {
      env: { ...process.env, PATH: `${fakeDir}:${process.env.PATH}`, FAKE_GH_OUT: outFile },
      input: opts.input ?? "",
      encoding: "utf8",
    });
    let fakeGhInvoked: { argv: string[]; stdin: string } | null = null;
    try {
      fakeGhInvoked = JSON.parse(readFileSync(outFile, "utf8"));
    } catch {
      fakeGhInvoked = null;
    }
    return { ...res, fakeGhInvoked };
  }

  it("não é mais um no-op silencioso: comando limpo atravessa até o gh falso", () => {
    const r = runWrapperViaSymlink(["pr", "comment", "42", "--body", "LGTM via symlink"]);
    assert.equal(r.status, 0);
    assert.ok(r.fakeGhInvoked, "o `gh` falso deveria ter sido invocado — antes do fix, saía 0 sem chamar nada");
    assert.deepEqual(r.fakeGhInvoked!.argv, ["pr", "comment", "42", "--body", "LGTM via symlink"]);
    assert.equal(r.stdout, "", "não deveria haver saída extra — só o repasse pro gh real");
  });

  it("segredo continua bloqueado quando invocado via symlink", () => {
    const r = runWrapperViaSymlink(["pr", "comment", "1", "--body", `log: ${OR_KEY}`]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /bloqueado.*#8884/i);
    assert.equal(r.fakeGhInvoked, null, "o `gh` (falso) nunca deveria ter sido chamado");
  });

  it("chamada direta (não-symlink) continua funcionando como antes", () => {
    const r = runWrapper(["pr", "view", "1"]);
    assert.equal(r.status, 0);
    assert.ok(r.fakeGhInvoked);
  });
});
