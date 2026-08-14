/**
 * test/newsletter-patronos.test.ts (#4275, Fase 1 — "Gerar e revisar")
 *
 * `scripts/lib/newsletter-patronos.ts` — variante Patronos da newsletter
 * diária: MESMO `NewsletterContent` já parseado (destaques/seções idênticos),
 * só os campos de box de divulgação (slot 0-3) são sobrescritos a partir de
 * `platform.config.json` → `boxes_divulgacao_patronos` (chave irmã de
 * `boxes_divulgacao`, não aninhada).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewsletterContent } from "../scripts/lib/newsletter-parse.ts";
import {
  loadBoxesDivulgacaoPatronosConfig,
  applyPatronosBoxes,
  PATRONOS_BOXES_CONFIG_KEY,
} from "../scripts/lib/newsletter-patronos.ts";

function writeSnippet(root: string, filename: string, content: string): void {
  mkdirSync(join(root, "data", "snippets"), { recursive: true });
  writeFileSync(join(root, "data", "snippets", filename), content, "utf8");
}

function writeConfig(root: string, cfg: Record<string, unknown>): void {
  writeFileSync(join(root, "platform.config.json"), JSON.stringify(cfg, null, 2), "utf8");
}

/** NewsletterContent mínimo, válido, com boxes PADRÃO já preenchidos — usado
 * pra provar que `applyPatronosBoxes` sobrescreve os campos de box e deixa o
 * resto (destaques/eia/sections/title/subtitle/coverImage) intocado. */
function baseContent(): NewsletterContent {
  return {
    title: "Título do destaque 1",
    subtitle: "Subtítulo",
    coverImage: "04-d1-2x1.jpg",
    destaques: [
      { n: 1, category: "lancamento", title: "D1", body: "corpo 1", why: "importa 1", url: "https://x.com/1", emoji: "🚀" },
      { n: 2, category: "radar", title: "D2", body: "corpo 2", why: "importa 2", url: "https://x.com/2", emoji: "📡" },
    ],
    eia: { credit: "Crédito", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: "260801" },
    sections: [],
    // Boxes PADRÃO preenchidos — provam que applyPatronosBoxes SOBRESCREVE
    // (não faz merge/preserva) quando a variante Patronos não tem override
    // pro slot (semântica "TROCA", não "herda o padrão").
    boxDivulgacao0: "box padrão slot 0",
    boxDivulgacao0Image: "padrao-0.jpg",
    boxDivulgacao0Bold: true,
    boxDivulgacao0Categoria: "Divulgação",
    boxDivulgacao1: "box padrão slot 1",
    boxDivulgacao1Image: "padrao-1.jpg",
    boxDivulgacao1Bold: true,
    boxDivulgacao1Categoria: "Divulgação",
    boxDivulgacao2: "box padrão slot 2",
    boxDivulgacao2Image: "padrao-2.jpg",
    boxDivulgacao2Bold: true,
    boxDivulgacao2Categoria: "Divulgação",
    boxDivulgacao3: "box padrão slot 3",
    boxDivulgacao3Image: "padrao-3.jpg",
    boxDivulgacao3Bold: true,
    boxDivulgacao3Categoria: "Divulgação",
    boxDivulgacaoImageExplicit: { 0: true, 1: true, 2: true, 3: true },
    boxDivulgacaoImagePortrait: { 0: true, 1: true, 2: true, 3: true },
    boxDivulgacaoImageAlt: { 0: "alt0", 1: "alt1", 2: "alt2", 3: "alt3" },
  };
}

