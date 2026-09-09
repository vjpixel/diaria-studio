/**
 * test/lib/kit-subscriber-state-transition-alarm.test.ts (#7660)
 *
 * Regressão do alarme de perda de assinante no Kit — transição `active` →
 * `complained`/`bounced`/`cancelled`/`inactive`, DESAPARECIMENTO da conta
 * (o 2º evento do caso de origem, que um diff só de estado não vê), e a
 * correlação com o histórico de envio de onboarding.
 *
 * A 1ª versão importava de `vitest`, dependência que este repo não usa (o
 * runner é `node:test`): quebrava `test`, `Typecheck ratchet` (TS2307) e
 * `Unused code check` (unlisted dependency) de uma vez só — a mesma causa
 * raiz da PR #7669, do mesmo lote. Convertido, e os literais passaram a
 * respeitar os tipos reais (`KitSubscriberSummary` tem `email_address`;
 * `KitStateTransition` tem `address` — a versão anterior usava
 * `email_address` nos dois e escondia a divergência com `as any`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectKitStateTransitions,
  detectKitDisappearances,
  toStateTransitionAlarmFindings,
  toDisappearanceAlarmFindings,
  onboardingCorrelationLines,
  shouldAlarmKitStateTransition,
  shouldAlarmKitDisappearance,
  advanceKitStateTransitionAlarmState,
  emptyKitStateTransitionAlarmState,
  KIT_STATE_TRANSITION_ALARM_STATES,
  type KitLossOnboardingContext,
  type KitStateTransitionSnapshotEntry,
} from "../../scripts/lib/kit-subscriber-state-transition-alarm.ts";
import type { KitSubscriberSummary } from "../../scripts/lib/kit-subscribers.ts";

const NOW = new Date("2026-09-08T12:00:00Z");

const PREV: KitStateTransitionSnapshotEntry[] = [
  { id: 1, state: "active" },
  { id: 2, state: "active" },
  { id: 3, state: "bounced" },
];

function sub(id: number, state: string, fields: Record<string, string> = {}): KitSubscriberSummary {
  return { id, email_address: `s${id}@x.com`, state, created_at: "2026-01-01T00:00:00Z", fields };
}

describe("detectKitStateTransitions (#7660)", () => {
  it("detecta active → complained", () => {
    const res = detectKitStateTransitions(PREV, [sub(1, "complained")], NOW);
    assert.equal(res.length, 1);
    assert.equal(res[0].toState, "complained");
    assert.equal(res[0].fromState, "active");
    assert.equal(res[0].address, "s1@x.com");
  });

  it("bounced incluído por default — premissa registrada do #7660", () => {
    assert.ok(KIT_STATE_TRANSITION_ALARM_STATES.includes("bounced"));
    assert.equal(detectKitStateTransitions(PREV, [sub(2, "bounced")], NOW).length, 1);
  });

  it("active → active não é transição", () => {
    assert.equal(detectKitStateTransitions(PREV, [sub(1, "active")], NOW).length, 0);
  });

  it("cadastro novo (sem entry no snapshot anterior) não conta — é assunto do DOI orphan guard", () => {
    assert.equal(detectKitStateTransitions(PREV, [sub(99, "complained")], NOW).length, 0);
  });

  it("quem JÁ estava num estado de alarme não realarma (só sai de `active`)", () => {
    assert.equal(detectKitStateTransitions(PREV, [sub(3, "bounced")], NOW).length, 0);
  });

  it("estado fora da lista de alarme (ex: `unconfirmed`) é ignorado", () => {
    assert.equal(detectKitStateTransitions(PREV, [sub(1, "unconfirmed")], NOW).length, 0);
  });

  it("apoioNivel vem do custom field do snapshot ATUAL", () => {
    const res = detectKitStateTransitions(PREV, [sub(1, "cancelled", { apoio_nivel: "mantenedor" })], NOW);
    assert.equal(res[0].apoioNivel, "mantenedor");
  });
});

describe("latch por assinante (#7660)", () => {
  it("1ª detecção alarma; depois do advance, a mesma não realarma", () => {
    const s = emptyKitStateTransitionAlarmState();
    const t = detectKitStateTransitions(PREV, [sub(1, "complained")], NOW);
    assert.equal(shouldAlarmKitStateTransition(s, t), true);
    const next = advanceKitStateTransitionAlarmState(s, t, [2, 3], NOW);
    assert.equal(shouldAlarmKitStateTransition(next, t), false);
    assert.deepEqual(next.alertedSubscriberIds, [1]);
    assert.equal(next.lastCheckedAt, NOW.toISOString());
  });

  it("assinante que voltou a `active` sai do latch — re-arma pra uma próxima transição", () => {
    const s = { alertedSubscriberIds: [1, 2], lastCheckedAt: "2026-09-07T00:00:00Z" };
    // id 1 aparece na lista de ativos → limpo do latch; id 2 não → permanece.
    const next = advanceKitStateTransitionAlarmState(s, [], [1], NOW);
    assert.deepEqual(next.alertedSubscriberIds, [2]);
  });

  it("transição já alertada não realarma enquanto o assinante não voltar a active", () => {
    const s = { alertedSubscriberIds: [1], lastCheckedAt: "2026-09-07T00:00:00Z" };
    const t = detectKitStateTransitions([{ id: 1, state: "active" }], [sub(1, "complained")], NOW);
    assert.equal(shouldAlarmKitStateTransition(s, t), false);
  });
});

describe("toStateTransitionAlarmFindings (#7660)", () => {
  it("apoiador aparece no título, e a finding é P1/evento (nunca fecha sozinha)", () => {
    const [f] = toStateTransitionAlarmFindings([
      {
        id: 4264399626,
        address: "pedro@x.com",
        fromState: "active",
        toState: "complained",
        detectedAt: NOW.toISOString(),
        apoioNivel: "apoiador",
      },
    ]);
    assert.match(f.title, /apoiador/);
    assert.equal(f.priority, "P1");
    assert.equal(f.family, "evento");
    assert.match(f.body, /form de DOI/);
    // O playbook precisa carregar a ARMADILHA, não só o caminho feliz: o
    // recadastro dispara o e-mail 1 de boas-vindas pra quem lê há meses.
    assert.match(f.body, /onboarding-welcome-run\.ts/);
    assert.match(f.body, /--seed-email1-sent-at/);
  });

  it("sem apoio_nivel o título diz 'assinante', não 'apoiador'", () => {
    const [f] = toStateTransitionAlarmFindings([
      { id: 7, address: "x@x.com", fromState: "active", toState: "bounced", detectedAt: NOW.toISOString() },
    ]);
    assert.match(f.title, /assinante/);
    assert.doesNotMatch(f.title, /apoiador/);
  });

  it("fingerprint é por assinante — dois assinantes distintos nunca colapsam numa issue só", () => {
    const fs = toStateTransitionAlarmFindings([
      { id: 1, address: "a@x.com", fromState: "active", toState: "bounced", detectedAt: NOW.toISOString() },
      { id: 2, address: "b@x.com", fromState: "active", toState: "bounced", detectedAt: NOW.toISOString() },
    ]);
    assert.equal(new Set(fs.map((f) => f.fingerprint)).size, 2);
  });
});

describe("detectKitDisappearances (#7660, 3º comentário)", () => {
  it("assinante presente no anterior e ausente no atual é detectado", () => {
    const prev: KitStateTransitionSnapshotEntry[] = [
      { id: 1, state: "active", address: "s1@x.com" },
      { id: 2, state: "active", address: "s2@x.com" },
    ];
    const res = detectKitDisappearances(prev, [sub(2, "active")], NOW);
    assert.equal(res.length, 1);
    assert.equal(res[0].id, 1);
    assert.equal(res[0].address, "s1@x.com");
    assert.equal(res[0].lastState, "active");
  });

  it("NÃO exige estado anterior `active` — o caso real sumiu estando `complained`", () => {
    const prev: KitStateTransitionSnapshotEntry[] = [
      { id: 4264399626, state: "complained", address: "pedro@x.com", apoioNivel: "apoiador" },
    ];
    const res = detectKitDisappearances(prev, [], NOW);
    assert.equal(res.length, 1);
    assert.equal(res[0].lastState, "complained");
    assert.equal(res[0].apoioNivel, "apoiador");
  });

  it("snapshot anterior sem `address` (pré-follow-up) ainda emite, com address null", () => {
    const res = detectKitDisappearances([{ id: 9, state: "active" }], [], NOW);
    assert.equal(res[0].address, null);
    const [f] = toDisappearanceAlarmFindings(res);
    assert.match(f.title, /id 9/);
    assert.match(f.body, /só o id é conhecido/);
  });

  it("ninguém some quando todos continuam presentes", () => {
    const prev: KitStateTransitionSnapshotEntry[] = [{ id: 1, state: "active", address: "s1@x.com" }];
    assert.equal(detectKitDisappearances(prev, [sub(1, "complained")], NOW).length, 0);
  });

  it("fingerprint de desaparecimento NÃO colide com o de transição do mesmo id", () => {
    const [transicao] = toStateTransitionAlarmFindings([
      { id: 42, address: "a@x.com", fromState: "active", toState: "complained", detectedAt: NOW.toISOString() },
    ]);
    const [sumico] = toDisappearanceAlarmFindings([
      { id: 42, address: "a@x.com", lastState: "complained", detectedAt: NOW.toISOString() },
    ]);
    assert.notEqual(
      transicao.fingerprint,
      sumico.fingerprint,
      "o assinante do caso passou pelos DOIS eventos — colidir deduplicaria o segundo",
    );
    assert.equal(sumico.family, "evento");
    assert.equal(sumico.priority, "P1");
  });
});

describe("latch de desaparecimento (#7660)", () => {
  it("alarma na 1ª vez; depois do advance, não realarma", () => {
    const d = [{ id: 1, address: "a@x.com", lastState: "active", detectedAt: NOW.toISOString() }];
    const s = emptyKitStateTransitionAlarmState();
    assert.equal(shouldAlarmKitDisappearance(s, d), true);
    const next = advanceKitStateTransitionAlarmState(s, [], [], NOW, d);
    assert.equal(shouldAlarmKitDisappearance(next, d), false);
    assert.deepEqual(next.alertedDisappearedIds, [1]);
  });

  it("latch antigo sem o campo novo é lido como vazio, não como corrupção", () => {
    const antigo = { alertedSubscriberIds: [7], lastCheckedAt: "2026-09-07T00:00:00Z" };
    const d = [{ id: 7, address: "a@x.com", lastState: "complained", detectedAt: NOW.toISOString() }];
    // id 7 já alertado por TRANSIÇÃO, mas nunca por desaparecimento.
    assert.equal(shouldAlarmKitDisappearance(antigo, d), true);
  });

  it("o latch de transição não é contaminado pelo de desaparecimento", () => {
    const s = emptyKitStateTransitionAlarmState();
    const d = [{ id: 5, address: "a@x.com", lastState: "active", detectedAt: NOW.toISOString() }];
    const next = advanceKitStateTransitionAlarmState(s, [], [], NOW, d);
    assert.deepEqual(next.alertedSubscriberIds, []);
  });
});

describe("onboardingCorrelationLines (#7660, 1º comentário)", () => {
  const detectado = "2026-08-29T14:00:00Z";

  it("envio recente de boas-vindas vira CORRELAÇÃO destacada com o intervalo em dias", () => {
    const ctx: KitLossOnboardingContext = { email1SentAt: "2026-08-24T12:05:25.000Z" };
    const linhas = onboardingCorrelationLines(ctx, detectado).join("\n");
    assert.match(linhas, /CORRELAÇÃO/);
    assert.match(linhas, /5 dia\(s\) antes/);
    assert.match(linhas, /#6043/);
  });

  it("envio antigo é histórico, não correlação destacada", () => {
    const ctx: KitLossOnboardingContext = { email1SentAt: "2026-01-01T00:00:00Z" };
    const linhas = onboardingCorrelationLines(ctx, detectado).join("\n");
    assert.doesNotMatch(linhas, /CORRELAÇÃO/);
    assert.match(linhas, /Correlação de envio/);
  });

  it("sem contexto diz explicitamente que não há registro — nunca silêncio", () => {
    const linhas = onboardingCorrelationLines(undefined, detectado).join("\n");
    assert.match(linhas, /nenhum registro/i);
  });

  it("a correlação entra no corpo da issue quando o endereço bate (case-insensitive)", () => {
    const correl = new Map<string, KitLossOnboardingContext>([
      ["pedro@x.com", { email1SentAt: "2026-08-24T12:05:25.000Z", seededBy: "#7660" }],
    ]);
    const [f] = toStateTransitionAlarmFindings(
      [
        {
          id: 1,
          address: "Pedro@X.com",
          fromState: "active",
          toState: "complained",
          detectedAt: detectado,
        },
      ],
      correl,
    );
    assert.match(f.body, /CORRELAÇÃO/);
    assert.match(f.body, /#7660/);
  });
});
