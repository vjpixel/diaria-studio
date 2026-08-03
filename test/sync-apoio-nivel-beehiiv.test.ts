/**
 * test/sync-apoio-nivel-beehiiv.test.ts (#4273 parte 2, carência/guard #4436)
 *
 * Testa as funções PURAS de `scripts/sync-apoio-nivel-beehiiv.ts`:
 * `computeDesiredApoioLevels` (contatos + histórico → nível desejado, com
 * carência de 1 mês), `diffApoioTags` (desejado × estado atual da Beehiiv →
 * entra/sai/muda de faixa), `shouldBlockRemovals` (guard fail-closed de
 * dados parciais) e `evaluateBlastRadiusGuard` (guard de magnitude de
 * remoções, #4436). Nenhum teste bate na API real — `current` é sempre uma
 * fixture `BeehiivSubscriptionSnapshot[]` construída à mão, nunca vem de
 * `fetchCurrentBeehiivState`; `pastSnapshots` é sempre uma fixture
 * `MonthSnapshot[]`, nunca vem de `readPastMonthSnapshots` real.
 *
 * Casos obrigatórios (#4273, corpo da issue):
 *   1. Contato com múltiplos e-mails.
 *   2. Contato "sem_dados" (não pode gerar remoção).
 *   3. Mudança de faixa (troca de valor, nunca acumula duas).
 *   4. Assinante taggeado que parou de apoiar (perde o valor).
 *   5. Apoiador que não é assinante da Beehiiv (ignorado/reportado, sem erro).
 *
 * Casos obrigatórios de carência + guard (#4436, corpo da issue):
 *   6. Pagou no mês corrente-1, não pagou no corrente → MANTÉM (carência).
 *   7. 2 meses sem pagar → remove.
 *   8. Troca de faixa → 1 escrita, nunca acumula valor.
 *   9. Contato com múltiplos e-mails casando mais de uma subscription
 *      (repetido aqui no contexto da carência — `levelFromSnapshot` cruza
 *      TODOS os e-mails do contato contra o snapshot do mês anterior).
 *  10. `sem_dados` nunca gera ação, mesmo com carência disponível.
 *  11. Guard (b): limiar de remoções atingido → push recusado; no limiar
 *      EXATO (30%) não bloqueia (só acima).
 *
 * Também testa `applyApoioTagEntry` (achado #2 do review da PR #4307) — a
 * função de escrita+releitura, com `fetchImpl` mockado (nunca rede real). É o
 * mecanismo de segurança central do módulo (a lição documentada no cabeçalho
 * do arquivo: nunca confiar só no status code, sempre reler — exatamente a
 * armadilha que a issue #4273 documentou pra `tags`), então precisa de
 * cobertura direta, não só inferida via `diffApoioTags`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeDesiredApoioLevels,
  diffApoioTags,
  extractApoioNivelValue,
  shouldBlockRemovals,
  applyApoioTagEntry,
  fetchCurrentBeehiivState,
  maxLevel,
  previousMonthKey,
  levelFromSnapshot,
  evaluateBlastRadiusGuard,
  reconcilePendingPromises,
  type ApoioTagDiffEntry,
  type BeehiivSubscriptionSnapshot,
} from "../scripts/sync-apoio-nivel-beehiiv.ts";
import type { ContactWithStatus, MonthSnapshot } from "../scripts/studio-ui/studio-apoios.ts";
import type { PendingPromise } from "../scripts/lib/apoio-promise-store.ts";
import { RateLimiter, ApoiaSeAuthError } from "../scripts/lib/apoia-se.ts";

const TEST_APOIA_ENV = { apiKey: "test-key", apiSecret: "test-secret", campaign: "diaria" };
// Limiter "rápido" — evita o throttle real de 200ms/chamada do singleton
// default do módulo apoia-se (mesmo padrão de `test/apoia-se.test.ts`).
const fastPromiseLimiter = new RateLimiter({ maxPerSecond: 1000 });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function pendingPromise(overrides: Partial<PendingPromise> = {}): PendingPromise {
  return {
    name: "Fabiana",
    email: "fabiana@example.com",
    value: 50,
    receivedAtIso: "2026-08-02T21:45:00.000Z",
    ...overrides,
  };
}

/** Mês corrente fixo usado por default nos testes que não exercitam carência
 * (sem histórico — `pastSnapshots: []`) — qualquer YYYY-MM serve, só precisa
 * ser um formato válido pra `previousMonthKey` não lançar. */
const NO_HISTORY_MONTH = "2026-08";

