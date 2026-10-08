/**
 * #9882 — pedido recorrente `bucket-move` (261005, 261006, 261008).
 *
 * Regra nova derivada SÓ dos movimentos reais do editor (radar → lancamento)
 * e limitada pelos contra-exemplos do corpus, medida com o eval de replay
 * (`npx tsx scripts/analyze-bucket-overrides.ts --replay --all`, 08/10/2026):
 * 3 melhorias, 0 regressões. Título/URL/summary/type_hint vêm de
 * `_internal/01-categorized.json` de cada edição citada.
 *
 * Os outros movimentos do pedido (261005 mods/prompt-foto/Apple diffusion)
 * já tinham sido cobertos pelo PR #9649 (guard em
 * `categorize-residual-5995-261005.test.ts`); o resíduo sem sinal reutilizável
 * (latent.space, exame "ensinam", AWS "Add secure Web Search") está no PR.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorizeWithRule, categoryToBucket, isNewPlatformAvailabilityTitle } from "../scripts/lib/launch-heuristics.ts";

const bucketAndRule = (a: Parameters<typeof categorizeWithRule>[0]) => {
  const r = categorizeWithRule(a);
  return { bucket: categoryToBucket(r.category), rule: r.rule };
};

describe("#9882 — produto chegando a superfície nova de usuário final → LANÇAMENTOS", () => {
  it("CASO REAL 261008: 'Claude now works with Google Docs, Sheets, and Slides' (claude.com/resources/articles) → lancamento", () => {
    assert.deepEqual(
      bucketAndRule({
        url: "https://claude.com/resources/articles/claude-now-works-in-google-docs-sheets-and-slides",
        title: "Claude now works with Google Docs, Sheets, and Slides",
        summary:
          "With our new Claude for Google Workspace add-on and connectors (in beta), bring Claude into your Google files or work on your files directly from Claude.",
      }),
      { bucket: "lancamento", rule: "lancamento-new-platform-availability" },
    );
  });

  it("CASO REAL 260911: 'The Gemini app is now available for Windows' (blog.google) → lancamento", () => {
    assert.deepEqual(
      bucketAndRule({
        url: "https://blog.google/innovation-and-ai/products/gemini-app/gemini-app-now-on-windows/",
        title: "The Gemini app is now available for Windows",
        summary:
          "We’re launching the Gemini app for Windows, the new desktop app built to work alongside your favorite tools and daily applications.",
      }),
      { bucket: "lancamento", rule: "lancamento-new-platform-availability" },
    );
  });

  it("CASO REAL 260915: 'Perplexity Portable Computer Is Now Available on Windows…' (blogs.nvidia.com) → lancamento", () => {
    assert.deepEqual(
      bucketAndRule({
        url: "https://blogs.nvidia.com/blog/local-ai-perplexity-windows-pcs/",
        title: "Perplexity Portable Computer Is Now Available on Windows, Powered by NVIDIA RTX",
        summary:
          "As local models become more capable, AI agents can handle more work directly on a PC while keeping sensitive information on the device. Portable Computer is a local version of the agent Perplexity Computer that plans and carries out multistep tasks.",
      }),
      { bucket: "lancamento", rule: "lancamento-new-platform-availability" },
    );
  });
});

describe("#9882 — limites (contra-exemplos do corpus que o editor manteve em RADAR)", () => {
  it("CASO REAL 260603: 'OpenAI frontier models and Codex are now available on AWS' → radar (distribuição em nuvem)", () => {
    assert.deepEqual(
      bucketAndRule({
        url: "https://openai.com/index/openai-frontier-models-and-codex-are-now-available-on-aws",
        title: "OpenAI frontier models and Codex are now available on AWS",
        summary:
          "OpenAI frontier models and Codex are now generally available on AWS, giving enterprises a new path to build with OpenAI through the AWS environments, controls, and procurement workflows they already use.",
      }),
      { bucket: "radar", rule: "lancamento-update" },
    );
  });

  it("CASO REAL 260813: 'Daybreak models are now available on AWS' → radar", () => {
    assert.deepEqual(
      bucketAndRule({
        url: "https://openai.com/index/daybreak-models-are-now-available-on-aws",
        title: "Daybreak models are now available on AWS",
        summary:
          "OpenAI and AWS are making Daybreak cybersecurity capabilities available through Amazon Bedrock to support enterprise security workflows.",
      }),
      { bucket: "radar", rule: "lancamento-update" },
    );
  });

  it("CASO REAL 261002: 'Claude for Government is now generally available' → radar (GA não casa 'now available on|for')", () => {
    assert.deepEqual(
      bucketAndRule({
        url: "https://claude.com/blog/claude-for-government-is-now-generally-available",
        title: "Claude for Government is now generally available",
        summary: "Claude Code CLI and Claude for Microsoft 365 also now available in early access.",
      }),
      { bucket: "radar", rule: "lancamento-update" },
    );
  });

  it("só o TÍTULO conta: 'now works with' no summary não dispara a exceção", () => {
    assert.equal(
      isNewPlatformAvailabilityTitle({
        url: "https://openai.com/index/x",
        title: "An update on our connectors",
        summary: "ChatGPT now works with Google Drive.",
      }),
      false,
    );
  });

  it("Azure/Bedrock/Vertex no título também ficam fora (mesma classe de distribuição em nuvem)", () => {
    for (const title of [
      "Gemini models now available on Vertex AI",
      "Claude now available on Microsoft Azure Foundry",
      "Llama now works with Amazon Bedrock Agents",
    ]) {
      assert.equal(isNewPlatformAvailabilityTitle({ url: "https://example.com", title }), false, title);
    }
  });
});
