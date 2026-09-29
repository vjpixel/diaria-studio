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
  normalizeArgv,
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

describe("#8950: -F/-F - em pr/issue (short form de --body-file/--notes-file)", () => {
  it("-F é reconhecido como body-file em pr/issue comment/create/edit, não como field do gh api", () => {
    assert.ok(isPublishingInvocation(["pr", "comment", "1", "-F", "f.md"]));
    assert.ok(isPublishingInvocation(["issue", "create", "-F", "f.md"]));
    assert.ok(isPublishingInvocation(["release", "create", "v1", "-F", "n.md"]));
  });
  it("-F - pede stdin em pr/issue (antes só --body-file/--notes-file por extenso eram vistos)", () => {
    assert.ok(requiresStdin(["pr", "comment", "1", "-F", "-"]));
    assert.ok(requiresStdin(["issue", "comment", "1", "-F", "-"]));
  });
  it("bloqueia segredo lido via -F arquivo (forma curta)", () => {
    const r = evaluateGhInvocation(["pr", "comment", "1", "-F", "s.txt"], {
      readFileSync: () => `dump ${OR_KEY}`,
    });
    assert.ok(r.blocked);
  });
  it("bloqueia segredo vindo por stdin via -F - (forma curta)", () => {
    const r = evaluateGhInvocation(["issue", "comment", "1", "-F", "-"], {
      stdinText: `via stdin: ${OR_KEY}`,
    });
    assert.ok(r.blocked);
  });
  it("gh api continua tratando -F como field key=value, não como body-file", () => {
    // -F aqui é `campo=valor` — não deve tentar ler "n=1" como path de arquivo.
    const r = evaluateGhInvocation(["api", "repos/o/r/issues/1/comments", "-F", "n=1"], {
      readFileSync: () => {
        throw new Error("nunca deveria ler arquivo aqui");
      },
    });
    assert.equal(r.blocked, false);
  });
});

describe("#8950: pr/issue close --comment / -c publicam", () => {
  it("isPublishingInvocation reconhece close", () => {
    assert.ok(isPublishingInvocation(["pr", "close", "1", "--comment", "x"]));
    assert.ok(isPublishingInvocation(["issue", "close", "1", "-c", "x"]));
  });
  it("bloqueia segredo em --comment/-c de close", () => {
    const r1 = evaluateGhInvocation(["pr", "close", "1", "--comment", `fechando: ${OR_KEY}`], {});
    assert.ok(r1.blocked);
    const r2 = evaluateGhInvocation(["issue", "close", "1", "-c", `fechando: ${OR_KEY}`], {});
    assert.ok(r2.blocked);
  });
  it("close sem --comment/-c não publica nada (nada a checar)", () => {
    assert.equal(evaluateGhInvocation(["pr", "close", "1"], {}).blocked, false);
  });
  it("close --comment limpo passa", () => {
    assert.equal(evaluateGhInvocation(["pr", "close", "1", "--comment", "resolvido no #123"], {}).blocked, false);
  });
});

describe("#8950: normalização de --flag=valor", () => {
  it("--body=, --title=, --notes=, --comment= são resolvidos como o par flag+valor", () => {
    assert.deepEqual(normalizeArgv(["pr", "comment", "1", "--body=oi"]), ["pr", "comment", "1", "--body", "oi"]);
    assert.deepEqual(normalizeArgv(["pr", "close", "1", "--comment=oi"]), ["pr", "close", "1", "--comment", "oi"]);
  });
  it("bloqueia segredo passado como --body=SEGREDO", () => {
    const r = evaluateGhInvocation(["pr", "comment", "1", `--body=log: ${OR_KEY}`], {});
    assert.ok(r.blocked);
  });
  it("bloqueia segredo passado como --title=SEGREDO", () => {
    const r = evaluateGhInvocation(["pr", "create", `--title=${OR_KEY}`, "--body", "b"], {});
    assert.ok(r.blocked);
  });
  it("bloqueia segredo passado como --comment=SEGREDO em close", () => {
    const r = evaluateGhInvocation(["issue", "close", "1", `--comment=${OR_KEY}`], {});
    assert.ok(r.blocked);
  });
  it("--body-file=arquivo é lido (forma com =)", () => {
    const r = evaluateGhInvocation(["pr", "comment", "1", "--body-file=s.txt"], {
      readFileSync: () => OR_KEY,
    });
    assert.ok(r.blocked);
  });
  it("--input=arquivo (gh api) é lido (forma com =)", () => {
    const r = evaluateGhInvocation(["api", "repos/o/r/issues/1/comments", "--input=s.txt"], {
      readFileSync: () => OR_KEY,
    });
    assert.ok(r.blocked);
  });
  it("--field=body=valor (gh api) normaliza sem quebrar o key=value interno", () => {
    const r = evaluateGhInvocation(["api", "repos/o/r/issues/1/comments", `--field=body=${OR_KEY}`], {});
    assert.ok(r.blocked);
  });
});

