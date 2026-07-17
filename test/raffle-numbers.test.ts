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
  decideRemoteFallback,
  extractPreviousEditionRevealFromPublishedContent,
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
      saveRaffleRegistry(path, { entries });
      const loaded = loadRaffleRegistry(path);
      assert.deepEqual(loaded, entries);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #2780: `saveRaffleRegistry` aceita `{ entries }` (não `RaffleEntry[]` cru) —
  // `AllocateRaffleNumberResult` satisfaz esse shape estruturalmente, então o
  // call-site correto é `saveRaffleRegistry(path, result)`, NUNCA
  // `saveRaffleRegistry(path, loadRaffleRegistry(path))` (array originalmente
  // carregado, sem a entry recém-alocada).
  it("#2780: aceita diretamente o AllocateRaffleNumberResult (result.entries persistido, não o array originalmente carregado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "raffle-test-"));
    try {
      const path = join(dir, "raffle-numbers.json");
      const originalEntries: RaffleEntry[] = [
        { cycle: "2606", email: "existing@example.com", number: 1, edition: "260610", issued_at: "x" },
      ];
      const result = allocateRaffleNumber(
        originalEntries,
        { cycle: "2606", email: "joshu@example.com", edition: "260629" },
        "2026-06-29T12:00:00.000Z",
      );
      assert.equal(result.isNew, true);

      // Call-site correto: passa o result inteiro (satisfaz `{ entries }` por
      // structural typing), não `originalEntries` (que ficaria sem a alocação).
      saveRaffleRegistry(path, result);

      const loaded = loadRaffleRegistry(path);
      assert.equal(loaded.length, 2, "deve persistir AMBAS entries — a original + a recém-alocada");
      assert.ok(loaded.some((e) => e.email === "joshu@example.com" && e.number === 2));
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

describe("decideRemoteFallback (#3210)", () => {
  it("não usa fallback remoto quando o JSON local existe", () => {
    const result = decideRemoteFallback({ description: "erro X" }, null);
    assert.equal(result.useRemoteFallback, false);
    assert.equal(result.reason, "local_json_present");
  });

  it("não usa fallback remoto quando só a entry do jsonl existe", () => {
    const result = decideRemoteFallback(null, { edition: "260709", error_type: "factual" });
    assert.equal(result.useRemoteFallback, false);
    assert.equal(result.reason, "jsonl_entry_present");
  });

  it("usa fallback remoto quando AMBOS estão ausentes (caso 260709 do #3210)", () => {
    const result = decideRemoteFallback(null, null);
    assert.equal(result.useRemoteFallback, true);
    assert.equal(result.reason, "both_missing");
  });

  it("undefined é tratado igual a null (ambos ausentes)", () => {
    const result = decideRemoteFallback(undefined, undefined);
    assert.equal(result.useRemoteFallback, true);
  });
});

describe("extractPreviousEditionRevealFromPublishedContent (#3210)", () => {
  // Fixture inspirada no caso real 260709→260710: MIT descrito como
  // universidade britânica quando na verdade é americana.
  const PUBLISHED_260710 = [
    "# Diar.ia — 10/07",
    "",
    "DESTAQUE 1",
    "",
    "Texto qualquer do destaque...",
    "",
    "---",
    "",
    "**ERRO INTENCIONAL**",
    "",
    "Na última edição, chamamos o MIT de universidade britânica, mas o correto é universidade americana.",
    "",
    "---",
    "",
    "**🎁 SORTEIO**",
    "",
    "Você presta atenção ao conteúdo gerado por IA que consome?",
    "",
  ].join("\n");

  it("extrai o reveal da edição anterior a partir do conteúdo publicado (fallback #3210)", () => {
    const result = extractPreviousEditionRevealFromPublishedContent(PUBLISHED_260710);
    assert.ok(result, "deve extrair um resultado");
    assert.match(result!.description!, /MIT/);
    assert.match(result!.description!, /universidade americana/);
  });

  it("retorna null quando não há seção de reveal no conteúdo publicado", () => {
    const content = "# Diar.ia — 10/07\n\nDESTAQUE 1\n\nTexto sem nenhum reveal.\n";
    assert.equal(extractPreviousEditionRevealFromPublishedContent(content), null);
  });

  it("retorna null pra conteúdo vazio", () => {
    assert.equal(extractPreviousEditionRevealFromPublishedContent(""), null);
  });

  it("decisão completa: local+jsonl ausentes → fallback remoto → parse do reveal → match correto do leitor (fluxo #3210 ponta-a-ponta, sem MCP real)", () => {
    // 1. Decisão: dados locais ausentes (como 260709 no incidente real).
    const decision = decideRemoteFallback(null, null);
    assert.equal(decision.useRemoteFallback, true);

    // 2. Fallback: parseia o conteúdo que teria vindo de
    //    mcp__claude_ai_Beehiiv__get_post_content (mockado aqui como string,
    //    já que mockar o MCP em si não é prático neste ambiente de teste).
    const remoteError = extractPreviousEditionRevealFromPublishedContent(PUBLISHED_260710);
    assert.ok(remoteError, "fallback deve recuperar o erro a partir do conteúdo publicado");

    // 3. Match: a reply do leitor (caso real Joshu) deve bater contra o erro
    //    recuperado via fallback, exatamente como bateria contra dados locais.
    const replyBody = "Acho que o erro foi chamar o MIT de universidade britânica — é americana!";
    assert.equal(matchesIntentionalError(replyBody, remoteError!), true);

    // 4. Contraste: reply sem relação nenhuma não deve bater mesmo com o
    //    fallback ativo (mesma heurística conservadora de sempre).
    const unrelatedReply = "Adorei a edição de hoje!";
    assert.equal(matchesIntentionalError(unrelatedReply, remoteError!), false);
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

  it("idempotência: mesma edição pro mesmo email não realoca — reprocessar a mesma reply não duplica (#achado-260716, revisão do #2724 item 4)", () => {
    const first = allocateRaffleNumber(
      [],
      { cycle: "2606", email: "joshu@example.com", edition: "260629" },
      "2026-06-29T12:00:00.000Z",
    );
    const second = allocateRaffleNumber(
      first.entries,
      { cycle: "2606", email: "JOSHU@example.com", edition: "260629" }, // case diferente, MESMA edição
      "2026-06-30T12:00:00.000Z",
    );
    assert.equal(second.isNew, false);
    assert.equal(second.entry.number, first.entry.number);
    assert.equal(second.entries.length, 1); // não duplicou
  });

  it("caso real Joshu 260716: mesmo email, mesmo ciclo, edição DIFERENTE → ganha número NOVO (regra confirmada com o editor: 1 número por acerto, não por pessoa)", () => {
    const first = allocateRaffleNumber(
      [],
      { cycle: "2607", email: "joshusantos@gmail.com", nickname: "Joshu", edition: "260709" },
      "2026-07-10T02:36:43.268Z",
    );
    assert.equal(first.entry.number, 1);

    const second = allocateRaffleNumber(first.entries, {
      cycle: "2607",
      email: "joshusantos@gmail.com",
      nickname: "Joshu",
      edition: "260716", // edição diferente, mesmo ciclo
    });
    assert.equal(second.isNew, true, "acerto numa edição diferente do mesmo ciclo deve gerar número novo");
    assert.equal(second.entry.number, 2, "próximo número sequencial do ciclo, não reaproveita o da 1ª edição");
    assert.equal(second.entries.length, 2, "as 2 entries coexistem — 2 bilhetes pro mesmo email no mesmo ciclo");
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
