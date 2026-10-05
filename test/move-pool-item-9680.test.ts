/**
 * #9680 — mover item do pool entre seções no gate do Stage 4 (caso 261006:
 * RADAR → USE MELHOR). À mão quebrava url-bucket (approved + capped),
 * use-melhor-tempo e intro-count-consistent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveInApprovedJson, moveItemInReviewedMd, movePoolItem } from "../scripts/move-pool-item.ts";
import { lintNewsletter } from "../scripts/lib/lint-checks/url-bucket.ts";
import { checkUseMelhorTempo } from "../scripts/lib/lint-checks/use-melhor-tempo.ts";
import { lintIntroCount } from "../scripts/lib/newsletter-count.ts";

const R1 = "https://exemplo.com/radar-1";
const R2 = "https://exemplo.com/radar-2";
const U1 = "https://exemplo.com/guia";
const V1 = "https://www.youtube.com/watch?v=abc";

const MD = `Olá!

Nesta edição, a IA analisou 100 conteúdos (2 enviados por mim e 98 encontrados automaticamente) e selecionei os 7 mais relevantes.

---

**DESTAQUE 1 | 📦 PRODUTO**

**[D1](https://d.com/1)**

Corpo.

---

**DESTAQUE 2 | 📦 PRODUTO**

**[D2](https://d.com/2)**

Corpo.

---

**DESTAQUE 3 | 📦 PRODUTO**

**[D3](https://d.com/3)**

Corpo.

---

**🛠️ USE MELHOR**

**[Guia](${U1})**
Passo a passo para usar a ferramenta. (5 min)

---

**📺 VÍDEO**

**[Vídeo](${V1})**
Um vídeo.

---

**📡 RADAR**

**[Radar um](${R1})**
Descrição do radar um.

**[Radar dois](${R2})**
Descrição do radar dois.

---

**ERRO INTENCIONAL**

Texto.
`;

function approved() {
  return {
    highlights: [1, 2, 3].map((n) => ({ url: `https://d.com/${n}`, article: { url: `https://d.com/${n}` } })),
    lancamento: [],
    radar: [
      { url: R1, title: "Radar um", score: 60 },
      { url: R2, title: "Radar dois", score: 50 },
    ],
    use_melhor: [{ url: U1, title: "Guia", score: 55 }],
    video: [{ url: V1, title: "Vídeo" }],
  };
}

describe("moveItemInReviewedMd (#9680)", () => {
  it("RADAR → USE MELHOR exige --tempo e anexa '(N min)' (lint use-melhor-tempo passa)", () => {
    assert.throws(() => moveItemInReviewedMd(MD, R1, "use_melhor"), /--tempo/);
    const r = moveItemInReviewedMd(MD, R1, "use_melhor", { tempo: 7 });
    assert.equal(r.from, "radar");
    assert.equal(r.tempo_added, "(7 min)");
    assert.match(r.md, /\*\*\[Guia\][^\n]*\nPasso a passo[^\n]*\(5 min\)\n\n\*\*\[Radar um\]\([^)]*\)\*\* *\nDescrição do radar um\. \(7 min\)\n\n---/);
    assert.ok(!/RADAR\*\*[\s\S]*Radar um/.test(r.md), "saiu do RADAR");
    assert.equal(checkUseMelhorTempo(r.md).ok, true);
  });

  it("USE MELHOR → RADAR remove o '(N min)' e some com a seção que ficou vazia", () => {
    const r = moveItemInReviewedMd(MD, U1, "radar");
    assert.equal(r.tempo_removed, true);
    assert.equal(r.source_section_removed, true);
    assert.ok(!r.md.includes("USE MELHOR"), "seção vazia removida");
    assert.match(r.md, /Passo a passo para usar a ferramenta\.\n\n---\n\n\*\*ERRO INTENCIONAL/);
    assert.ok(!/---\n\n---/.test(r.md), "não sobra separador duplicado");
  });

  it("singular/plural do header acompanha a contagem (VÍDEO → VÍDEOS)", () => {
    const r = moveItemInReviewedMd(MD, R1, "video");
    assert.match(r.md, /^\*\*📺 VÍDEOS\*\*$/m);
  });

  it("corrige a intro quando a contagem real muda", () => {
    const stale = MD.replace("selecionei os 7", "selecionei os 9");
    const r = moveItemInReviewedMd(stale, R1, "video");
    assert.deepEqual(r.intro_count, { before: 9, after: 7 });
    assert.equal(lintIntroCount(r.md).ok, true);
  });

  it("recusa sem efeito: destino inexistente, já no destino, URL fora do pool", () => {
    assert.throws(() => moveItemInReviewedMd(MD, R1, "lancamento"), /não existe/);
    assert.throws(() => moveItemInReviewedMd(MD, R1, "radar"), /já está/);
    assert.throws(() => moveItemInReviewedMd(MD, "https://d.com/1", "radar"), /não encontrada/);
  });
});

describe("moveInApprovedJson (#9680)", () => {
  it("muda de bucket e o arquivo que não tinha o item recebe cópia", () => {
    const a = approved();
    const r = moveInApprovedJson(a, R1, "use_melhor");
    assert.equal(r.from, "radar");
    assert.deepEqual(a.radar.map((x) => x.url), [R2]);
    assert.deepEqual(a.use_melhor.map((x) => x.url), [U1, R1]);

    const capped: Record<string, unknown> = { highlights: [], radar: [], use_melhor: [] };
    moveInApprovedJson(capped, R1, "use_melhor", r.item);
    assert.deepEqual((capped.use_melhor as Array<{ url: string }>).map((x) => x.url), [R1]);
  });

  it("destaque não é item do pool", () => {
    assert.throws(() => moveInApprovedJson(approved(), "https://d.com/2", "radar"), /destaque/);
  });
});

describe("movePoolItem CLI-level (#9680, cenário 261006)", () => {
  it("grava reviewed + approved + capped e o url-bucket passa nos dois", () => {
    const dir = mkdtempSync(join(tmpdir(), "move-pool-9680-"));
    try {
      const internal = join(dir, "_internal");
      mkdirSync(internal, { recursive: true });
      writeFileSync(join(dir, "02-reviewed.md"), MD);
      writeFileSync(join(internal, "01-approved.json"), JSON.stringify(approved(), null, 2));
      const capped = approved();
      capped.radar = capped.radar.filter((x) => x.url !== R1); // capped sem o item
      writeFileSync(join(internal, "01-approved-capped.json"), JSON.stringify(capped, null, 2));
      writeFileSync(
        join(internal, "use-melhor-post.json"),
        JSON.stringify({ enabled: true, item: { url: U1, title: "Guia" } }),
      );

      const res = movePoolItem(dir, R1, "use_melhor", { tempo: 6 });
      assert.equal(res.from, "radar");
      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      for (const f of ["01-approved.json", "01-approved-capped.json"]) {
        const data = JSON.parse(readFileSync(join(internal, f), "utf8"));
        assert.deepEqual(lintNewsletter(md, data).errors, [], f);
      }
      assert.ok(res.next_steps.some((s) => s.includes("--reviewed --force")), "4º post segue, re-seleção é opcional");

      // Tirar o item do 4º post do USE MELHOR exige re-seleção.
      const back = movePoolItem(dir, U1, "radar");
      assert.ok(back.next_steps.some((s) => s.includes("select-use-melhor-post.ts") && s.includes("## um")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run não grava", () => {
    const dir = mkdtempSync(join(tmpdir(), "move-pool-9680-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "02-reviewed.md"), MD);
      movePoolItem(dir, R1, "video", { dryRun: true });
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), MD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
