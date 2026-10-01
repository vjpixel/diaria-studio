// #8990 fatia (a): apply-box-slot troca o box de um slot pós-stitch, sem
// sobrescrever box editado pelo editor (#495/#7401).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyBoxSlot, type BoxSelectionEntry } from "../scripts/apply-box-slot.ts";
import { extractBoxDivulgacao1, extractBoxDivulgacao2 } from "../scripts/lib/newsletter-parse.ts";

const OLD = "**📚 Livro velho: [Compre](https://amzn.to/velho)**";
const NEW = "**📣 Workshop novo: [Inscreva-se](https://diar.ia.br/workshop?utm_content=x)**";
const OTHER = "**🎉 Outra caixa: [Veja](https://x.com/outra)**";

const md = (box1: string, box2 = OTHER): string =>
  `intro\n\n---\n\n**DESTAQUE 1 | 🚀**\n\n[Título 1](https://d1.com)\n\ncorpo 1\n\n---\n\n${box1}\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[Título 2](https://d2.com)\n\ncorpo 2\n\n---\n\n${box2}\n\n---\n\n**DESTAQUE 3 | 🚀**\n\n[Título 3](https://d3.com)\n\ncorpo 3\n`;

const selection = (): BoxSelectionEntry[] => [
  { slot: 1, mode: "auto", file: "velho.md", score: 3 },
  { slot: 2, mode: "fallback-no-candidates", file: "outra.md" },
  { slot: 3, mode: "disabled", file: null },
];

describe("#8990 applyBoxSlot", () => {
  it("box intacto -> troca só a faixa do box e atualiza box-selection", () => {
    const before = md(OLD);
    const res = applyBoxSlot({ reviewedMd: before, selection: selection(), slot: 1, newFile: "novo.md", newRendered: NEW, currentRendered: OLD });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.reviewedMd, md(NEW));
    assert.equal(extractBoxDivulgacao2(res.reviewedMd), extractBoxDivulgacao2(before), "slot 2 intocado");
    const s1 = res.selection.find((e) => e.slot === 1)!;
    assert.equal(s1.file, "novo.md");
    assert.equal(s1.mode, "manual");
    assert.equal(res.selection.find((e) => e.slot === 2)!.file, "outra.md");
  });

  it("slot 2 também funciona", () => {
    const res = applyBoxSlot({ reviewedMd: md(OLD), selection: selection(), slot: 2, newFile: "novo.md", newRendered: NEW, currentRendered: OTHER });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.reviewedMd, md(OLD, NEW));
    assert.ok(extractBoxDivulgacao1(res.reviewedMd));
  });

  it("box editado pelo editor -> aborta (edited), sem devolver texto", () => {
    const edited = "**📚 Livro velho, texto que o editor reescreveu: [Compre](https://amzn.to/velho)**";
    const res = applyBoxSlot({ reviewedMd: md(edited), selection: selection(), slot: 1, newFile: "novo.md", newRendered: NEW, currentRendered: OLD });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, "edited");
  });

  it("--force sobrescreve mesmo editado", () => {
    const edited = "**📚 Editado: [Compre](https://amzn.to/velho)**";
    const res = applyBoxSlot({ reviewedMd: md(edited), selection: selection(), slot: 1, newFile: "novo.md", newRendered: NEW, currentRendered: OLD, force: true });
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.reviewedMd, md(NEW));
  });

  it("sem baseline (snippet registrado ausente) -> aborta sem --force", () => {
    const res = applyBoxSlot({ reviewedMd: md(OLD), selection: [], slot: 1, newFile: "novo.md", newRendered: NEW, currentRendered: null });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "no-baseline");
  });

  it("sem entry do slot em box-selection -> cria entry (com --force)", () => {
    const res = applyBoxSlot({ reviewedMd: md(OLD), selection: [], slot: 1, newFile: "novo.md", newRendered: NEW, currentRendered: null, force: true });
    assert.ok(res.ok);
    if (res.ok) assert.deepEqual(res.selection.map((e) => [e.slot, e.file, e.mode]), [[1, "novo.md", "manual"]]);
  });

  it("diferença só de whitespace/CRLF não conta como edição", () => {
    const res = applyBoxSlot({ reviewedMd: md(OLD), selection: selection(), slot: 1, newFile: "novo.md", newRendered: NEW, currentRendered: `\n${OLD}\r\n` });
    assert.ok(res.ok);
  });
});
