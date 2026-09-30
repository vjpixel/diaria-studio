// Regressões dos follow-ups da troca do gerador padrão pra codex (#9088):
// #9095/#9110-1 (crédito do gerador efetivo), #9094 (gemini.model com
// codex.fallback=gemini), #9110-5 (mapa único de fallback), #9097 (timeout
// mata a árvore de processos).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeImageGeneratorSidecar,
  readImageGeneratorSidecar,
  resolveEditionImageGenerator,
  imageGeneratorSidecarPath,
  MIXED_GENERATORS,
} from "../scripts/lib/shared/image-generator-sidecar.ts";
import { extractContent } from "../scripts/lib/newsletter-parse.ts";
import { renderDestaque, imageGeneratorCredit } from "../scripts/lib/newsletter-render-html.ts";
import { captionForGenerator } from "../scripts/lib/mensal/monthly-render.ts";
import { usesGeminiModel, CODEX_FALLBACK_SCRIPTS, backendNeedsEnglishPrompt } from "../scripts/lib/image-backends.ts";
import { editionFromOutDir } from "../scripts/image-generate.ts";
// @ts-expect-error — módulo .js sem tipos
import { runWithTreeKill, killProcessTree } from "../scripts/codex-image.js";

const ROOT = join(import.meta.dirname, "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

function editionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-9110-"));
  const reviewed = [1, 2, 3].flatMap((n) => [
    `**DESTAQUE ${n} | RADAR**`, "",
    `**[Título ${n}](https://example.com/${n})**`, "",
    `Corpo ${n} com contexto suficiente.`, "",
    `Por que isso importa: razão ${n}.`, "",
    ...(n < 3 ? ["---", ""] : []),
  ]).join("\n");
  writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
  writeFileSync(join(dir, "01-eia.md"), "É IA?\n\nCrédito [link](https://x.com).\n", "utf8");
  return dir;
}

