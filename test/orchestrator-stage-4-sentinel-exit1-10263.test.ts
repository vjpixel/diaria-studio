/**
 * #10263: o §4e do playbook do Stage 4 não pode ler recusa por invariante do
 * `pipeline-sentinel.ts write --step 4` como warn, e precisa mandar re-rodar o
 * pre-render depois de replant/edição do 02-reviewed.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const md = readFileSync(
  new URL("../.claude/agents/orchestrator-stage-4.md", import.meta.url),
  "utf8",
);

describe("orchestrator-stage-4 §4e sentinel (#10263)", () => {
  it("exit 1 do sentinel por invariante volta ao gate, nunca warn", () => {
    assert.match(md, /exit 1 \(recusa por invariante[^)]*\) NUNCA é warn \(#10263\)/);
    assert.match(md, /`NÃO escrito`[^]*recusa por invariante[^]*`falha ao escrever sentinel` = I\/O/);
    assert.ok(!md.includes("Falha do sentinel → idem, logar warn e não bloquear."));
  });

  it("replant/edição manda re-rodar render + substitute antes do sentinel", () => {
    assert.match(md, /Depois de qualquer replant[^]*render-newsletter-html\.ts[^]*substitute-image-urls\.ts[^]*newsletter-html-not-behind-reviewed/);
  });
});
