import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  buildCodexArgs,
  buildCodexPrompt,
  checkAspect,
  generateWithCodex,
  sanitizedEnv,
  DEFAULTS,
  verifySessionImage,
  // @ts-expect-error — módulo .js sem tipos
} from "../scripts/codex-image.js";
import { parsePlatformConfig } from "../scripts/lib/schemas/platform-config.ts";
import { resolveImageScriptName } from "../scripts/eia-compose.ts";

const SD = { positive: "a robot reading a newspaper", negative: "photorealistic", final_width: 1600, final_height: 800 };

async function png(w: number, h: number, dest: string) {
  await sharp({ create: { width: w, height: h, channels: 3, background: "#336699" } }).png().toFile(dest);
}

// run mockado: PNG pré-gerado, gravado no cwd que o backend criou (spawnSync é síncrono)
async function fixtureRun(w: number, h: number, extra: { status?: number; skipFile?: boolean; error?: { code?: string; message: string } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codex-fixture-"));
  const src = join(dir, "src.png");
  await png(w, h, src);
  const buf = readFileSync(src);
  const session = "01234567-1234-1234-1234-123456789abc";
  mkdirSync(join(dir, session));
  writeFileSync(join(dir, session, "generated.png"), buf);
  const calls: { args: string[]; prompt: string }[] = [];
  const run = (args: string[], prompt: string, cwd: string) => {
    calls.push({ args, prompt });
    if (extra.error) return { error: extra.error, status: null, stdout: "", stderr: "" };
    if (!extra.skipFile) writeFileSync(join(cwd, "image.png"), buf);
    return { error: undefined, status: extra.status ?? 0, stdout: JSON.stringify({ type: "thread.started", thread_id: session }), stderr: extra.status ? "boom" : "" };
  };
  return { run, calls, generatedImagesDir: dir };
}

describe("codex-image (#9088)", () => {
  it("sanitizedEnv remove chaves pay-per-token", () => {
    const env = sanitizedEnv({ OPENAI_API_KEY: "x", CODEX_API_KEY: "y", OPENAI_BASE_URL: "u", PATH: "/bin" });
    assert.equal(env.OPENAI_BASE_URL, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
    assert.equal(env.PATH, "/bin");
  });

  it("args passam modelo explícito e prompt via stdin", () => {
    const args = buildCodexArgs(DEFAULTS);
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("-m") && args.includes(DEFAULTS.model));
    assert.equal(args[args.length - 1], "-");
  });

  it("prompt pede a proporção do alvo e inclui negative", () => {
    assert.match(buildCodexPrompt(SD), /2:1/);
    assert.match(buildCodexPrompt({ ...SD, final_width: 1080, final_height: 1350 }), /4:5/);
    assert.match(buildCodexPrompt(SD), /photorealistic/);
  });

  it("É IA? 800x450 pede landscape (não quadrado)", () => {
    assert.match(buildCodexPrompt({ positive: "x", final_width: 800, final_height: 450 }), /landscape 16:9/);
  });

  it("args forçam login ChatGPT", () => {
    assert.ok(buildCodexArgs(DEFAULTS).includes('forced_login_method="chatgpt"'));
  });

  it("checkAspect aceita 3:2 p/ 2:1, rejeita quadrado e retrato p/ wide", () => {
    assert.equal(checkAspect(1536, 1024, 1600, 800), null);
    assert.match(checkAspect(1024, 1024, 1600, 800)!, /proporção errada/);
    assert.match(checkAspect(1024, 1536, 1600, 800)!, /proporção errada/);
  });

  it("sucesso: grava JPEG nas dimensões finais", async () => {
    const { run, calls, generatedImagesDir } = await fixtureRun(1536, 1024);
    const out = join(mkdtempSync(join(tmpdir(), "codex-out-")), "o.jpg");
    await generateWithCodex(SD, out, {}, run, generatedImagesDir);
    const meta = await sharp(out).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 1600, 800]);
    assert.equal(calls.length, 1);
  });

  it("arquivo ausente: falha barulhenta, sem saída", async () => {
    const { run, generatedImagesDir } = await fixtureRun(1536, 1024, { skipFile: true });
    const out = join(mkdtempSync(join(tmpdir(), "codex-out-")), "o.jpg");
    await assert.rejects(() => generateWithCodex(SD, out, {}, run, generatedImagesDir), /NO_IMAGE_FILE/);
    assert.equal(existsSync(out), false);
  });

  it("timeout vira erro CODEX_TIMEOUT", async () => {
    const { run, generatedImagesDir } = await fixtureRun(10, 10, { error: { code: "ETIMEDOUT", message: "t" } });
    await assert.rejects(() => generateWithCodex(SD, "/nao/usado.jpg", { timeout_seconds: 7 }, run, generatedImagesDir), /CODEX_TIMEOUT após 7s/);
  });

  it("exit ≠ 0 do codex vira erro", async () => {
    const { run, generatedImagesDir } = await fixtureRun(10, 10, { status: 1 });
    await assert.rejects(() => generateWithCodex(SD, "/nao/usado.jpg", {}, run, generatedImagesDir), /CODEX_FAILED exit=1/);
  });

  it("proporção errada é rejeitada e não grava", async () => {
    const { run, generatedImagesDir } = await fixtureRun(1024, 1536);
    const out = join(mkdtempSync(join(tmpdir(), "codex-out-")), "o.jpg");
    await assert.rejects(() => generateWithCodex(SD, out, {}, run, generatedImagesDir), /proporção errada/);
    assert.equal(existsSync(out), false);
  });
});

