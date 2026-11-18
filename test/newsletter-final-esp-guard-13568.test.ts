/**
 * test/newsletter-final-esp-guard-13568.test.ts (#13568)
 *
 * Regressão: `_internal/newsletter-final.html` regravado com a merge tag do
 * Kit (`?email={{ subscriber.email_address }}`) fez
 * `publish-edition-site-page.ts` sair com exit 5 (guard #6202/#6210) e a
 * página `/p/{slug}` não saiu no Stage 5 (edição 261118). Invariante:
 * o caminho canônico nunca recebe merge tag de Kit/Brevo — nem pelo
 * `render-newsletter-html.ts --esp kit --out ...newsletter-draft.html`, nem
 * pelo `substitute-image-urls.ts --out ...newsletter-final.html` com um HTML
 * de entrada na variante Kit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkNeutralHtmlWrite,
  checkRenderEspForOut,
  findEspSpecificMergeTags,
  isNeutralHtmlPath,
} from "../scripts/lib/diaria/newsletter-final-esp-guard.ts";
import { verifyNoUnresolvedMergeTags, UnresolvedMergeTagError } from "../scripts/lib/site-archive-pages.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const RENDER = join(PROJECT_ROOT, "scripts", "render-newsletter-html.ts");
const SUBSTITUTE = join(PROJECT_ROOT, "scripts", "substitute-image-urls.ts");

const KIT_VOTE = 'https://eia.diar.ia.br/vote/261118/A?email={{ subscriber.email_address }}&utm_source=diaria';
const NEUTRAL_VOTE = "https://eia.diar.ia.br/vote/261118/A?email={{email}}&utm_source=diaria";

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8", cwd: PROJECT_ROOT });
}

/** Mesmo fixture mínimo de render-newsletter-html-cli-esp-4266.test.ts (subpasta AAMMDD + 01-eia.md com credit). */
function makeEditionDir(): string {
  const base = mkdtempSync(join(tmpdir(), "diaria-13568-"));
  const dir = join(base, "260999");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const reviewed = [1, 2, 3]
    .flatMap((n) => [
      `**DESTAQUE ${n} | RADAR**`,
      "",
      `**[Título ${n}](https://example.com/${n})**`,
      "",
      `Corpo do destaque ${n} com contexto suficiente pra render.`,
      "",
      `Por que isso importa: razão ${n}.`,
      "",
      "---",
      "",
    ])
    .join("\n");
  writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
  writeFileSync(join(dir, "01-eia.md"), "Foto: Author / CC BY-SA 4.0.", "utf8");
  return dir;
}

