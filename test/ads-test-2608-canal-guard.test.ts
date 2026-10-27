/**
 * test/ads-test-2608-canal-guard.test.ts (#8239 item 3 — "guard único")
 *
 * Guard ÚNICO sobre os scripts de ingestão de gasto do teste 2608. Os
 * testes por script (`test/meta-ads-ingest-spend.test.ts` #8239, e até o
 * #10755 o do Microsoft Ads, #7544) travam cada constante
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
 * A #5862 (27/10/2026) renomeou as specs temporárias "(teste 2608)" para os
 * nomes permanentes "X Ads (UTM)": as constantes mudaram juntas, e este
 * teste é o que exige que mudem juntas.
 *
 * #10755 (21/10/2026): o canal Microsoft Ads foi encerrado e o ingest dele
 * saiu do repo. O braço `Microsoft Ads (UTM)` (ex-"(teste 2608)") CONTINUA em
 * `CHANNEL_KEY_SPECS` e em `ADS_TEST_2608_BRACOS` — é o que mantém o gasto
 * já gravado em `spend.csv` atribuído ao braço no relatório de CAC e na
 * apuração do teste. Ele entra aqui como exceção documentada (braço só de
 * histórico, sem ingest), em `BRACOS_SO_HISTORICO`.
 *
 * Não chama API/MCP — só importa as constantes e compara com as specs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GOOGLE_ADS_CANAL } from "../scripts/google-ads-ingest-spend.ts";
import { META_ADS_CANAL } from "../scripts/meta-ads-ingest-spend.ts";
import { CHANNEL_KEY_SPECS } from "../scripts/lib/shared/channel-key-specs.ts";
import { ADS_TEST_2608_BRACOS } from "../scripts/lib/ads-test-run-state.ts";

/** Os canais escritos em `spend.csv` pelos ingests ATIVOS do teste 2608. */
const CANAIS_DE_INGESTAO = [
  { script: "google-ads-ingest-spend.ts", canal: GOOGLE_ADS_CANAL },
  { script: "meta-ads-ingest-spend.ts", canal: META_ADS_CANAL },
] as const;

/** Braços do teste 2608 sem ingest de propósito: canal encerrado, gasto só
 *  no histórico de `spend.csv` (#10755). Continuam precisando de spec e de
 *  lugar em `ADS_TEST_2608_BRACOS`, senão o histórico vira "canal
 *  desconhecido" no cac-report e some de `sumTeste2608Spend`. */
const BRACOS_SO_HISTORICO = ["Microsoft Ads (UTM)"] as const;

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
 * | `"Google Ads"` | **sim** (linhas 2026-02 PMax/Search usam esse nome) | não | 2 linhas pro MESMO gasto (`Google Ads` da ingestão + `Google Ads (UTM)` da reconciliação), **somadas** por `computeMonthBudgetUsage` — gasto contado 2× |
 * | `"Meta"` | não (só `RESERVED_CHANNEL_NAMES`) | não | linha cai no caminho "canal desconhecido" — aviso em stderr, n=0 no relatório |
 *
 * Por isso o invariante comum que este guard afirma é **"não é braço do
 * teste 2608"**, e não "não tem spec": `"Google Ads"` tem spec legítima e
 * deve continuar tendo (canal legado dez/2025–fev/2026, por referrer; a
 * #5862 manteve os dois separados). O que nenhum dos
 * dois pode ser é o canal que um ingest do teste 2608 escreve.
 */
const VALORES_DEFEITUOSOS = ["Google Ads", "Meta"] as const;

const specCanais = CHANNEL_KEY_SPECS.map((spec) => spec.canal);
const bracos = ADS_TEST_2608_BRACOS as readonly string[];

describe("#8239 — guard único: os ingests do teste 2608 escrevem canal com spec e braço", () => {
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

  it("os canais de ingestão são distintos entre si", () => {
    const canais = CANAIS_DE_INGESTAO.map((c) => c.canal);
    assert.equal(
      new Set(canais).size,
      canais.length,
      `Dois ingests escrevendo o mesmo canal somariam gastos de plataformas diferentes ` +
        `na mesma linha de spend.csv: ${JSON.stringify(canais)}`,
    );
  });

  it("cobre TODOS os braços do teste 2608 — um braço novo sem ingest cadastrado aqui falha", () => {
    // Se uma issue futura acrescentar um 4º braço, este
    // teste falha até que o ingest correspondente entre em CANAIS_DE_INGESTAO
    // — é o que impede a assimetria que gerou o #8239 (Microsoft corrigido
    // em #7544, Google esquecido por 2 meses, sem nada acusando).
    const canaisCobertos = new Set<string>([...CANAIS_DE_INGESTAO.map((c) => c.canal), ...BRACOS_SO_HISTORICO]);
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

  for (const braco of BRACOS_SO_HISTORICO) {
    it(`#10755 — braço só de histórico "${braco}" segue com spec e em ADS_TEST_2608_BRACOS (o gasto gravado continua lido)`, () => {
      assert.ok(specCanais.includes(braco), `${braco} perdeu a spec — o gasto histórico viraria "canal desconhecido"`);
      assert.ok(bracos.includes(braco), `${braco} saiu de ADS_TEST_2608_BRACOS — sumTeste2608Spend deixaria de somar o histórico`);
    });

    it(`#10755 — "${braco}" não tem mais ingest ativo (nenhum script escreve esse canal)`, () => {
      assert.equal(
        CANAIS_DE_INGESTAO.some((c) => (c.canal as string) === braco),
        false,
      );
    });
  }

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
            `intencional (renomeação como a do #5862), reveja este guard e a ` +
            `tabela de VALORES_DEFEITUOSOS junto.`,
        );
      });
    }

    it("nenhum dos ingests escreve um dos valores defeituosos", () => {
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
