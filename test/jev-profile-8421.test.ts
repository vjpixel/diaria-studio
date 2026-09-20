import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JEV_PROFILE_ENV,
  effectiveJevFeatures,
  isJevFeatureOn,
  isJevProfileAll,
} from "../scripts/lib/jev-profile.ts";
import { isActorBrazilEnabled } from "../scripts/lib/jev-actor-brazil.ts";
import { readDedupGrayzoneMode, buildGrayZoneResolver } from "../scripts/lib/dedup-grayzone-jev.ts";
import { buildJevProfile } from "../scripts/write-jev-profile.ts";
import { dedup } from "../scripts/dedup.ts";
import { categorizeArticles } from "../scripts/categorize.ts";
import { assemble } from "../scripts/assemble-scored.ts";
import { buildAbReport, computeMetrics, renderAbReport, type EditionRaw } from "../scripts/lib/jev-ab-report.ts";

let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevp-"));
  saved = process.env[JEV_PROFILE_ENV];
  delete process.env[JEV_PROFILE_ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[JEV_PROFILE_ENV];
  else process.env[JEV_PROFILE_ENV] = saved;
  rmSync(dir, { recursive: true, force: true });
});
const cfg = (features: Record<string, boolean>, shadow?: boolean) => {
  const p = join(dir, "platform.config.json");
  writeFileSync(p, JSON.stringify({ jev: { ...(shadow === undefined ? {} : { shadow }), features } }));
  return p;
};

