/**
 * test/claude-openrouter-subscription-lane-7649.test.ts (#7649, Parte 1)
 *
 * Guard de regressão para o elo final de assinatura claude.ai adicionado a
 * `claude-openrouter.sh` — depois do glm-5.3-flash, quando os 3 elos `:free`
 * E o pago falham, a cadeia agora tenta MAIS UM elo: o MESMO `claude -p`,
 * mas SEM nenhuma das 5 vars ANTHROPIC_* de gateway.
 *
 * A regra #5608/#6714 do CLAUDE.md deste repo (nunca trocar a assinatura
 * claude.ai pela API pay-per-token) é a razão de este arquivo existir:
 * ANTHROPIC_AUTH_TOKEN tem PRECEDÊNCIA sobre o OAuth da assinatura, então
 * um resíduo dessas vars no ambiente transformaria o elo "grátis" numa
 * chamada PAGA no gateway em silêncio. Cobre:
 *
 *   1. A sentinela `sonnet` é o último elo de MODELS_DEFAULT (depois do
 *      glm-5.3-flash) e `is_subscription_lane_model()` existe.
 *   2. O branch de invocação do elo de assinatura NUNCA exporta nenhuma das
 *      5 vars ANTHROPIC_* de gateway (estático — grep na fatia do source) e
 *      o branch openrouter (else) CONTINUA exportando todas.
 *   3. O guard fail-closed (unset + checagem `${!v:-}` + `exit 97`) existe
 *      dentro do branch de assinatura, e dispara de verdade quando uma das
 *      5 vars sobrevive ao `unset` (teste AO VIVO, isolado — nunca toca
 *      ~/.hermes/auth.json real nem invoca `claude` de verdade).
 *   4. RC=97 vira ABORT IMEDIATO (`exit 96`) — checado ANTES da
 *      classificação SAW_QUOTA_SIGNAL/SAW_CONFIG_ERROR_SIGNAL (posição no
 *      source), nunca lido como "transitório" nem "próximo elo".
 *   5. `--max-budget-usd` está ausente do branch de assinatura, presente no
 *      branch openrouter (item 4 da issue).
 *   6. `exit 3` de "nenhuma chave OpenRouter legível" virou warning — o
 *      script não morre mais antes de montar a cadeia (item 3 da issue).
 *   7. O sentinela sobrevive ao `filter_out_free_models` (não termina em
 *      `:free`) — teste AO VIVO da função pura de
 *      `lib/free-quota-exhaustion.sh` (item 5 da issue).
 *
 * Teste de parsing estático — mesma técnica de
 * test/claude-openrouter-free-quota-marker.test.ts e
 * test/claude-openrouter-log-hygiene-6965.test.ts — mais 2 execuções AO VIVO
 * isoladas (function pura + guard extraído por regex, nunca o script inteiro
 * nem credenciais reais).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_PATH = join(ROOT, "hermes/scripts/claude-openrouter.sh");
const LIB_PATH = join(ROOT, "hermes/scripts/lib/free-quota-exhaustion.sh");

function readWrapper(): string {
  return readFileSync(WRAPPER_PATH, "utf8");
}

/** Fatia do source entre um marcador de início e o `else`/`fi` que fecha o
 * branch — mesma técnica de extração por índice já usada em
 * test/claude-openrouter-free-quota-marker.test.ts. */
function subscriptionBranch(src: string): string {
  const start = src.indexOf('if is_subscription_lane_model "$MODEL"; then');
  assert.ok(start >= 0, "branch de invocação do elo de assinatura não encontrado");
  const elseIdx = src.indexOf("\n  else\n", start);
  assert.ok(elseIdx > start, "`else` do branch openrouter não encontrado depois do branch de assinatura");
  return src.slice(start, elseIdx);
}

function openrouterBranch(src: string): string {
  const branchStart = src.indexOf('if is_subscription_lane_model "$MODEL"; then');
  const elseIdx = src.indexOf("\n  else\n", branchStart);
  const fiIdx = src.indexOf("\n  fi\n", elseIdx);
  assert.ok(fiIdx > elseIdx, "`fi` de fechamento do if/else não encontrado");
  return src.slice(elseIdx, fiIdx);
}

