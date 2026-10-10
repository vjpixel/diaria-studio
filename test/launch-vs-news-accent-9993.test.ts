/**
 * #9993 — `\b` final ASCII-only não casava país terminado em letra acentuada
 * ("Canadá", "Vietnã") em `GEO_COMPLEMENT_RE` e em `NEWS_TITLE_PATTERNS`.
 * Antes do fix: `startsWithGeoComplement("Canadá") → false`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isLikelyNewsNotLaunch,
  NEWS_TITLE_PATTERNS,
  startsWithGeoComplement,
} from "../scripts/lib/launch-vs-news.ts";

describe("#9993 — país com acento final", () => {
  it("startsWithGeoComplement reconhece Canadá e Vietnã (fim de texto e seguido de espaço)", () => {
    for (const t of ["Canadá", "Vietnã", "Canadá and Mexico", "users in Vietnã today", "the Canadá."]) {
      assert.equal(startsWithGeoComplement(t), true, t);
    }
  });

  it("startsWithGeoComplement segue exigindo fronteira (não casa prefixo de palavra maior)", () => {
    assert.equal(startsWithGeoComplement("Canadian users"), false);
    assert.equal(startsWithGeoComplement("Canadáx"), false);
    assert.equal(startsWithGeoComplement("Canada"), true);
    assert.equal(startsWithGeoComplement("Brasil"), true);
  });

  it("NEWS_TITLE_PATTERNS casa 'para o Canadá' e 'for Vietnã'", () => {
    for (const t of ["Claude chega para o Canadá", "OpenAI para o Vietnã", "Gemini for Vietnã", "Claude for Canadá now"]) {
      assert.ok(NEWS_TITLE_PATTERNS.some((re) => re.test(t)), t);
      assert.equal(isLikelyNewsNotLaunch(t), true, t);
    }
  });

  it("NEWS_TITLE_PATTERNS não casa país como prefixo de palavra maior", () => {
    assert.equal(isLikelyNewsNotLaunch("Tools for Canadáfoo"), false);
  });
});
