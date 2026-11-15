/**
 * #12465 (decisão do editor de 08/11/2026): o post do vídeo nas contas
 * PESSOAIS leva a menção (ou o link) do perfil da diar.ia.br da mesma rede.
 * Os destinos que já publicam pela conta da diar.ia.br não ganham nada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_DIARIA_PROFILES,
  buildReelsCaption,
  buildShortSocialText,
  diariaFollowLine,
  loadDiariaProfiles,
  loadShortsConfig,
  threadsTextLength,
} from "../scripts/lib/diaria/short-video.ts";
import { THREADS_TEXT_MAX_CHARS } from "../scripts/lib/threads-api.ts";
import { toLittleText } from "../scripts/lib/linkedin-personal.ts";
import { planScheduledUpdates } from "../scripts/lib/diaria/short-scheduled-update.ts";

/** Perfis com a menção do LinkedIn liberada (nome da página conferido pelo editor). */
const VERIFIED = { ...DEFAULT_DIARIA_PROFILES, linkedin: { ...DEFAULT_DIARIA_PROFILES.linkedin, mentionVerified: true } };

const D1 = { title: "Você já viu IA mentir. Já viu roubar?", body: "Um modelo da OpenAI gastou o saldo de uma carteira de terceiros. Depois mais." };

describe("#12465 diariaFollowLine por destino (frase única desde #13033/#13034)", () => {
  it("LinkedIn pessoal: menção nativa à página numa frase, só com o nome conferido (mention_verified)", () => {
    assert.equal(
      diariaFollowLine("linkedin_profile", VERIFIED),
      "Siga a @[diar.ia.br](urn:li:organization:110742958) para receber dicas e notícias de IA todos os dias",
    );
  });

  it("default: mention_verified ligado desde a medição de 15/11/2026 (#13033)", () => {
    assert.equal(DEFAULT_DIARIA_PROFILES.linkedin.mentionVerified, true);
    assert.equal(diariaFollowLine("linkedin_profile"), diariaFollowLine("linkedin_profile", VERIFIED));
  });

  it("LinkedIn pessoal com mention_verified false ou sem URN: sem linha, nunca a URL (review do PR #12489, #13033)", () => {
    const off = { ...VERIFIED, linkedin: { ...VERIFIED.linkedin, mentionVerified: false } };
    assert.equal(diariaFollowLine("linkedin_profile", off), null);
    const semUrn = { ...VERIFIED, linkedin: { ...VERIFIED.linkedin, urn: null } };
    assert.equal(diariaFollowLine("linkedin_profile", semUrn), null);
  });

  it("Threads pessoal: @diar.ia.br numa frase", () => {
    assert.equal(diariaFollowLine("threads_profile"), "Siga a @diar.ia.br para receber dicas e notícias de IA todos os dias");
  });

  it("página VJ Pixel e perfil pessoal do Facebook: sem linha (menção pela Graph API não medida, #13034)", () => {
    assert.equal(diariaFollowLine("facebook:vjpixel"), null);
    assert.equal(diariaFollowLine("facebook_profile"), null);
  });

  it("destinos da conta da diar.ia.br não ganham nada", () => {
    for (const d of ["youtube_shorts", "facebook:diaria", "instagram", "x", "tiktok", "linkedin_page_repost"]) {
      assert.equal(diariaFollowLine(d), null, d);
    }
  });

  it("sem handle do Threads: sem linha, nunca a URL do perfil", () => {
    const p = { ...DEFAULT_DIARIA_PROFILES, threads: { ...DEFAULT_DIARIA_PROFILES.threads, handle: null } };
    assert.equal(diariaFollowLine("threads_profile", p), null);
  });
});

