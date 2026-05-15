/**
 * research-reviewer-out-path.test.ts (#1271)
 *
 * Verifica que (a) o agent .md exige `out_path` como input,
 * (b) o orchestrator-stage-1 passa `out_path` explícito na invocação.
 *
 * Não testa runtime do agent — esse é dispatch de Haiku via API e cobre
 * só a documentação. Mas garante que se alguém remover o requirement
 * acidentalmente, o test falha (#633 — bugfix exige regressão).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

describe("research-reviewer out_path requirement (#1271)", () => {
  it("research-reviewer.md documenta out_path como input obrigatório", () => {
    const md = readFileSync(resolve(ROOT, ".claude/agents/research-reviewer.md"), "utf8");
    assert.match(md, /out_path.*obrigat.rio/i, "out_path deve estar marcado como obrigatório");
    assert.match(md, /tmp-reviewer-output\.json/, "exemplo canônico deve aparecer");
    // Anti-regressão específica: avisa contra inventar nome semântico
    assert.match(md, /N.O inventar/i, "deve avisar contra LLM inventar path próprio");
  });

  it("orchestrator-stage-1-research.md passa out_path explícito na invocação", () => {
    const md = readFileSync(resolve(ROOT, ".claude/agents/orchestrator-stage-1-research.md"), "utf8");
    // Busca padrão `out_path: "..."` na seção 1p2
    const f2section = md.match(/### 1p2\. Research-reviewer[\s\S]{0,1500}/);
    assert.ok(f2section, "seção 1p2 deve existir");
    assert.match(
      f2section![0],
      /out_path.*tmp-reviewer-output\.json/,
      "playbook deve passar out_path explícito pro agent",
    );
    // E deve avisar que confirma file existe pós-dispatch (#1273:
    // wrapper ensure-research-reviewer-output.ts substitui Confirmar manual)
    assert.match(
      f2section![0],
      /Confirmar.*arquivo existe|arquivo existe.*scorer|ensure-research-reviewer-output|Pós-dispatch enforcement/i,
      "playbook deve sanity-check post-dispatch",
    );
  });
});
