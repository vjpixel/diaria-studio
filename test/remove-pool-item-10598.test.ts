/**
 * #10598 — remover item do pool no gate do Stage 4 (caso 261020). À mão
 * deixava a intro "selecionei os N" desatualizada e a seção vazia no MD.
 * `01-approved.json` fica intacto (#8121 approved-item-removal).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeItemFromReviewedMd, removePoolItem } from "../scripts/remove-pool-item.ts";
import { lintNewsletter } from "../scripts/lib/lint-checks/url-bucket.ts";
import { lintIntroCount } from "../scripts/lib/newsletter-count.ts";
import { detectRemovedApprovedItems } from "../scripts/lib/lint-checks/approved-item-removal.ts";

const L1 = "https://openai.com/index/lancamento";
const R1 = "https://exemplo.com/radar-1";
const R2 = "https://exemplo.com/radar-2";
const U1 = "https://exemplo.com/guia";
const V1 = "https://www.youtube.com/watch?v=abc";
const V2 = "https://www.youtube.com/watch?v=def";

const MD = `Olá!

Nesta edição, a IA analisou 100 conteúdos (2 enviados por mim e 98 encontrados automaticamente) e selecionei os 9 mais relevantes.

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

**🚀 LANÇAMENTO**

**[Lançamento](${L1})**
Um lançamento oficial.

---

**🛠️ USE MELHOR**

**[Guia](${U1})**
Passo a passo para usar a ferramenta. (5 min)

---

**📺 VÍDEOS**

**[Vídeo um](${V1})**
Um vídeo.

**[Vídeo dois](${V2})**
Outro vídeo.

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
    lancamento: [{ url: L1, title: "Lançamento" }],
    radar: [
      { url: R1, title: "Radar um", score: 60 },
      { url: R2, title: "Radar dois", score: 50 },
    ],
    use_melhor: [{ url: U1, title: "Guia", score: 55 }],
    video: [
      { url: V1, title: "Vídeo um" },
      { url: V2, title: "Vídeo dois" },
    ],
  };
}

describe("removeItemFromReviewedMd (#10598)", () => {
  it("o MD de base é consistente (intro 9)", () => {
    assert.equal(lintIntroCount(MD).ok, true);
  });

  it("remove o item do RADAR e recalcula a intro", () => {
    const r = removeItemFromReviewedMd(MD, R1);
    assert.equal(r.from, "radar");
    assert.equal(r.section_removed, false);
    assert.ok(!r.md.includes(R1));
    assert.ok(!r.md.includes("Descrição do radar um"), "descrição sai junto");
    assert.ok(r.md.includes(R2), "o outro item do RADAR fica");
    assert.deepEqual(r.intro_count, { before: 9, after: 8 });
    assert.match(r.md, /selecionei os 8 mais relevantes/);
    assert.equal(lintIntroCount(r.md).ok, true);
    assert.match(r.md, /\*\*📡 RADAR\*\*\n\n\*\*\[Radar dois\]/, "sem linha em branco acumulada");
  });

  it("seção que fica vazia some inteira (LANÇAMENTOS), sem separador duplicado", () => {
    const r = removeItemFromReviewedMd(MD, L1);
    assert.equal(r.from, "lancamento");
    assert.equal(r.section_removed, true);
    assert.ok(!/LANÇAMENTO/.test(r.md), "header removido");
    assert.ok(!/---\n\n---/.test(r.md), "não sobra separador duplicado");
    assert.match(r.md, /Corpo\.\n\n---\n\n\*\*🛠️ USE MELHOR\*\*/);
    assert.equal(lintIntroCount(r.md).ok, true);
  });

  it("header vai pro singular quando sobra 1 item (VÍDEOS → VÍDEO)", () => {
    const r = removeItemFromReviewedMd(MD, V1);
    assert.match(r.md, /^\*\*📺 VÍDEO\*\*$/m);
    assert.ok(r.md.includes(V2));
  });

  it("preserva CRLF", () => {
    const r = removeItemFromReviewedMd(MD.replace(/\n/g, "\r\n"), R1);
    assert.ok(!/[^\r]\n/.test(r.md), "todas as quebras seguem CRLF");
  });

  it("recusa URL fora do pool (destaque ou inexistente)", () => {
    assert.throws(() => removeItemFromReviewedMd(MD, "https://d.com/1"), /não encontrada/);
    assert.throws(() => removeItemFromReviewedMd(MD, "https://nada.com"), /não encontrada/);
  });
});

describe("removePoolItem CLI-level (#10598, cenário 261020)", () => {
  function setup(): string {
    const dir = mkdtempSync(join(tmpdir(), "remove-pool-10598-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), MD);
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved(), null, 2));
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(approved(), null, 2));
    return dir;
  }

  it("grava só o MD; approved e capped ficam byte-idênticos (#8121) e url-bucket passa", () => {
    const dir = setup();
    try {
      const before = ["01-approved.json", "01-approved-capped.json"].map((f) =>
        readFileSync(join(dir, "_internal", f), "utf8"),
      );
      const res = removePoolItem(dir, L1);
      assert.equal(res.from, "lancamento");
      assert.equal(res.section_removed, true);
      assert.deepEqual(res.rewritten, [join(dir, "02-reviewed.md")]);

      const after = ["01-approved.json", "01-approved-capped.json"].map((f) =>
        readFileSync(join(dir, "_internal", f), "utf8"),
      );
      assert.deepEqual(after, before, "approved intacto");

      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.ok(!md.includes(L1));
      const data = JSON.parse(after[0]);
      assert.deepEqual(lintNewsletter(md, data).errors, []);
      assert.deepEqual(detectRemovedApprovedItems(approved(), data), [], "nada sumiu do approved");
      assert.ok(res.next_steps.some((s) => s.includes("#8121")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("item do 4º post social (## um) pede re-seleção", () => {
    const dir = setup();
    try {
      writeFileSync(
        join(dir, "_internal", "use-melhor-post.json"),
        JSON.stringify({ enabled: true, item: { url: U1, title: "Guia" } }),
      );
      const other = removePoolItem(dir, R1);
      assert.ok(!other.next_steps.some((s) => s.includes("select-use-melhor-post.ts")));
      const res = removePoolItem(dir, U1);
      assert.equal(res.section_removed, true);
      assert.ok(res.next_steps.some((s) => s.includes("select-use-melhor-post.ts") && s.includes("## um")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run não grava", () => {
    const dir = setup();
    try {
      const res = removePoolItem(dir, R1, { dryRun: true });
      assert.equal(res.dry_run, true);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), MD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
