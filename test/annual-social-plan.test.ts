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
  socialCardCategory,
  themeImageFile,
  type AnnualSocialKey,
} from "../scripts/lib/anual/annual-social-plan.ts";
import { parseDestaques } from "../scripts/extract-destaques.ts";
import { prepAnnualSocial } from "../scripts/prep-annual-social.ts";
import { readDestaqueCount } from "../scripts/lib/invariant-checks/stage-3.ts";
import { resolveOutrosCountFromEditionDir } from "../scripts/lib/outros-count.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("prepAnnualSocial — o diretório do dia satisfaz os scripts da diária", () => {
  // Fixture mínima de uma anual real: draft com 3 temas, imagens públicas e
  // 03-social.md com 3 temas + previsões → 2 dias de 2 posts. Dia de 2 posts
  // é o caso que quebrava: sem 01-approved-capped.json, readDestaqueCount
  // assume 3 e o upload exige a imagem do d3; e publish-linkedin aborta sem
  // outros_count.
  const root = mkdtempSync(join(tmpdir(), "anual-social-"));
  const dir = join(root, "2026-aniversario");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  mkdirSync(join(dir, "social"), { recursive: true });
  const tema = (n: number) => `**TEMA ${n} | NOME ${n}**\n\nTítulo do tema ${n}\n\nParágrafo ${n}.\n\nO fio condutor:\nFio ${n}.\n`;
  writeFileSync(join(dir, "draft.md"), `**INTRO**\n\nAbertura.\n\n${tema(1)}\n${tema(2)}\n${tema(3)}\n**PREVISÕES**\n\nP.\n`);
  const pub: Record<string, string> = {};
  for (const n of [1, 2, 3]) {
    pub[`https://x/img-annual-2026-aniversario-04-d${n}-2x1-h${n}.jpg`] = `04-d${n}-2x1.jpg`;
    writeFileSync(join(dir, `04-d${n}-2x1.jpg`), "jpg");
  }
  writeFileSync(join(dir, "_internal", "public-images.json"), JSON.stringify(pub));
  writeFileSync(join(dir, "social", "previsoes-2x1.jpg"), "jpg");
  const k = ["t1", "t2", "t3", "previsoes"];
  writeFileSync(
    join(dir, "social", "03-social.md"),
    `# Social\n\n${k.map((x) => `## ${x}\nTexto ${x}.\n`).join("\n")}\n# Curto\n\n${k.map((x) => `## ${x}\nCurto ${x}.\n`).join("\n")}`,
  );

  const { days } = prepAnnualSocial(dir, parseAAMMDD("260912"));

  it("2 dias de 2 posts, cada um com a contagem certa de destaques", () => {
    assert.deepEqual(days.map((d) => d.keys.length), [2, 2]);
    for (const d of days) assert.equal(readDestaqueCount(d.dir), 2);
  });

  it("publish-linkedin consegue resolver outros_count (não aborta)", () => {
    for (const d of days) assert.equal(resolveOutrosCountFromEditionDir(d.dir), 0);
  });

  it("capa com a categoria de aniversário e a URL da retrospectiva registrada", () => {
    const d = days[0].dir;
    assert.match(readFileSync(join(d, "02-reviewed.md"), "utf8"), /RETROSPECTIVA DE ANIVERSÁRIO/);
    assert.equal(readFileSync(join(d, "_internal", "05-edition-url.txt"), "utf8").trim(), "https://retrospectiva.diar.ia.br/aniversario2026");
    assert.ok(existsSync(join(d, "04-d2-2x1.jpg")));
    assert.ok(!existsSync(join(d, "04-d3-2x1.jpg")));
  });

  it("rodada de janeiro não usa o enquadramento de aniversário", () => {
    assert.equal(socialCardCategory("janeiro", "2026"), "RETROSPECTIVA 2026");
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
