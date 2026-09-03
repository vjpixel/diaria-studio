/**
 * test/erro-intencional-agent-scope-7214.test.ts (#7214)
 *
 * #633: PR de bugfix exige teste de regressão. O bug corrigido aqui é texto
 * de prompt de agente (`.claude/agents/*.md`), não código — o guard possível
 * é textual: asserções sobre o CONTEÚDO dos prompts, não comportamento
 * executável (o repo já usa esse padrão, ver `erro-intencional-guards-frontmatter.test.ts`
 * e os guards de `orchestrator-prompt.test.ts`).
 *
 * Bug: a regra "erro intencional só humano" nos 4 agentes de escrita
 * (writer, writer-destaque, social-writer, social-curto) estava escrita sem
 * escopo ("você nunca decide nem sugere"), sem dizer QUEM é "você" nem que a
 * proibição não vale pro orquestrador — que, no Stage 2, tem exatamente o
 * trabalho oposto (montar e propor uma candidata pronta pra aceite, #3808).
 * Resultado real (edição 260903): 3 leituras erradas em 3 contextos
 * distintos, todas concluindo "ninguém pode propor" a partir da frase
 * categórica. 3 dos 4 arquivos também citavam uma memória
 * (`feedback_intentional_error_human_only.md`) que não existe em nenhuma
 * máquina do projeto — citação pendurada, regra inauditável.
 *
 * Este teste trava 3 invariantes textuais:
 * 1. Nenhum agent cita mais a memória inexistente.
 * 2. Os 4 agentes de escrita continuam proibidos de propor/decidir o erro
 *    (o invariante REAL não mudou — só o escopo da frase).
 * 3. Os 4 agentes de escrita agora dizem explicitamente que a restrição é
 *    deles, não do orquestrador (a correção não pode regredir pra frase
 *    categórica de novo).
 * 4. `orchestrator-stage-2.md` referencia explicitamente essa mesma issue
 *    perto da instrução de montar a proposta — a referência cruzada pedida
 *    no item 3 da correção proposta.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WRITER_AGENT_FILES = [
  ".claude/agents/writer.md",
  ".claude/agents/writer-destaque.md",
  ".claude/agents/social-writer.md",
  ".claude/agents/social-curto.md",
];

function readAgent(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

describe("#7214 — regra 'erro intencional só humano' escopada nos agentes de escrita", () => {
  it("nenhum .claude/agents/*.md cita a memória inexistente feedback_intentional_error_human_only.md", () => {
    const offenders: string[] = [];
    for (const relPath of WRITER_AGENT_FILES) {
      const content = readAgent(relPath);
      if (content.includes("feedback_intentional_error_human_only.md")) {
        offenders.push(relPath);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `citação pendurada a memória inexistente ainda presente em: ${offenders.join(", ")}`,
    );
  });

  for (const relPath of WRITER_AGENT_FILES) {
    it(`${relPath}: continua proibindo o agente de decidir/sugerir o erro intencional`, () => {
      const content = readAgent(relPath);
      assert.match(
        content,
        /nunca decide nem (sugere|propõe)/i,
        `${relPath} deve manter o invariante real — o agente de escrita não decide nem sugere/propõe o erro`,
      );
    });

    it(`${relPath}: escopa a proibição a si mesmo, não ao orquestrador`, () => {
      const content = readAgent(relPath);
      // A frase precisa deixar explícito que a restrição é do PRÓPRIO agente
      // ("é sua", "restrição sua" etc.) — não uma proibição categórica sem
      // sujeito, que é exatamente o que causou as 3 leituras erradas do #7214.
      assert.match(
        content,
        /restrição é sua|é sua, não do orquestrador/i,
        `${relPath} deve deixar explícito que a proibição vale só para este agente, não para o orquestrador (#7214)`,
      );
      assert.match(
        content,
        /orchestrator-stage-2\.md/,
        `${relPath} deve apontar pra orchestrator-stage-2.md como responsável por propor a candidata (#7214)`,
      );
    });
  }

  it("orchestrator-stage-2.md referencia #7214 ao explicar que a regra 'só humano' não se aplica ao orquestrador", () => {
    const content = readAgent(".claude/agents/orchestrator-stage-2.md");
    assert.match(
      content,
      /#7214/,
      "orchestrator-stage-2.md deve citar #7214 na cross-reference que explica o escopo da regra 'erro intencional só humano'",
    );
    assert.match(
      content,
      /restringe SÓ ELES|não você/i,
      "orchestrator-stage-2.md deve dizer explicitamente que a regra dos agentes de escrita não se aplica ao orquestrador",
    );
  });
});
