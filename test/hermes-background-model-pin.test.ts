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

/**
 * Linhas de código do wrapper, sem comentários shell (o docblock do próprio
 * script cita a var em prosa — casar com isso daria falso verde).
 *
 * Tira comentário de linha inteira E comentário inline (`cmd  # nota`). O
 * inline não existe hoje perto desta var, mas o repo usa `# ref (#NNNN)` com
 * frequência e este teste é um guard de longo prazo: sem isso, um comentário
 * futuro citando a var produziria falso verde (achado do review da PR #6717).
 *
 * O corte de inline só vale quando o `#` vem depois de espaço em branco e fora
 * de aspas — `"https://openrouter.ai/api"` não tem `#`, mas um valor com `#`
 * dentro de string não pode ser truncado.
 */
function codeLines(): string[] {
  return readFileSync(WRAPPER_PATH, "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map(stripInlineComment);
}

/** Remove `# ...` no fim da linha, respeitando aspas simples e duplas. */
export function stripInlineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== "\\") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

describe("claude-openrouter.sh — pin do modelo de background (#6716)", () => {
  /**
   * #6716, 31/08/2026 — o pin de haiku NÃO bastava, e a razão está nos docs.
   *
   * `ANTHROPIC_DEFAULT_HAIKU_MODEL` cobre apenas o alias `haiku` e as
   * funcionalidades de background. Qualquer caminho interno do CLI que peça
   * modelo pela FAMÍLIA `sonnet`/`opus` resolve pelo ID default embutido no
   * binário — uma string real da Anthropic — que o gateway fatura a preço
   * cheio. Medido na conta: em 30/08, `anthropic/claude-sonnet-5` fez 10
   * requisições ($0,3868) contra um total de $0,4650 no dia — 83% do custo com
   * ~1,4% das requisições, ~71K prompt tokens por chamada.
   *
   * Mesma invisibilidade do caso original: não aparece no transcript, não
   * produz erro, só no billing do gateway. As três vars têm testes de
   * conteúdo/valor análogos (existe + fixada em "$MODEL") e, mais abaixo,
   * o MESMO guard de posição (dentro do subshell do OUT=$(...)) — não são
   * travadas por um único teste compartilhado; achado do review da PR
   * #6859 corrigindo um overclaim deste parágrafo (dizia "o mesmo guard"
   * quando o guard de posição, na versão original desta PR, só cobria
   * HAIKU).
   */
  for (const varName of [
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
  ]) {
    it(`passa ${varName} para o CLI, fixado em "$MODEL"`, () => {
      const hit = codeLines().filter((l) => l.includes(varName));
      assert.equal(
        hit.length,
        1,
        `esperava exatamente 1 uso de ${varName} em código (fora de ` +
          `comentário), achei ${hit.length}. Sem essa var, caminho interno que ` +
          "peça a família resolve pelo ID default da Anthropic e o gateway " +
          "fatura a preço cheio — ver #6716.",
      );
      assert.match(
        hit[0],
        new RegExp(`export\\s+${varName}="\\$MODEL"`),
        `${varName} deve ser fixado em "$MODEL" (elo corrente da cadeia), ` +
          "nunca num slug hardcoded — o auxiliar herda o custo do primário e " +
          "nunca fica mais caro que o modelo pedido.",
      );
    });
  }

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

  it("stripInlineComment não confunde `#` dentro de aspas com comentário", () => {
    // Sem o corte de inline, um comentário futuro citando a var daria falso
    // verde; com um corte ingênuo, um `#` dentro de string truncaria código real.
    assert.equal(
      stripInlineComment('    FOO="bar" \\  # ANTHROPIC_DEFAULT_HAIKU_MODEL antigo').trim(),
      'FOO="bar" \\',
    );
    assert.equal(stripInlineComment('    URL="https://x/#frag" \\').trim(), 'URL="https://x/#frag" \\');
    assert.equal(stripInlineComment("    A='b#c' \\").trim(), "A='b#c' \\");
    assert.equal(stripInlineComment('    sem comentario'), '    sem comentario');
  });

  /**
   * Achado do review da PR #6859 (P2, confiança alta, confirmado
   * empiricamente pelo revisor): a versão anterior deste teste só checava
   * ANTHROPIC_DEFAULT_HAIKU_MODEL, e usava âncoras fracas (`ANTHROPIC_BASE_
   * URL`/`claude -p` por CONTEÚDO de linha, não a fronteira real do
   * subshell) — mover uma das 2 vars novas (SONNET/OPUS) pra FORA do
   * subshell `OUT=$(printf ... | ( ... ))` (a regressão exata que violaria
   * #5608/#6718: var ANTHROPIC_* vazando pro ambiente global sequestra
   * sessão da assinatura claude.ai) não fazia os testes de conteúdo/valor
   * acima falharem, e o teste de posição só cobria HAIKU. Generalizado
   * pras 3 vars + trocado pro MESMO par de âncoras robusto que `test/
   * hermes-key-not-in-cmdline.test.ts` já usa pra ANTHROPIC_AUTH_TOKEN:
   * `iSub` (abertura do subshell) e `iClose` (a linha `))` que o fecha,
   * procurada DEPOIS de `iSub` — não a 1ª ocorrência do arquivo — em vez de
   * `claude -p`, que é só uma linha DENTRO do bloco, não a fronteira real.
   * Validado manualmente (não travado em CI, documentado aqui pra quem
   * duvidar): mover `export ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL"` pra
   * antes de `OUT=$(printf ...` faz este teste falhar; o código de produção
   * não tem essa regressão.
   */
  for (const varName of [
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
  ]) {
    it(`${varName} fica DENTRO do subshell do OUT=$(printf ... | ( ... )) (chega ao processo do CLI, nunca vaza pro ambiente global)`, () => {
      const lines = codeLines();
      const iSub = lines.findIndex((l) => l.includes(`OUT=$(printf '%s' "$PROMPT" | (`));
      const iVar = lines.findIndex((l) => l.includes(varName));
      const iClose = lines.findIndex((l, i) => i > iSub && l.trim() === "))");
      assert.ok(iSub >= 0, "subshell do OUT=$(printf ... | ( não encontrado — a estrutura do fix #6718 mudou");
      assert.ok(iVar >= 0, `${varName} não encontrada em código`);
      assert.ok(iClose > iSub, "fechamento )) do subshell não encontrado depois de iSub");
      assert.ok(
        iVar > iSub && iVar < iClose,
        `${varName} precisa estar ENTRE a abertura do subshell (OUT=$(printf ... | () e o fechamento )) — ` +
          "fora dele a var vaza pro ambiente global do wrapper (violaria #5608/#6718: sequestra sessão da " +
          "assinatura claude.ai) e/ou nunca chega ao processo do `claude -p`.",
      );
    });
  }
});
