/**
 * test/ads-rolling-window-7577.test.ts (#7577)
 *
 * A janela móvel de 3 dias substituiu o acumulado como unidade de comparação
 * do teste 2608 (decisão do editor, 07/09/2026). Estes testes travam as quatro
 * coisas que o relatório errou — ou erraria — se a conta ficasse em prosa:
 *
 * 1. **O CSV é ACUMULADO, então a janela é uma diferença.** Somar as linhas do
 *    período multiplicaria o gasto pelo número de dias. É o erro mais fácil de
 *    cometer olhando a tabela, porque cada linha parece um dia.
 * 2. **Sem dado ≠ zero ≠ o pior.** Braço abaixo do piso de amostra sai do
 *    ranking com a célula VAZIA (§3.5), nunca com CAC 0 ou infinito.
 * 3. **Janela que cruza um refinamento não é estado estável** (§3.4, D5) — e
 *    só `edicao-em-voo` conta; `investigacao` não mudou a conta.
 * 4. **A fronteira do dia é BRT nos dois lados.** Contar cadastro do Kit por
 *    UTC desloca ~3h entre dias adjacentes, sobre um denominador pequeno.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ClicksCsvRow } from "../scripts/lib/ads-test-watch.ts";
import {
  MIN_CADASTROS_PARA_COMPARAR,
  brtDateOf,
  computeDailyCac,
  computeDailyCacSeries,
  computeRollingWindow,
  contarDiasAposUltimaEdicao,
  descreverEstabilidade,
  shiftDate,
} from "../scripts/lib/ads-rolling-window.ts";

const CANAL = "Google Ads (teste 2608)";

function row(data: string, gasto: number, cadastros: number | null): ClicksCsvRow {
  return {
    canal: CANAL,
    data_apuracao: data as ClicksCsvRow["data_apuracao"],
    gasto_acumulado: gasto,
    leitoresAcumulado: null,
    cadastrosAcumulado: cadastros,
  };
}

describe("#7577 — a janela é DIFERENÇA de acumulados, não soma de linhas", () => {
  it("desconta a linha-base imediatamente anterior à janela", () => {
    // 4 dias acumulados; janela de 3 termina em 04. Base = dia 01 (100/10).
    const rows = [row("2026-09-01", 100, 10), row("2026-09-02", 130, 14), row("2026-09-03", 160, 17), row("2026-09-04", 190, 22)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.gastoJanela, 90, "190 − 100, nunca 130+160+190");
    assert.equal(r.cadastrosJanela, 12, "22 − 10");
    assert.equal(r.custoPorCadastro, 7.5);
    assert.deepEqual(r.dias, ["2026-09-02", "2026-09-03", "2026-09-04"]);
  });

  it("sem linha-base (braço começou dentro da janela), o acumulado JÁ é o total", () => {
    const rows = [row("2026-09-03", 60, 6), row("2026-09-04", 90, 9)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.gastoJanela, 90);
    assert.equal(r.cadastrosJanela, 9);
  });

  it("o acumulado continua reportado ao lado — a §3.2 depende dele", () => {
    const rows = [row("2026-09-01", 100, 10), row("2026-09-04", 190, 22)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.gastoAcumulado, 190);
    assert.equal(r.cadastrosAcumulado, 22);
  });

  it("ignora linhas posteriores a `ate` — o dia em curso nunca entra", () => {
    const rows = [row("2026-09-03", 60, 6), row("2026-09-04", 90, 9), row("2026-09-05", 120, 12)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.gastoAcumulado, 90, "a linha do dia 05 não pode entrar");
  });

  it("não mistura braços", () => {
    const rows = [row("2026-09-04", 90, 9), { ...row("2026-09-04", 999, 999), canal: "Meta Ads (teste 2608)" }];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.gastoJanela, 90);
  });
});

describe("#7577 — sem dado nunca vira zero nem 'o pior'", () => {
  it("abaixo do piso de amostra: sem CAC, fora da comparação, com motivo", () => {
    const rows = [row("2026-09-03", 50, 0), row("2026-09-04", 80, 2)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.cadastrosJanela, 2);
    assert.equal(r.custoPorCadastro, null, "célula vazia, nunca 0 nem Infinity");
    assert.equal(r.comparavel, false);
    assert.match(r.motivo ?? "", new RegExp(String(MIN_CADASTROS_PARA_COMPARAR)));
  });

  it("exatamente no piso já entra na comparação", () => {
    const rows = [row("2026-09-03", 0, 0), row("2026-09-04", 90, 3)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.comparavel, true);
    assert.equal(r.custoPorCadastro, 30);
  });

  it("coluna cadastros vazia no último dia é 'sem numerador', não zero cadastros", () => {
    const rows = [row("2026-09-03", 50, 5), row("2026-09-04", 80, null)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.comparavel, false);
    assert.match(r.motivo ?? "", /vazia/);
    assert.equal(r.custoPorCadastro, null);
  });

  it("braço sem nenhuma linha na janela sai com motivo, não com números inventados", () => {
    const rows = [row("2026-08-01", 500, 50)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.comparavel, false);
    assert.equal(r.custoPorCadastro, null);
    assert.match(r.motivo ?? "", /sem nenhuma linha/);
    assert.equal(r.gastoAcumulado, 500, "o acumulado histórico continua visível");
  });
});

describe("#7577 — janela que cruza refinamento não é estado estável", () => {
  const dias = ["2026-09-02", "2026-09-03", "2026-09-04"];

  it("conta só os dias POSTERIORES à última edição em voo", () => {
    const { diasApos, ultimaEdicao } = contarDiasAposUltimaEdicao(
      [{ braco: CANAL, tipo: "edicao-em-voo", registrado_em_utc: "2026-09-03T12:00:00.000Z" }],
      CANAL,
      dias,
    );
    assert.equal(ultimaEdicao, "2026-09-03");
    assert.equal(diasApos, 1);
  });

  it("`investigacao` NÃO conta — olhar a conta não é mudá-la", () => {
    const { diasApos, ultimaEdicao } = contarDiasAposUltimaEdicao(
      [{ braco: CANAL, tipo: "investigacao", registrado_em_utc: "2026-09-03T12:00:00.000Z" }],
      CANAL,
      dias,
    );
    assert.equal(ultimaEdicao, null);
    assert.equal(diasApos, null, "janela sem edição é estável, e investigação não a torna instável");
  });

  it("edição de OUTRO braço não afeta este", () => {
    const { ultimaEdicao } = contarDiasAposUltimaEdicao(
      [{ braco: "Meta Ads (teste 2608)", tipo: "edicao-em-voo", registrado_em_utc: "2026-09-03T12:00:00.000Z" }],
      CANAL,
      dias,
    );
    assert.equal(ultimaEdicao, null);
  });

  it("a frase de estabilidade distingue os três estados", () => {
    const base = {
      canal: CANAL,
      dias,
      gastoJanela: 0,
      cadastrosJanela: 0,
      custoPorCadastro: null,
      comparavel: false,
      motivo: null,
      gastoAcumulado: 0,
      cadastrosAcumulado: null,
      baseData: null,
      janelaDias: 3,
    };
    assert.match(descreverEstabilidade({ ...base, diasAposUltimaEdicao: null, ultimaEdicao: null }), /estável/);
    assert.match(
      descreverEstabilidade({ ...base, diasAposUltimaEdicao: 0, ultimaEdicao: "2026-09-05" }),
      /não é estado estável/,
    );
    assert.match(
      descreverEstabilidade({ ...base, diasAposUltimaEdicao: 1, ultimaEdicao: "2026-09-03" }),
      /cruza refinamento/,
    );
    assert.match(
      descreverEstabilidade({ ...base, diasAposUltimaEdicao: 3, ultimaEdicao: "2026-09-01" }),
      /estado estável/,
    );
  });
});

describe("#7577 — a fronteira do dia é BRT, um só, dos dois lados", () => {
  it("instante UTC depois das 21h cai no MESMO dia em BRT", () => {
    // 2026-09-03T23:30Z = 20:30 BRT do dia 3. Por UTC seria dia 3 também.
    assert.equal(brtDateOf("2026-09-03T23:30:00.000Z"), "2026-09-03");
  });

  it("instante UTC de madrugada pertence ao dia ANTERIOR em BRT", () => {
    // 2026-09-04T02:00Z = 23:00 BRT do dia 3. Contar por UTC jogaria este
    // cadastro para o dia 4 — o deslocamento de ~3h que a issue nomeia.
    assert.equal(brtDateOf("2026-09-04T02:00:00.000Z"), "2026-09-03");
  });

  it("shiftDate atravessa virada de mês sem depender de fuso", () => {
    assert.equal(shiftDate("2026-09-02", -3), "2026-08-30");
    assert.equal(shiftDate("2026-09-01", -1), "2026-08-31");
  });
});

/**
 * Achados do fleet de review da PR #7586. Os dois mais graves eram do mesmo
 * formato — **um número errado que parece certo**, entrando na comparação com
 * `comparavel: true` e nenhum aviso. É o pior resultado possível num relatório
 * que o editor lê de manhã e usa para decidir se continua financiando um canal.
 */
