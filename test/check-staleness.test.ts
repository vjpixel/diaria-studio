import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isStale,
  lagMinutes,
  evaluateStaleness,
  STAGE_CHECKS,
} from "../scripts/check-staleness.ts";

describe("isStale (#120)", () => {
  it("detecta upstream mais novo que downstream com gap grande", () => {
    const downstream = Date.parse("2026-04-24T19:33:34Z");
    const upstream = Date.parse("2026-04-24T22:13:13Z");
    assert.equal(isStale(downstream, upstream), true);
  });

  it("não dispara quando downstream é mais novo (caso normal)", () => {
    const downstream = Date.parse("2026-04-24T22:00:00Z");
    const upstream = Date.parse("2026-04-24T19:00:00Z");
    assert.equal(isStale(downstream, upstream), false);
  });

  it("não dispara em diferença <= tolerance (default 1s)", () => {
    const t = Date.parse("2026-04-24T20:00:00Z");
    assert.equal(isStale(t, t + 500), false);
    assert.equal(isStale(t, t + 1000), false);
    assert.equal(isStale(t, t + 1001), true);
  });

  it("tolerance customizada (5s pra clock skew)", () => {
    const t = Date.parse("2026-04-24T20:00:00Z");
    assert.equal(isStale(t, t + 4000, 5000), false);
    assert.equal(isStale(t, t + 6000, 5000), true);
  });

  it("timestamps idênticos não disparam", () => {
    const t = Date.parse("2026-04-24T20:00:00Z");
    assert.equal(isStale(t, t), false);
  });
});

describe("lagMinutes", () => {
  it("calcula minutos arredondados", () => {
    const d = Date.parse("2026-04-24T19:33:34Z");
    const u = Date.parse("2026-04-24T22:13:13Z");
    assert.equal(lagMinutes(d, u), 160); // ~159.65 → 160
  });

  it("zero quando iguais", () => {
    const t = Date.parse("2026-04-24T20:00:00Z");
    assert.equal(lagMinutes(t, t), 0);
  });
});

