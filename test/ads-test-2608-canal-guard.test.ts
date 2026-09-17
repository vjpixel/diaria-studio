/**
 * test/ads-test-2608-canal-guard.test.ts (#8239 item 3 — "guard único")
 *
 * Guard ÚNICO sobre os 3 scripts de ingestão de gasto do teste 2608. Os
 * testes por script (`test/microsoft-ads-ingest-spend.test.ts` #7544,
 * `test/meta-ads-ingest-spend.test.ts` #8239) travam cada constante
 * isoladamente; nada garantia que um 4º braço, ou um braço renomeado,
 * entrasse na mesma disciplina — o defeito do #8239 foi exatamente o
 * Google ficar de fora por 2 meses depois do Microsoft ter sido corrigido
 * (#7544, PR #7547), sem nenhum teste acusando a assimetria.
 *
 * O invariante: **o canal que cada script ESCREVE em `spend.csv` tem que
 * existir nas 2 fontes de verdade** — `CHANNEL_KEY_SPECS` (senão a linha
 * cai no caminho "canal desconhecido": aviso em stderr e n=0 no relatório,
 * mesmo com gasto real) e `ADS_TEST_2608_BRACOS` (senão o gasto não é
 * atribuído a nenhum braço do teste, e `sumTeste2608Spend` o ignora).
 *
 * Quando a #5862 renomear ou remover as specs temporárias "(teste 2608)",
 * as 3 constantes mudam juntas e este teste é o que exige que mudem juntas.
 *
 * Não chama API/MCP — só importa as constantes e compara com as specs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GOOGLE_ADS_CANAL } from "../scripts/google-ads-ingest-spend.ts";
import { META_ADS_CANAL } from "../scripts/meta-ads-ingest-spend.ts";
import { MICROSOFT_ADS_CANAL } from "../scripts/microsoft-ads-ingest-spend.ts";
import { CHANNEL_KEY_SPECS } from "../scripts/lib/shared/channel-key-specs.ts";
import { ADS_TEST_2608_BRACOS } from "../scripts/lib/ads-test-run-state.ts";

/** Os 3 canais escritos em `spend.csv` pelos ingests do teste 2608. */
const CANAIS_DE_INGESTAO = [
  { script: "google-ads-ingest-spend.ts", canal: GOOGLE_ADS_CANAL },
  { script: "meta-ads-ingest-spend.ts", canal: META_ADS_CANAL },
  { script: "microsoft-ads-ingest-spend.ts", canal: MICROSOFT_ADS_CANAL },
] as const;

/**
 * Valores que os scripts JÁ usaram e que causaram (ou teriam causado) o
 * defeito do #8239. O caso negativo prova que este guard pega o defeito
 * original, não só concorda com o estado atual.
 *
 * **Os dois falham por motivos DIFERENTES, e a assimetria importa** —
 * medida em 17/09/2026:
 *
 * | valor | spec em CHANNEL_KEY_SPECS | braço do teste | como o defeito aparece |
 * |---|---|---|---|
 * | `"Google Ads"` | **sim** (linhas 2026-02 PMax/Search usam esse nome) | não | 2 linhas pro MESMO gasto (`Google Ads` da ingestão + `Google Ads (teste 2608)` da reconciliação), **somadas** por `computeMonthBudgetUsage` — gasto contado 2× |
 * | `"Meta"` | não (só `RESERVED_CHANNEL_NAMES`) | não | linha cai no caminho "canal desconhecido" — aviso em stderr, n=0 no relatório |
 *
 * Por isso o invariante comum que este guard afirma é **"não é braço do
 * teste 2608"**, e não "não tem spec": `"Google Ads"` tem spec legítima e
 * deve continuar tendo (a #5862 decide o destino dela). O que nenhum dos
 * dois pode ser é o canal que um ingest do teste 2608 escreve.
 */
const VALORES_DEFEITUOSOS = ["Google Ads", "Meta"] as const;

const specCanais = CHANNEL_KEY_SPECS.map((spec) => spec.canal);
const bracos = ADS_TEST_2608_BRACOS as readonly string[];