describe("#7577 — linha-base sem cadastros não vira zero (achado P0 do review)", () => {
  it("base PRESENTE com a coluna vazia sai da comparação, em vez de descontar 0", () => {
    // Descontar 0 faria `cadUltima − 0` devolver o HISTÓRICO INTEIRO do braço
    // como se tudo tivesse acontecido nos 3 dias: numerador inflado, CAC
    // artificialmente barato, e nenhum sinal de que o número está errado.
    const rows = [row("2026-09-01", 100, null), row("2026-09-04", 190, 40)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.comparavel, false);
    assert.equal(r.custoPorCadastro, null);
    assert.match(r.motivo ?? "", /linha-base/);
    assert.match(r.motivo ?? "", /2026-09-01/, "o motivo precisa nomear a linha problemática");
  });

  it("base AUSENTE continua valendo 0 — é o braço que começou dentro da janela", () => {
    const rows = [row("2026-09-03", 60, 6), row("2026-09-04", 90, 9)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.comparavel, true, "ausência de base é caso legítimo, não erro");
    assert.equal(r.cadastrosJanela, 9);
  });
});

describe("#7577 — acumulado que CAI é dado inconsistente, não janela pequena", () => {
  // Já aconteceu neste dataset: em 07/09/2026 a mesma consulta devolveu 47
  // cadastros para 05/09 onde no dia anterior tinha devolvido 48.
  it("cadastros_acumulado menor que a base sai da comparação nomeando a queda", () => {
    const rows = [row("2026-09-01", 100, 48), row("2026-09-04", 190, 47)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.comparavel, false);
    assert.match(r.motivo ?? "", /DIMINUIU/);
    assert.match(r.motivo ?? "", /cadastros_acumulado/);
  });

  it("gasto_acumulado que cai NUNCA produz CAC negativo comparável", () => {
    // Sem a guarda: gastoJanela = 150 − 200 = −50, cadastrosJanela = 10 (passa
    // do piso), custoPorCadastro = −5 e `comparavel: true`. A tabela mostraria
    // "R$ -5,00" alinhado à direita, onde o sinal passa batido.
    const rows = [row("2026-09-01", 200, 10), row("2026-09-04", 150, 20)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.comparavel, false);
    assert.equal(r.custoPorCadastro, null, "CAC negativo nunca pode entrar na comparação");
    assert.match(r.motivo ?? "", /gasto_acumulado/);
    assert.match(r.motivo ?? "", /DIMINUIU/);
  });

  it("a queda é distinguida de amostra baixa — exigem ações opostas do editor", () => {
    const queda = computeRollingWindow([row("2026-09-01", 10, 9), row("2026-09-04", 20, 8)], {
      canal: CANAL,
      ate: "2026-09-04",
    });
    const amostra = computeRollingWindow([row("2026-09-01", 10, 5), row("2026-09-04", 20, 6)], {
      canal: CANAL,
      ate: "2026-09-04",
    });
    assert.match(queda.motivo ?? "", /DIMINUIU/, "corrigir o CSV");
    assert.match(amostra.motivo ?? "", /abaixo do piso/, "esperar mais dado");
    assert.notEqual(queda.motivo, amostra.motivo);
  });
});

