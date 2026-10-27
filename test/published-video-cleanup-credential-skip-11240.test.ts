/**
 * test/published-video-cleanup-credential-skip-11240.test.ts (#11240, resíduo do PR #11270)
 *
 * Decisão do editor (briefing 27/10/2026): destino do vertical pulado por falta
 * de credencial/token (ex.: `threads_profile` sem THREADS_PERSONAL_*) conta como
 * TERMINAL e libera apagar o MP4 vertical. Antes, o pulo não deixava registro e
 * a limpeza nunca disparava enquanto o token faltasse. Sem rede.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHORTS_CREDENTIAL_SKIPS_FILE,
  cleanupPublishedVideo,
  readCredentialSkips,
  recordCredentialSkips,
  shortsVideoTerminal,
} from "../scripts/lib/diaria/published-video-cleanup.ts";
import { DEFAULT_SHORTS_CONFIG } from "../scripts/lib/diaria/short-video.ts";
import { readShortsRegistry } from "../scripts/lib/diaria/shorts-published-store.ts";
import { credentialSkippedItems, planShortsPublish } from "../scripts/publish-shorts.ts";

const edition = "261027";
const video = `diaria-comentada-${edition}-short.mp4`;
const cfg = { ...DEFAULT_SHORTS_CONFIG, facebookPages: [], instagram: true, linkedinProfile: true, linkedinPageRepost: false, threadsProfile: true, x: false };
const NOW = "2026-10-27T12:00:00Z";

function fixture(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "cleanup-cred-"));
  mkdirSync(join(dir, "_internal"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function ledger(dir: string, destinations: string[]) {
  writeFileSync(join(dir, "_internal", "06-shorts-published.json"), JSON.stringify({
    aammdd: edition,
    entries: destinations.map(destination => ({ destination, status: "published", id: "id", at: NOW })),
  }));
}
const cleanup = (dir: string) => cleanupPublishedVideo({ dir, edition, kind: "vertical", config: cfg, log: () => {} });
const threadsSkip = [{ destination: "threads_profile", detail: "THREADS_PERSONAL_ACCESS_TOKEN ausente(s)" }];

test("threads_profile pulado por credencial é terminal e libera apagar o vertical (decisão do editor)", () => fixture(dir => {
  writeFileSync(join(dir, video), "video");
  ledger(dir, ["youtube_shorts", "instagram", "facebook_profile", "linkedin_profile"]);
  // Sem o registro do pulo: o threads_profile segue pendente e o arquivo fica (comportamento do #11270).
  assert.equal(shortsVideoTerminal(dir, edition, cfg), false);
  cleanup(dir);
  assert.ok(existsSync(join(dir, video)));
  // Com o pulo registrado pela rodada --publish: terminal, o arquivo sai.
  recordCredentialSkips(dir, edition, ["youtube_shorts", "instagram", "threads_profile"], threadsSkip, NOW);
  assert.equal(shortsVideoTerminal(dir, edition, cfg), true);
  cleanup(dir);
  assert.ok(!existsSync(join(dir, video)));
}));

test("o arquivo de pulos não entra no registro de publicação (nunca vira skip_done)", () => fixture(dir => {
  recordCredentialSkips(dir, edition, ["threads_profile"], threadsSkip, NOW);
  assert.deepEqual(readShortsRegistry(dir, edition).entries, []);
  assert.deepEqual([...readCredentialSkips(dir, edition)], ["threads_profile"]);
}));

test("rodada seguinte com token remove o pulo; --only preserva o pulo de quem ficou de fora", () => fixture(dir => {
  recordCredentialSkips(dir, edition, ["instagram", "threads_profile"], [...threadsSkip, { destination: "instagram", detail: "INSTAGRAM_*" }], NOW);
  // --only instagram: o threads_profile não foi planejado, o pulo dele fica.
  recordCredentialSkips(dir, edition, ["instagram"], [], NOW);
  assert.deepEqual([...readCredentialSkips(dir, edition)], ["threads_profile"]);
  // Rodada com o token: o threads_profile foi planejado e não pulou, sai da lista.
  recordCredentialSkips(dir, edition, ["threads_profile"], [], NOW);
  assert.equal(readCredentialSkips(dir, edition).size, 0);
}));

test("pulos de outra edição ou arquivo ilegível não contam (fail-safe: o vertical fica)", () => fixture(dir => {
  writeFileSync(join(dir, video), "video");
  ledger(dir, ["youtube_shorts", "instagram", "facebook_profile", "linkedin_profile"]);
  const path = join(dir, SHORTS_CREDENTIAL_SKIPS_FILE);
  writeFileSync(path, JSON.stringify({ aammdd: "261026", entries: threadsSkip }));
  assert.equal(shortsVideoTerminal(dir, edition, cfg), false);
  writeFileSync(path, "{ quebrado");
  assert.equal(shortsVideoTerminal(dir, edition, cfg), false);
  cleanup(dir);
  assert.ok(existsSync(join(dir, video)));
  // Um --publish depois recomeça o arquivo ilegível em vez de lançar.
  recordCredentialSkips(dir, edition, ["threads_profile"], threadsSkip, NOW);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).aammdd, edition);
}));

test("fetch-drive-video não baixa de novo o vertical apagado com threads_profile pulado por credencial", async () => {
  const { runFetchDriveVideo } = await import("../scripts/fetch-drive-video.ts");
  const { loadShortsConfig, listShortDestinations } = await import("../scripts/lib/diaria/short-video.ts");
  const config = loadShortsConfig(JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8")));
  const ids = listShortDestinations(config).map(d => d.id);
  const dir = mkdtempSync(join(tmpdir(), "fetch-cred-"));
  mkdirSync(join(dir, "_internal"));
  try {
    // Todos publicados menos o threads_profile (sem token), que só tem o pulo registrado.
    ledger(dir, ids.filter(id => id !== "threads_profile"));
    recordCredentialSkips(dir, edition, ["threads_profile"], threadsSkip, NOW);
    const outcome = await runFetchDriveVideo({} as never, { aammdd: edition, editionDir: dir, orientation: "vertical", folderId: "unused", now: new Date(), windowHours: 24, dryRun: false, force: false }, () => {});
    assert.equal(outcome.output.action, "already-published");
    assert.equal(existsSync(join(dir, video)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("credentialSkippedItems: pulo por credencial entra; R2 fora do ar e delegação ao timer não", () => {
  const D1 = { title: "Você já viu IA mentir. Já viu roubar?", body: "Um modelo gastou o saldo de terceiros." };
  const reviewed = `DESTAQUE 1 | 🔐 SEGURANÇA\n\n[${D1.title}](https://alignment.openai.com/x)\n\n${D1.body}\n\nPor que isso importa: porque sim.\n`;
  const schedule = { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };
  const base = {
    aammdd: "261022",
    reviewedMd: reviewed,
    config: { publishing: { shorts: { facebook_pages: [], instagram: false, linkedin_profile: false, linkedin_page_repost: false, x: false, threads_profile: true, schedule } } },
    pages: [],
    instagramReady: false,
    published: { aammdd: "261022", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: "https://diar.ia.br/p/x",
    youtubeVideoUrl: "https://youtu.be/MMyBVHVQELI",
    now: new Date("2026-10-22T16:00:00Z"),
  };
  const noToken = planShortsPublish({ ...base, threadsPersonal: { ready: false, reason: "THREADS_PERSONAL_ACCESS_TOKEN ausente(s)." }, publicVideo: { ready: true } });
  assert.deepEqual(credentialSkippedItems(noToken.items).map(s => s.destination), ["threads_profile"]);
  const noR2 = planShortsPublish({ ...base, threadsPersonal: { ready: true }, publicVideo: { ready: false, reason: "R2_* ausente" } });
  assert.equal(noR2.items.find(i => i.destination === "threads_profile")?.action, "skip_missing_credentials");
  assert.deepEqual(credentialSkippedItems(noR2.items), []);
  assert.deepEqual(credentialSkippedItems([{ destination: "linkedin_profile", mode: "api", action: "skip_delegated", detail: "timer" }]), []);
});
