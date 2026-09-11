/**
 * test/diaria-develop-issues-force-queue-7946.test.ts (#7946)
 *
 * Trava a exceção de `--issues N,M` explícito sobre o MOTIVO do bloqueio no
 * /diaria-develop — não só sobre a competição com o `300` (critério 3 do
 * "Filtro do servidor 300", já coberto por outros testes). Dois casos:
 *
 *   1. cat. A/B sem front-load, mas a issue foi pedida via `--issues` →
 *      Gate 1 pergunta o insumo faltante em vez do default silencioso
 *      `nao-destravavel-na-sessao` de #5695.
 *   2. bloqueio SEM categoria A-E mapeada (ex: veto da whitelist AAARRR,
 *      #7945) pedido via `--issues` → entra na fila como elegível, sem
 *      pergunta, com override registrado em comentário durável.
 *
 * Não testa comportamento do LLM (SKILL.md é prompt); testa presença de
 * strings no texto-fonte, como diaria-develop-frontload.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEVELOP_SKILL_MD = resolve(ROOT, ".claude/skills/diaria-develop/SKILL.md");
const content = readFileSync(DEVELOP_SKILL_MD, "utf8");

describe("diaria-develop — --issues força fila de resolução, qualquer que seja o bloqueio (#7946)", () => {
  it("critério 3 aponta que o pedido explícito vence o MOTIVO do bloqueio, não só o filtro do 300", () => {
    assert.match(content, /\(#7946\) Esse pedido também vence o MOTIVO do bloqueio/);
  });

  it("cat. A/B pedida via --issues sem insumo gera AskUserQuestion, não o default silencioso", () => {
    assert.match(
      content,
      /Exceção \(#7946\): issue cat\. A\/B pedida nominalmente via `--issues N,M` nesta invocação não cai no default silencioso/,
    );
    assert.match(content, /cat\. A\/B pedida via `--issues` sem insumo \(exceção acima\)/);
  });

  it("passo 1 (Diagnosticar) bifurca cat. A/B por --issues antes do default nao-destravavel-na-sessao", () => {
    assert.match(
      content,
      /ausente \*\*e a issue não foi pedida via `--issues` nesta invocação\*\* → default `pulada` motivo `nao-destravavel-na-sessao`/,
    );
    assert.match(content, /ausente \*\*e pedida via `--issues` \(#7946\)\*\* → formular o pedido do insumo faltante/);
  });

  it("bloqueio sem categoria A-E mapeada (ex: whitelist AAARRR) entra elegível quando pedido via --issues, sem pergunta", () => {
    assert.match(content, /\*\*Bloqueio SEM categoria A-E mapeada \(#7946\)\.\*\*/);
    assert.match(content, /label:aarrr-fora-da-whitelist/);
    assert.match(
      content,
      /o pedido explícito já É a decisão de prioridade[\s\S]{0,400}sem `AskUserQuestion`/,
    );
    assert.match(
      content,
      /registra o override como comentário durável na issue \(ex: "processada apesar do veto de priorização da whitelist AAARRR/,
    );
  });

  it("o override imprime banner no terminal, não só comentário na issue (#7946 review P2)", () => {
    assert.match(content, /e imprime um banner no terminal.*bloqueio de PRIORIZAÇÃO \(não técnico\) ignorado/s);
  });

  it("a exceção não desarma bloqueio de categoria A-E coexistindo", () => {
    assert.match(
      content,
      /Isto \*\*não\*\* desarma um bloqueio de categoria A-E mapeada coexistindo \(credencial ainda ausente continua ausente\)/,
    );
  });

  it("passo 1 cobre o caso sem --issues: bloqueio sem categoria não tem protocolo e não deveria estar no tier corrente", () => {
    assert.match(
      content,
      /sem `--issues`, esse bloqueio não tem protocolo aqui e a issue não deveria ter chegado ao tier corrente/,
    );
  });
});
