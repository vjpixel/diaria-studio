/**
 * test/stage5-youtube-step-10659.test.ts (#10659)
 *
 * Regressão do 261026: a Etapa 5 rodou com consent `youtube: auto` e o
 * §5b-youtube não rodou (nem fetch, nem upload, nem log), sem nada acusar.
 * Agora o passo é `scripts/stage5-youtube.ts` (grava sempre
 * `05-youtube-step.json`) e a invariante `youtube-step-ran` acusa a ausência.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkYouTubeStepRan, STAGE_5_RULES } from "../scripts/lib/invariant-checks/stage-5.ts";
import { classifyFetch, consentAllowsYouTube, parseUploadStdout, pastedVideoUrl, planFromDryRun, YOUTUBE_STEP_FILE } from "../scripts/stage5-youtube.ts";

describe("#11222 link colado pelo editor (vídeo subido pelo Studio)", () => {
  it("pastedVideoUrl: com 05-video-url.txt o passo não busca nem sobe; sem ele, segue o fluxo", () => {
    const withLink = edition({ "_internal/05-video-url.txt": "https://www.youtube.com/watch?v=dQw4w9WgXcQ\n" });
    const empty = edition({ "_internal/05-video-url.txt": "  \n" });
    const none = edition({});
    try {
      // #11297: passa pelo parseD1VideoUrlFile (normaliza para youtu.be).
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

describe("#11297 horizontal de Final/ não sobe sem sinal explícito", () => {
  const dryRun = (scope: string) =>
    JSON.stringify({ action: "dry-run", selection: "found", file: { id: "x", name: "Diaria comentada_Youtube_V3.mp4", scope } });

  it("cenário da issue: dry-run acha o _Youtube_ em Final/, sem link e sem sinal → awaiting-link, sem download", () => {
    const p = planFromDryRun(0, dryRun("final-folder"), false, "261028");
    assert.equal(p.kind, "stop");
    assert.equal(p.kind === "stop" && p.outcome, "awaiting-link");
    assert.match(p.kind === "stop" ? p.detail ?? "" : "", /link-video-d1\.ts 261028 --save/);
  });

  it("com --upload-from-final, Final/ segue para o download", () => {
    assert.equal(planFromDryRun(0, dryRun("final-folder"), true).kind, "download");
  });

  it("edição sem Final/ (subpasta ou raiz) mantém o upload automático", () => {
    assert.equal(planFromDryRun(0, dryRun("edition-folder"), false).kind, "download");
    assert.equal(planFromDryRun(0, dryRun("root"), false).kind, "download");
  });

  it("exists sobe o arquivo local; none/already-published/needs-editor param como antes", () => {
    assert.equal(planFromDryRun(0, JSON.stringify({ action: "exists" }), false).kind, "upload-existing");
    const none = planFromDryRun(0, JSON.stringify({ action: "none", reason: "r" }), false);
    assert.equal(none.kind === "stop" && none.outcome, "no-video");
    const pub = planFromDryRun(0, JSON.stringify({ action: "already-published" }), false);
    assert.equal(pub.kind === "stop" && pub.outcome, "already-published");
    const amb = planFromDryRun(3, JSON.stringify({ action: "needs-editor", selection: "ambiguous" }), false);
    assert.equal(amb.kind === "stop" && amb.outcome, "needs-editor");
    const bad = planFromDryRun(1, "nada", false);
    assert.equal(bad.kind === "stop" && bad.outcome, "fetch-error");
  });
});

function edition(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "s5yt-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

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
    ["upload pelo /diaria-youtube", { "_internal/05-youtube-published.json": "{}" }],
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

  it("fetch: downloaded/exists sobem; o resto vira desfecho sem upload", () => {
    assert.equal(classifyFetch(0, JSON.stringify({ action: "downloaded" })).upload, true);
    assert.equal(classifyFetch(0, JSON.stringify({ action: "exists" })).upload, true);
    assert.equal(classifyFetch(0, JSON.stringify({ action: "already-published" })).outcome, "already-published");
    assert.equal(classifyFetch(0, JSON.stringify({ action: "none", reason: "r" })).outcome, "no-video");
    assert.equal(classifyFetch(3, JSON.stringify({ action: "needs-editor", selection: "ambiguous" })).outcome, "needs-editor");
    assert.equal(classifyFetch(1, JSON.stringify({ action: "error", error: "401" })).outcome, "fetch-error");
    assert.equal(classifyFetch(1, "boom").outcome, "fetch-error");
  });

  it("upload: lê url/state do JSON; saída vazia não lança", () => {
    assert.deepEqual(parseUploadStdout(JSON.stringify({ url: "https://youtu.be/x", state: "scheduled" })), { url: "https://youtu.be/x", state: "scheduled" });
    assert.deepEqual(parseUploadStdout(""), { url: null, state: null });
  });

  it("o playbook do Stage 5 chama o comando único", () => {
    const md = readFileSync(resolve(import.meta.dirname, "..", ".claude/agents/orchestrator-stage-5.md"), "utf8");
    assert.match(md, /npx tsx scripts\/stage5-youtube\.ts \{AAMMDD\} --edition-dir \{EDITION_DIR\}/);
    assert.doesNotMatch(md, /npx tsx scripts\/publish-youtube\.ts \{AAMMDD\} --upload --edition-dir/);
  });
});
