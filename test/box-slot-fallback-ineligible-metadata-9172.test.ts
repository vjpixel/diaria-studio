/**
 * #9172 — `mode: "fallback-ineligible"` (#9155) grava o slot VAZIO
 * (`file: null`) em `_internal/box-selection.json` porque o
 * `boxes_divulgacao.slotN` do config foi recusado. Se o editor colar um box
 * à mão nesse slot no Stage 4 e o match por conteúdo falhar, o render e o
 * aviso de alt ausente caíam no config — ou seja, no arquivo RECUSADO — e
 * herdavam categoria/alt/título dele. O slot esvaziado agora conta como
 * "sem arquivo" e nunca cai no config.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveBoxDivulgacaoCategoriaForSlot,
  resolveBoxDivulgacaoAltForSlot,
  resolveBoxDivulgacaoNoTituloForSlot,
  resolveBoxDivulgacaoTituloForSlot,
} from "../scripts/lib/newsletter-parse.ts";
import { checkBoxDivulgacaoAltMissing } from "../scripts/lib/invariant-checks/stage-4.ts";

const REJECTED = "evento-recusado.md";
const REJECTED_BODY =
  "<!--\nnome: Evento\ncategoria: EVENTO RECUSADO\nalt: Alt do arquivo recusado\ntitulo: true\n-->\n\n**Workshop que já passou**\n\nInscrições encerradas há tempos.";

const MD = `Para esta edição, selecionamos 15 itens.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título D1](https://example.com/d1)**

Corpo do destaque 1.

Por que isso importa:

Algo importante.

---

**📚 Box colado à mão pelo editor, sem snippet nenhum. [Veja](https://livros.diar.ia.br).**

---

**DESTAQUE 2 | 🚀 LANÇAMENTO**

**[Título D2](https://example.com/d2)**

Corpo do destaque 2.
`;

const PASTED_BOX = "Box colado à mão pelo editor, sem snippet nenhum.";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup(entry: Record<string, unknown> | null): { dir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "box-9172-root-"));
  mkdirSync(join(root, "data", "snippets"), { recursive: true });
  writeFileSync(join(root, "data", "snippets", REJECTED), REJECTED_BODY);
  writeFileSync(join(root, "platform.config.json"), JSON.stringify({ boxes_divulgacao: { slot1: REJECTED } }));
  const dir = mkdtempSync(join(tmpdir(), "box-9172-ed-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(resolve(dir, "02-reviewed.md"), MD);
  writeFileSync(
    resolve(dir, "06-public-images.json"),
    JSON.stringify({ images: { livros_promo: { cloudflare_url: "https://img.example/livros.jpg" } } }),
  );
  if (entry) writeFileSync(resolve(dir, "_internal", "box-selection.json"), JSON.stringify([entry]));
  dirs.push(root, dir);
  return { dir, root };
}

const INELIGIBLE = {
  slot: 1,
  mode: "fallback-ineligible",
  file: null,
  rejectedFile: REJECTED,
  rejectReason: "evento",
  nome: null,
  score: null,
  trend: null,
  editionsAppeared: null,
  seasonal: null,
};

describe("slot fallback-ineligible não herda metadados do snippet recusado (#9172)", () => {
  it("render: categoria/alt/título ficam vazios, não vêm do config", () => {
    const { dir, root } = setup(INELIGIBLE);
    assert.equal(resolveBoxDivulgacaoCategoriaForSlot(1, dir, root, PASTED_BOX), null);
    assert.equal(resolveBoxDivulgacaoAltForSlot(1, dir, root, PASTED_BOX), null);
    assert.equal(resolveBoxDivulgacaoTituloForSlot(1, dir, root, PASTED_BOX), false);
    assert.equal(resolveBoxDivulgacaoNoTituloForSlot(1, dir, root, PASTED_BOX), false);
  });

  it("controle: sem box-selection.json, o config continua valendo (comportamento pré-#9155)", () => {
    const { dir, root } = setup(null);
    assert.equal(resolveBoxDivulgacaoCategoriaForSlot(1, dir, root, PASTED_BOX), "EVENTO RECUSADO");
    assert.equal(resolveBoxDivulgacaoAltForSlot(1, dir, root, PASTED_BOX), "Alt do arquivo recusado");
    assert.equal(resolveBoxDivulgacaoTituloForSlot(1, dir, root, PASTED_BOX), true);
  });

  it("controle: entry com file:null em outro modo segue caindo no config", () => {
    const { dir, root } = setup({ ...INELIGIBLE, mode: "fallback-no-candidates", rejectedFile: undefined });
    assert.equal(resolveBoxDivulgacaoCategoriaForSlot(1, dir, root, PASTED_BOX), "EVENTO RECUSADO");
  });

  it("controle: entry com file normal resolve pelo arquivo da entry, não pelo config", () => {
    const { dir, root } = setup({ ...INELIGIBLE, mode: "auto", file: "outro.md", rejectedFile: undefined });
    writeFileSync(join(root, "data", "snippets", "outro.md"), "<!--\nnome: Outro\ncategoria: OUTRO\n-->\n\nTexto do outro snippet aqui.");
    assert.equal(resolveBoxDivulgacaoCategoriaForSlot(1, dir, root, PASTED_BOX), "OUTRO");
  });

  it("casamento por conteúdo vence o vazio: editor colou de volta o próprio snippet recusado", () => {
    const { dir, root } = setup(INELIGIBLE);
    const box = "Workshop que já passou — Inscrições encerradas há tempos.";
    assert.equal(resolveBoxDivulgacaoCategoriaForSlot(1, dir, root, box), "EVENTO RECUSADO");
    assert.equal(resolveBoxDivulgacaoAltForSlot(1, dir, root, box), "Alt do arquivo recusado");
  });

  it("slot 2 esvaziado também não herda do config", () => {
    const { dir, root } = setup({ ...INELIGIBLE, slot: 2 });
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ boxes_divulgacao: { slot2: REJECTED } }));
    assert.equal(resolveBoxDivulgacaoCategoriaForSlot(2, dir, root, PASTED_BOX), null);
    assert.equal(resolveBoxDivulgacaoAltForSlot(2, dir, root, PASTED_BOX), null);
  });

  it("invariant de alt: não usa o alt do arquivo recusado e não cita o config", () => {
    const { dir, root } = setup(INELIGIBLE);
    const v = checkBoxDivulgacaoAltMissing(dir, root);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "box-divulgacao-alt-missing");
    assert.doesNotMatch(v[0].message, /boxes_divulgacao\.slot1/);
    assert.doesNotMatch(v[0].message, /evento-recusado\.md/);
    assert.match(v[0].message, /fallback recusado/);
    // Fix acionável pro box colado à mão — não "adicionar alt ao header do snippet".
    assert.doesNotMatch(v[0].message, /ao header do snippet/);
    assert.match(v[0].message, /aceitar o anchor text/);
  });
});
