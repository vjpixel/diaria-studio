/**
 * #13328 / #13329 — dois itens oficiais barrados em LANÇAMENTOS no gate 4 da
 * edição 261117. O check estava incompleto, não o conteúdo do editor (#7401):
 *
 *   - #13328: `devin.ai/blog/devin-apps` (Cognition) fora do registro oficial.
 *   - #13329: `openai.com/index/more-ways-to-move-care-forward-with-chatgpt-for-healthcare`
 *     sem sinal POSITIVO de produto. Entrada na `seed/lancamentos-tool-allowlist.txt`,
 *     não `chatgpt` como sinal genérico: "ChatGPT for Academic Researchers"
 *     (programa de acesso, #4339) tem a mesma forma e precisa seguir rebaixado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isOfficialLancamentoUrl } from "../scripts/categorize.ts";
import { companyToDomain } from "../scripts/lib/official-domains.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasProductSignal,
  isVerifiedTool,
  loadToolAllowlist,
  validateLancamentos,
} from "../scripts/validate-lancamentos.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("#13328 Cognition / Devin no registro oficial", () => {
  const url = "https://devin.ai/blog/devin-apps";

  it("o post do blog do Devin é URL oficial de lançamento", () => {
    assert.equal(isOfficialLancamentoUrl(url), true);
  });

  it("o blog da Cognition também conta", () => {
    assert.equal(isOfficialLancamentoUrl("https://cognition.ai/blog/introducing-devin-2"), true);
  });

  it("o resto do host do Devin (app, pricing) não conta", () => {
    assert.equal(isOfficialLancamentoUrl("https://devin.ai/pricing"), false);
    assert.equal(isOfficialLancamentoUrl("https://app.devin.ai/sessions/abc"), false);
  });

  it("validateLancamentos aceita o item real da edição 261117", () => {
    const md = ["LANÇAMENTOS", "", `**[Introducing Devin Apps](${url})**`, "Resumo.", "", "---"].join("\n");
    const r = validateLancamentos(md);
    assert.equal(r.lancamento_count, 1);
    assert.deepEqual(r.invalid_urls, []);
    assert.deepEqual(r.not_a_tool, []);
    assert.equal(r.status, "ok");
  });

  it("a detecção por nome sugere devin.ai; 'cognition' solto não", () => {
    const map = companyToDomain();
    const hit = (s: string) => map.find((m) => m.keyword.test(s))?.domain;
    assert.equal(hit("Devin ganha apps"), "devin.ai");
    assert.equal(hit("Cognition AI levanta rodada"), "devin.ai");
    assert.notEqual(hit("A study on human cognition and memory"), "devin.ai");
  });
});

describe("#13329 ChatGPT for Healthcare via allowlist da seed", () => {
  const url = "https://openai.com/index/more-ways-to-move-care-forward-with-chatgpt-for-healthcare";
  const title = "More ways to move care forward with ChatGPT for Healthcare";
  // Lê a seed REAL: o teste falha se a entrada sair do arquivo.
  const allowlist = loadToolAllowlist(ROOT);

  it("sem allowlist o item não tem sinal positivo (reproduz o bloqueio do gate)", () => {
    assert.equal(hasProductSignal(url, title), false);
    assert.equal(isVerifiedTool(url, title), false);
  });

  it("com a seed real, validateLancamentos não barra o item da edição 261117", () => {
    const md = ["LANÇAMENTOS", "", `**[${title}](${url})**`, "Resumo.", "", "---"].join("\n");
    const r = validateLancamentos(md, allowlist);
    assert.equal(r.lancamento_count, 1);
    assert.deepEqual(r.invalid_urls, []);
    assert.deepEqual(r.not_a_tool, []);
    assert.equal(r.status, "ok");
  });

  it("a entrada é específica: ChatGPT for Academic Researchers (programa, #4339) segue barrado", () => {
    assert.equal(
      isVerifiedTool(
        "https://openai.com/index/chatgpt-for-academic-researchers",
        "Accelerating scientific discovery with ChatGPT for Academic Researchers",
        allowlist,
      ),
      false,
    );
  });
});
