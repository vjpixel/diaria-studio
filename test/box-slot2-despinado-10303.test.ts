/**
 * test/box-slot2-despinado-10303.test.ts (#10303)
 *
 * Bug: com `boxes_divulgacao_auto.pinned_slots = [1, 2]` o slot 2 ficava fora
 * do ranking E da anti-repetição de `select-boxes-by-clicks.ts` — o mesmo
 * `livros-divulgacao.md` saiu em 261014, 261015 e 261016. Decisão do editor
 * (15/10/2026): despinar o slot 2 (`pinned_slots: [1]`), devolvendo-o à
 * seleção por cliques com anti-repetição (#4626).
 *
 * Trava duas coisas:
 *   1. o `platform.config.json` REAL não pina o slot 2 (só o 1, de evento);
 *   2. com o config real carregado, um slot 2 cuja caixa configurada saiu na
 *      edição imediatamente anterior NÃO a repete quando há outro candidato —
 *      e, como controle, com o slot pinado o mesmo cenário repete (o bug).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBoxesDivulgacaoAutoConfig, resolveBoxesForEdition } from "../scripts/select-boxes-by-clicks.ts";

const REPO_CONFIG = join(import.meta.dirname, "..", "platform.config.json");

function writeSnippet(dir: string, file: string, nome: string, url: string): void {
  writeFileSync(join(dir, file), `<!-- nome: ${nome} -->\n**📚 ${nome}**\n\n[Link](${url})`);
}

/** Edição com box só no gap D2/D3 (slot 2). */
function writeEditionSlot2(editionsDir: string, aammdd: string, nome: string, url: string): void {
  const d = join(editionsDir, aammdd);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "02-reviewed.md"),
    `**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n` +
      `**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody\n\n---\n\n` +
      `**📚 ${nome}**\n\n[Link](${url})\n\n---\n\n` +
      `**DESTAQUE 3 | 🚀**\n\n[T](https://d3.com)\n\nbody`,
  );
}

function writePost(postsDir: string, id: string, iso: string, url: string, clicks: number): void {
  writeFileSync(
    join(postsDir, `${id}.json`),
    JSON.stringify({
      id,
      publish_date: Math.floor(new Date(`${iso}T09:00:00Z`).getTime() / 1000),
      stats: { clicks: [{ url, email: { verified_clicks: clicks, unique_verified_clicks: clicks } }] },
    }),
  );
}

function scenario(pinnedSlots: Set<1 | 2 | 3>) {
  const dir = mkdtempSync(join(tmpdir(), "box-slot2-10303-"));
  const editionsDir = join(dir, "editions");
  const postsDir = join(dir, "posts");
  const snippetsDir = join(dir, "snippets");
  for (const d of [editionsDir, postsDir, snippetsDir]) mkdirSync(d, { recursive: true });
  try {
    writeSnippet(snippetsDir, "livros-divulgacao.md", "Livros", "https://x.com/livros");
    writeSnippet(snippetsDir, "amazon-loja-divulgacao.md", "Loja", "https://x.com/loja");
    // 261013: loja no slot 2 (histórico com clique — candidata elegível).
    writeEditionSlot2(editionsDir, "261013", "Loja", "https://x.com/loja");
    writePost(postsDir, "p13", "2026-10-13", "https://x.com/loja", 5);
    // 261014-261016: livros no slot 2 — a repetição da issue.
    for (const [i, a] of ["261014", "261015", "261016"].entries()) {
      writeEditionSlot2(editionsDir, a, "Livros", "https://x.com/livros");
      writePost(postsDir, `p${a}`, `2026-10-${14 + i}`, "https://x.com/livros", 50);
    }
    return resolveBoxesForEdition({
      aammdd: "261017",
      boxesCfg: { slot0: "", slot1: null, slot2: "livros-divulgacao.md", slot3: null },
      autoCfg: { enabled: true, pinnedSlots, recentWindow: 3, priorWindow: 3, lastN: 20 },
      editionsDir,
      postsDir,
      snippetsDir,
      destaqueCount: 3,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#10303 — slot 2 despinado volta à anti-repetição", () => {
  it("platform.config.json REAL: auto ligado, slot 1 pinado, slot 2 NÃO pinado", () => {
    const cfg = loadBoxesDivulgacaoAutoConfig(REPO_CONFIG);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.pinnedSlots.has(1), true, "slot 1 (evento) segue pinado");
    assert.equal(
      cfg.pinnedSlots.has(2),
      false,
      "slot 2 pinado escapa da anti-repetição e repete a mesma caixa toda edição (#10303)",
    );
  });

  it("com o config real, slot 2 não repete a caixa da edição anterior quando há outro candidato", () => {
    const realPinned = loadBoxesDivulgacaoAutoConfig(REPO_CONFIG).pinnedSlots;
    const { effective, selection } = scenario(realPinned as Set<1 | 2 | 3>);
    const slot2 = selection.find((s) => s.slot === 2)!;
    assert.equal(slot2.mode, "auto");
    assert.equal(effective.slot2, "amazon-loja-divulgacao.md");
    assert.notEqual(effective.slot2, "livros-divulgacao.md");
  });

  it("controle (o bug): com slot 2 pinado, a mesma caixa repete — modo 'pinned', sem anti-repetição", () => {
    const { effective, selection } = scenario(new Set([1, 2]));
    assert.equal(selection.find((s) => s.slot === 2)!.mode, "pinned");
    assert.equal(effective.slot2, "livros-divulgacao.md");
  });
});