function contact(
  id: string,
  emails: string[],
  status: ContactWithStatus["status"],
): ContactWithStatus {
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

function sub(subscriptionId: string, email: string, apoioNivel = ""): BeehiivSubscriptionSnapshot {
  return { subscriptionId, email, apoioNivel };
}

/** Fixture de snapshot de mês passado — `paid` mapeia email → valor pago
 * naquele mês (`isPaidThisMonth: true`); emails ausentes de `paid` não
 * aparecem no snapshot (equivalente a "não encontrado"). */
function monthSnapshot(month: string, paid: Record<string, number>): MonthSnapshot {
  const statuses: MonthSnapshot["statuses"] = {};
  for (const [email, value] of Object.entries(paid)) {
    statuses[email] = { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: value };
  }
  return { month, statuses };
}

describe("computeDesiredApoioLevels (#4273) — sem histórico (pastSnapshots: [])", () => {
  it("apoiando + monthlyValue → nível derivado de computeRewardGroup", () => {
    const result = computeDesiredApoioLevels(
      [contact("c1", ["mantenedor@x.com"], { label: "apoiando", monthlyValue: 30, matchedEmail: "mantenedor@x.com" })],
      [],
      NO_HISTORY_MONTH,
    );
    assert.equal(result[0].level, "mantenedor");
    assert.equal(result[0].unresolved, false);
  });

  it("nao_apoia sem histórico → level null, unresolved false (removal candidate, não desconhecido)", () => {
    const result = computeDesiredApoioLevels([contact("c1", ["x@x.com"], { label: "nao_apoia" })], [], NO_HISTORY_MONTH);
    assert.equal(result[0].level, null);
    assert.equal(result[0].unresolved, false);
  });

  it("apoiou_e_parou sem histórico recente → level null, unresolved false", () => {
    const result = computeDesiredApoioLevels(
      [contact("c1", ["x@x.com"], { label: "apoiou_e_parou", lastPaidMonth: "2026-05", matchedEmail: "x@x.com" })],
      [],
      NO_HISTORY_MONTH,
    );
    assert.equal(result[0].level, null);
    assert.equal(result[0].unresolved, false);
  });

  it("sem_dados → level null, unresolved TRUE (desconhecido, não 'sem apoio')", () => {
    const result = computeDesiredApoioLevels([contact("c1", ["x@x.com"], { label: "sem_dados" })], [], NO_HISTORY_MONTH);
    assert.equal(result[0].level, null);
    assert.equal(result[0].unresolved, true);
  });

  it("emails normalizados (lowercase/trim/dedup)", () => {
    const result = computeDesiredApoioLevels(
      [contact("c1", [" Foo@X.com ", "foo@x.com", "bar@X.COM"], { label: "nao_apoia" })],
      [],
      NO_HISTORY_MONTH,
    );
    assert.deepEqual(result[0].emails, ["foo@x.com", "bar@x.com"]);
  });
});

// ── carência de 1 mês (#4436) ────────────────────────────────────────────

describe("previousMonthKey (#4436)", () => {
  it("mês normal: 2026-08 → 2026-07", () => {
    assert.equal(previousMonthKey("2026-08"), "2026-07");
  });

  it("virada de ano: 2026-01 → 2025-12", () => {
    assert.equal(previousMonthKey("2026-01"), "2025-12");
  });

  it("formato inesperado → lança (nunca produz mês inválido silenciosamente)", () => {
    assert.throws(() => previousMonthKey("2026/01"));
    assert.throws(() => previousMonthKey("agosto-2026"));
  });
});

describe("maxLevel (#4436)", () => {
  it("faixa maior vence, em qualquer ordem dos argumentos", () => {
    assert.equal(maxLevel("apoiador", "mantenedor"), "mantenedor");
    assert.equal(maxLevel("mantenedor", "apoiador"), "mantenedor");
  });

  it("null perde pra qualquer faixa real", () => {
    assert.equal(maxLevel(null, "amigo"), "amigo");
    assert.equal(maxLevel("amigo", null), "amigo");
  });

  it("null e null → null", () => {
    assert.equal(maxLevel(null, null), null);
  });

  it("mesma faixa → a própria faixa", () => {
    assert.equal(maxLevel("patrono", "patrono"), "patrono");
  });
});

describe("levelFromSnapshot (#4436)", () => {
  it("snapshot ausente (mês sem cache) → null", () => {
    assert.equal(levelFromSnapshot(["x@x.com"], undefined), null);
  });

  it("nenhum email do contato pagou naquele mês → null", () => {
    const snap = monthSnapshot("2026-07", { "outro@x.com": 20 });
    assert.equal(levelFromSnapshot(["x@x.com"], snap), null);
  });

  it("qualquer um dos e-mails do contato pagando → nível derivado (múltiplos e-mails)", () => {
    const snap = monthSnapshot("2026-07", { "secundario@x.com": 30 });
    assert.equal(levelFromSnapshot(["principal@x.com", "secundario@x.com"], snap), "mantenedor");
  });
});

describe("computeDesiredApoioLevels — carência de 1 mês (#4436, corpo da issue)", () => {
  it("caso 6: pagou em julho (apoiador), não pagou em agosto → MANTÉM apoiador (carência)", () => {
    const pastSnapshots = [monthSnapshot("2026-07", { "x@x.com": 15 })];
    const result = computeDesiredApoioLevels(
      [contact("c1", ["x@x.com"], { label: "nao_apoia" })],
      pastSnapshots,
      "2026-08",
    );
    assert.equal(result[0].level, "apoiador");
    assert.equal(result[0].unresolved, false);
  });

  it("caso 7: não pagou em julho NEM em agosto → remove (carência esgotada)", () => {
    const pastSnapshots = [monthSnapshot("2026-07", {})];
    const result = computeDesiredApoioLevels(
      [contact("c1", ["x@x.com"], { label: "nao_apoia" })],
      pastSnapshots,
      "2026-08",
    );
    assert.equal(result[0].level, null);
  });

  it("caso 7b: pagou em junho mas NÃO em julho (mês imediatamente anterior) → remove — carência é só 1 mês, não 'algum dia no passado'", () => {
    const pastSnapshots = [monthSnapshot("2026-07", {}), monthSnapshot("2026-06", { "x@x.com": 15 })];
    const result = computeDesiredApoioLevels(
      [contact("c1", ["x@x.com"], { label: "nao_apoia" })],
      pastSnapshots,
      "2026-08",
    );
    assert.equal(result[0].level, null);
  });

  it("caso 8: troca de faixa — pagou apoiador em julho, paga mantenedor (maior) em agosto → nível do mês corrente vence (maior)", () => {
    const pastSnapshots = [monthSnapshot("2026-07", { "x@x.com": 15 })];
    const result = computeDesiredApoioLevels(
      [contact("c1", ["x@x.com"], { label: "apoiando", monthlyValue: 30, matchedEmail: "x@x.com" })],
      pastSnapshots,
      "2026-08",
    );
    assert.equal(result[0].level, "mantenedor");
  });

  it("caso 8b: pagou mantenedor em julho, paga só apoiador (menor) em agosto → carência preserva a MAIOR faixa (mantenedor)", () => {
    const pastSnapshots = [monthSnapshot("2026-07", { "x@x.com": 30 })];
    const result = computeDesiredApoioLevels(
      [contact("c1", ["x@x.com"], { label: "apoiando", monthlyValue: 15, matchedEmail: "x@x.com" })],
      pastSnapshots,
      "2026-08",
    );
    assert.equal(result[0].level, "mantenedor");
  });

  it("caso 9: múltiplos e-mails — pagou em julho com o e-mail SECUNDÁRIO → carência casa mesmo assim", () => {
    const pastSnapshots = [monthSnapshot("2026-07", { "secundario@x.com": 8 })];
    const result = computeDesiredApoioLevels(
      [contact("c1", ["principal@x.com", "secundario@x.com"], { label: "nao_apoia" })],
      pastSnapshots,
      "2026-08",
    );
    assert.equal(result[0].level, "amigo");
  });

  it("caso 10: sem_dados nunca usa carência — nível fica null/unresolved mesmo com pagamento em julho", () => {
    const pastSnapshots = [monthSnapshot("2026-07", { "x@x.com": 30 })];
    const result = computeDesiredApoioLevels(
      [contact("c1", ["x@x.com"], { label: "sem_dados" })],
      pastSnapshots,
      "2026-08",
    );
    assert.equal(result[0].level, null);
    assert.equal(result[0].unresolved, true);
  });

  it("virada de ano: pagou em dezembro/2025, não paga em janeiro/2026 → mantém (previousMonthKey cobre o rollover)", () => {
    const pastSnapshots = [monthSnapshot("2025-12", { "x@x.com": 50 })];
    const result = computeDesiredApoioLevels(
      [contact("c1", ["x@x.com"], { label: "nao_apoia" })],
      pastSnapshots,
      "2026-01",
    );
    assert.equal(result[0].level, "patrono");
  });
});

describe("diffApoioTags — caso 1: contato com múltiplos e-mails (#4273)", () => {
  it("gera 1 entrada de diff por e-mail casado na Beehiiv", () => {
    const desired = computeDesiredApoioLevels(
      [
        contact("c1", ["principal@x.com", "secundario@x.com"], {
          label: "apoiando",
          monthlyValue: 15,
          matchedEmail: "principal@x.com",
        }),
      ],
      [],
      NO_HISTORY_MONTH,
    );
    const current: BeehiivSubscriptionSnapshot[] = [
      sub("sub-1", "principal@x.com", ""),
      sub("sub-2", "secundario@x.com", ""),
    ];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toApply.length, 2);
    assert.deepEqual(
      diff.toApply.map((e) => e.email).sort(),
      ["principal@x.com", "secundario@x.com"],
    );
    for (const e of diff.toApply) assert.equal(e.toLevel, "apoiador");
  });

  it("só o e-mail que TEM subscription Beehiiv gera diff — o outro fica de fora, sem erro", () => {
    const desired = computeDesiredApoioLevels(
      [
        contact("c1", ["principal@x.com", "naobeehiiv@x.com"], {
          label: "apoiando",
          monthlyValue: 15,
          matchedEmail: "principal@x.com",
        }),
      ],
      [],
      NO_HISTORY_MONTH,
    );
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "principal@x.com", "")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toApply.length, 1);
    assert.equal(diff.toApply[0].email, "principal@x.com");
    assert.equal(diff.notBeehiivSubscriber.length, 0); // pelo menos 1 email casou — não conta como "não assinante"
  });
});