describe("dispatch do backend codex (#9088)", () => {
  it("schema aceita image_generator=codex e bloco codex", () => {
    const cfg = parsePlatformConfig({ image_generator: "codex", codex: { model: "gpt-5.6-luna", fallback: "gemini" } } as never);
    assert.equal(cfg.image_generator, "codex");
    assert.equal(cfg.codex?.fallback, "gemini");
  });

  it("eia-compose despacha codex-image.js", () => {
    assert.equal(resolveImageScriptName("codex"), "scripts/codex-image.js");
  });

  it("image-generate.ts mapeia codex → codex-image.js", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "image-generate.ts"), "utf8");
    assert.match(src, /generator === "codex"\s+\? "codex-image\.js"/);
  });
});

describe("proveniência da imagem (#12877)", () => {
  for (const crossed of [false, true]) it(`quatro runs concorrentes: ${crossed ? "rejeitam cópia cruzada com exit 0" : "aceitam imagens próprias"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-concurrent-"));
    try {
      const images = await Promise.all(["red", "blue", "green", "yellow"].map((background) =>
        sharp({ create: { width: 64, height: 64, channels: 3, background } }).png().toBuffer()));
      const sessions = images.map((_, i) => `01234567-1234-1234-1234-123456789ab${i}`);
      sessions.forEach((session, i) => {
        mkdirSync(join(dir, session));
        writeFileSync(join(dir, session, "generated.png"), images[i]);
      });
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const results = await Promise.allSettled(sessions.map((session, i) =>
        generateWithCodex({ positive: `color ${i}`, final_width: 64, final_height: 64 }, join(dir, `${i}.jpg`), {},
          async (_args: string[], _prompt: string, cwd: string) => {
            if (++arrived === 4) release();
            await barrier;
            // Simula a corrida real: 3 agentes copiam a imagem da sessão 0.
            writeFileSync(join(cwd, "image.png"), images[crossed ? 0 : i]);
            return { status: 0, stdout: JSON.stringify({ type: "thread.started", thread_id: session }), stderr: "" };
          }, dir)));
      if (!crossed) {
        assert.ok(results.every((result) => result.status === "fulfilled"));
        assert.equal(new Set(sessions.map((_, i) => readFileSync(join(dir, `${i}.jpg`)).toString("base64"))).size, 4);
        return;
      }
      assert.equal(results[0].status, "fulfilled");
      for (let i = 1; i < 4; i++) {
        assert.equal(results[i].status, "rejected");
        assert.match((results[i] as PromiseRejectedResult).reason.message, /CODEX_IMAGE_PROVENANCE/);
        assert.equal(existsSync(join(dir, `${i}.jpg`)), false);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("aceita JSONL com eventos extras e mais de um PNG na sessão", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-jsonl-"));
    try {
      const session = "01234567-1234-1234-1234-123456789abc";
      mkdirSync(join(dir, session));
      const image = join(dir, "image.png");
      await png(64, 64, image);
      writeFileSync(join(dir, session, "first.png"), "other image");
      writeFileSync(join(dir, session, "second.png"), readFileSync(image));
      const stdout = ["null", JSON.stringify({ type: "thread.started", thread_id: session }),
        JSON.stringify({ type: "turn.completed", usage: {} })].join("\n");
      assert.doesNotThrow(() => verifySessionImage(image, stdout, dir));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejeita sessão ausente, inválida, ambígua e sem artefato próprio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-provenance-"));
    try {
      const image = join(dir, "image.png");
      await png(64, 64, image);
      const event = JSON.stringify({ type: "thread.started", thread_id: "01234567-1234-1234-1234-123456789abc" });
      for (const stdout of ["null", "done", '{bad json', JSON.stringify({ type: "thread.started", thread_id: "../other" }), `${event}\n${event}`, event]) {
        assert.throws(() => verifySessionImage(image, stdout, dir), /CODEX_IMAGE_PROVENANCE/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
