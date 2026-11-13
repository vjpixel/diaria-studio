/**
 * #12945 — incluir item NOVO no pool no gate 4 (caso 261113: "Introducing
 * Claude Meetings" em LANÇAMENTOS). À mão, o url-bucket reprovava com
 * found_in_bucket: "missing" até patchar os dois approved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addItemToReviewedMd, addPoolItem, findLateRefreshCandidate } from "../scripts/add-pool-item.ts";
import { lintNewsletter } from "../scripts/lib/lint-checks/url-bucket.ts";
import { lintIntroCount } from "../scripts/lib/newsletter-count.ts";
import { checkUseMelhorTempo } from "../scripts/lib/lint-checks/use-melhor-tempo.ts";

const L1 = "https://openai.com/index/x";
const R1 = "https://exemplo.com/radar-1";
const NEW = "https://claude.com/resources/articles/claude-meetings";

const MD = `Olá!

Nesta edição, a IA analisou 100 conteúdos (2 enviados por mim e 98 encontrados automaticamente) e selecionei os 4 mais relevantes.

---

**DESTAQUE 1 | 📦 PRODUTO**

**[D1](https://d.com/1)**

Corpo.

---

**🛠️ USE MELHOR**

**[Guia](https://exemplo.com/guia)**
Passo a passo. (5 min)

---

**🚀 LANÇAMENTO**

**[Lançamento um](${L1})**
Descrição do lançamento.

---

**📡 RADAR**

**[Radar um](${R1})**
Descrição do radar um.

---

**ERRO INTENCIONAL**

Texto.
`;

function approved() {
  return {
    highlights: [{ url: "https://d.com/1", article: { url: "https://d.com/1" } }],
    lancamento: [{ url: L1, title: "Lançamento um", category: "lancamento" }],
    radar: [{ url: R1, title: "Radar um", category: "noticias" }],
    use_melhor: [{ url: "https://exemplo.com/guia", title: "Guia", category: "tutorial" }],
    video: [],
  };
}

const ITEM = { url: NEW, title: "Introducing Claude Meetings", summary: "O Claude entra em videochamadas como participante." };

describe("addItemToReviewedMd (#12945)", () => {
  it("anexa ao fim da seção, ajusta plural e a intro", () => {
    const r = addItemToReviewedMd(MD, ITEM, "lancamento");
    assert.match(r.md, /\*\*🚀 LANÇAMENTOS\*\*/);
    assert.match(r.md, /Descrição do lançamento\.\n\n\*\*\[Introducing Claude Meetings\]\(https:\/\/claude\.com[^)]*\)\*\*\nO Claude entra em videochamadas como participante\.\n\n---/);
    assert.deepEqual(r.intro_count, { before: 4, after: 5 });
    assert.equal(lintIntroCount(r.md).ok, true);
  });

  it("USE MELHOR exige --tempo e anexa '(N min)'", () => {
    assert.throws(() => addItemToReviewedMd(MD, ITEM, "use_melhor"), /--tempo/);
    const r = addItemToReviewedMd(MD, ITEM, "use_melhor", { tempo: 4 });
    assert.equal(r.tempo_added, "(4 min)");
    assert.equal(checkUseMelhorTempo(r.md).ok, true);
  });

  it("recusa URL que já está no MD e seção inexistente", () => {
    assert.throws(() => addItemToReviewedMd(MD, { ...ITEM, url: R1 }, "lancamento"), /já está em 02-reviewed\.md/);
    assert.throws(() => addItemToReviewedMd(MD, ITEM, "video"), /não existe/);
  });
});

describe("findLateRefreshCandidate (#12945)", () => {
  it("acha pelo URL normalizado e devolve título/resumo/fonte", () => {
    const c = findLateRefreshCandidate(
      { candidates: [{ url: `${NEW}/`, title: "Introducing Claude Meetings, now in beta", summary: "Add Claude to calls.", source: "Claude Articles", published_at: "2026-11-12" }] },
      NEW,
    );
    assert.equal(c?.title, "Introducing Claude Meetings, now in beta");
    assert.equal(c?.source, "Claude Articles");
    assert.equal(findLateRefreshCandidate({ candidates: [] }, NEW), null);
  });
});

describe("addPoolItem (#12945) — cenário 261113", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "add-pool-12945-"));
    mkdirSync(join(dir, "_internal"));
    writeFileSync(join(dir, "02-reviewed.md"), MD);
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved(), null, 2));
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(approved(), null, 2));
    writeFileSync(
      join(dir, "_internal", "04-late-refresh.json"),
      JSON.stringify({ candidates: [{ url: NEW, title: "Introducing Claude Meetings", summary: "Claude joins video calls.", source: "Claude Articles", published_at: "2026-11-12" }] }),
    );
    return dir;
  }

  it("item do refresh tardio: grava nos dois approved e o url-bucket passa", () => {
    const dir = setup();
    try {
      const r = addPoolItem(dir, { url: NEW }, "lancamento");
      assert.equal(r.from_late_refresh, true);
      assert.equal(r.rewritten.length, 3);
      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      for (const f of ["01-approved.json", "01-approved-capped.json"]) {
        const a = JSON.parse(readFileSync(join(dir, "_internal", f), "utf8"));
        const it = a.lancamento.find((x: { url: string }) => x.url === NEW);
        assert.equal(it.flag, "editor_added_at_gate");
        assert.equal(it.category, "lancamento");
        assert.equal(it.source, "Claude Articles");
        assert.equal(lintNewsletter(md, a).errors.length, 0, `${f}: url-bucket limpo`);
      }
      assert.ok(r.next_steps.some((s) => s.includes("validate-lancamentos.ts")));
      assert.ok(r.next_steps.some((s) => s.includes("audit-newsletter-intake.ts")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem refresh tardio e sem --title/--summary: recusa sem gravar", () => {
    const dir = setup();
    try {
      assert.throws(() => addPoolItem(dir, { url: "https://outro.com/x" }, "radar"), /--title e --summary/);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), MD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("URL que é destaque: recusa", () => {
    const dir = setup();
    try {
      assert.throws(() => addPoolItem(dir, { url: "https://d.com/1", title: "t", summary: "s" }, "radar"), /já está|destaque/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run não grava", () => {
    const dir = setup();
    try {
      addPoolItem(dir, { url: NEW }, "radar", { dryRun: true });
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), MD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
