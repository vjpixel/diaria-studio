/** #10765 itens 1/4/6: check individual de tempo sem medição + medição no move-pool-item. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUseMelhorTempoItemSemMedicao } from "../scripts/lib/invariant-checks/stage-4.ts";
import { measureTempoForMove, recordTempoMeasurement, moveItemInReviewedMd, movePoolItem } from "../scripts/move-pool-item.ts";
import { refreshUseMelhorTempo } from "../scripts/lib/use-melhor-tempo-refresh.ts";
import { saveCachedBody } from "../scripts/lib/url-body-cache.ts";

const MD = [
  "**🛠️ USE MELHOR**",
  "",
  "**[Medido](https://a.com/medido)**  ",
  "desc (5 min)",
  "",
  "**[Por título](https://a.com/titulo)**  ",
  "desc (5 min)",
  "",
  "**[Manual](https://a.com/manual)**  ",
  "desc (5 min)",
  "",
  "---",
  "",
  "**📰 RADAR**",
  "",
  "**[Outro](https://a.com/radar)**  ",
  "desc",
].join("\n");

function ed(artifact: unknown): string {
  const d = mkdtempSync(join(tmpdir(), "um10765-"));
  mkdirSync(join(d, "_internal"), { recursive: true });
  writeFileSync(join(d, "02-reviewed.md"), MD, "utf8");
  if (artifact !== null) writeFileSync(join(d, "_internal", "use-melhor-tempo-source.json"), JSON.stringify(artifact), "utf8");
  return d;
}

describe("#10765 checkUseMelhorTempoItemSemMedicao", () => {
  it("avisa por item: estimado por título e sem fonte (manual); medido e RADAR ficam fora", () => {
    const v = checkUseMelhorTempoItemSemMedicao(
      ed([
        { url: "https://a.com/medido", source: "wordcount", estimate: "(5 min)" },
        { url: "https://a.com/titulo", source: "title-heuristic" },
      ]),
    );
    assert.equal(v.length, 2);
    assert.ok(v.every((x) => x.severity === "warning"));
    assert.match(v[0].message, /"Por título".*ESTIMADO POR TÍTULO/);
    assert.match(v[1].message, /"Manual".*sem fonte de medição/);
  });

  it("artifact ausente → todos os itens sem fonte", () => {
    assert.equal(checkUseMelhorTempoItemSemMedicao(ed(null)).length, 3);
  });

  it("tudo medido → sem violação", () => {
    const v = checkUseMelhorTempoItemSemMedicao(
      ed(["medido", "titulo", "manual"].map((k) => ({ url: `https://a.com/${k}`, source: "youtube", estimate: "(5 min)" }))),
    );
    assert.deepEqual(v, []);
  });
});

describe("#10765 measureTempoForMove", () => {
  it("usa o corpo cacheado, mede e registra a fonte no artifact", async () => {
    const d = ed(null);
    const url = "https://a.com/manual";
    const body = `<html lang="pt"><body><p>${new Array(2000).fill("palavra").join(" ")}</p></body></html>`;
    saveCachedBody(join(d, "_internal", "_forensic", "link-verify-bodies"), url, body);
    const r = await measureTempoForMove(d, url);
    assert.equal(r.tempo, 10);
    assert.equal(r.source, "wordcount");
    assert.equal(r.title, "Manual");
    recordTempoMeasurement(d, { url, ...r }, r.tempo);
    const art = JSON.parse(readFileSync(join(d, "_internal", "use-melhor-tempo-source.json"), "utf8"));
    assert.equal(art[0].source, "wordcount");
    assert.equal(art[0].md_tempo, 10);
  });
});

const BODY = `<html lang="pt"><body><p>${new Array(2000).fill("palavra").join(" ")}</p></body></html>`; // 10 min

describe("#10765 A: move pro USE MELHOR com tempo manual pré-existente (caso Cowork)", () => {
  const RADAR_MD = [
    "**📰 RADAR**", "", "**[Cowork](https://a.com/cowork)**  ", "Descrição longa (2 min)", "", "---", "",
    "**🛠️ USE MELHOR**", "", "**[Outro](https://a.com/outro)**  ", "desc (5 min)",
  ].join("\n");

  it("sem tempo explícito: mede e SUBSTITUI o (N min) manual", () => {
    const r = moveItemInReviewedMd(RADAR_MD, "https://a.com/cowork", "use_melhor", { tempo: 10, replaceTempo: true });
    assert.match(r.md, /Descrição longa \(10 min\)/);
    assert.doesNotMatch(r.md, /\(2 min\)/);
  });

  it("com --tempo explícito: preserva o manual (sem replaceTempo)", () => {
    const r = moveItemInReviewedMd(RADAR_MD, "https://a.com/cowork", "use_melhor", { tempo: 10 });
    assert.match(r.md, /Descrição longa \(2 min\)/);
  });

  it("registra medição vs manual: divergência vira warning (escolha manual preservada)", async () => {
    const d = ed(null);
    writeFileSync(join(d, "02-reviewed.md"), RADAR_MD, "utf8");
    saveCachedBody(join(d, "_internal", "_forensic", "link-verify-bodies"), "https://a.com/cowork", BODY);
    const m = await measureTempoForMove(d, "https://a.com/cowork");
    recordTempoMeasurement(d, { url: "https://a.com/cowork", ...m }, 2);
    movePoolItem(d, "https://a.com/cowork", "use_melhor", { tempo: 2 });
    const v = checkUseMelhorTempoItemSemMedicao(d).filter((x) => x.message.includes("Cowork"));
    assert.equal(v.length, 1);
    assert.match(v[0].message, /texto diz 2 min, medido 10 min \(wordcount\) — escolha manual preservada/);
  });
});

describe("#10765 B: refresh no gate para URL USE MELHOR sem artifact/alterada", () => {
  it("item inserido à mão é medido via cache/fetch mockado; md não é reescrito", async () => {
    const d = ed([{ url: "https://a.com/medido", source: "wordcount", estimate: "(5 min)" }]);
    const before = readFileSync(join(d, "02-reviewed.md"), "utf8");
    saveCachedBody(join(d, "_internal", "_forensic", "link-verify-bodies"), "https://a.com/manual", BODY);
    const fetched: string[] = [];
    const r = await refreshUseMelhorTempo(d, async (_dir, u) => {
      fetched.push(u);
      return null; // /titulo: fetch falha → heurística
    });
    assert.deepEqual(r.skipped, ["https://a.com/medido"]);
    assert.equal(r.refreshed.length, 2);
    assert.deepEqual(fetched, ["https://a.com/titulo"]);
    assert.equal(readFileSync(join(d, "02-reviewed.md"), "utf8"), before);
    const v = checkUseMelhorTempoItemSemMedicao(d).map((x) => x.message);
    assert.ok(v.some((m) => /"Manual".*texto diz 5 min, medido 10 min/.test(m)));
    assert.ok(v.some((m) => /"Por título".*ESTIMADO POR TÍTULO/.test(m)));
    // idempotente: 2ª passada não refaz o que já está medido e consistente
    const r2 = await refreshUseMelhorTempo(d, async () => null);
    assert.ok(r2.skipped.includes("https://a.com/manual"));
  });

  it('"(N min)" alterado pelo editor invalida a medição anterior', async () => {
    const d = ed([
      { url: "https://a.com/medido", source: "wordcount", estimate: "(3 min)" },
      { url: "https://a.com/titulo", source: "wordcount", estimate: "(5 min)" },
      { url: "https://a.com/manual", source: "wordcount", estimate: "(5 min)" },
    ]);
    const r = await refreshUseMelhorTempo(d, async () => null);
    assert.deepEqual(r.refreshed.map((x) => x.url), ["https://a.com/medido"]);
  });
});
