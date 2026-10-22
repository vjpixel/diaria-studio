/** #10765 itens 1/4/6: check individual de tempo sem medição + medição no move-pool-item. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUseMelhorTempoItemSemMedicao } from "../scripts/lib/invariant-checks/stage-4.ts";
import { measureTempoForMove } from "../scripts/move-pool-item.ts";
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
        { url: "https://a.com/medido", source: "wordcount" },
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
      ed(["medido", "titulo", "manual"].map((k) => ({ url: `https://a.com/${k}`, source: "youtube" }))),
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
    const art = JSON.parse(readFileSync(join(d, "_internal", "use-melhor-tempo-source.json"), "utf8"));
    assert.equal(art[0].source, "wordcount");
  });
});
