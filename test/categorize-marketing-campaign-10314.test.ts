/**
 * #10314 — cobertura de campanha de marketing (exame.com/marketing/) com
 * summary citando "capacitação gratuita" caía em USE MELHOR via
 * tutorial-title-extra. Deve ir pra noticias/RADAR.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorizeWithRule } from "../scripts/lib/launch-heuristics.ts";

const url = "https://exame.com/marketing/openai-homenageia-professores-em-campanha-que-aborda-ia-na-sala-de-aula/";
const title = "OpenAI homenageia professores em campanha que aborda IA na sala de aula";

describe("#10314 campanha de marketing não é tutorial", () => {
  it("path /marketing/ + campanha no título → noticias", () => {
    const r = categorizeWithRule({
      url, title,
      summary: "OpenAI oferece capacitação gratuita para professores",
      type_hint: "noticia",
    } as any);
    assert.equal(r.category, "noticias");
  });

  it("guard não afeta how-to real fora de campanha", () => {
    const r = categorizeWithRule({
      url: "https://exame.com/marketing/como-usar-ia/",
      title: "Capacitação gratuita: como usar IA",
      summary: "capacitação gratuita",
    } as any);
    assert.equal(r.category, "tutorial");
  });
});
