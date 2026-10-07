/**
 * #9824 — a fila diária da Clarice ordena por `priority_points` DESC na fila
 * INTEIRA (positivo, zero e negativo), com cadastro mais recente como
 * desempate entre scores iguais. Decisão do editor de 07/10/2026.
 *
 * Substitui o teste do #7876, que travava o contrário: score 0 e negativo
 * num bloco único ordenado só por safra. Com o teto de volume por onda, isso
 * deixou 45 contatos elegíveis de score >= 0 (cadastros 2021-2023) fora da
 * onda `d3-qua07` (campanha Brevo 332), enquanto -10/-20 de cadastros mais
 * novos entravam.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compareDailyQueueOrder, buildDailySendQueue } from "../scripts/lib/clarice-segment.ts";

function row(over: Record<string, unknown> = {}): any {
  return {
    email: "x@x.com",
    send_eligible: 1,
    sends_count: 2,
    priority_points: 0,
    mv_bucket: "verified",
    cohort: "leads-2026h1",
    created: "2026-01-01T00:00:00Z",
    brevo_list_ids: null,
    ...over,
  };
}

const noGuard = { queuedListIds: new Set<string>(), committedListIds: new Set<string>() };

test("#9824: score 0 de cadastro antigo vem ANTES de score -10 de cadastro novo", () => {
  const zeroAntigo = row({ email: "zero-2021@x.com", priority_points: 0, cohort: "leads-2021h2", created: "2021-09-01T00:00:00Z" });
  const negNovo = row({ email: "neg-2026@x.com", priority_points: -10, cohort: "leads-2026h1", created: "2026-03-01T00:00:00Z" });

  assert.ok(compareDailyQueueOrder(zeroAntigo, negNovo) < 0, "score 0 (2021) antes de -10 (2026)");
  assert.ok(compareDailyQueueOrder(negNovo, zeroAntigo) > 0, "simétrico");
});

test("#9824: entre negativos a magnitude também manda — -10 antes de -20 mesmo com cadastro mais antigo", () => {
  const menos10Antigo = row({ email: "m10@x.com", priority_points: -10, created: "2022-01-01T00:00:00Z" });
  const menos20Novo = row({ email: "m20@x.com", priority_points: -20, created: "2026-09-01T00:00:00Z" });

  assert.ok(compareDailyQueueOrder(menos10Antigo, menos20Novo) < 0);
});

test("#9824: mesmo score desempata por cadastro mais recente primeiro (vale pra 0, negativo e positivo)", () => {
  for (const score of [-10, 0, 30]) {
    const novo = row({ email: "z-novo@x.com", priority_points: score, created: "2026-05-01T00:00:00Z" });
    const antigo = row({ email: "a-antigo@x.com", priority_points: score, created: "2023-05-01T00:00:00Z" });
    assert.ok(compareDailyQueueOrder(novo, antigo) < 0, `score ${score}: cadastro mais recente primeiro, mesmo com email maior`);
  }
});

test("#9824: buildDailySendQueue — fila sai por score DESC e recência dentro do score", () => {
  const engajado = row({ email: "engajado@x.com", sends_count: 5, priority_points: 50, created: "2019-01-01T00:00:00Z" });
  const zero2021 = row({ email: "zero-2021@x.com", priority_points: 0, created: "2021-05-01T00:00:00Z" });
  const zero2023 = row({ email: "zero-2023@x.com", priority_points: 0, created: "2023-05-01T00:00:00Z" });
  const neg10a2026 = row({ email: "neg10-2026@x.com", priority_points: -10, created: "2026-05-01T00:00:00Z" });
  const neg10a2024 = row({ email: "neg10-2024@x.com", priority_points: -10, created: "2024-05-01T00:00:00Z" });
  const neg20a2026 = row({ email: "neg20-2026@x.com", priority_points: -20, created: "2026-08-01T00:00:00Z" });

  const queue = buildDailySendQueue([neg20a2026, zero2021, neg10a2024, engajado, neg10a2026, zero2023], noGuard);

  assert.deepEqual(
    queue.map((r) => r.email),
    [engajado.email, zero2023.email, zero2021.email, neg10a2026.email, neg10a2024.email, neg20a2026.email],
  );
});

test("#9824: invariante da definição de feito — corte por teto nunca deixa fora score maior que algum incluído", () => {
  const rows = [];
  const scores = [5, 0, 0, -10, -10, -20, 0, -10];
  const years = [2020, 2021, 2025, 2026, 2023, 2026, 2022, 2024];
  for (let i = 0; i < scores.length; i++) {
    rows.push(row({ email: `c${i}@x.com`, priority_points: scores[i], created: `${years[i]}-03-01T00:00:00Z` }));
  }
  const queue = buildDailySendQueue(rows, noGuard);
  for (let teto = 1; teto < queue.length; teto++) {
    const incl = queue.slice(0, teto);
    const excl = queue.slice(teto);
    const minIncl = Math.min(...incl.map((r) => r.priority_points));
    const maxExcl = Math.max(...excl.map((r) => r.priority_points));
    assert.ok(minIncl >= maxExcl, `teto ${teto}: incluído com score ${minIncl} < excluído com ${maxExcl}`);
    for (const i of incl) {
      for (const e of excl) {
        if (i.priority_points === e.priority_points) {
          assert.ok(Date.parse(i.created) >= Date.parse(e.created), `teto ${teto}: empate de score com incluído mais antigo que excluído`);
        }
      }
    }
  }
});
