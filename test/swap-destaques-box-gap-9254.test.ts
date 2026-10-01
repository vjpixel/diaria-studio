/**
 * #9254: `swap-destaques.ts` (e `swap-destaque.ts`, que compartilha
 * `removeDestaqueBlockFromMd`) apagava a caixa de divulgação da lacuna logo
 * depois do destaque trocado — o bloco do destaque ia até o próximo `---`
 * seguido de DESTAQUE/seção, engolindo a caixa. Caso real 261001: caixa do
 * slot 2 (livro, entre D2 e D3) sumiu após `--d2-url`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { removeDestaqueBlockFromMd } from "../scripts/swap-destaque.ts";
import { extractBoxDivulgacao1, extractBoxDivulgacao2 } from "../scripts/lib/newsletter-parse.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "swap-destaques.ts");

const BOX_SLOT1 =
  "**📣 Workshop de agentes de IA, inscrições abertas. [Quero participar](https://exemplo.com/workshop)**";
const BOX_SLOT2 =
  "**📚 IA – do Zero a Superpoderes, o livro. [Comprar na Amazon](https://exemplo.com/livro)**";

function reviewedMdWithBoxes(): string {
  return `Intro texto.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Artigo D1](https://example.com/d1)**

Texto do destaque 1. Por que isso importa: relevância 1.

---

${BOX_SLOT1}

---

**DESTAQUE 2 | 📡 RADAR**

**[Artigo D2](https://example.com/d2)**

Texto do destaque 2. Por que isso importa: relevância 2.

---

${BOX_SLOT2}

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[Artigo D3](https://example.com/d3)**

Texto do destaque 3. Por que isso importa: relevância 3.

---

**📡 RADAR**

[Link radar](https://example.com/r)

Descrição radar.
`;
}

function approved(): Record<string, unknown> {
  const h = (n: number) => ({
    rank: n,
    score: 80,
    bucket: "radar",
    url: `https://example.com/d${n}`,
    article: { url: `https://example.com/d${n}`, title: `Artigo D${n}` },
  });
  return { highlights: [h(1), h(2), h(3)], radar: [], lancamento: [], use_melhor: [], video: [], runners_up: [] };
}

describe("swap preserva caixas de divulgação entre destaques (#9254)", () => {
  it("fixture tem as 2 caixas detectáveis (sanidade)", () => {
    const md = reviewedMdWithBoxes();
    assert.ok(extractBoxDivulgacao1(md)?.includes("Workshop"));
    assert.ok(extractBoxDivulgacao2(md)?.includes("Superpoderes"));
  });

  it("trocar D2 mantém a caixa da lacuna D2/D3 (caso real 261001)", () => {
    const md = reviewedMdWithBoxes();
    const out = removeDestaqueBlockFromMd(md, 2, "Título Y", "https://novo.com/y");
    assert.match(out, /RASCUNHO PENDENTE/);
    assert.ok(!out.includes("Texto do destaque 2"), "texto antigo do D2 deve sair");
    assert.ok(out.includes(BOX_SLOT2), "caixa do slot 2 sumiu");
    assert.equal(extractBoxDivulgacao2(out), extractBoxDivulgacao2(md));
    assert.equal(extractBoxDivulgacao1(out), extractBoxDivulgacao1(md));
    assert.ok(out.includes("Texto do destaque 3"));
  });

  it("trocar D1 ou D3 mantém as duas caixas", () => {
    const md = reviewedMdWithBoxes();
    const out1 = removeDestaqueBlockFromMd(md, 1, "T", "https://novo.com/a");
    assert.ok(out1.includes(BOX_SLOT1) && out1.includes(BOX_SLOT2));
    assert.ok(!out1.includes("Texto do destaque 1"));
    const out3 = removeDestaqueBlockFromMd(md, 3, "T", "https://novo.com/b");
    assert.ok(out3.includes(BOX_SLOT1) && out3.includes(BOX_SLOT2));
    assert.ok(out3.includes("**📡 RADAR**"));
    assert.ok(!out3.includes("Texto do destaque 3"));
  });

  it("CLI: --d2-url com caixa na lacuna D2/D3 preserva a caixa em 02-reviewed.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-box-9254-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved(), null, 2));
      writeFileSync(join(dir, "02-reviewed.md"), reviewedMdWithBoxes());
      execFileSync(
        "npx",
        ["tsx", SCRIPT, "--edition", "261001", "--edition-dir", dir, "--d2-url", "https://novo.com/y", "--d2-title", "Título Y"],
        { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.ok(md.includes(BOX_SLOT2), "caixa do slot 2 sumiu após swap-destaques");
      assert.ok(md.includes(BOX_SLOT1));
      assert.match(md, /RASCUNHO PENDENTE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
