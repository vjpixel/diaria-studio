/**
 * test/mensal-anual-preview-detached-9686.test.ts (#9686)
 *
 * Guard de PLAYBOOK análogo a `stage4-preview-detached-9678.test.ts`, pras
 * skills mensal e anual: as duas subiam o preview do gate com `&` +
 * `run_in_background: true` — o mesmo padrão que matava os servidores do
 * Stage 4 diário no teto de tempo da background task do harness (#9678).
 * O código (`serve-preview.ts --detach/--ensure`) já existia; sem o playbook
 * usá-lo, o bug continuava (lição do #8123: flag entregue, playbook nunca a
 * ligou).
 *
 * Trava, no texto das duas skills:
 *   1. toda invocação que sobe servidor usa `--detach` ou `--ensure`, e
 *      nenhuma termina em `&`;
 *   2. existe o re-serve sob demanda (`--ensure`) do preview do gate;
 *   3. nenhuma instrução manda rodar o serve-preview com `run_in_background: true`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Invocações (continuações de linha juntadas) que sobem servidor — têm `--file` E `--port`. */
function serveInvocations(src: string): string[] {
  const out: string[] = [];
  let buffer = "";
  for (const raw of src.split("\n")) {
    buffer += (buffer ? " " : "") + raw.replace(/\\$/, "").trim();
    if (raw.trimEnd().endsWith("\\")) continue;
    if (buffer.includes("serve-preview.ts") && buffer.includes("--file ") && buffer.includes("--port ")) {
      out.push(buffer);
    }
    buffer = "";
  }
  return out;
}

const SKILLS = [
  { name: "diaria-mensal", minInvocations: 3 }, // 3c serve + 3c ensure + 4b serve
  { name: "diaria-anual", minInvocations: 2 }, // 4a serve + ensure
];

for (const { name, minInvocations } of SKILLS) {
  describe(`#9686 — ${name} sobe o preview do gate DESANEXADO do harness`, () => {
    const text = readFileSync(resolve(ROOT, ".claude/skills", name, "SKILL.md"), "utf8");
    const invocations = serveInvocations(text);

    it("há invocações de serve-preview na skill (o guard não está cego)", () => {
      assert.ok(
        invocations.length >= minInvocations,
        `esperava ≥${minInvocations}, achou ${invocations.length}`,
      );
    });

    for (const inv of invocations) {
      it(`usa --detach/--ensure e nunca '&': ${inv.slice(0, 90)}…`, () => {
        assert.ok(/--detach\b|--ensure\b/.test(inv), `invocação sem --detach/--ensure: ${inv}`);
        assert.ok(!/&\s*$/.test(inv), `invocação em background do shell ('&'): ${inv}`);
      });
    }

    it("re-serve sob demanda (--ensure) do preview do gate", () => {
      assert.ok(
        invocations.some((i) => i.includes("--ensure") && i.includes("--field preview_url")),
        "falta --ensure do preview_url",
      );
    });

    it("nenhuma instrução manda rodar com run_in_background: true (só a proibição explícita)", () => {
      // Hoje o único uso de background nessas skills era o serve-preview; uma
      // menção que sobreviva tem de ser a PROIBIÇÃO ("nunca"), nunca a ordem.
      // Por PARÁGRAFO (a prosa da mensal quebra linha no meio da frase).
      for (const para of text.split(/\n\s*\n/)) {
        if (/run_in_background: true/.test(para)) {
          assert.match(para, /nunca|NUNCA/, `instrução de background sobreviveu: ${para.slice(0, 160)}`);
        }
      }
    });
  });
}
