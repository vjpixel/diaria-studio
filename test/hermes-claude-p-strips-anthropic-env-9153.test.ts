/**
 * test/hermes-claude-p-strips-anthropic-env-9153.test.ts (#9153)
 *
 * Todo `claude -p` de `hermes/scripts/*.sh` roda uma sessão de Claude Code,
 * que tem de autenticar pela assinatura claude.ai (regra #5608 do CLAUDE.md).
 * "Não setar" ANTHROPIC_* não basta: o cron/unit pode herdar o `.env` inteiro
 * (#5114 — ANTHROPIC_API_KEY é legítima ali pra scripts de API direta) ou um
 * `export` persistente de gateway (#6714), e qualquer uma dessas vars faz o
 * CLI trocar a assinatura pela API paga e perder os conectores claude.ai.
 *
 * Antes do fix, `continuo-pr-review.sh` e `opus-daily-diff-review.sh`
 * chamavam `claude -p` herdando o ambiente cru. Este teste exige que CADA
 * invocação executável de `claude -p` nesses scripts remova as vars de
 * auth/gateway no próprio comando (`env -u ...`). `claude-delegate.sh` é a
 * exceção explícita: tem um elo OpenRouter que seta essas vars de propósito,
 * e o elo de assinatura dele faz `unset` + guard fail-closed num subshell —
 * checado à parte abaixo.
 *
 * Além do parsing estático, o 2º describe EXECUTA o prefixo real extraído de
 * cada script com um `claude` stub no PATH e ANTHROPIC_* setadas no ambiente,
 * confirmando que o processo filho não as recebe.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HERMES_SCRIPTS = join(ROOT, "hermes", "scripts");

const REQUIRED_STRIPS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

// Elo OpenRouter seta ANTHROPIC_* de propósito; elo de assinatura tem guard próprio.
const EXEMPT = new Set(["claude-delegate.sh"]);

function listShellScripts(): string[] {
  const out: string[] = [];
  for (const dir of [HERMES_SCRIPTS, join(HERMES_SCRIPTS, "lib")]) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".sh") && !name.endsWith(".test.sh")) out.push(join(dir, name));
    }
  }
  return out;
}

interface Invocation {
  file: string;
  line: number;
  command: string; // comando lógico completo (linhas de continuação juntadas)
}

/** Acha cada `claude -p` executável (fora de comentário) e junta o comando lógico. */
function findInvocations(file: string): Invocation[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const found: Invocation[] = [];
  const seenStarts = new Set<number>();
  lines.forEach((raw, i) => {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("#")) return;
    // Qualquer execução do binário `claude` (não só o literal `claude -p`):
    // pega `claude --print`, `claude --model X -p`, duplo espaço, crase.
    if (!/(^|[\s|(`])claude(\s|\\|$)/.test(raw)) return;
    let end = i;
    while (end < lines.length - 1 && lines[end].trimEnd().endsWith("\\")) end++;
    let start = i;
    while (start > 0 && lines[start - 1].trimEnd().endsWith("\\")) start--;
    if (seenStarts.has(start)) return; // mesmo comando lógico já contado
    seenStarts.add(start);
    const command = lines.slice(start, end + 1).join("\n");
    if (!/(\s)(-p|--print)(\s|\\|$)/.test(command)) return; // só sessões headless
    found.push({ file, line: i + 1, command });
  });
  return found;
}

describe("#9153 — todo `claude -p` de hermes/scripts remove ANTHROPIC_* do ambiente", () => {
  const scripts = listShellScripts();
  const invocations = scripts
    .filter((f) => !EXEMPT.has(f.split("/").pop()!))
    .flatMap(findInvocations);

  it("encontra os 2 call sites conhecidos (sanidade do parser)", () => {
    const names = invocations.map((v) => v.file.split("/").pop());
    assert.ok(names.includes("continuo-pr-review.sh"), `call sites: ${names.join(", ")}`);
    assert.ok(names.includes("opus-daily-diff-review.sh"), `call sites: ${names.join(", ")}`);
  });

  for (const inv of invocations) {
    it(`${inv.file.split("/").pop()}:${inv.line} faz env -u de todas as vars de auth/gateway`, () => {
      const envIdx = inv.command.search(/\benv\s+-u\b/);
      const claudeIdx = inv.command.search(/\bclaude\s/);
      assert.ok(envIdx >= 0 && envIdx < claudeIdx, `sem \`env -u\` antes do claude -p:\n${inv.command}`);
      const prefix = inv.command.slice(envIdx, claudeIdx);
      for (const v of REQUIRED_STRIPS) {
        assert.match(prefix, new RegExp(`-u ${v}(\\s|\\\\|$)`), `falta -u ${v} em:\n${inv.command}`);
      }
    });
  }

  it("claude-delegate.sh: só os 2 elos conhecidos, e o de assinatura faz unset + guard fail-closed", () => {
    const file = join(HERMES_SCRIPTS, "claude-delegate.sh");
    const invs = findInvocations(file);
    assert.equal(invs.length, 2, `claude-delegate.sh tem ${invs.length} chamadas claude -p (esperado 2: assinatura + OpenRouter) — chamada nova precisa de strip próprio`);
    const lines = readFileSync(file, "utf8").split("\n");
    // Bloco do elo de assinatura: da linha do 1º claude -p pra trás até o `unset`.
    const first = invs[0].line - 1;
    const block = lines.slice(Math.max(0, first - 20), first + 1).join("\n");
    const unsetIdx = block.search(/^\s*unset ANTHROPIC_BASE_URL/m);
    assert.ok(unsetIdx >= 0, `unset do elo de assinatura sumiu:\n${block}`);
    for (const v of REQUIRED_STRIPS) assert.ok(block.slice(unsetIdx).includes(v), `unset do elo de assinatura sem ${v}`);
    assert.match(block, /exit 97/, "guard fail-closed (exit 97) do elo de assinatura sumiu");
  });
});

