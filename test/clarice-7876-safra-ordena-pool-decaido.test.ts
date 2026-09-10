/**
 * #7876 — dentro do pool de score ≤ 0 da fila diária unificada (#7406), quem
 * ordena é a SAFRA (`compareContactRecency` = `created` DESC, #5169), nunca a
 * magnitude do decaimento.
 *
 * Antes, `compareDailyQueueOrder` comparava `priority_points` primeiro pra
 * QUALQUER par (`if (pa !== pb) return pb - pa`), então dentro do pool
 * negativo cada valor de score virava um sub-bloco: quem decaiu -1 passava
 * inteiro na frente de quem decaiu -2, por mais nova que fosse a safra deste.
 *
 * Era inofensivo antes do #7873 (o pool só tinha ramp-warm, todos score 0, e
 * a recência governava de fato). O #7873 trouxe ~268k contatos de score ≤ 0
 * pra dentro da fila — 263.998 deles entre -1 e -10 (medição de 09/09/2026,
 * ciclo 2608-09) — e o pool inteiro passou a sair despedaçado por ruído de
 * decaimento.
 *
 * Decisão do editor (09/09/2026): score negativo não é sinal editorial, é
 * quanto tempo faz que a pessoa não interage; dentro do pool a safra manda.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compareDailyQueueOrder, buildDailySendQueue } from "../scripts/lib/clarice-segment.ts";

function row(over: Record<string, unknown> = {}): any {
  return {
    email: "x@x.com",
    send_eligible: 1,
    sends_count: 0,
    priority_points: 0,
    mv_bucket: "verified",
    cohort: "leads-2026h1",
    created: "2026-01-01T00:00:00Z",
    brevo_list_ids: null,
    ...over,
  };
}

const noGuard = { queuedListIds: new Set<string>(), committedListIds: new Set<string>() };

test("#7876: safra vence a magnitude do decaimento dentro do pool score <= 0", () => {
  const decaiMuitoMasNovo = row({
    email: "novo@x.com",
    sends_count: 2,
    priority_points: -9,
    cohort: "leads-2026h1",
    created: "2026-03-01T00:00:00Z",
  });
  const decaiPoucoMasAntigo = row({
    email: "antigo@x.com",
    sends_count: 2,
    priority_points: -1,
    cohort: "leads-2021h2",
    created: "2021-09-01T00:00:00Z",
  });

  assert.ok(
    compareDailyQueueOrder(decaiMuitoMasNovo, decaiPoucoMasAntigo) < 0,
    "cadastro de 2026 com score -9 vem ANTES de cadastro de 2021 com score -1",
  );
  assert.ok(compareDailyQueueOrder(decaiPoucoMasAntigo, decaiMuitoMasNovo) > 0, "simétrico");
});

test("#7876: a fronteira que ordena é `> 0`, não `0` vs negativo — score 0 não é tier acima de score -9", () => {
  const negativoNovo = row({
    email: "neg-novo@x.com",
    sends_count: 2,
    priority_points: -9,
    created: "2026-03-01T00:00:00Z",
  });
  const zeroAntigo = row({
    email: "zero-antigo@x.com",
    sends_count: 2,
    priority_points: 0,
    created: "2022-01-01T00:00:00Z",
  });

  assert.ok(
    compareDailyQueueOrder(negativoNovo, zeroAntigo) < 0,
    "score -9 de 2026 antes de score 0 de 2022 — os dois estão no mesmo pool",
  );
});

test("#7876: score > 0 preserva magnitude como sinal e prioridade TOTAL sobre o pool (#7236)", () => {
  const pos10 = row({ email: "p10@x.com", sends_count: 3, priority_points: 10, created: "2021-01-01T00:00:00Z" });
  const pos80 = row({ email: "p80@x.com", sends_count: 3, priority_points: 80, created: "2020-01-01T00:00:00Z" });
  const negativoNovissimo = row({
    email: "neg@x.com",
    sends_count: 2,
    priority_points: -1,
    created: "2026-09-01T00:00:00Z",
  });

  assert.ok(
    compareDailyQueueOrder(pos80, pos10) < 0,
    "entre positivos, score DESC ainda governa — safra NÃO inverte (lá a magnitude é sinal)",
  );
  assert.ok(
    compareDailyQueueOrder(pos10, negativoNovissimo) < 0,
    "qualquer score>0 antes de qualquer score<=0, mesmo o cadastro mais novo do pool",
  );
});

test("#7876: buildDailySendQueue — fila real sai por safra dentro do pool, positivos na frente", () => {
  const engajado = row({ email: "engajado@x.com", sends_count: 5, priority_points: 50, created: "2019-01-01T00:00:00Z" });
  const pool2026 = row({ email: "a-2026@x.com", sends_count: 2, priority_points: -7, created: "2026-05-01T00:00:00Z" });
  const pool2024 = row({ email: "b-2024@x.com", sends_count: 2, priority_points: -1, created: "2024-05-01T00:00:00Z" });
  const pool2021 = row({ email: "c-2021@x.com", sends_count: 2, priority_points: 0, created: "2021-05-01T00:00:00Z" });

  const queue = buildDailySendQueue([pool2021, pool2024, engajado, pool2026], noGuard);

  assert.deepEqual(
    queue.map((r) => r.email),
    [engajado.email, pool2026.email, pool2024.email, pool2021.email],
    "score>0 primeiro; depois o pool inteiro por `created` DESC, ignorando -7 vs -1 vs 0",
  );
});