describe("#8239 — guard único: os 3 ingests do teste 2608 escrevem canal com spec e braço", () => {
  for (const { script, canal } of CANAIS_DE_INGESTAO) {
    it(`${script}: canal "${canal}" tem entrada em CHANNEL_KEY_SPECS`, () => {
      assert.ok(
        specCanais.includes(canal),
        `${script} escreve o canal "${canal}", que NÃO tem entrada em CHANNEL_KEY_SPECS ` +
          `(${JSON.stringify(specCanais)}). Sem spec, a linha de gasto cai no caminho ` +
          `"canal desconhecido" — aviso em stderr e n=0 no cac-report, com gasto real acontecendo.`,
      );
    });

    it(`${script}: canal "${canal}" é um braço de ADS_TEST_2608_BRACOS`, () => {
      assert.ok(
        bracos.includes(canal),
        `${script} escreve o canal "${canal}", que NÃO está em ADS_TEST_2608_BRACOS ` +
          `(${JSON.stringify(bracos)}) — o gasto não seria atribuído a nenhum braço do teste, ` +
          `e sumTeste2608Spend o ignoraria no digest diário.`,
      );
    });
  }

  it("os 3 canais são distintos entre si", () => {
    const canais = CANAIS_DE_INGESTAO.map((c) => c.canal);
    assert.equal(
      new Set(canais).size,
      canais.length,
      `Dois ingests escrevendo o mesmo canal somariam gastos de plataformas diferentes ` +
        `na mesma linha de spend.csv: ${JSON.stringify(canais)}`,
    );
  });

  it("cobre TODOS os braços do teste 2608 — um braço novo sem ingest cadastrado aqui falha", () => {
    // Se a #5862 (ou qualquer issue futura) acrescentar um 4º braço, este
    // teste falha até que o ingest correspondente entre em CANAIS_DE_INGESTAO
    // — é o que impede a assimetria que gerou o #8239 (Microsoft corrigido
    // em #7544, Google esquecido por 2 meses, sem nada acusando).
    const canaisCobertos = new Set<string>(CANAIS_DE_INGESTAO.map((c) => c.canal));
    const semCobertura = bracos.filter((braco) => !canaisCobertos.has(braco));
    assert.deepEqual(
      semCobertura,
      [],
      `Braço(s) de ADS_TEST_2608_BRACOS sem ingest coberto por este guard: ` +
        `${JSON.stringify(semCobertura)}. Acrescente a constante do ingest correspondente ` +
        `em CANAIS_DE_INGESTAO (ou, se o braço não tem ingest próprio de propósito, ` +
        `documente a exceção aqui).`,
    );
  });

  describe("caso negativo — os valores que causaram o #8239 falhariam este guard", () => {
    for (const defeituoso of VALORES_DEFEITUOSOS) {
      it(`"${defeituoso}" NÃO é braço do teste 2608 — é o que o torna errado pros ingests`, () => {
        // Deliberadamente NÃO afirmamos nada sobre spec aqui: "Google Ads"
        // TEM spec (linhas 2026-02) e "Meta" não tem. Ver a tabela em
        // VALORES_DEFEITUOSOS — o invariante comum é ser braço, não ter spec.
        assert.equal(
          bracos.includes(defeituoso),
          false,
          `"${defeituoso}" virou um braço do teste 2608 (ADS_TEST_2608_BRACOS). Se foi ` +
            `intencional (#5862 renomeando as specs temporárias), reveja este guard e a ` +
            `tabela de VALORES_DEFEITUOSOS junto.`,
        );
      });
    }

    it("nenhum dos 3 ingests escreve um dos valores defeituosos", () => {
      for (const { script, canal } of CANAIS_DE_INGESTAO) {
        assert.equal(
          (VALORES_DEFEITUOSOS as readonly string[]).includes(canal),
          false,
          `${script} voltou a escrever o nome genérico "${canal}" — é a regressão exata do #8239 ` +
            `(duplica o gasto do braço numa 2ª linha de spend.csv, que o cac-report soma junto).`,
        );
      }
    });
  });
});