describe("diffApoioTags — caso 2: contato sem_dados nunca gera remoção (#4273)", () => {
  it("contato sem_dados TAGGEADO na Beehiiv → nenhuma ação, vai pra skippedUnresolved", () => {
    const desired = computeDesiredApoioLevels([contact("c1", ["semdados@x.com"], { label: "sem_dados" })], [], NO_HISTORY_MONTH);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "semdados@x.com", "apoiador")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.toApply.length, 0);
    assert.equal(diff.skippedUnresolved.length, 1);
    assert.equal(diff.skippedUnresolved[0].contactId, "c1");
  });

  it("shouldBlockRemovals: true quando há sem_dados, mesmo sem allowPartial", () => {
    const desired = computeDesiredApoioLevels(
      [
        contact("ok", ["ok@x.com"], { label: "nao_apoia" }),
        contact("semdados", ["semdados@x.com"], { label: "sem_dados" }),
      ],
      [],
      NO_HISTORY_MONTH,
    );
    const current: BeehiivSubscriptionSnapshot[] = [
      sub("sub-1", "ok@x.com", "apoiador"),
      sub("sub-2", "semdados@x.com", "mantenedor"),
    ];
    const diff = diffApoioTags(desired, current);
    assert.equal(shouldBlockRemovals(null, diff, false), true);
    assert.equal(shouldBlockRemovals(null, diff, true), false); // --allow-partial força
  });

  it("shouldBlockRemovals: true quando data.error setado, mesmo sem sem_dados algum", () => {
    const desired = computeDesiredApoioLevels([contact("c1", ["x@x.com"], { label: "nao_apoia" })], [], NO_HISTORY_MONTH);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "x@x.com", "amigo")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.skippedUnresolved.length, 0);
    assert.equal(shouldBlockRemovals("apoia.se: 401", diff, false), true);
  });

  it("shouldBlockRemovals: false quando tudo resolvido e sem erro", () => {
    const desired = computeDesiredApoioLevels([contact("c1", ["x@x.com"], { label: "nao_apoia" })], [], NO_HISTORY_MONTH);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "x@x.com", "amigo")];
    const diff = diffApoioTags(desired, current);
    assert.equal(shouldBlockRemovals(null, diff, false), false);
  });
});

