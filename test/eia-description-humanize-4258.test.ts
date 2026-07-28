/**
 * test/eia-description-humanize-4258.test.ts (#4258 item 3)
 *
 * Cobre os dois scripts novos que dão suporte ao passo de
 * humanizador+Clarice sobre a frase de descrição do "É IA?" (Stage 3 do
 * orchestrator, ver .claude/agents/orchestrator-stage-3.md):
 *
 *   1. `scripts/extract-eia-description.ts` — extrai `wikimedia.description`
 *      de `01-eia-meta.json` pra um arquivo de texto plano.
 *   2. `scripts/apply-eia-description.ts` — recebe a frase já
 *      humanizada+corrigida e regrava `01-eia.md` (linha de crédito,
 *      REGERADA via `buildCreditLine` + o contexto persistido por
 *      `eia-compose.ts`) e `01-eia-meta.json` (`wikimedia.description`) de
 *      forma sincronizada — as duas saídas derivam do MESMO texto, nunca
 *      divergem.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractDescriptionFromMeta } from "../scripts/extract-eia-description.ts";
import { replaceCreditLineInEiaMd } from "../scripts/apply-eia-description.ts";
import { buildCreditLine, buildEiaMd, chooseSides } from "../scripts/eia-compose.ts";

// ── extractDescriptionFromMeta (pure) ───────────────────────────────────────

describe("extractDescriptionFromMeta (#4258 item 3, pure)", () => {
  it("extrai wikimedia.description quando presente", () => {
    const meta = { wikimedia: { description: "Uma ave rara em voo." } };
    assert.equal(extractDescriptionFromMeta(meta), "Uma ave rara em voo.");
  });

  it("description ausente → null (skip, não erro)", () => {
    assert.equal(extractDescriptionFromMeta({ wikimedia: {} }), null);
  });

  it("description vazia/só espaço → null", () => {
    assert.equal(extractDescriptionFromMeta({ wikimedia: { description: "" } }), null);
    assert.equal(extractDescriptionFromMeta({ wikimedia: { description: "   " } }), null);
  });

  it("wikimedia ausente → null", () => {
    assert.equal(extractDescriptionFromMeta({}), null);
  });

  it("input malformado (não-objeto, null, array) → null, nunca lança", () => {
    assert.equal(extractDescriptionFromMeta(null), null);
    assert.equal(extractDescriptionFromMeta(undefined), null);
    assert.equal(extractDescriptionFromMeta("string crua"), null);
    assert.equal(extractDescriptionFromMeta([1, 2, 3]), null);
  });

  it("description não-string (shape corrompido) → null", () => {
    assert.equal(extractDescriptionFromMeta({ wikimedia: { description: 123 } }), null);
  });
});

// ── replaceCreditLineInEiaMd (pure) ──────────────────────────────────────────

describe("replaceCreditLineInEiaMd (#4258 item 3, pure)", () => {
  const sides = chooseSides(0.5);

  it("substitui a creditLine preservando frontmatter + header, sem prevResultLine", () => {
    const md = buildEiaMd(sides, "Crédito original — [Foto](https://x.com/a) / CC BY-SA 4.0.", null);
    const result = replaceCreditLineInEiaMd(md, "Crédito corrigido — [Foto](https://x.com/a) / CC BY-SA 4.0.");
    assert.match(result, /^---\neia_answer:/, "frontmatter preservado no início");
    assert.match(result, /\*\*É IA\?\*\*/, "header preservado");
    assert.match(result, /Crédito corrigido/);
    assert.ok(!result.includes("Crédito original"), "creditLine antiga não deve sobreviver");
  });

  it("preserva prevResultLine intacta ao substituir a creditLine", () => {
    const md = buildEiaMd(
      sides,
      "Crédito original.",
      "Resultado da última edição: 62% das pessoas acertaram.",
    );
    const result = replaceCreditLineInEiaMd(md, "Crédito corrigido.");
    assert.match(result, /Crédito corrigido\./);
    assert.match(result, /Resultado da última edição: 62% das pessoas acertaram\./);
    assert.ok(!result.includes("Crédito original"));
  });

  it("preserva o mapping eia_answer (A/B real|ia) byte-a-byte", () => {
    const md = buildEiaMd(sides, "X.", null);
    const result = replaceCreditLineInEiaMd(md, "Y.");
    const frontmatterOriginal = md.slice(0, md.indexOf("**É IA?**"));
    const frontmatterResult = result.slice(0, result.indexOf("**É IA?**"));
    assert.equal(frontmatterResult, frontmatterOriginal);
  });

  it("marcador \"**É IA?**\\n\\n\" ausente → lança (formato inesperado, falha alto)", () => {
    assert.throws(() => replaceCreditLineInEiaMd("texto qualquer sem o header", "novo"));
  });

  it("creditLine com markdown links inline sobrevive intacta quando é ela mesma o texto novo", () => {
    const md = buildEiaMd(sides, "Antiga.", null);
    const newCredit = "Uma [ave rara](https://en.wikipedia.org/wiki/Bird) — [Foto](https://x.com/a) / [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0).";
    const result = replaceCreditLineInEiaMd(md, newCredit);
    assert.match(result, /\[ave rara\]\(https:\/\/en\.wikipedia\.org\/wiki\/Bird\)/);
    assert.match(result, /\[Foto\]\(https:\/\/x\.com\/a\)/);
  });
});

