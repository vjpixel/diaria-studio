/**
 * raffle-numbers.test.ts (#2724)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRaffleRegistry,
  loadRaffleRegistry,
  saveRaffleRegistry,
  cycleFromEdition,
  matchesIntentionalError,
  nextRaffleNumber,
  allocateRaffleNumber,
  type RaffleEntry,
} from "../scripts/lib/raffle-numbers.ts";

describe("cycleFromEdition (#2724)", () => {
  it("deriva o ciclo AAMM a partir da edição AAMMDD", () => {
    assert.equal(cycleFromEdition("260629"), "2606");
    assert.equal(cycleFromEdition("260701"), "2607");
  });

  it("lança em edição malformada", () => {
    assert.throws(() => cycleFromEdition("abc"));
    assert.throws(() => cycleFromEdition("26063")); // curta demais
  });
});

describe("parseRaffleRegistry / loadRaffleRegistry (#2724)", () => {
  it("parseia array válido", () => {
    const entries = parseRaffleRegistry(
      JSON.stringify([{ cycle: "2606", email: "a@b.com", number: 1, edition: "260629", issued_at: "x" }]),
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].email, "a@b.com");
  });

  it("retorna [] em JSON inválido (sem crash)", () => {
    assert.deepEqual(parseRaffleRegistry("{ broken"), []);
  });

  it("retorna [] quando não é array", () => {
    assert.deepEqual(parseRaffleRegistry(JSON.stringify({ foo: "bar" })), []);
  });

  it("filtra entries malformadas (sem cycle/email/number)", () => {
    const entries = parseRaffleRegistry(
      JSON.stringify([
        { cycle: "2606", email: "a@b.com", number: 1, edition: "260629", issued_at: "x" },
        { cycle: "2606" }, // sem email/number
      ]),
    );
    assert.equal(entries.length, 1);
  });

  it("loadRaffleRegistry retorna [] quando arquivo não existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "raffle-test-"));
    try {
      assert.deepEqual(loadRaffleRegistry(join(dir, "nope.json")), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("save + load roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "raffle-test-"));
    try {
      const path = join(dir, "raffle-numbers.json");
      const entries: RaffleEntry[] = [
        { cycle: "2606", email: "a@b.com", number: 1, edition: "260629", issued_at: "2026-06-29T10:00:00.000Z" },
      ];
      saveRaffleRegistry(path, entries);
      const loaded = loadRaffleRegistry(path);
      assert.deepEqual(loaded, entries);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("matchesIntentionalError (#2724) — caso real Joshu 260629", () => {
  // Erro real declarado: papéis de Sol/Luna invertidos no "Por que isso importa" do D2.
  const ERROR_260629 = {
    category: "attribution",
    location: "DESTAQUE 2, Por que isso importa",
    description: "Papéis de Sol e Luna invertidos no parágrafo Por que isso importa",
    correct_value: "Sol é o modelo de geração de imagem, Luna é o de geração de texto",
  };

  it("acerta quando a reply identifica corretamente o erro (caso Joshu)", () => {
    const body =
      "Oi Pixel! Acho que vi o erro de hoje: vocês trocaram Sol e Luna no Por que isso importa do D2 — Sol é geração de imagem, não Luna.";
    assert.equal(matchesIntentionalError(body, ERROR_260629), true);
  });

  it("não acerta quando a reply fala de outro assunto (sem overlap)", () => {
    const body = "Adorei a edição de hoje, parabéns pelo trabalho!";
    assert.equal(matchesIntentionalError(body, ERROR_260629), false);
  });

  it("não acerta quando a reply menciona Sol/Luna mas fora do contexto certo (sem correct_value)", () => {
    const body = "Gostei muito da parte sobre o sistema solar e a lua cheia desse mês.";
    // bate "sol"/"luna" não exatamente (acentos/plural) — heurística exige >3 chars
    // e palavras do correct_value/description; aqui não há overlap real.
    assert.equal(matchesIntentionalError(body, ERROR_260629), false);
  });

  it("caso real Edson 'Macrosoft fora do prazo' — fora do prazo, deve ficar como não-acerto no fluxo (matching em si pode bater, prazo é responsabilidade do orchestrator)", () => {
    const body = "Acho que o erro foi chamar a Microsoft de Macrosoft, mas só vi isso agora, depois do prazo.";
    const error = {
      category: "ortografico",
      location: "DESTAQUE 1",
      description: "Microsoft grafada como Macrosoft",
      correct_value: "Microsoft",
    };
    assert.equal(matchesIntentionalError(body, error), true);
  });

  it("caso real Joshu 'valuation' — não-acerto, sem overlap com o erro real", () => {
    const body = "Achei que o erro intencional era sobre o valuation da empresa estar errado.";
    assert.equal(matchesIntentionalError(body, ERROR_260629), false);
  });

  it("retorna false pra corpo vazio", () => {
    assert.equal(matchesIntentionalError("", ERROR_260629), false);
  });

  it("retorna false quando o erro não tem correct_value nem description/location", () => {
    assert.equal(matchesIntentionalError("qualquer coisa", {}), false);
  });
});

describe("nextRaffleNumber (#2724)", () => {
  it("retorna 1 quando o ciclo está vazio", () => {
    assert.equal(nextRaffleNumber([], "2606"), 1);
  });

  it("retorna max + 1 dentro do ciclo", () => {
    const entries: RaffleEntry[] = [
      { cycle: "2606", email: "a@b.com", number: 5, edition: "260610", issued_at: "x" },
      { cycle: "2606", email: "c@d.com", number: 7, edition: "260620", issued_at: "x" },
      { cycle: "2605", email: "e@f.com", number: 99, edition: "260520", issued_at: "x" },
    ];
    assert.equal(nextRaffleNumber(entries, "2606"), 8);
  });

  it("ignora entries de outros ciclos", () => {
    const entries: RaffleEntry[] = [
      { cycle: "2605", email: "a@b.com", number: 99, edition: "260520", issued_at: "x" },
    ];
    assert.equal(nextRaffleNumber(entries, "2606"), 1);
  });
});

describe("allocateRaffleNumber (#2724)", () => {
  it("aloca número sequencial novo", () => {
    const result = allocateRaffleNumber(
      [],
      { cycle: "2606", email: "joshu@example.com", nickname: "Joshu", edition: "260629" },
      "2026-06-29T12:00:00.000Z",
    );
    assert.equal(result.isNew, true);
    assert.equal(result.entry.number, 1);
    assert.equal(result.entries.length, 1);
  });

  it("incrementa a partir do maior número do ciclo", () => {
    const existing: RaffleEntry[] = [
      { cycle: "2606", email: "a@b.com", number: 7, edition: "260620", issued_at: "x" },
    ];
    const result = allocateRaffleNumber(existing, {
      cycle: "2606",
      email: "joshu@example.com",
      edition: "260629",
    });
    assert.equal(result.entry.number, 8);
  });

  it("idempotência: mesmo email no mesmo ciclo não realoca (#2724 item 4)", () => {
    const first = allocateRaffleNumber(
      [],
      { cycle: "2606", email: "joshu@example.com", edition: "260629" },
      "2026-06-29T12:00:00.000Z",
    );
    const second = allocateRaffleNumber(
      first.entries,
      { cycle: "2606", email: "JOSHU@example.com", edition: "260630" }, // case diferente, edição diferente
      "2026-06-30T12:00:00.000Z",
    );
    assert.equal(second.isNew, false);
    assert.equal(second.entry.number, first.entry.number);
    assert.equal(second.entries.length, 1); // não duplicou
    assert.equal(second.entry.edition, "260629"); // preserva a edição original
  });

  it("mesmo email em ciclos diferentes ganha números independentes", () => {
    const first = allocateRaffleNumber([], { cycle: "2606", email: "a@b.com", edition: "260629" });
    const second = allocateRaffleNumber(first.entries, {
      cycle: "2607",
      email: "a@b.com",
      edition: "260710",
    });
    assert.equal(second.isNew, true);
    assert.equal(second.entry.number, 1);
    assert.equal(second.entries.length, 2);
  });
});