describe("diffApoioTags — caso 3: mudança de faixa (troca, nunca acumula) (#4273)", () => {
  it("apoiador → mantenedor: 1 entrada toApply com from/to corretos, nunca 2 valores simultâneos", () => {
    const desired = computeDesiredApoioLevels(
      [contact("c1", ["sobe@x.com"], { label: "apoiando", monthlyValue: 30, matchedEmail: "sobe@x.com" })],
      [],
      NO_HISTORY_MONTH,
    );
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "sobe@x.com", "apoiador")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toApply.length, 1);
    assert.equal(diff.toApply[0].fromLevel, "apoiador");
    assert.equal(diff.toApply[0].toLevel, "mantenedor");
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.unchanged.length, 0);
  });

  it("mesma faixa (sem mudança) → unchanged, nenhuma ação", () => {
    const desired = computeDesiredApoioLevels(
      [contact("c1", ["estavel@x.com"], { label: "apoiando", monthlyValue: 12, matchedEmail: "estavel@x.com" })],
      [],
      NO_HISTORY_MONTH,
    );
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "estavel@x.com", "apoiador")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toApply.length, 0);
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.unchanged.length, 1);
  });

  it("idempotência: rodar o diff 2x sobre o MESMO estado atual produz o mesmo resultado", () => {
    const desired = computeDesiredApoioLevels(
      [contact("c1", ["x@x.com"], { label: "apoiando", monthlyValue: 60, matchedEmail: "x@x.com" })],
      [],
      NO_HISTORY_MONTH,
    );
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "x@x.com", "")];
    const diff1 = diffApoioTags(desired, current);
    const diff2 = diffApoioTags(desired, current);
    assert.deepEqual(diff1.toApply, diff2.toApply);
    // Simula o estado PÓS-push (convergido) — 2ª rodada não reaplica nada.
    const converged: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "x@x.com", "patrono")];
    const diff3 = diffApoioTags(desired, converged);
    assert.equal(diff3.toApply.length, 0);
    assert.equal(diff3.toRemove.length, 0);
    assert.equal(diff3.unchanged.length, 1);
  });
});

describe("diffApoioTags — caso 4: assinante taggeado que parou de apoiar (#4273)", () => {
  it("tinha valor 'patrono', agora nao_apoia (sem histórico) → toRemove", () => {
    const desired = computeDesiredApoioLevels([contact("c1", ["parou@x.com"], { label: "nao_apoia" })], [], NO_HISTORY_MONTH);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "parou@x.com", "patrono")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toRemove.length, 1);
    assert.equal(diff.toRemove[0].fromLevel, "patrono");
    assert.equal(diff.toRemove[0].toLevel, null);
    assert.equal(diff.toApply.length, 0);
  });

  it("apoiou_e_parou (histórico antigo, fora da carência) também gera toRemove se ainda tem valor na Beehiiv", () => {
    const desired = computeDesiredApoioLevels(
      [contact("c1", ["exapoiador@x.com"], { label: "apoiou_e_parou", lastPaidMonth: "2026-03", matchedEmail: "exapoiador@x.com" })],
      [],
      NO_HISTORY_MONTH,
    );
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "exapoiador@x.com", "amigo")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toRemove.length, 1);
    assert.equal(diff.toRemove[0].fromLevel, "amigo");
  });

  it("já sem valor + não apoia → unchanged (nada a remover)", () => {
    const desired = computeDesiredApoioLevels([contact("c1", ["semvalor@x.com"], { label: "nao_apoia" })], [], NO_HISTORY_MONTH);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "semvalor@x.com", "")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.toRemove.length, 0);
    assert.equal(diff.unchanged.length, 1);
  });
});

