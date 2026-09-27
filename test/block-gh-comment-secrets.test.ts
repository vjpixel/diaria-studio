import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  findSecrets,
  redactSecrets,
  isGhPublishCommand,
  bodyFileArgs,
  evaluate,
} from "../.claude/hooks/block-gh-comment-secrets.mjs";

// #8827: a chave OpenRouter do Hermes vazou num comentário da PR #8800
// (repo público) e foi revogada. Os valores abaixo são SINTÉTICOS e montados
// em runtime — um literal com formato real faria os scanners de segredo do
// GitHub/OpenRouter disparar contra este próprio arquivo.
const OR_KEY = "sk-or-v1-" + "a1b2c3d4".repeat(8);
const ANT_KEY = "sk-ant-api03-" + "Z9".repeat(20);

describe("findSecrets / redactSecrets (#8827)", () => {
  it("acha chave OpenRouter e Anthropic", () => {
    assert.deepEqual(findSecrets(`x ${OR_KEY} y`), ["OpenRouter"]);
    assert.ok(findSecrets(ANT_KEY).includes("Anthropic"));
  });
  it("não acusa só o NOME da variável nem prefixo curto", () => {
    assert.deepEqual(findSecrets("defina OPENROUTER_API_KEY=... (sk-or-v1-...)"), []);
  });
  it("redige: o padrão sk-or-v1- nunca sobra no texto final", () => {
    const out = redactSecrets(`erro: Bearer ${OR_KEY} recusado`);
    assert.ok(!out.includes(OR_KEY));
    assert.ok(!/sk-or-v1-[A-Za-z0-9]{20,}/.test(out));
    assert.match(out, /\[REDACTED_OPENROUTER\]/);
  });
});

describe("isGhPublishCommand (#8827)", () => {
  it("reconhece os caminhos que publicam texto", () => {
    for (const c of [
      'gh pr comment 8800 --body "x"',
      "gh issue comment 1 --body-file f.md",
      "gh pr create --title t --body b",
      "gh issue create -t t -b b",
      "gh api repos/o/r/issues/1/comments -f body=x",
    ]) assert.ok(isGhPublishCommand(c), c);
  });
  it("ignora leitura", () => {
    assert.ok(!isGhPublishCommand("gh pr view 8800"));
    assert.ok(!isGhPublishCommand("gh api repos/o/r/issues/1/comments --jq .[].id"));
  });
});

describe("bodyFileArgs", () => {
  it("extrai --body-file, -F body=@arq e ignora -F literal", () => {
    assert.deepEqual(bodyFileArgs('gh pr comment 1 --body-file "/tmp/a b.md"'), ["/tmp/a b.md"]);
    assert.deepEqual(bodyFileArgs("gh api x/comments -F body=@c.md -F n=1"), ["c.md"]);
  });
});

describe("evaluate (#8827 — regressão do vazamento da PR #8800)", () => {
  it("bloqueia gh pr comment com a chave no --body", () => {
    const r = evaluate(`gh pr comment 8800 --body "log: ${OR_KEY}"`, "/");
    assert.ok(r && r.includes("OpenRouter"));
    assert.ok(!r.includes(OR_KEY), "a mensagem de bloqueio não pode ecoar o segredo");
  });
  it("bloqueia quando o segredo está no --body-file", () => {
    const r = evaluate("gh pr comment 8800 --body-file body.md", "/w", () => `dump ${OR_KEY}`);
    assert.ok(r);
  });
  it("deixa passar comentário limpo e comandos que não publicam", () => {
    assert.equal(evaluate('gh pr comment 8800 --body "LGTM"', "/"), null);
    assert.equal(evaluate(`echo ${OR_KEY} > /dev/null`, "/"), null);
  });
  it("arquivo ilegível é fail-open", () => {
    const r = evaluate("gh pr comment 1 --body-file nope.md", "/", () => {
      throw new Error("ENOENT");
    });
    assert.equal(r, null);
  });
});

describe("hook como processo (contrato PreToolUse)", () => {
  const run = (command: string) =>
    spawnSync(process.execPath, [".claude/hooks/block-gh-comment-secrets.mjs"], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: process.cwd() }),
      encoding: "utf8",
    });
  it("emite deny para comentário com segredo", () => {
    const out = JSON.parse(run(`gh pr comment 1 --body "${OR_KEY}"`).stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  });
  it("silencioso para comentário limpo", () => {
    assert.equal(run('gh pr comment 1 --body "ok"').stdout, "");
  });
});

describe("continuo-pr-review.sh redige o REJECT_BODY (#8827)", () => {
  const src = readFileSync("hermes/scripts/continuo-pr-review.sh", "utf8");
  it("passa o corpo por redact_public_text antes do gh pr comment", () => {
    const redactAt = src.indexOf('REJECT_BODY=$(redact_public_text "$REJECT_BODY")');
    const commentAt = src.indexOf('gh pr comment "$pr" --body "$REJECT_BODY"');
    assert.ok(redactAt > 0 && commentAt > redactAt);
  });
  it("redact_public_text remove a chave de verdade (bash)", () => {
    const fn = src.slice(src.indexOf("redact_public_text() {"), src.indexOf("INFRA_ERROR_LOG="));
    const r = spawnSync("bash", ["-c", `${fn}\nredact_public_text "$1"`, "_", `motivo ${OR_KEY} fim`], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes(OR_KEY));
    assert.match(r.stdout, /\[REDACTED_OPENROUTER\]/);
  });
});
