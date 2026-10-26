/**
 * test/publish-youtube-already-on-channel-11080.test.ts (#11080)
 *
 * O editor sobe o vídeo do dia à mão no Studio (sem `05-youtube-published.json`);
 * o `--upload` do Stage 5 não pode agendar um SEGUNDO vídeo. A conferência lê os
 * uploads recentes do canal (fetch mockado, nenhuma rede) antes de abrir a sessão.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchEditionVideo, editionDayWindowMs, YOUTUBE_PUBLISHED_FILE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import { planYouTubePublish, runYouTubeUpload } from "../scripts/publish-youtube.ts";

const REVIEWED_MD = `DESTAQUE 1 | SEGURANÇA
IA ladra? O cofre que o modelo abriu
https://fonte.exemplo.com/artigo

Pesquisadores mostraram que um agente conseguiu abrir o cofre sem senha.

Por que isso importa:
Porque sim.
`;
const ENV = {
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
  YOUTUBE_REFRESH_TOKEN: "refresh",
  YOUTUBE_CHANNEL_ID: "UCSsppeUnBy6q-4a5hsl5u0w",
};
const NOW = new Date("2026-10-21T23:00:00Z");
const MANUAL_ID = "manualVid01";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Canal com `videos` (resposta de videos.list); registra cada chamada. */
function channelDeps(videos: unknown[], opts: { playlistStatus?: number } = {}) {
  const calls: string[] = [];
  const deps: YouTubeUploadDeps = {
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "tok" });
      if (url.includes("/youtube/v3/channels")) return json(200, { items: [{ id: ENV.YOUTUBE_CHANNEL_ID }] });
      if (url.includes("/youtube/v3/playlistItems")) {
        if (opts.playlistStatus) return json(opts.playlistStatus, { error: "boom" });
        return json(200, { items: videos.map((v) => ({ contentDetails: { videoId: (v as { id: string }).id } })) });
      }
      if (url.includes("/youtube/v3/videos?part=snippet,status")) return json(200, { items: videos });
      if (url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { Location: "https://up/sess" } });
      if (url === "https://up/sess") return json(200, { id: "newVid", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: "2026-10-22T09:00:00.000Z" } });
      if (url.includes("/youtube/v3/videos?part=status")) return json(200, { items: [{ id: "newVid", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: "2026-10-22T09:00:00.000Z" } }] });
      throw new Error(`rota não mockada: ${url}`);
    },
  };
  return { deps, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yt-11080-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function plan() {
  const videoPath = join(dir, "diaria-comentada-261022.mp4");
  writeFileSync(videoPath, Buffer.from("fake"));
  return planYouTubePublish({
    aammdd: "261022",
    reviewedMd: REVIEWED_MD,
    now: NOW,
    episode: 2,
    editionUrl: "https://diar.ia.br/p/ia-ladra",
    video: { path: videoPath, exists: true, sizeBytes: 4 },
    thumb: { path: join(dir, "04-youtube-thumb.jpg"), exists: false },
  });
}

async function run(deps: YouTubeUploadDeps, p = plan(), force = false, acceptPeriodMatch: boolean | string = false) {
  const logs: string[] = [];
  const outcome = await runYouTubeUpload(deps, {
    plan: p,
    editionDir: dir,
    env: ENV,
    force,
    acceptPeriodMatch,
    readFile: (f) => readFileSync(f),
    log: (l) => logs.push(l),
  });
  return { outcome, logs };
}

const manualVideo = (over: Record<string, unknown> = {}) => ({
  id: MANUAL_ID,
  snippet: { title: "Um título qualquer feito à mão", description: "sem utm", tags: [], publishedAt: "2026-10-21T20:00:00Z" },
  status: { uploadStatus: "processed", privacyStatus: "private", publishAt: "2026-10-22T09:00:00.000Z" },
  ...over,
});

describe("--upload com o vídeo da edição já no canal (#11080)", () => {
  it("vídeo manual agendado para o dia da edição, aceito pelo editor (--accept-period-match): não sobe, reconhece e grava o registro", async () => {
    const { deps, calls } = channelDeps([manualVideo()]);
    const { outcome, logs } = await run(deps, plan(), false, MANUAL_ID);
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.equal(outcome.skipped, true);
    assert.equal(outcome.record?.videoId, MANUAL_ID);
    assert.equal(outcome.record?.source, "already-on-channel");
    assert.equal(outcome.record?.matched_by, "period");
    assert.equal(outcome.record?.period_match_accepted, true);
    assert.equal(outcome.record?.state, "scheduled");
    assert.ok(logs.some((l) => l.includes("already-on-channel")));
    // Nenhum byte enviado: nem sessão resumable nem PUT.
    assert.equal(calls.some((c) => c.includes("uploadType=resumable") || c.startsWith("PUT")), false);
    const onDisk = JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"));
    assert.equal(onDisk.videoId, MANUAL_ID);
    assert.equal(onDisk.source, "already-on-channel");
    // Link do D1 gravado a partir do vídeo existente.
    assert.equal(readFileSync(join(dir, "_internal/05-video-url.txt"), "utf8").trim(), `https://youtu.be/${MANUAL_ID}`);
  });

  it("#11147: lista todos e aceita o ID escolhido mesmo com ordem diferente", async () => {
    const live = manualVideo({ id: "liveVideo02" });
    const first = channelDeps([live, manualVideo()]);
    const refused = await run(first.deps, plan(), false, true);
    assert.equal(refused.outcome.exitCode, 1);
    for (const id of ["liveVideo02", MANUAL_ID]) assert.ok(refused.logs.join("\n").includes(id));
    assert.equal(existsSync(join(dir, YOUTUBE_PUBLISHED_FILE)), false);
    const second = channelDeps([manualVideo(), live]);
    const accepted = await run(second.deps, plan(), false, "liveVideo02");
    assert.equal(accepted.outcome.record?.videoId, "liveVideo02");
    assert.equal(readFileSync(join(dir, "_internal/05-video-url.txt"), "utf8").trim(), "https://youtu.be/liveVideo02");
    assert.equal(second.calls.some((c) => c.includes("uploadType=resumable") || c.startsWith("PUT")), false);
  });

  it("#11147: ID ausente ou inválido não aceita outro candidato nem inicia upload", async () => {
    for (const videos of [[manualVideo()], []]) {
      const { deps, calls } = channelDeps(videos);
      const { outcome } = await run(deps, plan(), false, "missingVideo");
      assert.equal(outcome.exitCode, 1);
      assert.equal(existsSync(join(dir, YOUTUBE_PUBLISHED_FILE)), false);
      assert.equal(existsSync(join(dir, "_internal/05-video-url.txt")), false);
      assert.equal(calls.some((c) => c.includes("uploadType=resumable") || c.startsWith("PUT")), false);
    }
  });

  it("#11147: CLI exige VIDEO_ID e mantém exclusão com --force/dry-run", () => {
    for (const flags of [
      ["--upload", "--accept-period-match"],
      ["--upload", "--accept-period-match", MANUAL_ID, "--force"],
      ["--dry-run", "--accept-period-match", MANUAL_ID],
    ]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/publish-youtube.ts", "261022", ...flags], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr);
      assert.ok(result.stderr.includes("exige VIDEO_ID"), result.stderr);
    }
  });

  it("segunda rodada: o registro gravado faz o --upload recusar sem nem chamar a API", async () => {
    const first = channelDeps([manualVideo()]);
    await run(first.deps, plan(), false, MANUAL_ID);
    const second = channelDeps([manualVideo()]);
    const { outcome } = await run(second.deps);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.skipped, true);
    assert.equal(second.calls.length, 0);
  });

  it("#11132: vídeo não relacionado no dia da edição (só período): exit 1, nada enviado, sem registro nem link no D1", async () => {
    const live = manualVideo({
      snippet: { title: "Live de domingo: perguntas e respostas", description: "ao vivo", tags: [], publishedAt: "2026-10-22T15:00:00Z" },
      status: { uploadStatus: "processed", privacyStatus: "public" },
    });
    const { deps, calls } = channelDeps([live]);
    const { outcome, logs } = await run(deps);
    assert.equal(outcome.exitCode, 1, logs.join("\n"));
    assert.equal(outcome.skipped, false);
    assert.equal(outcome.record, null);
    assert.equal(calls.some((c) => c.includes("uploadType=resumable") || c.startsWith("PUT")), false);
    assert.equal(existsSync(join(dir, YOUTUBE_PUBLISHED_FILE)), false);
    assert.equal(existsSync(join(dir, "_internal/05-video-url.txt")), false);
    const text = logs.join("\n");
    assert.ok(text.includes(`https://youtu.be/${MANUAL_ID}`), text);
    assert.ok(text.includes("--accept-period-match") && text.includes("--force"), text);
  });

  it("#11132: título do D1 continua valendo sem confirmação (só o período exige)", async () => {
    const byTitle = manualVideo({
      snippet: { title: "IA ladra? O cofre que o modelo abriu", description: "", tags: [], publishedAt: "2026-10-21T20:00:00Z" },
    });
    const { deps } = channelDeps([byTitle]);
    const { outcome, logs } = await run(deps);
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.equal(outcome.record?.matched_by, "title");
    assert.equal(outcome.record?.period_match_accepted, undefined);
    assert.equal(readFileSync(join(dir, "_internal/05-video-url.txt"), "utf8").trim(), `https://youtu.be/${MANUAL_ID}`);
  });

  it("canal sem vídeo da edição: sobe normalmente", async () => {
    const other = manualVideo({ snippet: { title: "Outra coisa", description: "", tags: [], publishedAt: "2026-10-10T12:00:00Z" }, status: { privacyStatus: "public" } });
    const { deps, calls } = channelDeps([other]);
    const { outcome } = await run(deps);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.skipped, false);
    assert.equal(outcome.record?.videoId, "newVid");
    assert.ok(calls.some((c) => c.includes("uploadType=resumable")));
  });

  it("--force pula a conferência e sobe de novo", async () => {
    const { deps, calls } = channelDeps([manualVideo()]);
    const { outcome } = await run(deps, plan(), true);
    assert.equal(outcome.record?.videoId, "newVid");
    assert.equal(calls.some((c) => c.includes("playlistItems")), false);
  });

  it("#11103: vídeo de OUTRA edição (utm_campaign) público no dia desta: não pula, sobe o desta", async () => {
    const yesterday = manualVideo({
      snippet: { title: "Vídeo de ontem", description: "edição: https://diar.ia.br/?utm_source=youtube&utm_medium=video&utm_campaign=261021", tags: [], publishedAt: "2026-10-22T12:00:00Z" },
      status: { uploadStatus: "processed", privacyStatus: "public" },
    });
    const { deps, calls } = channelDeps([yesterday]);
    const { outcome, logs } = await run(deps);
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.equal(outcome.skipped, false);
    assert.equal(outcome.record?.videoId, "newVid");
    assert.equal(outcome.record?.source, undefined);
    assert.ok(calls.some((c) => c.includes("uploadType=resumable")));
    assert.notEqual(readFileSync(join(dir, "_internal/05-video-url.txt"), "utf8").trim(), `https://youtu.be/${MANUAL_ID}`);
  });

  it("#11103: upload manual com uploadStatus failed/rejected não conta como já no canal", async () => {
    for (const uploadStatus of ["failed", "rejected"]) {
      rmSync(join(dir, YOUTUBE_PUBLISHED_FILE), { force: true });
      rmSync(join(dir, "_internal/05-video-url.txt"), { force: true });
      const broken = manualVideo({
        snippet: { title: "IA ladra? O cofre que o modelo abriu", description: "", tags: [], publishedAt: "2026-10-21T20:00:00Z" },
        status: { uploadStatus, privacyStatus: "private", publishAt: "2026-10-22T09:00:00.000Z" },
      });
      const { deps, calls } = channelDeps([broken]);
      const { outcome, logs } = await run(deps);
      assert.equal(outcome.skipped, false, `${uploadStatus}: ${logs.join("\n")}`);
      assert.equal(outcome.record?.videoId, "newVid", uploadStatus);
      assert.notEqual(outcome.record?.source, "already-on-channel", uploadStatus);
      assert.ok(calls.some((c) => c.includes("uploadType=resumable")), uploadStatus);
    }
  });

  it("falha ao conferir o canal: exit 1, nada enviado, sem registro", async () => {
    const { deps, calls } = channelDeps([], { playlistStatus: 500 });
    const { outcome, logs } = await run(deps);
    assert.equal(outcome.exitCode, 1);
    assert.equal(calls.some((c) => c.includes("uploadType=resumable")), false);
    assert.equal(existsSync(join(dir, YOUTUBE_PUBLISHED_FILE)), false);
    assert.ok(logs.join("\n").includes("nada foi enviado"));
  });
});

