/**
 * #12542: "o vídeo mais assistido até agora" do e-mail 2 do onboarding deixou
 * de ser texto fixo. O snippet traz `{{VIDEO_MAIS_ASSISTIDO}}`, resolvido no
 * parse a partir do registro da medição semanal; sem registro, o último valor
 * conhecido. O placeholder cru nunca sai.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSnippetSendable, parseOnboardingSnippet } from "../scripts/lib/onboarding-state.ts";
import {
  buildTopVideoRecord,
  cleanTopVideoTitle,
  FALLBACK_TOP_VIDEO,
  parseTopVideoRecord,
  readTopVideoRecord,
  renderTopVideoLink,
  resolveTopVideoPlaceholder,
  VIDEO_MAIS_ASSISTIDO_PLACEHOLDER,
} from "../scripts/lib/onboarding-top-video.ts";
import { CLI_SPEC, measureTopVideo } from "../scripts/measure-top-youtube-video.ts";
import { resolveCliAction } from "../scripts/lib/cli-args.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const ROOT = resolve(import.meta.dirname, "..");

const SNIPPET = [
  "<!--",
  'assunto: "Tem um erro de propósito em toda edição"',
  'preview_text: "x"',
  "-->",
  `<p>Olá! Tudo bem?</p>`,
  `<p>O mais assistido até agora é ${VIDEO_MAIS_ASSISTIDO_PLACEHOLDER}.</p>`,
  "<p>Pixel</p>",
].join("\n");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "top-video-12542-"));
}

describe("#12542 — placeholder do vídeo mais assistido", () => {
  it("snippet com placeholder e SEM registro não sai com o placeholder cru (usa o último valor conhecido)", () => {
    const snip = parseOnboardingSnippet(SNIPPET, 2);
    assert.ok(snip);
    assert.ok(!snip.body.includes("{{"), snip.body);
    assert.ok(snip.body.includes(`href="${FALLBACK_TOP_VIDEO.url}"`));
    assert.ok(snip.body.includes(`>${FALLBACK_TOP_VIDEO.title}</a>.`));
    assert.doesNotThrow(() => assertSnippetSendable(snip));
  });

  it("registro null também cai no fallback", () => {
    const snip = parseOnboardingSnippet(SNIPPET, 2, null)!;
    assert.ok(!snip.body.includes(VIDEO_MAIS_ASSISTIDO_PLACEHOLDER));
    assert.ok(snip.body.includes(FALLBACK_TOP_VIDEO.url));
  });

  it("com registro, o link do vídeo medido entra no lugar do placeholder", () => {
    const snip = parseOnboardingSnippet(SNIPPET, 2, { title: "Pais acusam ChatGPT", url: "https://youtu.be/CMdeWkiZG1Y" })!;
    assert.ok(!snip.body.includes(VIDEO_MAIS_ASSISTIDO_PLACEHOLDER));
    assert.match(snip.body, /href="https:\/\/youtu\.be\/CMdeWkiZG1Y">Pais acusam ChatGPT<\/a>\./);
    assert.ok(!snip.body.includes(FALLBACK_TOP_VIDEO.url));
  });

  it("título com caractere de HTML é escapado", () => {
    assert.equal(
      renderTopVideoLink({ title: 'A & B <x> "y"', url: "https://youtu.be/CMdeWkiZG1Y" }),
      '<a target="_blank" rel="noopener noreferrer nofollow" class="link" href="https://youtu.be/CMdeWkiZG1Y">A &amp; B &lt;x&gt; &quot;y&quot;</a>',
    );
  });

  it("texto sem placeholder volta igual", () => {
    assert.equal(resolveTopVideoPlaceholder("<p>nada</p>", null), "<p>nada</p>");
  });

  it("o template versionado do e-mail 2 usa o placeholder e não carrega mais o vídeo fixo no corpo", () => {
    const raw = readFileSync(join(ROOT, "context/templates/onboarding/onboarding-2.md"), "utf8");
    const corpo = raw.slice(raw.indexOf("-->") + 3);
    assert.ok(corpo.includes(`O mais assistido até agora é ${VIDEO_MAIS_ASSISTIDO_PLACEHOLDER}.`));
    assert.ok(!corpo.includes("OCtGv0f_6sg"), "vídeo fixo no corpo é o bug da #12542");
    const snip = parseOnboardingSnippet(raw, 2)!;
    assert.ok(!snip.body.includes("{{VIDEO_MAIS_ASSISTIDO"));
  });

  it("os dois executores (Brevo e Kit) passam o registro medido ao parser", () => {
    for (const f of ["scripts/onboarding-welcome-run.ts", "scripts/onboarding-kit-transport-run.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      assert.match(src, /readTopVideoRecord\(resolve\(ROOT, TOP_VIDEO_RECORD_RELPATH\)\)/, f);
      assert.match(src, /parseOnboardingSnippet\(readFileSync\(p, "utf8"\), \w+, topVideo\)/, f);
    }
  });
});

describe("#12542 — registro da medição", () => {
  it("parseTopVideoRecord: válido, sem título, id inválido, não-objeto", () => {
    assert.deepEqual(parseTopVideoRecord({ title: "X", video_id: "CMdeWkiZG1Y" }), { title: "X", url: "https://youtu.be/CMdeWkiZG1Y" });
    assert.equal(parseTopVideoRecord({ title: "  ", video_id: "CMdeWkiZG1Y" }), null);
    assert.equal(parseTopVideoRecord({ title: "X", video_id: "curto" }), null);
    assert.equal(parseTopVideoRecord(null), null);
    assert.equal(parseTopVideoRecord("x"), null);
  });

  it("readTopVideoRecord: ausente e ilegível viram null (fail-soft)", () => {
    const dir = tmp();
    try {
      assert.equal(readTopVideoRecord(join(dir, "nao-existe.json")), null);
      writeFileSync(join(dir, "ruim.json"), "{nao é json");
      assert.equal(readTopVideoRecord(join(dir, "ruim.json")), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleanTopVideoTitle tira o sufixo de série do upload", () => {
    assert.equal(cleanTopVideoTitle("Falhas no PHP colocam a internet em alerta global | diar.ia.br comentada #3"), "Falhas no PHP colocam a internet em alerta global");
    assert.equal(cleanTopVideoTitle("Lula promete uma IA brasileira"), "Lula promete uma IA brasileira");
  });

  it("buildTopVideoRecord: sem medição ou sem título → null", () => {
    const now = new Date("2026-11-10T11:50:00Z");
    assert.equal(buildTopVideoRecord(null, now), null);
    assert.equal(buildTopVideoRecord({ aammdd: "261029", videoId: "OCtGv0f_6sg", title: null, views: 9 }, now), null);
    assert.deepEqual(buildTopVideoRecord({ aammdd: "261029", videoId: "OCtGv0f_6sg", title: "Lula", views: 9 }, now), {
      title: "Lula",
      url: "https://youtu.be/OCtGv0f_6sg",
      video_id: "OCtGv0f_6sg",
      edition: "261029",
      views: 9,
      measured_at: "2026-11-10T11:50:00.000Z",
    });
  });

  it("measureTopVideo grava o registro medido, que o parser lê de volta", async () => {
    const dir = tmp();
    try {
      const out = join(dir, "youtube", "top-video.json");
      const res = await measureTopVideo({
        editionsRoot: join(dir, "editions"),
        outPath: out,
        dryRun: false,
        env: {},
        topVideo: async () => ({ aammdd: "261030", videoId: "CMdeWkiZG1Y", videoUrl: "https://youtu.be/CMdeWkiZG1Y", title: "Pais acusam ChatGPT", views: 500 }),
        log: () => {},
      });
      assert.equal(res.written, true);
      const link = readTopVideoRecord(out);
      assert.deepEqual(link, { title: "Pais acusam ChatGPT", url: "https://youtu.be/CMdeWkiZG1Y" });
      assert.match(parseOnboardingSnippet(SNIPPET, 2, link)!.body, /CMdeWkiZG1Y/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("medição que falha (null) NÃO sobrescreve o último registro", async () => {
    const dir = tmp();
    try {
      const out = join(dir, "youtube", "top-video.json");
      mkdirSync(join(dir, "youtube"), { recursive: true });
      const anterior = JSON.stringify({ title: "Anterior", video_id: "CMdeWkiZG1Y" });
      writeFileSync(out, anterior);
      const res = await measureTopVideo({ editionsRoot: join(dir, "editions"), outPath: out, dryRun: false, env: {}, topVideo: async () => null, log: () => {} });
      assert.equal(res.written, false);
      assert.equal(readFileSync(out, "utf8"), anterior);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run mede e não grava", async () => {
    const dir = tmp();
    try {
      const out = join(dir, "top-video.json");
      const res = await measureTopVideo({
        editionsRoot: join(dir, "editions"),
        outPath: out,
        dryRun: true,
        env: {},
        topVideo: async () => ({ aammdd: "261030", videoId: "CMdeWkiZG1Y", videoUrl: "https://youtu.be/CMdeWkiZG1Y", title: "T", views: 1 }),
        log: () => {},
      });
      assert.ok(res.record);
      assert.equal(existsSync(out), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI recusa typo de flag antes de qualquer I/O", () => {
    assert.equal(resolveCliAction(["--dryrun"], CLI_SPEC).kind, "error");
    assert.equal(resolveCliAction(["--dry-run"], CLI_SPEC).kind, "run");
    assert.equal(resolveCliAction(["--out"], CLI_SPEC).kind, "error");
  });

  it("a medição está registrada como task semanal (guard tem que ser ARMADO, #7137)", () => {
    const t = getScheduledTaskByName("Diaria-Top-YouTube-Video-Measure");
    assert.ok(t);
    assert.equal(t.schedule.kind, "weekly");
    assert.deepEqual(t.steps.map((s) => s.script), ["scripts/measure-top-youtube-video.ts"]);
    assert.ok(existsSync(join(ROOT, t.steps[0].script)));
  });
});
