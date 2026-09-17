/**
 * test/ads-rolling-window-8241.test.ts (#8241)
 *
 * Dois defeitos corrigidos em `scripts/lib/ads-rolling-window.ts`:
 *
 * 1. `contarDiasAposUltimaEdicao`/`normalizeEdicaoRegistro` só enxergavam o
 *    formato ANTIGO de `edicoes.jsonl` (`tipo === "edicao-em-voo"`,
 *    `braco`, `registrado_em_utc`) — as 7 linhas reais gravadas entre
 *    09-17/09/2026 usam `{ts, tipo, braco?}` sem `braco` em várias delas, e
 *    eram ignoradas SEM AVISO.
 * 2. `computeRollingWindow` não sabia de `revisao.pausa` — uma janela com
 *    dias pausados saía `comparavel: true` e "estado estável".
 *
 * Fixtures do item 1 usam o formato REAL das linhas gravadas no
 * `edicoes.jsonl` de produção (copiado, não inventado — #633).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ClicksCsvRow } from "../scripts/lib/ads-test-watch.ts";
import {
  computeRollingWindow,
  contarDiasAposUltimaEdicao,
  descreverEstabilidade,
  normalizeEdicaoRegistro,
  type EdicaoEmVoo,
} from "../scripts/lib/ads-rolling-window.ts";

const CANAL = "Google Ads (teste 2608)";

function row(data: string, gasto: number, cadastros: number | null): ClicksCsvRow {
  return { canal: CANAL, data_apuracao: data as ClicksCsvRow["data_apuracao"], gasto_acumulado: gasto, leitoresAcumulado: null, cadastrosAcumulado: cadastros };
}

// Linhas 11-17 REAIS de data/aquisicao/teste-2608/edicoes.jsonl (09-17/09/2026).
const LINHAS_REAIS_NOVO_FORMATO: EdicaoEmVoo[] = [
  {
    ts: "2026-09-09T08:05:00-03:00",
    tipo: "backfill-conversao-google-ads",
  } as unknown as EdicaoEmVoo,
  {
    ts: "2026-09-09T09:10:00-03:00",
    tipo: "pausa-total-anuncios",
  } as unknown as EdicaoEmVoo,
  {
    ts: "2026-09-10T16:52:11-03:00",
    tipo: "backfill-conversao-google-ads",
  } as unknown as EdicaoEmVoo,
  {
    ts: "2026-09-17T00:15:00-03:00",
    tipo: "retomada-pre-registro",
  } as unknown as EdicaoEmVoo,
  {
    ts: "2026-09-17T00:17:00-03:00",
    tipo: "retomada-executada",
  } as unknown as EdicaoEmVoo,
  {
    ts: "2026-09-17T01:13:39-03:00",
    tipo: "correcao-data-termino-pre-registro",
  } as unknown as EdicaoEmVoo,
  {
    ts: "2026-09-17T01:35:00-03:00",
    tipo: "correcao-data-termino-executada",
  } as unknown as EdicaoEmVoo,
];

describe("#8241 item 1 — normalizeEdicaoRegistro: schema novo (ts, sem braco)", () => {
  it("linha SEM braco vira braco:'todos'", () => {
    const n = normalizeEdicaoRegistro({ ts: "2026-09-09T09:10:00-03:00", tipo: "pausa-total-anuncios" } as EdicaoEmVoo);
    assert.equal(n?.braco, "todos");
    assert.equal(n?.efeito, "pausa");
  });

  it("schema ANTIGO (registrado_em_utc, braco) continua reconhecido", () => {
    const n = normalizeEdicaoRegistro({ braco: CANAL, tipo: "edicao-em-voo", registrado_em_utc: "2026-09-06T15:23:21.363Z" });
    assert.equal(n?.braco, CANAL);
    assert.equal(n?.ts, "2026-09-06T15:23:21.363Z");
    assert.equal(n?.efeito, "mudanca");
  });

  it("tipo DESCONHECIDO conta como 'mudanca' e avisa — nunca ignora em silêncio", () => {
    const avisos: string[] = [];
    const n = normalizeEdicaoRegistro({ ts: "2026-09-20T00:00:00-03:00", tipo: "tipo-nunca-visto" } as EdicaoEmVoo, (m) => avisos.push(m));
    assert.equal(n?.efeito, "mudanca");
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /tipo desconhecido "tipo-nunca-visto"/);
  });

  it("linha sem ts NEM tipo -> null (nada a normalizar), sem aviso (não é 'tipo desconhecido', é ausência do mínimo)", () => {
    const avisos: string[] = [];
    const n = normalizeEdicaoRegistro({} as EdicaoEmVoo, (m) => avisos.push(m));
    assert.equal(n, null);
    assert.equal(avisos.length, 0);
  });
});

describe("#8241 item 1 — contarDiasAposUltimaEdicao lê as 7 linhas reais (antes eram TODAS ignoradas)", () => {
  it("a retomada-executada (17/09) NÃO conta como 'mudanca' (é efeito 'retomada', tratado pela pausa em si)", () => {
    const dias = ["2026-09-15", "2026-09-16", "2026-09-17"];
    const { diasApos, ultimaEdicao } = contarDiasAposUltimaEdicao(LINHAS_REAIS_NOVO_FORMATO, CANAL, dias);
    // Nenhuma linha do fixture tem efeito "mudanca" (todas são pausa/retomada/registro)
    assert.equal(ultimaEdicao, null);
    assert.equal(diasApos, null);
  });

  it("linha braco:'todos' com tipo 'edicao-em-voo' conta pra QUALQUER canal", () => {
    const linhas: EdicaoEmVoo[] = [{ ts: "2026-09-16T12:00:00-03:00", tipo: "edicao-em-voo" } as unknown as EdicaoEmVoo];
    const dias = ["2026-09-16", "2026-09-17", "2026-09-18"];
    const { diasApos, ultimaEdicao } = contarDiasAposUltimaEdicao(linhas, "Meta Ads (teste 2608)", dias);
    assert.equal(ultimaEdicao, "2026-09-16");
    assert.equal(diasApos, 2);
  });

  it("tipo desconhecido nas linhas reais avisaria — aqui confirmamos que o warn É chamado quando presente no dataset", () => {
    const avisos: string[] = [];
    const linhas: EdicaoEmVoo[] = [...LINHAS_REAIS_NOVO_FORMATO, { ts: "2026-09-18T00:00:00-03:00", tipo: "algo-novo-nao-catalogado" } as unknown as EdicaoEmVoo];
    contarDiasAposUltimaEdicao(linhas, CANAL, ["2026-09-18"], (m) => avisos.push(m));
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /algo-novo-nao-catalogado/);
  });
});

describe("#8241 item 2 — computeRollingWindow: janela com dia pausado NUNCA é estado estável", () => {
  const PAUSE = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];

  it("janela até 16/09 (dados reais: 3 dias 100% pausados) -> comparavel:false, motivo cita pausa", () => {
    // base imediatamente antes da janela (13/09) presente, pra não disparar
    // o guard de borda do #7790 antes de chegar na checagem de pausa.
    const rows = [row("2026-09-13", 517.85, 140), row("2026-09-14", 520, 142), row("2026-09-15", 523, 145), row("2026-09-16", 526, 148)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-16", dias: 3, pauseIntervals: PAUSE });
    assert.equal(r.comparavel, false);
    assert.match(r.motivo ?? "", /pausado/);
    assert.equal(r.estavel, false);
  });

  it("janela até 10/09 (pausa parcial 09/09 + 10/09 pausado inteiro) -> não comparável (era `true` antes do #8241)", () => {
    const rows = [row("2026-09-07", 400, 100), row("2026-09-08", 450, 120), row("2026-09-09", 460, 122), row("2026-09-10", 460, 122)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-10", dias: 3, pauseIntervals: PAUSE });
    assert.equal(r.comparavel, false);
    assert.match(r.motivo ?? "", /pausado/);
  });

  it("janela SEM nenhum dia pausado -> comportamento normal, comparável quando os demais critérios passam", () => {
    const rows = [row("2026-09-01", 100, 20), row("2026-09-02", 130, 24), row("2026-09-03", 160, 27), row("2026-09-04", 190, 32)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04", dias: 3, pauseIntervals: PAUSE });
    assert.equal(r.comparavel, true);
    assert.equal(r.estavel, true);
  });

  it("sem pauseIntervals (omitido) -> comportamento idêntico ao pré-#8241", () => {
    const rows = [row("2026-09-01", 100, 20), row("2026-09-02", 130, 24), row("2026-09-03", 160, 27), row("2026-09-04", 190, 32)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-04", dias: 3 });
    assert.equal(r.comparavel, true);
  });

  it("descreverEstabilidade nomeia a pausa quando é ela quem derruba a estabilidade", () => {
    const rows = [row("2026-09-13", 517.85, 140), row("2026-09-14", 520, 142), row("2026-09-15", 523, 145), row("2026-09-16", 526, 148)];
    const r = computeRollingWindow(rows, { canal: CANAL, ate: "2026-09-16", dias: 3, pauseIntervals: PAUSE });
    const texto = descreverEstabilidade(r);
    assert.match(texto, /não é estado estável/);
    assert.match(texto, /pausado/);
  });

  it("janela SEM dado (sem nenhuma linha) mas que cruza pausa também nomeia a pausa no motivo", () => {
    const r = computeRollingWindow([], { canal: CANAL, ate: "2026-09-12", dias: 3, pauseIntervals: PAUSE });
    assert.equal(r.comparavel, false);
    assert.match(r.motivo ?? "", /pausado/);
    assert.equal(r.estavel, false);
  });

  it("REGRESSÃO (self-review): janela SEM dado e SEM pausa/edição -> estavel:true, coerente com descreverEstabilidade dizendo 'estado estável' (não pode faltar dado E ficar estavel:false por hardcode)", () => {
    const r = computeRollingWindow([], { canal: CANAL, ate: "2026-01-05", dias: 3 }); // sem pauseIntervals, sem edicoes
    assert.equal(r.ultimaEdicao, null);
    assert.equal(r.estavel, true, "sem edição registrada e sem pausa, o campo estavel não pode discordar do texto de descreverEstabilidade");
    assert.match(descreverEstabilidade(r), /estado estável/);
  });
});

describe("#8262 achado 8 — as 4 janelas de transição do critério de aceite original do #8241 (17-20/09)", () => {
  // Pausa real de produção: 09/09 09:10 -> 17/09 00:16. Rows contíguas
  // 13-20/09 com gasto/cadastros sempre crescentes o bastante pra nunca
  // cair no piso de MIN_CADASTROS_PARA_COMPARAR nem disparar os guards de
  // borda/decréscimo — o que está sob teste aqui é SÓ `comparavel`/`estavel`
  // reagindo à pausa e à `retomada-executada` das LINHAS_REAIS_NOVO_FORMATO.
  const PAUSE = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];
  const ROWS: ClicksCsvRow[] = [
    row("2026-09-13", 500, 130),
    row("2026-09-14", 510, 133),
    row("2026-09-15", 515, 135),
    row("2026-09-16", 520, 138),
    row("2026-09-17", 525, 142),
    row("2026-09-18", 530, 146),
    row("2026-09-19", 535, 150),
    row("2026-09-20", 540, 154),
  ];

  it("até 17/09 -> comparavel:false por dia pausado (16 e 17 ambos com alguma cobertura de pausa) — bate com o critério de aceite do #8241", () => {
    const r = computeRollingWindow(ROWS, { canal: CANAL, ate: "2026-09-17", dias: 3, pauseIntervals: PAUSE, edicoes: LINHAS_REAIS_NOVO_FORMATO });
    assert.equal(r.comparavel, false);
    assert.match(r.motivo ?? "", /pausado/);
  });

  it("até 18/09 -> comparavel:false por dia pausado (16 100% + 17 parcial ainda dentro da janela [16,17,18]) — bate com o critério de aceite do #8241", () => {
    const r = computeRollingWindow(ROWS, { canal: CANAL, ate: "2026-09-18", dias: 3, pauseIntervals: PAUSE, edicoes: LINHAS_REAIS_NOVO_FORMATO });
    assert.equal(r.comparavel, false);
    assert.match(r.motivo ?? "", /pausado/);
  });

  it("até 19/09 -> DIVERGE do texto literal do critério de aceite do #8241 (\"comparável, mas cruza a retomada\"): sai comparavel:false porque 17/09 ainda tem fração de pausa > 0 (~0,011 do dia, pausa termina 00:16). Decisão registrada em isDatePaused (ads-test-pause-window.ts) — leitura conservadora preferida a um piso arbitrário de fração mínima.", () => {
    const r = computeRollingWindow(ROWS, { canal: CANAL, ate: "2026-09-19", dias: 3, pauseIntervals: PAUSE, edicoes: LINHAS_REAIS_NOVO_FORMATO });
    assert.equal(r.comparavel, false);
    assert.match(r.motivo ?? "", /pausado/);
  });

  it("até 20/09, sem mudança nova (retomada não conta como 'mudanca') -> estavel:true, comparavel:true — bate com o critério de aceite do #8241", () => {
    const r = computeRollingWindow(ROWS, { canal: CANAL, ate: "2026-09-20", dias: 3, pauseIntervals: PAUSE, edicoes: LINHAS_REAIS_NOVO_FORMATO });
    assert.equal(r.comparavel, true);
    assert.equal(r.estavel, true);
  });
});
