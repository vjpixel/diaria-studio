/**
 * #10214: a validade (`expires:`) da caixa só era checada no stitch.
 * `apply-box-slot.ts` e o botão "aplicar na edição" do painel Caixas aplicavam
 * caixa vencida sem aviso; o invariante `box-divulgacao-expiry` só lia o
 * config, nunca a caixa presente na edição; e o painel julgava pela data de
 * HOJE, não da edição em montagem (D+1).
 *
 * Cenário real: caixa do evento de 17/10 (`expires: 2026-10-17`) aplicada no
 * gate do Stage 4 na edição de 18/10.
 *
 * Tudo em diretório temporário: `data/` é gitignored (#5227).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBoxSlotToEdition } from "../scripts/apply-box-slot.ts";
import { applySlotToStitchedEdition, listBoxes } from "../scripts/studio-ui/studio-boxes.ts";
import { checkBoxDivulgacaoExpiry } from "../scripts/lib/invariant-checks/stage-4.ts";

const EVENTO = `<!--
nome: Agente de IA em uma hora (17/10)
expires: 2026-10-17
-->

**📣 Agente de IA: um mês em uma hora: [Quero participar](https://diar.ia.br/evento/agente-ia)**`;
const EVENTO_BODY = "**📣 Agente de IA: um mês em uma hora: [Quero participar](https://diar.ia.br/evento/agente-ia)**";
const OLD = "**📚 Livro velho: [Compre](https://amzn.to/velho)**";
const OTHER = "**🎉 Outra caixa: [Veja](https://x.com/outra)**";
const md = (box1: string, box2 = OTHER): string =>
  `intro\n\n---\n\n**DESTAQUE 1 | 🚀**\n\n[Título 1](https://d1.com)\n\ncorpo 1\n\n---\n\n${box1}\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[Título 2](https://d2.com)\n\ncorpo 2\n\n---\n\n${box2}\n\n---\n\n**DESTAQUE 3 | 🚀**\n\n[Título 3](https://d3.com)\n\ncorpo 3\n`;

let root = "";

function setup(edition: string, cfgSlot1 = "velho.md"): string {
  root = mkdtempSync(join(tmpdir(), "box-expiry-apply-10214-"));
  const snip = join(root, "data", "snippets");
  mkdirSync(snip, { recursive: true });
  writeFileSync(join(snip, "velho.md"), OLD);
  writeFileSync(join(snip, "evento.md"), EVENTO);
  writeFileSync(join(snip, "outra.md"), OTHER);
  writeFileSync(
    join(root, "platform.config.json"),
    JSON.stringify({ boxes_divulgacao: { slot0: "", slot1: cfgSlot1, slot2: "outra.md", slot3: null } }),
  );
  const edDir = join(root, "data", "editions", edition.slice(0, 4), edition);
  mkdirSync(join(edDir, "_internal"), { recursive: true });
  writeFileSync(join(edDir, "02-reviewed.md"), md(OLD));
  writeFileSync(
    join(edDir, "_internal", "box-selection.json"),
    JSON.stringify([
      { slot: 1, mode: "auto", file: "velho.md" },
      { slot: 2, mode: "auto", file: "outra.md" },
    ]),
  );
  return edDir;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("#10214 applyBoxSlotToEdition recusa caixa vencida", () => {
  it("edição 261018 + caixa com expires 2026-10-17 → reason expired, nada escrito", async () => {
    const edDir = setup("261018");
    const before = readFileSync(join(edDir, "02-reviewed.md"), "utf8");
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "evento.md", runUpload: () => {} });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, "expired");
    assert.match(res.message, /evento\.md/);
    assert.match(res.message, /expires: 2026-10-17/);
    assert.match(res.message, /--allow-expired/);
    assert.equal(readFileSync(join(edDir, "02-reviewed.md"), "utf8"), before, "02-reviewed.md intacto");
    const sel = JSON.parse(readFileSync(join(edDir, "_internal", "box-selection.json"), "utf8"));
    assert.equal(sel[0].file, "velho.md", "box-selection.json intacto");
  });

  it("último dia válido (edição 261017) → aplica normalmente", async () => {
    const edDir = setup("261017");
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "evento.md", runUpload: () => {} });
    assert.ok(res.ok);
    assert.ok(readFileSync(join(edDir, "02-reviewed.md"), "utf8").includes(EVENTO_BODY));
  });

  it("allowExpired → aplica com warning explícito", async () => {
    const edDir = setup("261018");
    const res = await applyBoxSlotToEdition({
      rootDir: root,
      editionDir: edDir,
      slot: 1,
      file: "evento.md",
      allowExpired: true,
      runUpload: () => {},
    });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.match(res.warnings.join(" "), /expirou.*--allow-expired/);
    assert.ok(readFileSync(join(edDir, "02-reviewed.md"), "utf8").includes(EVENTO_BODY));
  });

  it("botão do painel Caixas (applySlotToStitchedEdition) também recusa", async () => {
    const edDir = setup("261018");
    const res = await applySlotToStitchedEdition(root, { edition: "261018", slot: 1, file: "evento.md" }, { runUpload: () => {} });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, "expired");
    assert.ok(readFileSync(join(edDir, "02-reviewed.md"), "utf8").includes(OLD), "box antigo segue no lugar");
  });
});

describe("#10214 invariante box-divulgacao-expiry lê a caixa presente na edição", () => {
  it("caixa vencida presente no 02-reviewed.md (config aponta outra) → warning 'NA EDIÇÃO'", async () => {
    const edDir = setup("261018");
    const applied = await applyBoxSlotToEdition({
      rootDir: root,
      editionDir: edDir,
      slot: 1,
      file: "evento.md",
      allowExpired: true,
      runUpload: () => {},
    });
    assert.ok(applied.ok);
    const v = checkBoxDivulgacaoExpiry(edDir, root);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "box-divulgacao-expiry");
    assert.equal(v[0].severity, "warning");
    assert.match(v[0].message, /evento\.md.*NA EDIÇÃO.*slot 1/);
    assert.match(v[0].message, /vai chegar ao leitor/);
  });

  it("mesma caixa no config E presente → só o aviso de presença (nunca 'o stitch não publica')", async () => {
    const edDir = setup("261018", "evento.md");
    await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "evento.md", allowExpired: true, runUpload: () => {} });
    const v = checkBoxDivulgacaoExpiry(edDir, root);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /NA EDIÇÃO/);
    assert.doesNotMatch(v[0].message, /stitch não publica/);
  });

  it("caixa vencida só no config (stitch a pulou) → mantém o aviso do config", () => {
    const edDir = setup("261018", "evento.md");
    const v = checkBoxDivulgacaoExpiry(edDir, root);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /stitch não publica caixa vencida/);
  });

  it("caixa presente dentro da validade → sem aviso de presença", () => {
    const edDir = setup("261010");
    assert.deepEqual(checkBoxDivulgacaoExpiry(edDir, root), []);
  });
});

describe("#10214 painel Caixas julga pela próxima edição (D+1)", () => {
  it("hoje 17/10 BRT, expires 17/10 → próxima edição é 18/10: 'Expirada', não 'expira hoje'", () => {
    setup("261018");
    const boxes = listBoxes(root, new Date("2026-10-17T15:00:00Z"));
    const ev = boxes.find((b) => b.slug === "evento.md")!;
    assert.equal(ev.warnings.length, 1);
    assert.match(ev.warnings[0], /Expirada em 2026-10-17/);
  });

  it("hoje 16/10 BRT → próxima edição 17/10 é a última", () => {
    setup("261018");
    const ev = listBoxes(root, new Date("2026-10-16T15:00:00Z")).find((b) => b.slug === "evento.md")!;
    assert.match(ev.warnings[0], /Última edição: 2026-10-17/);
  });
});
