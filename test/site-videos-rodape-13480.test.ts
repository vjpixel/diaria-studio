/**
 * #13480 — a `/videos` (#13323) nasceu chamando `renderSiteNav` direto e
 * ficou sem o rodapé social global que o #13321 pôs nas demais páginas com o
 * menu. Este teste trava a página e, para não repetir o drift com a próxima
 * página nova, exige que todo gerador em `scripts/lib/` que chama
 * `renderSiteNav(` também renderize o rodapé social.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVideosPageHtml } from "../scripts/lib/site-videos-page.ts";
import type { HomeVideoEntry } from "../scripts/lib/site-home-page.ts";
import { SITE_SOCIAL_MARKER } from "../scripts/lib/shared/site-social.ts";
import { SITE_NAV_MARKER } from "../scripts/lib/shared/site-nav.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("#13480 — /videos com o rodapé social global", () => {
  const entry: HomeVideoEntry = {
    slug: "teste",
    date: "2026-11-17",
    videoId: "abc123def45",
    title: "Vídeo de teste",
    description: "Descrição",
    url: "https://diar.ia.br/p/teste/",
    uploadDate: "2026-11-17",
  };

  const cases: Array<[string, HomeVideoEntry[]]> = [
    ["com vídeos", [entry]],
    ["sem vídeos", []],
  ];
  for (const [label, entries] of cases) {
    it(`buildVideosPageHtml (${label}): menu e rodapé, uma vez cada, rodapé antes do </body>`, () => {
      const html = buildVideosPageHtml(entries);
      assert.equal(count(html, SITE_NAV_MARKER), 1);
      assert.equal(count(html, SITE_SOCIAL_MARKER), 1);
      assert.ok(html.indexOf(SITE_SOCIAL_MARKER) < html.toLowerCase().lastIndexOf("</body>"));
      assert.ok(html.indexOf(SITE_SOCIAL_MARKER) > html.indexOf("</main>"), "rodapé fora do <main>");
    });
  }

  it("workers/site/public/videos/index.html commitado carrega o rodapé", () => {
    const html = readFileSync(join(ROOT, "workers/site/public/videos/index.html"), "utf8");
    assert.equal(count(html, SITE_SOCIAL_MARKER), 1);
  });
});

describe("#13480 — todo gerador com o menu global também tem o rodapé social", () => {
  const libDir = join(ROOT, "scripts", "lib");
  // site-nav.ts define renderSiteNav; site-social.ts define o rodapé.
  const exempt = new Set(["scripts/lib/shared/site-nav.ts", "scripts/lib/shared/site-social.ts"]);
  const callers = listTs(libDir)
    .map((f) => relative(ROOT, f).replaceAll("\\", "/"))
    .filter((rel) => !exempt.has(rel))
    .filter((rel) => readFileSync(join(ROOT, rel), "utf8").includes("renderSiteNav("));

  it("a varredura acha os geradores conhecidos (sanidade)", () => {
    assert.ok(callers.includes("scripts/lib/site-videos-page.ts"));
    assert.ok(callers.length >= 5, `só ${callers.length} chamadores encontrados`);
  });

  for (const rel of callers) {
    it(rel, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      assert.ok(
        /renderSiteSocialFooter\(|renderSiteSocialIcons\(|injectSiteSocialFooter\(|injectSiteNavAfterBodyOpen\(/.test(src),
        `${rel} chama renderSiteNav( mas não renderiza o rodapé social (#13321): use renderSiteSocialFooter antes do </body>`,
      );
    });
  }
});