describe("newsletter-final-esp-guard (#13568) — lib", () => {
  it("isNeutralHtmlPath: só draft/final dentro de _internal/", () => {
    assert.equal(isNeutralHtmlPath("/x/260999/_internal/newsletter-final.html"), true);
    assert.equal(isNeutralHtmlPath("/x/260999/_internal/newsletter-draft.html"), true);
    assert.equal(isNeutralHtmlPath("/x/260999/_internal/newsletter-final-kit.html"), false);
    assert.equal(isNeutralHtmlPath("/x/260999/_internal/out.html"), false);
    assert.equal(isNeutralHtmlPath("/x/260999/newsletter-final.html"), false);
  });

  it("findEspSpecificMergeTags: acha Kit e Brevo, ignora {{email}} e {{IMG:...}}", () => {
    const html = `<a href="${KIT_VOTE}"></a><a href="x?t={{ contact.POLL_TOKEN }}"></a><a href="${NEUTRAL_VOTE}"></a><img src="{{IMG:04-d1-2x1.jpg}}">`;
    assert.deepEqual(findEspSpecificMergeTags(html), ["{{ subscriber.email_address }}", "{{ contact.POLL_TOKEN }}"]);
    assert.deepEqual(findEspSpecificMergeTags(`<a href="${NEUTRAL_VOTE}"></a>`), []);
  });

  it("checkRenderEspForOut: recusa kit/brevo só no caminho canônico", () => {
    const final = "/x/260999/_internal/newsletter-draft.html";
    assert.match(checkRenderEspForOut("kit", final) ?? "", /#13568/);
    assert.match(checkRenderEspForOut("brevo", final) ?? "", /#13568/);
    assert.equal(checkRenderEspForOut("beehiiv", final), null);
    assert.equal(checkRenderEspForOut("kit", "/x/260999/_internal/kit-preview.html"), null);
    assert.equal(checkRenderEspForOut("kit", undefined), null);
  });

  it("checkNeutralHtmlWrite: HTML neutro passa; Kit no newsletter-final.html é recusado", () => {
    const final = "/x/260999/_internal/newsletter-final.html";
    assert.equal(checkNeutralHtmlWrite(final, `<a href="${NEUTRAL_VOTE}"></a>`), null);
    assert.match(checkNeutralHtmlWrite(final, `<a href="${KIT_VOTE}"></a>`) ?? "", /subscriber\.email_address/);
    assert.equal(checkNeutralHtmlWrite("/x/260999/_internal/newsletter-final-kit.html", `<a href="${KIT_VOTE}"></a>`), null);
  });

  it("premissa do incidente: a página do site recusa a merge tag do Kit (exit 5 do §5b-site)", () => {
    assert.throws(() => verifyNoUnresolvedMergeTags(`<a href="${KIT_VOTE}"></a>`, "slug"), UnresolvedMergeTagError);
  });
});

describe("render-newsletter-html CLI (#13568)", () => {
  it("--esp kit --out _internal/newsletter-draft.html: exit 1 e nada gravado", () => {
    const dir = makeEditionDir();
    try {
      const outPath = join(dir, "_internal", "newsletter-draft.html");
      const r = run(RENDER, [dir, "--format", "html", "--esp", "kit", "--out", outPath]);
      assert.equal(r.status, 1, `stderr: ${r.stderr}`);
      assert.match(r.stderr, /#13568/);
      assert.equal(existsSync(outPath), false);
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });

  it("sem --esp no caminho canônico: grava, e o HTML não tem merge tag de Kit", () => {
    const dir = makeEditionDir();
    try {
      const outPath = join(dir, "_internal", "newsletter-draft.html");
      const r = run(RENDER, [dir, "--format", "html", "--out", outPath]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const html = readFileSync(outPath, "utf8");
      assert.match(html, /\?email=\{\{email\}\}/);
      assert.deepEqual(findEspSpecificMergeTags(html), []);
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });

  it("--esp kit fora do caminho canônico segue permitido", () => {
    const dir = makeEditionDir();
    try {
      const outPath = join(dir, "_internal", "kit-debug.html");
      const r = run(RENDER, [dir, "--format", "html", "--esp", "kit", "--out", outPath]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(readFileSync(outPath, "utf8"), /\{\{ subscriber\.email_address \}\}/);
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });
});

describe("substitute-image-urls CLI (#13568)", () => {
  function setup(inputHtml: string) {
    const dir = makeEditionDir();
    const base = resolve(dir, "..");
    // Entrada fora de _internal/: o guard de staleness (#2316) não se aplica.
    const htmlIn = join(base, "in.html");
    writeFileSync(htmlIn, inputHtml, "utf8");
    const images = join(base, "images.json");
    writeFileSync(images, JSON.stringify({ images: {} }), "utf8");
    return { dir, base, htmlIn, images };
  }

  it("HTML na variante Kit com --out newsletter-final.html: exit 4 e o arquivo anterior fica intacto", () => {
    const { dir, base, htmlIn, images } = setup(`<a href="${KIT_VOTE}">A</a>`);
    try {
      const outPath = join(dir, "_internal", "newsletter-final.html");
      writeFileSync(outPath, `<a href="${NEUTRAL_VOTE}">A</a>`, "utf8");
      const r = run(SUBSTITUTE, ["--html", htmlIn, "--images", images, "--out", outPath]);
      assert.equal(r.status, 4, `stderr: ${r.stderr}`);
      assert.match(r.stderr, /#13568/);
      const after = readFileSync(outPath, "utf8");
      assert.deepEqual(findEspSpecificMergeTags(after), [], "newsletter-final.html nunca contém a merge tag do Kit");
      assert.equal(existsSync(join(dir, "_internal", "studio-review-baseline", "newsletter-final.html.md")), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("HTML neutro com --out newsletter-final.html: grava normalmente", () => {
    const { dir, base, htmlIn, images } = setup(`<a href="${NEUTRAL_VOTE}">A</a>`);
    try {
      const outPath = join(dir, "_internal", "newsletter-final.html");
      const r = run(SUBSTITUTE, ["--html", htmlIn, "--images", images, "--out", outPath]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(readFileSync(outPath, "utf8"), /\{\{email\}\}/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("HTML na variante Kit com --out newsletter-final-kit.html: permitido", () => {
    const { dir, base, htmlIn, images } = setup(`<a href="${KIT_VOTE}">A</a>`);
    try {
      const outPath = join(dir, "_internal", "newsletter-final-kit.html");
      const r = run(SUBSTITUTE, ["--html", htmlIn, "--images", images, "--out", outPath]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
