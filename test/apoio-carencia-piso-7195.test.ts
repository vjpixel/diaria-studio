/**
 * test/apoio-carencia-piso-7195.test.ts (#7195)
 *
 * Dois invariantes da carência de apoio que existiam de fato mas não estavam
 * declarados nem testados em lugar nenhum — descobertos ao aplicar as
 * remoções da #6925 ao vivo (02/09/2026).
 *
 * ─── 1. O piso de ~30 dias é efeito colateral, não invariante escrito ─────
 *
 * O editor pediu "esperar 30 dias após o último pagamento antes de remover
 * `apoio_nivel`". A carência de 1 mês do #4436 (`computeDesiredApoioLevels`
 * = `max(mês corrente, mês anterior)`) **já** satisfaz isso, mas por
 * aritmética de mês, não por decisão explícita: o pior caso é pagar no
 * ÚLTIMO dia de M, não pagar em M+1, e só ser removido no dia 1º de M+2 —
 * 31 dias. Ninguém escreveu "garantimos ≥30 dias" em lugar nenhum, e nada
 * impedia uma mudança futura em `computeDesiredApoioLevels`/`competenceMonth`
 * de encurtar isso em silêncio. Este arquivo trava o piso.
 *
 * ─── 2. Snapshot do mês anterior ausente zerava a carência em silêncio ────
 *
 * `readPastMonthSnapshots` é fail-soft por desenho (diretório inexistente →
 * `[]`; arquivo de um mês corrompido → aquele mês é pulado, os demais
 * seguem). O `catch` do caller só avisa quando a leitura INTEIRA lança —
 * um único mês faltando passa calado. E é justamente o mês que a carência
 * usa: sem o snapshot de M-1, `previousLevel` de TODO mundo vira `null`,
 * então quem pagou no mês passado e não pagou neste é removido na hora,
 * com zero margem. Pelo RESULTADO, "snapshot ausente" é indistinguível de
 * "ninguém pagou no mês passado" — daí `isPreviousMonthSnapshotMissing`
 * ser um guard próprio, e as remoções passarem a ser fail-closed nesse caso
 * (mesmo escape hatch `--allow-partial` dos outros dois motivos).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeDesiredApoioLevels,
  shouldBlockRemovals,
  isPreviousMonthSnapshotMissing,
  previousMonthKey,
} from "../scripts/sync-apoio-nivel-beehiiv.ts";
import type { MonthSnapshot } from "../scripts/studio-ui/studio-apoios.ts";
import type { ContactWithStatus } from "../scripts/studio-ui/studio-apoios.ts";

function contact(id: string, emails: string[], status: ContactWithStatus["status"]): ContactWithStatus {
  return {
    id,
    name: id,
    emails,
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status,
    openRate: null,
    vinculo: null,
  };
}

function monthSnapshot(month: string, paid: Record<string, number>): MonthSnapshot {
  const statuses: MonthSnapshot["statuses"] = {};
  for (const [email, value] of Object.entries(paid)) {
    statuses[email] = { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: value };
  }
  return { month, statuses };
}

describe("piso de carência ≥30 dias (#7195) — pior caso da aritmética de mês", () => {
  // Cenário do pior caso, o que decide se a regra do editor é cumprida:
  // pagamento no ÚLTIMO dia de agosto, nada em setembro.
  const AGOSTO = monthSnapshot("2026-08", { "quase@x.com": 25 });

  it("em SETEMBRO (M+1) o nível é MANTIDO — a carência está ativa", () => {
    const result = computeDesiredApoioLevels(
      [contact("c1", ["quase@x.com"], { label: "nao_apoia" })],
      [AGOSTO],
      "2026-09",
    );
    assert.equal(
      result[0]!.level,
      "mantenedor",
      "pagou em agosto e não pagou em setembro: tem que manter o nível — este é o mês de carência",
    );
  });

  it("em OUTUBRO (M+2) o nível cai — 31 dias no pior caso (pagamento em 31/08)", () => {
    // Em outubro o snapshot relevante passa a ser o de setembro (vazio);
    // agosto sai da janela. É aqui que a remoção fica legítima.
    const result = computeDesiredApoioLevels(
      [contact("c1", ["quase@x.com"], { label: "nao_apoia" })],
      [AGOSTO, monthSnapshot("2026-09", {})],
      "2026-10",
    );
    assert.equal(result[0]!.level, null, "dois meses sem pagar: a carência esgotou, remoção legítima");
  });

  it("o piso vale para o MELHOR caso também (pagamento em 01/08 ⇒ ~61 dias)", () => {
    // Mesma aritmética — a distinção dia-1 vs dia-31 não existe no cálculo,
    // que é por mês de competência. Documenta que a janela real varia entre
    // ~31 e ~61 dias, e que 31 é o piso.
    const result = computeDesiredApoioLevels(
      [contact("c1", ["quase@x.com"], { label: "nao_apoia" })],
      [AGOSTO],
      "2026-09",
    );
    assert.equal(result[0]!.level, "mantenedor");
  });

  it("REGRESSÃO: o mês da carência é sempre M-1, nunca um mês mais antigo solto", () => {
    // Se `previousMonthKey` (ou a busca por ele) regredir e passar a aceitar
    // qualquer snapshot antigo, alguém que parou de pagar em julho ficaria
    // com o nível para sempre. Julho pago, agosto vazio, corrente setembro
    // ⇒ tem que cair (é exatamente o caso real de lorrene/marinobre, #6925).
    const result = computeDesiredApoioLevels(
      [contact("c1", ["antigo@x.com"], { label: "nao_apoia" })],
      [monthSnapshot("2026-07", { "antigo@x.com": 25 }), monthSnapshot("2026-08", {})],
      "2026-09",
    );
    assert.equal(result[0]!.level, null, "último pagamento em julho, corrente setembro: fora da carência");
  });

  it("previousMonthKey atravessa a virada de ano sem quebrar a carência", () => {
    assert.equal(previousMonthKey("2026-01"), "2025-12");
    const result = computeDesiredApoioLevels(
      [contact("c1", ["ano@x.com"], { label: "nao_apoia" })],
      [monthSnapshot("2025-12", { "ano@x.com": 25 })],
      "2026-01",
    );
    assert.equal(result[0]!.level, "mantenedor", "dezembro→janeiro é carência normal, não um mês perdido");
  });
});

describe("isPreviousMonthSnapshotMissing (#7195)", () => {
  it("snapshot de M-1 presente -> false", () => {
    assert.equal(isPreviousMonthSnapshotMissing([monthSnapshot("2026-08", {})], "2026-09"), false);
  });

  it("lista vazia -> true (é o caso de readPastMonthSnapshots fail-soft devolvendo [])", () => {
    assert.equal(isPreviousMonthSnapshotMissing([], "2026-09"), true);
  });

  it("tem OUTROS meses mas não o M-1 -> true (o caso silencioso: 1 arquivo corrompido)", () => {
    const snaps = [monthSnapshot("2026-06", {}), monthSnapshot("2026-07", {})];
    assert.equal(isPreviousMonthSnapshotMissing(snaps, "2026-09"), true);
  });

  it("virada de ano: corrente 2026-01 exige 2025-12", () => {
    assert.equal(isPreviousMonthSnapshotMissing([monthSnapshot("2025-12", {})], "2026-01"), false);
    assert.equal(isPreviousMonthSnapshotMissing([monthSnapshot("2026-12", {})], "2026-01"), true);
  });
});

describe("shouldBlockRemovals com previousMonthSnapshotMissing (#7195)", () => {
  const semPendencia = { skippedUnresolved: [] };

  it("REGRESSÃO: snapshot de M-1 ausente BLOQUEIA remoções, mesmo com todo o resto limpo", () => {
    // O caminho que antes passava calado: sem erro, sem sem_dados — só a
    // carência silenciosamente inexistente.
    assert.equal(
      shouldBlockRemovals(null, semPendencia, false, { previousMonthSnapshotMissing: true }),
      true,
    );
  });

  it("--allow-partial continua sendo o escape hatch, igual aos outros 2 motivos", () => {
    assert.equal(
      shouldBlockRemovals(null, semPendencia, true, { previousMonthSnapshotMissing: true }),
      false,
    );
  });

  it("snapshot presente + resto limpo -> não bloqueia (caminho normal preservado)", () => {
    assert.equal(
      shouldBlockRemovals(null, semPendencia, false, { previousMonthSnapshotMissing: false }),
      false,
    );
  });

  it("opts OMITIDO equivale a snapshot presente — comportamento pré-#7195 preservado", () => {
    // Garante que os call sites que ainda não passam o campo (ou um consumidor
    // externo) não mudam de comportamento por causa desta issue.
    assert.equal(shouldBlockRemovals(null, semPendencia, false), false);
    assert.equal(shouldBlockRemovals("erro de topo", semPendencia, false), true);
  });

  it("os 3 motivos são independentes — qualquer um sozinho basta pra bloquear", () => {
    assert.equal(shouldBlockRemovals("erro", semPendencia, false, { previousMonthSnapshotMissing: false }), true);
    assert.equal(
      shouldBlockRemovals(null, { skippedUnresolved: [{} as never] }, false, { previousMonthSnapshotMissing: false }),
      true,
    );
    assert.equal(shouldBlockRemovals(null, semPendencia, false, { previousMonthSnapshotMissing: true }), true);
  });
});
