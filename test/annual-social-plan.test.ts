/**
 * test/annual-social-plan.test.ts — Etapa 6 da `/diaria-anual`.
 *
 * Os publicadores da diária aceitam 2–3 destaques por edição e datam o post
 * pelo AAMMDD do diretório. O plano tem que respeitar isso para QUALQUER N de
 * temas (3–7) + previsões, agrupando os posts em lotes de 2–3, e ainda assim
 * publicar um post por dia, no mesmo horário (slots por post, lidos via
 * DIARIA_SOCIAL_SLOTS_FILE — decisão do editor, 12/09/2026).
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
  buildDayCoverJson,
  themeImageFile,
  type AnnualSocialKey,
} from "../scripts/lib/anual/annual-social-plan.ts";
import { parseDestaques } from "../scripts/extract-destaques.ts";
import { prepAnnualSocial } from "../scripts/prep-annual-social.ts";
import { readDestaqueCount } from "../scripts/lib/invariant-checks/stage-3.ts";
import { resolveOutrosCountFromEditionDir } from "../scripts/lib/outros-count.ts";
import { computeScheduledAt, readSlotOverride } from "../scripts/compute-social-schedule.ts";
import { buildOverlaySvg, readCoverOverride } from "../scripts/gen-social-card-4x5.ts";
import { slideSourceText } from "../scripts/gen-carousel-cards.ts";
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

  it("6 temas + previsões → lotes 3/2/2, com as previsões no último", () => {
    const lotes = planAnnualSocialDays(keysFor(6), sabado);
    assert.deepEqual(lotes.map((d) => d.keys.length), [3, 2, 2]);
    assert.equal(lotes.at(-1)!.keys.at(-1), "previsoes");
  });

  it("um post por dia, em dias seguidos, sempre no mesmo horário (decisão do editor, 12/09/2026)", () => {
    const domingo = parseAAMMDD("260913");
    const lotes = planAnnualSocialDays(keysFor(6), domingo);
    const slots = lotes.flatMap((l) => l.keys.map((_, i) => l.slots[`d${i + 1}`]));
    assert.deepEqual(slots, [
      "2026-09-13T09:00", "2026-09-14T09:00", "2026-09-15T09:00", "2026-09-16T09:00",
      "2026-09-17T09:00", "2026-09-18T09:00", "2026-09-19T09:00",
    ]);
    assert.deepEqual(lotes.map((l) => l.date), ["260913", "260916", "260918"]);
  });

  it("horário configurável e validado", () => {
    assert.equal(planAnnualSocialDays(keysFor(3), sabado, "18:30")[0].slots.d1, "2026-09-12T18:30");
    assert.throws(() => planAnnualSocialDays(keysFor(3), sabado, "9h"), /HH:MM/);
  });

  it("menos de 2 posts não cabe em lote nenhum", () => {
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

  it("os publicadores agendam cada post no seu dia às 9h, lendo o social-slots.json do lote", () => {
    const config = { publishing: { social: { timezone: "America/Sao_Paulo", fallback_schedule: { d1_time: "10:00", d2_time: "12:30", d3_time: "17:30" } } } };
    const env = { DIARIA_SOCIAL_SLOTS_FILE: join(days[1].dir, "_internal", "social-slots.json") };
    const prev = process.env.DIARIA_SOCIAL_SLOTS_FILE;
    process.env.DIARIA_SOCIAL_SLOTS_FILE = env.DIARIA_SOCIAL_SLOTS_FILE;
    try {
      const now = Date.parse("2026-09-01T00:00:00Z");
      const at = (d: "d1" | "d2") => computeScheduledAt({ config, editionDate: days[1].date, destaque: d, platform: "linkedin", now });
      assert.equal(at("d1"), "2026-09-14T09:00:00-03:00");
      assert.equal(at("d2"), "2026-09-15T09:00:00-03:00");
    } finally {
      if (prev === undefined) delete process.env.DIARIA_SOCIAL_SLOTS_FILE;
      else process.env.DIARIA_SOCIAL_SLOTS_FILE = prev;
    }
  });

  it("rodada de janeiro não usa o enquadramento de aniversário", () => {
    assert.equal(socialCardCategory("janeiro", "2026"), "RETROSPECTIVA 2026");
  });
});

describe("readSlotOverride (DIARIA_SOCIAL_SLOTS_FILE)", () => {
  const dir = mkdtempSync(join(tmpdir(), "slots-"));
  const f = join(dir, "s.json");
  writeFileSync(f, JSON.stringify({ edition: "260913", slots: { d1: "2026-09-13T09:00", d2: "13/09 9h", d3: "2026-09-15T25:00" } }));
  const env = { DIARIA_SOCIAL_SLOTS_FILE: f, DIARIA_QUIET_SCHEDULE_LOG: "1" };

  it("sem a variável, nada muda (a diária segue a grade de sempre)", () => {
    assert.equal(readSlotOverride("d1", "260913", {}), null);
  });

  it("destaque listado vira data e hora explícitas; não listado cai na grade", () => {
    assert.deepEqual(readSlotOverride("d1", "260913", env), { year: 2026, month: 9, day: 13, time: "09:00" });
    const f2 = join(dir, "s2.json");
    writeFileSync(f2, JSON.stringify({ edition: "260913", slots: { d1: "2026-09-13T09:00" } }));
    assert.equal(readSlotOverride("d2", "260913", { ...env, DIARIA_SOCIAL_SLOTS_FILE: f2 }), null);
  });

  it("variável esquecida no shell não mexe em OUTRA edição (a diária seguinte, o artigo especial)", () => {
    assert.equal(readSlotOverride("d1", "260914", env), null);
    const config = { publishing: { social: { timezone: "America/Sao_Paulo", fallback_schedule: { d1_time: "10:00", d2_time: "12:30", d3_time: "17:30" } } } };
    const prev = process.env.DIARIA_SOCIAL_SLOTS_FILE;
    process.env.DIARIA_SOCIAL_SLOTS_FILE = f;
    try {
      const at = computeScheduledAt({ config, editionDate: "260914", destaque: "d1", platform: "facebook", now: Date.parse("2026-09-01T00:00:00Z") });
      assert.equal(at, "2026-09-14T10:00:00-03:00");
    } finally {
      if (prev === undefined) delete process.env.DIARIA_SOCIAL_SLOTS_FILE;
      else process.env.DIARIA_SOCIAL_SLOTS_FILE = prev;
    }
  });

  it("valor malformado (inclusive hora 25:00), arquivo sem edition ou ilegível lança", () => {
    assert.throws(() => readSlotOverride("d2", "260913", env), /AAAA-MM-DDTHH:MM/);
    assert.throws(() => readSlotOverride("d3", "260913", env), /AAAA-MM-DDTHH:MM/);
    const velho = join(dir, "velho.json");
    writeFileSync(velho, JSON.stringify({ d1: "2026-09-13T09:00" }));
    assert.throws(() => readSlotOverride("d1", "260913", { ...env, DIARIA_SOCIAL_SLOTS_FILE: velho }), /edition/);
    assert.throws(() => readSlotOverride("d1", "260913", { ...env, DIARIA_SOCIAL_SLOTS_FILE: join(tmpdir(), "nao-existe.json") }), /ilegível/);
  });

  it("slot já no passado ainda passa pelo past-slot guard", () => {
    const prev = process.env.DIARIA_SOCIAL_SLOTS_FILE;
    process.env.DIARIA_SOCIAL_SLOTS_FILE = f;
    try {
      const config = { publishing: { social: { timezone: "America/Sao_Paulo", fallback_schedule: { d1_time: "10:00" } } } };
      const now = Date.parse("2026-09-13T13:00:00Z"); // 10:00 BRT, depois do slot das 09:00
      const at = computeScheduledAt({ config, editionDate: "260913", destaque: "d1", platform: "linkedin", now });
      assert.ok(Date.parse(at) >= now + 10 * 60 * 1000, at);
    } finally {
      if (prev === undefined) delete process.env.DIARIA_SOCIAL_SLOTS_FILE;
      else process.env.DIARIA_SOCIAL_SLOTS_FILE = prev;
    }
  });
});

describe("capa de série (texto da retrospectiva + título ligado a '1 ano')", () => {
  it("# Capas sobrepõe o título da capa; capa de post inexistente falha", () => {
    const md = "# Social\n\n## t1\nS1\n\n# Curto\n\n## t1\nC1\n\n# Capas\n\n## t1\nEm um ano, o trabalho mudou\n";
    assert.equal(parseAnnualSocialMd(md).capas.t1, "Em um ano, o trabalho mudou");
    assert.throws(() => parseAnnualSocialMd(md + "\n## t9\nX\n"), /t9/);
  });

  it("social-cover.json leva só o nome da série em cada capa (sem 'tema i de N', sem data)", () => {
    const lote = { date: "260916", keys: ["t4", "previsoes"] as AnnualSocialKey[], slots: { d1: "2026-09-16T09:00", d2: "2026-09-17T09:00" } };
    assert.deepEqual(JSON.parse(buildDayCoverJson(lote, "Retrospectiva de aniversário")), {
      d1: { kicker: "Retrospectiva de aniversário" },
      d2: { kicker: "Retrospectiva de aniversário" },
    });
  });

  it("a abertura 'Retrospectiva …' sai do 1º slide de texto, mas fica na legenda", () => {
    const lote = { date: "260913", keys: ["t1"] as AnnualSocialKey[], slots: { d1: "2026-09-13T09:00" } };
    const social = { t1: "Retrospectiva de 1 ano da diar.ia.br, tema 1 de 6: o trabalho. Em setembro de 2025, **x**.\n\nP2.\n\nP3." };
    const cover = JSON.parse(buildDayCoverJson(lote, "Retrospectiva de aniversário", social));
    assert.equal(cover.d1.slide_prefix, "Retrospectiva de 1 ano da diar.ia.br, tema 1 de 6: o trabalho.");
    const d = mkdtempSync(join(tmpdir(), "slide-"));
    mkdirSync(join(d, "_internal"));
    writeFileSync(join(d, "_internal", "social-cover.json"), JSON.stringify(cover));
    assert.equal(slideSourceText(d, "d1", social.t1), "Em setembro de 2025, **x**.\n\nP2.\n\nP3.");
    assert.throws(() => slideSourceText(d, "d1", "Outro texto."), /slide_prefix/);
    // Abertura em parágrafo próprio (decisão do editor, 12/09/2026): o carrossel
    // fica com os 3 parágrafos de conteúdo.
    const separado = "Retrospectiva de 1 ano da diar.ia.br, tema 1 de 6: o trabalho.\n\nEm setembro de 2025, **x**.\n\nP2.\n\nP3.";
    const c2 = JSON.parse(buildDayCoverJson(lote, "Retrospectiva de aniversário", { t1: separado }));
    assert.equal(c2.d1.slide_prefix, "Retrospectiva de 1 ano da diar.ia.br, tema 1 de 6: o trabalho.");
    writeFileSync(join(d, "_internal", "social-cover.json"), JSON.stringify(c2));
    assert.equal(slideSourceText(d, "d1", separado), "Em setembro de 2025, **x**.\n\nP2.\n\nP3.");
    // Sem social-cover.json (diária): texto intacto.
    assert.equal(slideSourceText(mkdtempSync(join(tmpdir(), "diaria-")), "d1", social.t1), social.t1);
  });

  it("# Slides define o carrossel quando a legenda é uma lista (previsões uma por linha)", () => {
    const md = "# Social\n\n## previsoes\nAbertura.\n\n1) A.\n2) B.\n3) C.\n\nRessalva.\n\n# Curto\n\n## previsoes\nC\n\n# Slides\n\n## previsoes\n1) A. 2) B.\n\n3) C.\n\nRessalva.\n";
    const t = parseAnnualSocialMd(md);
    assert.equal(t.slides.previsoes, "1) A. 2) B.\n\n3) C.\n\nRessalva.");
    const lote = { date: "260918", keys: ["previsoes"] as AnnualSocialKey[], slots: { d1: "2026-09-19T09:00" } };
    const cover = JSON.parse(buildDayCoverJson(lote, "Retrospectiva de aniversário", t.social, t.slides));
    assert.deepEqual(cover.d1, { kicker: "Retrospectiva de aniversário", slide_text: t.slides.previsoes });
    const d = mkdtempSync(join(tmpdir(), "slides-"));
    mkdirSync(join(d, "_internal"));
    writeFileSync(join(d, "_internal", "social-cover.json"), JSON.stringify(cover));
    assert.equal(slideSourceText(d, "d1", t.social.previsoes), t.slides.previsoes);
    assert.throws(() => parseAnnualSocialMd(md + "\n## t9\nX\n"), /t9/);
  });

  it("a capa desenha a linha da série só quando pedida (a da diária não muda)", () => {
    assert.match(buildOverlaySvg("Título", "", undefined, undefined, "Retrospectiva de aniversário"), /RETROSPECTIVA DE ANIVERSÁRIO/);
    assert.equal(buildOverlaySvg("Título", "16 SET 2026"), buildOverlaySvg("Título", "16 SET 2026", undefined, undefined, ""));
    assert.doesNotMatch(buildOverlaySvg("Título", "16 SET 2026"), /RETROSPECTIVA/);
  });

  it("readCoverOverride: ausente → null (diária); malformado lança", () => {
    const d = mkdtempSync(join(tmpdir(), "cover-"));
    assert.equal(readCoverOverride(d, "d1"), null);
    mkdirSync(join(d, "_internal"));
    writeFileSync(join(d, "_internal", "social-cover.json"), JSON.stringify({ d1: { kicker: "K" }, d2: { kicker: 1 } }));
    assert.deepEqual(readCoverOverride(d, "d1"), { kicker: "K" });
    assert.throws(() => readCoverOverride(d, "d2"), /inválido/);
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
      { date: "260920", keys: ["t6", "previsoes"], slots: {} },
      { social: { t6: "S6", previsoes: "SP" }, curto: { t6: "C6", previsoes: "CP" }, capas: {}, slides: {} },
    );
    assert.match(md, /# Social\n\n## d1\nS6\n\n## d2\nSP/);
    assert.match(md, /# Curto\n\n## d1\nC6\n\n## d2\nCP/);
  });
});
