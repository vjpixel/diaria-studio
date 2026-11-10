/**
 * test/onboarding-base-invite-draft-stale-12517.test.ts (#12517)
 *
 * O e-mail da base em `draft` (`followup.base_invite`) segura o D+6 de todos
 * os destinatários (`baseInviteRecipientIds`, contados como
 * `email_da_base_pendente`). A releitura devolvia `still_draft` com
 * `failed: false` e nada mais: quem confirmou depois de o rascunho ser
 * montado ficava com o D+6 suspenso, sem aviso, até vencer. Agora o rascunho
 * parado há `FOLLOWUP_BASE_INVITE_DRAFT_STALE_DAYS` dias com gente suspensa
 * marca `base_invite_draft_stale`, conta como rodada falha (alarme de
 * continuidade), sai com o exit 3 e o painel mostra o alerta.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  baseInviteDraftStale,
  baseInviteRecipientIds,
  FOLLOWUP_BASE_INVITE_DRAFT_STALE_DAYS,
  FOLLOWUP_CAP_WINDOW_OVERFLOW_EXIT_CODE,
  isFailedFollowupRun,
  planFollowup,
  recordFollowupRun,
  resolveFollowupConfig,
  resolveFollowupExitCode,
  type FollowupBaseInvite,
  type FollowupRunRecord,
} from "../scripts/lib/onboarding-followup.ts";
import { buildFollowupPanel } from "../scripts/lib/onboarding-followup-panel.ts";
import { emptyStore } from "../scripts/lib/onboarding-store.ts";
import { alertAction } from "../scripts/studio-ui/public/assinantes-actions.js";

const DAY = 86_400;
const T0 = Date.parse("2026-11-01T12:00:00Z") / 1000;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

const invite: FollowupBaseInvite = {
  lot_id: "form_base-x-01",
  tag_name: "t",
  tag_id: 1,
  broadcast_id: 9,
  recipient_subscription_ids: ["1", "2"],
  recipient_emails: ["p1@x.com", "p2@x.com"],
  status: "draft",
  created_at: iso(T0),
  send_at: null,
  confirmed_at: null,
  last_error: null,
};

function run(over: Partial<FollowupRunRecord> = {}): FollowupRunRecord {
  return { at: iso(T0), send: true, lots_failed: 0, over_cap: 0, lookups_failed: 0, counts: {}, ...over } as FollowupRunRecord;
}

describe("#12517 baseInviteDraftStale", () => {
  const stale = FOLLOWUP_BASE_INVITE_DRAFT_STALE_DAYS;

  it("rascunho parado há N dias com D+6 suspenso: acusa com idade e contagem", () => {
    assert.deepEqual(baseInviteDraftStale(invite, 1, (T0 + stale * DAY) * 1000), {
      lot_id: "form_base-x-01",
      broadcast_id: 9,
      days: stale,
      suspended: 1,
    });
  });

  it("rascunho novo (menos de N dias) não acusa", () => {
    assert.equal(baseInviteDraftStale(invite, 5, (T0 + stale * DAY - 1) * 1000), null);
  });

  it("ninguém suspenso nesta rodada não acusa, mesmo com o rascunho velho", () => {
    assert.equal(baseInviteDraftStale(invite, 0, (T0 + 30 * DAY) * 1000), null);
  });

  it("só 'draft' acusa: agendado vai sair, enviado/pendente não seguram", () => {
    const now = (T0 + 30 * DAY) * 1000;
    for (const status of ["scheduled", "sent", "sent_unverified", "pending", "divergent"] as const) {
      assert.equal(baseInviteDraftStale({ ...invite, status }, 3, now), null, status);
    }
    assert.equal(baseInviteDraftStale(null, 3, now), null);
    assert.equal(baseInviteDraftStale({ ...invite, created_at: "lixo" }, 3, now), null, "sem idade, sem prazo");
  });

  it("cenário da issue: quem confirmou depois do rascunho tem o D+6 devido e suspenso — o plano conta e o helper acusa", () => {
    const cfg = resolveFollowupConfig({ enabled: true });
    const nowSec = T0 + stale * DAY;
    // p1 confirmou depois de o rascunho ser montado: o D+6 vence hoje.
    const cands = [{ kit_subscriber_id: 1, email: "p1@x.com", anchorSec: nowSec - cfg.formFirstDays * DAY }];
    const plan = planFollowup({
      apoioCandidates: [],
      formCandidates: cands,
      people: {},
      nowSec,
      cfg,
      apoioBlocked: null,
      formBlocked: null,
      baseInviteRecipientIds: baseInviteRecipientIds(invite),
    });
    assert.equal(plan.due.length, 0, "D+6 segue suspenso enquanto o rascunho existe (comportamento #10605 intacto)");
    const suspended = plan.counts.form?.email_da_base_pendente ?? 0;
    assert.equal(suspended, 1);
    assert.equal(baseInviteDraftStale(invite, suspended, nowSec * 1000)?.suspended, 1);
  });
});

describe("#12517 rodada: alarme, exit 3 e painel", () => {
  it("conta como rodada falha e alimenta o contador de continuidade", () => {
    const r = run({ base_invite_draft_stale: 2 });
    assert.equal(isFailedFollowupRun(r), true);
    const block = { people: {}, lots: {}, consecutive_failed_runs: 0 };
    recordFollowupRun(block, r);
    assert.equal(block.consecutive_failed_runs, 1);
    assert.equal(isFailedFollowupRun(run({ base_invite_draft_stale: 0 })), false);
  });

  it("exit 3 quando é o único problema; falha de entrega ainda vence com 1", () => {
    assert.equal(resolveFollowupExitCode(run({ base_invite_draft_stale: 1 })), FOLLOWUP_CAP_WINDOW_OVERFLOW_EXIT_CODE);
    assert.equal(resolveFollowupExitCode(run({ base_invite_draft_stale: 1, lots_failed: 1 })), 1);
    assert.equal(resolveFollowupExitCode(run({ base_invite_draft_stale: 1, base_invite_failed: 1 })), 1);
    assert.equal(resolveFollowupExitCode(run()), 0);
  });

  it("painel mostra o alerta já na 1ª rodada, com ação própria", () => {
    const store = emptyStore();
    store.followup = { people: {}, lots: {}, base_invite: invite, last_run: run({ base_invite_draft_stale: 2 }), consecutive_failed_runs: 1 };
    const alert = buildFollowupPanel(store, {}).alerts.find((a) => a.kind === "base_invite_draft_stale");
    assert.ok(alert, "alerta presente");
    assert.match(alert!.mensagem, /broadcast 9/);
    assert.match(alert!.mensagem, /2 destinatário\(s\) com o D\+6 suspenso/);
    assert.match(alertAction(alert).acao, /Agendar o rascunho do e-mail da base/);

    store.followup.last_run = run();
    assert.equal(buildFollowupPanel(store, {}).alerts.some((a) => a.kind === "base_invite_draft_stale"), false);
  });
});
