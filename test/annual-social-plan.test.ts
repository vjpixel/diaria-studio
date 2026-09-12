/**
 * test/annual-social-plan.test.ts — Etapa 6 da `/diaria-anual`.
 *
 * Os publicadores da diária aceitam 2–3 destaques por edição e datam o post
 * pelo AAMMDD do diretório. O plano tem que respeitar isso para QUALQUER N de
 * temas (3–7) + previsões, e cair só em fim de semana (dia sem diária).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDayReviewedMd,
  buildDaySocialMd,
  orderAnnualSocialKeys,
  parseAAMMDD,
  parseAnnualSocialMd,
  planAnnualSocialDays,
  themeImageFile,
  type AnnualSocialKey,
} from "../scripts/lib/anual/annual-social-plan.ts";
import { parseDestaques } from "../scripts/extract-destaques.ts";

const keysFor = (n: number): AnnualSocialKey[] => [
  ...Array.from({ length: n }, (_, i) => `t${i + 1}` as AnnualSocialKey),
  "previsoes",
];

describe("planAnnualSocialDays", () => {
  const sabado = parseAAMMDD("260912"); // 12/09/2026 é sábado

  it("todo N de temas (3–7) + previsões cabe em dias de 2 ou 3 posts, sem perder nem repetir post", () => {
    for (let n = 3; n <= 7; n++) {
      const keys = keysFor(n);
      const dias = planAnnualSocialDays(keys, sabado);
      assert.ok(dias.every((d) => d.keys.length >= 2 && d.keys.length <= 3), `N=${n}: ${dias.map((d) => d.keys.length)}`);
      assert.deepEqual(dias.flatMap((d) => d.keys), keys, `N=${n}`);
    }
  });

  it("6 temas + previsões → 3/2/2, com as previsões no último dia", () => {
    const dias = planAnnualSocialDays(keysFor(6), sabado);
    assert.deepEqual(dias.map((d) => d.keys.length), [3, 2, 2]);
    assert.equal(dias.at(-1)!.keys.at(-1), "previsoes");
  });

  it("só sábado e domingo, a partir do início informado", () => {
    const quarta = parseAAMMDD("260916");
    const dias = planAnnualSocialDays(keysFor(6), quarta);
    assert.deepEqual(dias.map((d) => d.date), ["260919", "260920", "260926"]);
  });

  it("menos de 2 posts não cabe em dia nenhum", () => {
    assert.throws(() => planAnnualSocialDays(["t1"], sabado), /2 ou 3/);
  });
});

describe("parseAnnualSocialMd", () => {
  const md = [
    "# Social", "", "## t2", "Texto dois.", "", "## t1", "Texto um.", "", "## previsoes", "Previsões.", "",
    "# Curto", "", "## t1", "c1", "", "## t2", "c2", "", "## previsoes", "cp", "",
    "# Pixel", "", "## post_pixel", "Post pessoal.",
  ].join("\n");

  it("lê os três blocos e ordena temas numericamente, previsões por último", () => {
    const t = parseAnnualSocialMd(md);
    assert.equal(t.social.t1, "Texto um.");
    assert.equal(t.curto.previsoes, "cp");
    assert.equal(t.pixel, "Post pessoal.");
    assert.deepEqual(orderAnnualSocialKeys(Object.keys(t.social)), ["t1", "t2", "previsoes"]);
  });

  it("post sem versão curta falha — X e Threads ficariam sem ele em silêncio", () => {
    assert.throws(() => parseAnnualSocialMd(md.replace("## t2\nc2\n", "")), /t2/);
  });

  it("seção desconhecida falha", () => {
    assert.throws(() => orderAnnualSocialKeys(["t1", "extra"]), /extra/);
  });
});

describe("arquivos do dia", () => {
  it("imagem do tema sai pelo índice da URL, não pelo nome do arquivo (temas reordenados no gate)", () => {
    const pub = {
      "https://x/img-annual-2026-04-d1-2x1-aa.jpg": "04-d1-2x1.jpg",
      "https://x/img-annual-2026-04-d2-2x1-bb.jpg": "04-d5-2x1.jpg",
    };
    assert.equal(themeImageFile(pub, 2), "04-d5-2x1.jpg");
    assert.equal(themeImageFile(pub, 3), null);
  });

  it("02-reviewed.md do dia é lido pelo mesmo parser que o gerador de capa usa", () => {
    const d = parseDestaques(buildDayReviewedMd(["O trabalho mudou", "O Brasil deixou de assistir"]));
    assert.deepEqual(d.map((x) => x.title), ["O trabalho mudou", "O Brasil deixou de assistir"]);
  });

  it("03-social.md do dia renumera as chaves para d1..d3 nos dois blocos", () => {
    const md = buildDaySocialMd(
      { date: "260920", keys: ["t6", "previsoes"] },
      { social: { t6: "S6", previsoes: "SP" }, curto: { t6: "C6", previsoes: "CP" } },
    );
    assert.match(md, /# Social\n\n## d1\nS6\n\n## d2\nSP/);
    assert.match(md, /# Curto\n\n## d1\nC6\n\n## d2\nCP/);
  });
});
