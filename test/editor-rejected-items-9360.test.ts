/**
 * test/editor-rejected-items-9360.test.ts (#9360)
 *
 * Regressão: item cortado pelo editor no Stage 4 nunca é publicado, então não
 * entra em past-editions.md e o dedup o deixava voltar no dia seguinte (caso
 * real: wired "OpenAI Pauses Training..." cortado em 260930 E em 261001).
 * Agora o dedup deriva os cortes (saída da pipeline × 02-reviewed.md) das
 * últimas edições e remove o item no Pass 1r.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffRejectedItems,
  extractEditorRejectedItems,
  extractItemLinks,
  resolvePipelineOutput,
} from "../scripts/lib/editor-rejected-items.ts";
import { dedup } from "../scripts/dedup.ts";

const WIRED = "https://www.wired.com/story/openai-pauses-training-most-powerful-models-after-rogue-agents-target-government/";
const WIRED_TITLE = "OpenAI Pauses Training Its Most Powerful Models After Rogue Agents Target Government";
const GEMMA = "https://deepmind.google/models/gemma/gemma-4/";
const KEPT = "https://openai.com/index/introducing-gpt-6-1-sol/";
const MOVED = "https://deepmind.google/blog/gemini-4-argon/";

const PIPELINE_MD = `**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[GPT-6.1 Sol encosta no Astra](${KEPT})**

Texto.

**[Gemini 4 Argon](${MOVED})**
Resumo.

**[${WIRED_TITLE}](${WIRED})**
Sam Altman diz que a empresa não foi tão rápida.

**[Gemma 4, Google DeepMind](${GEMMA})**
Página do modelo.
`;

// Editor: cortou wired + gemma; rebaixou o Argon para "Aprofunde:" (URL mantida).
const FINAL_MD = `**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[GPT-6.1 Sol encosta no Astra](${KEPT}?utm_source=diaria)**

Aprofunde:

* [Gemini 4 Argon](${MOVED}) - DeepMind
`;

describe("diffRejectedItems (#9360)", () => {
  it("só acusa URL de item ausente de TODO o final (mover/rebaixar não conta)", () => {
    const rej = diffRejectedItems(PIPELINE_MD, FINAL_MD, "260930");
    assert.deepEqual(
      rej.map((r) => r.url).sort(),
      [GEMMA, WIRED].sort(),
    );
    assert.equal(rej.find((r) => r.url === WIRED)?.title, WIRED_TITLE);
    assert.ok(rej.every((r) => r.edition === "260930"));
  });

  it("final idêntico à pipeline = zero cortes", () => {
    assert.deepEqual(diffRejectedItems(PIPELINE_MD, PIPELINE_MD, "x"), []);
  });

  it("extractItemLinks ignora bullets de Aprofunde e links inline", () => {
    const links = extractItemLinks("Olá [Pixel](https://x.com/p)\n* [A](https://a.com/1) - A\n**[B](https://b.com/2)**");
    assert.deepEqual(links, [{ title: "B", url: "https://b.com/2" }]);
  });
});

describe("extractEditorRejectedItems + dedup Pass 1r (#9360)", () => {
  const root = mkdtempSync(join(tmpdir(), "editor-rejected-9360-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  const ed = join(root, "2609", "260930");
  mkdirSync(join(ed, "_internal"), { recursive: true });
  writeFileSync(join(ed, "02-reviewed.md"), FINAL_MD);
  // Rascunho velho SEM o wired e com mtime anterior — deve perder pro humanizado.
  writeFileSync(join(ed, "_internal", "02-draft.md"), `**[x](${KEPT})**\n`);
  utimesSync(join(ed, "_internal", "02-draft.md"), new Date(2026, 8, 29), new Date(2026, 8, 29));
  writeFileSync(join(ed, "_internal", "02-humanized.md"), PIPELINE_MD);

  // Edição em curso (sem 02-reviewed.md) é pulada sem lançar.
  const wip = join(root, "2609", "260929");
  mkdirSync(join(wip, "_internal"), { recursive: true });
  writeFileSync(join(wip, "_internal", "01-approved.json"), "{}");
  writeFileSync(join(wip, "_internal", "02-humanized.md"), `**[y](https://y.com/1)**\n`);

  it("usa a saída da pipeline de maior mtime", () => {
    assert.equal(resolvePipelineOutput(ed), join(ed, "_internal", "02-humanized.md"));
  });

  it("deriva os cortes da janela, excluindo a edição corrente", () => {
    const rej = extractEditorRejectedItems(root, 3, "261001");
    assert.deepEqual(rej.map((r) => r.url).sort(), [GEMMA, WIRED].sort());
    assert.deepEqual(extractEditorRejectedItems(root, 3, "260930"), []);
    assert.deepEqual(extractEditorRejectedItems(join(root, "nope"), 3), []);
  });

  it("cenário real: wired cortado em 260930 não volta em 261001", () => {
    const rejected = extractEditorRejectedItems(root, 3, "261001");
    const articles = [
      { url: WIRED + "?utm_source=rss", title: WIRED_TITLE },
      { url: "https://syndicated.example.com/openai-pauses", title: WIRED_TITLE },
      { url: "https://example.com/novidade", title: "Uma notícia completamente nova sobre chips" },
      { url: GEMMA, title: "Gemma 4", flag: "editor_submitted" },
    ];
    const { kept, removed } = dedup(
      articles, new Set(), 0.85, [], 0.7, [], 0.6, undefined, 0.55, new Set(), [], rejected,
    );
    assert.deepEqual(kept.map((a) => a.url), ["https://example.com/novidade", GEMMA]);
    assert.equal(removed.length, 2);
    assert.ok(removed.every((r) => r.dedup_note.includes("#9360") && r.dedup_note.includes("260930")));
    // submissão do editor nunca é removida, só marcada
    assert.match(String(kept[1].editor_rejected_flagged), /260930/);
  });

  it("sem registro de cortes, dedup não muda (backward-compat)", () => {
    const articles = [{ url: WIRED, title: WIRED_TITLE }];
    const { kept } = dedup(articles, new Set(), 0.85);
    assert.equal(kept.length, 1);
  });
});
