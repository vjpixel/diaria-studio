/**
 * #13156 — o `/diaria-video-roteiro` roda a pesquisa de títulos do YouTube
 * para os títulos dos vídeos. O script aceita `--title`/`--url` (a edição pode
 * ainda não ter `01-approved.json`, caso da 261117) e grava num arquivo
 * próprio, sem sobrescrever a pesquisa do D1 do Stage 2.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ROTEIRO_RESEARCH_DAYS,
  YOUTUBE_TITLE_RESEARCH_FILE,
  YOUTUBE_TITLE_RESEARCH_ROTEIRO_FILE,
} from "../scripts/lib/diaria/youtube-title-research.ts";
import { researchAndWrite, researchOutPath } from "../scripts/youtube-title-research.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "youtube-title-research.ts");
const NOW = new Date("2026-11-15T12:00:00Z");
const CREDS = { credentials: { clientId: "c", clientSecret: "s", refreshToken: "r" }, missing: [] as string[] };

function okFetch(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    if (url.includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    if (url.includes("/search?")) return new Response(JSON.stringify({ items: [{ id: { videoId: "a" } }, { id: { videoId: "b" } }] }), { status: 200 });
    if (url.includes("/videos?")) {
      const item = (id: string, title: string, views: string) => ({
        id,
        snippet: { title, channelTitle: "Canal", defaultAudioLanguage: "pt-BR", publishedAt: "2026-11-10T10:00:00Z" },
        statistics: { viewCount: views },
        contentDetails: { duration: "PT50S" },
      });
      return new Response(
        JSON.stringify({ items: [item("a", "Drauzio alerta: golpe com médicos criados por IA", "28000"), item("b", "Como identificar deepfake de médicos", "9000")] }),
        { status: 200 },
      );
    }
    return new Response("?", { status: 404 });
  };
}

/** Edição sem approved (caso 261117: o roteiro rodou antes da edição existir). */
function emptyEdition(): string {
  return join(mkdtempSync(join(tmpdir(), "yt-roteiro-")), "261117");
}

test("roteiro: grava em arquivo próprio, sem approved, com a janela e as queries dadas", async () => {
  const dir = emptyEdition();
  const calls: string[] = [];
  const r = await researchAndWrite(
    { fetch: okFetch(calls), now: () => NOW, warn: () => {}, credentials: CREDS },
    {
      editionDir: dir,
      approvedPath: join(dir, "_internal", "01-approved.json"),
      roteiro: { title: "Deepfake de médico vende cura falsa" },
      queryOverrides: ["Drauzio deepfake", "médicos criados por IA golpe"],
      days: DEFAULT_ROTEIRO_RESEARCH_DAYS,
    },
  );
  assert.equal(r.status, "ok");
  assert.equal(r.edition, "261117");
  assert.deepEqual(r.d1, { title: "Deepfake de médico vende cura falsa", url: "" });
  assert.deepEqual(r.queries, ["Drauzio deepfake", "médicos criados por IA golpe"]);
  assert.equal(r.videos[0].title, "Drauzio alerta: golpe com médicos criados por IA");
  const search = calls.find((u) => u.includes("/search?"))!;
  assert.match(search, /publishedAfter=2026-10-16T12%3A00%3A00Z/, "janela de 30 dias");
  assert.ok(existsSync(join(dir, YOUTUBE_TITLE_RESEARCH_ROTEIRO_FILE)));
  assert.ok(!existsSync(join(dir, YOUTUBE_TITLE_RESEARCH_FILE)), "nunca grava no arquivo do D1");
});

test("roteiro: não sobrescreve a pesquisa do D1 do Stage 2", async () => {
  const dir = emptyEdition();
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const d1Path = join(dir, YOUTUBE_TITLE_RESEARCH_FILE);
  writeFileSync(d1Path, '{"d1":{"title":"D1","url":"https://x/d1"}}\n');
  await researchAndWrite(
    { fetch: okFetch([]), now: () => NOW, warn: () => {}, credentials: CREDS },
    { editionDir: dir, approvedPath: join(dir, "nao-existe.json"), roteiro: { title: "Drauzio falso", url: "https://x/d1" } },
  );
  assert.equal(readFileSync(d1Path, "utf8"), '{"d1":{"title":"D1","url":"https://x/d1"}}\n');
  assert.equal(researchOutPath(dir, true), join(dir, YOUTUBE_TITLE_RESEARCH_ROTEIRO_FILE));
  assert.equal(researchOutPath(dir, false), d1Path);
});

test("roteiro: sem credencial é fail-soft (skipped no arquivo do roteiro, sem rede)", async () => {
  const dir = emptyEdition();
  const calls: string[] = [];
  const r = await researchAndWrite(
    { fetch: okFetch(calls), now: () => NOW, warn: () => {}, credentials: { credentials: null, missing: ["YOUTUBE_REFRESH_TOKEN"] } },
    { editionDir: dir, approvedPath: join(dir, "x.json"), roteiro: { title: "Drauzio falso" } },
  );
  assert.equal(r.status, "skipped");
  assert.equal(calls.length, 0);
  const saved = JSON.parse(readFileSync(join(dir, YOUTUBE_TITLE_RESEARCH_ROTEIRO_FILE), "utf8"));
  assert.match(saved.reason, /YOUTUBE_REFRESH_TOKEN/);
});

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
}

test("CLI: --title não combina com --approved/--gate-block; --url exige --title (exit 2, sem rede)", () => {
  const dir = emptyEdition();
  for (const args of [
    ["--edition-dir", dir, "--title", "X", "--approved", "a.json"],
    ["--edition-dir", dir, "--title", "X", "--gate-block"],
    ["--edition-dir", dir, "--title"],
    ["--edition-dir", dir, "--url", "https://x"],
  ]) {
    const r = runCli(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
  }
  assert.ok(!existsSync(join(dir, "_internal")), "nada gravado em uso inválido");
});