describe("diffApoioTags — caso 5: apoiador que não é assinante da Beehiiv (#4273)", () => {
  it("nenhum e-mail do contato casa com nenhuma subscription → notBeehiivSubscriber, sem erro", () => {
    const desired = computeDesiredApoioLevels(
      [contact("c1", ["naotemconta@x.com"], { label: "apoiando", monthlyValue: 20, matchedEmail: "naotemconta@x.com" })],
      [],
      NO_HISTORY_MONTH,
    );
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "outrapessoa@x.com", "")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.notBeehiivSubscriber.length, 1);
    assert.equal(diff.notBeehiivSubscriber[0].contactId, "c1");
    assert.equal(diff.toApply.length, 0);
    assert.equal(diff.toRemove.length, 0);
  });

  it("estado da Beehiiv vazio (nenhum assinante) → todos os desejados caem em notBeehiivSubscriber", () => {
    const desired = computeDesiredApoioLevels(
      [
        contact("c1", ["a@x.com"], { label: "apoiando", monthlyValue: 20, matchedEmail: "a@x.com" }),
        contact("c2", ["b@x.com"], { label: "nao_apoia" }),
      ],
      [],
      NO_HISTORY_MONTH,
    );
    const diff = diffApoioTags(desired, []);
    assert.equal(diff.notBeehiivSubscriber.length, 2);
    assert.equal(diff.toApply.length, 0);
    assert.equal(diff.toRemove.length, 0);
  });

  // #4490 causa 3: candidatos heurísticos quando não casa por e-mail exato.
  it("gera candidato heurístico (local-part normalizado) quando o e-mail Beehiiv difere só por pontuação", () => {
    const c = contact("murilo", ["murilo.sarno@online.uscs.edu.br"], {
      label: "apoiando",
      monthlyValue: 20,
      matchedEmail: "murilo.sarno@online.uscs.edu.br",
    });
    c.name = "Murilo";
    const desired = computeDesiredApoioLevels([c], [], NO_HISTORY_MONTH);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "murilosarno@gmail.com", "")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.notBeehiivSubscriber.length, 1);
    assert.equal(diff.notBeehiivSubscriber[0].candidates.length, 1);
    assert.equal(diff.notBeehiivSubscriber[0].candidates[0].email, "murilosarno@gmail.com");
    // Nunca vira ação automática — só reportado.
    assert.equal(diff.toApply.length, 0);
  });

  it("sem candidato heurístico algum → candidates: []", () => {
    const c = contact("zeca", ["zeca@x.com"], { label: "apoiando", monthlyValue: 20, matchedEmail: "zeca@x.com" });
    c.name = "Zeca";
    const desired = computeDesiredApoioLevels([c], [], NO_HISTORY_MONTH);
    const current: BeehiivSubscriptionSnapshot[] = [sub("sub-1", "completamentediferente@outro.com", "")];
    const diff = diffApoioTags(desired, current);
    assert.equal(diff.notBeehiivSubscriber.length, 1);
    assert.deepEqual(diff.notBeehiivSubscriber[0].candidates, []);
  });
});

describe("extractApoioNivelValue", () => {
  it("array ausente → ''", () => {
    assert.equal(extractApoioNivelValue(undefined), "");
  });

  it("campo apoio_nivel presente → valor", () => {
    assert.equal(
      extractApoioNivelValue([{ name: "apoio_nivel", value: "mantenedor" }, { name: "nps", value: 9 }]),
      "mantenedor",
    );
  });

  it("campo apoio_nivel ausente entre outros custom fields → ''", () => {
    assert.equal(extractApoioNivelValue([{ name: "setor", value: "tech" }]), "");
  });

  it("valor não-string (defensivo) → '' (nunca lança)", () => {
    assert.equal(extractApoioNivelValue([{ name: "apoio_nivel", value: 123 }]), "");
  });
});

describe("diffApoioTags — mistura completa (regressão de composição)", () => {
  it("cenário combinado: add, remove, change, sem_dados e não-assinante no mesmo diff", () => {
    const desired = computeDesiredApoioLevels(
      [
        contact("novo", ["novo@x.com"], { label: "apoiando", monthlyValue: 8, matchedEmail: "novo@x.com" }), // amigo, novo
        contact("parou", ["parou@x.com"], { label: "nao_apoia" }), // tinha valor, perde
        contact("sobe", ["sobe@x.com"], { label: "apoiando", monthlyValue: 60, matchedEmail: "sobe@x.com" }), // troca
        contact("semdados", ["semdados@x.com"], { label: "sem_dados" }), // skip
        contact("naobeehiiv", ["naobeehiiv@x.com"], { label: "apoiando", monthlyValue: 20, matchedEmail: "naobeehiiv@x.com" }), // sem subscription
      ],
      [],
      NO_HISTORY_MONTH,
    );
    const current: BeehiivSubscriptionSnapshot[] = [
      sub("s-novo", "novo@x.com", ""),
      sub("s-parou", "parou@x.com", "apoiador"),
      sub("s-sobe", "sobe@x.com", "apoiador"),
      sub("s-semdados", "semdados@x.com", "amigo"),
    ];
    const diff = diffApoioTags(desired, current);

    assert.equal(diff.toApply.length, 2); // novo (amigo) + sobe (mantenedor→patrono)
    assert.equal(diff.toRemove.length, 1); // parou
    assert.equal(diff.skippedUnresolved.length, 1); // semdados
    assert.equal(diff.notBeehiivSubscriber.length, 1); // naobeehiiv

    const novoEntry = diff.toApply.find((e) => e.email === "novo@x.com");
    assert.equal(novoEntry?.toLevel, "amigo");
    const sobeEntry = diff.toApply.find((e) => e.email === "sobe@x.com");
    assert.equal(sobeEntry?.fromLevel, "apoiador");
    assert.equal(sobeEntry?.toLevel, "patrono");
  });
});

// ── guard de blast radius (#4436) ────────────────────────────────────────