describe("loadBoxesDivulgacaoPatronosConfig (#4275, pure)", () => {
  it("sem platform.config.json -> todos os slots null", () => {
    const root = mkdtempSync(join(tmpdir(), "patronos-cfg-none-"));
    assert.deepEqual(loadBoxesDivulgacaoPatronosConfig(root), {
      slot0: null,
      slot1: null,
      slot2: null,
      slot3: null,
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("lê boxes_divulgacao_patronos (chave irmã), ignorando boxes_divulgacao", () => {
    const root = mkdtempSync(join(tmpdir(), "patronos-cfg-"));
    writeConfig(root, {
      boxes_divulgacao: { slot0: null, slot1: "padrao-1.md", slot2: null, slot3: "padrao-3.md" },
      [PATRONOS_BOXES_CONFIG_KEY]: { slot0: null, slot1: "patronos-1.md", slot2: "patronos-2.md", slot3: null },
    });
    assert.deepEqual(loadBoxesDivulgacaoPatronosConfig(root), {
      slot0: null,
      slot1: "patronos-1.md",
      slot2: "patronos-2.md",
      slot3: null,
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("boxes_divulgacao_patronos ausente (config antigo, só boxes_divulgacao) -> todos null, NÃO herda o padrão", () => {
    const root = mkdtempSync(join(tmpdir(), "patronos-cfg-absent-"));
    writeConfig(root, { boxes_divulgacao: { slot0: null, slot1: "padrao-1.md", slot2: null, slot3: "padrao-3.md" } });
    assert.deepEqual(loadBoxesDivulgacaoPatronosConfig(root), {
      slot0: null,
      slot1: null,
      slot2: null,
      slot3: null,
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("JSON corrompido -> fail-soft, todos os slots null", () => {
    const root = mkdtempSync(join(tmpdir(), "patronos-cfg-corrupt-"));
    writeFileSync(join(root, "platform.config.json"), "{ not json", "utf8");
    assert.deepEqual(loadBoxesDivulgacaoPatronosConfig(root), {
      slot0: null,
      slot1: null,
      slot2: null,
      slot3: null,
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("valores não-string/vazios no bloco -> null nesse slot", () => {
    const root = mkdtempSync(join(tmpdir(), "patronos-cfg-badvalues-"));
    writeConfig(root, { [PATRONOS_BOXES_CONFIG_KEY]: { slot0: 42, slot1: "", slot2: "ok.md", slot3: null } });
    assert.deepEqual(loadBoxesDivulgacaoPatronosConfig(root), {
      slot0: null,
      slot1: null,
      slot2: "ok.md",
      slot3: null,
    });
    rmSync(root, { recursive: true, force: true });
  });
});

describe("applyPatronosBoxes (#4275, pure)", () => {
  it("sem boxes_divulgacao_patronos configurado -> TODOS os slots ficam null (não herda o box padrão do content de entrada)", () => {
    const root = mkdtempSync(join(tmpdir(), "patronos-apply-empty-"));
    // sem platform.config.json nenhum — fail-soft total
    const out = applyPatronosBoxes(baseContent(), root);

    assert.equal(out.boxDivulgacao0, null);
    assert.equal(out.boxDivulgacao1, null);
    assert.equal(out.boxDivulgacao2, null);
    assert.equal(out.boxDivulgacao3, null);
    assert.equal(out.boxDivulgacao0Image, null);
    assert.equal(out.boxDivulgacao1Image, null);
    assert.equal(out.boxDivulgacao0Bold, false);
    assert.equal(out.boxDivulgacao1Bold, false);
    assert.equal(out.boxDivulgacao0Categoria, null);
    assert.deepEqual(out.boxDivulgacaoImageExplicit, { 0: false, 1: false, 2: false, 3: false });
    assert.deepEqual(out.boxDivulgacaoImagePortrait, { 0: false, 1: false, 2: false, 3: false });
    assert.deepEqual(out.boxDivulgacaoImageAlt, { 0: null, 1: null, 2: null, 3: null });

    rmSync(root, { recursive: true, force: true });
  });

  it("com slots configurados -> texto + categoria vêm do snippet Patronos, sem imagem, sem bold", () => {
    const root = mkdtempSync(join(tmpdir(), "patronos-apply-filled-"));
    writeSnippet(
      root,
      "patronos-bastidores.md",
      "<!--\nnome: teste\ncategoria: Bastidores\n-->\n\nBastidores da Diar.ia\n\nTexto de bastidores pros Patronos.",
    );
    writeSnippet(
      root,
      "patronos-agradecimento.md",
      "Obrigado, Patronos\n\nSem header nenhum neste arquivo — categoria deve sair null.",
    );
    writeConfig(root, {
      [PATRONOS_BOXES_CONFIG_KEY]: {
        slot0: null,
        slot1: "patronos-bastidores.md",
        slot2: null,
        slot3: "patronos-agradecimento.md",
      },
    });

    const out = applyPatronosBoxes(baseContent(), root);

    assert.equal(out.boxDivulgacao0, null); // slot0 sem override -> null, não herda o padrão
    assert.match(out.boxDivulgacao1 ?? "", /Bastidores da Diar\.ia/);
    assert.doesNotMatch(out.boxDivulgacao1 ?? "", /<!--/); // header removido
    assert.equal(out.boxDivulgacao1Categoria, "Bastidores");
    assert.equal(out.boxDivulgacao1Bold, false);
    assert.equal(out.boxDivulgacao1Image, null);
    assert.equal(out.boxDivulgacao2, null);
    assert.match(out.boxDivulgacao3 ?? "", /Obrigado, Patronos/);
    assert.equal(out.boxDivulgacao3Categoria, null); // sem categoria: no header
    assert.equal(out.boxDivulgacao3Bold, false);
    assert.deepEqual(out.boxDivulgacaoImageExplicit, { 0: false, 1: false, 2: false, 3: false });
    assert.deepEqual(out.boxDivulgacaoImageAlt, { 0: null, 1: null, 2: null, 3: null });

    rmSync(root, { recursive: true, force: true });
  });

  it("sanitiza markdown (** / # / - inicial) da categoria, mesmo tratamento de readBoxDivulgacaoCategoriaForSlot", () => {
    const root = mkdtempSync(join(tmpdir(), "patronos-apply-sanitize-"));
    writeSnippet(root, "patronos-x.md", "<!--\ncategoria: **Bastidores** #\n-->\n\nCorpo.");
    writeConfig(root, { [PATRONOS_BOXES_CONFIG_KEY]: { slot0: null, slot1: "patronos-x.md", slot2: null, slot3: null } });

    const out = applyPatronosBoxes(baseContent(), root);
    assert.equal(out.boxDivulgacao1Categoria, "Bastidores");

    rmSync(root, { recursive: true, force: true });
  });

  it("snippet referenciado mas ausente em disco -> slot fica null (fail-soft, nunca lança)", () => {
    const root = mkdtempSync(join(tmpdir(), "patronos-apply-missing-"));
    writeConfig(root, { [PATRONOS_BOXES_CONFIG_KEY]: { slot0: null, slot1: "nao-existe.md", slot2: null, slot3: null } });

    const out = applyPatronosBoxes(baseContent(), root);
    assert.equal(out.boxDivulgacao1, null);
    assert.equal(out.boxDivulgacao1Categoria, null);

    rmSync(root, { recursive: true, force: true });
  });

  it("preserva destaques/eia/sections/title/subtitle/coverImage intocados (spread, não recomputados)", () => {
    const root = mkdtempSync(join(tmpdir(), "patronos-apply-preserve-"));
    const input = baseContent();
    const out = applyPatronosBoxes(input, root);

    assert.equal(out.title, input.title);
    assert.equal(out.subtitle, input.subtitle);
    assert.equal(out.coverImage, input.coverImage);
    assert.deepEqual(out.destaques, input.destaques);
    assert.deepEqual(out.eia, input.eia);
    assert.deepEqual(out.sections, input.sections);

    rmSync(root, { recursive: true, force: true });
  });
});
