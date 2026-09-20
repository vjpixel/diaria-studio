import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JEV_FEATURE_NAMES,
  JEV_PROFILE_ENV,
  effectiveJevFeatures,
  effectiveJevShadow,
  isJevFeatureOn,
  isJevProfileAll,
  readJevFeatureFlags,
} from "../scripts/lib/jev-profile.ts";
import { isActorBrazilEnabled } from "../scripts/lib/jev-actor-brazil.ts";
import { readDedupGrayzoneMode, buildGrayZoneResolver } from "../scripts/lib/dedup-grayzone-jev.ts";
import { buildJevProfile } from "../scripts/write-jev-profile.ts";
import { dedup } from "../scripts/dedup.ts";
import { buildAbReport, computeMetrics, renderAbReport, type EditionRaw, type Tri } from "../scripts/lib/jev-ab-report.ts";

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
  it("effectiveJevShadow: env=all força false; senão config, default true", () => {
    assert.equal(effectiveJevShadow(true, { [JEV_PROFILE_ENV]: "all" }), false);
    assert.equal(effectiveJevShadow(undefined, {}), true);
    assert.equal(effectiveJevShadow(false, {}), false);
  });
  it("config JSON 'null' vira {} (sem lançar) e config ilegível avisa 1x", () => {
    const nul = join(dir, "null.json");
    writeFileSync(nul, "null");
    assert.deepEqual(readJevFeatureFlags(nul), {});
    assert.equal(readDedupGrayzoneMode(nul), "off");
    const bad = join(dir, "bad2.json");
    writeFileSync(bad, "{oops");
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => void warns.push(String(m));
    try {
      readJevFeatureFlags(bad);
      readJevFeatureFlags(bad);
      readDedupGrayzoneMode(bad);
    } finally {
      console.warn = orig;
    }
    assert.equal(warns.length, 1);
  });
  it("JEV_FEATURE_NAMES espelha as chaves de jev.features do platform.config.json", () => {
    const real = JSON.parse(readFileSync(join(import.meta.dirname, "..", "platform.config.json"), "utf8"));
    assert.deepEqual([...JEV_FEATURE_NAMES].sort(), Object.keys(real.jev.features).sort());
  });
});

describe("features consomem a função única", () => {
  it("dedup_grayzone: env ausente = off/shadow como antes; shadow:false sem env segue active", () => {
    assert.equal(readDedupGrayzoneMode(cfg({ dedup_grayzone: false })), "off");
    assert.equal(readDedupGrayzoneMode(cfg({ dedup_grayzone: true })), "shadow");
    assert.equal(readDedupGrayzoneMode(cfg({ dedup_grayzone: true }, false)), "active");
  });
  it("dedup_grayzone: env=all liga e força active, mesmo com shadow:true/config ausente/quebrado", () => {
    process.env[JEV_PROFILE_ENV] = "all";
    assert.equal(readDedupGrayzoneMode(cfg({ dedup_grayzone: false }, true)), "active");
    assert.equal(readDedupGrayzoneMode(join(dir, "ausente.json")), "active");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{oops");
    assert.equal(readDedupGrayzoneMode(bad), "active");
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
  it("registra as features efetivas, shadow efetivo e o timestamp", () => {
    const p = cfg({ dedup_grayzone: false, actor_brazil: false });
    const out = buildJevProfile(p, { [JEV_PROFILE_ENV]: "all" }, new Date("2026-09-20T12:00:00Z"));
    assert.deepEqual(out, {
      profile: "all",
      features: ["dedup_grayzone", "actor_brazil"],
      shadow: false,
      written_at: "2026-09-20T12:00:00.000Z",
    });
    assert.equal(buildJevProfile(p, {}).profile, "config");
    assert.equal(buildJevProfile(p, {}).shadow, true);
  });
  it("CLI sai não-zero e NÃO grava marcador sem DIARIA_JEV_PROFILE exatamente 'all'", () => {
    for (const v of [undefined, "ALL", "none"]) {
      const env = { ...process.env };
      delete env[JEV_PROFILE_ENV];
      if (v) env[JEV_PROFILE_ENV] = v;
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/write-jev-profile.ts", "--edition", "260101"], {
        cwd: join(import.meta.dirname, ".."),
        env,
        encoding: "utf8",
      });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /NÃO gravado/);
    }
  });
});