describe("#8950: gh api --input sem -X conta como publicação", () => {
  it("isPublishingInvocation reconhece --input mesmo sem -X/--method", () => {
    assert.ok(isPublishingInvocation(["api", "repos/o/r/issues/1/comments", "--input", "f.json"]));
  });
  it("bloqueia segredo em --input sem -X", () => {
    const r = evaluateGhInvocation(["api", "repos/o/r/issues/1/comments", "--input", "s.json"], {
      readFileSync: () => `{"body":"${OR_KEY}"}`,
    });
    assert.ok(r.blocked);
  });
  it("stdin de --input - (sem -X) também é checado", () => {
    const r = evaluateGhInvocation(["api", "repos/o/r/issues/1/comments", "--input", "-"], {
      stdinText: `{"body":"${OR_KEY}"}`,
    });
    assert.ok(r.blocked);
    assert.ok(requiresStdin(["api", "repos/o/r/issues/1/comments", "--input", "-"]));
  });
});

describe("#8950 (follow-up): short flag colada ao valor (-Fcorpo.md, -F-, -btexto, -ccomentario, -fcampo=valor)", () => {
  it("normalizeArgv separa -F/-b/-t/-n coladas ao valor em pr/issue/release", () => {
    assert.deepEqual(normalizeArgv(["pr", "comment", "1", "-Fcorpo.md"]), ["pr", "comment", "1", "-F", "corpo.md"]);
    assert.deepEqual(normalizeArgv(["pr", "comment", "1", "-btexto"]), ["pr", "comment", "1", "-b", "texto"]);
    assert.deepEqual(normalizeArgv(["issue", "close", "1", "-ccomentario"]), ["issue", "close", "1", "-c", "comentario"]);
    assert.deepEqual(normalizeArgv(["api", "x/comments", "-fcampo=valor"]), ["api", "x/comments", "-f", "campo=valor"]);
  });
  it("-F- (stdin colado, sem espaço) normaliza para [\"-F\", \"-\"]", () => {
    assert.deepEqual(normalizeArgv(["pr", "comment", "1", "-F-"]), ["pr", "comment", "1", "-F", "-"]);
  });
  it("requiresStdin detecta -F- colado", () => {
    assert.ok(requiresStdin(["pr", "comment", "1", "-F-"]));
    assert.ok(requiresStdin(["issue", "comment", "1", "-F-"]));
  });
  it("bloqueia segredo em -Fcorpo.md (arquivo, forma curta colada)", () => {
    const r = evaluateGhInvocation(["pr", "comment", "1", "-Fcorpo.md"], {
      readFileSync: () => `dump ${OR_KEY}`,
    });
    assert.ok(r.blocked);
  });
  it("bloqueia segredo em -F- (stdin, forma curta colada)", () => {
    const r = evaluateGhInvocation(["issue", "comment", "1", "-F-"], {
      stdinText: `via stdin: ${OR_KEY}`,
    });
    assert.ok(r.blocked);
  });
  it("bloqueia segredo em -btexto (--body colado)", () => {
    const r = evaluateGhInvocation(["pr", "comment", "1", `-blog: ${OR_KEY}`], {});
    assert.ok(r.blocked);
  });
  it("bloqueia segredo em -ccomentario (--comment de close, colado)", () => {
    const r = evaluateGhInvocation(["pr", "close", "1", `-cfechando: ${OR_KEY}`], {});
    assert.ok(r.blocked);
  });
  it("bloqueia segredo em -fcampo=valor (gh api --raw-field colado)", () => {
    const r = evaluateGhInvocation(["api", "repos/o/r/issues/1/comments", `-fbody=${OR_KEY}`], {});
    assert.ok(r.blocked);
  });
  it("-c colado NÃO é tratado como valor em `pr review` (lá -c/--comment é booleano, sem valor)", () => {
    // `-caprovado` não é sintaxe real do gh review (o -c de review não aceita valor),
    // mas o ponto do teste é que normalizeArgv não pode inventar um split aqui:
    // shortValueFlagsFor("pr","review") não inclui "-c".
    assert.deepEqual(normalizeArgv(["pr", "review", "1", "-c"]), ["pr", "review", "1", "-c"]);
  });
  it("-f colado NÃO é reinterpretado em `pr create` (lá -f/--fill é booleano, sem valor)", () => {
    assert.deepEqual(normalizeArgv(["pr", "create", "-f", "--title", "t"]), [
      "pr",
      "create",
      "-f",
      "--title",
      "t",
    ]);
  });
  it("gh api continua distinguindo -F campo=valor colado de -F arquivo (nunca lê arquivo aqui)", () => {
    const r = evaluateGhInvocation(["api", "repos/o/r/issues/1/comments", "-Fn=1"], {
      readFileSync: () => {
        throw new Error("nunca deveria ler arquivo aqui");
      },
    });
    assert.equal(r.blocked, false);
  });
});

