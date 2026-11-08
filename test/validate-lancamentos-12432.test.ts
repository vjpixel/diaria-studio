import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateLancamentos,
  validateLancamentosFromApproved,
  demoteNotATool,
  hasProductSignal,
  isNonProductLancamento,
  isOfficialModelIntroducingSlug,
  isVerifiedTool,
} from "../scripts/validate-lancamentos.ts";

// Caso real da edição 261109 (#12432). O título usa hífen não separável
// (U+2011) em "GPT‑6" e traz "Advancing the frontier", que casava o hint de
// ensaio de posicionamento (#4714) e derrubava o item como not_a_tool.
const GPT6_URL = "https://openai.com/index/introducing-gpt-6-cyber/";
const GPT6_TITLE = "GPT‑6 Cyber: Advancing the frontier of aligned cybersecurity agents";

describe("#12432 post oficial de lançamento de modelo (introducing-{modelo}-{versão})", () => {
  it("caso GPT-6 Cyber 261109 é ferramenta verificada sem allowlist", () => {
    assert.ok(isOfficialModelIntroducingSlug(GPT6_URL));
    assert.ok(!isNonProductLancamento(GPT6_URL, GPT6_TITLE));
    assert.ok(hasProductSignal(GPT6_URL, GPT6_TITLE));
    assert.ok(isVerifiedTool(GPT6_URL, GPT6_TITLE, []));
  });

  it("modo MD (gate da Etapa 4) não acusa not_a_tool no caso GPT-6 Cyber", () => {
    const md = ["**🚀 LANÇAMENTOS**", "", `**[${GPT6_TITLE}](${GPT6_URL})**`, "", "---"].join("\n");
    const r = validateLancamentos(md, []);
    assert.equal(r.not_a_tool.length, 0);
    assert.equal(r.status, "ok");
  });

  it("modo approved não rebaixa o caso GPT-6 Cyber pra RADAR", () => {
    const approved = { lancamento: [{ url: GPT6_URL, title: GPT6_TITLE }], radar: [] };
    assert.equal(validateLancamentosFromApproved(approved, []).not_a_tool.length, 0);
    assert.equal(demoteNotATool(approved, []).demoted.length, 0);
  });

  it("cobertura de imprensa com o mesmo slug/título não ganha o override", () => {
    const press = "https://www.theverge.com/news/introducing-gpt-6-cyber";
    assert.equal(isOfficialModelIntroducingSlug(press), false);
    // o hint de título continua valendo fora de domínio oficial
    assert.ok(isNonProductLancamento(press, GPT6_TITLE));
    const md = ["**🚀 LANÇAMENTOS**", "", `**[${GPT6_TITLE}](${press})**`, "", "---"].join("\n");
    const r = validateLancamentos(md, []);
    assert.equal(r.status, "error");
    assert.equal(r.invalid_urls.length, 1, "imprensa segue barrada pelo #160");
  });

  it("blog pessoal com o mesmo slug não ganha o override", () => {
    const personal = "https://someone.substack.com/p/introducing-gpt-6-cyber";
    assert.equal(isOfficialModelIntroducingSlug(personal), false);
    assert.ok(isNonProductLancamento(personal, GPT6_TITLE));
  });

  it("introducing sem versão em domínio oficial não ganha o override (programa segue barrado)", () => {
    const program = "https://openai.com/index/introducing-openai-partner-network";
    assert.equal(isOfficialModelIntroducingSlug(program), false);
    assert.ok(!isVerifiedTool(program, "Introducing the OpenAI Partner Network", []));
  });

  it("introducing-{modelo} oficial com termo de governança no slug segue barrado", () => {
    const gov = "https://openai.com/index/introducing-gpt-6-safety-policy";
    assert.ok(isOfficialModelIntroducingSlug(gov));
    assert.ok(isNonProductLancamento(gov, "GPT-6 safety policy"), "checks de slug continuam valendo");
  });

  it("ensaio de posicionamento oficial sem slug introducing segue barrado (#4714)", () => {
    const essay = "https://blogs.nvidia.com/blog/open-world-models-physical-ai/";
    const title = "Into the Omniverse: How Open World Models Push the Frontier of Physical AI";
    assert.equal(isOfficialModelIntroducingSlug(essay), false);
    assert.ok(isNonProductLancamento(essay, title));
  });
});

describe("#12432 hífen tipográfico normalizado antes dos sinais", () => {
  it("versão com U+2011 no título casa como versão com '-'", () => {
    const url = "https://example.com/x/cyber-defense";
    assert.ok(hasProductSignal(url, "Nemotron‑4 for cyber defense"));
    assert.ok(hasProductSignal(url, "Nemotron-4 for cyber defense"));
    assert.ok(hasProductSignal(url, "Nemotron—4 for cyber defense"), "em dash também");
    assert.equal(hasProductSignal(url, "Nemotron for cyber defense"), false);
  });
});
