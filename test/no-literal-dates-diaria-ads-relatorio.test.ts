/**
 * test/no-literal-dates-diaria-ads-relatorio.test.ts (#8246)
 *
 * Trava a razão de ser da issue: a skill canônica `.claude/skills/diaria-ads-relatorio/SKILL.md`
 * NUNCA pode citar uma data de marco do teste 2608 (fim da janela, coorte
 * madura, apuração) em prosa — tudo tem que vir, em tempo de execução, do
 * `--json` de `ads-rolling-cac.ts`/`ads-test-watch.ts` (que leem
 * `run-state.json`). O defeito original (#8246): a versão local, fora do
 * git, tinha datas copiadas que ficaram velhas assim que o run-state foi
 * revisado de novo — sem teste algum barrando isso.
 *
 * (a) nenhuma data no formato AAAA-MM-DD/DD-MM (associada a marco do teste)
 *     pode aparecer no arquivo;
 * (b) os limiares citados na prosa (piso de amostra, limiar de aviso de
 *     gasto) batem com as constantes EXPORTADAS que a skill referencia —
 *     nunca um número solto que possa divergir em silêncio do código.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MIN_CADASTROS_PARA_COMPARAR } from "../scripts/lib/ads-rolling-window.ts";
import { SPEND_WARNING_RATIO_THRESHOLD } from "../scripts/lib/ads-test-watch.ts";

const SKILL_PATH = ".claude/skills/diaria-ads-relatorio/SKILL.md";
const SKILL_TEXT = readFileSync(SKILL_PATH, "utf8");

describe("#8246 — SKILL.md canônica do relatório de ads: sem data literal de marco do teste", () => {
  it("nenhuma data YYYY-MM-DD (formato de run-state.json) aparece no arquivo", () => {
    const matches = SKILL_TEXT.match(/\d{4}-\d{2}-\d{2}/g);
    assert.equal(
      matches,
      null,
      `data literal encontrada em ${SKILL_PATH}: ${JSON.stringify(matches)} — o defeito original (#8246) era ` +
        `exatamente isto: uma data de marco do teste copiada na hora de escrever a skill, que fica velha assim que ` +
        `o run-state.json é revisado de novo. A skill só deve ler datas do \`--json\` em tempo de execução.`,
    );
  });

  it("nenhuma data DD/MM (formato de prosa em PT-BR, ex: '19/09') aparece no arquivo", () => {
    const matches = SKILL_TEXT.match(/\b\d{2}\/\d{2}\b/g);
    assert.equal(
      matches,
      null,
      `data literal encontrada em ${SKILL_PATH}: ${JSON.stringify(matches)} — mesma razão do teste acima.`,
    );
  });
});

describe("#8246 — SKILL.md canônica do relatório de ads: limiares batem com as constantes exportadas", () => {
  it("piso de amostra citado na prosa bate com MIN_CADASTROS_PARA_COMPARAR", () => {
    assert.equal(MIN_CADASTROS_PARA_COMPARAR, 3, "se este número mudar, a prosa abaixo precisa mudar junto");
    assert.match(
      SKILL_TEXT,
      /MIN_CADASTROS_PARA_COMPARAR.*3 cadastros/,
      "a skill deve citar o piso de amostra pelo NOME da constante + o valor atual, nunca só um número solto",
    );
  });

  it("limiar de AVISO de gasto citado na prosa bate com SPEND_WARNING_RATIO_THRESHOLD", () => {
    assert.equal(SPEND_WARNING_RATIO_THRESHOLD, 1.25, "se este número mudar, a prosa abaixo precisa mudar junto");
    assert.match(
      SKILL_TEXT,
      /SPEND_WARNING_RATIO_THRESHOLD.*1,25×/,
      "a skill deve citar o limiar de aviso pelo NOME da constante + o valor atual, nunca só um número solto",
    );
  });
});