describe("regressão #8421: flags off + env ausente ⇒ dedup idêntico (config sintético)", () => {
  const PAST = "OpenAI lança novo modelo de raciocínio para desenvolvedores";
  const titles = [
    "OpenAI lança novo modelo de raciocínio para empresas",
    "Modelo de raciocínio da OpenAI chega aos desenvolvedores agora",
    "Google apresenta ferramenta de agentes para empresas e desenvolvedores",
  ];
  const arts = () => titles.map((t, i) => ({ url: `https://ex.com/${i}`, title: t, summary: "resumo longo o bastante para passar do filtro de placeholder", source: "Ex" }));
  const run = (gz?: Awaited<ReturnType<typeof buildGrayZoneResolver>>) =>
    dedup(arts(), new Set(), 0.85, [], 0.7, [PAST], 0.6, undefined, 0.55, new Set(), [], gz);
  const stubDifferent = (async (items: { id: string }[]) => ({
    results: items.map((it) => ({ id: it.id, answers: [{ id: "same_story", type: "noul", probability: 0.1, confidence: 0.95 }] })),
    errors: new Map(),
  })) as never;
  const write = (o: unknown) => writeFileSync(join(dir, "platform.config.json"), JSON.stringify(o));

  it("todas as features off, env ausente: resolver ausente == baseline", async () => {
    const baseline = JSON.stringify(run());
    write({ jev: { shadow: true, features: { dedup_grayzone: false, actor_brazil: false } } });
    const gz = await buildGrayZoneResolver(arts(), [PAST], { rootDir: dir, apiKey: "k", askBatchImpl: stubDifferent });
    assert.equal(gz, undefined);
    assert.equal(JSON.stringify(run(gz)), baseline);
  });
  it("env ausente + flag on em shadow: Jev consultado mas resultado byte a byte igual", async () => {
    const baseline = JSON.stringify(run());
    write({ jev: { shadow: true, features: { dedup_grayzone: true } } });
    const gz = await buildGrayZoneResolver(arts(), [PAST], { rootDir: dir, apiKey: "k", askBatchImpl: stubDifferent });
    assert.equal(gz?.mode, "shadow");
    assert.equal(JSON.stringify(run(gz)), baseline);
  });
  it("env=all força active: com Jev stubado (não é a mesma história) a decisão MUDA", async () => {
    assert.ok(run().removed.some((r) => r.title === titles[0]));
    process.env[JEV_PROFILE_ENV] = "all";
    write({ jev: { shadow: true, features: { dedup_grayzone: false } } });
    const gz = await buildGrayZoneResolver(arts(), [PAST], { rootDir: dir, apiKey: "k", askBatchImpl: stubDifferent });
    assert.equal(gz?.mode, "active");
    assert.ok(run(gz).kept.some((k) => k.title === titles[0]), "Jev ativo devia manter o par que a heurística removia");
  });
  it("config shadow:false + env ausente segue active", async () => {
    write({ jev: { shadow: false, features: { dedup_grayzone: true } } });
    const gz = await buildGrayZoneResolver(arts(), [PAST], { rootDir: dir, apiKey: "k", askBatchImpl: stubDifferent });
    assert.equal(gz?.mode, "active");
  });
  it("env=all sem chave de API (fail-soft) == baseline", async () => {
    const baseline = JSON.stringify(run());
    process.env[JEV_PROFILE_ENV] = "all";
    const gz = await buildGrayZoneResolver(arts(), [PAST], { rootDir: dir, apiKey: "" });
    assert.equal(JSON.stringify(run(gz)), baseline);
  });
});