describe("evaluateBlastRadiusGuard (#4436)", () => {
  it("abaixo do limiar (20% de 10) → não bloqueia", () => {
    const current: BeehiivSubscriptionSnapshot[] = [
      sub("s1", "a@x.com", "amigo"),
      sub("s2", "b@x.com", "apoiador"),
      sub("s3", "c@x.com", "mantenedor"),
      sub("s4", "d@x.com", "patrono"),
      sub("s5", "e@x.com", "amigo"),
      sub("s6", "f@x.com", "amigo"),
      sub("s7", "g@x.com", "amigo"),
      sub("s8", "h@x.com", "amigo"),
      sub("s9", "i@x.com", "amigo"),
      sub("s10", "j@x.com", "amigo"),
    ];
    const guard = evaluateBlastRadiusGuard(2, current, false);
    assert.equal(guard.currentWithLevelCount, 10);
    assert.equal(guard.ratio, 0.2);
    assert.equal(guard.blocked, false);
  });

  it("no limiar EXATO (30% de 10 = 3) → NÃO bloqueia ('passar de' é estrito)", () => {
    const current: BeehiivSubscriptionSnapshot[] = Array.from({ length: 10 }, (_, i) =>
      sub(`s${i}`, `u${i}@x.com`, "amigo"),
    );
    const guard = evaluateBlastRadiusGuard(3, current, false);
    assert.equal(guard.ratio, 0.3);
    assert.equal(guard.blocked, false);
  });

  it("acima do limiar (40% de 10 = 4) → bloqueia", () => {
    const current: BeehiivSubscriptionSnapshot[] = Array.from({ length: 10 }, (_, i) =>
      sub(`s${i}`, `u${i}@x.com`, "amigo"),
    );
    const guard = evaluateBlastRadiusGuard(4, current, false);
    assert.equal(guard.ratio, 0.4);
    assert.equal(guard.blocked, true);
  });

  it("acima do limiar mas com force=true → não bloqueia (escape hatch explícito)", () => {
    const current: BeehiivSubscriptionSnapshot[] = Array.from({ length: 10 }, (_, i) =>
      sub(`s${i}`, `u${i}@x.com`, "amigo"),
    );
    const guard = evaluateBlastRadiusGuard(4, current, true);
    assert.equal(guard.blocked, false);
  });

  it("ninguém com nível hoje (denominador 0) → ratio 0, nunca bloqueia por divisão por zero", () => {
    const current: BeehiivSubscriptionSnapshot[] = [sub("s1", "a@x.com", "")];
    const guard = evaluateBlastRadiusGuard(0, current, false);
    assert.equal(guard.currentWithLevelCount, 0);
    assert.equal(guard.ratio, 0);
    assert.equal(guard.blocked, false);
  });
});

// ── applyApoioTagEntry (escrita + releitura, I/O mockado, #4307 achado 2) ──

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Mock sequencial de `typeof fetch`: a N-ésima chamada recebe a N-ésima
 * resposta da lista (a última se a lista acabar). Grava todas as chamadas
 * (`calls`) pra assert de método/body — nunca faz rede real. */
function mockFetchSeq(responses: Array<{ status: number; body?: unknown }>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      text: async () => (r.body !== undefined ? JSON.stringify(r.body) : ""),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function diffEntry(overrides: Partial<ApoioTagDiffEntry>): ApoioTagDiffEntry {
  return {
    contactId: "c1",
    contactName: "Fulano",
    email: "fulano@x.com",
    subscriptionId: "sub-1",
    fromLevel: null,
    toLevel: "amigo",
    ...overrides,
  };
}

function subscriptionBody(email: string, customFields: Array<{ name: string; value: unknown }>) {
  return { data: { id: "sub-1", email, status: "active", custom_fields: customFields } };
}

describe("applyApoioTagEntry (#4307 achado 2 — write+reread nunca testado)", () => {
  it("(a) PUT ok + GET confirma o valor esperado → resolve limpo", async () => {
    const entry = diffEntry({ email: "confirma@x.com", toLevel: "mantenedor" });
    const { fetchImpl, calls } = mockFetchSeq([
      { status: 200, body: { data: { id: "sub-1" } } },
      { status: 200, body: subscriptionBody("confirma@x.com", [{ name: "apoio_nivel", value: "mantenedor" }]) },
    ]);
    await assert.doesNotReject(applyApoioTagEntry(entry, "pub-1", "key", fetchImpl));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "PUT");
    assert.equal(calls[1].method, "GET");
  });

  it("(a.1) body do PUT — add/troca usa {name, value} (nunca delete)", async () => {
    const entry = diffEntry({ email: "add@x.com", fromLevel: null, toLevel: "amigo" });
    const { fetchImpl, calls } = mockFetchSeq([
      { status: 200, body: {} },
      { status: 200, body: subscriptionBody("add@x.com", [{ name: "apoio_nivel", value: "amigo" }]) },
    ]);
    await applyApoioTagEntry(entry, "pub-1", "key", fetchImpl);
    assert.deepEqual(calls[0].body, { custom_fields: [{ name: "apoio_nivel", value: "amigo" }] });
  });

  it("(e) remoção (toLevel null) — body usa {name, delete:true}, releitura confirma ausência", async () => {
    const entry = diffEntry({ email: "parou@x.com", fromLevel: "patrono", toLevel: null });
    const { fetchImpl, calls } = mockFetchSeq([
      { status: 200, body: {} },
      { status: 200, body: subscriptionBody("parou@x.com", []) },
    ]);
    await assert.doesNotReject(applyApoioTagEntry(entry, "pub-1", "key", fetchImpl));
    assert.deepEqual(calls[0].body, { custom_fields: [{ name: "apoio_nivel", delete: true }] });
  });

  it("(b) PUT retorna não-ok → lança erro com email e nível alvo na mensagem", async () => {
    const entry = diffEntry({ email: "putfalha@x.com", toLevel: "apoiador" });
    const { fetchImpl } = mockFetchSeq([{ status: 500 }]);
    await assert.rejects(applyApoioTagEntry(entry, "pub-1", "key", fetchImpl), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /putfalha@x\.com/);
      assert.match(err.message, /apoiador/);
      return true;
    });
  });

  it("(c) GET pós-escrita falha → lança erro DISTINTO (releitura, não PUT)", async () => {
    const entry = diffEntry({ email: "getfalha@x.com", toLevel: "mantenedor" });
    const { fetchImpl } = mockFetchSeq([
      { status: 200, body: {} }, // PUT ok
      { status: 500 }, // GET falha
    ]);
    await assert.rejects(applyApoioTagEntry(entry, "pub-1", "key", fetchImpl), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /releitura pós-escrita falhou/);
      return true;
    });
  });

  it("(d) GET ok mas valor relido ≠ esperado → lança erro com valor esperado E valor real", async () => {
    // Cenário exato documentado pela issue #4273 pra `tags`: PUT responde 200
    // mas a mutação não pegou — a releitura devolve o valor ANTIGO.
    const entry = diffEntry({ email: "diverge@x.com", fromLevel: "apoiador", toLevel: "patrono" });
    const { fetchImpl } = mockFetchSeq([
      { status: 200, body: {} },
      { status: 200, body: subscriptionBody("diverge@x.com", [{ name: "apoio_nivel", value: "apoiador" }]) },
    ]);
    await assert.rejects(applyApoioTagEntry(entry, "pub-1", "key", fetchImpl), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /"patrono"/); // esperado
      assert.match(err.message, /"apoiador"/); // encontrado
      assert.match(err.message, /NÃO confere/);
      return true;
    });
  });

  it("(d.1) remoção esperada mas releitura ainda mostra valor antigo → lança erro", async () => {
    const entry = diffEntry({ email: "removeFalha@x.com", fromLevel: "amigo", toLevel: null });
    const { fetchImpl } = mockFetchSeq([
      { status: 200, body: {} },
      { status: 200, body: subscriptionBody("removeFalha@x.com", [{ name: "apoio_nivel", value: "amigo" }]) },
    ]);
    await assert.rejects(applyApoioTagEntry(entry, "pub-1", "key", fetchImpl), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /NÃO confere/);
      return true;
    });
  });
});

