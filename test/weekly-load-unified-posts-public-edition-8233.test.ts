/**
 * test/weekly-load-unified-posts-public-edition-8233.test.ts (#8233)
 *
 * Os 3 wrappers `loadUnifiedPostsForRanking` (`select-linkedin-weekly.ts`,
 * `publish-weekly-social.ts`, `prep-weekly-twitter.ts`) leem o cache
 * unificado Beehiiv+Kit pra RANQUEAR candidatos a post público de LinkedIn/
 * Instagram/Facebook/X. Antes do #8233 nenhum filtrava por `isPublicEdition`
 * — um envio de teste do Stage 5 (`teste-*`) ou a variante Patronos
 * (`*-patronos`) podia entrar na corrida de ranking e virar candidato a
 * publicação real. Este teste confirma, pros 3 wrappers, que um post
 * `teste-*`/`*-patronos` no cache NUNCA aparece no resultado, enquanto um
 * post normal continua aparecendo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadUnifiedPostsForRanking as loadForLinkedin } from "../scripts/select-linkedin-weekly.ts";
import { loadUnifiedPostsForRanking as loadForSocial } from "../scripts/publish-weekly-social.ts";
import { loadUnifiedPostsForRanking as loadForTwitter } from "../scripts/prep-weekly-twitter.ts";

function setupCacheDirs(): { beehiivDir: string; kitDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "diaria-8233-weekly-"));
  const beehiivDir = join(root, "beehiiv-cache", "posts");
  const kitDir = join(root, "kit-cache", "broadcasts");
  mkdirSync(beehiivDir, { recursive: true });
  mkdirSync(kitDir, { recursive: true });
  writeFileSync(
    join(beehiivDir, "post_normal.json"),
    JSON.stringify({ slug: "260910-edicao-normal", publish_date: 1000, status: "confirmed" }),
  );
  writeFileSync(
    join(beehiivDir, "post_teste.json"),
    JSON.stringify({ slug: "teste-260910", publish_date: 1001, status: "confirmed" }),
  );
  writeFileSync(
    join(beehiivDir, "post_patronos.json"),
    JSON.stringify({ slug: "260910-edicao-normal-patronos", publish_date: 1002, status: "confirmed" }),
  );
  return { beehiivDir, kitDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const wrappers: Array<[string, (b: string, k: string) => Array<{ slug?: string | null }>]> = [
  ["select-linkedin-weekly.ts", loadForLinkedin],
  ["publish-weekly-social.ts", loadForSocial],
  ["prep-weekly-twitter.ts", loadForTwitter],
];

for (const [name, loadFn] of wrappers) {
  describe(`${name}::loadUnifiedPostsForRanking — filtra por isPublicEdition (#8233)`, () => {
    it("nunca inclui teste-*/-patronos, sempre inclui edição normal", () => {
      const { beehiivDir, kitDir, cleanup } = setupCacheDirs();
      try {
        const posts = loadFn(beehiivDir, kitDir);
        const slugs = posts.map((p) => p.slug);
        assert.ok(slugs.includes("260910-edicao-normal"), `esperava a edição normal em ${slugs.join(", ")}`);
        assert.ok(!slugs.some((s) => s?.startsWith("teste-")), `teste-* vazou: ${slugs.join(", ")}`);
        assert.ok(!slugs.some((s) => s?.endsWith("-patronos")), `-patronos vazou: ${slugs.join(", ")}`);
        assert.equal(posts.length, 1);
      } finally {
        cleanup();
      }
    });
  });
}
