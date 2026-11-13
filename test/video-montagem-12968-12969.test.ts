/**
 * #12968: `build --seq` depois de editar o blocks.json não recusa mais (#12902
 * recusava, e a SKILL e o `[erro]` do `srt --from-final` mandavam justamente
 * refazer o `build --seq youtube`). As outras sequências ficam no plan.json
 * marcadas como defasadas, com o plano, a versão e o instante do build delas,
 * e srt/preview/review/verify-xml as deixam de fora até um build delas.
 *
 * #12969: o `verify-xml` confere a palavra esticada no MESMO limiar fixo do
 * review/preview e as bordas no limiar do silences.meta.json que o build usou.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_SILENCE_FILTER,
  exportSrtRefusalHint,
  main,
  mergeBuildPlan,
  splitStalePlans,
  staleMarkOf,
  staleSequencesWarning,
  verifyXmlEdgeThreshold,
} from "../scripts/video-montagem.ts";
import { SILENCE_DETECT } from "../scripts/lib/diaria/video-montage.ts";

type Merge = Parameters<typeof mergeBuildPlan>[0];
type P = Merge["next"]["plans"][number];
const plan = (target: string, tag: string, height = 1080, width = 1920, corte?: string): P =>
  ({ spec: { name: `${target}-${tag}`, target, width, height, ...(corte ? { corte } : {}) }, clips: [], durationFrames: 0, missingBlocks: [], dropped: [], script: tag } as unknown as P);
const base = { edition: "261112", source: {} as never, framing: {} as never, framingAssumed: false };
const names = (pf: { plans: P[] }) => pf.plans.map((p) => p.spec.name);

describe("#12968: build --seq com entradas novas mantém as outras sequências como defasadas", () => {
  // O cenário da issue: o horizontal foi ao ar, o editor corrige o roteiro dele no blocks.json e refaz o build --seq youtube.
  const prev = {
    ...base,
    hash: "OLD",
    plans: [plan("youtube", "v1"), plan("outras-redes", "v1", 1920, 1080), plan("instagram", "v1", 1920, 1080, "guia")],
    builtAt: { youtube: 100, "outras-redes": 100, guia: 100 },
    xmlVersions: { youtube: { id: "seq-youtube-v1", since: 100 }, "outras-redes": { id: "seq-outras-redes-v4", since: 90 }, guia: { id: "seq-instagram-v2-guia", since: 80 } },
    xmlAssets: { "outras-redes": { treatedAudio: { path: "a", xmlPath: "b", filter: "old" } } },
  };
  const next = { ...base, hash: "NEW", plans: [plan("youtube", "v2"), plan("outras-redes", "v2", 1920, 1080), plan("instagram", "v2", 1920, 1080, "guia")] };

  it("a reconstruída entra nova; as outras ficam com plano, versão, instante e assets do build delas", () => {
    const r = mergeBuildPlan({ next, pickedKeys: new Set(["youtube"]), prev, now: 500, xmlIds: { youtube: "seq-youtube-v2" } });
    assert.deepEqual(names(r.plan), ["youtube-v2", "outras-redes-v1", "instagram-v1"]);
    assert.equal(r.plan.hash, "NEW");
    assert.deepEqual(r.stale, ["outras-redes", "guia"]);
    assert.deepEqual(r.kept, []);
    assert.deepEqual(r.dropped, []);
    assert.deepEqual(r.plan.stale, { "outras-redes": { hash: "OLD" }, guia: { hash: "OLD" } });
    assert.deepEqual(r.plan.builtAt, { youtube: 500, "outras-redes": 100, guia: 100 });
    // A versão das verticais já exportadas para Final/ não muda (o problema do build completo, #12111/#12160).
    assert.deepEqual(r.plan.xmlVersions?.["outras-redes"], { id: "seq-outras-redes-v4", since: 90 });
    assert.deepEqual(r.plan.xmlVersions?.guia, { id: "seq-instagram-v2-guia", since: 80 });
    assert.deepEqual(r.plan.xmlVersions?.youtube, { id: "seq-youtube-v2", since: 500 });
    assert.deepEqual(r.plan.xmlAssets?.["outras-redes"], prev.xmlAssets["outras-redes"]);
  });

  it("srt/preview/review/verify-xml veem só a sequência em dia (loadPlan filtra as defasadas)", () => {
    const r = mergeBuildPlan({ next, pickedKeys: new Set(["youtube"]), prev, now: 500 });
    const split = splitStalePlans(r.plan);
    assert.deepEqual(split.fresh.map((p) => p.spec.name), ["youtube-v2"]);
    assert.deepEqual(split.stale, ["outras-redes", "guia"]);
    assert.match(staleSequencesWarning(split.stale), /outras-redes, guia: defasada\(s\).*build --seq de cada uma.*#12968/);
  });

  it("a marca sobrevive a outro --seq com as mesmas entradas e sai no build da sequência", () => {
    const first = mergeBuildPlan({ next, pickedKeys: new Set(["youtube"]), prev, now: 500 }).plan;
    const second = mergeBuildPlan({ next, pickedKeys: new Set(["outras-redes"]), prev: first, now: 600 });
    assert.deepEqual(names(second.plan), ["youtube-v2", "outras-redes-v2", "instagram-v1"]);
    assert.deepEqual(second.kept, ["youtube"]);
    assert.deepEqual(second.stale, ["guia"]);
    assert.deepEqual(second.plan.stale, { guia: { hash: "OLD" } }, "a defasada guarda o hash das entradas do XML dela, não o do plano intermediário");
    const full = mergeBuildPlan({ next, pickedKeys: new Set(["youtube", "outras-redes", "guia"]), prev: second.plan, now: 700 });
    assert.equal(full.plan.stale, undefined, "build sem --seq limpa todas as marcas");
    assert.deepEqual(full.stale, []);
  });

  it("entradas que voltam às do build dela desfazem a marca", () => {
    const first = mergeBuildPlan({ next, pickedKeys: new Set(["youtube"]), prev, now: 500 }).plan;
    const back = mergeBuildPlan({ next: { ...next, hash: "OLD" }, pickedKeys: new Set(["youtube"]), prev: first, now: 600 });
    assert.deepEqual(back.kept, ["outras-redes", "guia"]);
    assert.equal(back.plan.stale, undefined);
  });

  it("só sai do plano a sequência que o plano anterior não tinha", () => {
    const r = mergeBuildPlan({ next: { ...next, plans: [...next.plans, plan("instagram", "v1", 1920, 1080, "novo")] }, pickedKeys: new Set(["youtube"]), prev, now: 500 });
    assert.deepEqual(r.dropped, ["novo"]);
  });

  it("marca malformada ou com o mesmo hash do plano não conta como defasada", () => {
    assert.equal(staleMarkOf({ hash: "H", stale: { a: { hash: "H" } } }, "a"), null);
    assert.equal(staleMarkOf({ hash: "H", stale: { a: { hash: "" } } }, "a"), null);
    assert.equal(staleMarkOf({ hash: "H", stale: { a: {} as never } }, "a"), null);
    assert.equal(staleMarkOf({ hash: "H" }, "a"), null);
    assert.deepEqual(staleMarkOf({ hash: "H", stale: { a: { hash: "X" } } }, "a"), { hash: "X" });
  });

  it("a saída documentada do srt --from-final (refazer o build --seq youtube) é a que o build aceita", () => {
    const hint = exportSrtRefusalHint("261112", "Final/horizontal.mp4", "roteiro");
    assert.match(hint, /refazer o build --seq youtube/);
  });

  for (const seq of ["youtube", "guia"]) {
    it(`build --seq ${seq} com entradas novas não recusa mais pelo hash (#12902 → #12968)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "plan-seq-12968-"));
      try {
        writeFileSync(join(dir, "blocks.json"), JSON.stringify({ edition: "261112", blocks: { titulo: [{ text: "Título novo" }] } }));
        writeFileSync(join(dir, "source.json"), "{}");
        const planText = JSON.stringify({ hash: "anterior", plans: [{ spec: { target: "youtube", name: "Horizontal_V2", width: 1920, height: 1080 }, script: "Título anterior" }] });
        writeFileSync(join(dir, "plan.json"), planText);
        let err: Error | null = null;
        try {
          await main(["build", "261112", "--seq", seq, "--state-dir", dir, "--work-dir", dir, "--out-dir", dir, "--no-drive-api", "--drive-root", dir]);
        } catch (e) {
          err = e as Error;
        }
        // O fixture não tem bruto: o build para adiante, mas nunca na recusa do hash.
        assert.doesNotMatch(err?.message ?? "", /as entradas mudaram/);
        assert.equal(readFileSync(join(dir, "plan.json"), "utf8"), planText, "o fixture falha antes de gravar o plano");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("#12969: limiares do verify-xml", () => {
  it("a palavra esticada usa o limiar fixo do review/preview (-40 dB), não o adaptativo", () => {
    assert.equal(REVIEW_SILENCE_FILTER, "silencedetect=noise=-40dB:d=0.08");
    const src = readFileSync(new URL("../scripts/video-montagem.ts", import.meta.url), "utf8");
    const start = src.indexOf("function cmdVerifyXml(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    assert.ok(start > 0 && body.includes("stretchedWordFindings(heard, xmlSilences)"), "cmdVerifyXml com a checagem da palavra esticada");
    assert.match(body, /const xmlSilences = parseSilenceDetect\(run\("ffmpeg", \[[^\]]*REVIEW_SILENCE_FILTER/);
    assert.doesNotMatch(body, /silencedetect=noise=\$\{/, "nenhum silencedetect com limiar variável no verify-xml");
  });

  it("as bordas usam o noiseDb do silences.meta.json (o do refino do build), sem remedir", () => {
    assert.deepEqual(verifyXmlEdgeThreshold({ noiseDb: -33, how: "floor", floorDb: -39 }), { thresholdDb: -33, floorDb: -39, from: "silences.meta.json", warning: null });
    assert.equal(verifyXmlEdgeThreshold({ noiseDb: -28, how: "override" }).warning, null, "--silence-db não pede piso");
    assert.equal(verifyXmlEdgeThreshold({ noiseDb: -40, how: "relative", floorDb: null }).warning, null, "piso medido e indisponível ainda é meta do #12903");
  });

  it("meta anterior ao #12903 segue o limiar do build e avisa para refazer o transcribe", () => {
    const r = verifyXmlEdgeThreshold({ noiseDb: -45, how: "relative" });
    assert.equal(r.thresholdDb, -45);
    assert.match(r.warning ?? "", /anterior ao #12903.*rode transcribe e build/);
  });

  it("sem meta, o padrão do build", () => {
    const r = verifyXmlEdgeThreshold(null);
    assert.equal(r.thresholdDb, SILENCE_DETECT.noiseDb);
    assert.match(r.warning ?? "", /sem silences.meta.json/);
  });
});
