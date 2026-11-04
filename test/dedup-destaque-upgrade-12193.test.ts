/**
 * test/dedup-destaque-upgrade-12193.test.ts (#12193)
 *
 * Regra do editor (04/11/2026): URL já publicada em seção NÃO-destaque
 * (RADAR, USE MELHOR...) dentro da janela de dedup pode voltar como
 * DESTAQUE; URL que já foi destaque continua barrada; e a URL repetida nunca
 * volta para uma seção normal. Caso real 261105: o TechCrunch "Anthropic
 * warns that it's very close to RSI capability" pedido pelo editor como D1
 * caiu no dedup (`url-match com edição anterior`) por ter saído no RADAR da
 * 261104, e o editor não foi avisado.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedup } from "../scripts/dedup.ts";
import {
  computeDestaqueUpgradeEligible,
  detectDestaqueRequest,
  dropDestaqueOnlyFromBuckets,
  findEditorDestaqueRequestIssues,
  DESTAQUE_ONLY_FIELD,
  DESTAQUE_REQUEST_FIELD,
} from "../scripts/lib/destaque-upgrade.ts";
import {
  extractDestaqueUpgradeEligibleUrls,
  extractPastUrlDatesWithinDays,
} from "../scripts/lib/past-editions-extract.ts";
import { extractEditorUrls, parseInboxMd } from "../scripts/inject-inbox-urls.ts";
import {
  findDuplicateUrlsAgainstPastEditions,
  checkEditorDestaqueRequests,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";

const RSI = "https://techcrunch.com/2026/11/02/anthropic-warns-that-its-very-close-to-rsi-capability-aka-self-building-ai";
const RSI_TITLE = "Anthropic warns that it's very close to RSI capability, aka self-building AI";
const PAST_D1 = "https://example.com/destaque-de-ontem";

/** Chama dedup() só com o que importa aqui (posicionais longos). */
function runDedup(
  articles: Array<Record<string, unknown> & { url: string }>,
  opts: {
    pastUrls: string[];
    pastDestaques?: string[];
    eligible?: string[];
    pastArticleTitles?: string[];
    titleByUrl?: Map<string, string>;
  },
) {
  return dedup(
    articles,
    new Set(opts.pastUrls.map((u) => canonicalize(u))),
    0.85,
    [],
    0.7,
    opts.pastArticleTitles ?? [],
    0.6,
    new Set((opts.pastDestaques ?? []).map((u) => canonicalize(u))),
    0.55,
    new Set(),
    [],
    [],
    new Map(),
    new Map(),
    opts.titleByUrl ?? new Map(),
    [],
    new Set((opts.eligible ?? []).map((u) => canonicalize(u))),
  );
}

describe("#12193 dedup Pass 1: upgrade a destaque", () => {
  it("URL que saiu no RADAR (elegível) fica no pool marcada como só-destaque", () => {
    const r = runDedup([{ url: RSI, title: RSI_TITLE, flag: "editor_submitted" }], {
      pastUrls: [RSI],
      eligible: [RSI],
    });
    assert.equal(r.kept.length, 1);
    assert.equal(r.removed.length, 0);
    assert.match(String(r.kept[0][DESTAQUE_ONLY_FIELD]), /só pode voltar como destaque/);
  });

  it("URL que já foi destaque segue barrada, mesmo se aparecer no Set de elegíveis", () => {
    const r = runDedup([{ url: PAST_D1, title: "Destaque de ontem" }], {
      pastUrls: [PAST_D1],
      pastDestaques: [PAST_D1],
      eligible: [PAST_D1],
    });
    assert.equal(r.kept.length, 0);
    assert.equal(r.removed[0].dedup_note, "url-match com edição anterior");
  });

  it("sem prova de seção (fora do Set de elegíveis) a URL repetida segue barrada", () => {
    const r = runDedup([{ url: RSI, title: RSI_TITLE }], { pastUrls: [RSI] });
    assert.equal(r.kept.length, 0);
    assert.equal(r.removed[0].dedup_note, "url-match com edição anterior");
  });

  it("o próprio título publicado não derruba a candidata no Pass 1c (self-match)", () => {
    const r = runDedup([{ url: RSI, title: "(inbox)", flag: "editor_submitted" }], {
      pastUrls: [RSI],
      eligible: [RSI],
      pastArticleTitles: [RSI_TITLE],
      titleByUrl: new Map([[canonicalize(RSI), RSI_TITLE]]),
    });
    assert.equal(r.kept.length, 1, JSON.stringify(r.removed));
  });

  it("o mesmo título passado ainda derruba um artigo comum (sem marca)", () => {
    const r = runDedup([{ url: "https://outro.com/copia", title: RSI_TITLE }], {
      pastUrls: [RSI],
      eligible: [RSI],
      pastArticleTitles: [RSI_TITLE],
    });
    assert.equal(r.kept.length, 0);
    assert.match(r.removed[0].dedup_note, /subject similar/);
  });
});

