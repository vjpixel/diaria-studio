import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findSecrets,
  redactSecrets,
  isGhPublishCommand,
  bodyFileArgs,
  evaluate,
  evaluateBodyFileName,
  isUniqueBodyFileName,
  BODY_FILE_STALE_MS,
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

describe("brechas apontadas no review da PR #8880", () => {
  const leak = () => `dump ${OR_KEY}`;
  for (const cmd of [
    "gh api repos/o/r/issues/1/comments -f body=@s.txt -X POST",
    "gh api repos/o/r/issues/1/comments --field body=@s.txt",
    "gh api repos/o/r/issues/1/comments --raw-field body=@s.txt",
    "gh release create v1 --notes-file s.txt",
    "gh gist create -d desc s.txt",
    'gh pr comment 1 --body "$(cat s.txt)"',
    'gh pr comment 1 --body "$(< s.txt)"',
    "gh api graphql --input s.txt",
  ]) {
    it(`bloqueia: ${cmd}`, () => {
      assert.ok(evaluate(cmd, "/w", leak), cmd);
    });
  }
  it("gh gist create: descrição não é tratada como arquivo", () => {
    assert.deepEqual(bodyFileArgs("gh gist create -d minha-desc a.txt"), ["a.txt"]);
  });
});

describe("paridade de padrões hook × bash (#8827/#8884)", () => {
  // Desde o #8884, `redact_public_text` deixou de duplicar os padrões via
  // sed — delega pro mesmo módulo (`.claude/hooks/lib/secret-patterns.mjs`)
  // que este próprio hook importa. "Paridade" agora é literal: mesma fonte,
  // não duas cópias que podem divergir.
  it("redact_public_text delega para o módulo compartilhado de padrões", () => {
    const src = readFileSync("hermes/scripts/continuo-pr-review.sh", "utf8");
    assert.ok(src.includes(".claude/hooks/lib/secret-patterns.mjs"));
  });
  it("o hook usa o mesmo módulo compartilhado (não duplica os padrões)", () => {
    const src = readFileSync(".claude/hooks/block-gh-comment-secrets.mjs", "utf8");
    assert.ok(src.includes("./lib/secret-patterns.mjs"));
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
  it("redact_public_text remove a chave de verdade (bash, via o módulo Node compartilhado)", () => {
    const fn = src.slice(src.indexOf("redact_public_text() {"), src.indexOf("INFRA_ERROR_LOG="));
    const r = spawnSync(
      "bash",
      ["-c", `REPO="$(pwd)"\n${fn}\nredact_public_text "$1"`, "_", `motivo ${OR_KEY} fim`],
      { encoding: "utf8", cwd: process.cwd() },
    );
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes(OR_KEY));
    assert.match(r.stdout, /\[REDACTED_OPENROUTER\]/);
  });
});

// #9065: mesmo gap do #9056 (GitHub) nos padrões Slack/Doppler/Google/AWS —
// o `\b` antes do prefixo deixava escapar segredo colado a uma letra (flag
// curta colada ao valor, `-bxoxb-…`). Valores sintéticos montados em runtime.
describe("#9065: Slack/Doppler/Google/AWS sem word boundary antes do prefixo", () => {
  const SLACK = "xox" + "b-" + "1234567890-abcdefghijklmnop";
  const DOPPLER = "dp" + ".st." + "prd_" + "A1b2C3d4E5f6G7h8I9j0K1l2";
  const GOOGLE = "AI" + "za" + "Sy" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q";
  const AWS = "AK" + "IA" + "ABCDEFGH12345678";
  const cases: Array<[string, string]> = [
    ["Slack", SLACK],
    ["Doppler", DOPPLER],
    ["Google API", GOOGLE],
    ["AWS", AWS],
  ];
  it("sanidade dos sintéticos: comprimentos de Google (39) e AWS (20)", () => {
    assert.equal(GOOGLE.length, 39);
    assert.equal(AWS.length, 20);
  });
  for (const [name, secret] of cases) {
    it(`${name}: colado a uma letra é detectado e redigido`, () => {
      for (const text of [`-b${secret}`, `key${secret}`, `token:x${secret} fim`]) {
        assert.ok(findSecrets(text).includes(name), `${name} em ${JSON.stringify(text)}`);
        assert.ok(!redactSecrets(text).includes(secret), `redação de ${name}`);
      }
    });
    it(`${name}: isolado continua detectado`, () => {
      assert.ok(findSecrets(`veja ${secret} aqui`).includes(name));
    });
  }
  it("menção do prefixo em prosa não é falso positivo", () => {
    for (const body of [
      "Tokens Slack começam com xoxb- (bot) ou xoxp- (user).",
      "O Doppler usa dp.st. para service tokens e dp.pt. para pessoais.",
      "Chaves do Google começam com AIza e as da AWS com AKIA.",
      "O MAKIA123 e o XAIzaABC são identificadores curtos.",
      "Rodei o dp.st.curto e o xoxb-curto sem problema.",
    ]) {
      assert.deepEqual(findSecrets(body), [], body);
    }
  });
});

// #12746: a #12547 nasceu com o corpo da #12348 (0 edições na API). Causa
// provável: `--body-file` de nome genérico reaproveitado, com a escrita do
// corpo novo falhando em silêncio. Guard: nome sem número de 4+ dígitos é
// recusado; arquivo velho gera aviso sem recusa.
describe("#12746: nome único e frescor do --body-file", () => {
  const NOW = 1_800_000_000_000;
  const fresh = { statMtimeMs: () => NOW - 30_000, now: NOW };
  it("recusa o caso da issue: gh issue create com --body-file genérico", () => {
    for (const cmd of [
      "gh issue create --title t --label P3 --body-file /tmp/issue-body.md",
      "gh issue comment 12547 --body-file /tmp/scratch/comment.md",
      "gh pr create --title t --body-file pr-body.md",
      "gh pr edit 12135 --body-file=f1.md",
      "gh issue edit 12547 -F body.md",
      'cd /w && gh -R vjpixel/diaria-design issue create -t t -F "/tmp/a b.md"',
      "gh issue create -t t --body-file /tmp/12547/body.md",
    ]) {
      const r = evaluateBodyFileName(cmd, "/w", fresh);
      assert.ok(r.deny, cmd);
      assert.match(r.deny, /#12746/);
    }
  });
  it("aceita nome com número de 4+ dígitos, stdin e nome com expansão", () => {
    for (const cmd of [
      "gh pr create --title 'x (#12746)' --body-file /tmp/pr-body-12746-4821.md",
      "gh issue comment 12547 --body-file /tmp/c-12547-77.md",
      "gh issue create -t t --body-file /tmp/issue-nova-1762871234.md",
      "gh issue comment 1 --body-file - <<'EOF'\ncorpo\nEOF",
      'gh issue comment 1 --body-file "$F"',
      "gh pr create --body-file /tmp/pr-body-$RANDOM.md",
      "gh issue create --body-file issue-$(date +%s).md",
    ]) {
      assert.deepEqual(evaluateBodyFileName(cmd, "/w", fresh), {}, cmd);
    }
  });
  it("só gh issue|pr create|comment|edit: -F de gh api e texto citado não contam", () => {
    for (const cmd of [
      "gh api repos/o/r/issues/1/comments -F body=@c.md",
      "gh pr view 1 --json body",
      'git commit -m "rode gh issue comment 1 --body-file f.md"',
      "gh issue comment 1 --body-file - <<'EOF'\nexemplo: gh issue create --body-file body.md\nEOF",
      "cat > /tmp/x-12746-1.md <<'EOF'\ngh pr create --body-file pr.md\nEOF",
    ]) {
      assert.deepEqual(evaluateBodyFileName(cmd, "/w", fresh), {}, cmd);
    }
  });
  it("avisa sem recusar quando o arquivo tem mais de 10 min; recém-escrito ou ausente fica calado", () => {
    const cmd = "gh issue create -t t --body-file /tmp/issue-12547-1234.md";
    const old = evaluateBodyFileName(cmd, "/w", { statMtimeMs: () => NOW - BODY_FILE_STALE_MS - 60_000, now: NOW });
    assert.equal(old.deny, undefined);
    assert.match(old.warn ?? "", /#12746/);
    assert.match(old.warn ?? "", /11 min/);
    assert.deepEqual(evaluateBodyFileName(cmd, "/w", fresh), {});
    const missing = evaluateBodyFileName(cmd, "/w", {
      statMtimeMs: () => {
        throw new Error("ENOENT");
      },
      now: NOW,
    });
    assert.deepEqual(missing, {});
  });
  it("isUniqueBodyFileName: mesma regra do gh-pr-review-api.ts (#12169), só o nome-base", () => {
    assert.ok(isUniqueBodyFileName("/tmp/sr-12169-4821.md"));
    assert.ok(!isUniqueBodyFileName("/tmp/12169/f1.md"));
    assert.ok(!isUniqueBodyFileName("C:\\tmp\\12169\\body.md"));
  });
  const runHook = (command: string) =>
    spawnSync(process.execPath, [".claude/hooks/block-gh-comment-secrets.mjs"], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: process.cwd() }),
      encoding: "utf8",
    });
  it("processo do hook: deny para nome genérico, aviso sem deny para arquivo velho, calado no stdin", () => {
    const deny = JSON.parse(runHook("gh issue create -t t --body-file /tmp/body.md").stdout);
    assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
    assert.match(deny.hookSpecificOutput.permissionDecisionReason, /#12746/);
    const dir = mkdtempSync(join(tmpdir(), "bodyfile-12746-"));
    const oldFile = join(dir, "issue-12746-4821.md");
    writeFileSync(oldFile, "corpo antigo");
    const past = new Date(Date.now() - BODY_FILE_STALE_MS - 5 * 60_000);
    utimesSync(oldFile, past, past);
    const warn = JSON.parse(runHook(`gh issue comment 1 --body-file ${oldFile}`).stdout);
    assert.equal(warn.hookSpecificOutput.permissionDecision, undefined);
    assert.match(warn.hookSpecificOutput.additionalContext, /#12746/);
    assert.match(warn.systemMessage, /#12746/);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(runHook("gh issue comment 1 --body-file - <<'EOF'\nok\nEOF").stdout, "");
  });
});
