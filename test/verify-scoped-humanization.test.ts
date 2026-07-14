/**
 * test/verify-scoped-humanization.test.ts (#3446)
 *
 * Testes de regressão para verify-scoped-humanization.ts — o guard determinístico
 * que confirma que uma re-humanização SCOPED do Stage 4 (§4d.1) tocou EXATAMENTE
 * as seções pedidas, nem menos (humanizador ignorou o alvo) nem mais (mudou
 * seções que deveriam ficar intactas — corrompendo o preview final).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/verify-scoped-humanization.ts");

const SOCIAL_PRE = `# LinkedIn
## d1
D1 aprovado, não deve mudar.

## d2
D2 original com tic de IA: otimizando o pipeline.

## post_pixel
Post pixel aprovado, não deve mudar.

# Facebook
## d1
Post Facebook d1.
`;

const SOCIAL_POST_SCOPED_OK = SOCIAL_PRE.replace(
  "D2 original com tic de IA: otimizando o pipeline.",
  "D2 reescrito — sem tics de IA.",
);

const SOCIAL_POST_UNTOUCHED = SOCIAL_PRE; // idêntico — humanizador não tocou o alvo

const SOCIAL_POST_SCOPE_VIOLATED = SOCIAL_POST_SCOPED_OK.replace(
  "D1 aprovado, não deve mudar.",
  "D1 também reescrito — colateral fora do escopo pedido.",
);

function mkFiles(preContent: string, postContent: string): { dir: string; prePath: string; postPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "verify-scoped-humanize-"));
  const prePath = join(dir, "pre-snapshot.md");
  const postPath = join(dir, "03-social.md");
  writeFileSync(prePath, preContent, "utf8");
  writeFileSync(postPath, postContent, "utf8");
  return { dir, prePath, postPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runScript(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", SCRIPT_PATH, ...args],
    { encoding: "utf8", env: { ...process.env } },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("verify-scoped-humanization.ts (#3446)", () => {
  it("exit 0 quando apenas a seção-alvo (main_d2) mudou", () => {
    const { prePath, postPath, cleanup } = mkFiles(SOCIAL_PRE, SOCIAL_POST_SCOPED_OK);
    try {
      const result = runScript(["--pre", prePath, "--post", postPath, "--sections", "main_d2"]);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout.trim().split("\n")[0]);
      assert.equal(parsed.ok, true);
      assert.deepEqual(parsed.touchedTargets, ["main_d2"]);
    } finally {
      cleanup();
    }
  });

  it("exit 1 quando a seção-alvo NÃO mudou (humanizador pulou o alvo)", () => {
    const { prePath, postPath, cleanup } = mkFiles(SOCIAL_PRE, SOCIAL_POST_UNTOUCHED);
    try {
      const result = runScript(["--pre", prePath, "--post", postPath, "--sections", "main_d2"]);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
      assert.ok(result.stderr.includes("NÃO tocada"), `stderr deve reportar seção não tocada; got:\n${result.stderr}`);
      const parsed = JSON.parse(result.stdout.trim().split("\n")[0]);
      assert.deepEqual(parsed.untouchedTargets, ["main_d2"]);
    } finally {
      cleanup();
    }
  });

  it("exit 1 quando uma seção FORA do escopo também mudou (violação de escopo)", () => {
    const { prePath, postPath, cleanup } = mkFiles(SOCIAL_PRE, SOCIAL_POST_SCOPE_VIOLATED);
    try {
      const result = runScript(["--pre", prePath, "--post", postPath, "--sections", "main_d2"]);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
      assert.ok(result.stderr.includes("FORA do escopo"), `stderr deve reportar violação de escopo; got:\n${result.stderr}`);
      const parsed = JSON.parse(result.stdout.trim().split("\n")[0]);
      assert.deepEqual(parsed.unexpectedChanges, ["main_d1"]);
    } finally {
      cleanup();
    }
  });

  it("aceita múltiplas seções-alvo separadas por vírgula", () => {
    const preMulti = `# LinkedIn
## d1
D1 texto.

### comment_pixel
D1 comentário.

## post_pixel
Post pixel.

# Facebook
## d1
Foo.
`;
    const postMulti = preMulti
      .replace("D1 texto.", "D1 reescrito.")
      .replace("D1 comentário.", "D1 comentário reescrito.");
    const { prePath, postPath, cleanup } = mkFiles(preMulti, postMulti);
    try {
      const result = runScript(["--pre", prePath, "--post", postPath, "--sections", "main_d1,comment_pixel_d1"]);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  it("exit 1 com mensagem de uso quando faltam flags obrigatórias", () => {
    const result = runScript(["--pre", "/tmp/does-not-exist.md"]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("Uso:"));
  });

  it("exit 1 quando arquivo --pre ou --post não existe", () => {
    const { postPath, cleanup } = mkFiles(SOCIAL_PRE, SOCIAL_POST_SCOPED_OK);
    try {
      const result = runScript(["--pre", "/tmp/definitely-not-here.md", "--post", postPath, "--sections", "main_d2"]);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes("ERRO"));
    } finally {
      cleanup();
    }
  });
});
