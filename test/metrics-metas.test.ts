/**
 * test/metrics-metas.test.ts (#7177, fatia 5 do épico #7172)
 *
 * `metas.ts` (máquina de estados, puro) + `metas-store.ts` (I/O fail-soft
 * na leitura, erro duro na validação). Nenhum teste toca `data/metas.json`
 * real — sempre fixture/tmpdir.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateMeta, type Meta, type MedicaoDia } from "../scripts/lib/metrics/metas.ts";
import { loadMetas, validateMetas, DEFAULT_METAS_PATH } from "../scripts/lib/metrics/metas-store.ts";
import type { MetricDef, MetricResult, Janela } from "../scripts/lib/metrics/registry.ts";

function janela(dia: string): Janela {
  return { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
}

function exato(dia: string, valor: number): MedicaoDia {
  return { chave: dia, resultado: { valor, janela: janela(dia), frescor: dia, qualidade: "exato", motivo: null } };
}

function indeterminado(dia: string): MedicaoDia {
  return {
    chave: dia,
    resultado: { valor: null, janela: janela(dia), frescor: null, qualidade: "indeterminado", motivo: "sem coleta" },
  };
}

function faixaMed(dia: string, min: number, max: number): MedicaoDia {
  return {
    chave: dia,
    resultado: {
      valor: min,
      janela: janela(dia),
      frescor: dia,
      qualidade: "faixa",
      motivo: "faixa",
      limites: { min, max },
    },
  };
}

const metaPlacar: Meta = {
  id: "ativacao-placar-5-por-dia",
  metrica_id: "cadastros-nao-pago-nao-reativacao-dia",
  produto: "diaria",
  alvo: 5,
  operador: ">=",
  janela: "dia",
  consecutivos: 7,
  prazo: null,
  criada_em: "2026-09-02",
  dono: "editor",
  motivo: "baseline 2,17/dia",
};

describe("evaluateMeta — máquina de estados (#7177)", () => {
  it("todo dia medido bate o alvo, streak completo → atingida", () => {
    const medicoes = Array.from({ length: 7 }, (_, i) => exato(`2026-09-0${i + 1}`, 5));
    const status = evaluateMeta(metaPlacar, medicoes, "2026-09-08");
    assert.equal(status.estado, "atingida");
    assert.equal(status.streak_atual, 7);
    assert.equal(status.atingida_em, "2026-09-07");
  });

  it("todo dia medido bate o alvo, mas há um buraco de coleta no meio → indeterminado", () => {
    const medicoes: MedicaoDia[] = [
      exato("2026-08-27", 5),
      exato("2026-08-28", 5),
      indeterminado("2026-08-29"),
      exato("2026-08-30", 5),
      exato("2026-08-31", 5),
      exato("2026-09-01", 5),
      exato("2026-09-02", 5),
    ];
    const status = evaluateMeta(metaPlacar, medicoes, "2026-09-02");
    assert.equal(status.estado, "indeterminado");
    assert.equal(status.dias_indeterminados, 1);
  });

  it("mesma janela com 1 dia medido ABAIXO do alvo → em-curso com streak reiniciado, NUNCA indeterminado", () => {
    const medicoes: MedicaoDia[] = [
      exato("2026-08-27", 5),
      exato("2026-08-28", 2), // abaixo do alvo — conclusivo, vence o buraco
      indeterminado("2026-08-29"),
      exato("2026-08-30", 5),
      exato("2026-08-31", 5),
      exato("2026-09-01", 5),
      exato("2026-09-02", 5),
    ];
    const status = evaluateMeta(metaPlacar, medicoes, "2026-09-02");
    assert.equal(status.estado, "em-curso");
    assert.equal(status.streak_atual, 4); // 09-02..08-30, para no fail de 08-28
  });

  it("buraco no MEIO de uma janela maior que consecutivos não soma os dois lados do streak (#7175 reviewer finding 1)", () => {
    const metaAlvo5: Meta = { ...metaPlacar, alvo: 5, operador: ">=", consecutivos: 5 };

    // [5,5,null,5,5] — janela do tamanho exato de `consecutivos`: o buraco
    // já quebra o streak mesmo sem reset (2 dias de cada lado, nenhum
    // chega a 5) → indeterminado, comportamento preexistente preservado.
    const janelaExata: MedicaoDia[] = [
      exato("2026-08-27", 5),
      exato("2026-08-28", 5),
      indeterminado("2026-08-29"),
      exato("2026-08-30", 5),
      exato("2026-08-31", 5),
    ];
    const statusExata = evaluateMeta(metaAlvo5, janelaExata, "2026-08-31");
    assert.equal(statusExata.estado, "indeterminado");

    // [5,5,5,null,5,5] — 1 dia de contexto A MAIS (docstring: "cobrir mais
    // não muda o resultado"). Sem o reset do streak no buraco, os 3 dias
    // depois + os 2 antes se somavam a 5 e o resultado virava `atingida`
    // (TERMINAL, nunca reverte) — falso positivo. Com o reset, nenhum dos
    // dois lados do buraco sozinho chega a 5 → precisa continuar
    // `indeterminado`, nunca `atingida`.
    const janelaMaior: MedicaoDia[] = [
      exato("2026-08-26", 5),
      exato("2026-08-27", 5),
      exato("2026-08-28", 5),
      indeterminado("2026-08-29"),
      exato("2026-08-30", 5),
      exato("2026-08-31", 5),
    ];
    const statusMaior = evaluateMeta(metaAlvo5, janelaMaior, "2026-08-31");
    assert.equal(statusMaior.estado, "indeterminado");
    assert.notEqual(statusMaior.estado, "atingida");
  });

  it("meta com prazo: null NUNCA devolve nao-atingida", () => {
    const medicoes = [exato("2026-01-01", 1)]; // bem abaixo do alvo, sem streak
    const status = evaluateMeta(metaPlacar, medicoes, "2099-01-01"); // "hoje" bem no futuro
    assert.notEqual(status.estado, "nao-atingida");
  });

  it("meta com prazo passado e não atingida → nao-atingida", () => {
    const metaComPrazo: Meta = { ...metaPlacar, prazo: "2026-09-01", consecutivos: 3 };
    const medicoes = [exato("2026-08-30", 1), exato("2026-08-31", 1), exato("2026-09-01", 1)];
    const status = evaluateMeta(metaComPrazo, medicoes, "2026-09-02");
    assert.equal(status.estado, "nao-atingida");
  });

  it("métrica em faixa — estado principal pelo limite INFERIOR e status_no_limite_superior separado", () => {
    const metaSimples: Meta = { ...metaPlacar, consecutivos: 1 };
    const medicoes = [faixaMed("2026-09-02", 3, 6)]; // piso 3 < alvo 5, teto 6 >= alvo 5
    const status = evaluateMeta(metaSimples, medicoes, "2026-09-02");
    assert.equal(status.estado, "em-curso"); // decidido pelo piso (3 < 5)
    assert.equal(status.status_no_limite_superior, "atingida"); // teto bateria
    assert.deepEqual(status.faixa, { min: 3, max: 6 });
  });

  it("atingidaEmAnterior é sticky/terminal — não reavalia a série", () => {
    const medicoes = [exato("2026-09-02", 0)]; // se reavaliasse, falharia
    const status = evaluateMeta(metaPlacar, medicoes, "2026-09-02", "2026-08-20");
    assert.equal(status.estado, "atingida");
    assert.equal(status.atingida_em, "2026-08-20");
  });

  it("progresso é streak_atual/streak_necessario", () => {
    const medicoes = [exato("2026-09-01", 5), exato("2026-09-02", 5)];
    const status = evaluateMeta(metaPlacar, medicoes, "2026-09-02");
    assert.equal(status.progresso, 2 / 7);
  });
});

describe("loadMetas — fail-soft (#7177)", () => {
  it("data/metas.json ausente devolve [] sem lançar", () => {
    const dir = mkdtempSync(join(tmpdir(), "metas-test-"));
    const path = join(dir, "não-existe.json");
    const result = loadMetas(path);
    assert.deepEqual(result.metas, []);
    assert.ok(result.motivo);
    rmSync(dir, { recursive: true, force: true });
  });

  it("DEFAULT_METAS_PATH aponta para data/metas.json", () => {
    assert.match(DEFAULT_METAS_PATH, /data[\\/]+metas\.json$/);
  });

  it("arquivo presente e bem formado carrega normalmente", () => {
    const dir = mkdtempSync(join(tmpdir(), "metas-test-"));
    const path = join(dir, "metas.json");
    writeFileSync(path, JSON.stringify([metaPlacar]));
    const result = loadMetas(path);
    assert.equal(result.metas.length, 1);
    assert.equal(result.motivo, null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("arquivo presente mas JSON inválido LANÇA (presença errada é erro duro)", () => {
    const dir = mkdtempSync(join(tmpdir(), "metas-test-"));
    const path = join(dir, "metas.json");
    writeFileSync(path, "{ não é array");
    assert.throws(() => loadMetas(path));
    rmSync(dir, { recursive: true, force: true });
  });

  it("entrada malformada (falta campo obrigatório) LANÇA", () => {
    const dir = mkdtempSync(join(tmpdir(), "metas-test-"));
    const path = join(dir, "metas.json");
    writeFileSync(path, JSON.stringify([{ id: "x" }]));
    assert.throws(() => loadMetas(path));
    rmSync(dir, { recursive: true, force: true });
  });
});

function fakeRegistry(ids: string[]): MetricDef[] {
  return ids.map((id) => ({
    id,
    nome: id,
    produto: "diaria",
    etapa: "aquisicao",
    definicao: "x",
    unidade: "contagem",
    direcao: "neutro",
    fonte: "x",
    decomposicoes: [],
    async computar(): Promise<MetricResult> {
      return { valor: 0, janela: janela("2026-01-01"), frescor: null, qualidade: "exato", motivo: null };
    },
  })) as MetricDef[];
}

describe("validateMetas — erro duro (#7177)", () => {
  it("metrica_id fora do registry LANÇA nomeando a meta órfã", () => {
    assert.throws(
      () => validateMetas([metaPlacar], fakeRegistry(["outra-metrica"])),
      /cadastros-nao-pago-nao-reativacao-dia/,
    );
  });

  it("metrica_id presente no registry não lança", () => {
    assert.doesNotThrow(() => validateMetas([metaPlacar], fakeRegistry([metaPlacar.metrica_id])));
  });

  it("id de meta duplicado LANÇA", () => {
    assert.throws(
      () => validateMetas([metaPlacar, metaPlacar], fakeRegistry([metaPlacar.metrica_id])),
      /duplicado/,
    );
  });
});