describe("matchEditionVideo (#11080)", () => {
  const crit = { aammdd: "261022", title: "IA ladra? O cofre que o modelo abriu" };
  const v = (id: string, title: string, description = "", extra: Record<string, unknown> = {}) => ({
    id,
    snippet: { title, description, tags: [], publishedAt: "2026-10-01T12:00:00Z" },
    status: { privacyStatus: "public" },
    ...extra,
  });

  it("utm_campaign=AAMMDD na descrição (nosso upload) tem prioridade", () => {
    const m = matchEditionVideo([v("a", "x", "veja ?utm_campaign=261022"), v("b", crit.title)], crit);
    assert.equal(m?.videoId, "a");
    assert.equal(m?.matchedBy, "edition-tag");
  });

  it("AAMMDD como token no título/tag casa; dígitos vizinhos não", () => {
    assert.equal(matchEditionVideo([v("a", "Edição 261022 comentada")], crit)?.matchedBy, "edition-tag");
    assert.equal(matchEditionVideo([v("a", "Código 12610229")], crit), null);
  });

  it("título igual ao do D1 casa (ignora caixa e espaços)", () => {
    assert.equal(matchEditionVideo([v("a", "  ia LADRA?  o cofre que o modelo abriu ")], crit)?.matchedBy, "title");
  });

  it("período: publishAt ou publishedAt dentro do dia BRT da edição; fora não casa", () => {
    const { startMs, endMs } = editionDayWindowMs("261022");
    assert.equal(startMs, Date.parse("2026-10-22T03:00:00Z"));
    const inside = v("a", "z", "", { status: { privacyStatus: "private", publishAt: "2026-10-22T09:00:00Z" } });
    const before = v("b", "z", "", { status: { privacyStatus: "private", publishAt: new Date(startMs - 1).toISOString() } });
    const after = v("c", "z", "", { status: { privacyStatus: "private", publishAt: new Date(endMs).toISOString() } });
    assert.equal(matchEditionVideo([inside], crit)?.matchedBy, "period");
    assert.equal(matchEditionVideo([before, after], crit), null);
  });

  it("#11103: utm_campaign de outra edição anula título e período; a nossa continua valendo", () => {
    const inDay = { status: { privacyStatus: "public", publishAt: "2026-10-22T09:00:00Z" } };
    assert.equal(matchEditionVideo([v("a", "z", "?utm_campaign=261021", inDay)], crit), null);
    assert.equal(matchEditionVideo([v("a", crit.title, "?utm_campaign=261021")], crit), null);
    // Descrição citando as duas edições: a nossa vence.
    assert.equal(matchEditionVideo([v("a", "z", "?utm_campaign=261021 e ?utm_campaign=261022")], crit)?.matchedBy, "edition-tag");
    // Dígito extra não é a nossa edição.
    assert.equal(matchEditionVideo([v("a", "z", "?utm_campaign=2610221")], crit), null);
    // utm_campaign não numérico (ex.: video-d1-AAMMDD) não é prova de outra edição.
    assert.equal(matchEditionVideo([v("a", crit.title, "?utm_campaign=video-d1-261021")], crit)?.matchedBy, "title");
  });

  it("#11103: uploadStatus failed/rejected/deleted nunca casa, nem por utm_campaign", () => {
    for (const uploadStatus of ["failed", "rejected", "deleted"]) {
      const bad = v("a", crit.title, "?utm_campaign=261022", { status: { privacyStatus: "private", uploadStatus } });
      assert.equal(matchEditionVideo([bad], crit), null, uploadStatus);
    }
    const ok = v("b", crit.title, "", { status: { privacyStatus: "private", uploadStatus: "processed" } });
    const bad = v("a", crit.title, "?utm_campaign=261022", { status: { privacyStatus: "private", uploadStatus: "failed" } });
    assert.equal(matchEditionVideo([bad, ok], crit)?.videoId, "b");
  });

  it("Short do mesmo dia não conta pelo período", () => {
    const short = v("s", "Recorte #shorts", "", { status: { privacyStatus: "public", publishAt: "2026-10-22T09:00:00Z" } });
    assert.equal(matchEditionVideo([short], crit), null);
  });
});