describe("claude-openrouter.sh — sentinela do elo de assinatura (#7649)", () => {
  it("MODELS_DEFAULT termina com a sentinela, depois do glm-5.3-flash", () => {
    const src = readWrapper();
    assert.match(
      src,
      /MODELS_DEFAULT=\("dots-studio\/dots-3-note-preview:free" "thinkingmachines\/inkling-small:free" "poolside\/laguna-s-2\.1:free" "z-ai\/glm-5\.3-flash" "\$SUBSCRIPTION_LANE_MODEL"\)/,
      "MODELS_DEFAULT não termina com o sentinela do elo de assinatura logo depois do glm-5.3-flash",
    );
  });

  it("SUBSCRIPTION_LANE_MODEL é a string nua 'sonnet' (nenhum id real da OpenRouter é palavra sem '/')", () => {
    const src = readWrapper();
    assert.match(src, /SUBSCRIPTION_LANE_MODEL="sonnet"/);
  });

  it("is_subscription_lane_model() existe e compara contra SUBSCRIPTION_LANE_MODEL", () => {
    const src = readWrapper();
    assert.match(
      src,
      /is_subscription_lane_model\(\)\s*\{\s*\n\s*\[ "\$\{1:-\}" = "\$SUBSCRIPTION_LANE_MODEL" \]\s*\n\}/,
    );
  });
});

describe("claude-openrouter.sh — branch de invocação (#7649 item 2)", () => {
  const src = readWrapper();
  const sub = subscriptionBranch(src);
  const openrouter = openrouterBranch(src);

  it("o branch de assinatura NUNCA contém `export ANTHROPIC_` (nenhuma das 5 vars de gateway)", () => {
    assert.doesNotMatch(
      sub,
      /export ANTHROPIC_/,
      "o branch do elo de assinatura exporta pelo menos uma var ANTHROPIC_* — isso " +
        "transformaria o elo 'grátis' numa chamada PAGA no gateway em silêncio (#5608/#6714)",
    );
  });

  it("o branch de assinatura faz `unset` explícito das 5 vars (não 'deixar de exportar')", () => {
    assert.match(
      sub,
      /unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN \\\s*\n\s*ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL/,
    );
  });

  it("o branch de assinatura tem o guard fail-closed (loop pelas 5 vars, `exit 97` se alguma sobreviver)", () => {
    for (const v of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ]) {
      assert.ok(sub.includes(v), `guard não menciona ${v}`);
    }
    assert.match(sub, /exit 97/, "guard não aborta com exit 97 quando uma var sobrevive ao unset");
  });

  it("o branch de assinatura NÃO passa `--max-budget-usd` na invocação real (item 4 — comentário explicando a ausência é ok, o FLAG na chamada não pode estar lá)", () => {
    assert.doesNotMatch(sub, /--max-budget-usd "\$BUDGET"/);
  });

  it("o branch openrouter (else) CONTINUA exportando as 5 vars e passando --max-budget-usd", () => {
    assert.match(openrouter, /export ANTHROPIC_BASE_URL="https:\/\/openrouter\.ai\/api"/);
    assert.match(openrouter, /export ANTHROPIC_AUTH_TOKEN="\$KEY"/);
    assert.match(openrouter, /export ANTHROPIC_DEFAULT_HAIKU_MODEL="\$MODEL"/);
    assert.match(openrouter, /export ANTHROPIC_DEFAULT_SONNET_MODEL="\$MODEL"/);
    assert.match(openrouter, /export ANTHROPIC_DEFAULT_OPUS_MODEL="\$MODEL"/);
    assert.match(openrouter, /--max-budget-usd "\$BUDGET"/);
  });

  it("os dois branches passam --model/--allowedTools/--effort (a única diferença é gateway+budget)", () => {
    for (const branch of [sub, openrouter]) {
      assert.match(branch, /--model "\$MODEL"/);
      assert.match(branch, /--allowedTools "\$TOOLS"/);
      assert.match(branch, /\$\{EFFORT:\+--effort "\$EFFORT"\}/);
    }
  });
});