describe("#12193 elegibilidade", () => {
  it("computeDestaqueUpgradeEligible: edição sem destaques conhecidos ou com a URL como destaque → inelegível", () => {
    const dates = new Map<string, string[]>([
      ["a", ["2026-11-04"]],
      ["b", ["2026-11-04", "2026-11-02"]], // 11-02 desconhecida
      ["c", ["2026-11-03"]], // foi destaque em 11-03
    ]);
    const known: Record<string, Set<string>> = {
      "2026-11-04": new Set(["x"]),
      "2026-11-03": new Set(["c"]),
    };
    const out = computeDestaqueUpgradeEligible(dates, (d) => known[d]);
    assert.deepEqual([...out], ["a"]);
  });

  describe("extractDestaqueUpgradeEligibleUrls (pastas locais)", () => {
    let dir: string;
    const md = [
      "# Past editions",
      "",
      "## 2026-11-04 — \"Golpe da selfie\"",
      "",
      "Links usados:",
      `- ${PAST_D1} — Destaque`,
      `- ${RSI} — ${RSI_TITLE}`,
      "",
      "## 2026-11-03 — \"Outra\"",
      "",
      "Links usados:",
      "- https://example.com/sem-pasta — Sem pasta local",
      "",
    ].join("\n");
    before(() => {
      dir = mkdtempSync(join(tmpdir(), "upgrade-12193-"));
      mkdirSync(join(dir, "2611", "261104", "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "2611", "261104", "_internal", "01-approved.json"),
        JSON.stringify({ highlights: [{ rank: 1, url: PAST_D1 }], radar: [{ url: RSI }] }),
      );
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("RADAR de edição com destaques legíveis é elegível; destaque e edição sem pasta não", () => {
      const out = extractDestaqueUpgradeEligibleUrls(md, dir, 30, "261105");
      assert.ok(out.has(canonicalize(RSI)));
      assert.ok(!out.has(canonicalize(PAST_D1)));
      assert.ok(!out.has(canonicalize("https://example.com/sem-pasta")));
    });

    it("extractPastUrlDatesWithinDays guarda todas as datas", () => {
      const twice = md.replace("https://example.com/sem-pasta", RSI);
      const dates = extractPastUrlDatesWithinDays(twice, 30, "261105");
      assert.deepEqual(dates.get(canonicalize(RSI)), ["2026-11-04", "2026-11-03"]);
      // 11-03 sem pasta local → inelegível
      assert.ok(!extractDestaqueUpgradeEligibleUrls(twice, dir, 30, "261105").has(canonicalize(RSI)));
    });
  });
});

describe("#12193 nunca volta para seção normal", () => {
  it("dropDestaqueOnlyFromBuckets tira do pool o marcado que não virou destaque", () => {
    const buckets: Record<string, Array<{ url: string; [k: string]: unknown }>> = {
      radar: [{ url: RSI, [DESTAQUE_ONLY_FIELD]: "nota" }, { url: "https://a.com/x" }],
      use_melhor: [{ url: "https://b.com/y", [DESTAQUE_ONLY_FIELD]: "nota" }],
    };
    const dropped = dropDestaqueOnlyFromBuckets(buckets, ["https://b.com/y"]);
    assert.deepEqual(dropped.map((d) => d.url), [RSI]);
    assert.deepEqual(buckets.radar.map((a) => a.url), ["https://a.com/x"]);
    assert.equal(buckets.use_melhor.length, 1); // virou destaque: fica
  });
});

describe("#12193 pedido de destaque do editor", () => {
  it("detectDestaqueRequest", () => {
    assert.equal(detectDestaqueRequest("esse deve ser o d1 da edição 261105"), "d1");
    assert.equal(detectDestaqueRequest("coloca como destaque"), "destaque");
    assert.equal(detectDestaqueRequest("https://site.com/d1/artigo"), null);
    assert.equal(detectDestaqueRequest("olha isso"), null);
  });

  it("extractEditorUrls marca o link do e-mail real de 03/11 (assunto + raw)", () => {
    const inbox = [
      "# Inbox",
      "",
      "## 2026-11-03T23:25:26.000Z",
      "- **from:** Angelo Pixel <vjpixel@gmail.com>",
      "- **subject:** esse deve ser o d1 da edição 261105",
      "- **urls:**",
      `  - ${RSI}/`,
      `- **raw:** > ${RSI}/   me avise se não colocar ele como d1 por qualquer razão`,
      "",
      "## 2026-11-03T22:00:00.000Z",
      "- **from:** Angelo Pixel <vjpixel@gmail.com>",
      "- **subject:** Fwd: Newsletter com os destaques do dia",
      "- **urls:**",
      "  - https://example.com/fwd-1",
      "",
    ].join("\n");
    const arts = extractEditorUrls(parseInboxMd(inbox));
    const rsi = arts.find((a) => a.url.includes("anthropic-warns"));
    assert.equal(rsi?.[DESTAQUE_REQUEST_FIELD], "d1");
    const fwd = arts.find((a) => a.url.includes("fwd-1"));
    assert.equal(fwd?.[DESTAQUE_REQUEST_FIELD], undefined);
  });

  it("findEditorDestaqueRequestIssues: barrado no funil, posição errada, no pool, atendido", () => {
    const issues = findEditorDestaqueRequestIssues(
      [
        { url: RSI, request: "d1" },
        { url: "https://b.com/d2-ok", request: "d2" },
        { url: "https://c.com/d1-mas-d3", request: "d1" },
        { url: "https://d.com/no-radar", request: "destaque" },
      ],
      ["https://x.com/d1", "https://b.com/d2-ok", "https://c.com/d1-mas-d3"],
      [{ url: RSI, outcome: "dropped", exit_stage: "dedup", reason: "dedup: url-match com edição anterior" }],
      { radar: [{ url: "https://d.com/no-radar" }] },
    );
    assert.equal(issues.length, 3);
    assert.match(issues[0].reason, /barrado em dedup: dedup: url-match/);
    assert.match(issues[1].reason, /pedido como D1, saiu como D3/);
    assert.match(issues[2].reason, /ficou no pool \(seção radar\)/);
  });

  describe("checkEditorDestaqueRequests (fixture de edição)", () => {
    let dir: string;
    before(() => {
      dir = mkdtempSync(join(tmpdir(), "req-12193-"));
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", "tmp-articles-raw.json"),
        JSON.stringify([{ url: RSI, title: "(inbox)", flag: "editor_submitted", [DESTAQUE_REQUEST_FIELD]: "d1" }]),
      );
      writeFileSync(
        join(dir, "_internal", "01-approved.json"),
        JSON.stringify({ highlights: [{ rank: 1, url: "https://x.com/d1" }], radar: [], lancamento: [], use_melhor: [], video: [] }),
      );
      writeFileSync(
        join(dir, "_internal", "stage1-funnel.json"),
        JSON.stringify({ items: [{ url: RSI, outcome: "dropped", exit_stage: "dedup", reason: "dedup: url-match com edição anterior" }] }),
      );
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("avisa no gate 4 com o motivo, severity warning", () => {
      const v = checkEditorDestaqueRequests(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "editor-destaque-request");
      assert.match(v[0].message, /D1/);
      assert.match(v[0].message, /url-match com edição anterior/);
    });

    it("registrado em STAGE_4_RULES", () => {
      assert.ok(getRulesForStage(4).some((r) => r.id === "editor-destaque-request"));
    });
  });
});

describe("#12193 invariante no-duplicate-urls-vs-past-editions", () => {
  it("destaque promovido (exempt) não é acusado; outro link repetido segue acusado", () => {
    const md = `## Destaque\n\n**[RSI](${RSI})**\n\n## Radar\n\n**[Velho](https://example.com/velho)**\n`;
    const origins = new Map([
      [canonicalize(RSI), "2026-11-04"],
      [canonicalize("https://example.com/velho"), "2026-11-04"],
    ]);
    const all = findDuplicateUrlsAgainstPastEditions(md, origins);
    assert.equal(all.length, 2);
    const exempt = findDuplicateUrlsAgainstPastEditions(md, origins, new Set([canonicalize(RSI)]));
    assert.deepEqual(exempt.map((m) => m.url), ["https://example.com/velho"]);
  });
});
