/**
 * test/overnight-paralelo-contrato.test.ts (#6299)
 *
 * O `/diaria-overnight` deixou de ser serial. Toda a mudança é PROSA — não há
 * função nova pra testar —, e é exatamente por isso que este arquivo existe:
 * a #6299 nasce da observação de que **afirmação em prosa envelhece sem que
 * ninguém perceba**, e a prova disso estava no próprio texto que ela corrige.
 *
 * A justificativa da serialização era: *"sem supervisão, paralelo elevaria o
 * blast-radius"* — escrita quando o overnight não tinha defesa nenhuma além de
 * "um de cada vez". Desde então o repo construiu 9 mecanismos determinísticos
 * que tornam o paralelo seguro (worktree isolado, cluster de conflito, fusão
 * de colidentes, `is-claimed` check-and-set, `conflicts` por arquivo, merge
 * lock, fleet review pré-merge, Gate 2, guard do #5716) e **nenhum deles exige
 * o editor presente**. A frase continuou lá, e continuou decidindo.
 *
 * Este teste trava as 3 afirmações que precisam permanecer verdadeiras juntas
 * — se alguém reverter uma sem as outras, o texto volta a mentir:
 *
 *   1. o overnight declara paralelismo com teto explícito;
 *   2. o MERGE segue estritamente serial nas duas skills;
 *   3. nenhuma das duas volta a atribuir a segurança do paralelo à
 *      supervisão humana.
 *
 * Não é um teste de comportamento — é um guard de coerência entre documentos
 * que decidem execução, no mesmo espírito de
 * `test/continuo-infra-consumidor-externo.test.ts` (#6056) e
 * `test/hub-registry-completeness.test.ts` (#4558): cruzar duas pontas
 * mantidas separadamente e falhar quando uma some.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const OVERNIGHT = ".claude/skills/diaria-overnight/SKILL.md";
const DEVELOP = ".claude/skills/diaria-develop/SKILL.md";
const CLAUDE_MD = "CLAUDE.md";

describe("#6299 — o overnight declara paralelismo, com teto", () => {
  it("a SKILL.md do overnight fala em compor ONDA antes do fan-out", () => {
    const s = read(OVERNIGHT);
    assert.match(
      s,
      /Compor a onda antes de dispatchar/,
      "o passo de composição de onda sumiu do overnight — sem ele o fan-out não tem o que despachar em paralelo",
    );
  });

  it("declara teto de concorrência explícito, e menor que o do develop", () => {
    const s = read(OVERNIGHT);
    assert.match(
      s,
      /Teto de concorrência: 3/,
      "o teto do overnight sumiu ou mudou de forma — ele é deliberadamente MENOR que os 6 do develop porque roda desassistido",
    );
  });

  it("reusa a análise de cluster do develop em vez de reimplementar", () => {
    const s = read(OVERNIGHT);
    assert.match(s, /an[áa]lise de cluster/i);
    assert.match(
      s,
      /fundem numa unidade s[óo]/,
      "a fusão de colidentes é o que faz o #636 continuar satisfeito POR CONSTRUÇÃO",
    );
  });
});

describe("#6299 — o MERGE continua estritamente serial nas duas skills", () => {
  // Esta é a metade que NÃO pode afrouxar junto. Paralelizar implementação e
  // paralelizar merge são coisas diferentes; a issue muda só a primeira.
  for (const [nome, path] of [
    ["overnight", OVERNIGHT],
    ["develop", DEVELOP],
  ] as const) {
    it(`${nome}: exige merge-lock-acquire antes do gh pr merge`, () => {
      const s = read(path);
      assert.match(
        s,
        /merge-lock-acquire/,
        `${nome} deixou de exigir o merge lock — master receberia mais de um squash ao mesmo tempo`,
      );
    });
  }

  it("o overnight afirma explicitamente que só o merge é serial", () => {
    const s = read(OVERNIGHT);
    assert.match(
      s,
      /merge continua estritamente serial/i,
      "a distinção 'implementação paralela, merge serial' sumiu — é ela que preserva o histórico linear de master",
    );
  });

  it("CLAUDE.md acompanha: onda no dispatch, serial no merge", () => {
    const s = read(CLAUDE_MD);
    assert.match(
      s,
      /s[óo] o MERGE segue serial/i,
      "CLAUDE.md voltou a dizer '1 unidade por vez' sem a ressalva — é o arquivo carregado em TODA sessão, então mentir aqui custa mais",
    );
  });
});

describe("#6299 — nenhuma skill volta a creditar o paralelo à supervisão humana", () => {
  it("o develop não afirma mais que a supervisão é o que torna o paralelo seguro", () => {
    const s = read(DEVELOP);
    // A frase original era: "aqui a supervisão humana torna o paralelo
    // seguro". Ela sustentava a serialização do overnight por contraste — e
    // era factualmente errada: os 9 mecanismos que garantem a segurança são
    // todos determinísticos.
    assert.doesNotMatch(
      s,
      /supervis[ãa]o humana torna o paralelo seguro/i,
      "a afirmação factualmente errada voltou — ver #6299: o que torna o paralelo seguro é determinístico, não a presença do editor",
    );
  });

  it("o develop registra o que a supervisão humana DE FATO cobre", () => {
    const s = read(DEVELOP);
    assert.match(
      s,
      /Gate 1 cat\. C.*Gate B|Gate B.*Gate 1 cat\. C/s,
      "sumiu o registro de que a supervisão cobre Gate 1 cat. C e Gate B — sem isso a correção do #6299 perde o contraponto e alguém reverte por parecer que 'a supervisão não servia pra nada'",
    );
  });

  it("o overnight não descreve a si mesmo como serial por blast-radius", () => {
    const s = read(OVERNIGHT);
    assert.doesNotMatch(
      s,
      /Overnight roda serial \(#636\)/,
      "voltou a afirmação de que o overnight é serial — o #6299 a substituiu",
    );
  });
});

describe("#6299 — active_worktrees deixou de ser cosmético", () => {
  it("o overnight instrui chamar heartbeat --active-worktrees", () => {
    const s = read(OVERNIGHT);
    assert.match(
      s,
      /heartbeat --active-worktrees/,
      "sem este call site, o teto por sessão não compõe entre sessões: overnight e develop somariam worktrees sem ninguém enxergar (#5156 item 6, que nunca teve chamador)",
    );
  });
});
