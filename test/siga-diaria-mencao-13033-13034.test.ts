/**
 * #13033/#13034 (decisão do editor, 13/11/2026): a linha de seguir a
 * diar.ia.br no post do vertical é uma frase, "Siga a {menção} para receber
 * dicas e notícias de IA todos os dias", com a menção NATIVA do perfil da
 * rede. Nunca `diar.ia.br` solto (LinkedIn e Facebook o autolinkam para o
 * site) e nunca a URL do perfil (o LinkedIn a encurta para `lnkd.in/…`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DIARIA_PROFILES,
  DIARIA_FOLLOW_PURPOSE,
  buildShortSocialText,
  diariaFollowLine,
  hasBareDiariaDomain,
  loadDiariaProfiles,
  type DiariaProfiles,
} from "../scripts/lib/diaria/short-video.ts";
import { toLittleText } from "../scripts/lib/linkedin-personal.ts";
import { readFileSync } from "node:fs";

const VERIFIED: DiariaProfiles = { ...DEFAULT_DIARIA_PROFILES, linkedin: { ...DEFAULT_DIARIA_PROFILES.linkedin, mentionVerified: true } };
const NO_IDS: DiariaProfiles = {
  ...DEFAULT_DIARIA_PROFILES,
  linkedin: { ...DEFAULT_DIARIA_PROFILES.linkedin, urn: null, mentionVerified: true },
  threads: { ...DEFAULT_DIARIA_PROFILES.threads, handle: null },
};
const DESTINATIONS = [
  "linkedin_profile", "threads_profile", "facebook_profile", "facebook:vjpixel", "facebook:outra",
  "facebook:diaria", "youtube_shorts", "instagram", "x", "tiktok", "linkedin_page_repost",
];
const D1 = { title: "Você já viu IA mentir. Já viu roubar?", body: "Um modelo gastou o saldo de uma carteira de terceiros. Depois mais." };

describe("#13034 hasBareDiariaDomain", () => {
  it("acusa a linha antiga de cada rede (o caso real da #13033)", () => {
    assert.equal(hasBareDiariaDomain("Siga a diar.ia.br: linkedin.com/company/diar.ia.br"), true);
    assert.equal(hasBareDiariaDomain("Siga a diar.ia.br: facebook.com/diar.ia.br"), true);
    assert.equal(hasBareDiariaDomain("A diar.ia.br é a newsletter"), true);
    assert.equal(hasBareDiariaDomain("Siga a diar.ia.br."), true);
  });

  it("aceita menção nativa (LinkedIn little text, @handle) e URL", () => {
    assert.equal(hasBareDiariaDomain("Siga a @[diar.ia.br](urn:li:organization:110742958) para receber"), false);
    assert.equal(hasBareDiariaDomain("Siga a @diar.ia.br para receber"), false);
    assert.equal(hasBareDiariaDomain("Assista em https://diar.ia.br/video"), false);
    assert.equal(hasBareDiariaDomain("sem marca nenhuma"), false);
  });
});

describe("#13033/#13034 diariaFollowLine nunca deixa diar.ia.br solto nem URL", () => {
  for (const [label, profiles] of [["default", DEFAULT_DIARIA_PROFILES], ["verificado", VERIFIED], ["sem urn/handle", NO_IDS]] as const) {
    for (const d of DESTINATIONS) {
      it(`${label} / ${d}`, () => {
        const line = diariaFollowLine(d, profiles);
        if (line === null) return;
        assert.equal(hasBareDiariaDomain(line), false, line);
        assert.doesNotMatch(line, /https?:\/\/|\.com\/|lnkd\.in/, line);
        assert.ok(line.startsWith("Siga a @"), line);
        assert.ok(line.endsWith(` ${DIARIA_FOLLOW_PURPOSE}`), line);
      });
    }
  }

  it("mention_verified false: sem linha no LinkedIn; Facebook nunca tem linha", () => {
    const off = loadDiariaProfiles({ linkedin: { mention_verified: false } });
    assert.equal(diariaFollowLine("linkedin_profile", off), null);
    assert.equal(diariaFollowLine("facebook:vjpixel", off), null);
  });

  it("o config do repo liga a menção medida em 15/11/2026 (LinkedIn) e segue sem linha no Facebook", () => {
    const cfg = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
    const fromConfig = loadDiariaProfiles(cfg.publishing.shorts.diaria_profiles);
    // Medição do #13033: nome e URN exatos, que o LinkedIn transformou em link para a página.
    assert.equal(fromConfig.linkedin.mentionVerified, true);
    assert.equal(fromConfig.linkedin.name, "diar.ia.br");
    assert.equal(fromConfig.linkedin.urn, "urn:li:organization:110742958");
    assert.equal(
      diariaFollowLine("linkedin_profile", fromConfig),
      "Siga a @[diar.ia.br](urn:li:organization:110742958) para receber dicas e notícias de IA todos os dias",
    );
    // Medição do #13034: a Graph API descartou a tag de página, então o Facebook segue sem linha.
    assert.equal(diariaFollowLine("facebook:vjpixel", fromConfig), null);
    assert.equal(diariaFollowLine("facebook_profile", fromConfig), null);
  });
});

describe("#13033 toLittleText preserva a menção no MEIO da frase", () => {
  it("a menção sai sem escape e o resto da frase continua igual", () => {
    const line = diariaFollowLine("linkedin_profile", VERIFIED)!;
    assert.equal(
      toLittleText(line),
      "Siga a @[diar.ia.br](urn:li:organization:110742958) para receber dicas e notícias de IA todos os dias",
    );
  });

  it("no texto inteiro do post do LinkedIn pessoal, a frase fica antes das hashtags", () => {
    const text = buildShortSocialText({ platform: "linkedin", d1: D1, follow: diariaFollowLine("linkedin_profile", VERIFIED) });
    const little = toLittleText(text);
    assert.ok(little.includes("\n\nSiga a @[diar.ia.br](urn:li:organization:110742958) para receber dicas e notícias de IA todos os dias\n\n{hashtag|\\#|IA}"), little);
  });
});