// ── fetchCurrentBeehiivState (#4317 — fail-loud da paginação + reconciliação
// anti-truncamento, lógica já corrigida no commit 66a042bf/#4307 mas nunca
// exercitada diretamente por teste) ──

function pageBody(items: Array<{ id: string; email: string }>, totalResults?: number) {
  return {
    data: items.map((i) => ({ id: i.id, email: i.email, status: "active", custom_fields: [] })),
    total_results: totalResults,
  };
}

describe("fetchCurrentBeehiivState (#4317)", () => {
  it("página no meio da paginação retorna 403 (não-ok) → rejeita, nunca trata como fim-de-lista silencioso", async () => {
    // total_results=5 com só 2 itens na página 1 força uma 2ª página (hasMorePages:
    // collected(2) < totalResults(5) → true) — é nessa 2ª chamada que a API "cai".
    const { fetchImpl } = mockFetchSeq([
      { status: 200, body: pageBody([{ id: "sub-1", email: "a@x.com" }, { id: "sub-2", email: "b@x.com" }], 5) },
      { status: 403 },
    ]);
    await assert.rejects(fetchCurrentBeehiivState("pub-1", "key", fetchImpl), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /403/);
      assert.match(err.message, /página 2/);
      return true;
    });
  });

  it("total_results declarado (5) maior que o efetivamente coletado (página final vazia antes de bater o total) → rejeita, mensagem cita truncamento", async () => {
    const { fetchImpl } = mockFetchSeq([
      { status: 200, body: pageBody([{ id: "sub-1", email: "a@x.com" }, { id: "sub-2", email: "b@x.com" }], 5) },
      // Página seguinte vem VAZIA (gotLength=0 → hasMorePages para o loop) antes
      // de coletar os 5 anunciados — truncamento silencioso, exatamente o risco
      // de remoção fantasma que a reconciliação pós-loop existe pra barrar.
      { status: 200, body: pageBody([], 5) },
    ]);
    await assert.rejects(fetchCurrentBeehiivState("pub-1", "key", fetchImpl), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /truncad|terminou cedo/);
      assert.match(err.message, /2/); // coletado
      assert.match(err.message, /5/); // total declarado
      return true;
    });
  });

  it("caso feliz: paginação completa (total_results bate com coletado) → resolve com o snapshot esperado", async () => {
    const { fetchImpl } = mockFetchSeq([
      { status: 200, body: pageBody([{ id: "sub-1", email: "a@x.com" }, { id: "sub-2", email: "b@x.com" }], 2) },
    ]);
    const result = await fetchCurrentBeehiivState("pub-1", "key", fetchImpl);
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((r) => r.email).sort(),
      ["a@x.com", "b@x.com"],
    );
  });
});

// ── reconcilePendingPromises (#4490 causa 4) ─────────────────────────────
//
// Cenário motivador da issue: Fabiana prometeu R$50, o pagamento já estava
// confirmado na API minutos depois — sem reconciliação automática, ela nunca
// entraria no CRM. `checkBacker` é sempre exercitado com `fetchImpl` mockado
// e `cacheDir` isolado em tmpdir — nunca rede real.

