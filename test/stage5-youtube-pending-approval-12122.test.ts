/**
 * test/stage5-youtube-pending-approval-12122.test.ts (#12122, #12120)
 *
 * #12122: na 261104 o `/diaria-5-publicacao` rodou em paralelo ao
 * `/diaria-publica-video`, e o `stage5-youtube.ts` achou o mp4 que a skill já
 * tinha baixado e subiu o horizontal antes do "pode publicar", com a capa
 * intermediária. Agora o `publish-youtube.ts --dry-run` grava
 * `_internal/05-youtube-pending-approval.json`, e o passo do Stage 5 não busca
 * nem subia nada enquanto ele existisse (`awaiting-approval`).
 *
 * #12588: a Etapa 5 deixou de subir vídeo; o marcador ficou só informativo
 * (o passo cita o plano pendente quando falta o link). O podcast (#12120)
 * saiu do passo junto com o upload: vive no `publish-youtube.ts --upload`.
 *
 * Nenhum teste toca a rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  YOUTUBE_PENDING_APPROVAL_FILE,
  clearPendingApproval,
  describePendingApproval,
  readPendingApproval,
  writePendingApproval,
} from "../scripts/lib/diaria/youtube-pending-approval.ts";
import { markPendingApprovalAfterDryRun } from "../scripts/publish-youtube.ts";
import { YOUTUBE_STEP_FILE } from "../scripts/stage5-youtube.ts";
import { D1_VIDEO_URL_FILE } from "../scripts/lib/diaria/d1-video-link.ts";
import { YOUTUBE_PUBLISHED_FILE } from "../scripts/lib/diaria/youtube-upload.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AAMMDD = "261104";
const NOW = new Date("2026-11-04T03:40:00Z");

const REVIEWED_MD = `DESTAQUE 1 | SEGURANÇA
IA ladra? O cofre que o modelo abriu
https://fonte.exemplo.com/artigo

Pesquisadores mostraram que um agente conseguiu abrir o cofre sem senha.

Por que isso importa:
Porque sim.
`;

function tmpEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "yt-pending-12122-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

const DONE_RECORD = JSON.stringify({ aammdd: AAMMDD, videoId: "14SLJsdrjqE", url: "https://youtu.be/14SLJsdrjqE", state: "scheduled" });

describe("#12122 marcador de confirmação pendente (lib)", () => {
  it("grava, lê e apaga; o leitor é da mesma edição", () => {
    const dir = tmpEdition();
    try {
      assert.equal(readPendingApproval(dir, AAMMDD).kind, "none");
      writePendingApproval(dir, AAMMDD, NOW);
      const r = readPendingApproval(dir, AAMMDD);
      assert.equal(r.kind, "pending");
      assert.equal(r.kind === "pending" ? r.marker.at : "", NOW.toISOString());
      assert.equal(clearPendingApproval(dir), true);
      assert.equal(readPendingApproval(dir, AAMMDD).kind, "none");
      assert.equal(clearPendingApproval(dir), false, "apagar de novo é no-op");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ilegível ou de outra edição conta como presente (unreadable)", () => {
    const dir = tmpEdition();
    try {
      writeFileSync(join(dir, YOUTUBE_PENDING_APPROVAL_FILE), "{ quebrado");
      assert.equal(readPendingApproval(dir, AAMMDD).kind, "unreadable");
      writePendingApproval(dir, "261103", NOW);
      const r = readPendingApproval(dir, AAMMDD);
      assert.equal(r.kind, "unreadable");
      assert.match(describePendingApproval(r as Exclude<typeof r, { kind: "none" }>, AAMMDD), /set-d1-no-video\.ts 261104/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12122 publish-youtube --dry-run grava o marcador", () => {
  const log: string[] = [];
  it("edição sem vídeo no canal: grava", () => {
    const dir = tmpEdition();
    try {
      assert.equal(markPendingApprovalAfterDryRun(dir, AAMMDD, NOW, (l) => log.push(l)), true);
      assert.equal(readPendingApproval(dir, AAMMDD).kind, "pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vídeo já registrado ou link já colado: não grava (não há confirmação pendente)", () => {
    const a = tmpEdition();
    const b = tmpEdition();
    try {
      writeFileSync(join(a, YOUTUBE_PUBLISHED_FILE), DONE_RECORD);
      assert.equal(markPendingApprovalAfterDryRun(a, AAMMDD, NOW, () => {}), false);
      writeFileSync(join(b, D1_VIDEO_URL_FILE), "https://youtu.be/14SLJsdrjqE\n");
      assert.equal(markPendingApprovalAfterDryRun(b, AAMMDD, NOW, () => {}), false);
      assert.equal(existsSync(join(a, YOUTUBE_PENDING_APPROVAL_FILE)) || existsSync(join(b, YOUTUBE_PENDING_APPROVAL_FILE)), false);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("upload em estado incerto (in_progress) grava: na dúvida, segura o Stage 5", () => {
    const dir = tmpEdition();
    try {
      writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), JSON.stringify({ aammdd: AAMMDD, status: "in_progress", at: NOW.toISOString() }));
      assert.equal(markPendingApprovalAfterDryRun(dir, AAMMDD, NOW, () => {}), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI: o dry-run real grava o marcador na pasta da edição", () => {
    const dir = tmpEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_MD);
      // Capa presente: o dry-run não sonda o ambiente da capa (check-video-env).
      writeFileSync(join(dir, "04-youtube-thumb.jpg"), "x");
      const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "publish-youtube.ts"), AAMMDD, "--dry-run", "--edition-dir", dir, "--no-captions"], {
        encoding: "utf8",
        cwd: ROOT,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readPendingApproval(dir, AAMMDD).kind, "pending", r.stderr);
      assert.match(r.stderr, /#12122/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12588 stage5-youtube.ts com o marcador: só cita o plano pendente, nunca sobe", () => {
  const run = (dir: string) =>
    spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "stage5-youtube.ts"), AAMMDD, "--edition-dir", dir], {
      encoding: "utf8",
      cwd: ROOT,
    });

  it("cenário da 261104: mp4 baixado pela skill + marcador → missing-link citando o pode publicar, mp4 intacto", () => {
    const dir = tmpEdition();
    try {
      writeFileSync(join(dir, "diaria-comentada-261104.mp4"), "video");
      writeFileSync(join(dir, "_internal", "05-publish-consent.json"), JSON.stringify({ youtube: "auto" }));
      writePendingApproval(dir, AAMMDD, NOW);
      const r = run(dir);
      assert.equal(r.status, 0, r.stderr);
      const rec = JSON.parse(readFileSync(join(dir, YOUTUBE_STEP_FILE), "utf8"));
      assert.equal(rec.outcome, "missing-link");
      assert.equal(rec.upload_exit, undefined, "o upload não existe mais");
      assert.match(rec.detail, /pode publicar/);
      assert.ok(existsSync(join(dir, "diaria-comentada-261104.mp4")), "o mp4 da skill fica intacto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("link já colado vence o marcador (already-published)", () => {
    const dir = tmpEdition();
    try {
      writePendingApproval(dir, AAMMDD, NOW);
      writeFileSync(join(dir, D1_VIDEO_URL_FILE), "https://youtu.be/14SLJsdrjqE\n");
      const r = run(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(readFileSync(join(dir, YOUTUBE_STEP_FILE), "utf8")).outcome, "already-published");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("consent desligado vence o marcador (consent-off)", () => {
    const dir = tmpEdition();
    try {
      writePendingApproval(dir, AAMMDD, NOW);
      writeFileSync(join(dir, "_internal", "05-publish-consent.json"), JSON.stringify({ youtube: "skipped" }));
      const r = run(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(readFileSync(join(dir, YOUTUBE_STEP_FILE), "utf8")).outcome, "consent-off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12122 link-video-d1.ts --save apaga o marcador (fallback do Studio)", () => {
  it("--save com o marcador presente → apagado", () => {
    const dir = tmpEdition();
    try {
      writePendingApproval(dir, AAMMDD, NOW);
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", join(ROOT, "scripts", "link-video-d1.ts"), AAMMDD, "--edition-dir", dir, "--video-url", "https://youtu.be/14SLJsdrjqE", "--save", "--assume-public"],
        { encoding: "utf8", cwd: ROOT },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(existsSync(join(dir, YOUTUBE_PENDING_APPROVAL_FILE)), false, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
