/**
 * test/blind-label-sample.test.ts (#5995, generalizado em #8413)
 *
 * Guard das partes PURAS do motor genérico de gabarito cego
 * (`scripts/lib/blind-label-core.ts`) — generalização de
 * `scripts/blind-label-sample.ts`, que agora é um CLI fino sobre ele.
 *
 * A propriedade que estes testes protegem é a mesma do #8206, agora por
 * ESTRATO em vez de bucket fixo: **nenhum item já rotulado sai da amostra
 * numa re-geração**. Cobre também o fluxo completo generate → record →
 * report/next contra uma `FeatureDef` sintética, isolado em diretório
 * temporário (nunca toca `data/jev-eval/` real).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  stableRank,
  stratumQuota,
  selectByThreshold,
  generate,
  next,
  record,
  report,
  MIN_PER_STRATUM,
  type PoolItem,
} from "../scripts/lib/blind-label-core.ts";
import type { FeatureDef } from "../scripts/lib/blind-label-core.ts";

function item(id: string, stratum = "radar"): PoolItem {
  return {
    id,
    display: { url: id, title: "t " + id },
    jevState: { title: "t " + id, url: id, summary: "" },
    stratum,
    hiddenGuess: stratum,
    hiddenRule: "noticias-default",
    edition: "260101",
  };
}

const corpus = (n: number, prefix = "https://example.com/a/", stratum = "radar") =>
  Array.from({ length: n }, (_, i) => item(prefix + i, stratum));

describe("stableRank", () => {
  it("é determinístico para o mesmo id", () => {
    const u = "https://blog.google/products/ads-commerce/ads-decoded-finale/";
    assert.equal(stableRank(u), stableRank(u));
  });

  it("separa ids diferentes", () => {
    assert.notEqual(stableRank("https://example.com/a"), stableRank("https://example.com/b"));
  });
});

describe("stratumQuota", () => {
  it("é proporcional quando o estrato é grande", () => {
    assert.equal(stratumQuota(3000, 4000, 60), 45);
  });

  it("aplica o piso quando a proporção daria menos", () => {
    assert.equal(stratumQuota(100, 4000, 60), MIN_PER_STRATUM);
  });

  it("nunca pede mais itens do que o estrato tem, mesmo abaixo do piso", () => {
    assert.equal(stratumQuota(3, 4000, 60), 3);
  });

  it("devolve 0 para entradas degeneradas em vez de NaN/Infinity", () => {
    assert.equal(stratumQuota(0, 4000, 60), 0);
    assert.equal(stratumQuota(10, 0, 60), 0);
    assert.equal(stratumQuota(10, 4000, NaN), 0);
  });
});

describe("selectByThreshold — amostra aditiva", () => {
  it("devolve aproximadamente a quota pedida", () => {
    const picked = selectByThreshold(corpus(400), 40, new Set());
    assert.ok(picked.length >= 20 && picked.length <= 60, `esperava ~40, veio ${picked.length}`);
  });

  it("mantém o tamanho da amostra sob crescimento do corpus", () => {
    const antes = selectByThreshold(corpus(200), 40, new Set()).length;
    const depois = selectByThreshold(corpus(800), 40, new Set()).length;
    assert.ok(Math.abs(antes - depois) <= 20, `amostra instável: ${antes} -> ${depois}`);
  });

  it("todo item rotulado sobrevive ao crescimento do corpus", () => {
    const small = corpus(200);
    const rotulados = new Set(selectByThreshold(small, 40, new Set()).map((p) => p.id));
    const grown = corpus(800);
    const depois = selectByThreshold(grown, 40, rotulados).map((p) => p.id);
    for (const id of rotulados) {
      assert.ok(depois.includes(id), `rótulo perdido após crescimento do corpus: ${id}`);
    }
  });

  it("NUNCA descarta item já rotulado, mesmo fora do corte", () => {
    const pool = corpus(500);
    const narrow = new Set(selectByThreshold(pool, 10, new Set()).map((p) => p.id));
    const outside = pool.find((p) => !narrow.has(p.id));
    assert.ok(outside, "fixture precisa de um item fora do corte");
    const picked = selectByThreshold(pool, 10, new Set([outside.id]));
    assert.ok(picked.some((p) => p.id === outside.id), "item rotulado foi descartado");
  });

  it("devolve vazio para lista vazia", () => {
    assert.deepEqual(selectByThreshold([], 10, new Set()), []);
  });

  it("quota >= candidatos inclui TODO mundo (ramo do piso MIN_PER_STRATUM)", () => {
    const pool = corpus(5);
    assert.equal(selectByThreshold(pool, 8, new Set()).length, 5);
  });
});

describe("generate/record/next/report — fluxo completo (feature sintética)", () => {
  let rootDir: string;
  let def: FeatureDef;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "blind-label-core-test-"));
    const pool = [...corpus(20, "https://example.com/radar/", "radar"), ...corpus(20, "https://example.com/lanc/", "lancamento")];
    def = {
      id: "synthetic-feature",
      labels: ["radar", "lancamento", "nao_pertence"],
      collectPool: () => ({ pool, skipped: [] }),
    };
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("generate produz amostra estratificada e persiste em disco", () => {
    const r = generate(rootDir, def, 10);
    assert.equal(r.poolSize, 40);
    assert.ok(r.pickedCount > 0);
    assert.equal(r.alreadyLabeled, 0);
  });

  it("record rejeita id fora da amostra", () => {
    generate(rootDir, def, 10);
    assert.throws(() => record(rootDir, def, "https://nao-existe.com", "radar"), /não está na amostra/);
  });

  it("record rejeita rótulo fora do vocabulário da feature", () => {
    generate(rootDir, def, 10);
    const sample = next(rootDir, def.id, 1);
    assert.throws(() => record(rootDir, def, sample[0].id, "bucket_invalido"), /rótulo inválido/);
  });

  it("next devolve só itens NÃO rotulados (a outra metade do contrato de cegueira — o CLI serializa só `display`, nunca `hiddenGuess`)", () => {
    generate(rootDir, def, 10);
    const sample = next(rootDir, def.id, 5);
    assert.ok(sample.length > 0);
    for (const item of sample) assert.equal(item.label, undefined);
  });

  it("record grava, e um 2º record do mesmo id ATUALIZA (o último vence)", () => {
    generate(rootDir, def, 10);
    const [first] = next(rootDir, def.id, 1);
    record(rootDir, def, first.id, "radar");
    record(rootDir, def, first.id, "lancamento");
    const rep = report(rootDir, def);
    assert.ok(rep);
    const found = rep!.disagreements.find((d) => d.id === first.id) ?? null;
    // o rótulo final é "lancamento" — se o hiddenGuess original for "radar", isso aparece como discordância.
    if (first.hiddenGuess !== "lancamento") {
      assert.ok(found, "2º record deveria ter sobrescrito o 1º");
    }
  });

  it("report calcula acordo/discordância contra hiddenGuess", () => {
    generate(rootDir, def, 40);
    const sample = next(rootDir, def.id, 40);
    for (const item of sample) {
      // rotula tudo concordando com o palpite, exceto o primeiro item (discorda de propósito).
      const isFirst = item.id === sample[0].id;
      const flipped = item.hiddenGuess === "radar" ? "lancamento" : "radar";
      record(rootDir, def, item.id, isFirst ? flipped : item.hiddenGuess);
    }
    const rep = report(rootDir, def);
    assert.ok(rep);
    assert.equal(rep!.labeled, sample.length);
    assert.equal(rep!.agree, sample.length - 1);
    assert.equal(rep!.disagreements.length, 1);
    assert.equal(rep!.disagreements[0].id, sample[0].id);
  });

  it("report exclui optOutLabels do cálculo de acordo/discordância (self-review #8413: regressão vs. o script original, que excluía `nao_pertence`)", () => {
    const optOutDef: FeatureDef = { ...def, optOutLabels: ["nao_pertence"] };
    generate(rootDir, optOutDef, 10);
    const sample = next(rootDir, optOutDef.id, 5);
    assert.ok(sample.length >= 2, "fixture precisa de ao menos 2 itens");
    record(rootDir, optOutDef, sample[0].id, "nao_pertence"); // opt-out — deve sair do report
    record(rootDir, optOutDef, sample[1].id, sample[1].hiddenGuess); // concorda — deve entrar

    const rep = report(rootDir, optOutDef);
    assert.ok(rep);
    assert.ok(!rep!.disagreements.some((d) => d.id === sample[0].id), "item opt-out não deveria aparecer no report");
    // só o item concordante conta pra `labeled`/`agree` — o opt-out é excluído do denominador inteiro.
    assert.equal(rep!.labeled, 1);
    assert.equal(rep!.agree, 1);
  });

  it("generate ABORTA sem gravar se um item já rotulado sairia da amostra", () => {
    generate(rootDir, def, 5);
    const [first] = next(rootDir, def.id, 1);
    record(rootDir, def, first.id, first.hiddenGuess);

    // Feature cujo pool não inclui mais o item rotulado — simula "moveu de bucket / edição sumiu".
    const shrunkDef: FeatureDef = { ...def, collectPool: () => ({ pool: def.collectPool(rootDir).pool.filter((p) => p.id !== first.id), skipped: [] }) };
    assert.throws(() => generate(rootDir, shrunkDef, 5), /ABORTADO/);
  });
});