describe("#12465 texto de cada destino pessoal", () => {
  it("LinkedIn: a menção entra antes das hashtags e sobrevive ao little text", () => {
    const text = buildShortSocialText({ platform: "linkedin", d1: D1, follow: diariaFollowLine("linkedin_profile", VERIFIED) });
    assert.match(text, /\n\nSiga a @\[diar\.ia\.br\]\(urn:li:organization:110742958\) para receber dicas e notícias de IA todos os dias\n\n#IA/);
    const little = toLittleText(text);
    assert.ok(little.includes("@[diar.ia.br](urn:li:organization:110742958)"), little);
    // O resto continua escapado (o "?" não é reservado; o "." do título também não).
    assert.ok(little.includes("{hashtag|\\#|IA}"));
  });

  it("toLittleText escapa @ e colchetes que não são menção", () => {
    assert.equal(toLittleText("mande @fulano [x](y)"), "mande \\@fulano \\[x\\]\\(y\\)");
  });

  it("Threads: a linha fica no fim e cabe no teto, mesmo com gancho longo", () => {
    const text = buildShortSocialText({ platform: "threads", d1: D1, follow: diariaFollowLine("threads_profile") });
    assert.ok(text.endsWith("\n\nSiga a @diar.ia.br para receber dicas e notícias de IA todos os dias"));
    const long = { title: D1.title, body: `${"palavra ".repeat(70)}fim.` };
    const follow = diariaFollowLine("threads_profile")!;
    const fitted = buildShortSocialText({ platform: "threads", d1: long, follow });
    assert.ok(fitted.endsWith(follow));
    assert.ok(threadsTextLength(fitted) <= THREADS_TEXT_MAX_CHARS);
  });

  it("X (@diariabr) sem a linha", () => {
    assert.doesNotMatch(buildShortSocialText({ platform: "x", d1: D1, follow: diariaFollowLine("x") }), /Siga/);
  });

  it("Reels da página VJ Pixel e da página diar.ia.br sem linha de seguir (#13034)", () => {
    const vj = buildReelsCaption({ platform: "facebook", d1: D1, follow: diariaFollowLine("facebook:vjpixel") });
    assert.doesNotMatch(vj, /Siga|facebook\.com\/diar\.ia\.br/);
    const diaria = buildReelsCaption({ platform: "facebook", d1: D1, follow: diariaFollowLine("facebook:diaria") });
    assert.doesNotMatch(diaria, /Siga/);
  });

  it("--update-scheduled da página VJ Pixel segue o publish: sem linha de seguir (#13034)", () => {
    const entries = [
      { destination: "facebook:vjpixel", status: "scheduled" as const, id: "fb2", scheduled_at: "2026-11-09T15:00:00.000Z", at: "t" },
      { destination: "facebook:diaria", status: "scheduled" as const, id: "fb1", scheduled_at: "2026-11-09T15:00:00.000Z", at: "t" },
    ];
    const items = planScheduledUpdates({ entries, d1: D1, now: new Date("2026-11-09T03:00:00Z"), coverPresent: false });
    const by = Object.fromEntries(items.map((i) => [i.destination, i])) as Record<string, { description?: string }>;
    assert.doesNotMatch(by["facebook:vjpixel"].description!, /Siga/);
    assert.doesNotMatch(by["facebook:diaria"].description!, /Siga/);
  });
});

describe("#12465 config (fonte única dos perfis)", () => {
  it("o platform.config.json do repo carrega os perfis, iguais aos defaults", () => {
    const cfg = loadShortsConfig(JSON.parse(readFileSync("platform.config.json", "utf8")));
    assert.deepEqual(cfg.diariaProfiles, DEFAULT_DIARIA_PROFILES);
  });

  it("ausente = defaults; inválido lança", () => {
    assert.deepEqual(loadDiariaProfiles(undefined), DEFAULT_DIARIA_PROFILES);
    assert.throws(() => loadDiariaProfiles({ linkedin: { urn: "123" } }), /linkedin\.urn/);
    assert.throws(() => loadDiariaProfiles({ threads: { handle: "@diar.ia.br" } }), /threads\.handle/);
    assert.throws(() => loadDiariaProfiles({ facebook: { url: "facebook.com/diar.ia.br" } }), /facebook\.url/);
    assert.throws(() => loadDiariaProfiles({ linkedin: { name: "diar](x)" } }), /linkedin\.name/);
    assert.throws(() => loadDiariaProfiles({ linkedin: { mention_verified: "sim" } }), /linkedin\.mention_verified/);
    assert.equal(loadDiariaProfiles({ linkedin: { mention_verified: true } }).linkedin.mentionVerified, true);
  });
});
