/**
 * #11223: `publishing.shorts.facebook_profile` pausa o Reel no perfil pessoal
 * do Facebook (passo guiado no Chrome) durante a viagem do editor, sem o Neo.
 * Antes o destino era fixo em `listShortDestinations` e a skill o cobrava todo
 * dia; a limpeza do vertical (#11240) esperava por ele e nunca apagava o MP4.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SHORTS_CONFIG, listShortDestinations, loadShortsConfig } from "../scripts/lib/diaria/short-video.ts";
import { shortsVideoTerminal } from "../scripts/lib/diaria/published-video-cleanup.ts";
import { planShortsPublish } from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEDULE = { rotation_times: ["12:00", "19:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };
const REVIEWED = `DESTAQUE 1 | SEGURANÇA

[Você já viu IA mentir. Já viu roubar?](https://alignment.openai.com/x)

Um modelo gastou o saldo de uma carteira de terceiros.

Por que isso importa: porque sim.
`;
const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: `page-${slug}` });
const baseShorts = { facebook_pages: ["diaria"], instagram: false, schedule: SCHEDULE };

function plan(shorts: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return planShortsPublish({
    aammdd: "261028",
    reviewedMd: REVIEWED,
    config: { publishing: { shorts: { ...baseShorts, ...shorts } } },
    pages: [page("diaria")],
    instagramReady: false,
    published: { aammdd: "261028", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: "https://diar.ia.br/p/x",
    now: new Date("2026-10-28T03:00:00Z"),
    ...extra,
  } as Parameters<typeof planShortsPublish>[0]);
}

describe("#11223 publishing.shorts.facebook_profile", () => {
  it("ausente = ligado (default do código não muda o comportamento de antes)", () => {
    assert.equal(DEFAULT_SHORTS_CONFIG.facebookProfile, true);
    assert.equal(loadShortsConfig({ publishing: { shorts: baseShorts } }).facebookProfile, true);
    assert.ok(plan({}).items.some((i) => i.destination === "facebook_profile"));
  });

  it("false tira o perfil pessoal do plano; o resto continua", () => {
    const cfg = loadShortsConfig({ publishing: { shorts: { ...baseShorts, facebook_profile: false } } });
    assert.equal(cfg.facebookProfile, false);
    assert.deepEqual(listShortDestinations(cfg).map((d) => d.id).filter((id) => id.startsWith("facebook")), ["facebook:diaria"]);
    const ids = plan({ facebook_profile: false }).items.map((i) => i.destination);
    assert.ok(!ids.includes("facebook_profile"), "o plano não cobra o passo pausado");
    assert.ok(ids.includes("facebook:diaria"), "as páginas seguem pela API");
  });

  it("pausado, --only facebook_profile vira destino desconhecido (nunca publica nada com exit 0)", () => {
    assert.throws(() => plan({ facebook_profile: false }, { only: ["facebook_profile"] }), /desconhecido: facebook_profile/);
  });

  it("valor não-booleano lança", () => {
    assert.throws(() => loadShortsConfig({ publishing: { shorts: { ...baseShorts, facebook_profile: "nao" } } }), /facebook_profile precisa ser boolean/);
  });

  it("limpeza do vertical (#11240) não espera o destino pausado", () => {
    const dir = mkdtempSync(join(tmpdir(), "fbprofile-"));
    try {
      mkdirSync(join(dir, "_internal"));
      const entries = ["youtube_shorts", "instagram", "linkedin_profile"].map((destination) => ({ destination, status: "published", id: "id", at: "2026-10-28T00:00:00Z" }));
      writeFileSync(join(dir, "_internal", "06-shorts-published.json"), JSON.stringify({ aammdd: "261028", entries }));
      const cfg = { ...DEFAULT_SHORTS_CONFIG, facebookPages: [], threadsProfile: false, x: false };
      assert.equal(shortsVideoTerminal(dir, "261028", cfg), false, "ligado, o perfil pessoal pendente segura o MP4");
      assert.equal(shortsVideoTerminal(dir, "261028", { ...cfg, facebookProfile: false }), true, "pausado, não segura");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o platform.config.json real declara a chave como boolean", () => {
    const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    assert.equal(typeof config.publishing.shorts.facebook_profile, "boolean");
    assert.equal(loadShortsConfig(config).facebookProfile, config.publishing.shorts.facebook_profile);
  });
});
