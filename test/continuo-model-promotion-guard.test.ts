/**
 * test/continuo-model-promotion-guard.test.ts (#7568)
 *
 * Regressão pro guard mecânico que bloqueia a promoção do modelo local a
 * `model.default` do contínuo enquanto o alarme de fabricação de conclusão
 * (#7537) está ativo — antes deste PR, "não promover enquanto o alarme
 * disparar" só existia em prosa em `docs/goal-modelo-local-continuo.md`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkFabricationAlarm,
  detectsModelPromotionToLocal,
  evaluateModelPromotionGuard,
  extractModelDefault,
  isLocalModelId,
  LOCAL_MODEL_PATTERNS,
} from "../scripts/lib/continuo-model-promotion-guard.ts";

describe("isLocalModelId", () => {
  it("casa os 3 formatos documentados em docs/goal-modelo-local-continuo.md", () => {
    assert.equal(isLocalModelId("qwen-64k:latest"), true);
    assert.equal(isLocalModelId("qwen3.5:4b"), true);
    assert.equal(isLocalModelId("custom/qwen-64k:latest"), true);
    assert.equal(isLocalModelId("ollama/llama3"), true);
  });
  it("modelos pagos não casam", () => {
    assert.equal(isLocalModelId("gpt-5.6-luna"), false);
    assert.equal(isLocalModelId("z-ai/glm-5.3-flash"), false);
    assert.equal(isLocalModelId("openai-codex"), false);
  });
  it("string vazia/só espaço nunca casa", () => {
    assert.equal(isLocalModelId(""), false);
    assert.equal(isLocalModelId("   "), false);
  });
  it("LOCAL_MODEL_PATTERNS é a lista real usada (não duplicada em silêncio)", () => {
    assert.equal(LOCAL_MODEL_PATTERNS.length, 3);
  });
});

describe("extractModelDefault", () => {
  it("extrai default sob a seção model: (config.yaml real do Hermes)", () => {
    const yaml = [
      "model:",
      "  default: gpt-5.6-luna",
      "  provider: openai-codex",
      "  max_tokens: 16384",
      "fallback_providers:",
      "  - provider: openrouter",
    ].join("\n");
    assert.equal(extractModelDefault(yaml), "gpt-5.6-luna");
  });
  it("remove aspas do valor", () => {
    const yaml = "model:\n  default: \"custom/qwen-64k:latest\"\n";
    assert.equal(extractModelDefault(yaml), "custom/qwen-64k:latest");
  });
  it("seção model: ausente -> null", () => {
    assert.equal(extractModelDefault("fallback_providers:\n  - provider: openrouter\n"), null);
  });
  it("seção model: presente mas sem default: -> null", () => {
    assert.equal(extractModelDefault("model:\n  provider: openai-codex\n"), null);
  });
  it("para de procurar ao sair da seção model: (nova chave top-level)", () => {
    const yaml = "model:\n  provider: openai-codex\nagent:\n  default: nao-e-isto\n";
    assert.equal(extractModelDefault(yaml), null);
  });
  it("arquivo vazio -> null, nunca lança", () => {
    assert.equal(extractModelDefault(""), null);
  });
});

describe("detectsModelPromotionToLocal", () => {
  it("modelo pago -> modelo local = promoção", () => {
    const oldC = "model:\n  default: gpt-5.6-luna\n";
    const newC = "model:\n  default: custom/qwen-64k:latest\n";
    const r = detectsModelPromotionToLocal(oldC, newC);
    assert.equal(r.isPromotion, true);
    assert.equal(r.oldModel, "gpt-5.6-luna");
    assert.equal(r.newModel, "custom/qwen-64k:latest");
  });
  it("modelo pago -> outro modelo pago = não é promoção", () => {
    const oldC = "model:\n  default: gpt-5.6-luna\n";
    const newC = "model:\n  default: z-ai/glm-5.3-flash\n";
    assert.equal(detectsModelPromotionToLocal(oldC, newC).isPromotion, false);
  });
  it("modelo local -> outro modelo local = não é NOVA promoção (já era local)", () => {
    const oldC = "model:\n  default: qwen-64k:latest\n";
    const newC = "model:\n  default: qwen3.5:4b\n";
    assert.equal(detectsModelPromotionToLocal(oldC, newC).isPromotion, false);
  });
  it("modelo local -> modelo pago (rebaixamento) = não é promoção", () => {
    const oldC = "model:\n  default: qwen-64k:latest\n";
    const newC = "model:\n  default: gpt-5.6-luna\n";
    assert.equal(detectsModelPromotionToLocal(oldC, newC).isPromotion, false);
  });
  it("1ª escrita (oldContent undefined) com default local = promoção", () => {
    const r = detectsModelPromotionToLocal(undefined, "model:\n  default: qwen-64k:latest\n");
    assert.equal(r.isPromotion, true);
    assert.equal(r.oldModel, null);
  });
  it("nenhum dos dois tem model.default = não é promoção", () => {
    assert.equal(detectsModelPromotionToLocal("agent:\n  max_turns: 150\n", "agent:\n  max_turns: 200\n").isPromotion, false);
  });
});

describe("checkFabricationAlarm", () => {
  it("status=fabrication_suspected do JSON é repassado", () => {
    const r = checkFabricationAlarm("qualquer", () => JSON.stringify({ status: "fabrication_suspected" }));
    assert.equal(r.status, "fabrication_suspected");
  });
  it("status=ok/indeterminate são repassados", () => {
    assert.equal(checkFabricationAlarm("x", () => JSON.stringify({ status: "ok" })).status, "ok");
    assert.equal(checkFabricationAlarm("x", () => JSON.stringify({ status: "indeterminate" })).status, "indeterminate");
  });
  it("comando falha (exec lança) -> error, nunca ok por default", () => {
    const r = checkFabricationAlarm("x", () => {
      throw new Error("python3: command not found");
    });
    assert.equal(r.status, "error");
  });
  it("saída não-JSON -> error", () => {
    assert.equal(checkFabricationAlarm("x", () => "isto não é json").status, "error");
  });
  it("JSON válido mas status desconhecido/ausente -> error", () => {
    assert.equal(checkFabricationAlarm("x", () => JSON.stringify({ status: "algo-novo" })).status, "error");
    assert.equal(checkFabricationAlarm("x", () => JSON.stringify({})).status, "error");
  });
});

describe("evaluateModelPromotionGuard", () => {
  const localPromotion = { old: "model:\n  default: gpt-5.6-luna\n", new: "model:\n  default: qwen-64k:latest\n" };

  it("não é promoção -> allowed sem rodar a checagem de fabricação", () => {
    let called = false;
    const exec = () => {
      called = true;
      return JSON.stringify({ status: "fabrication_suspected" });
    };
    const r = evaluateModelPromotionGuard("model:\n  default: gpt-5.6-luna\n", "model:\n  default: z-ai/glm-5.3-flash\n", "cmd", exec);
    assert.equal(r.allowed, true);
    assert.equal(called, false, "checagem de fabricação não devia rodar — não é uma promoção");
  });

  it("promoção + alarme ATIVO -> bloqueado (allowed: false)", () => {
    const exec = () => JSON.stringify({ status: "fabrication_suspected" });
    const r = evaluateModelPromotionGuard(localPromotion.old, localPromotion.new, "cmd", exec);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /BLOQUEADA/);
    assert.match(r.reason, /#7537|#7568/);
  });

  it("promoção + alarme ok -> permitido", () => {
    const exec = () => JSON.stringify({ status: "ok" });
    const r = evaluateModelPromotionGuard(localPromotion.old, localPromotion.new, "cmd", exec);
    assert.equal(r.allowed, true);
  });

  it("promoção + alarme indeterminate -> permitido (fail-open, ver docstring do módulo)", () => {
    const exec = () => JSON.stringify({ status: "indeterminate" });
    const r = evaluateModelPromotionGuard(localPromotion.old, localPromotion.new, "cmd", exec);
    assert.equal(r.allowed, true);
  });

  it("promoção + detector indisponível (erro) -> permitido (fail-open, infra != fabricação)", () => {
    const exec = () => {
      throw new Error("python3 ausente");
    };
    const r = evaluateModelPromotionGuard(localPromotion.old, localPromotion.new, "cmd", exec);
    assert.equal(r.allowed, true);
  });
});
