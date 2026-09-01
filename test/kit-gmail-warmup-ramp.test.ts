/**
 * kit-gmail-warmup-ramp.test.ts (#6504 item 2) — casca do CLI (leitura de
 * config, round-trip de estado, formatação do relatório). A orquestração de
 * rede (`runWarmupRamp`) fica sem teste direto de propósito — mesma
 * convenção já usada por `kit-provider-split.ts` (que não testa `main()`,
 * só as peças puras/testáveis que ele compõe); `runWarmupRamp` compõe as
 * funções puras já cobertas em `kit-gmail-warmup.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAudienceTagName,
  loadState,
  saveState,
  formatReport,
  assertReferenceBroadcastImmutable,
  type WarmupRampResult,
} from "../scripts/kit-gmail-warmup-ramp.ts";
import { buildInitialState, type WavePlan } from "../scripts/lib/kit-gmail-warmup.ts";

describe("readAudienceTagName", () => {
  it("lê kit_diaria.audience_tag de platform.config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-warmup-cfg-"));
    try {
      writeFileSync(join(dir, "platform.config.json"), JSON.stringify({ kit_diaria: { audience_tag: "rampa-kit" } }));
      assert.equal(readAudienceTagName(dir), "rampa-kit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("LANÇA quando kit_diaria.audience_tag está ausente — falha segura, nunca cai pra 'sem filtro'", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-warmup-cfg-"));
    try {
      writeFileSync(join(dir, "platform.config.json"), JSON.stringify({}));
      assert.throws(() => readAudienceTagName(dir), /kit_diaria\.audience_tag ausente/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadState / saveState — round-trip", () => {
  it("loadState devolve null quando o arquivo não existe (1ª rodada)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-warmup-state-"));
    try {
      assert.equal(loadState(join(dir, "state.json")), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saveState → loadState preserva o conteúdo (inclusive cria o diretório)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-warmup-state-"));
    try {
      const path = join(dir, "nested", "state.json");
      const state = buildInitialState(25622689, ["a@gmail.com", "b@gmail.com"], new Date("2026-08-28T12:00:00.000Z"));
      saveState(state, path);
      assert.deepEqual(loadState(path), state);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fakeResult(overrides: Partial<WarmupRampResult> = {}): WarmupRampResult {
  const state = buildInitialState(1, ["a@gmail.com", "b@gmail.com", "c@gmail.com"]);
  const plan: WavePlan = { emails: ["a@gmail.com", "b@gmail.com"], size: 2, skipped: false, reason: "gate OK — onda de 2 de 3 restante(s)." };
  return {
    state,
    plan,
    safeToTag: ["a@gmail.com"],
    needsBeehiivDeactivation: ["b@gmail.com"],
    pushed: false,
    unverifiedEmails: [],
    failedEmails: [],
    outOfBandReturned: [],
    outOfBandStillActiveOnBeehiiv: [],
    unconfirmedTagEmails: [],
    ...overrides,
  };
}

describe("assertReferenceBroadcastImmutable", () => {
  it("sem estado (null): --reference-broadcast é aceito, nada a validar", () => {
    assert.doesNotThrow(() => assertReferenceBroadcastImmutable(null, 25622689));
  });

  it("com estado, sem --reference-broadcast passado: ok (usa o cohort já capturado)", () => {
    const state = buildInitialState(1, []);
    assert.doesNotThrow(() => assertReferenceBroadcastImmutable(state, undefined));
  });

  it("com estado, --reference-broadcast IGUAL ao já capturado: ok (idempotente)", () => {
    const state = buildInitialState(25622689, []);
    assert.doesNotThrow(() => assertReferenceBroadcastImmutable(state, 25622689));
  });

  it("com estado, --reference-broadcast DIFERENTE: LANÇA — nunca ignora em silêncio", () => {
    const state = buildInitialState(25622689, []);
    assert.throws(() => assertReferenceBroadcastImmutable(state, 99999999), /seria IGNORADO em silêncio/);
  });
});

describe("formatReport", () => {
  it("onda segurada pelo gate: relatório mostra o motivo e não a contagem de e-mails", () => {
    const out = formatReport(
      fakeResult({
        plan: { emails: [], size: 0, skipped: true, reason: "SEGURAR — entrega abaixo do piso" },
        safeToTag: [],
        needsBeehiivDeactivation: [],
      }),
    );
    assert.match(out, /Nenhuma onda proposta: SEGURAR — entrega abaixo do piso/);
  });

  it("onda proposta: mostra tamanho, seguros, e quem precisa de desativação manual na Beehiiv", () => {
    const out = formatReport(fakeResult());
    assert.match(out, /Onda proposta: 2 endereço\(s\)/);
    assert.match(out, /seguro taguear agora: 1/);
    assert.match(out, /PRECISA de desativação manual na Beehiiv antes \(1\)/);
    assert.match(out, /b@gmail\.com/);
  });

  it("dry-run avisa que nada foi escrito; --push confirma a aplicação", () => {
    assert.match(formatReport(fakeResult({ pushed: false })), /--dry-run: nada foi escrito/);
    assert.match(formatReport(fakeResult({ pushed: true })), /--push: onda aplicada e estado persistido/);
  });

  it("lista endereços tagueados mas não confirmados pela releitura", () => {
    const out = formatReport(fakeResult({ unverifiedEmails: ["a@gmail.com"] }));
    assert.match(out, /NÃO confirmou.*a@gmail\.com/s);
  });

  it("lista endereços que FALHARAM (create/tag/releitura lançou) com o motivo — fleet review, mesma classe do #6507", () => {
    const out = formatReport(
      fakeResult({ failedEmails: [{ email: "falhou@gmail.com", error: "ECONNRESET: timeout" }] }),
    );
    assert.match(out, /falharam.*falhou@gmail\.com.*ECONNRESET/s);
  });

  it("não confunde failedEmails com unverifiedEmails — seções distintas quando ambos presentes", () => {
    const out = formatReport(
      fakeResult({
        unverifiedEmails: ["nao-confirmado@gmail.com"],
        failedEmails: [{ email: "erro@gmail.com", error: "5xx" }],
      }),
    );
    assert.match(out, /NÃO confirmou.*nao-confirmado@gmail\.com/s);
    assert.match(out, /falharam.*erro@gmail\.com/s);
  });

  it("omite a seção de desativação manual quando ninguém precisa dela", () => {
    const out = formatReport(fakeResult({ needsBeehiivDeactivation: [] }));
    assert.doesNotMatch(out, /desativação manual/);
  });
});

describe("formatReport — reconciliação out-of-band (#6964)", () => {
  it("omite a linha quando estado e tag do Kit concordam", () => {
    assert.doesNotMatch(formatReport(fakeResult()), /FORA desta rampa/);
  });

  it("informa quantos migraram fora da rampa e que a absorção foi só em memória no dry-run", () => {
    const out = formatReport(fakeResult({ outOfBandReturned: ["x@gmail.com", "y@gmail.com"], pushed: false }));
    assert.match(out, /2 deles migrados FORA desta rampa/);
    assert.match(out, /só em memória \(dry-run\)/);
  });

  it("com --push, diz que a absorção foi persistida no estado", () => {
    const out = formatReport(fakeResult({ outOfBandReturned: ["x@gmail.com"], pushed: true }));
    assert.match(out, /absorvidos no estado/);
  });
});

describe("formatReport — invariante de envio em dobro e releitura não confirmada (#6984)", () => {
  it("lista os endereços absorvidos, não só a contagem", () => {
    const out = formatReport(fakeResult({ outOfBandReturned: ["x@gmail.com", "y@gmail.com"] }));
    assert.match(out, /- x@gmail\.com/);
    assert.match(out, /- y@gmail\.com/);
  });

  it("GRITA quando alguém absorvido continua ativo na Beehiiv (envio em dobro)", () => {
    const out = formatReport(
      fakeResult({ outOfBandReturned: ["dobro@gmail.com"], outOfBandStillActiveOnBeehiiv: ["dobro@gmail.com"] }),
    );
    assert.match(out, /ENVIO EM DOBRO/);
    assert.match(out, /dobro@gmail\.com/);
    assert.match(out, /--audit/);
  });

  it("não menciona envio em dobro quando o invariante está intacto", () => {
    assert.doesNotMatch(formatReport(fakeResult({ outOfBandReturned: ["ok@gmail.com"] })), /ENVIO EM DOBRO/);
  });

  it("mostra os endereços cuja tag não pôde ser confirmada, em vez de silenciá-los", () => {
    const out = formatReport(fakeResult({ unconfirmedTagEmails: ["flaky@gmail.com"] }));
    assert.match(out, /não deu pra confirmar a tag de 1 endereço/);
    assert.match(out, /flaky@gmail\.com/);
  });
});
