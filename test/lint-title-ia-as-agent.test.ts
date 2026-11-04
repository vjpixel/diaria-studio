/**
 * test/lint-title-ia-as-agent.test.ts (#12106)
 *
 * Regressão do caso da edição 261104 ("IA usa seu rosto..." num destaque em
 * que quem age são os criminosos) e dos falsos positivos óbvios da
 * heurística. Inclui o registro no STAGE_4_RULES (warning-only).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkTitleIaAsAgent, findIaSubjectVerb } from "../scripts/lib/lint-checks/title-ia-as-agent.ts";
import { checkTitleIaAsAgentInvariant, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

const GOLPE_BODY =
  "Criminosos estão usando ferramentas de IA para gerar selfies falsas a partir de fotos de redes sociais e abrir contas em bancos.";

function destaqueMd(titles: string[], body: string, { destaque = 1, category = "SEGURANÇA" } = {}): string {
  return [
    `DESTAQUE ${destaque} | ${category}`,
    "",
    ...titles.flatMap((t) => [`**[${t}](https://example.com/d${destaque})**`, ""]),
    body,
    "",
    "Por que isso importa: contexto relevante aqui.",
    "",
    "---",
  ].join("\n");
}

describe("findIaSubjectVerb (#12106)", () => {
  it("acha o verbo com IA no começo", () => {
    assert.equal(findIaSubjectVerb("IA usa seu rosto para abrir contas"), "usa");
    assert.equal(findIaSubjectVerb("A IA copia seu rosto"), "copia");
  });
  it("acha o verbo depois de dois-pontos", () => {
    assert.equal(findIaSubjectVerb("Golpe da selfie: IA clona seu rosto"), "clona");
  });
  it("pula adjetivo colado à sigla", () => {
    assert.equal(findIaSubjectVerb("IA generativa engana bancos"), "engana");
  });
  it("não flagra IA como instrumento nem complemento", () => {
    assert.equal(findIaSubjectVerb("Golpe da selfie: criminosos usam IA para copiar seu rosto"), null);
    assert.equal(findIaSubjectVerb("IA da Meta lê seus e-mails"), null);
    assert.equal(findIaSubjectVerb("IA Gemini chega ao Brasil"), null);
  });
});

describe("checkTitleIaAsAgent (#12106)", () => {
  it("flagra o caso real da edição 261104", () => {
    const md = destaqueMd(["IA usa seu rosto para abrir contas no seu nome"], GOLPE_BODY);
    const r = checkTitleIaAsAgent(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].verb, "usa");
    assert.match(r.errors[0].humanActor, /criminosos/i);
  });

  it("não flagra o título corrigido pelo editor", () => {
    const md = destaqueMd(["Golpe da selfie: criminosos usam IA para copiar seu rosto"], GOLPE_BODY);
    assert.equal(checkTitleIaAsAgent(md).ok, true);
  });

  it("não flagra IA como sujeito quando o corpo não cita ator humano", () => {
    const md = destaqueMd(
      ["IA lê exames de raio-x com precisão de radiologista"],
      "Um modelo treinado pelo hospital acertou 94% dos diagnósticos em teste com 3 mil exames.",
    );
    assert.equal(checkTitleIaAsAgent(md).ok, true);
  });

  it("só flagra a opção problemática entre as 3", () => {
    const md = destaqueMd(
      [
        "IA clona seu rosto em golpe bancário",
        "Golpe da selfie: criminosos usam IA no seu nome",
        "Sua selfie virou chave para golpistas",
      ],
      GOLPE_BODY,
    );
    const r = checkTitleIaAsAgent(md);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].title, "IA clona seu rosto em golpe bancário");
  });

  it("corpo de um destaque não contamina o seguinte", () => {
    const md = [
      destaqueMd(["Golpistas usam IA para clonar vozes"], GOLPE_BODY, { destaque: 1 }),
      "",
      destaqueMd(["IA lê exames de raio-x"], "Um modelo acertou 94% dos diagnósticos.", { destaque: 2, category: "SAÚDE" }),
    ].join("\n");
    assert.equal(checkTitleIaAsAgent(md).ok, true);
  });
});

describe("checkTitleIaAsAgentInvariant (#12106)", () => {
  it("vira warning no Stage 4", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-title-ia-as-agent-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(resolve(dir, "02-reviewed.md"), destaqueMd(["IA usa seu rosto"], GOLPE_BODY));
    try {
      const v = checkTitleIaAsAgentInvariant(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "title-ia-as-agent");
      assert.equal(v[0].source_issue, "#12106");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("está registrado no STAGE_4_RULES", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "title-ia-as-agent");
    assert.ok(rule);
    assert.equal(rule!.stage, 4);
  });
});