// ── Fim-a-fim: extract → (humanizador/Clarice simulado) → apply ────────────

describe("#4258 item 3: extract + apply mantêm 01-eia.md e 01-eia-meta.json sincronizados", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-eia-humanize-"));
  }

  it("frase corrigida aparece IDÊNTICA em wikimedia.description e na creditLine regerada", () => {
    const dir = makeDir();
    try {
      const internalDir = join(dir, "_internal");
      mkdirSync(internalDir, { recursive: true });

      const image = {
        title: "File:Test_bird.jpg",
        description: { text: "A rare bird flying over the mountains.", html: "A rare bird flying over the mountains." },
        artist: { text: "Jane Doe", html: '<a href="//commons.wikimedia.org/wiki/User:JaneDoe">Jane Doe</a>' },
        license: { type: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0" },
      };
      const originalSentence = "A rare bird flying over the mountains.";
      const originalCreditLine = buildCreditLine(image, { translatedSentence: originalSentence });
      writeFileSync(join(dir, "01-eia.md"), buildEiaMd(chooseSides(0.5), originalCreditLine, null));
      writeFileSync(
        join(internalDir, "01-eia-meta.json"),
        JSON.stringify({ edition: "260101", wikimedia: { description: originalSentence, credit: "Jane Doe" } }, null, 2),
      );
      writeFileSync(
        join(internalDir, "01-eia-compose-context.json"),
        JSON.stringify({ image, ptLabel: null, ptWikipediaUrl: null }, null, 2),
      );

      // Simula o passo de humanizador+Clarice do orchestrator: a frase
      // "melhora" (aqui, só uma substituição determinística pra não depender
      // de rede/skill no teste).
      const correctedSentence = "Uma ave rara sobrevoando as montanhas.";
      const correctedPath = join(internalDir, "01-eia-description-corrected.txt");
      writeFileSync(correctedPath, correctedSentence, "utf8");

      // Aplica manualmente a mesma lógica do main() de apply-eia-description.ts
      // (evita spawnar subprocess no teste — script fino sobre funções puras
      // já testadas acima).
      const context = JSON.parse(readFileSync(join(internalDir, "01-eia-compose-context.json"), "utf8"));
      const newCreditLine = buildCreditLine(context.image, {
        ptLabel: context.ptLabel,
        ptWikipediaUrl: context.ptWikipediaUrl,
        translatedSentence: correctedSentence,
      });
      const md = readFileSync(join(dir, "01-eia.md"), "utf8");
      const newMd = replaceCreditLineInEiaMd(md, newCreditLine);
      writeFileSync(join(dir, "01-eia.md"), newMd, "utf8");
      const meta = JSON.parse(readFileSync(join(internalDir, "01-eia-meta.json"), "utf8"));
      meta.wikimedia.description = correctedSentence;
      writeFileSync(join(internalDir, "01-eia-meta.json"), JSON.stringify(meta, null, 2), "utf8");

      const finalMd = readFileSync(join(dir, "01-eia.md"), "utf8");
      const finalMeta = JSON.parse(readFileSync(join(internalDir, "01-eia-meta.json"), "utf8"));

      assert.equal(finalMeta.wikimedia.description, correctedSentence);
      assert.match(finalMd, /Uma ave rara sobrevoando as montanhas/);
      assert.ok(!finalMd.includes(originalSentence), "frase antiga (EN) não deve sobreviver no md");
      assert.ok(!JSON.stringify(finalMeta).includes(originalSentence), "frase antiga não deve sobreviver no meta");
      // Nunca divergem: a frase corrigida aparece IGUAL nos dois lugares.
      assert.match(finalMd, new RegExp(correctedSentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
