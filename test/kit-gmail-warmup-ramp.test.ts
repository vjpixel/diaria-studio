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
    beehiivCheckOk: true,
    statePersisted: false,
    propagationConfirmed: true,
    propagationConfirmedCount: 0,
    propagationTotalCount: 0,
    propagationAttempts: 0,
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

  it("lista endereços que FALHARAM (create/tag/releitura lançou) com o motivo — fleet review, mesma classe do #6507", () => {
    const out = formatReport(
      fakeResult({ failedEmails: [{ email: "falhou@gmail.com", error: "ECONNRESET: timeout" }] }),
    );
    assert.match(out, /falharam.*falhou@gmail\.com.*ECONNRESET/s);
  });

  it("não confunde failedEmails com unverifiedEmails — seções distintas quando ambos presentes", () => {
    const out = formatReport(
      fakeResult({
        pushed: true,
        unverifiedEmails: ["nao-confirmado@gmail.com"],
        propagationConfirmed: false,
        propagationConfirmedCount: 0,
        propagationTotalCount: 1,
        propagationAttempts: 6,
        failedEmails: [{ email: "erro@gmail.com", error: "5xx" }],
      }),
    );
    assert.match(out, /propagando.*nao-confirmado@gmail\.com/s);
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
    // A rotulagem segue `statePersisted` (o que de fato foi escrito), não
    // `pushed` (se uma onda foi tagueada) — ver finding 2 da 2ª rodada.
    const out = formatReport(fakeResult({ outOfBandReturned: ["x@gmail.com"], pushed: true, statePersisted: true }));
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

describe("formatReport — persistência e checagem da Beehiiv (#6984 2ª rodada)", () => {
  it("REGRESSÃO finding 2: absorção gravada numa rodada sem onda não é rotulada como dry-run", () => {
    // --push + gate segurou: nenhuma onda tagueada (pushed=false), mas a
    // absorção foi pro disco. Dizer "só em memória" seria mentir sobre o
    // estado — a classe de erro que o #573 existe pra impedir.
    const out = formatReport(
      fakeResult({ outOfBandReturned: ["x@gmail.com"], pushed: false, statePersisted: true }),
    );
    assert.match(out, /absorvidos no estado/);
    assert.doesNotMatch(out, /só em memória/);
  });

  it("dry-run de verdade continua dizendo que nada foi escrito", () => {
    const out = formatReport(
      fakeResult({ outOfBandReturned: ["x@gmail.com"], pushed: false, statePersisted: false }),
    );
    assert.match(out, /só em memória \(dry-run\)/);
  });

  it("REGRESSÃO finding 1: sem checagem da Beehiiv, o alarme não AFIRMA que estão ativos", () => {
    const out = formatReport(
      fakeResult({
        outOfBandReturned: ["x@gmail.com"],
        outOfBandStillActiveOnBeehiiv: ["x@gmail.com"],
        beehiivCheckOk: false,
      }),
    );
    assert.match(out, /NÃO VERIFICADO/);
    assert.match(out, /SEM checagem/);
    assert.match(out, /--audit/);
  });

  it("com checagem OK, o alarme afirma a violação sem ressalva", () => {
    const out = formatReport(
      fakeResult({
        outOfBandReturned: ["x@gmail.com"],
        outOfBandStillActiveOnBeehiiv: ["x@gmail.com"],
        beehiivCheckOk: true,
      }),
    );
    assert.match(out, /ENVIO EM DOBRO —/);
    assert.doesNotMatch(out, /NÃO VERIFICADO/);
  });
});

describe("formatReport — nunca declara 'aplicada' enquanto a propagação não confirma (#7296)", () => {
  it("--push com propagationConfirmed:false NUNCA imprime 'onda aplicada e estado persistido'", () => {
    const out = formatReport(
      fakeResult({
        pushed: true,
        unverifiedEmails: ["a@gmail.com", "b@gmail.com"],
        propagationConfirmed: false,
        propagationConfirmedCount: 1,
        propagationTotalCount: 3,
        propagationAttempts: 6,
      }),
    );
    assert.doesNotMatch(out, /onda aplicada e estado persistido/);
    assert.match(out, /propagando.*1\/3 confirmados/s);
    assert.match(out, /a@gmail\.com/);
    assert.match(out, /b@gmail\.com/);
  });

  it("avisa explicitamente contra reativar na Beehiiv enquanto propaga — o risco central do #7296", () => {
    const out = formatReport(
      fakeResult({
        pushed: true,
        unverifiedEmails: ["a@gmail.com"],
        propagationConfirmed: false,
        propagationConfirmedCount: 0,
        propagationTotalCount: 1,
        propagationAttempts: 6,
      }),
    );
    assert.match(out, /NUNCA reative estes endereços na Beehiiv/);
  });

  it("--push com propagationConfirmed:true (convergiu, mesmo que só após retry) imprime 'aplicada' com a contagem", () => {
    const out = formatReport(
      fakeResult({
        pushed: true,
        unverifiedEmails: [],
        propagationConfirmed: true,
        propagationConfirmedCount: 3,
        propagationTotalCount: 3,
        propagationAttempts: 3,
      }),
    );
    assert.match(out, /onda aplicada e estado persistido \(propagação confirmada: 3\/3\)/);
  });
});

describe("confirmWavePropagation (#7296) — retry-com-releitura antes de declarar convergência", () => {
  it("converge na 1ª tentativa quando confirmFn já confirma tudo — 1 attempt, sem sleep", async () => {
    const { confirmWavePropagation } = await import("../scripts/kit-gmail-warmup-ramp.ts");
    let sleepCalls = 0;
    const result = await confirmWavePropagation(["a@gmail.com", "b@gmail.com"], 999, {
      sleepFn: async () => {
        sleepCalls += 1;
      },
      confirmFn: async (emails) => ({ tagged: new Set(emails.map((e) => e.trim().toLowerCase())), unconfirmed: [] }),
    });
    assert.deepEqual(result.pending, []);
    assert.deepEqual(result.confirmed.sort(), ["a@gmail.com", "b@gmail.com"]);
    assert.equal(result.attempts, 1);
    assert.equal(sleepCalls, 0);
  });

  it("simula a API do Kit devolvendo a tag INCOMPLETA nas N primeiras leituras e converge depois — regressão central do #7296", async () => {
    const { confirmWavePropagation } = await import("../scripts/kit-gmail-warmup-ramp.ts");
    // Mimetiza a tabela medida ao vivo na issue: só parte da onda confirma a
    // cada rodada, até convergir de vez na 4ª.
    const waves = [
      new Set(["a@gmail.com"]), // rodada 1: só 1/3
      new Set(["a@gmail.com", "b@gmail.com"]), // rodada 2: 2/3
      new Set(["a@gmail.com", "b@gmail.com"]), // rodada 3: sem progresso (ainda incompleta)
      new Set(["a@gmail.com", "b@gmail.com", "c@gmail.com"]), // rodada 4: converge
    ];
    let call = 0;
    const sleeps: number[] = [];
    const result = await confirmWavePropagation(["a@gmail.com", "b@gmail.com", "c@gmail.com"], 999, {
      maxAttempts: 6,
      intervalMs: 30_000,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      confirmFn: async (emails) => {
        const snapshot = waves[Math.min(call, waves.length - 1)];
        call += 1;
        const tagged = new Set(emails.filter((e) => snapshot.has(e.trim().toLowerCase())).map((e) => e.trim().toLowerCase()));
        return { tagged, unconfirmed: [] };
      },
    });
    assert.deepEqual(result.pending, []);
    assert.deepEqual(result.confirmed.sort(), ["a@gmail.com", "b@gmail.com", "c@gmail.com"]);
    assert.equal(result.attempts, 4);
    // 3 sleeps entre as 4 tentativas (nenhum antes da 1ª) — nunca espera à
    // toa depois de convergir.
    assert.deepEqual(sleeps, [30_000, 30_000, 30_000]);
  });

  it("estoura o teto de tentativas sem convergir: devolve quem ainda está pendente, nunca lança", async () => {
    const { confirmWavePropagation } = await import("../scripts/kit-gmail-warmup-ramp.ts");
    const result = await confirmWavePropagation(["nunca-confirma@gmail.com"], 999, {
      maxAttempts: 3,
      sleepFn: async () => {},
      confirmFn: async () => ({ tagged: new Set<string>(), unconfirmed: [] }),
    });
    assert.deepEqual(result.pending, ["nunca-confirma@gmail.com"]);
    assert.deepEqual(result.confirmed, []);
    assert.equal(result.attempts, 3);
  });

  it("404/erro de leitura no confirmFn NÃO é fatal — endereço só segue pendente, releitura continua", async () => {
    const { confirmWavePropagation } = await import("../scripts/kit-gmail-warmup-ramp.ts");
    // confirmFn real (confirmTaggedEmails) já absorve erro por endereço em
    // `unconfirmed` sem lançar (ver docstring) — este teste garante que
    // confirmWavePropagation não trata isso como falha da onda inteira.
    let call = 0;
    const result = await confirmWavePropagation(["pendente-404@gmail.com"], 999, {
      maxAttempts: 2,
      sleepFn: async () => {},
      confirmFn: async (emails) => {
        call += 1;
        // 1ª leitura: 404 (assinante ainda não indexado) → classificado como
        // não-confirmado, não fatal. 2ª leitura: confirma.
        if (call === 1) return { tagged: new Set<string>(), unconfirmed: [...emails] };
        return { tagged: new Set(emails.map((e) => e.trim().toLowerCase())), unconfirmed: [] };
      },
    });
    assert.deepEqual(result.pending, []);
    assert.deepEqual(result.confirmed, ["pendente-404@gmail.com"]);
    assert.equal(result.attempts, 2);
  });

  it("só relê quem ainda está pendente em rodadas seguintes, nunca o lote inteiro de novo", async () => {
    const { confirmWavePropagation } = await import("../scripts/kit-gmail-warmup-ramp.ts");
    const seenPerCall: string[][] = [];
    await confirmWavePropagation(["a@gmail.com", "b@gmail.com"], 999, {
      maxAttempts: 3,
      sleepFn: async () => {},
      confirmFn: async (emails) => {
        seenPerCall.push([...emails]);
        // só "a" confirma na 1ª rodada
        const tagged = new Set(emails.includes("a@gmail.com") && seenPerCall.length === 1 ? ["a@gmail.com"] : []);
        return { tagged, unconfirmed: [] };
      },
    });
    assert.deepEqual(seenPerCall[0].sort(), ["a@gmail.com", "b@gmail.com"]);
    assert.deepEqual(seenPerCall[1], ["b@gmail.com"]);
  });
});
