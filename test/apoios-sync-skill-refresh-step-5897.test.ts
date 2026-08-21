/**
 * test/apoios-sync-skill-refresh-step-5897.test.ts (#5897, regressão #633)
 *
 * O Passo 4 de `/diaria-apoios-sync` existe porque `--push` NÃO dispara
 * reprocessamento de segmento na Beehiiv (#4485): segmento é lista
 * materializada, e sem refresh manual um envio segmentado no mesmo dia do push
 * acerta a lista ANTIGA — a classe de erro que o #4436 existiu pra eliminar.
 *
 * O passo instruía clicar um botão "Refresh segment" na aba Overview. Esse
 * botão foi REMOVIDO da UI da Beehiiv (medido ao vivo em 260821: nenhum
 * `<button>` da página casa /refresh|reload|process/i). Seguindo a instrução
 * antiga, o operador procura um botão inexistente e ou para no meio deixando
 * os 6 segmentos stale, ou conclui que "regenera sozinho" — leitura que o
 * #4485 já refutou. Nos dois casos o envio segmentado erra o alvo em silêncio.
 *
 * Trava o caminho verificado que substituiu o botão (Configure → "Update
 * segment") e impede que a instrução morta volte como comando.
 *
 * Não testa comportamento do LLM (SKILL.md é prompt); testa presença/ausência
 * de strings no texto-fonte, mesmo padrão de
 * overnight-skill-npm-test-scope.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = resolve(ROOT, ".claude/skills/diaria-apoios-sync/SKILL.md");
const content = readFileSync(SKILL_MD, "utf8");

/**
 * Toda menção a "Refresh segment" que sobra no arquivo, com a linha inteira —
 * pra distinguir a instrução morta (proibida) da nota histórica que explica
 * por que ela morreu (permitida).
 */
function linesMentioningRefreshSegment(): string[] {
  return content.split("\n").filter((line) => line.includes("Refresh segment"));
}

describe("diaria-apoios-sync — Passo 4 usa o caminho verificado, não o botão removido (#5897)", () => {
  it("instrui Configure → \"Update segment\" como o gatilho de reprocessamento", () => {
    assert.match(
      content,
      /clicar \*\*"Update segment"\*\*/,
      'Passo 4.1 deve mandar clicar "Update segment" (caminho verificado ao vivo em 260821)',
    );
    assert.match(
      content,
      /\*\*sem\s+alterar nenhuma condição\*\*/,
      "deve deixar explícito que nenhuma condição é alterada — salvar sem diff já dispara o reprocessamento",
    );
  });

  it("não instrui mais clicar o botão removido \"Refresh segment\"", () => {
    const offenders = linesMentioningRefreshSegment().filter(
      // A única menção legítima é a nota que documenta que o botão NÃO existe
      // mais. Qualquer outra é instrução morta voltando.
      (line) => !/NÃO existe mais/.test(line),
    );
    assert.deepEqual(
      offenders,
      [],
      `nenhuma linha deve instruir o botão removido; encontradas: ${JSON.stringify(offenders)}`,
    );
  });

  it("preserva o gate determinístico do Passo 4.2 como o critério de sucesso", () => {
    // A lição do #5897 não é "corrigir o clique" — é que o clique é a parte
    // frágil e o gate é a parte confiável. Se o gate sair, a skill volta a
    // poder declarar sucesso com segmentos stale.
    assert.match(
      content,
      /evaluateSegmentCountGate/,
      "Passo 4.2 deve continuar chamando evaluateSegmentCountGate",
    );
    assert.match(
      content,
      /nunca\s+declarar sucesso com o gate falhando/,
      "deve continuar proibindo declarar sucesso com gate.ok === false",
    );
    assert.match(
      content,
      /gate\.ok === false/,
      "deve nomear gate.ok === false como o sintoma canônico de refresh que não pegou",
    );
  });

  it("mantém o achado do #4485 que torna o passo obrigatório", () => {
    // Mudar só o VALOR do custom field (o que --push faz) continua não
    // disparando nada. É a assimetria entre salvar-o-formulário e
    // mudar-o-valor que justifica o passo manual existir.
    assert.match(
      content,
      /mudan[çc]a de VALOR do campo, que é o que o `--push` faz/,
      "deve preservar a assimetria medida no #4485 (salvar dispara; mudar valor não)",
    );
  });
});
