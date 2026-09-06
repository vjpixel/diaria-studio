/**
 * test/continuo-tick-report-continuity-7511.test.ts (#7511)
 *
 * Guard do mecanismo que SUBSTITUIU `context_from: ["self"]` no job do
 * contínuo (`5d791ef6fc2c`).
 *
 * O que o `context_from: ["self"]` fazia: reinjetava o output ANTERIOR
 * INTEIRO do job. Esse output, medido em 05/09/2026, é
 * `header + SKILL.md verbatim + prompt + relatório` — ou seja, ~36 KB de
 * cópia literal da própria skill (~10,6k tokens, ~20% do baseline de 54,3k
 * medido no #6712) para carregar ~3 KB de relatório. A skill já é carregada
 * fresca em todo tick; a 2ª cópia era desperdício puro.
 *
 * O substituto tem DUAS pontas, em seções distantes do SKILL.md:
 *   - ESCRITA: último passo do tick grava o relatório em
 *     `data/continuo/last-tick-report.md` (seção "Relatório de tick")
 *   - LEITURA: passo 1b do ciclo lê esse mesmo arquivo (seção "Cada ciclo")
 *
 * É exatamente a forma de bug que este repo já colecionou várias vezes: duas
 * pontas que precisam concordar, escritas longe uma da outra, onde mexer numa
 * e esquecer a outra não quebra nada visivelmente — só faz a continuidade
 * sumir em silêncio, e o próximo tick começa cego sem ninguém notar. Mesma
 * classe do #6928 (cadência em prosa) e do #5821 (label de decisão não
 * removida): o guard mecânico existe porque a prosa correta não bastou.
 *
 * Este teste NÃO alcança `~/.hermes/cron/jobs.json` (estado de máquina, fora
 * do repo) — não há como o CI verificar que `context_from` foi de fato
 * removido lá. O que ele tranca é a metade que dá: as duas pontas dentro do
 * repo existem e citam o MESMO caminho.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = join(
  ROOT,
  "hermes",
  "skills",
  "hermes-diaria-continuo",
  "SKILL.md",
);

/** Caminho único de continuidade entre ticks. Mudar aqui exige mudar as duas
 * pontas no SKILL.md — que é precisamente o que este teste trava. */
export const CONTINUO_TICK_REPORT_PATH = "data/continuo/last-tick-report.md";

function skill(): string {
  return readFileSync(SKILL_MD, "utf8");
}

describe("contínuo: continuidade de tick sem context_from (#7511)", () => {
  it("a ponta de LEITURA (passo 1b) cita o arquivo de relatório", () => {
    const body = skill();
    const trecho = body.slice(
      body.indexOf("### 1. Preparar e sincronizar"),
      body.indexOf("### 2. Classificar"),
    );
    assert.ok(
      trecho.length > 0,
      "não achei a seção do passo 1 no SKILL.md — a estrutura mudou",
    );
    assert.ok(
      trecho.includes(CONTINUO_TICK_REPORT_PATH),
      `passo 1 do ciclo não lê ${CONTINUO_TICK_REPORT_PATH} — sem isso o tick ` +
        "começa sem nenhuma continuidade com o anterior (o context_from que " +
        "fazia esse papel foi removido no #7511)",
    );
  });

  it("a ponta de ESCRITA (relatório de tick) grava no mesmo arquivo", () => {
    const body = skill();
    const trecho = body.slice(body.indexOf("## Relatório de tick"));
    assert.ok(
      trecho.length > 0,
      "não achei a seção 'Relatório de tick' no SKILL.md",
    );
    assert.ok(
      trecho.includes(CONTINUO_TICK_REPORT_PATH),
      `a seção de relatório não manda persistir em ${CONTINUO_TICK_REPORT_PATH} — ` +
        "o passo 1b do tick seguinte leria um arquivo que ninguém escreve",
    );
  });

  it("escrita é sobrescrita, nunca append", () => {
    const body = skill();
    const trecho = body.slice(body.indexOf("## Relatório de tick"));
    assert.ok(
      /sobrescrev/i.test(trecho),
      "a seção de relatório precisa dizer explicitamente que SOBRESCREVE: " +
        "em append o arquivo vira histórico e cresce sem teto, reintroduzindo " +
        "por outro caminho exatamente o inchaço de contexto que o #7511 cortou",
    );
  });

  it("registra por que context_from foi removido, não só que foi", () => {
    const body = skill();
    assert.ok(
      body.includes("context_from"),
      "o SKILL.md deve explicar que substitui o context_from: sem o porquê, " +
        "a primeira pessoa que sentir falta da continuidade religa o " +
        "mecanismo antigo e traz de volta a duplicação da skill",
    );
  });
});
