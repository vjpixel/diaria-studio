/**
 * test/resolve-video-youtube.test.ts (#3202)
 *
 * Testa o wrapper de I/O `resolveVideoYoutube` (opera sobre o shape
 * `{ lancamento, radar, use_melhor, video }` de `tmp-categorized.json`) —
 * complementa `test/video-youtube-resolve.test.ts` (lógica pura por-artigo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveVideoYoutube } from "../scripts/resolve-video-youtube.ts";
import type { VideoSearchCandidate } from "../scripts/lib/video-youtube-resolve.ts";

describe("resolveVideoYoutube", () => {
  it("sem bucket video (ausente ou vazio) → no-op", () => {
    const input = { lancamento: [], radar: [], use_melhor: [] };
    const result = resolveVideoYoutube(input, {});
    assert.equal(result.output, input);
    assert.equal(result.resolved, 0);
    assert.equal(result.flagged, 0);
    assert.equal(result.alreadyYoutube, 0);
  });

  it("resolve item não-YouTube com busca mockada confiável, preserva demais buckets intocados", () => {
    const input = {
      lancamento: [{ url: "https://openai.com/blog/x", title: "X" }],
      radar: [],
      use_melhor: [],
      video: [
        { url: "https://openai.com/index/introducing-gpt-live/", title: "Introducing GPT-Live" },
      ],
    };
    const searchResults: Record<string, VideoSearchCandidate[]> = {
      "https://openai.com/index/introducing-gpt-live/": [
        { url: "https://youtu.be/EAN5Cj347PY", title: "Introducing GPT-Live | OpenAI" },
      ],
    };
    const result = resolveVideoYoutube(input, searchResults);
    assert.equal(result.resolved, 1);
    assert.equal(result.flagged, 0);
    assert.equal(result.output.video![0].url, "https://youtu.be/EAN5Cj347PY");
    // Outros buckets não tocados
    assert.equal(result.output.lancamento, input.lancamento);
  });

  it("flaga item sem search-results correspondente (mapa sem a URL do artigo)", () => {
    const input = {
      video: [
        { url: "https://blog.example.com/live", title: "Live sem cobertura de busca" },
      ],
    };
    const result = resolveVideoYoutube(input, {});
    assert.equal(result.resolved, 0);
    assert.equal(result.flagged, 1);
    assert.equal(result.output.video![0].video_url_unverified, true);
    // Nunca fabrica uma URL youtube-shaped
    assert.equal(result.output.video![0].url, "https://blog.example.com/live");
  });

  it("item já-YouTube não conta como resolved nem flagged", () => {
    const input = {
      video: [{ url: "https://youtu.be/already-ok", title: "Já está certo" }],
    };
    const result = resolveVideoYoutube(input, {});
    assert.equal(result.resolved, 0);
    assert.equal(result.flagged, 0);
    assert.equal(result.alreadyYoutube, 1);
  });
});