describe("reconcilePendingPromises (#4490 causa 4)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "apoio-promise-reconcile-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("promessa que virou pagamento é promovida a contato e sai do store de pendentes", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 50 })) as unknown as typeof fetch;

    const result = await reconcilePendingPromises([], [pendingPromise()], {
      env: TEST_APOIA_ENV,
      cacheDir: tmpDir,
      fetchImpl,
      limiter: fastPromiseLimiter,
      now: new Date("2026-08-02T22:00:00Z"),
    });

    assert.equal(result.promoted.length, 1);
    assert.equal(result.promoted[0].email, "fabiana@example.com");
    assert.deepEqual(result.remainingPromises, []);
    assert.equal(result.contacts.length, 1);
    assert.equal(result.contacts[0].emails[0], "fabiana@example.com");
    assert.equal(result.contacts[0].name, "Fabiana");
    assert.match(result.contacts[0].notes, /apoia\.se/);
  });

  it("promessa ainda não confirmada permanece pendente (nenhum contato criado)", async () => {
    const fetchImpl = (async () => jsonResponse(200, { isBacker: true, isPaidThisMonth: false })) as unknown as typeof fetch;

    const result = await reconcilePendingPromises([], [pendingPromise()], {
      env: TEST_APOIA_ENV,
      cacheDir: tmpDir,
      fetchImpl,
      limiter: fastPromiseLimiter,
      now: new Date("2026-08-02T22:00:00Z"),
    });

    assert.deepEqual(result.promoted, []);
    assert.equal(result.remainingPromises.length, 1);
    assert.equal(result.remainingPromises[0].email, "fabiana@example.com");
    assert.deepEqual(result.contacts, []);
  });

  it("falha pontual (rede/API) mantém a promessa pendente pra próxima rodada, nunca a descarta", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const result = await reconcilePendingPromises([], [pendingPromise()], {
      env: TEST_APOIA_ENV,
      cacheDir: tmpDir,
      fetchImpl,
      limiter: fastPromiseLimiter,
      now: new Date("2026-08-02T22:00:00Z"),
    });

    assert.deepEqual(result.promoted, []);
    assert.equal(result.remainingPromises.length, 1);
  });

  it("achado crítico 2 (PR #4503): ApoiaSeAuthError PROPAGA (throw) em vez de manter a promessa pendente em silêncio", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "chave inválida" }), { status: 401 })) as unknown as typeof fetch;

    await assert.rejects(
      () =>
        reconcilePendingPromises([], [pendingPromise()], {
          env: TEST_APOIA_ENV,
          cacheDir: tmpDir,
          fetchImpl,
          limiter: fastPromiseLimiter,
          now: new Date("2026-08-02T22:00:00Z"),
        }),
      (e: unknown) => e instanceof ApoiaSeAuthError,
      "chave apoia.se rejeitada (401) deve propagar como ApoiaSeAuthError, nunca ser engolida",
    );
  });

  it("sempre usa forceRefresh (ignora qualquer cache HIT do mês corrente) — promessa recém-confirmada não fica presa num false cacheado", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      // 1ª chamada (fora da reconciliação, simulando um check anterior no
      // mesmo dia): ainda não tinha pago. 2ª chamada (dentro da
      // reconciliação, forceRefresh): já confirmou.
      return jsonResponse(200, { isBacker: true, isPaidThisMonth: calls > 1, ...(calls > 1 ? { thisMonthPaidValue: 50 } : {}) });
    }) as unknown as typeof fetch;
    const now = new Date("2026-08-02T22:00:00Z");

    // Popula o cache do mês corrente com um "false" ANTES da reconciliação
    // (ex: `buildApoiosData` já rodou nesta mesma invocação do script).
    const { checkBacker } = await import("../scripts/lib/apoia-se.ts");
    await checkBacker("fabiana@example.com", { env: TEST_APOIA_ENV, cacheDir: tmpDir, fetchImpl, now, limiter: fastPromiseLimiter });
    assert.equal(calls, 1);

    const result = await reconcilePendingPromises([], [pendingPromise()], {
      env: TEST_APOIA_ENV,
      cacheDir: tmpDir,
      fetchImpl,
      limiter: fastPromiseLimiter,
      now,
    });

    assert.equal(calls, 2, "reconciliação sempre força refresh, nunca confia no cache HIT do mês corrente");
    assert.equal(result.promoted.length, 1);
  });

  it("promessa não duplica contato já existente (dedup por e-mail, mesma disciplina de importNewApoiadoresFromGmail)", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 50 })) as unknown as typeof fetch;
    const existingContact = contact("existing", ["fabiana@example.com"], { label: "nao_apoia" });

    const result = await reconcilePendingPromises([existingContact], [pendingPromise()], {
      env: TEST_APOIA_ENV,
      cacheDir: tmpDir,
      fetchImpl,
      limiter: fastPromiseLimiter,
      now: new Date("2026-08-02T22:00:00Z"),
    });

    // Promovida (a promessa converteu) mas NÃO duplica o contato existente.
    assert.equal(result.promoted.length, 1);
    assert.equal(result.contacts.length, 1);
  });

  it("múltiplas promessas — mistura de confirmada/pendente/erro no mesmo lote", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("confirmada")) return jsonResponse(200, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 10 });
      if (u.includes("pendente")) return jsonResponse(200, { isBacker: true, isPaidThisMonth: false });
      return new Response("boom", { status: 500 }); // "erro@..."
    }) as unknown as typeof fetch;

    const promises = [
      pendingPromise({ email: "confirmada@x.com", name: "Confirmada" }),
      pendingPromise({ email: "pendente@x.com", name: "Pendente" }),
      pendingPromise({ email: "erro@x.com", name: "Erro" }),
    ];

    const result = await reconcilePendingPromises([], promises, {
      env: TEST_APOIA_ENV,
      cacheDir: tmpDir,
      fetchImpl,
      limiter: fastPromiseLimiter,
      now: new Date("2026-08-02T22:00:00Z"),
    });

    assert.deepEqual(result.promoted.map((p) => p.email).sort(), ["confirmada@x.com"]);
    assert.deepEqual(result.remainingPromises.map((p) => p.email).sort(), ["erro@x.com", "pendente@x.com"]);
    assert.equal(result.contacts.length, 1);
  });
});