describe("jev-profile: flag efetiva", () => {
  it("env ausente: só o config decide", () => {
    assert.equal(isJevFeatureOn(true, {}), true);
    assert.equal(isJevFeatureOn(false, {}), false);
    assert.equal(isJevFeatureOn(undefined, {}), false);
  });
  it("DIARIA_JEV_PROFILE=all liga; outro valor não; nunca desliga flag true", () => {
    assert.equal(isJevFeatureOn(false, { [JEV_PROFILE_ENV]: "all" }), true);
    assert.equal(isJevFeatureOn(false, { [JEV_PROFILE_ENV]: "none" }), false);
    assert.equal(isJevFeatureOn(true, { [JEV_PROFILE_ENV]: "none" }), true);
    assert.equal(isJevProfileAll({ [JEV_PROFILE_ENV]: "all" }), true);
  });
  it("effectiveJevFeatures lista as ligadas; config ausente/quebrado é fail-soft", () => {
    assert.deepEqual(effectiveJevFeatures(cfg({ dedup_grayzone: true, actor_brazil: false }), {}), ["dedup_grayzone"]);
    assert.deepEqual(effectiveJevFeatures(join(dir, "nope.json"), {}), []);
    assert.deepEqual(effectiveJevFeatures(join(dir, "nope.json"), { [JEV_PROFILE_ENV]: "all" }), ["dedup_grayzone", "actor_brazil"]);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{oops");
    assert.deepEqual(effectiveJevFeatures(bad, {}), []);
  });
});

describe("features consomem a função única", () => {
  it("dedup_grayzone: env=all liga em shadow; shadow:false vira active; env ausente = off", () => {
    const off = cfg({ dedup_grayzone: false });
    assert.equal(readDedupGrayzoneMode(off), "off");
    process.env[JEV_PROFILE_ENV] = "all";
    assert.equal(readDedupGrayzoneMode(off), "shadow");
    assert.equal(readDedupGrayzoneMode(join(dir, "ausente.json")), "shadow");
    assert.equal(readDedupGrayzoneMode(cfg({ dedup_grayzone: false }, false)), "active");
  });
  it("actor_brazil: env=all liga; legado JEV_FORCE_ACTOR_BRAZIL preservado", () => {
    const off = cfg({ actor_brazil: false });
    assert.equal(isActorBrazilEnabled(off), false);
    process.env[JEV_PROFILE_ENV] = "all";
    assert.equal(isActorBrazilEnabled(off), true);
    delete process.env[JEV_PROFILE_ENV];
    process.env.JEV_FORCE_ACTOR_BRAZIL = "1";
    try {
      assert.equal(isActorBrazilEnabled(off), true);
    } finally {
      delete process.env.JEV_FORCE_ACTOR_BRAZIL;
    }
  });
});

describe("write-jev-profile", () => {
  it("registra as features efetivas e o timestamp", () => {
    const p = cfg({ dedup_grayzone: false, actor_brazil: false });
    const out = buildJevProfile(p, { [JEV_PROFILE_ENV]: "all" }, new Date("2026-09-20T12:00:00Z"));
    assert.deepEqual(out, {
      profile: "all",
      features: ["dedup_grayzone", "actor_brazil"],
      written_at: "2026-09-20T12:00:00.000Z",
    });
    assert.equal(buildJevProfile(p, {}).profile, "config");
  });
});

describe("regressão #8421: todas as jev.features.* off + env ausente ⇒ saída idêntica", () => {
  const PAST = "OpenAI lança novo modelo de raciocínio para desenvolvedores";
  const titles = [
    "OpenAI lança novo modelo de raciocínio para empresas",
    "Modelo de raciocínio da OpenAI chega aos desenvolvedores agora",
    "Google apresenta ferramenta de agentes para empresas e desenvolvedores",
  ];
  const arts = () => titles.map((t, i) => ({ url: `https://ex.com/${i}`, title: t, summary: "resumo longo o bastante para passar do filtro de placeholder", source: "Ex" }));
  const run = (gz?: Awaited<ReturnType<typeof buildGrayZoneResolver>>) =>
    dedup(arts(), new Set(), 0.85, [], 0.7, [PAST], 0.6, undefined, 0.55, new Set(), [], gz);

  it("dedup: com resolver do perfil (flags off, sem env) == sem resolver", async () => {
    const baseline = JSON.stringify(run());
    const gz = await buildGrayZoneResolver(arts(), [PAST], { rootDir: dir, apiKey: "k" });
    // rootDir sem platform.config.json → off
    assert.equal(JSON.stringify(run(gz)), baseline);
    const real = join(import.meta.dirname, "..", "platform.config.json");
    const feats = JSON.parse(readFileSync(real, "utf8")).jev.features as Record<string, unknown>;
    assert.ok(Object.values(feats).every((v) => v === false), "todas as jev.features.* commitadas devem ser false");
    assert.deepEqual(effectiveJevFeatures(real, {}), []);
  });
  it("dedup: env=all sem TYPESAFE_API_KEY (fail-soft) == baseline", async () => {
    const baseline = JSON.stringify(run());
    process.env[JEV_PROFILE_ENV] = "all";
    const gz = await buildGrayZoneResolver(arts(), [PAST], { rootDir: dir, apiKey: "" });
    assert.equal(JSON.stringify(run(gz)), baseline);
  });
  it("categorizeArticles e assemble não dependem do perfil", () => {
    const a = arts();
    const before = JSON.stringify(categorizeArticles(structuredClone(a)));
    process.env[JEV_PROFILE_ENV] = "all";
    assert.equal(JSON.stringify(categorizeArticles(structuredClone(a))), before);
    const sel = { highlights: [{ url: "u", rank: 9 }], runners_up: [] } as never;
    const all = { all_scored: [] } as never;
    const x = JSON.stringify(assemble(sel, all));
    delete process.env[JEV_PROFILE_ENV];
    assert.equal(JSON.stringify(assemble(sel, all)), x);
  });
});

describe("jev-ab-report", () => {
  const rows = [
    { stage: 1, duration_ms: 600000, pipeline_ms: 600000, tokens_in: 100, tokens_out: 50 },
    { stage: 4, duration_ms: 900000, pipeline_ms: 300000, tokens_in: 10, tokens_out: 5 },
  ];
  const ed = (edition: string, jev: boolean, over: Partial<EditionRaw> = {}): EditionRaw => ({
    edition,
    profile: jev ? { features: ["dedup_grayzone"] } : null,
    editorRequests: [{ stage: 4 }, { stage: 4 }, { stage: 1 }],
    stageRows: rows,
    ...over,
  });
  it("calcula métricas por edição", () => {
    const { m, warnings } = computeMetrics(ed("260901", false));
    assert.equal(m.arm, "A");
    assert.equal(m.gate4Corrections, 2);
    assert.equal(m.touchMinutes, 10);
    assert.equal(m.tokens, 165);
    assert.equal(m.stage1WallMinutes, 10);
    assert.deepEqual(warnings, []);
  });
  it("métrica ausente vira null + aviso, sem inventar dado", () => {
    const { m, warnings } = computeMetrics(ed("260902", true, { editorRequests: null, stageRows: null }));
    assert.equal(m.arm, "B");
    assert.equal(m.gate4Corrections, null);
    assert.equal(m.touchMinutes, null);
    assert.equal(m.tokens, null);
    assert.equal(m.stage1WallMinutes, null);
    assert.equal(warnings.length, 4);
  });
  it("agrega por braço, ignora null na média e avisa amostra pequena", () => {
    const r = buildAbReport([ed("1", false), ed("2", false, { editorRequests: [] }), ed("3", true, { stageRows: null })]);
    assert.equal(r.arms.A.editions, 2);
    assert.equal(r.arms.A.mean.gate4Corrections, 1);
    assert.equal(r.arms.B.mean.tokens, null);
    assert.equal(r.arms.B.n.gate4Corrections, 1);
    assert.ok(r.warnings.some((w) => w.includes("abaixo do critério")));
    assert.match(renderAbReport(r), /n\/d/);
  });
});

describe("skill /diaria-edicao-jev", () => {
  const skill = readFileSync(join(import.meta.dirname, "..", ".claude/skills/diaria-edicao-jev/SKILL.md"), "utf8");
  it("referencia o playbook, não o duplica, exporta o perfil e não encadeia Stage 5", () => {
    assert.match(skill, /^name: diaria-edicao-jev$/m);
    assert.ok(skill.includes(".claude/skills/diaria-edicao/SKILL.md"));
    assert.ok(skill.includes("DIARIA_JEV_PROFILE=all"));
    assert.ok(skill.includes("write-jev-profile.ts"));
    assert.match(skill, /Não encadeia para o Stage 5/);
    assert.ok(skill.split("\n").length < 60);
    assert.ok(existsSync(join(import.meta.dirname, "..", "scripts/write-jev-profile.ts")));
  });
});
