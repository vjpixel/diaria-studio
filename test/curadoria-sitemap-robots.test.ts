/**
 * test/curadoria-sitemap-robots.test.ts (#4546)
 *
 * Cobre os 2 Workers de curadoria puramente estáticos (cursos, livros):
 * `public/sitemap.xml` e `public/robots.txt` são servidos direto pelo
 * binding `ASSETS` (sem passar pelo script), então não há `fetch` handler
 * pra invocar em teste — a cobertura é sobre o CONTEÚDO do arquivo
 * committed: existe, é XML/texto válido, e (pro robots.txt) bate byte-a-byte
 * com um render fresco de `renderCuradoriaRobotsTxt` — mesmo padrão de
 * `test/livros-asset-drift.test.ts`/`test/cursos-asset-drift.test.ts`.
 *
 * `workers/arquivo` (o 3º Worker) é dinâmico (sem `[assets]`) — sua
 * cobertura de `/sitemap.xml` e `/robots.txt` já vive em
 * `test/arquivo-render.test.ts` (invoca `worker.fetch` de verdade).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderCuradoriaRobotsTxt, CURADORIA_BLOCKED_BOTS } from "../scripts/lib/shared/robots-txt.ts";
import { parseSitemap } from "../scripts/lib/fetch-sitemap.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WORKERS = [
  { name: "cursos", host: "https://cursos.diar.ia.br" },
  { name: "livros", host: "https://livros.diar.ia.br" },
] as const;

for (const { name, host } of WORKERS) {
  const publicDir = resolve(ROOT, "workers", name, "public");
  const sitemapPath = resolve(publicDir, "sitemap.xml");
  const robotsPath = resolve(publicDir, "robots.txt");

  describe(`workers/${name}/public — sitemap.xml + robots.txt (#4546)`, () => {
    it("sitemap.xml existe e é XML válido com <loc> pra própria home", () => {
      assert.ok(existsSync(sitemapPath), `${sitemapPath} ausente`);
      const xml = readFileSync(sitemapPath, "utf8");
      const entries = parseSitemap(xml);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].loc, `${host}/`);
    });

    it("robots.txt existe e bate com um render fresco de renderCuradoriaRobotsTxt", () => {
      assert.ok(existsSync(robotsPath), `${robotsPath} ausente — rode o gerador ou copie o template do módulo`);
      const committed = readFileSync(robotsPath, "utf8");
      const fresh = renderCuradoriaRobotsTxt(`${host}/sitemap.xml`);
      assert.equal(committed, fresh, "robots.txt divergiu de renderCuradoriaRobotsTxt — regenerar o arquivo");
    });

    it("robots.txt declara Allow: / geral e Sitemap: própria (não a do host principal)", () => {
      const body = readFileSync(robotsPath, "utf8");
      assert.match(body, /User-agent: \*/);
      assert.match(body, /Allow: \//);
      const sitemapLines = body.split("\n").filter((l) => l.startsWith("Sitemap:"));
      assert.deepEqual(
        sitemapLines,
        [`Sitemap: ${host}/sitemap.xml`],
        "deve declarar exatamente 1 Sitemap:, apontando pro próprio host — não pro host principal (diar.ia.br)",
      );
    });

    it("robots.txt só bloqueia os bots da allowlist de bloqueio (#4546) — os 7 crawlers de IA liberados não aparecem", () => {
      const body = readFileSync(robotsPath, "utf8");
      for (const bot of CURADORIA_BLOCKED_BOTS) {
        assert.match(body, new RegExp(`User-agent: ${bot}\\nDisallow: /`));
      }
      for (const bot of [
        "GPTBot",
        "ClaudeBot",
        "CCBot",
        "Google-Extended",
        "Bytespider",
        "meta-externalagent",
        "Applebot-Extended",
      ]) {
        assert.doesNotMatch(body, new RegExp(`User-agent: ${bot}\\b`));
      }
    });
  });
}

describe("renderCuradoriaRobotsTxt (#4546)", () => {
  it("é puro — mesma entrada produz sempre a mesma saída", () => {
    const a = renderCuradoriaRobotsTxt("https://exemplo.diar.ia.br/sitemap.xml");
    const b = renderCuradoriaRobotsTxt("https://exemplo.diar.ia.br/sitemap.xml");
    assert.equal(a, b);
  });

  it("interpola a sitemapUrl recebida, não uma fixa", () => {
    const out = renderCuradoriaRobotsTxt("https://outro-host.example/sitemap.xml");
    assert.match(out, /Sitemap: https:\/\/outro-host\.example\/sitemap\.xml/);
  });

  it("Content-Signal reflete ai-train=yes (liberação do #4546, não o default ai-train=no da Cloudflare)", () => {
    const out = renderCuradoriaRobotsTxt("https://x.example/sitemap.xml");
    assert.match(out, /Content-Signal: search=yes,ai-train=yes,use=reference/);
  });
});
