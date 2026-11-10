/**
 * test/stage5-youtube-step-10659.test.ts (#10659, #12588)
 *
 * Regressão do 261026: a Etapa 5 rodou com consent `youtube: auto` e o
 * §5b-youtube não rodou, sem nada acusar. O passo é `scripts/stage5-youtube.ts`
 * (grava sempre `05-youtube-step.json`) e a invariante `youtube-step-ran`
 * acusa a ausência.
 *
 * #12588: o passo virou SÓ LEITURA. A Etapa 5 nunca busca nem sobe vídeo (o
 * 2º caminho de upload causou #11297, #12122 e #12287): quem sobe o horizontal
 * é só o `/diaria-publica-video`, depois do "pode publicar".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkYouTubeStepRan, STAGE_5_RULES } from "../scripts/lib/invariant-checks/stage-5.ts";
import { consentAllowsYouTube, decideYouTubeStep, pastedVideoUrl, youtubeStepLevel, YOUTUBE_STEP_FILE } from "../scripts/stage5-youtube.ts";

const ROOT = resolve(import.meta.dirname, "..");

function edition(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "s5yt-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

describe("#11222 link no D1 (05-video-url.txt)", () => {
  it("pastedVideoUrl: com 05-video-url.txt devolve o link normalizado; vazio/ausente = null", () => {
    const withLink = edition({ "_internal/05-video-url.txt": "https://www.youtube.com/watch?v=dQw4w9WgXcQ\n" });
    const empty = edition({ "_internal/05-video-url.txt": "  \n" });
    const none = edition({});
    try {
      assert.deepEqual(pastedVideoUrl(withLink), { url: "https://youtu.be/dQw4w9WgXcQ" });
      assert.equal(pastedVideoUrl(empty), null);
      assert.equal(pastedVideoUrl(none), null);
    } finally {
      for (const d of [withLink, empty, none]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("#11297: arquivo com conteúdo que não é link do YouTube vira invalid (nunca url crua)", () => {
    const junk = edition({ "_internal/05-video-url.txt": "colar aqui depois\n" });
    try {
      const r = pastedVideoUrl(junk);
      assert.ok(r && "invalid" in r, `esperava invalid, veio ${JSON.stringify(r)}`);
    } finally {
      rmSync(junk, { recursive: true, force: true });
    }
  });
});

describe("#12588 decideYouTubeStep: só lê a pasta, nunca sobe", () => {
  it("link válido → already-published (info)", () => {
    const dir = edition({ "_internal/05-video-url.txt": "https://youtu.be/14SLJsdrjqE\n" });
    try {
      const r = decideYouTubeStep(dir, "261110");
      assert.equal(r.outcome, "already-published");
      assert.equal(r.video_url, "https://youtu.be/14SLJsdrjqE");
      assert.equal(youtubeStepLevel(r), "info");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-video.json vence o link (#11125) → no-video-marked", () => {
    const dir = edition({ "_internal/05-video-url.txt": "https://youtu.be/14SLJsdrjqE\n", "_internal/no-video.json": "{}" });
    try {
      assert.equal(decideYouTubeStep(dir, "261110").outcome, "no-video-marked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--skip youtube sem link → consent-off (info, não bloqueia)", () => {
    const dir = edition({ "_internal/05-publish-consent.json": JSON.stringify({ youtube: "manual" }) });
    try {
      const r = decideYouTubeStep(dir, "261110");
      assert.equal(r.outcome, "consent-off");
      assert.equal(r.blocking, false);
      assert.equal(r.d1_link, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("revisão #12597: --skip youtube com link gravado → already-published (o link vai, os publishers não leem o consent)", () => {
    const dir = edition({
      "_internal/05-publish-consent.json": JSON.stringify({ youtube: "manual" }),
      "_internal/05-video-url.txt": "https://youtu.be/14SLJsdrjqE\n",
    });
    try {
      const r = decideYouTubeStep(dir, "261110");
      assert.equal(r.outcome, "already-published");
      assert.equal(r.d1_link, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cenário do #12588: mp4 no disco e nada mais → missing-link (warn), sem upload", () => {
    const dir = edition({ "diaria-comentada-261110.mp4": "video" });
    try {
      const r = decideYouTubeStep(dir, "261110");
      assert.equal(r.outcome, "missing-link");
      assert.equal(youtubeStepLevel(r), "warn");
      assert.equal(r.blocking, true);
      assert.match(r.detail ?? "", /\/diaria-publica 261110/);
      assert.match(r.detail ?? "", /set-d1-no-video\.ts 261110/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vídeo registrado sem link liberado → missing-link apontando o link-video-d1", () => {
    const dir = edition({ "_internal/05-youtube-published.json": "{}" });
    try {
      const r = decideYouTubeStep(dir, "261110");
      assert.equal(r.outcome, "missing-link");
      assert.match(r.detail ?? "", /link-video-d1\.ts 261110 --save/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("link inválido → needs-editor (warn)", () => {
    const dir = edition({ "_internal/05-video-url.txt": "colar aqui\n" });
    try {
      const r = decideYouTubeStep(dir, "261110");
      assert.equal(r.outcome, "needs-editor");
      assert.equal(youtubeStepLevel(r), "warn");
      assert.equal(r.blocking, true);
      assert.equal(r.d1_link, false, "arquivo inválido não é link no D1");
      assert.match(r.detail ?? "", /link-video-d1\.ts 261110 --save --video-url URL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o fonte não chama mais fetch-drive-video nem publish-youtube", () => {
    const src = readFileSync(join(ROOT, "scripts", "stage5-youtube.ts"), "utf8");
    assert.doesNotMatch(src, /spawnSync|runTsx|"scripts\/fetch-drive-video\.ts"|"scripts\/publish-youtube\.ts"/);
  });

  it("CLI: as flags do upload antigo são recusadas (exit 2) e nada é gravado", () => {
    // `--flag valor` cai em `values` no parseArgs: também tem que ser recusada.
    for (const extra of [["--upload-from-final"], ["--ignore-pending-approval"], ["--ignore-pending-approval", "sim"]]) {
      const dir = edition({});
      try {
        const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "stage5-youtube.ts"), "--edition-dir", dir, ...extra, "261110"], {
          encoding: "utf8",
          cwd: ROOT,
        });
        assert.equal(r.status, 2, r.stderr);
        assert.match(r.stderr, /#12588/);
        assert.throws(() => readFileSync(join(dir, YOUTUBE_STEP_FILE)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("CLI: sem link grava o registro e sai 3 (2ª barreira antes do dispatch social)", () => {
    const dir = edition({ "_internal/05-publish-consent.json": JSON.stringify({ youtube: "auto" }) });
    try {
      const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "stage5-youtube.ts"), "261110", "--edition-dir", dir], {
        encoding: "utf8",
        cwd: ROOT,
      });
      assert.equal(r.status, 3, r.stderr);
      const rec = JSON.parse(readFileSync(join(dir, YOUTUBE_STEP_FILE), "utf8"));
      assert.equal(rec.outcome, "missing-link");
      assert.equal(rec.d1_link, false);
      assert.equal(rec.blocking, true);
      assert.match(r.stderr, /\[halt\] YouTube/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("revisão #12597: retry de canal depois da Etapa 5 não bloqueia", () => {
  it("sem link mas com .step-5-done.json → missing-link sem blocking; CLI sai 0", () => {
    const dir = edition({ "_internal/.step-5-done.json": "{}" });
    try {
      const r = decideYouTubeStep(dir, "261110");
      assert.equal(r.outcome, "missing-link");
      assert.equal(r.blocking, false);
      assert.match(r.detail ?? "", /retry de canal/);
      const cli = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "stage5-youtube.ts"), "261110", "--edition-dir", dir], { encoding: "utf8", cwd: ROOT });
      assert.equal(cli.status, 0, cli.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("invariante youtube-step-ran", () => {
  it("o cenário da 261026 (consent auto, sem registro do passo) acusa warning", () => {
    const dir = edition({ "_internal/05-publish-consent.json": JSON.stringify({ youtube: "auto" }) });
    try {
      const v = checkYouTubeStepRan(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /stage5-youtube\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chave youtube ausente conta como auto", () => {
    const dir = edition({ "_internal/05-publish-consent.json": JSON.stringify({ newsletter: "auto" }) });
    try {
      assert.equal(checkYouTubeStepRan(dir).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [label, files] of [
    ["registro do passo", { [YOUTUBE_STEP_FILE]: "{}" }],
    ["upload pelo /diaria-publica-video", { "_internal/05-youtube-published.json": "{}" }],
  ] as const) {
    it(`passa com ${label}`, () => {
      const dir = edition({ "_internal/05-publish-consent.json": JSON.stringify({ youtube: "auto" }), ...files });
      try {
        assert.deepEqual(checkYouTubeStepRan(dir), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("consent manual/skipped ou sem consent: não acusa", () => {
    const cases: Array<Record<string, string>> = [
      { "_internal/05-publish-consent.json": JSON.stringify({ youtube: "manual" }) },
      { "_internal/05-publish-consent.json": JSON.stringify({ youtube: "skipped" }) },
      {},
    ];
    for (const files of cases) {
      const dir = edition(files);
      try {
        assert.deepEqual(checkYouTubeStepRan(dir), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("registrada no Stage 5, só pós-dispatch", () => {
    const rule = STAGE_5_RULES.find((r) => r.id === "youtube-step-ran");
    assert.ok(rule);
    assert.equal(rule!.postDispatchOnly, true);
  });
});

describe("stage5-youtube.ts (miolo puro)", () => {
  it("consent: arquivo ausente/ilegível = auto; manual/skipped desligam", () => {
    assert.equal(consentAllowsYouTube(null).enabled, true);
    assert.equal(consentAllowsYouTube("{").enabled, true);
    assert.equal(consentAllowsYouTube(JSON.stringify({ youtube: "manual" })).enabled, false);
    assert.equal(consentAllowsYouTube(JSON.stringify({ youtube: "skipped" })).enabled, false);
    assert.equal(consentAllowsYouTube(JSON.stringify({ youtube: "auto" })).enabled, true);
  });

  it("o playbook do Stage 5 chama o comando único e nunca o upload", () => {
    const md = readFileSync(resolve(ROOT, ".claude/agents/orchestrator-stage-5.md"), "utf8");
    assert.match(md, /npx tsx scripts\/stage5-youtube\.ts \{AAMMDD\} --edition-dir \{EDITION_DIR\}/);
    assert.doesNotMatch(md, /publish-youtube\.ts \{AAMMDD\} --upload/);
    assert.doesNotMatch(md, /--upload-from-final|--ignore-pending-approval/);
  });
});
