/**
 * Tests pro script cloudflare-image.js.
 *
 * Testa apenas a lógica pura de montagem de body por modelo (FLUX vs SDXL).
 * Chamadas HTTP reais requerem credenciais CF + rede — cobertas só no
 * editor's local validation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Helper inline pra testar lógica de body shape — espelha a lógica do
// cloudflare-image.js. Se o script mudar, atualizar aqui também.
function buildRequestBody(model: string, sd: {
  positive: string;
  negative?: string;
  final_width?: number;
  final_height?: number;
  num_steps?: number;
  guidance?: number;
}, defaults: { steps: number; guidance: number }): Record<string, unknown> {
  const steps = sd.num_steps ?? defaults.steps;
  const guidance = sd.guidance ?? defaults.guidance;
  const resizeW = sd.final_width ?? null;
  const resizeH = sd.final_height ?? null;
  const isFlux = model.includes("flux");
  const isSdxl = model.includes("stable-diffusion");

  const prompt = isFlux && sd.negative
    ? `${sd.positive} (avoid: ${sd.negative})`
    : sd.positive;

  if (isSdxl) {
    return {
      prompt: sd.positive,
      negative_prompt: sd.negative || undefined,
      width: resizeW ?? 1024,
      height: resizeH ?? 1024,
      num_steps: steps,
      guidance,
    };
  }
  // FLUX default
  return {
    prompt,
    num_steps: Math.min(steps, 8),
  };
}

describe("cloudflare-image — FLUX body shape", () => {
  const defaults = { steps: 4, guidance: 7.5 };

  it("monta body simples com só prompt pra FLUX", () => {
    const body = buildRequestBody(
      "@cf/black-forest-labs/flux-1-schnell",
      { positive: "van gogh style mountains" },
      defaults,
    );
    assert.equal(body.prompt, "van gogh style mountains");
    assert.equal(body.num_steps, 4);
    assert.equal(body.negative_prompt, undefined);
  });

  it("FLUX folda negative no prompt como '(avoid: X)'", () => {
    const body = buildRequestBody(
      "@cf/black-forest-labs/flux-1-schnell",
      { positive: "van gogh mountains", negative: "photorealistic, text" },
      defaults,
    );
    assert.equal(body.prompt, "van gogh mountains (avoid: photorealistic, text)");
  });

  it("FLUX limita num_steps a 8 mesmo se config pedir mais", () => {
    const body = buildRequestBody(
      "@cf/black-forest-labs/flux-1-schnell",
      { positive: "x", num_steps: 20 },
      defaults,
    );
    assert.equal(body.num_steps, 8);
  });

  it("FLUX não inclui width/height (modelo schnell decide)", () => {
    const body = buildRequestBody(
      "@cf/black-forest-labs/flux-1-schnell",
      { positive: "x", final_width: 1600, final_height: 800 },
      defaults,
    );
    assert.equal(body.width, undefined);
    assert.equal(body.height, undefined);
  });
});

describe("cloudflare-image — SDXL body shape", () => {
  const defaults = { steps: 4, guidance: 7.5 };

  it("SDXL inclui negative_prompt nativo", () => {
    const body = buildRequestBody(
      "@cf/stabilityai/stable-diffusion-xl-base-1.0",
      { positive: "scene", negative: "photorealistic" },
      defaults,
    );
    assert.equal(body.prompt, "scene");
    assert.equal(body.negative_prompt, "photorealistic");
  });

  it("SDXL usa final_width/final_height quando presentes", () => {
    const body = buildRequestBody(
      "@cf/stabilityai/stable-diffusion-xl-base-1.0",
      { positive: "scene", final_width: 1600, final_height: 800 },
      defaults,
    );
    assert.equal(body.width, 1600);
    assert.equal(body.height, 800);
  });

  it("SDXL default 1024x1024 se width/height ausentes", () => {
    const body = buildRequestBody(
      "@cf/stabilityai/stable-diffusion-xl-base-1.0",
      { positive: "scene" },
      defaults,
    );
    assert.equal(body.width, 1024);
    assert.equal(body.height, 1024);
  });

  it("SDXL usa guidance config/override", () => {
    const body = buildRequestBody(
      "@cf/stabilityai/stable-diffusion-xl-base-1.0",
      { positive: "x", guidance: 12.0 },
      defaults,
    );
    assert.equal(body.guidance, 12.0);
  });

  it("SDXL usa num_steps config (sem limite de 8)", () => {
    const body = buildRequestBody(
      "@cf/stabilityai/stable-diffusion-xl-base-1.0",
      { positive: "x", num_steps: 30 },
      defaults,
    );
    assert.equal(body.num_steps, 30);
  });
});