describe("#9095 crédito reflete o gerador efetivo", () => {
  it("sidecar: grava e lê o backend efetivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-"));
    try {
      assert.equal(readImageGeneratorSidecar(dir, "d1"), null);
      writeImageGeneratorSidecar(dir, "d1", { generator: "gemini", configured: "codex", fallback: true });
      assert.equal(readImageGeneratorSidecar(dir, "d1"), "gemini");
      const j = JSON.parse(readFileSync(imageGeneratorSidecarPath(dir, "d1"), "utf8"));
      assert.equal(j.fallback, true);
      assert.equal(j.configured, "codex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sidecar corrompido → null (cai no config), nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(imageGeneratorSidecarPath(dir, "d2"), "{nao json", "utf8");
      assert.equal(readImageGeneratorSidecar(dir, "d2"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diária E2E: fallback Gemini no D2 → legenda do D2 diz Gemini, D1 segue ChatGPT", () => {
    const dir = editionDir();
    try {
      writeImageGeneratorSidecar(dir, "d1", { generator: "codex", configured: "codex", fallback: false });
      writeImageGeneratorSidecar(dir, "d2", { generator: "gemini", configured: "codex", fallback: true });
      const content = extractContent(dir);
      const [d1, d2, d3] = content.destaques;
      assert.equal(d1.imageGenerator, "codex");
      assert.equal(d2.imageGenerator, "gemini");
      assert.equal(d3.imageGenerator, undefined, "sem sidecar → campo ausente (usa o config)");
      assert.match(renderDestaque(d2), /Criada com Gemini/);
      assert.doesNotMatch(renderDestaque(d2), /Criada com ChatGPT/);
      assert.match(renderDestaque(d1), /Criada com ChatGPT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imageGeneratorCredit: gerador efetivo tem precedência sobre o config", () => {
    assert.equal(imageGeneratorCredit("gemini"), "Criada com Gemini");
    assert.equal(imageGeneratorCredit("desconhecido"), "Criada com IA");
  });

  it("mensal: uma legenda — concorda → nomeia; diverge → genérico; sem sidecar → config", () => {
    const dir = mkdtempSync(join(tmpdir(), "mensal-"));
    try {
      assert.equal(resolveEditionImageGenerator(dir, "codex"), "codex");
      writeImageGeneratorSidecar(dir, "d1", { generator: "gemini", configured: "codex", fallback: true });
      writeImageGeneratorSidecar(dir, "d2", { generator: "gemini", configured: "codex", fallback: true });
      assert.equal(resolveEditionImageGenerator(dir, "codex"), "gemini");
      writeImageGeneratorSidecar(dir, "d3", { generator: "codex", configured: "codex", fallback: false });
      assert.equal(resolveEditionImageGenerator(dir, "codex"), MIXED_GENERATORS);
      assert.equal(captionForGenerator(MIXED_GENERATORS), "Criada com IA");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("os 4 renders mensais leem o sidecar (wiring)", () => {
    for (const f of ["scripts/publish-monthly.ts", "scripts/render-monthly-apoiadores-brevo.ts", "scripts/render-monthly-apoiadores-kit.ts", "scripts/monthly-preview-cloudflare.ts"]) {
      assert.match(src(f), /captionForGenerator\(resolveEditionImageGenerator\(monthlyDir,/, f);
    }
  });

  it("image-generate grava o sidecar no wide com o backend efetivo e loga o fallback", () => {
    const s = src("scripts/image-generate.ts");
    assert.match(s, /effectiveGenerator = fb;/);
    assert.match(s, /writeImageGeneratorSidecar\(normalizedOutDir, destaque, \{\s*generator: effectiveGenerator/);
    assert.match(s, /logEvent\(\{[\s\S]{0,200}fallback para \$\{fb\}/);
  });

  it("editionFromOutDir extrai AAMMDD (plano e aninhado) e devolve null fora do layout", () => {
    assert.equal(editionFromOutDir("data/editions/260930/"), "260930");
    assert.equal(editionFromOutDir("data/editions/2609/260930"), "260930");
    assert.equal(editionFromOutDir("data/monthly/2609-10/"), null);
  });
});

describe("#9094 gemini.model validado também como fallback do Codex", () => {
  it("usesGeminiModel", () => {
    assert.equal(usesGeminiModel({}), true);
    assert.equal(usesGeminiModel({ image_generator: "gemini" }), true);
    assert.equal(usesGeminiModel({ image_generator: "codex", codex: { fallback: "gemini" } }), true);
    assert.equal(usesGeminiModel({ image_generator: "codex" }), false);
    assert.equal(usesGeminiModel({ image_generator: "codex", codex: { fallback: "cloudflare" } }), false);
    assert.equal(usesGeminiModel({ image_generator: "cloudflare" }), false);
  });

  it("validate-gemini-config e a invariante gemini-model-valid usam o predicado", () => {
    assert.match(src("scripts/validate-gemini-config.ts"), /if \(!usesGeminiModel\(cfg\)\)/);
    assert.match(src("scripts/lib/invariant-checks/stage-0.ts"), /if \(!usesGeminiModel\(cfg\)\) return \[\]/);
  });
});

describe("#9110 item 5 mapa único de fallback", () => {
  it("eia-compose e image-generate usam CODEX_FALLBACK_SCRIPTS (sem mapa inline)", () => {
    assert.match(src("scripts/eia-compose.ts"), /CODEX_FALLBACK_SCRIPTS\[fb\]/);
    assert.doesNotMatch(src("scripts/eia-compose.ts"), /\{ gemini: "scripts\/gemini-image\.js"/);
    assert.match(src("scripts/image-generate.ts"), /CODEX_FALLBACK_SCRIPTS\[fb\]/);
    assert.equal(CODEX_FALLBACK_SCRIPTS.gemini, "gemini-image.js");
  });

  it("fallback comfyui/cloudflare precisa de prompt EN (#4620); gemini/openai não", () => {
    assert.equal(backendNeedsEnglishPrompt("comfyui"), true);
    assert.equal(backendNeedsEnglishPrompt("cloudflare"), true);
    assert.equal(backendNeedsEnglishPrompt("gemini"), false);
    assert.equal(backendNeedsEnglishPrompt("openai"), false);
    assert.match(src("scripts/eia-compose.ts"), /backendNeedsEnglishPrompt\(fb\) && sdPromptLocale !== "en"/);
  });
});

describe("#9097 timeout do codex mata a árvore", () => {
  it("killProcessTree: Windows usa taskkill /T por PID; POSIX mata o grupo", () => {
    const calls: unknown[] = [];
    killProcessTree({ pid: 42 }, { platform: "win32", execTaskkill: (pid: number) => calls.push(["taskkill", pid]) });
    assert.deepEqual(calls, [["taskkill", 42]]);
    const kills: unknown[] = [];
    killProcessTree({ pid: 43, kill: () => kills.push("child") }, { platform: "linux", killFn: (pid: number, sig: string) => kills.push([pid, sig]) });
    assert.deepEqual(kills, [[-43, "SIGKILL"], "child"]);
  });

  it("runWithTreeKill resolve no shape do spawnSync (sucesso)", async () => {
    const r = await runWithTreeKill(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "oi", timeoutMs: 10_000, env: process.env });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "oi");
  });

  it("ENOENT vira error.code=ENOENT (fallback codex.cmd depende disso)", async () => {
    const r = await runWithTreeKill("comando-que-nao-existe-9097", [], { input: "", timeoutMs: 5_000, env: process.env });
    assert.equal(r.error?.code, "ENOENT");
  });

  it("POSIX: neto que ignora SIGTERM morre no timeout (wrapper não repassa sinal)", { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "treekill-"));
    const pidFile = join(dir, "neto.pid");
    try {
      // "wrapper" que spawna um neto imune a SIGTERM e fica esperando.
      const neto = join(dir, "neto.cjs");
      writeFileSync(neto, `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
      const wrapper = join(dir, "wrapper.cjs");
      writeFileSync(wrapper, `require("child_process").spawn(process.execPath, [${JSON.stringify(neto)}], { stdio: "ignore" }); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`);
      const t0 = Date.now();
      const r = await runWithTreeKill(process.execPath, [wrapper], { input: "", timeoutMs: 1_500, env: process.env });
      assert.equal(r.error?.code, "ETIMEDOUT");
      assert.ok(Date.now() - t0 < 8_000, "timeout efetivo — não esperou o neto");
      assert.ok(existsSync(pidFile), "neto chegou a subir");
      const netoPid = Number(readFileSync(pidFile, "utf8"));
      await new Promise((r2) => setTimeout(r2, 300));
      let alive = true;
      try { process.kill(netoPid, 0); } catch { alive = false; }
      if (alive) process.kill(netoPid, "SIGKILL"); // não deixar órfão se o teste falhar
      assert.equal(alive, false, "neto deveria ter morrido junto com o grupo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