describe("evaluateStaleness — orchestration (#120)", () => {
  function mkGetter(mtimes: Record<string, number | null>) {
    return (path: string) => mtimes[path] ?? null;
  }

  it("Stage 6: 03-social.md mais antigo que 02-reviewed.md → flag", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T19:33:34Z"),
      "02-reviewed.md": Date.parse("2026-04-24T22:13:13Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    const social = stale.find((s) => s.downstream === "03-social.md");
    assert.ok(social);
    assert.equal(social!.upstream, "02-reviewed.md");
    assert.equal(social!.lag_minutes, 160);
  });

  it("#1710: Stage 6 imagem 04-d1-2x1 mais antiga que SEU PROMPT também flag", () => {
    const get = mkGetter({
      "04-d1-2x1.jpg": Date.parse("2026-04-24T18:00:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T22:00:00Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    const img = stale.find((s) => s.downstream === "04-d1-2x1.jpg");
    assert.ok(img);
    assert.equal(img!.upstream, "_internal/02-d1-prompt.md");
  });

  it("#1710: imagem mais nova que o PROMPT mas mais velha que 02-reviewed → NÃO stale", () => {
    // O FP do #1710: editor ajusta texto no 02-reviewed pós-imagem (ou sync pull
    // toca o mtime). A imagem deriva do prompt, não do reviewed — não é stale.
    const get = mkGetter({
      "04-d1-2x1.jpg": Date.parse("2026-04-24T20:00:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T19:00:00Z"), // prompt + velho que img
      "02-reviewed.md": Date.parse("2026-04-24T22:00:00Z"), // reviewed editado DEPOIS
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.deepEqual(stale.filter((s) => s.downstream.startsWith("04-d")), []);
  });

  it("Stage 6 limpo: imagens depois dos prompts + social depois do reviewed", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T22:30:00Z"),
      "02-reviewed.md": Date.parse("2026-04-24T22:13:13Z"),
      "04-d1-2x1.jpg": Date.parse("2026-04-24T22:35:00Z"),
      "04-d1-1x1.jpg": Date.parse("2026-04-24T22:35:00Z"),
      "04-d2-1x1.jpg": Date.parse("2026-04-24T22:36:00Z"),
      "04-d3-1x1.jpg": Date.parse("2026-04-24T22:37:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T22:13:13Z"),
      "_internal/02-d2-prompt.md": Date.parse("2026-04-24T22:13:13Z"),
      "_internal/02-d3-prompt.md": Date.parse("2026-04-24T22:13:13Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.deepEqual(stale, []);
  });

  it("downstream ausente: skip silencioso (não trava)", () => {
    const get = mkGetter({
      "02-reviewed.md": Date.parse("2026-04-24T22:00:00Z"),
      // 03-social.md, 04-*.jpg ausentes — Stage 6 nunca rodou
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.deepEqual(stale, []);
  });

  it("upstream ausente: skip silencioso (não trava)", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T22:00:00Z"),
      // 02-reviewed.md ausente — situação anômala, mas não trava
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.deepEqual(stale, []);
  });

  it("#1413/#1710: Stage 4 checa imagem vs prompt + 03-social.md vs 02-reviewed", () => {
    const get = mkGetter({
      "04-d1-2x1.jpg": Date.parse("2026-04-24T19:00:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T22:00:00Z"), // imagem stale vs prompt
      "02-reviewed.md": Date.parse("2026-04-24T22:00:00Z"),
      "03-social.md": Date.parse("2026-04-24T19:00:00Z"), // stale vs reviewed (#1413)
    });
    const stale = evaluateStaleness(STAGE_CHECKS["4"], get);
    // Esperado: 04-d1-2x1.jpg (stale vs prompt) + 03-social.md (stale vs reviewed) = 2
    assert.equal(stale.length, 2);
    const downstreams = stale.map((s) => s.downstream);
    assert.ok(downstreams.includes("04-d1-2x1.jpg"));
    assert.ok(downstreams.includes("03-social.md"));
    assert.equal(stale.find((s) => s.downstream === "04-d1-2x1.jpg")!.upstream, "_internal/02-d1-prompt.md");
  });

  it("Stage não-mapeado: vazio", () => {
    const get = mkGetter({});
    const stale = evaluateStaleness(STAGE_CHECKS["99"] ?? [], get);
    assert.deepEqual(stale, []);
  });

  it("retorna múltiplas entries quando vários downstream estão stale", () => {
    const get = mkGetter({
      "02-reviewed.md": Date.parse("2026-04-24T22:00:00Z"),
      "03-social.md": Date.parse("2026-04-24T19:00:00Z"), // stale vs reviewed
      "04-d1-2x1.jpg": Date.parse("2026-04-24T19:00:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T22:00:00Z"), // d1 stale vs prompt
      "04-d2-1x1.jpg": Date.parse("2026-04-24T19:00:00Z"),
      "_internal/02-d2-prompt.md": Date.parse("2026-04-24T22:00:00Z"), // d2 stale vs prompt
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.equal(stale.length, 3); // 03-social + 04-d1-2x1 + 04-d2-1x1
  });

  it("formato ISO timestamp no output", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T19:33:34Z"),
      "02-reviewed.md": Date.parse("2026-04-24T22:13:13Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.match(stale[0].downstream_mtime, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(stale[0].upstream_mtime, /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("STAGE_CHECKS config — fixture do desenho (#120)", () => {
  it("Stage 6 cobre 03-social.md + 4 imagens", () => {
    const downstreams = STAGE_CHECKS["6"].map((c) => c.downstream);
    assert.ok(downstreams.includes("03-social.md"));
    assert.ok(downstreams.includes("04-d1-2x1.jpg"));
    assert.ok(downstreams.includes("04-d1-1x1.jpg"));
    assert.ok(downstreams.includes("04-d2-1x1.jpg"));
    assert.ok(downstreams.includes("04-d3-1x1.jpg"));
  });

  it("#1710: 03-social → 02-reviewed; imagens → seu prompt (não reviewed)", () => {
    const byDown = Object.fromEntries(
      STAGE_CHECKS["6"].map((c) => [c.downstream, c.upstreams]),
    );
    assert.deepEqual(byDown["03-social.md"], ["02-reviewed.md"]);
    assert.deepEqual(byDown["04-d1-2x1.jpg"], ["_internal/02-d1-prompt.md"]);
    assert.deepEqual(byDown["04-d1-1x1.jpg"], ["_internal/02-d1-prompt.md"]);
    assert.deepEqual(byDown["04-d2-1x1.jpg"], ["_internal/02-d2-prompt.md"]);
    assert.deepEqual(byDown["04-d3-1x1.jpg"], ["_internal/02-d3-prompt.md"]);
  });

  it("#1413: Stage 4 cobre imagens + 03-social.md", () => {
    const downstreams = STAGE_CHECKS["4"].map((c) => c.downstream);
    assert.ok(downstreams.includes("03-social.md"), "social staleness deve estar coberto em S4");
    assert.ok(downstreams.includes("04-d1-2x1.jpg"));
    assert.ok(downstreams.includes("04-d2-1x1.jpg"));
  });

  it("Stage 3 checa só 03-social.md", () => {
    assert.equal(STAGE_CHECKS["3"].length, 1);
    assert.equal(STAGE_CHECKS["3"][0].downstream, "03-social.md");
  });
});
