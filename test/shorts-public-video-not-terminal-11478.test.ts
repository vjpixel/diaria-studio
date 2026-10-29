/**
 * test/shorts-public-video-not-terminal-11478.test.ts (#11478)
 *
 * O R2 está habilitado desde 27/10/2026 (#10772). Numa máquina sem os secrets
 * `R2_*`/`SHORTS_R2_*`, X (Buffer) e Threads pessoal saem pulados por falta de
 * URL pública (`cause: "public_video"`). Com `instagram_backend: "timer-300"`
 * esse pulo contava como terminal (regra do #11265, do tempo em que o R2 não
 * seria habilitado) e o vertical local entrava na limpeza, embora outra
 * máquina com os secrets ainda pudesse publicar. Agora o pulo fica pendente
 * em qualquer backend e o `-short.mp4` não é podado por ele. Sem rede.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupPublishedVideo,
  readCredentialSkips,
  recordCredentialSkips,
  shortsVideoTerminal,
} from "../scripts/lib/diaria/published-video-cleanup.ts";
import { loadShortsConfig } from "../scripts/lib/diaria/short-video.ts";
import { credentialSkippedItems, planShortsPublish, publicVideoUnavailableReason } from "../scripts/publish-shorts.ts";

const AAMMDD = "261022";
const D1 = { title: "Você já viu IA mentir. Já viu roubar?", body: "Um modelo gastou o saldo de terceiros." };
const reviewed = `DESTAQUE 1 | 🔐 SEGURANÇA\n\n[${D1.title}](https://alignment.openai.com/x)\n\n${D1.body}\n\nPor que isso importa: porque sim.\n`;
const schedule = { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };
const shorts = {
  facebook_pages: [],
  instagram: false,
  linkedin_profile: false,
  linkedin_page_repost: false,
  x: true,
  threads_profile: true,
  instagram_backend: "timer-300",
  schedule,
};
const config = { publishing: { shorts } };

function planWithoutR2() {
  return planShortsPublish({
    aammdd: AAMMDD,
    reviewedMd: reviewed,
    config,
    pages: [],
    instagramReady: false,
    published: { aammdd: AAMMDD, entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: "https://diar.ia.br/p/x",
    now: new Date("2026-10-22T16:00:00Z"),
    threadsPersonal: { ready: true },
    // Mesmo motivo que o main() monta numa máquina sem os secrets do R2.
    publicVideo: { ready: false, reason: publicVideoUnavailableReason("timer-300", ["R2_ACCOUNT_ID", "SHORTS_R2_BUCKET"]) },
  });
}

test("#11478: timer-300 sem R2 na máquina — X/Threads pulados por URL pública não entram como terminais", () => {
  assert.equal(loadShortsConfig(config).instagramBackend, "timer-300");
  const plan = planWithoutR2();
  const skipped = plan.items.filter((i) => i.action === "skip_missing_credentials" && i.cause === "public_video").map((i) => i.destination);
  assert.ok(skipped.includes("x"), `x deveria sair pulado por URL pública: ${JSON.stringify(plan.items)}`);
  assert.ok(skipped.includes("threads_profile"), `threads_profile deveria sair pulado por URL pública: ${JSON.stringify(plan.items)}`);
  assert.deepEqual(credentialSkippedItems(plan.items), []);
});

// O bug morava no call site do main() (`publicVideoTerminal: timer-300 && !r2.ready`),
// que não dá pra exercitar sem env/rede; o scan trava que nenhuma opção volte.
test("#11478: o main() registra os pulos sem tornar o pulo por URL pública terminal", () => {
  const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /publicVideoTerminal/);
  assert.match(src, /recordCredentialSkips\([\s\S]{0,200}?credentialSkippedItems\(plan\.items\),/);
});

test("#11478: o vertical local não é podado por causa desse pulo", () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-11478-"));
  mkdirSync(join(dir, "_internal"));
  try {
    const video = `diaria-comentada-${AAMMDD}-short.mp4`;
    writeFileSync(join(dir, video), "video");
    const cfg = loadShortsConfig(config);
    // Os outros destinos (YouTube Shorts) já saíram; só X/Threads faltam.
    writeFileSync(join(dir, "_internal", "06-shorts-published.json"), JSON.stringify({
      aammdd: AAMMDD,
      entries: [{ destination: "youtube_shorts", status: "published", id: "id", at: "2026-10-22T16:00:00Z" }],
    }));
    const plan = planWithoutR2();
    // Mesmo caminho da rodada principal do --publish (main()).
    recordCredentialSkips(dir, AAMMDD, plan.items.map((i) => i.destination), credentialSkippedItems(plan.items), "2026-10-22T16:00:00Z");
    assert.equal(readCredentialSkips(dir, AAMMDD).size, 0);
    assert.equal(shortsVideoTerminal(dir, AAMMDD, cfg), false);
    cleanupPublishedVideo({ dir, edition: AAMMDD, kind: "vertical", config: cfg, log: () => {} });
    assert.ok(existsSync(join(dir, video)), "o -short.mp4 tem que ficar para a máquina com R2 publicar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
