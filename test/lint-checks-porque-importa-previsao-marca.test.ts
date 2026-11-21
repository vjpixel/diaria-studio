import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPorqueImportaPrevisaoMarca,
  countPrevisaoMarcas,
} from "../scripts/lib/lint-checks/porque-importa-previsao-marca.ts";

// #13766 (decisão do editor, briefing 261121b): no máximo 1 marca de previsão
// ("tende a"/"à medida que") por destaque, e só no "Por que isso importa".

const destaque = (n: number, corpo: string, why: string) =>
  [
    `**DESTAQUE ${n} | 🚀 LANÇAMENTO**`,
    "",
    `**[Título ${n}](https://example.com/d${n})**`,
    "",
    corpo,
    "",
    "Por que isso importa:",
    "",
    why,
    "---",
    "",
  ].join("\n");

test("#13766: 1 marca só no Por que isso importa passa (exemplos aprovados do #11073)", () => {
  const md =
    destaque(1, "A OpenAI lançou o modelo.", "Quem usa banco ou fintech na região tende a ver mais tentativas de golpe.") +
    destaque(2, "O METR publicou o relatório.", "À medida que empresas deixarem agentes mexer em dados reais, vão depender de monitores.");
  const r = checkPorqueImportaPrevisaoMarca(md);
  assert.equal(r.ok, true, JSON.stringify(r.warnings));
});

test("#13766: destaque sem marca nenhuma passa", () => {
  const r = checkPorqueImportaPrevisaoMarca(destaque(1, "Corpo.", "Quem usa o app passa a ver a mudança."));
  assert.equal(r.ok, true);
});

test("#13766: marca no corpo é sinalizada (mesmo sendo a única do destaque)", () => {
  const r = checkPorqueImportaPrevisaoMarca(
    destaque(2, "O preço tende a cair com a concorrência.", "Quem usa o app paga menos."),
  );
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.warnings.map((w) => [w.destaque, w.kind, w.count]),
    [[2, "corpo", 1]],
  );
});

test("#13766: 2 marcas no Por que isso importa é excesso", () => {
  const r = checkPorqueImportaPrevisaoMarca(
    destaque(1, "Corpo.", "À medida que a adoção cresce, o custo tende a cair para quem usa."),
  );
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.warnings.map((w) => [w.destaque, w.kind, w.count]),
    [[1, "excesso", 2]],
  );
});

test("#13766: marca no corpo + no Por que soma excesso e corpo", () => {
  const r = checkPorqueImportaPrevisaoMarca(
    destaque(3, "Empresas tendem a adotar o modelo.", "Quem usa tende a pagar menos."),
  );
  assert.deepEqual(
    r.warnings.map((w) => [w.destaque, w.kind, w.count]),
    [
      [3, "corpo", 1],
      [3, "excesso", 2],
    ],
  );
});

test("#13766: contagem é por destaque, não pela edição inteira", () => {
  const md =
    destaque(1, "Corpo.", "Quem usa tende a ver golpes.") +
    destaque(2, "Corpo.", "Quem usa tende a pagar menos.") +
    destaque(3, "Corpo.", "À medida que cresce, quem usa ganha.");
  assert.equal(checkPorqueImportaPrevisaoMarca(md).ok, true);
});

test("#13766: marca fora dos destaques (RADAR, USE MELHOR) é ignorada", () => {
  const md =
    destaque(1, "Corpo.", "Quem usa tende a ver golpes.") +
    "**RADAR**\n\n**[Item](https://example.com/r)**\nO preço tende a cair à medida que a oferta cresce.\n\n---\n";
  assert.equal(checkPorqueImportaPrevisaoMarca(md).ok, true);
});

test("#13766: rótulo com texto na mesma linha e '---' colado ao parágrafo", () => {
  const md =
    "**DESTAQUE 1 | X**\n\nCorpo.\n\nPor que isso importa: Quem usa tende a ver golpes, e o custo tende a subir.\n---\n";
  const r = checkPorqueImportaPrevisaoMarca(md);
  assert.deepEqual(r.warnings.map((w) => w.kind), ["excesso"]);
});

test("#13766: marcadores casam com variação de acento/plural e não casam dentro de palavra", () => {
  assert.equal(countPrevisaoMarcas("tendem a subir; a medida que cresce; À medida que cai"), 3);
  assert.equal(countPrevisaoMarcas("pretende atender"), 0);
  assert.equal(countPrevisaoMarcas("atende a todos"), 0);
});
