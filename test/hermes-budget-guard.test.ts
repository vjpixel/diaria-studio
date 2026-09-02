/**
 * test/hermes-budget-guard.test.ts (#6666)
 *
 * Guard de regressao contra o bug descrito na #6666: o wrapper
 * `claude-openrouter.sh` usava `BUDGET="0.25"`, mas o CLAUDE.md tem 76KB
 * (~19k tokens de entrada), e o CLI rastreia o custo de carregar o contexto
 * contra `--max-budget-usd`. A chamada com CLAUDE.md carregado ja excede
 * $0.25 no primeiro request, e o erro "Exceeded USD budget" vai pro STDOUT
 * (nao stderr), entao o classify-grep de stderr nunca o via — a cadeia
 * falha silenciosamente com rc=1 e stderr vazio.
 *
 * ATUALIZADO (#6712, 29/08/2026) — a premissa acima estava incompleta e o
 * piso de 2.0 provou-se baixo demais pelo motivo ERRADO. A causa real nao e
 * "o contexto e grande": e que o CLI NAO reconhece o slug do gateway
 * ("[claude-code:unrecognized_model]") e estima o custo com o preco DEFAULT
 * da Anthropic em vez do preco do modelo real, errando por ~18x. Medido em 3
 * delegacoes reais: 1.86M/3.80M/4.39M tokens custaram $0.067/$0.137/$0.159 e
 * o CLI estimou $1.21/$1.93/$2.64 — as tres estouraram budget de $1.0-$2.0
 * gastando centavos, e o tick de 40min produziu ZERO PRs.
 *
 * Por isso o piso subiu para 20.0: o --max-budget-usd NAO e o controle de
 * custo desta pipeline (quem limita e o teto diario da key na OpenRouter,
 * aplicado pelo provedor e imune a erro de estimativa) — aqui ele e so rede
 * contra runaway. Nao recalibrar pelo custo esperado de uma delegacao: a
 * regua esta errada, entao qualquer valor "justo" derivado dela volta a
 * cortar trabalho legitimo.
 *
 * Este teste lê o wrapper e confirma:
 *   1. BUDGET >= 20.0 (rede contra runaway, nao orcamento operacional)
 *   2. O classification loop cobre "exceeded.*budget" no ATTEMPT_LOG
 *   3. O stdout e capturado no ATTEMPT_LOG no RC!=0 (para budget errors
 *      serem visiveis)
 *
 * Nao executa o CLI (test de parsing estatico).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_PATH = join(ROOT, "hermes/scripts/claude-openrouter.sh");
const SKILL_PATH = join(ROOT, "hermes/skills/hermes-diaria-continuo/SKILL.md");

describe("guard de budget do wrapper (#6666)", () => {
  const source = readFileSync(WRAPPER_PATH, "utf8");

  it("BUDGET default e >= 20.0 (rede contra runaway, nao orcamento)", () => {
    const m = source.match(/^BUDGET="([^"]+)"/m);
    assert.ok(m, `BUDGET="..." nao encontrado em ${WRAPPER_PATH}`);
    const budget = parseFloat(m![1]);
    assert.ok(
      budget >= 20.0,
      `BUDGET=${budget} e menor que 20.0. O CLI nao reconhece o slug do gateway e estima o custo a preco Anthropic (~18x o real), entao qualquer teto "justo" corta delegacao legitima: 3 delegacoes de 29/08 gastaram $0.067/$0.137/$0.159 reais e o CLI contabilizou $1.21/$1.93/$2.64, estourando budget de $1.0-$2.0 (#6712). O controle de custo real e o teto diario da key na OpenRouter, nao este valor.`,
    );
  });

  it("o loop de classificacao cobre o erro literal do CLI ('Exceeded USD budget') no ATTEMPT_LOG", () => {
    // Procura pelo elif que detecta budget-exceeded, exatamente como o
    // #6617 fez com os patternos de rate-limit/config-error.
    //
    // #6796: o padrao frouxo original ("exceeded.*budget|budget.*exceeded|
    // too expensive|cost.*exceed") foi trocado pela string LITERAL que o
    // CLI emite — casava prosa gerada pelo proprio modelo discutindo o bug
    // (este checkout fala de orcamento/custo o tempo todo), o que e
    // perigoso porque este e o UNICO classificador que ainda le texto do
    // modelo e alimenta SAW_CONFIG_ERROR_SIGNAL (exit 4).
    const budgetPattern = /elif command grep -qE "Exceeded USD budget" "\$ATTEMPT_LOG"/;
    assert.ok(
      budgetPattern.test(source),
      "o elif de classificacao do budget-exceeded nao esta presente no wrapper — sem isso, 'Exceeded USD budget' (que vai pro STDOUT) e classificado como 'sem sinal claro' e a cadeia falha silenciosamente (#6666)",
    );
  });

  it("o stdout e capturado no ATTEMPT_LOG no RC!=0 (para budget errors serem visiveis)", () => {
    // A ordem correta: echo "$OUT" >> "$ATTEMPT_LOG" ANTES do classify-grep.
    // Procura pelo padrao exato: echo "$OUT" >> "$ATTEMPT_LOG"
    assert.ok(
      /echo "\$OUT" >> "\$ATTEMPT_LOG"/.test(source),
      "stdout nao e capturado no ATTEMPT_LOG — sem isso, erros do CLI que vai pro STDOUT (como 'Exceeded USD budget') nunca sao vistos pelo classify-grep de stderr (#6666)",
    );
  });

  it("o classify-grep roda sobre o ATTEMPT_LOG completo (stdout + stderr combinados)", () => {
    // O ATTEMPT_LOG deve conter tanto stderr (redirecionado 2>) quanto stdout
    // (echo "$OUT" >>) antes dos greps de classificacao. Verifica que o
    // echo "$OUT" >> "$ATTEMPT_LOG" vem ANTES do primeiro elif grep.
    const stdoutCapture = source.indexOf('echo "$OUT" >> "$ATTEMPT_LOG"');
    const firstClassifyGrep = source.indexOf('grep -qiE "model not found');
    assert.ok(
      stdoutCapture > -1 && firstClassifyGrep > -1,
      "padroes de busca nao encontrados no wrapper",
    );
    assert.ok(
      stdoutCapture < firstClassifyGrep,
      `echo "$OUT" >> "$ATTEMPT_LOG" (pos ${stdoutCapture}) deve vir ANTES do primeiro classify-grep (pos ${firstClassifyGrep}) — o stdout com o erro do CLI precisa estar no ATTEMPT_LOG antes de ser classificado (#6666)`,
    );
  });
});

describe("call sites do wrapper nao sobrepoem o piso de BUDGET (#6712)", () => {
  /**
   * O default do wrapper nao basta: a SKILL.md invoca
   * `claude-openrouter.sh --budget N`, e um `--budget` explicito SOBREPOE o
   * default. Em 29/08/2026 o wrapper tinha default 2.0 e a skill passava
   * exatamente 2.0 — subir so o default teria deixado o bug intacto no
   * caminho que de fato roda. Este teste trava os dois lados juntos.
   */
  it("todo --budget literal na SKILL.md e >= o piso do wrapper", () => {
    const wrapper = readFileSync(WRAPPER_PATH, "utf8");
    const floor = parseFloat(wrapper.match(/^BUDGET="([^"]+)"/m)![1]);
    const skill = readFileSync(SKILL_PATH, "utf8");
    // so linhas de COMANDO (bloco de codigo), nao prosa citando o valor
    const found = [...skill.matchAll(/--budget\s+([0-9]+(?:\.[0-9]+)?)/g)].map((m) =>
      parseFloat(m[1]),
    );
    assert.ok(found.length > 0, "nenhum `--budget N` encontrado na SKILL.md — o call site sumiu ou mudou de forma");
    for (const v of found) {
      assert.ok(
        v >= floor,
        `SKILL.md invoca --budget ${v}, abaixo do piso ${floor} do wrapper. Um --budget explicito sobrepoe o default, entao esse call site reintroduz o abort do #6712 (o CLI estima custo a preco Anthropic, ~14-18x o real, e mata a delegacao gastando centavos).`,
      );
    }
  });
});