describe("claude-openrouter.sh — RC=97 vira ABORT IMEDIATO, nunca 'próximo elo' (#7649 item 2)", () => {
  const src = readWrapper();

  it("`if [ \"$RC\" -eq 97 ]` aparece ANTES do classificador SAW_QUOTA/SAW_CONFIG (RC -eq 124)", () => {
    const rc97Idx = src.indexOf('if [ "$RC" -eq 97 ]; then');
    const rc124Idx = src.indexOf("if [ $RC -eq 124 ]; then");
    assert.ok(rc97Idx >= 0, "checagem de RC=97 não encontrada");
    assert.ok(rc124Idx > rc97Idx, "RC=97 precisa ser checado ANTES da classificação de timeout/quota/config");
  });

  it("RC=97 sai com `exit 96` — código distinto de 0/1/2/3/4/124, nunca reclassificado como transitório", () => {
    const rc97Idx = src.indexOf('if [ "$RC" -eq 97 ]; then');
    const nextFi = src.indexOf("\n    fi\n", rc97Idx);
    const block = src.slice(rc97Idx, nextFi);
    assert.match(block, /exit 96/);
  });
});

describe("claude-openrouter.sh — exit 3 (sem chave OpenRouter) virou warning (#7649 item 3)", () => {
  const src = readWrapper();

  it("não existe mais um `exit 3` matando o script na checagem da chave", () => {
    assert.doesNotMatch(
      src,
      /nenhuma chave OpenRouter legível[^"]*"\s*>&2;\s*exit 3;/,
      "a checagem de chave ausente ainda mata o script (exit 3) — o elo de assinatura não " +
        "precisa de chave nenhuma, então isso mataria justo o elo que ainda funcionaria",
    );
  });

  it("vira AVISO (warning) em vez de ERRO fatal", () => {
    assert.match(src, /AVISO: nenhuma chave OpenRouter legível/);
  });

  it("quando não há chave, MODELS é filtrado pra só o elo de assinatura (evita queimar tentativas fadadas)", () => {
    assert.match(src, /if \[ -z "\$KEY" \]; then/);
    assert.match(src, /ONLY_SUBSCRIPTION_LANE/);
    assert.match(src, /is_subscription_lane_model "\$m"/);
  });
});

describe("claude-openrouter.sh — sentinela sobrevive ao filtro de cota free (#7649 item 5, AO VIVO)", () => {
  it("filter_out_free_models mantém 'sonnet' junto com o elo pago, filtrando só os :free", () => {
    const out = execFileSync(
      "bash",
      [
        "-c",
        `source "${LIB_PATH}"; filter_out_free_models "a:free" "b:free" "c:free" "z-ai/glm-5.3-flash" "sonnet"`,
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    assert.deepEqual(out, ["z-ai/glm-5.3-flash", "sonnet"]);
  });
});

describe("claude-openrouter.sh — guard fail-closed dispara de verdade (#7649 item 7, AO VIVO, isolado)", () => {
  // Extrai o loop do guard LITERALMENTE do source (mesma disciplina de
  // "não reimplementar o parser bash" do describe acima) e roda ele isolado,
  // num subshell contrived — nunca toca ~/.hermes/auth.json real nem invoca
  // o binário `claude`. Prova que o mecanismo (não só a presença textual do
  // código) realmente aborta quando uma var sobrevive ao unset.
  const src = readWrapper();
  const sub = subscriptionBranch(src);
  const guardMatch = sub.match(
    /unset ANTHROPIC_BASE_URL[\s\S]*?exit 97\s*\n\s*fi\s*\n\s*done/,
  );
  assert.ok(guardMatch, "não encontrei o bloco literal do guard pra extrair");
  const guardSnippet = guardMatch![0];

  it("com as 5 vars genuinamente ausentes, o guard não aborta (RC=0)", () => {
    const script = `${guardSnippet}\necho SURVIVED`;
    const out = execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim();
    assert.equal(out, "SURVIVED", "guard abortou mesmo com o ambiente limpo — falso positivo");
  });

  it("com ANTHROPIC_AUTH_TOKEN sobrevivendo ao unset (readonly, simulando resíduo), o guard aborta com exit 97", () => {
    const script = `export ANTHROPIC_AUTH_TOKEN="poisoned"\nreadonly ANTHROPIC_AUTH_TOKEN\n${guardSnippet}\necho SURVIVED`;
    let threw = false;
    let stderr = "";
    try {
      execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      threw = true;
      stderr = String(e.stderr ?? "");
      assert.equal(e.status, 97, `esperava exit 97, saiu ${e.status}`);
    }
    assert.ok(threw, "o guard deveria abortar (exit 97) quando ANTHROPIC_AUTH_TOKEN sobrevive ao unset");
    assert.match(stderr, /FATAL \(#7649\)/);
  });
});
