/**
 * test/monthly-divulgacao-box-sync-9591.test.ts (#9591)
 *
 * O box DIVULGAÇÃO da mensal vive em DUAS cópias: o template
 * (`context/templates/newsletter-monthly.md`) e o passo 5 do prompt do
 * `writer-monthly` (`.claude/agents/writer-monthly.md`), que o agente emite
 * literalmente. No review da PR #9587 trocar só o template não surtiu efeito —
 * o writer continuou emitindo a cópia velha do prompt. Este guard trava as duas
 * cópias idênticas (texto, imagem e link com UTM).
 *
 * Também trava o registro da remoção: o box é temporário (imersão de 17/10) e a
 * remoção é rastreada na #8895 — enquanto o box existir, o prompt precisa citar
 * essa issue, senão a remoção volta a depender só de prosa com data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const TEMPLATE = readFileSync(new URL("../context/templates/newsletter-monthly.md", import.meta.url), "utf8");
const PROMPT = readFileSync(new URL("../.claude/agents/writer-monthly.md", import.meta.url), "utf8");

/** Bloco do template: da linha `**DIVULGAÇÃO**` até o próximo separador `---`. */
function extractTemplateBox(md: string): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === "**DIVULGAÇÃO**");
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.trim() === "---");
  return normalize(lines.slice(start, end < 0 ? undefined : end));
}

/** Bloco do prompt: dentro do code fence que abre com `**DIVULGAÇÃO**`. */
function extractPromptBox(md: string): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex(
    (l, i) => l.trim() === "**DIVULGAÇÃO**" && i > 0 && lines[i - 1].trim() === "```",
  );
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.trim() === "```");
  return normalize(lines.slice(start, end < 0 ? undefined : end));
}

function normalize(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

describe("#9591 — box DIVULGAÇÃO: template mensal × prompt do writer-monthly", () => {
  const tpl = extractTemplateBox(TEMPLATE);
  const prompt = extractPromptBox(PROMPT);

  it("as duas cópias existem juntas, ou nenhuma (remoção tem que ser simultânea)", () => {
    assert.equal(
      tpl === null,
      prompt === null,
      `template ${tpl === null ? "sem" : "com"} o box, prompt ${prompt === null ? "sem" : "com"} — remover/editar nos DOIS arquivos`,
    );
  });

  it("template e prompt carregam o MESMO bloco, byte a byte (após normalizar indentação)", () => {
    if (tpl === null || prompt === null) return; // box removido dos dois — nada a comparar
    assert.equal(prompt, tpl);
  });

  it("enquanto o box existir, o prompt cita a issue de remoção (#8895)", () => {
    if (prompt === null) return;
    assert.match(PROMPT, /#8895/, "registrar a remoção do box temporário pela issue, não só pela data em prosa");
  });

  it("extratores pegam a divergência que motivou a issue (cópia velha no prompt)", () => {
    const tplFixture = ["**DIVULGAÇÃO**", "", "Texto novo.", "", "→ [Saiba mais](https://x)", "", "---"].join("\n");
    const promptFixture = ["   ```", "   **DIVULGAÇÃO**", "", "   Texto velho.", "", "   → [Saiba mais](https://x)", "   ```"].join("\n");
    assert.notEqual(extractPromptBox(promptFixture), extractTemplateBox(tplFixture));
    assert.equal(
      extractPromptBox(promptFixture.replace("Texto velho.", "Texto novo.")),
      extractTemplateBox(tplFixture),
    );
  });
});
