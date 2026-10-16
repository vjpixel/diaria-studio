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
 *   1. o `platform.config.json` REAL não pina o slot 2 com caixa PERMANENTE.
 *      Pin do slot 2 só é legítimo enquanto um box temporário de
 *      Artigo Especial/Retrospectiva vigora (`box-slot-pin.ts`, #9474) — e
 *      esse pin entra no config por PR, então o teste NÃO pode exigir
 *      `pinned_slots` sem o 2 (#10343: a versão anterior lia o config real e
 *      ficava vermelha na PR legítima do pin);
 *   2. com o slot 2 não pinado (cenário em fixture, independente de quem ocupa
 *      o slot hoje), uma caixa que saiu na edição imediatamente anterior NÃO
 *      se repete quando há outro candidato — e, como controle, com o slot
 *      pinado o mesmo cenário repete (o bug).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBoxesDivulgacaoAutoConfig, resolveBoxesForEdition } from "../scripts/select-boxes-by-clicks.ts";
import { applyBoxPin, ARTIGO_ESPECIAL_BOX_FILENAME, type BoxesDivulgacaoConfig } from "../scripts/lib/box-slot-pin.ts";
import { RETROSPECTIVA_BOX_FILENAME } from "../scripts/update-retrospectiva-box.ts";

const REPO_CONFIG = join(import.meta.dirname, "..", "platform.config.json");

/** Boxes temporários que legitimamente pinam o slot 2 enquanto vigoram (#9474). */
const TEMP_SLOT2_PIN_FILES: ReadonlySet<string> = new Set([ARTIGO_ESPECIAL_BOX_FILENAME, RETROSPECTIVA_BOX_FILENAME]);

/**
 * #10343: `null` = config OK; string = motivo da violação. O slot 2 pinado só
 * passa se `boxes_divulgacao.slot2` aponta pra um box temporário de pin.
 */
function slot2PinViolation(cfg: BoxesDivulgacaoConfig): string | null {
  const pinned = cfg.boxes_divulgacao_auto?.pinned_slots ?? [];
  if (!pinned.includes(2)) return null;
  const slot2 = cfg.boxes_divulgacao?.slot2;
  if (typeof slot2 === "string" && TEMP_SLOT2_PIN_FILES.has(slot2)) return null;
  return `slot 2 pinado com caixa permanente (${JSON.stringify(slot2)}) escapa da anti-repetição e repete a mesma caixa toda edição (#10303)`;
}

function readRepoConfig(): BoxesDivulgacaoConfig {
  return JSON.parse(readFileSync(REPO_CONFIG, "utf8")) as BoxesDivulgacaoConfig;
}

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
  it("platform.config.json REAL: auto ligado e slot 2 nunca pinado com caixa permanente", () => {
    assert.equal(loadBoxesDivulgacaoAutoConfig(REPO_CONFIG).enabled, true);
    assert.equal(slot2PinViolation(readRepoConfig()), null);
  });

  it("com slot 2 não pinado, não repete a caixa da edição anterior quando há outro candidato", () => {
    const { effective, selection } = scenario(new Set([1]));
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

describe("#10343 — o guard do config real aceita o pin legítimo do slot 2", () => {
  for (const file of [ARTIGO_ESPECIAL_BOX_FILENAME, RETROSPECTIVA_BOX_FILENAME]) {
    it(`config real + pin do slot 2 por ${file} (o que a PR do pin grava) continua verde`, () => {
      const pinned = applyBoxPin(readRepoConfig(), { slot: 2, filename: file, pin: true });
      assert.ok(pinned.boxes_divulgacao_auto?.pinned_slots?.includes(2));
      assert.equal(slot2PinViolation(pinned), null);
    });
  }

  it("pin do slot 2 com caixa permanente (o #10303) segue reprovado", () => {
    const pinned = applyBoxPin(readRepoConfig(), { slot: 2, filename: "livros-divulgacao.md", pin: true });
    assert.match(slot2PinViolation(pinned) ?? "", /caixa permanente/);
  });
});
