import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripWranglerNotice } from "../scripts/lib/poll-kv.ts";

describe("stripWranglerNotice (#1703) — remove banner do wrangler do stdout", () => {
  const BANNER =
    "Cloudflare agent skills are available for: Claude Code. Run wrangler in an interactive terminal to install them, or use `--install-skills`";

  it("banner numa linha + JSON array na próxima → retorna só o JSON", () => {
    const stdout = `${BANNER}\n["260526","260527","260602"]`;
    const cleaned = stripWranglerNotice(stdout);
    assert.equal(cleaned, '["260526","260527","260602"]');
    assert.deepEqual(JSON.parse(cleaned), ["260526", "260527", "260602"]);
  });

  it("JSON antes do banner também é recuperado", () => {
    const stdout = `["260601"]\n${BANNER}`;
    assert.equal(stripWranglerNotice(stdout), '["260601"]');
  });

  it("banner quebrado em 2 linhas (wrap) — ambas removidas", () => {
    const stdout = [
      "Cloudflare agent skills are available for: Claude Code.",
      "Run wrangler in an interactive terminal to install them, or use `--install-skills`",
      '["260602"]',
    ].join("\n");
    assert.equal(stripWranglerNotice(stdout), '["260602"]');
  });

  it("valor JSON limpo (sem banner) é preservado intacto", () => {
    assert.equal(stripWranglerNotice('["260602"]'), '["260602"]');
    assert.equal(stripWranglerNotice('"260602"'), '"260602"');
  });

  it("banner sozinho (key vazia) → string vazia (wranglerKvGet vira null)", () => {
    assert.equal(stripWranglerNotice(BANNER), "");
  });

  it("não remove uma linha de valor que mencione 'wrangler' no meio", () => {
    // Só linhas que SÃO o notice (começam com 'Run wrangler' / contêm as frases
    // do banner) são removidas — um valor arbitrário com a palavra no meio fica.
    const stdout = '{"note":"configured via wrangler"}';
    assert.equal(stripWranglerNotice(stdout), '{"note":"configured via wrangler"}');
  });
});
