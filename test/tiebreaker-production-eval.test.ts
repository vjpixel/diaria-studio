/**
 * #8419 — medição de produção do tie-breaker #8211 (miolo puro + leitura do
 * corpus). Nenhum teste chama a rede: `runExtended` recebe fetch stubado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parsePublishedPlacements,
  sectionNameToBucket,
  collectTiebreakerDecisions,
  tiebreakerVerdictFromRule,
  gradeDecisions,
  summarizeProduction,
  isWorseThanOffline,
  wilsonInterval,
  extendedChoiceToBucket,
  extendedVerdict,
  compareExtended,
  gradable,
  tallyRuleAccuracy,
  renderProductionReport,
  renderExtendedReport,
  type CategorizedFile,
  type ExtendedComparison,
} from "../scripts/lib/tiebreaker-production-eval.ts";
import { loadCorpus, runExtended } from "../scripts/jev-tiebreaker-production-8419.ts";
import { canonicalize as canon } from "../scripts/lib/url-utils.ts";

const NEWS = "https://www.exemplo.com.br/2026/10/01/empresa-x-anuncia-parceria-com-governo"; // noticias-default
const OFFICIAL = "https://openai.com/index/new-thing"; // lancamento-default
const OFFICIAL2 = "https://blogs.nvidia.com/blog/egypt-africa-ai-ecosystem/"; // lancamento-default
const TUTORIAL = "https://www.exemplo.com.br/como-usar-ia-no-excel";
const CUT = "https://www.exemplo.com.br/cortado";
const DESTAQUE = "https://www.exemplo.com.br/destaque-1";

const REVIEWED_MD = `**DESTAQUE 1 | 💰 MERCADO**

**[Título do destaque](${DESTAQUE})**

Corpo do destaque com [fonte secundária](https://outra.com/x).

---

**🛠️ USE MELHOR**

**[Como usar IA no Excel](${TUTORIAL})**
Descrição.

---

**🚀 LANÇAMENTO**

**[New thing](${OFFICIAL})**
Descrição.

---

**📡 RADAR**

**[Empresa X anuncia parceria](${NEWS}?utm_source=diaria)**
Descrição.

**[Egypt AI ecosystem grows](${OFFICIAL2})**
Descrição.

---

**🎁 SORTEIO**

Responda.
`;

const art = (url: string, title: string, rule: string) => ({ url, title, summary: "A company did something with AI models this week.", category_rule: rule });

const CATEGORIZED: CategorizedFile = {
  lancamento: [art(OFFICIAL, "New thing", "semantic-tiebreaker-lancamento")],
  radar: [
    art(NEWS, "Empresa X anuncia parceria com governo para IA", "semantic-tiebreaker-radar"),
    // tie-breaker mudou o default (lancamento-default → radar) e o editor manteve em RADAR
    art(OFFICIAL2, "Egypt AI ecosystem grows", "semantic-tiebreaker-radar"),
    // tie-breaker disse radar, editor publicou em USE MELHOR (fora da Choice)
    art(TUTORIAL, "Como usar IA no Excel", "semantic-tiebreaker-radar"),
    art(CUT, "Cortado", "semantic-tiebreaker-radar-nonofficial"),
    art(DESTAQUE, "Destaque", "semantic-tiebreaker-radar"),
    art("https://www.exemplo.com.br/regra-forte", "Forte", "some-strong-rule"),
  ],
  use_melhor: [],
  video: [],
};

describe("sectionNameToBucket", () => {
  it("mapeia seções atuais e legadas", () => {
    assert.equal(sectionNameToBucket("LANÇAMENTOS"), "lancamento");
    assert.equal(sectionNameToBucket("RADAR"), "radar");
    assert.equal(sectionNameToBucket("USE MELHOR"), "use_melhor");
    assert.equal(sectionNameToBucket("VÍDEOS"), "video");
    assert.equal(sectionNameToBucket("OUTRAS NOTÍCIAS"), "radar");
    assert.equal(sectionNameToBucket("PESQUISAS"), "radar");
    assert.equal(sectionNameToBucket("SORTEIO"), null);
  });
});

describe("parsePublishedPlacements", () => {
  it("destaque, seções e URL com UTM casam canonicamente; fonte secundária do destaque não vira placement", () => {
    const p = parsePublishedPlacements(REVIEWED_MD);
    const get = (u: string) => p.get(canon(u));
    assert.equal(get(DESTAQUE), "destaque");
    assert.equal(get(TUTORIAL), "use_melhor");
    assert.equal(get(OFFICIAL), "lancamento");
    assert.equal(get(NEWS), "radar");
    assert.equal(get(OFFICIAL2), "radar");
    assert.equal(get("https://outra.com/x"), undefined);
  });
});

describe("collectTiebreakerDecisions", () => {
  it("só pega regras semantic-tiebreaker-* e recomputa o default silencioso", () => {
    const d = collectTiebreakerDecisions("261001", CATEGORIZED);
    assert.equal(d.length, 6);
    const byUrl = new Map(d.map((x) => [x.url, x]));
    assert.equal(byUrl.get(NEWS)!.baseline, "radar");
    assert.equal(byUrl.get(OFFICIAL2)!.baseline, "lancamento");
    assert.equal(byUrl.get(OFFICIAL2)!.tiebreaker, "radar");
    // drift: o código ATUAL já pega o tutorial por regra forte — baseline cai
    // na aproximação do default (não-oficial → radar), não na regra nova.
    assert.deepEqual(d.filter((x) => x.baselineDrift).map((x) => x.url), [TUTORIAL]);
    assert.equal(byUrl.get(TUTORIAL)!.baseline, "radar");
  });

  it("veredito vem da REGRA, não do bucket do arquivo (item movido depois por outro passo)", () => {
    const moved: CategorizedFile = { radar: [art(OFFICIAL, "New thing", "semantic-tiebreaker-lancamento")] };
    const [d] = collectTiebreakerDecisions("261001", moved);
    assert.equal(d.tiebreaker, "lancamento");
    assert.equal(d.storedBucket, "radar");
    assert.equal(tiebreakerVerdictFromRule("semantic-tiebreaker-radar-nonofficial"), "radar");
  });
});

describe("summarizeProduction", () => {
  const graded = gradeDecisions(collectTiebreakerDecisions("261001", CATEGORIZED), parsePublishedPlacements(REVIEWED_MD));

  it("exclui destaque e cortado do gabarito, separa o que está fora da Choice", () => {
    const s = summarizeProduction(graded);
    assert.equal(s.decisions, 6);
    assert.equal(s.gradable, 4);
    assert.equal(s.placements.cortado, 1);
    assert.equal(s.placements.destaque, 1);
    // tie-breaker: OFFICIAL ok, NEWS ok, OFFICIAL2 ok, TUTORIAL erro (use_melhor)
    assert.equal(s.tiebreakerVsBaseline.aCorrect, 3);
    // default: OFFICIAL ok, NEWS ok, OFFICIAL2 erro (lancamento), TUTORIAL erro
    assert.equal(s.tiebreakerVsBaseline.bCorrect, 2);
    assert.equal(s.tiebreakerVsBaseline.mcnemar.b, 1);
    assert.equal(s.tiebreakerVsBaseline.mcnemar.c, 0);
    assert.equal(s.inChoice.n, 3);
    assert.equal(s.inChoice.aCorrect, 3);
    assert.deepEqual(s.outOfChoice.map((x) => x.url), [TUTORIAL]);
    assert.equal(s.changedVsDefault, 1);
    assert.deepEqual(s.changedPlacements, { radar: 1 });
    assert.match(renderProductionReport(s), /Tie-breaker \(produção\) \| 3\/4/);
  });

  it("tallyRuleAccuracy usa o veredito da regra pros tie-breakers e ignora destaque/cortado", () => {
    const t = tallyRuleAccuracy(CATEGORIZED, parsePublishedPlacements(REVIEWED_MD));
    assert.deepEqual(t["semantic-tiebreaker-radar"], { correct: 2, total: 3, missTo: { use_melhor: 1 } });
    assert.deepEqual(t["semantic-tiebreaker-lancamento"], { correct: 1, total: 1, missTo: {} });
    assert.equal(t["semantic-tiebreaker-radar-nonofficial"], undefined);
  });
});

describe("item 3 — pior que o offline", () => {
  it("só é pior quando o IC superior fica abaixo de 20/22", () => {
    assert.equal(isWorseThanOffline(27, 33), false); // medido em produção (#8419)
    assert.equal(isWorseThanOffline(10, 33), true);
    assert.equal(isWorseThanOffline(0, 0), false);
  });
  it("Wilson contém o ponto e fica em [0,1]", () => {
    const [lo, hi] = wilsonInterval(27, 33);
    assert.ok(lo < 27 / 33 && 27 / 33 < hi && lo >= 0 && hi <= 1);
  });
});

describe("item 2 — Choice estendida", () => {
  it("extendedChoiceToBucket aplica #160 e funde pesquisa em radar", () => {
    assert.equal(extendedChoiceToBucket("lancamento", OFFICIAL), "lancamento");
    assert.equal(extendedChoiceToBucket("lancamento", NEWS), "radar");
    assert.equal(extendedChoiceToBucket("pesquisa", NEWS), "radar");
    assert.equal(extendedChoiceToBucket("use_melhor", NEWS), "use_melhor");
    assert.equal(extendedChoiceToBucket("video", NEWS), "video");
    assert.equal(extendedChoiceToBucket("outra", NEWS), null);
  });

  const mk = (a: number, b: number, bOnly: number, cOnly: number): ExtendedComparison =>
    ({ run: 1, answered: 10, errors: 0, n: 10, aCorrect: a, bCorrect: b, discordant: [], mcnemar: { b: bOnly, c: cOnly, chiSquare: 0, pValueChiSquare: 1, pValueExact: bOnly >= 6 && cOnly === 0 ? 0.03 : 0.5 } }) as ExtendedComparison;

  it("extendedVerdict exige ganho em todas as rodadas e significância", () => {
    assert.equal(extendedVerdict([]), "sem-dado");
    assert.equal(extendedVerdict([mk(9, 7, 2, 0), mk(8, 7, 1, 0)]), "nao-adotar"); // caso medido no #8419
    assert.equal(extendedVerdict([mk(10, 4, 6, 0), mk(10, 4, 6, 0)]), "adotar");
    assert.equal(extendedVerdict([mk(10, 4, 6, 0), mk(4, 4, 0, 0)]), "nao-adotar");
  });

  it("compareExtended pareia contra a produção e lista discordâncias", () => {
    const items = gradable(gradeDecisions(collectTiebreakerDecisions("261001", CATEGORIZED), parsePublishedPlacements(REVIEWED_MD)));
    // força a estendida a acertar o tutorial
    const r = compareExtended(
      items,
      { answers: new Map([...items].map((x) => [canon(x.url), x.url === TUTORIAL ? "use_melhor" : x.tiebreaker])), errors: 0 },
      1,
    );
    assert.equal(r.aCorrect, 4);
    assert.equal(r.bCorrect, 3);
    assert.equal(r.discordant.length, 1);
    assert.match(renderExtendedReport([r]), /NÃO ADOTAR/);
  });
});

describe("loadCorpus + runExtended (fixture em disco, fetch stubado)", () => {
  it("lê o layout nested, respeita --since e roda a estendida sem rede real", async () => {
    const root = mkdtempSync(join(tmpdir(), "tb8419-"));
    try {
      const dir = join(root, "2610", "261001");
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "01-categorized.json"), JSON.stringify(CATEGORIZED));
      writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_MD);
      const old = join(root, "2609", "260910");
      mkdirSync(join(old, "_internal"), { recursive: true });
      writeFileSync(join(old, "_internal", "01-categorized.json"), JSON.stringify(CATEGORIZED));
      writeFileSync(join(old, "02-reviewed.md"), REVIEWED_MD);

      const { graded, skipped } = loadCorpus(root, "260917");
      assert.equal(graded.length, 6);
      assert.deepEqual(skipped, []);

      let calls = 0;
      const fetchImpl = (async (_u: string, init: RequestInit) => {
        calls++;
        const body = JSON.parse(String(init.body));
        const choice = body.state.url === TUTORIAL ? "use_melhor" : body.state.url === OFFICIAL ? "lancamento" : "radar";
        return new Response(JSON.stringify({ answers: { bucket: { type: "choice", choice, confidence: 0.9 } } }), { status: 200 });
      }) as unknown as typeof fetch;
      const runs = await runExtended(graded, { apiKey: "test", runs: 2, fetchImpl });
      assert.equal(calls, 8); // 4 gabaritáveis × 2 rodadas
      assert.equal(runs.length, 2);
      assert.equal(runs[0].aCorrect, 4);
      assert.equal(runs[0].bCorrect, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("diretório ausente devolve corpus vazio", () => {
    assert.deepEqual(loadCorpus("/nao/existe/8419").graded, []);
  });
});
