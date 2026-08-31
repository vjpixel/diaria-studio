/**
 * test/continuo-pr-review-never-merges.test.ts (#6865)
 *
 * `hermes/scripts/continuo-pr-review.sh` existe pra fechar o gap de review
 * externo do contínuo SEM virar um 2º ponto de merge — só o pickup de PR
 * órfã (`hermes-diaria-continuo/SKILL.md` §3 passo 3, #6823) mergeia,
 * senão dois processos disputariam a mesma PR (a corrida que o guard do
 * #5716 existe pra evitar, #6849 item 4). Trava mecanicamente, não só em
 * prosa: `--allowedTools` do script nunca inclui `gh pr merge`, e o prompt
 * nunca instrui a mergear.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = resolve(ROOT, "hermes/scripts/continuo-pr-review.sh");

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf8");
}

describe("continuo-pr-review.sh nunca mergeia (#6865, propriedade mecânica)", () => {
  it("--allowedTools não contém 'gh pr merge' nem 'pr merge'", () => {
    const src = readScript();
    const allowedToolsLine = src
      .split("\n")
      .find((l) => l.includes("--allowedTools") && !l.trim().startsWith("#"));
    assert.ok(allowedToolsLine, "linha --allowedTools não encontrada no script");
    assert.ok(
      !allowedToolsLine!.includes("pr merge") && !allowedToolsLine!.includes("gh pr merge"),
      `--allowedTools não pode conter 'pr merge' — vazaria capacidade de merge pro Sonnet, veio: ${allowedToolsLine}`,
    );
  });

  it("nenhuma linha do script INVOCA `gh pr merge` como comando real (todas as menções são comentário, docstring, ou negação explícita no prompt)", () => {
    const lines = readScript().split("\n");
    const offenders = lines.filter((l) => {
      const trimmed = l.trim();
      if (!/gh\s+pr\s+merge/.test(trimmed)) return false;
      if (trimmed.startsWith("#")) return false; // comentário/docstring
      // Menção dentro do texto do PROMPT explicando a proibição — sempre
      // acompanhada de negação (não/nunca/NUNCA) na mesma linha.
      if (/n[aã]o|nunca/i.test(trimmed)) return false;
      return true;
    });
    assert.deepEqual(offenders, [], `linha(s) invocando 'gh pr merge' sem negação encontrada(s): ${JSON.stringify(offenders)}`);
  });

  it("o PROMPT enviado ao claude -p instrui explicitamente a NUNCA mergear", () => {
    const src = readScript();
    assert.match(
      src,
      /NUNCA MERGEIA|nunca mergear/i,
      "o prompt deve instruir explicitamente a sessão de review a nunca mergear",
    );
  });

  it("usa --model sonnet (não opus) — papel distinto do review diário consolidado", () => {
    const src = readScript();
    assert.match(src, /--model sonnet/, "continuo-pr-review.sh deve usar Sonnet, não Opus (decisão do editor, #6865)");
  });

  it("AUTH: não seta ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY (assinatura claude.ai, mesmo padrão do #5608)", () => {
    const src = readScript();
    assert.ok(
      !src.includes("ANTHROPIC_BASE_URL=") && !src.includes("ANTHROPIC_AUTH_TOKEN=") && !src.includes("ANTHROPIC_API_KEY="),
      "script não deve setar essas env vars — precisa rodar com a assinatura claude.ai, não gateway de terceiro (#5608/#6714)",
    );
  });

  it("checa check-pr-review-authenticity.ts antes de decidir revisar (não revisa PR que já tem review independente)", () => {
    const src = readScript();
    assert.match(src, /check-pr-review-authenticity\.ts/, "script deve consultar o gate de autenticidade antes de revisar");
  });
});
