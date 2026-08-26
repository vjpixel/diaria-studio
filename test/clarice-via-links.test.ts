/**
 * test/clarice-via-links.test.ts (#1910)
 *
 * Garante que todo link da Clarice voltado ao leitor carrega o tracking de
 * afiliado `via=diaria` (Rewardful → revenue share da parceria). Sem ele, a
 * conversão acontece mas a diar.ia.br perde a comissão.
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
  it("via é case-insensitive e tolera múltiplos params (#1911 review)", () => {
    assert.equal(clariceLinkMissingVia("https://clarice.ai/?via=Diaria"), false);
    assert.equal(clariceLinkMissingVia("https://clarice.ai/?via=x&via=diaria"), false);
  });
  it("findClariceLinksMissingVia ignora pontuação/wrapping no fim da URL (#1911 review)", () => {
    // link COM via, seguido de ] ; } . — NÃO deve ser flagado (falso-positivo)
    assert.deepEqual(findClariceLinksMissingVia("[Clarice][https://clarice.ai/?via=diaria]"), []);
    assert.deepEqual(findClariceLinksMissingVia("ok https://clarice.ai/?via=diaria; fim"), []);
    // link SEM via, com pontuação de fim de frase — flagado sem o `.`/`;`
    assert.deepEqual(findClariceLinksMissingVia("veja https://clarice.ai/precos."), [
      "https://clarice.ai/precos",
    ]);
  });
  it("exenta cortex (API), mcp (API, #5114), mailto e não-clarice", () => {
    assert.equal(clariceLinkMissingVia("https://cortex.clarice.ai/api-correction"), false);
    assert.equal(clariceLinkMissingVia("https://mcp.clarice.ai/mcp"), false);
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
  // Varredura repo-wide das árvores que podem linkar a Clarice (texto editorial
  // + código que renderiza/publica). Sem denylist de arquivos: um arquivo novo
  // que linke a Clarice é coberto automaticamente. Pulamos só o que não pode
  // conter link voltado ao leitor (node_modules, .git, data/ gitignored, build).
  const ROOTS: Array<{ dir: string; exts: string[] }> = [
    { dir: "context", exts: [".md"] },
    { dir: ".claude", exts: [".md"] },
    { dir: "scripts", exts: [".ts"] },
    { dir: "workers", exts: [".ts"] },
  ];
  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".wrangler",
    // `.claude/worktrees/` são checkouts de trabalho gitignorados das sessões
    // overnight/develop (#6206) — não são "arquivos commitados", que é o alvo
    // declarado desta varredura. Numa máquina com worktree sobrando, o walk
    // entrava neles e reportava um `data/monthly/.../draft.md` de OUTRA sessão
    // como violação do repo. Além de falso positivo, o resultado do teste
    // passava a depender de quantas sessões tinham rodado antes.
    "worktrees",
    // `data/` é gitignored por inteiro (junction do OneDrive) — o comentário
    // acima já declarava a intenção de pular, mas o nome nunca estava na lista.
    "data",
  ]);

  // Walk fail-loud: se um ROOT some (rename/refactor), o erro propaga em vez de
  // virar conjunto vazio silencioso. Diretórios opcionais não existem aqui —
  // todos os ROOTS são commitados e devem estar presentes.
  function walk(dir: string, exts: string[]): string[] {
    const out: string[] = [];
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        out.push(...walk(join(dir, e.name), exts));
      } else if (exts.includes(extname(e.name))) {
        out.push(join(dir, e.name));
      }
    }
    return out;
  }

  const files = ROOTS.flatMap((r) => walk(r.dir, r.exts));

  // Sanity por-target: os arquivos que SABEMOS linkar/renderizar a Clarice têm
  // que cair na varredura. Se um refactor mover qualquer um pra fora das ROOTS,
  // este teste falha alto em vez de a cobertura encolher em silêncio.
  const MUST_COVER = [
    "scripts/stitch-newsletter.ts",
    "scripts/lib/mensal/monthly-render.ts", // #2747: movido pra lib/mensal/
    "scripts/publish-monthly.ts",
    "workers/poll/src/lib.ts",
  ];
  it("cobre os arquivos conhecidos que linkam a Clarice", () => {
    const norm = new Set(files.map((f) => f.split("\\").join("/")));
    const missing = MUST_COVER.filter((m) => !norm.has(m));
    assert.deepEqual(
      missing,
      [],
      `arquivos esperados fora da varredura (refactor?): ${missing.join(", ")}`,
    );
  });

  for (const f of files) {
    it(`${f} — sem link da Clarice sem via=diaria`, () => {
      const content = readFileSync(join(ROOT, f), "utf8");
      const offenders = findClariceLinksMissingVia(content);
      assert.deepEqual(
        offenders,
        [],
        `${f}: links da Clarice sem via=diaria → ${offenders.join(", ")}`,
      );
    });
  }
});