describe("#9153 — execução real do prefixo extraído com claude stub", { skip: process.platform === "win32" }, () => {
  const invocations = listShellScripts()
    .filter((f) => !EXEMPT.has(f.split("/").pop()!))
    .flatMap(findInvocations);

  for (const inv of invocations) {
    it(`${inv.file.split("/").pop()}:${inv.line}: filho não recebe ANTHROPIC_*`, () => {
      const dir = mkdtempSync(join(tmpdir(), "claude-stub-9153-"));
      try {
        const stub = join(dir, "claude");
        writeFileSync(stub, "#!/bin/sh\nenv\n");
        chmodSync(stub, 0o755);
        // Do `env` até `claude -p` inclusive, trocando o timeout por um curto
        // e descartando as flags seguintes (não importam pro teste de ambiente).
        const cmd = inv.command
          .slice(inv.command.search(/\benv\s+-u\b/), inv.command.search(/\bclaude\s/) + "claude".length)
          .replace(/timeout \d+/, "timeout 10");
        const env: NodeJS.ProcessEnv = {
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          ANTHROPIC_API_KEY: "sk-ant-fake",
          ANTHROPIC_AUTH_TOKEN: "fake-token",
          ANTHROPIC_BASE_URL: "https://gateway.invalid",
          CLAUDE_CODE_USE_BEDROCK: "1",
          CLAUDE_CODE_USE_VERTEX: "1",
          MARKER_9153: "kept",
        };
        const out = execFileSync("bash", ["-c", cmd], { env, encoding: "utf8" });
        assert.match(out, /^MARKER_9153=kept$/m, "stub não rodou ou ambiente não chegou");
        for (const v of REQUIRED_STRIPS) {
          assert.doesNotMatch(out, new RegExp(`^${v}=`, "m"), `${v} vazou pro claude -p`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