describe("platform.config.json commitado (#8421)", () => {
  it("todas as jev.features.* commitadas são false e jev.shadow é true — mude só com decisão explícita do editor", () => {
    const real = join(import.meta.dirname, "..", "platform.config.json");
    const j = JSON.parse(readFileSync(real, "utf8")).jev;
    assert.ok(Object.values(j.features).every((v) => v === false), "jev.features.* commitadas devem ser false (o perfil Jev liga via env)");
    assert.equal(j.shadow, true);
    assert.deepEqual(effectiveJevFeatures(real, {}), []);
  });
});

describe("jev-ab-report", () => {
  const ok = <T,>(value: T): Tri<T> => ({ state: "ok", value });
  const absent: Tri<never> = { state: "absent" };
  const corrupt: Tri<never> = { state: "corrupt" };
  const rows = [
    { stage: 1, duration_ms: 600000, pipeline_ms: 600000, tokens_in: 100, tokens_out: 50 },
    { stage: 4, duration_ms: 900000, pipeline_ms: 300000, tokens_in: 10, tokens_out: 5 },
  ];
  const profB = { profile: "all", features: ["dedup_grayzone"], shadow: false, written_at: "2026-09-20T00:00:00Z" };
  const ed = (edition: string, jev: boolean, over: Partial<EditionRaw> = {}): EditionRaw => ({
    edition,
    exists: true,
    profile: jev ? ok(profB) : absent,
    editorRequests: ok({ rows: [{ stage: 4 }, { stage: 4 }, { stage: 1 }], invalidLines: 0 }),
    stageRows: ok(rows),
    dedupArtifact: jev ? ok({ profile_env: "all", shadow: false, records: [] }) : absent,
    ...over,
  });
  it("calcula métricas por edição", () => {
    const { m, warnings } = computeMetrics(ed("260901", false));
    assert.equal(m.arm, "A");
    assert.equal(m.gate4Corrections, 2);
    assert.equal(m.gateWaitMinutes, 10);
    assert.equal(m.tokens, 165);
    assert.equal(m.stage1WallMinutes, 10);
    assert.deepEqual(warnings, []);
  });
  it("P1-1: perfil corrompido = braço desconhecido, edição excluída com warning (nunca A)", () => {
    const r = buildAbReport([ed("1", true, { profile: corrupt })]);
    assert.equal(r.arms.A.editions, 0);
    assert.deepEqual(r.excluded, ["1"]);
    assert.ok(r.warnings.some((w) => w.includes(".jev-profile.json corrompido")));
  });
  it("P1-1: stage-status e editor-requests corrompidos têm warning específico", () => {
    const { warnings } = computeMetrics(ed("2", false, { stageRows: corrupt, editorRequests: corrupt }));
    assert.ok(warnings.some((w) => w.includes("stage-status.json ilegível/corrompido")));
    assert.ok(warnings.some((w) => w.includes("editor-requests.jsonl ilegível")));
  });
  it("P1-2: braço B exige profile 'all' E features não vazio", () => {
    assert.equal(computeMetrics(ed("3", true, { profile: ok({ profile: "config", features: ["x"] }) })).m.arm, "unknown");
    assert.equal(computeMetrics(ed("3", true, { profile: ok({ profile: "all", features: [] }) })).m.arm, "unknown");
    assert.equal(computeMetrics(ed("3", true, { profile: ok(null) })).m.arm, "unknown");
    assert.equal(computeMetrics(ed("3", true)).m.arm, "B");
  });
  it("P1-3: edição inexistente excluída; ids duplicados ignorados; amostra conta só edições com dado", () => {
    const r = buildAbReport([
      ed("1", false),
      ed("1", false),
      { ...ed("9", false), exists: false },
      ed("4", true, { editorRequests: absent, stageRows: absent }),
    ]);
    assert.equal(r.arms.A.editions, 1);
    assert.equal(r.arms.B.editions, 0);
    assert.ok(r.excluded.includes("9") && r.excluded.includes("4"));
    assert.ok(r.warnings.some((w) => w.includes("id duplicado")));
    assert.ok(r.warnings.some((w) => w.includes("A=1, B=0")));
    assert.equal(r.usable, 1);
  });
  it("P2: somas parciais, clamp de negativo, shapes inválidos, JSONL inválido", () => {
    const partial = [{ stage: 1, duration_ms: 100, pipeline_ms: 200, tokens_in: 5 }, { stage: 2 }, null, "x", { stage: "3", tokens_in: 999 }];
    const { m, warnings } = computeMetrics(
      ed("5", false, { stageRows: ok(partial), editorRequests: ok({ rows: [{ stage: 4 }, null, 7], invalidLines: 2 }) }),
    );
    assert.equal(m.tokens, 5);
    assert.equal(m.gateWaitMinutes, 0);
    assert.equal(m.gate4Corrections, 1);
    assert.ok(warnings.some((w) => w.includes("tokens parciais (1/2")));
    assert.ok(warnings.some((w) => w.includes("espera de gate parcial (1/2")));
    assert.ok(warnings.some((w) => w.includes("espera de gate = 0")));
    assert.ok(warnings.some((w) => w.includes("2 linha(s) inválida(s)")));
    assert.ok(computeMetrics(ed("6", false, { stageRows: ok({ not: "array" }) })).warnings.some((w) => w.includes("formato inválido")));
  });
  it("wall-clock: fallback duration_ms avisa que inclui espera de gate", () => {
    const { m, warnings } = computeMetrics(ed("7", false, { stageRows: ok([{ stage: 1, duration_ms: 120000 }]) }));
    assert.equal(m.stage1WallMinutes, 2);
    assert.ok(warnings.some((w) => w.includes("inclui espera de gate")));
  });
  it("B: avisa artefato sem env, com shadow, ausente; shadow no marcador; marcador anterior ao Stage 1", () => {
    const w1 = computeMetrics(ed("8", true, { dedupArtifact: ok({ profile_env: null, shadow: true }) })).warnings;
    assert.ok(w1.some((w) => w.includes("não registra profile_env=all")));
    assert.ok(w1.some((w) => w.includes("mostra shadow")));
    assert.ok(computeMetrics(ed("8", true, { dedupArtifact: absent })).warnings.some((w) => w.includes("sem dedup-grayzone-jev.json")));
    assert.ok(computeMetrics(ed("8", true, { profile: ok({ ...profB, shadow: true }) })).warnings.some((w) => w.includes("sem decisão real")));
    const late = computeMetrics(ed("8", true, { stageRows: ok([{ stage: 1, pipeline_ms: 1, start: "2026-09-21T00:00:00Z" }]) })).warnings;
    assert.ok(late.some((w) => w.includes("anterior ao início do Stage 1")));
  });
  it("relatório: rótulo 'espera de gate', aviso de que B decide e n/d", () => {
    const txt = renderAbReport(buildAbReport([ed("1", false), ed("3", true, { stageRows: absent })]));
    assert.match(txt, /Espera de gate/);
    assert.match(txt, /n\/d/);
    assert.match(txt, /DECIDE de fato/);
  });
});

describe("skill /diaria-edicao-jev", () => {
  const skill = readFileSync(join(import.meta.dirname, "..", ".claude/skills/diaria-edicao-jev/SKILL.md"), "utf8");
  it("referencia o playbook, não o duplica, exporta o perfil, trata falha como não-B e não encadeia Stage 5", () => {
    assert.match(skill, /^name: diaria-edicao-jev$/m);
    assert.ok(skill.includes(".claude/skills/diaria-edicao/SKILL.md"));
    assert.ok(skill.includes("DIARIA_JEV_PROFILE=all"));
    assert.ok(skill.includes("write-jev-profile.ts"));
    assert.ok(skill.includes("NÃO vale como braço B"));
    assert.match(skill, /Não encadeia para o Stage 5/);
    assert.ok(skill.split("\n").length < 60);
    assert.ok(existsSync(join(import.meta.dirname, "..", "scripts/write-jev-profile.ts")));
  });
});