describe("#7577 — dia faltando na janela é visível, e não estraga a aritmética", () => {
  it("o CAC continua correto com um buraco no meio da janela", () => {
    // Sem o dia 03: o gasto ainda é `último − anterior à janela`, e um buraco
    // no MEIO não causa contagem dupla nem falta.
    const rows = [row("2026-09-01", 100, 10), row("2026-09-02", 130, 14), row("2026-09-04", 190, 22)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.gastoJanela, 90);
    assert.equal(r.cadastrosJanela, 12);
    assert.equal(r.comparavel, true);
  });

  it("`janelaDias` expõe o buraco que `dias.length` sozinho esconderia", () => {
    const rows = [row("2026-09-01", 100, 10), row("2026-09-04", 190, 22)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.equal(r.janelaDias, 3, "a janela pedida tem 3 dias de calendário");
    assert.equal(r.dias.length, 1, "só 1 tem linha de apuração");
    assert.match(descreverEstabilidade(r), /sem linha de apuração/, "o relatório precisa dizer isso");
  });

  it("janela completa não emite aviso de buraco", () => {
    const rows = [row("2026-09-02", 130, 14), row("2026-09-03", 160, 17), row("2026-09-04", 190, 22)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04" });
    assert.doesNotMatch(descreverEstabilidade(r), /sem linha de apuração/);
  });
});

describe("#7577 — CAC diário (ontem/anteontem) reusa as guardas da janela", () => {
  it("o gasto do dia é a DIFERENÇA de acumulados, não o valor da linha", () => {
    // A armadilha nº 1 do CSV acumulado, agora sobre um único dia: ler
    // `gasto_acumulado` da linha de 07 como se fosse o gasto de 07 devolveria
    // R$ 300,00 no lugar de R$ 100,00 — um CAC 3x mais caro.
    const rows = [row("2026-09-05", 100, 10), row("2026-09-06", 200, 24), row("2026-09-07", 300, 34)];
    const d = computeDailyCac(rows, { canal: CANAL, dia: "2026-09-07" });
    assert.equal(d.gasto, 100);
    assert.equal(d.cadastros, 10);
    assert.equal(d.custoPorCadastro, 10);
    assert.equal(d.comparavel, true);
  });

  it("o primeiro dia do braço não tem linha-base, e o acumulado JÁ é o dia", () => {
    const rows = [row("2026-09-05", 100, 10)];
    const d = computeDailyCac(rows, { canal: CANAL, dia: "2026-09-05" });
    assert.equal(d.gasto, 100);
    assert.equal(d.cadastros, 10);
  });

  it("dia abaixo do piso de amostra sai sem CAC, e o motivo diz por quê", () => {
    // O piso morde bem mais sobre 1 dia que sobre 3 — é o comportamento certo,
    // e a célula vazia precisa continuar significando "sem amostra", nunca
    // "o braço parou" nem "o pior" (§3.5).
    const rows = [row("2026-09-06", 200, 24), row("2026-09-07", 260, 24 + MIN_CADASTROS_PARA_COMPARAR - 1)];
    const d = computeDailyCac(rows, { canal: CANAL, dia: "2026-09-07" });
    assert.equal(d.custoPorCadastro, null);
    assert.equal(d.comparavel, false);
    assert.match(d.motivo ?? "", /abaixo do piso/);
    // gasto continua reportável — só o CAC é que não é.
    assert.equal(d.gasto, 60);
  });

  it("coluna de cadastros vazia no dia devolve null, nunca 0", () => {
    const rows = [row("2026-09-06", 200, 24), row("2026-09-07", 300, null)];
    const d = computeDailyCac(rows, { canal: CANAL, dia: "2026-09-07" });
    assert.equal(d.cadastros, null, "0 aqui afirmaria 'nenhum cadastro' onde a verdade é 'não medido'");
    assert.equal(d.custoPorCadastro, null);
    assert.equal(d.comparavel, false);
  });

  it("acumulado que CAI no dia não vira dia barato", () => {
    // Já aconteceu neste dataset: a base do Kit se move para trás entre
    // leituras. Sem a guarda herdada, o dia sairia com CAC negativo.
    const rows = [row("2026-09-06", 200, 30), row("2026-09-07", 300, 28)];
    const d = computeDailyCac(rows, { canal: CANAL, dia: "2026-09-07" });
    assert.equal(d.comparavel, false);
    assert.equal(d.custoPorCadastro, null);
    assert.match(d.motivo ?? "", /DIMINUIU/);
  });

  it("a série sai do mais ANTIGO para o mais recente", () => {
    // Ordem invertida faria a coluna de tendência contar o oposto da
    // tendência real, sem nada na tela denunciando a inversão.
    const rows = [row("2026-09-05", 100, 10), row("2026-09-06", 200, 24), row("2026-09-07", 300, 34)];
    const serie = computeDailyCacSeries(rows, { canal: CANAL, ate: "2026-09-07", n: 2 });
    assert.deepEqual(
      serie.map((d) => d.dia),
      ["2026-09-06", "2026-09-07"],
    );
    assert.equal(serie[0].cadastros, 14);
    assert.equal(serie[1].cadastros, 10);
  });

  it("REGRESSÃO (review #7632): dia sem linha de apuração devolve null em gasto E cadastros", () => {
    // O buraco NÃO está no último dia da série, de propósito: é justamente o
    // caso que `findMissingClicksBracosForDate` (guard da CLI) não cobre, e o
    // único jeito de ele aparecer é aqui.
    //
    // O bug era ler a nulidade de `r.cadastrosAcumulado`, que no ramo sem
    // `ultima` traz a última linha CONHECIDA (aqui, a de 09-05, com 10) — o dia
    // saía com `cadastros: 0`, afirmando "nenhum cadastro em 09-06" sobre um
    // dia que ninguém mediu. A versão anterior deste teste passava mesmo com o
    // bug, porque não checava `cadastros` nem `gasto`.
    const rows = [row("2026-09-05", 100, 10), row("2026-09-07", 300, 34)];
    const serie = computeDailyCacSeries(rows, { canal: CANAL, ate: "2026-09-07", n: 2 });
    const anteontem = serie[0];
    assert.equal(anteontem.dia, "2026-09-06");
    assert.equal(anteontem.cadastros, null, "0 aqui afirmaria 'nenhum cadastro' sobre um dia não medido");
    assert.equal(anteontem.gasto, null, "0 aqui afirmaria 'não gastou' sobre um dia não medido");
    assert.equal(anteontem.custoPorCadastro, null);
    assert.equal(anteontem.comparavel, false);
    assert.match(anteontem.motivo ?? "", /sem nenhuma linha de apuração/);

    // E o dia que TEM linha continua medido — a guarda nova não pode engolir
    // o caminho normal junto.
    assert.equal(serie[1].gasto, 200);
    assert.equal(serie[1].cadastros, 24);
  });

  it("dia com linha e gasto genuinamente zero continua sendo 0, não null", () => {
    // A contrapartida do teste acima: braço que não entregou num dia em que
    // FOI apurado é um fato medido, e apagá-lo esconderia um braço parado.
    const rows = [row("2026-09-06", 200, 24), row("2026-09-07", 200, 30)];
    const d = computeDailyCac(rows, { canal: CANAL, dia: "2026-09-07" });
    assert.equal(d.gasto, 0);
    assert.equal(d.cadastros, 6);
  });
});

describe("#7635 — buraco no CSV não pode inflar o dia seguinte marcado comparável", () => {
  it("dia com linha-base de 2 dias atrás (buraco de 1 dia) não soma dois dias como comparável", () => {
    // Cenário exato da issue: 04/09 tem linha, 05/09 falta (buraco de
    // reconciliação), 06/09 tem linha. `base` de 06/09 vira a linha de 04/09
    // — dois dias de gasto/cadastros, não um — e SEM a guarda isso saía como
    // `gasto: 200`, `cadastros: 8`, `comparavel: true`.
    const rows = [row("2026-09-04", 300, 40), row("2026-09-06", 500, 48)];
    const d = computeDailyCac(rows, { canal: CANAL, dia: "2026-09-06" });
    assert.equal(d.comparavel, false, "linha-base não é o dia imediatamente anterior — não é comparável");
    assert.match(d.motivo ?? "", /linha-base é de 2026-09-04, não de 2026-09-05/);
    assert.equal(d.custoPorCadastro, null, "CAC calculado sobre 2 dias não pode ser lido como CAC de 1 dia");
    // gasto/cadastros continuam reportados (mesma disciplina das outras
    // guardas do módulo) — só o rótulo `comparavel` muda, não os números.
    assert.equal(d.gasto, 200);
    assert.equal(d.cadastros, 8);
  });

  it("dia com linha-base no dia imediatamente anterior continua comparável (caminho feliz)", () => {
    // Contrapartida do teste acima: a guarda não pode acusar buraco onde não
    // há um. Mesmos números do teste #7577 "o gasto do dia é a DIFERENÇA...".
    const rows = [row("2026-09-05", 100, 10), row("2026-09-06", 200, 24), row("2026-09-07", 300, 34)];
    const d = computeDailyCac(rows, { canal: CANAL, dia: "2026-09-07" });
    assert.equal(d.comparavel, true);
    assert.equal(d.motivo, null);
    assert.equal(d.gasto, 100);
    assert.equal(d.cadastros, 10);
    assert.equal(d.custoPorCadastro, 10);
  });

  it("primeiro dia do braço (sem linha-base nenhuma) não é acusado de buraco", () => {
    // `baseData` é `null` aqui, não uma data distante — a guarda só se aplica
    // quando HÁ uma linha-base e ela não é o dia anterior.
    const rows = [row("2026-09-05", 100, 10)];
    const d = computeDailyCac(rows, { canal: CANAL, dia: "2026-09-05" });
    assert.equal(d.comparavel, true);
    assert.equal(d.motivo, null);
  });
});