describe("#9020: normalizeArgv não reinterpreta VALOR de flag como flag", () => {
  it("--body \"--token=SEGREDO\" não é splitado — o token inteiro segue como valor", () => {
    assert.deepEqual(normalizeArgv(["pr", "comment", "1", "--body", "--token=ghp_XXXX"]), [
      "pr",
      "comment",
      "1",
      "--body",
      "--token=ghp_XXXX",
    ]);
  });
  it("--body \"-tghp_XXXX\" não é splitado como flag curta colada", () => {
    assert.deepEqual(normalizeArgv(["pr", "comment", "1", "--body", "-tghp_XXXX"]), [
      "pr",
      "comment",
      "1",
      "--body",
      "-tghp_XXXX",
    ]);
  });
  it("bloqueia segredo em --body \"--token=SEGREDO\" (regressão do #8950, achada no #9020)", () => {
    const r = evaluateGhInvocation(["pr", "comment", "1", "--body", `--token=${OR_KEY}`], {});
    assert.ok(r.blocked, "segredo inteiro precisa chegar em collectTextsToCheck, não só o pedaço pós-split");
    assert.ok(r.secrets?.includes("OpenRouter"));
  });
  it("bloqueia segredo em --body \"-tSEGREDO\" (mesma regressão, forma curta colada)", () => {
    const r = evaluateGhInvocation(["pr", "comment", "1", "--body", `-t${OR_KEY}`], {});
    assert.ok(r.blocked);
  });
  it("gh api: -X PATCH seguido de -f com valor iniciado por --x= não confunde a flag seguinte", () => {
    const r = evaluateGhInvocation(
      ["api", "-X", "PATCH", "repos/o/r/pulls/1", "-f", `body=--token=${OR_KEY}`],
      {},
    );
    assert.ok(r.blocked);
  });
  it("valor limpo que começa com -- continua passando intacto", () => {
    const r = evaluateGhInvocation(["pr", "comment", "1", "--body", "--isso é só texto normal"], {});
    assert.equal(r.blocked, false);
  });
});

describe("#9020: pr/issue reopen --comment/-c publicam", () => {
  it("isPublishingInvocation reconhece reopen", () => {
    assert.ok(isPublishingInvocation(["pr", "reopen", "1", "--comment", "x"]));
    assert.ok(isPublishingInvocation(["issue", "reopen", "1", "-c", "x"]));
  });
  it("bloqueia segredo em --comment/-c de reopen", () => {
    const r1 = evaluateGhInvocation(["pr", "reopen", "1", "--comment", `reabrindo: ${OR_KEY}`], {});
    assert.ok(r1.blocked);
    const r2 = evaluateGhInvocation(["issue", "reopen", "1", "-c", `reabrindo: ${OR_KEY}`], {});
    assert.ok(r2.blocked);
  });
  it("reopen sem --comment/-c não publica nada (nada a checar)", () => {
    assert.equal(evaluateGhInvocation(["pr", "reopen", "1"], {}).blocked, false);
  });
  it("reopen --comment limpo passa", () => {
    assert.equal(evaluateGhInvocation(["issue", "reopen", "1", "--comment", "reaberta por engano"], {}).blocked, false);
  });
});

describe("#9020: pr merge --body/-b e --subject/-t publicam", () => {
  it("isPublishingInvocation reconhece merge", () => {
    assert.ok(isPublishingInvocation(["pr", "merge", "1", "--body", "x"]));
    assert.ok(isPublishingInvocation(["pr", "merge", "1", "--subject", "x"]));
  });
  it("bloqueia segredo em --body/-b de merge", () => {
    const r1 = evaluateGhInvocation(["pr", "merge", "1", "--body", `mergeando: ${OR_KEY}`], {});
    assert.ok(r1.blocked);
    const r2 = evaluateGhInvocation(["pr", "merge", "1", "-b", `mergeando: ${OR_KEY}`], {});
    assert.ok(r2.blocked);
  });
  it("bloqueia segredo em --subject/-t de merge", () => {
    const r1 = evaluateGhInvocation(["pr", "merge", "1", "--subject", `assunto: ${OR_KEY}`], {});
    assert.ok(r1.blocked);
    const r2 = evaluateGhInvocation(["pr", "merge", "1", "-t", `assunto: ${OR_KEY}`], {});
    assert.ok(r2.blocked);
  });
  it("merge sem --body/--subject não publica nada (nada a checar)", () => {
    assert.equal(evaluateGhInvocation(["pr", "merge", "1", "--squash"], {}).blocked, false);
  });
  it("merge --body/--subject limpos passam", () => {
    assert.equal(
      evaluateGhInvocation(["pr", "merge", "1", "--body", "resolve #123", "--subject", "fix: bug"], {}).blocked,
      false,
    );
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
