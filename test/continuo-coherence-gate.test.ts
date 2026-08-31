import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateContinuoCoherence,
  extractMentionedPaths,
  type CoherenceGateInput,
} from "../scripts/lib/continuo-coherence-gate.ts";

const base: CoherenceGateInput = {
  issueTitle: "",
  issueBody: "",
  activeFiles: [],
  recentMasterFiles: [],
};

describe("extractMentionedPaths (#6752)", () => {
  it("extrai paths com extensão reconhecida do texto", () => {
    const text = "Bug em scripts/lib/brevo-diaria-store.ts:286 e também workers/poll/src/subscribe.ts";
    assert.deepEqual(extractMentionedPaths(text), ["scripts/lib/brevo-diaria-store.ts", "workers/poll/src/subscribe.ts"]);
  });

  it("ignora palavras soltas sem extensão de código/config", () => {
    assert.deepEqual(extractMentionedPaths("issue sobre performance e retrabalho, sem arquivo nenhum"), []);
  });

  it("dedup preservando ordem de 1ª ocorrência", () => {
    const text = "toca scripts/foo.ts duas vezes: scripts/foo.ts de novo";
    assert.deepEqual(extractMentionedPaths(text), ["scripts/foo.ts"]);
  });

  it("normaliza prefixo ./ ", () => {
    assert.deepEqual(extractMentionedPaths("editar ./scripts/bar.ts"), ["scripts/bar.ts"]);
  });
});

describe("evaluateContinuoCoherence — admite (baixa coerência, caso feliz)", () => {
  it("issue de fix pontual sem nenhum sinal -> admit true, reasons vazio", () => {
    const r = evaluateContinuoCoherence({
      ...base,
      issueTitle: "computeNextWaveSize trata lastWaveSize<=0 como null",
      issueBody: "Bug pontual em scripts/kit-ramp-cohort.ts:42 — causa óbvia, 1 arquivo, sem dependência de outra PR.",
    });
    assert.equal(r.admit, true);
    assert.deepEqual(r.reasons, []);
    assert.deepEqual(r.overlappingPaths, []);
  });

  it("path mencionado que NÃO colide com nada ativo/recente -> admit true", () => {
    const r = evaluateContinuoCoherence({
      ...base,
      issueBody: "fix em scripts/isolated-thing.ts",
      activeFiles: ["scripts/other-file.ts"],
      recentMasterFiles: ["scripts/another.ts"],
    });
    assert.equal(r.admit, true);
  });
});

describe("evaluateContinuoCoherence — rejeita (retrospectivo: teria pego o #6699?)", () => {
  it("#6699 real: issue menciona path que uma PR aberta também toca -> reject com overlappingPaths", () => {
    // Reconstrução do caso real: #6680 tocou scripts/lib/brevo-diaria-store.ts
    // dois commits depois de #6679 criar scripts/lib/shared/brevo-diaria-origin.ts.
    // Se a issue da 2ª PR tivesse citado o path da 1ª (ou vice-versa), o gate pega.
    const r = evaluateContinuoCoherence({
      ...base,
      issueTitle: "aplica novo parser de origem em scripts/lib/brevo-diaria-store.ts",
      issueBody: "usa parseOrigin de scripts/lib/shared/brevo-diaria-origin.ts",
      activeFiles: ["scripts/lib/shared/brevo-diaria-origin.ts"],
      recentMasterFiles: [],
    });
    assert.equal(r.admit, false);
    assert.deepEqual(r.overlappingPaths, ["scripts/lib/shared/brevo-diaria-origin.ts"]);
    assert.ok(r.reasons.some((x) => x.includes("#6699")));
  });

  it("overlap contra recentMasterFiles (não só activeFiles) também rejeita", () => {
    const r = evaluateContinuoCoherence({
      ...base,
      issueBody: "editar hermes/scripts/claude-openrouter.sh",
      recentMasterFiles: ["hermes/scripts/claude-openrouter.sh"],
    });
    assert.equal(r.admit, false);
    assert.deepEqual(r.overlappingPaths, ["hermes/scripts/claude-openrouter.sh"]);
  });

  it("path sob scripts/lib/shared/ mencionado -> reject (abstração compartilhada) mesmo sem overlap", () => {
    const r = evaluateContinuoCoherence({
      ...base,
      issueBody: "criar novo helper em scripts/lib/shared/new-thing.ts",
    });
    assert.equal(r.admit, false);
    assert.ok(r.reasons.some((x) => x.includes("compartilhada")));
    assert.deepEqual(r.overlappingPaths, []); // motivo é o path-prefix, não overlap
  });

  it('texto "abstração compartilhada"/"módulo canônico" dispara sem precisar de path', () => {
    const r = evaluateContinuoCoherence({ ...base, issueBody: "extrair um módulo canônico pra origem" });
    assert.equal(r.admit, false);
    assert.ok(r.reasons.some((x) => x.includes("compartilhada")));
  });

  it("palavra-chave de refactor/consolidação dispara", () => {
    for (const word of ["refactor", "refatoração", "consolidar", "unificar", "duplicação"]) {
      const r = evaluateContinuoCoherence({ ...base, issueBody: `precisa ${word} este código` });
      assert.equal(r.admit, false, `esperava reject para "${word}"`);
      assert.ok(r.reasons.some((x) => x.includes("refactor")));
    }
  });

  it('"fatia N de M" (épico) dispara', () => {
    const r = evaluateContinuoCoherence({ ...base, issueBody: "fatia 2 de 5 do épico de migração" });
    assert.equal(r.admit, false);
    assert.ok(r.reasons.some((x) => x.includes("fatia")));
  });

  it('"parte N/M" (épico, barra) dispara', () => {
    const r = evaluateContinuoCoherence({ ...base, issueBody: "parte 3/4 — depende da parte anterior" });
    assert.equal(r.admit, false);
  });

  it('dependência cruzada explícita "depende de #N" dispara', () => {
    const r = evaluateContinuoCoherence({ ...base, issueBody: "esta issue depende de #1234 pra fazer sentido" });
    assert.equal(r.admit, false);
    assert.ok(r.reasons.some((x) => x.includes("dependência explícita")));
  });

  it('"bloqueado por #N" dispara', () => {
    const r = evaluateContinuoCoherence({ ...base, issueBody: "bloqueado por #999 até lá" });
    assert.equal(r.admit, false);
  });

  it('"após mergear #N" dispara', () => {
    const r = evaluateContinuoCoherence({ ...base, issueBody: "só fazer isto após mergear #500" });
    assert.equal(r.admit, false);
  });

  it("múltiplos sinais simultâneos -> múltiplos reasons, não só o 1º", () => {
    const r = evaluateContinuoCoherence({
      ...base,
      issueBody: "refactor de scripts/lib/shared/x.ts, fatia 1 de 3, depende de #10",
    });
    assert.equal(r.admit, false);
    assert.ok(r.reasons.length >= 3);
  });
});
