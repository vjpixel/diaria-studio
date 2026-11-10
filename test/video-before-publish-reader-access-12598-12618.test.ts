/**
 * #12598 — o pré-requisito do vídeo da Etapa 5 confere se o vídeo do link
 * ABRE para o leitor (estado relido do registro do upload), não só se o
 * arquivo do link existe. Só avisa (`link-may-not-open`, não bloqueia).
 *
 * #12618 — com a edição marcada sem vídeo, o gate confere que o marcador foi
 * aplicado: sem `d1_play` em `06-public-images.json` e sem a imagem com o
 * convite em `_internal/newsletter-final.html`. Sobrou algo → bloqueia
 * (`no-video-stale`) com os comandos de upload e re-render.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assessVideoBeforePublish,
  BLOCKING_STATUSES,
  noVideoLeftovers,
  STAGE5_DONE_FILE,
} from "../scripts/lib/diaria/video-before-publish.ts";
import { decideYouTubeStep, youtubeStepLevel } from "../scripts/stage5-youtube.ts";
import { D1_INVITE_TEXT } from "../scripts/lib/diaria/d1-video-hero.ts";

const VIDEO_ID = "QRbXMprk9o0";
const LINK = `https://youtu.be/${VIDEO_ID}`;
// D1 da edição 261111: post às 12:00 BRT (valor fixo do teste, não do config).
const D1_SLOT = new Date("2026-11-11T15:00:00.000Z");
const NOW = new Date("2026-11-10T22:00:00.000Z");

function edition(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "video-reader-access-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function record(status: { privacyStatus: string; publishAt?: string | null; uploadStatus?: string }, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    aammdd: "261111",
    videoId: VIDEO_ID,
    url: LINK,
    state: "stale-do-upload",
    rereadStatus: { uploadStatus: "processed", ...status },
    audit_blocked: false,
    ...extra,
  });
}

function withDir<T>(files: Record<string, string>, fn: (dir: string) => T): T {
  const dir = edition(files);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#12598: link pronto, mas o vídeo pode não abrir para o leitor", () => {
  it("vídeo privado sem agendamento (draft) → link-may-not-open, avisa e NÃO bloqueia", () => {
    withDir(
      {
        "_internal/05-video-url.txt": `${LINK}\n`,
        "_internal/05-youtube-published.json": record({ privacyStatus: "private", publishAt: null }),
      },
      (dir) => {
        const r = assessVideoBeforePublish(dir, "261111", { now: NOW, d1SlotAt: D1_SLOT });
        assert.equal(r.status, "link-may-not-open");
        assert.equal(r.blocking, false);
        assert.equal(r.videoUrl, LINK, "o link continua indo para o D1");
        assert.match(r.warning ?? "", /pode não abrir para o leitor/);
        assert.match(r.warning ?? "", /privado sem agendamento/);
        assert.match(r.warning ?? "", /YouTube Studio/);
        assert.equal(BLOCKING_STATUSES.has("link-may-not-open"), false);
      },
    );
  });

  it("agendado DEPOIS do post do D1 (projeto auditado) → link-may-not-open", () => {
    withDir(
      {
        "_internal/05-video-url.txt": `${LINK}\n`,
        "_internal/05-youtube-published.json": record({ privacyStatus: "private", publishAt: "2026-11-11T20:00:00.000Z" }),
      },
      (dir) => {
        const r = assessVideoBeforePublish(dir, "261111", { now: NOW, d1SlotAt: D1_SLOT });
        assert.equal(r.status, "link-may-not-open");
        assert.match(r.warning ?? "", /DEPOIS do post do D1/);
      },
    );
  });

  it("público ou agendado antes do D1 → link-ready, sem aviso", () => {
    for (const status of [{ privacyStatus: "public" }, { privacyStatus: "private", publishAt: "2026-11-11T09:00:00.000Z" }]) {
      withDir(
        { "_internal/05-video-url.txt": `${LINK}\n`, "_internal/05-youtube-published.json": record(status) },
        (dir) => {
          const r = assessVideoBeforePublish(dir, "261111", { now: NOW, d1SlotAt: D1_SLOT });
          assert.equal(r.status, "link-ready", JSON.stringify(status));
          assert.equal(r.warning, null);
        },
      );
    }
  });

  it("relê o estado com o relógio de agora (#573), não confia no `state` gravado no upload", () => {
    // `state` gravado diz published, mas o rereadStatus é privado sem agendamento.
    withDir(
      {
        "_internal/05-video-url.txt": `${LINK}\n`,
        "_internal/05-youtube-published.json": record({ privacyStatus: "private", publishAt: null }, { state: "published" }),
      },
      (dir) => assert.equal(assessVideoBeforePublish(dir, "261111", { now: NOW, d1SlotAt: D1_SLOT }).status, "link-may-not-open"),
    );
  });

  it("link de OUTRO vídeo (colado à mão) não é conferido contra o registro", () => {
    withDir(
      {
        "_internal/05-video-url.txt": "https://youtu.be/AAAAAAAAAAA\n",
        "_internal/05-youtube-published.json": record({ privacyStatus: "private", publishAt: null }),
      },
      (dir) => assert.equal(assessVideoBeforePublish(dir, "261111", { now: NOW, d1SlotAt: D1_SLOT }).status, "link-ready"),
    );
  });

  it("registro ilegível não lança: avisa que não deu para conferir", () => {
    withDir({ "_internal/05-video-url.txt": `${LINK}\n`, "_internal/05-youtube-published.json": "{ruim" }, (dir) => {
      const r = assessVideoBeforePublish(dir, "261111", { now: NOW, d1SlotAt: D1_SLOT });
      assert.equal(r.status, "link-may-not-open");
      assert.equal(r.blocking, false);
      assert.match(r.warning ?? "", /não deu para conferir/);
    });
  });

  it("§5b-youtube: d1_link sim, nível warn, e o detail leva o aviso para o resumo", () => {
    withDir(
      {
        "_internal/05-video-url.txt": `${LINK}\n`,
        "_internal/05-youtube-published.json": record({ privacyStatus: "private", publishAt: null }),
      },
      (dir) => {
        const step = decideYouTubeStep(dir, "261111");
        assert.equal(step.outcome, "already-published");
        assert.equal(step.d1_link, true);
        assert.equal(step.blocking, false);
        assert.equal(step.video_may_not_open, true);
        assert.equal(youtubeStepLevel(step), "warn");
        assert.match(step.detail ?? "", /pode não abrir para o leitor/);
      },
    );
  });
});

describe("#12618: edição marcada sem vídeo, com o convite do vídeo ainda na edição", () => {
  const marker = { "_internal/no-video.json": JSON.stringify({ no_video: true }) };
  const cacheWithPlay = JSON.stringify({ images: { cover: { url: "https://img/cover.jpg" }, d1_play: { url: "https://img/d1-play.jpg" } } });
  const cacheClean = JSON.stringify({ images: { cover: { url: "https://img/cover.jpg" } } });
  const htmlWithPlay = `<a href="https://youtu.be/x"><img src="https://img/d1-play.jpg" alt="Título. ${D1_INVITE_TEXT}."></a>`;
  const htmlClean = `<img src="https://img/cover.jpg" alt="Título">`;

  it("só o set-d1-no-video (d1_play no cache e convite no HTML) → no-video-stale BLOQUEIA com os comandos", () => {
    withDir({ ...marker, "06-public-images.json": cacheWithPlay, "_internal/newsletter-final.html": htmlWithPlay }, (dir) => {
      const r = assessVideoBeforePublish(dir, "261111");
      assert.equal(r.status, "no-video-stale");
      assert.equal(r.blocking, true);
      assert.match(r.warning ?? "", /chave d1_play/);
      assert.match(r.warning ?? "", /newsletter-final\.html ainda leva/);
      assert.match(r.warning ?? "", /upload-images-public\.ts --edition-dir .* --mode newsletter/);
      assert.match(r.warning ?? "", /render-newsletter-html\.ts/);
      assert.match(r.warning ?? "", /substitute-image-urls\.ts/);
    });
  });

  it("upload feito mas HTML não re-renderizado → bloqueia só pelo HTML", () => {
    withDir({ ...marker, "06-public-images.json": cacheClean, "_internal/newsletter-final.html": htmlWithPlay }, (dir) => {
      const r = assessVideoBeforePublish(dir, "261111");
      assert.equal(r.status, "no-video-stale");
      assert.doesNotMatch(r.warning ?? "", /chave d1_play/);
      assert.match(r.warning ?? "", /newsletter-final\.html/);
    });
  });

  it("HTML pela URL do d1_play (sem o texto do convite no alt) também acusa", () => {
    withDir(
      { ...marker, "06-public-images.json": cacheWithPlay, "_internal/newsletter-final.html": `<img src="https://img/d1-play.jpg" alt="x">` },
      (dir) => assert.equal(noVideoLeftovers(dir).length, 2),
    );
  });

  it("marcador aplicado (cache e HTML limpos) → no-video-marked, não bloqueia", () => {
    withDir({ ...marker, "06-public-images.json": cacheClean, "_internal/newsletter-final.html": htmlClean }, (dir) => {
      const r = assessVideoBeforePublish(dir, "261111");
      assert.equal(r.status, "no-video-marked");
      assert.equal(r.blocking, false);
    });
  });

  it("sem cache nem HTML no disco → nada a acusar (no-video-marked)", () => {
    withDir(marker, (dir) => assert.equal(assessVideoBeforePublish(dir, "261111").status, "no-video-marked"));
  });

  it("cache ilegível acusa (não dá para confirmar que d1_play saiu)", () => {
    withDir({ ...marker, "06-public-images.json": "{ruim" }, (dir) => {
      const r = assessVideoBeforePublish(dir, "261111");
      assert.equal(r.status, "no-video-stale");
      assert.match(r.warning ?? "", /ilegível/);
    });
  });

  it("retry de canal com a Etapa 5 concluída não bloqueia", () => {
    withDir({ ...marker, "06-public-images.json": cacheWithPlay, [STAGE5_DONE_FILE]: "{}" }, (dir) => {
      const r = assessVideoBeforePublish(dir, "261111");
      assert.equal(r.status, "no-video-stale");
      assert.equal(r.blocking, false);
    });
  });

  it("§5b-youtube: no-video-stale é outcome próprio, bloqueia, nível warn, sem link no D1", () => {
    withDir({ ...marker, "06-public-images.json": cacheWithPlay }, (dir) => {
      const step = decideYouTubeStep(dir, "261111");
      assert.equal(step.outcome, "no-video-stale");
      assert.equal(step.blocking, true);
      assert.equal(step.d1_link, false);
      assert.equal(youtubeStepLevel(step), "warn");
    });
  });
});
