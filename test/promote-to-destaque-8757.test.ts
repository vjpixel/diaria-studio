/**
 * #8757 — promoção de item do pool a destaque com INSERÇÃO + deslocamento
 * (2 → 3 destaques). Cenário real da 260924: item do RADAR promovido a D1,
 * os 2 destaques existentes viram D2/D3.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  insertionOrder,
  promoteInApprovedJson,
  shiftDestaqueHeadersInMd,
  promoteToDestaque,
} from "../scripts/promote-to-destaque.ts";

const URL_RADAR = "https://www.anthropic.com/research/claude-enzyme";

function approved() {
  return {
    highlights: [
      { rank: 1, score: 90, bucket: "noticias", url: "https://a.com/d1", article: { url: "https://a.com/d1", title: "D1" } },
      { rank: 2, score: 80, bucket: "noticias", url: "https://b.com/d2", article: { url: "https://b.com/d2", title: "D2" } },
    ],
    radar: [
      { url: "https://c.com/r1", title: "R1", score: 60, category: "noticias" },
      { url: URL_RADAR, title: "Claude discovers a novel enzyme system", score: 70, category: "pesquisa" },
    ],
    use_melhor: [],
  };
}

describe("insertionOrder (#8757)", () => {
  it("o slot vazio (3) gira para a posição pedida", () => {
    assert.deepEqual(insertionOrder(1), [3, 1, 2]);
    assert.deepEqual(insertionOrder(2), [1, 3, 2]);
    assert.deepEqual(insertionOrder(3), [1, 2, 3]);
    assert.throws(() => insertionOrder(4), /position/);
  });
});

describe("promoteInApprovedJson (#8757)", () => {
  it("move o item do bucket para highlights na posição e renumera os ranks", () => {
    const j = approved();
    assert.deepEqual(promoteInApprovedJson(j, URL_RADAR, 1), { sourceBucket: "radar" });
    assert.deepEqual(j.highlights.map((h: any) => h.url), [URL_RADAR, "https://a.com/d1", "https://b.com/d2"]);
    assert.deepEqual(j.highlights.map((h: any) => h.rank), [1, 2, 3]);
    assert.equal((j.highlights[0] as any).bucket, "pesquisa");
    assert.equal(j.radar.length, 1, "sai do RADAR");
  });

  it("URL ausente → null e nada muda; URL já destaque → lança", () => {
    const j = approved();
    assert.equal(promoteInApprovedJson(j, "https://nao.existe", 1), null);
    assert.equal(j.highlights.length, 2);
    assert.throws(() => promoteInApprovedJson(approved(), "https://a.com/d1", 1), /já é destaque/);
  });

  it("edição com 3 destaques recusa (#3369: promover é substituir)", () => {
    const j = approved();
    j.highlights.push({ rank: 3, score: 1, bucket: "x", url: "https://z.com", article: { url: "https://z.com", title: "Z" } });
    assert.throws(() => promoteInApprovedJson(j, URL_RADAR, 1), /SUBSTITUIR/);
  });
});

describe("shiftDestaqueHeadersInMd (#8757)", () => {
  it("renumera só N ≥ posição, do maior pro menor sem colisão", () => {
    const md = "**DESTAQUE 1 | IA**\n\ntexto1\n\n---\n\n**DESTAQUE 2 | NEGÓCIOS**\n\ntexto2\n";
    const out = shiftDestaqueHeadersInMd(md, 1);
    assert.match(out, /\*\*DESTAQUE 2 \| IA\*\*/);
    assert.match(out, /\*\*DESTAQUE 3 \| NEGÓCIOS\*\*/);
    assert.equal(shiftDestaqueHeadersInMd(md, 2), md.replace("DESTAQUE 2 |", "DESTAQUE 3 |"));
  });
});

describe("promoteToDestaque — ponta a ponta (#8757)", () => {
  function makeEdition(): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-8757-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved()));
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(approved()));
    for (const n of [1, 2]) {
      writeFileSync(join(dir, `04-d${n}-2x1.jpg`), `img-d${n}`);
      writeFileSync(join(dir, `04-d${n}-4x5-nativo.jpg`), `nativo-d${n}`);
      writeFileSync(join(dir, "_internal", `02-d${n}-prompt.md`), `prompt-d${n}`);
    }
    writeFileSync(
      join(dir, "02-reviewed.md"),
      "**DESTAQUE 1 | IA**\n\nt1\n\n---\n\n**DESTAQUE 2 | IA**\n\nt2\n",
    );
    writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\ns1\n\n## d2\n\ns2\n");
    writeFileSync(
      join(dir, "06-public-images.json"),
      JSON.stringify({ images: { cover: { url: "u1" }, d2_2x1: { url: "u2" }, d1_4x5: { url: "c1" } } }),
    );
    return dir;
  }

  it("desloca arquivos sem perder nenhum, atualiza JSONs e deixa o slot novo vazio", () => {
    const dir = makeEdition();
    try {
      const r = promoteToDestaque(dir, URL_RADAR, 1);
      // arquivos deslocados com o conteúdo certo, nenhum sumiu
      assert.equal(readFileSync(join(dir, "04-d2-2x1.jpg"), "utf8"), "img-d1");
      assert.equal(readFileSync(join(dir, "04-d3-2x1.jpg"), "utf8"), "img-d2");
      assert.equal(readFileSync(join(dir, "04-d3-4x5-nativo.jpg"), "utf8"), "nativo-d2");
      assert.equal(readFileSync(join(dir, "_internal", "02-d3-prompt.md"), "utf8"), "prompt-d2");
      assert.equal(existsSync(join(dir, "04-d1-2x1.jpg")), false, "slot novo fica vazio (arte a gerar)");
      // JSONs
      for (const f of ["01-approved.json", "01-approved-capped.json"]) {
        const j = JSON.parse(readFileSync(join(dir, "_internal", f), "utf8"));
        assert.equal(j.highlights.length, 3, f);
        assert.equal(j.highlights[0].url, URL_RADAR, f);
      }
      // md/social renumerados
      assert.match(readFileSync(join(dir, "02-reviewed.md"), "utf8"), /DESTAQUE 3 \| IA\*\*\n\nt2/);
      assert.match(readFileSync(join(dir, "03-social.md"), "utf8"), /## d3\n\ns2/);
      // imagens públicas das posições deslocadas invalidadas
      const pub = JSON.parse(readFileSync(join(dir, "06-public-images.json"), "utf8"));
      assert.deepEqual(Object.keys(pub.images), []);
      assert.equal(r.source_bucket, "radar");
      assert.ok(r.next_steps.some((s) => s.includes("DESTAQUE 1")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("URL fora do pool aborta ANTES de mover qualquer arquivo", () => {
    const dir = makeEdition();
    try {
      assert.throws(() => promoteToDestaque(dir, "https://nao.existe", 1), /não encontrada/);
      assert.equal(readFileSync(join(dir, "04-d1-2x1.jpg"), "utf8"), "img-d1");
      assert.equal(existsSync(join(dir, "04-d3-2x1.jpg")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run não escreve nada", () => {
    const dir = makeEdition();
    try {
      const r = promoteToDestaque(dir, URL_RADAR, 1, true);
      assert.ok(r.renamed.length > 0);
      assert.equal(readFileSync(join(dir, "04-d1-2x1.jpg"), "utf8"), "img-d1");
      assert.equal(JSON.parse(readFileSync(join(dir, "_internal", "01-approved.json"), "utf8")).highlights.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
