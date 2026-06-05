/**
 * test/clarice-via-links.test.ts (#1910)
 *
 * Garante que todo link da Clarice voltado ao leitor carrega o tracking de
 * afiliado `via=diaria` (Rewardful → revenue share da parceria). Sem ele, a
 * conversão acontece mas a Diar.ia perde a comissão.
 *
 * (a) unit do helper `clariceLinkMissingVia` / `findClariceLinksMissingVia`.
 * (b) varre os arquivos COMMITADOS que podem conter links da Clarice e falha
 *     se algum link voltado ao leitor estiver sem `via=diaria`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clariceLinkMissingVia,
  findClariceLinksMissingVia,
} from "../scripts/lib/canonical-urls.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("clariceLinkMissingVia (#1910)", () => {
  it("flag link clarice.ai voltado ao leitor SEM via=diaria", () => {
    assert.equal(clariceLinkMissingVia("https://clarice.ai"), true);
    assert.equal(clariceLinkMissingVia("https://clarice.ai/precos-planos"), true);
    assert.equal(clariceLinkMissingVia("https://app.clarice.ai/novo-texto"), true);
    assert.equal(clariceLinkMissingVia("https://www.clarice.ai/"), true);
  });
  it("NÃO flag quando tem via=diaria (em qualquer posição da query)", () => {
    assert.equal(clariceLinkMissingVia("https://clarice.ai/?via=diaria"), false);
    assert.equal(clariceLinkMissingVia("https://clarice.ai/precos-planos?via=diaria"), false);
    assert.equal(clariceLinkMissingVia("https://clarice.ai/x?a=1&via=diaria"), false);
  });
  it("exenta cortex (API), mailto e não-clarice", () => {
    assert.equal(clariceLinkMissingVia("https://cortex.clarice.ai/api-correction"), false);
    assert.equal(clariceLinkMissingVia("mailto:ti@clarice.ai"), false);
    assert.equal(clariceLinkMissingVia("https://example.com"), false);
    assert.equal(clariceLinkMissingVia("https://notclarice.ai/?via=x"), false);
  });
  it("findClariceLinksMissingVia extrai só os offenders de um texto misto", () => {
    const md = [
      "A revisão foi feita pelo MCP da [Clarice](https://clarice.ai/?via=diaria).",
      "[Acesse](https://clarice.ai/precos-planos) e use os cupons.",
      "→ [Teste](https://app.clarice.ai/novo-texto)",
      "Endpoint: https://cortex.clarice.ai/api-correction",
    ].join("\n");
    assert.deepEqual(findClariceLinksMissingVia(md).sort(), [
      "https://app.clarice.ai/novo-texto",
      "https://clarice.ai/precos-planos",
    ]);
  });
});

describe("arquivos commitados não têm link da Clarice sem via=diaria (#1910)", () => {
  // dirs varridos por extensão + arquivos específicos que podem linkar a Clarice.
  const TARGETS: Array<{ dir: string; exts: string[] }> = [
    { dir: "context/templates", exts: [".md"] },
    { dir: ".claude/agents", exts: [".md"] },
    { dir: "workers/poll/src", exts: [".ts"] },
  ];
  const EXTRA_FILES = [
    "scripts/stitch-newsletter.ts",
    "scripts/lib/monthly-render.ts",
    "scripts/publish-monthly.ts",
  ];

  function walk(dir: string, exts: string[]): string[] {
    const out: string[] = [];
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(rel, exts));
      else if (exts.includes(extname(e.name))) out.push(rel);
    }
    return out;
  }

  const files = [
    ...TARGETS.flatMap((t) => walk(t.dir, t.exts)),
    ...EXTRA_FILES,
  ];

  it("varre os arquivos-alvo (sanity: encontrou arquivos)", () => {
    assert.ok(files.length > 5, `esperava >5 arquivos varridos, achei ${files.length}`);
  });

  for (const f of files) {
    it(`${f} — sem link da Clarice sem via=diaria`, () => {
      let content: string;
      try {
        content = readFileSync(join(ROOT, f), "utf8");
      } catch {
        return; // arquivo extra ausente — ignora
      }
      const offenders = findClariceLinksMissingVia(content);
      assert.deepEqual(
        offenders,
        [],
        `${f}: links da Clarice sem via=diaria → ${offenders.join(", ")}`,
      );
    });
  }
});
