/**
 * test/onboarding-state.test.ts (#5908)
 *
 * Regras de decisão do onboarding Brevo transacional — tudo PURA (mock de
 * rede zero). Cobre o que a #5908 exige como segurança:
 *
 *   - parseOnboardingSnippet: cabeçalho, marcador pendente, arquivo ausente.
 *   - assertSnippetSendable: pendente/sem assunto/sem corpo → throw.
 *   - classifyNewSubscribers: dedupe por store E dentro do mesmo lote.
 *   - dueForEmail2 / ageDays: D+3 exato e independência do email1.
 *   - email3Eligibility: D+10 + zero aberturas/cliques; stats ausentes
 *     NUNCA elegível (fail-safe).
 *   - buildRunPlan: o cenário-carro de segurança — snippet pendente ⇒ plano
 *     contém ZERO ações, mesmo com --send implícito; status ≠ active não
 *     recebe email1; cohort D+10 vira UMA campanha; skipped_opened grava
 *     decisão terminal.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseOnboardingSnippet,
  assertSnippetSendable,
  classifyNewSubscribers,
  dueForEmail2,
  ageDays,
  email3Eligibility,
  buildRunPlan,
  PENDING_BODY_MARKER,
  type OnboardingSnippet,
} from "../scripts/lib/onboarding-state.ts";
import type { OnboardingEntry, OnboardingStore } from "../scripts/lib/onboarding-store.ts";

const DAY = 86_400;
const T0 = 1_755_000_000; // epoch seg fixo — nada de Date.now() em teste

function entry(over: Partial<OnboardingEntry> = {}): OnboardingEntry {
  return {
    subscription_id: "sub-1",
    email: "novo@example.com",
    status_detectado: "active",
    created_at: T0,
    detected_at: new Date(T0 * 1000).toISOString(),
    email1_sent_at: null,
    email1_brevo_id: null,
    email2_sent_at: null,
    email2_brevo_id: null,
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
    ...over,
  };
}

function sendableSnippet(numero: 1 | 2 | 3): OnboardingSnippet {
  return { numero, assunto: `Assunto ${numero}`, previewText: "preview", body: "<p>corpo</p>", hasPendingMarker: false };
}

// ─── parseOnboardingSnippet ──────────────────────────────────────────────────

describe("parseOnboardingSnippet", () => {
  it("arquivo ausente (null) → null, nunca lança", () => {
    assert.equal(parseOnboardingSnippet(null, 1), null);
  });

  it("extrai assunto/preview do cabeçalho HTML-comment e corpo depois dele", () => {
    const raw = `<!--\nassunto: "Bem-vindo"\npreview_text: "oi"\n-->\n<p>corpo real</p>`;
    const s = parseOnboardingSnippet(raw, 1)!;
    assert.equal(s.assunto, "Bem-vindo");
    assert.equal(s.previewText, "oi");
    assert.equal(s.body, "<p>corpo real</p>");
    assert.equal(s.hasPendingMarker, false);
  });

  it("detecta o marcador ONBOARDING-CORPO-PENDENTE em qualquer lugar do arquivo", () => {
    const raw = `<!-- assunto: "" -->\n${PENDING_BODY_MARKER}`;
    const s = parseOnboardingSnippet(raw, 2)!;
    assert.equal(s.hasPendingMarker, true);
  });
});

// ─── assertSnippetSendable ───────────────────────────────────────────────────

describe("assertSnippetSendable", () => {
  it("snippet válido passa sem throw", () => {
    assert.doesNotThrow(() => assertSnippetSendable(sendableSnippet(1)));
  });

  it("marcador pendente → throw citando a automação origem (#5808)", () => {
    const s = sendableSnippet(1);
    s.hasPendingMarker = true;
    assert.throws(() => assertSnippetSendable(s), /aut_48bcae89|#5808|ONBOARDING-CORPO-PENDENTE/s);
  });

  it("sem assunto ou sem corpo → throw", () => {
    const semAssunto = sendableSnippet(1);
    semAssunto.assunto = null;
    assert.throws(() => assertSnippetSendable(semAssunto), /assunto/);
    const semCorpo = sendableSnippet(2);
    semCorpo.body = "";
    assert.throws(() => assertSnippetSendable(semCorpo), /corpo/);
  });
});

// ─── classifyNewSubscribers ──────────────────────────────────────────────────

describe("classifyNewSubscribers", () => {
  const sub = (id: string) => ({ id, email: `${id}@x.com`, status: "active", created: T0 });

  it("separa novos de conhecidos pelo store", () => {
    const r = classifyNewSubscribers([sub("a"), sub("b")], new Set(["a"]));
    assert.deepEqual(r.novos.map((s) => s.id), ["b"]);
    assert.equal(r.conhecidos, 1);
  });

  it("id repetido DENTRO do lote colapsa (paginação concorrente não gera 2 entradas)", () => {
    const r = classifyNewSubscribers([sub("a"), sub("a"), sub("b")], new Set());
    assert.deepEqual(r.novos.map((s) => s.id), ["a", "b"]);
    assert.equal(r.conhecidos, 1);
  });
});

// ─── dueForEmail2 / ageDays ──────────────────────────────────────────────────

describe("dueForEmail2 / ageDays", () => {
  it("D+3 exato vence; D+2 não", () => {
    const e = entry();
    assert.equal(dueForEmail2(e, T0 + 2 * DAY), false);
    assert.equal(dueForEmail2(e, T0 + 3 * DAY), true);
  });

  it("já enviado não vence de novo", () => {
    const e = entry({ email2_sent_at: new Date(T0 * 1000).toISOString() });
    assert.equal(dueForEmail2(e, T0 + 10 * DAY), false);
  });

  it("independe do email1 (falha de um toque não trava a escada)", () => {
    const e = entry(); // email1 nunca saiu
    assert.equal(dueForEmail2(e, T0 + 4 * DAY), true);
  });

  it("created_at null → nunca vence; ageDays null", () => {
    const e = entry({ created_at: null });
    assert.equal(dueForEmail2(e, T0 + 30 * DAY), false);
    assert.equal(ageDays(e, T0 + 30 * DAY), null);
  });
});

// ─── email3Eligibility ───────────────────────────────────────────────────────

describe("email3Eligibility", () => {
  it("D+10 com zero aberturas e cliques → elegível", () => {
    const e = entry();
    const d = email3Eligibility(e, { total_unique_opened: 0, total_clicked: 0 }, T0 + 10 * DAY);
    assert.deepEqual(d, { eligible: true });
  });

  it("abriu OU clicou → inelegível com reason abriu_ou_clicou", () => {
    const e = entry();
    const abriu = email3Eligibility(e, { total_unique_opened: 1, total_clicked: 0 }, T0 + 10 * DAY);
    assert.deepEqual(abriu, { eligible: false, reason: "abriu_ou_clicou" });
    const clicou = email3Eligibility(e, { total_unique_opened: 0, total_clicked: 2 }, T0 + 10 * DAY);
    assert.deepEqual(clicou, { eligible: false, reason: "abriu_ou_clicou" });
  });

  it("stats ausentes/parciais → NUNCA elegível (fail-safe)", () => {
    const e = entry();
    assert.equal(email3Eligibility(e, null, T0 + 30 * DAY).eligible, false);
    assert.equal(
      email3Eligibility(e, { total_unique_opened: 0 }, T0 + 30 * DAY).eligible,
      false,
    );
  });

  it("antes do D+10 e já decidido → reasons corretos", () => {
    const e = entry();
    assert.equal(email3Eligibility(e, { total_unique_opened: 0, total_clicked: 0 }, T0 + 9 * DAY).reason, "age<min");
    const decidido = entry({ email3_state: "skipped_opened" });
    assert.equal(email3Eligibility(decidido, null, T0 + 30 * DAY).reason, "ja_decidido");
  });
});

// ─── buildRunPlan ────────────────────────────────────────────────────────────

function planSnippets(pending: boolean) {
  const mk = (n: 1 | 2 | 3): OnboardingSnippet =>
    pending
      ? { numero: n, assunto: "", previewText: null, body: PENDING_BODY_MARKER, hasPendingMarker: true }
      : sendableSnippet(n);
  return { 1: mk(1), 2: mk(2), 3: mk(3) };
}

const PLAN_DEFAULTS = {
  nowSec: T0 + 11 * DAY, // passado do D+10 pra exercitar todas as etapas
  email2Days: 3,
  email3Days: 10,
  email3GraceDays: 7,
};

describe("buildRunPlan — cenário-carro de segurança (#5908)", () => {
  it("GUARD DURO: snippets pendentes ⇒ ZERO ações, só skips corpo_pendente", () => {
    const entries = [
      entry({ subscription_id: "novo" }), // detectado agora, active
      entry({ subscription_id: "d3", email1_sent_at: "x", created_at: T0 - 4 * DAY }),
      entry({ subscription_id: "d10", email1_sent_at: "x", email2_sent_at: "x", created_at: T0 - 12 * DAY }),
    ];
    const r = buildRunPlan({ entries, statsById: {}, ...PLAN_DEFAULTS, snippets: planSnippets(true) });
    assert.equal(r.actions.length, 0, "nenhuma ação pode existir com corpo pendente");
    const motivos = r.skips.map((s) => s.motivo);
    assert.ok(motivos.includes("corpo_pendente"));
  });

  it("plano completo com snippets ok: email1 novo + email2 D+3 + UMA campanha pro cohort D+10", () => {
    const entries = [
      entry({ subscription_id: "novo" }),
      entry({ subscription_id: "d3", email1_sent_at: "x", created_at: T0 - 4 * DAY }),
      entry({ subscription_id: "d10a", email1_sent_at: "x", email2_sent_at: "x", created_at: T0 - 12 * DAY }),
      entry({ subscription_id: "d10b", email1_sent_at: "x", email2_sent_at: "x", created_at: T0 - 13 * DAY }),
      entry({ subscription_id: "abriu", email1_sent_at: "x", email2_sent_at: "x", created_at: T0 - 12 * DAY, email3_state: "pending" }),
    ];
    const statsById: Record<string, { total_unique_opened: number; total_clicked: number }> = {
      d10a: { total_unique_opened: 0, total_clicked: 0 },
      d10b: { total_unique_opened: 0, total_clicked: 0 },
      abriu: { total_unique_opened: 3, total_clicked: 0 },
    };
    const r = buildRunPlan({ entries, statsById, ...PLAN_DEFAULTS, snippets: planSnippets(false) });

    const kinds = r.actions.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["email1", "email2", "email3_campaign"]);

    const camp = r.actions.find((a) => a.kind === "email3_campaign")!;
    if (camp.kind === "email3_campaign") {
      assert.deepEqual(camp.entries.map((e) => e.subscription_id).sort(), ["d10a", "d10b"]);
    }

    // quem abriu teve decisão terminal gravada in-place
    const abriu = entries.find((e) => e.subscription_id === "abriu")!;
    assert.equal(abriu.email3_state, "skipped_opened");
    assert.ok(abriu.email3_decided_at);
  });

  it("status ≠ active NUNCA recebe email1 nem email2 (skip status_nao_active)", () => {
    const entries = [
      entry({ subscription_id: "pendente", status_detectado: "pending" }),
      entry({ subscription_id: "d3-pending", email1_sent_at: "x", status_detectado: "pending", created_at: T0 - 9 * DAY }),
    ];
    const r = buildRunPlan({ entries, statsById: {}, ...PLAN_DEFAULTS, snippets: planSnippets(false) });
    assert.equal(r.actions.filter((a) => a.kind !== "email3_campaign").length, 0);
    assert.ok(r.skips.every((s) => s.motivo === "status_nao_active"));
  });

  it("stats ausentes pós-tolerância → skipped_sem_dados; dentro da tolerância fica pendente", () => {
    const fora = entry({
      subscription_id: "fora",
      email1_sent_at: "x",
      email2_sent_at: "x",
      created_at: T0 - (10 + 8) * DAY, // além do grace de 7
    });
    const dentro = entry({
      subscription_id: "dentro",
      email1_sent_at: "x",
      email2_sent_at: "x",
      created_at: T0 - 3 * DAY, // idade = 14d: passou do D+10, dentro do grace até D+17
    });
    const r = buildRunPlan({
      entries: [fora, dentro],
      statsById: {},
      nowSec: PLAN_DEFAULTS.nowSec,
      email2Days: 3,
      email3Days: 10,
      email3GraceDays: 7,
      snippets: planSnippets(false),
    });
    assert.equal(fora.email3_state, "skipped_sem_dados");
    assert.equal(dentro.email3_state, "pending");
    assert.ok(!r.actions.some((a) => a.kind === "email3_campaign" && campTem(a, "dentro")));
    function campTem(a: { kind: string; entries?: OnboardingEntry[] }, id: string): boolean {
      return a.kind === "email3_campaign" && (a.entries ?? []).some((e) => e.subscription_id === id);
    }
  });

  it("bootstrap implícito: store recém-criado não onboarda base antiga é responsabilidade do executor (cursor null), mas entries existentes no store são processadas normalmente", () => {
    // O executor trata cursor==null como bootstrap ANTES de chamar buildRunPlan;
    // aqui garante que buildRunPlan não tem caminho especial que ignore entries.
    const entries = [entry({ subscription_id: "qualquer" })];
    const r = buildRunPlan({ entries, statsById: {}, ...PLAN_DEFAULTS, snippets: planSnippets(false) });
    assert.ok(r.actions.length >= 1);
  });
});
