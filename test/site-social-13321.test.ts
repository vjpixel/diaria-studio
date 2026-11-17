/**
 * test/site-social-13321.test.ts (#13321)
 *
 * Rodapé social global do site: as 7 redes, na ordem e com as URLs do convite
 * da edição (mesma lista), SVG inline sem teal, e presente nas superfícies
 * geradas (home, /p/, índice do arquivo, hubs, curadorias, entidades). A
 * injeção pelo caminho do menu global é idempotente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DIARIA_SOCIAL_NETWORKS } from "../scripts/lib/shared/social-networks.ts";
import { SOCIAL_ICON_SVG_PATHS } from "../scripts/lib/shared/social-icon-paths.ts";
import {
  SITE_SOCIAL_MARKER,
  injectSiteSocialFooter,
  renderSiteSocialIcons,
  siteSocialHref,
} from "../scripts/lib/shared/site-social.ts";
import { injectSiteNavAfterBodyOpen, SITE_NAV_MARKER } from "../scripts/lib/shared/site-nav.ts";
import { SOCIAL_INVITE, SOCIAL_INVITE_ICON_KEYS, parseSocialInviteIcons } from "../scripts/lib/shared/encerramento-snippet.ts";
import { backfillArchivePageOnDisk } from "../scripts/lib/site-archive-page-backfill.ts";
import { SITE_SOCIAL_UTM, UTM_EMITTERS } from "../scripts/lib/shared/utm-registry.ts";
import { COLORS } from "../scripts/lib/shared/design-tokens.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

describe("#13321 — lista das redes", () => {
  it("7 redes, na ordem e com as URLs do convite da edição", () => {
    const parsed = parseSocialInviteIcons(SOCIAL_INVITE);
    assert.ok(parsed);
    assert.deepEqual(
      DIARIA_SOCIAL_NETWORKS.map(({ label, url }) => ({ label, url })),
      parsed.links.map(({ label, url }) => ({ label, url })),
    );
    assert.deepEqual(DIARIA_SOCIAL_NETWORKS.map((n) => n.key), [...SOCIAL_INVITE_ICON_KEYS]);
    assert.equal(DIARIA_SOCIAL_NETWORKS.length, 7);
  });

  it("o path de cada ícone inline é o mesmo do SVG em assets/social-icons/", () => {
    for (const key of SOCIAL_INVITE_ICON_KEYS) {
      const svg = readFileSync(join(ROOT, "assets/social-icons", `${key}.svg`), "utf8");
      assert.equal(svg.match(/ d="([^"]+)"/)?.[1], SOCIAL_ICON_SVG_PATHS[key], `${key} divergiu do SVG`);
      assert.match(svg, /viewBox="0 0 24 24"/);
    }
  });
});

describe("#13321 — renderSiteSocialIcons", () => {
  const html = renderSiteSocialIcons();

  it("um link por rede, na ordem, com UTM do rodapé, aria-label e rel=noopener", () => {
    const hrefs = [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    assert.deepEqual(hrefs, DIARIA_SOCIAL_NETWORKS.map((n) => siteSocialHref(n.url)));
    for (const href of hrefs) {
      const u = new URL(href);
      assert.equal(u.searchParams.get("utm_source"), SITE_SOCIAL_UTM.source);
      assert.equal(u.searchParams.get("utm_medium"), SITE_SOCIAL_UTM.medium);
      assert.equal(u.searchParams.get("utm_campaign"), SITE_SOCIAL_UTM.campaign);
    }
    // YouTube segue sendo o link de inscrição (#12069).
    assert.equal(new URL(hrefs[0]).searchParams.get("sub_confirmation"), "1");
    assert.equal(new URL(hrefs[1]).host + new URL(hrefs[1]).pathname, "www.tiktok.com/@diar.ia.br");
    for (const { label } of DIARIA_SOCIAL_NETWORKS) {
      assert.ok(html.includes(`aria-label="diar.ia.br no ${label}"`), `${label} sem aria-label`);
    }
    assert.equal(count(html, 'rel="noopener"'), 7);
    assert.equal(count(html, "<svg "), 7);
    assert.equal(count(html, 'aria-hidden="true"'), 7);
  });

  it("ícone em tinta herdada (currentColor), sem teal", () => {
    assert.match(html, /fill: currentColor/);
    assert.ok(!html.toUpperCase().includes(COLORS.brand.toUpperCase()), "teal no rodapé social");
    assert.ok(!html.includes("var(--teal)"));
  });

  it("emissor registrado no inventário de UTM", () => {
    const e = UTM_EMITTERS.find((x) => x.id === "site-rodape-social");
    assert.ok(e);
    assert.equal(e.originFile, "scripts/lib/shared/site-social.ts");
    assert.equal(e.noSignupExpected, true);
  });
});

describe("#13321 — injeção idempotente", () => {
  const page = "<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>";

  it("injectSiteSocialFooter põe o rodapé antes do </body>, uma vez só", () => {
    const once = injectSiteSocialFooter(page);
    assert.equal(count(once, SITE_SOCIAL_MARKER), 1);
    assert.ok(once.indexOf(SITE_SOCIAL_MARKER) < once.indexOf("</body>"));
    assert.equal(injectSiteSocialFooter(once), once);
    assert.equal(injectSiteSocialFooter("<p>sem body</p>"), "<p>sem body</p>");
  });

  it("injectSiteNavAfterBodyOpen leva menu + rodapé; página que já tem o menu ganha só o rodapé", () => {
    const full = injectSiteNavAfterBodyOpen(page);
    assert.equal(count(full, SITE_NAV_MARKER), 1);
    assert.equal(count(full, SITE_SOCIAL_MARKER), 1);
    assert.equal(injectSiteNavAfterBodyOpen(full), full);

    // Página publicada antes do #13321: menu presente, rodapé ausente.
    const legacy = full.replace(/<style>\n\.dsoc [\s\S]*?<\/footer>\n/, "");
    assert.equal(count(legacy, SITE_SOCIAL_MARKER), 0);
    const fixed = injectSiteNavAfterBodyOpen(legacy);
    assert.equal(count(fixed, SITE_NAV_MARKER), 1);
    assert.equal(count(fixed, SITE_SOCIAL_MARKER), 1);
  });

  it("backfill das /p/: página com menu e sem rodapé ganha o rodapé; 2ª passada não muda nada", () => {
    const withNav = injectSiteNavAfterBodyOpen(page).replace(/<style>\n\.dsoc [\s\S]*?<\/footer>\n/, "");
    const first = backfillArchivePageOnDisk(withNav, { slug: "x" });
    assert.equal(first.addedSiteNav, true);
    assert.equal(count(first.html, SITE_SOCIAL_MARKER), 1);
    assert.equal(count(first.html, SITE_NAV_MARKER), 1);
    const second = backfillArchivePageOnDisk(first.html, { slug: "x" });
    assert.equal(second.changed, false);
    assert.equal(second.html, first.html);
  });
});

describe("#13321 — superfícies publicadas carregam o rodapé", () => {
  const files = [
    "workers/site/public/index.html", // home
    "workers/site/public/archive/index.html", // índice do arquivo
    "workers/site/public/assinar/index.html",
    "workers/site/public/clarice/index.html",
    "workers/livros/public/index.html", // curadoria
    "workers/cursos/public/index.html", // curadoria
    "workers/arquivo/src/hubs/anthropic-claude.generated.ts", // hub
    "workers/arquivo/src/hubs/index-page.generated.ts", // índice de hubs
    "workers/artigos/public/entidades/perplexity/index.html", // entidade
  ];
  for (const rel of files) {
    it(rel, () => {
      const html = readFileSync(join(ROOT, rel), "utf8");
      // Os módulos `.generated.ts` dos hubs guardam o HTML como string JSON
      // (aspas escapadas).
      const escaped = JSON.stringify(SITE_SOCIAL_MARKER).slice(1, -1);
      assert.ok(html.includes(SITE_SOCIAL_MARKER) || html.includes(escaped), `${rel} sem o rodapé social`);
    });
  }

  // Amostra fixa, não o diretório inteiro: uma /p/ nova que entre em master
  // por um gerador anterior a este PR não deve deixar a suíte vermelha; ela
  // se completa com `npx tsx scripts/backfill-archive-page-links-seo.ts`.
  for (const slug of ["aws-sofre-queda", "deepfake-de-drauzio-varella-anuncia-remedio-milagroso"]) {
    it(`/p/${slug}: menu e rodapé, uma vez cada`, () => {
      const html = readFileSync(join(ROOT, "workers/site/public/p", slug, "index.html"), "utf8");
      assert.equal(count(html, SITE_SOCIAL_MARKER), 1);
      assert.equal(count(html, SITE_NAV_MARKER), 1);
    });
  }
});
