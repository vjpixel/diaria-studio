/**
 * test/hermes-background-model-pin.test.ts (#6716)
 *
 * Guard de regressão do vazamento de custo medido em 29/08/2026: o wrapper
 * `hermes/scripts/claude-openrouter.sh` passava `--model <slug-barato>` mas
 * NÃO fixava o modelo das chamadas de BACKGROUND do CLI (summarization pra
 * `--resume`, auto-compact). Essas chamadas usavam o default do CLI e saíam
 * como Claude Sonnet 5 a preço cheio no billing do OpenRouter — ~75% do custo
 * de cada delegação ($0.38 e $0.417 em duas sessões consecutivas, contra
 * ~$0.09 se tudo tivesse rodado no slug pedido).
 *
 * Por que um teste e não só o comentário no script: o sintoma é invisível em
 * toda superfície que este repo consegue observar. As chamadas NÃO aparecem no
 * transcript .jsonl da sessão (as duas medidas registram exclusivamente
 * `z-ai/glm-5.3-flash`), não aparecem no `usage_audit.jsonl` do Hermes, e não
 * produzem erro. A única evidência é o billing do gateway, fora do repo. Uma
 * remoção acidental desta linha não quebraria nada de forma perceptível —
 * voltaria a sangrar dinheiro em silêncio até alguém reabrir o dashboard.
 *
 * O teste trava DUAS propriedades, não uma:
 *   1. a var existe no bloco `env` do wrapper;
 *   2. o valor é `"$MODEL"` — o elo corrente da cadeia — e não um slug fixo.
 * A (2) importa porque `MODELS_DEFAULT` mistura `:free` e pago: um slug fixo
 * ficaria correto no elo em que foi escrito e errado nos outros, e um valor
 * hardcoded que saia do catálogo do OpenRouter reintroduz exatamente a classe
 * de bug do #6617 (id morto na cadeia, falha lida como rate-limit).
 *
 * **Se você chegou aqui porque este teste falhou:** não relaxe a asserção.
 * Se o billing mostrar que o pin deixou de bastar, a causa é outra e o lugar
 * de tratar é a #6716 — trocar o slug por um fixo só reintroduz o problema.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_PATH = join(ROOT, "hermes/scripts/claude-openrouter.sh");

/** Linhas de código do wrapper, sem comentários shell (o docblock do próprio
 * script cita a var em prosa — casar com isso daria falso verde). */
function codeLines(): string[] {
  return readFileSync(WRAPPER_PATH, "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line));
}

describe("claude-openrouter.sh — pin do modelo de background (#6716)", () => {
  it("passa ANTHROPIC_DEFAULT_HAIKU_MODEL para o CLI", () => {
    const hit = codeLines().filter((l) => l.includes("ANTHROPIC_DEFAULT_HAIKU_MODEL"));
    assert.equal(
      hit.length,
      1,
      "esperava exatamente 1 uso de ANTHROPIC_DEFAULT_HAIKU_MODEL em código " +
        `(fora de comentário), achei ${hit.length}. Sem essa var o CLI roda as ` +
        "chamadas de background no modelo default (Sonnet a preço cheio) — ver #6716.",
    );
  });

  it("fixa o background no elo corrente da cadeia, não num slug hardcoded", () => {
    const [line] = codeLines().filter((l) => l.includes("ANTHROPIC_DEFAULT_HAIKU_MODEL"));
    assert.match(
      line,
      /ANTHROPIC_DEFAULT_HAIKU_MODEL="\$MODEL"/,
      `esperava ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL", achei: ${line.trim()}. ` +
        "Um slug fixo fica errado nos demais elos de MODELS_DEFAULT (que mistura " +
        ":free e pago) e pode sair do catálogo do OpenRouter — ver #6617.",
    );
  });

  it("fica no mesmo bloco env do ANTHROPIC_BASE_URL (chega ao processo do CLI)", () => {
    const lines = codeLines();
    const iVar = lines.findIndex((l) => l.includes("ANTHROPIC_DEFAULT_HAIKU_MODEL"));
    const iBase = lines.findIndex((l) => l.includes('ANTHROPIC_BASE_URL="https://openrouter.ai/api"'));
    const iClaude = lines.findIndex((l) => /^\s*claude -p/.test(l));
    assert.ok(iBase >= 0 && iClaude >= 0, "âncoras do bloco env não encontradas");
    assert.ok(
      iVar > iBase && iVar < iClaude,
      "ANTHROPIC_DEFAULT_HAIKU_MODEL precisa estar entre ANTHROPIC_BASE_URL e " +
        "`claude -p` — fora do bloco `env` ela não chega ao processo do CLI.",
    );
  });
});
