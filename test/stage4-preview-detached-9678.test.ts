/**
 * test/stage4-preview-detached-9678.test.ts (#9678)
 *
 * Guard de PLAYBOOK pro achado da edição 261006: `orchestrator-stage-4.md`
 * mandava subir os preview servers com `&` + `run_in_background: true`, e o
 * harness os matava no teto de tempo da background task durante um gate
 * longo. O código novo (`--detach`/`--ensure`, coberto em
 * `test/serve-preview-detach.test.ts`) não serve de nada se o playbook não o
 * ligar — exatamente a lição do #8123 (flag entregue, playbook nunca a usou).
 *
 * Trava, no texto do playbook diário:
 *   1. toda invocação que sobe servidor usa `--detach` ou `--ensure`, e
 *      nenhuma termina em `&` (background do shell = de volta à task);
 *   2. existe o passo de re-serve sob demanda (`--ensure`) pros DOIS previews;
 *   3. os DOIS Artifacts (newsletter e social) são publicados — o social
 *      ficou sem fallback na 261006.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PLAYBOOK = resolve(ROOT, ".claude/agents/orchestrator-stage-4.md");
const text = readFileSync(PLAYBOOK, "utf8");

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

describe("#9678 — Stage 4 sobe os preview servers DESANEXADOS do harness", () => {
  const invocations = serveInvocations(text);

  it("há invocações de serve-preview no playbook (o guard não está cego)", () => {
    assert.ok(invocations.length >= 6, `esperava ≥6 (4 serve + 2 ensure), achou ${invocations.length}`);
  });

  for (const inv of invocations) {
    it(`usa --detach/--ensure e nunca '&': ${inv.slice(0, 90)}…`, () => {
      assert.ok(/--detach\b|--ensure\b/.test(inv), `invocação sem --detach/--ensure: ${inv}`);
      assert.ok(!/&\s*$/.test(inv), `invocação em background do shell ('&'): ${inv}`);
    });
  }

  it("re-serve sob demanda (--ensure) cobre os DOIS previews", () => {
    const ensures = invocations.filter((i) => i.includes("--ensure"));
    assert.ok(ensures.some((i) => i.includes("--field newsletter_url")), "falta --ensure da newsletter");
    assert.ok(ensures.some((i) => i.includes("--field social_preview_url")), "falta --ensure do social");
  });

  it("nenhuma instrução manda rodar o serve-preview com run_in_background: true", () => {
    for (const line of text.split("\n")) {
      if (/serve-preview/.test(line) && /Rodar[^.]*com `run_in_background: true`/.test(line)) {
        assert.fail(`instrução de background pro serve-preview sobreviveu: ${line.slice(0, 160)}`);
      }
    }
  });

  it("os DOIS Artifacts (newsletter e social) são publicados no §4b", () => {
    assert.match(text, /Artifact\(file_path: "\{EDITION_DIR\}\/_internal\/newsletter-final-embedded\.html"/);
    assert.match(text, /Artifact\(file_path: "\{EDITION_DIR\}\/_internal\/social-preview-embedded\.html"/);
    assert.match(text, /SEMPRE os DOIS/, "o playbook deve dizer explicitamente que os dois Artifacts são obrigatórios");
  });
});
