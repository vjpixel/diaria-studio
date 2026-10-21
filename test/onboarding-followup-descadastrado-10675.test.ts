/**
 * test/onboarding-followup-descadastrado-10675.test.ts (#10675)
 *
 * O lembrete do formulário (`form_lembrete`) não tem janela (decisão do editor
 * de 20/10/2026: a cada N dias até preencher). Quem descadastrava depois do
 * `form` continuava candidato: entrava em `due` todo dia, gastava um
 * `GET /subscribers/{id}`, caía em `nao_ativo` sem registro nenhum e voltava
 * no dia seguinte — e, por ter a âncora mais antiga, ficava com a vaga do teto
 * antes dos ativos. Agora `nao_ativo` vira pulo terminal gravado e encerra a
 * sequência do formulário para a pessoa (`formStepDue` → `saiu`), sem
 * ressuscitar. O lembrete segue sem teto de tempo para quem está ativo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterDueByLiveCheck,
  formStepDue,
  parseFollowupSnippet,
  recordLiveCheckSkips,
  resolveFollowupConfig,
  type FollowupPerson,
  type FollowupSnippets,
} from "../scripts/lib/onboarding-followup.ts";
import { runFollowupRound, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, readStore, writeStore, type OnboardingEntry } from "../scripts/lib/onboarding-store.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

const cfgBase = resolveFollowupConfig({ enabled: true, form_url: "https://form.example/", form_responses_url: "https://form.example/api/respostas" });

function okSnippet(): string {
  return `<!--\nassunto: "Assunto"\npreview_text: "Prev"\n-->\nCorpo {{FORM_URL}}`;
}

const snippets: FollowupSnippets = {
  apoio30: null,
  apoio90: null,
  apoio180: null,
  apoio360: null,
  form: parseFollowupSnippet(okSnippet()),
  form_lembrete: parseFollowupSnippet(okSnippet()),
};

function entry(id: number, anchorSec: number): OnboardingEntry {
  return {
    subscription_id: String(id), email: `${id}@x.com`, status_detectado: "active", created_at: anchorSec, detected_at: iso(anchorSec),
    email1_sent_at: iso(anchorSec), email1_brevo_id: null, email2_sent_at: null, email2_brevo_id: null,
    email3_state: "pending", email3_campaign_id: null, email3_decided_at: null,
  };
}

/** 3 pessoas que receberam o `form` em D+6; a id 1 (âncora mais antiga) descadastrou depois. */
function seededStore(): string {
  const p = join(mkdtempSync(join(tmpdir(), "followup-10675-")), "store.json");
  const store = emptyStore();
  const anchors = new Map([[1, T0 - 3600], [2, T0], [3, T0 + 60]]);
  store.followup = { people: {}, lots: {} };
  for (const [id, a] of anchors) {
    store.entries[String(id)] = entry(id, a);
    store.followup.people[String(id)] = {
      kit_subscriber_id: id, email: `${id}@x.com`, cadastro_at: null,
      sends: [{ step: "form", at: iso(T0 + 6 * DAY), lot_id: "form-2026-01-07-01" }],
    };
  }
  writeStore(store, p);
  return p;
}

function deps(
  inactive: ReadonlySet<number>,
  stateOf?: (id: number) => string | null,
): FollowupRoundDeps & { gets: number[]; lots: string[][] } {
  const gets: number[] = [];
  const lots: string[][] = [];
  let seq = 0;
  return {
    gets,
    lots,
    async listActiveSubscribers() {
      return [];
    },
    async getSubscriber(id) {
      gets.push(id);
      const state = stateOf ? stateOf(id) : inactive.has(id) ? "inactive" : "active";
      return { state, apoioNivel: "" };
    },
    async listEnvioBrevoEmails() {
      return [];
    },
    async setFormSig(_id: number, sig: string) {
      return { kind: "stored" as const, value: sig };
    },
    async probeFormLink() {
      return 200;
    },
    async fetchFormResponses() {
      return [];
    },
    async runLot(lot) {
      lots.push([...lot.recipient_subscription_ids]);
      lot.broadcast_id = 7000 + ++seq;
      lot.tag_id = 5;
      lot.status = "scheduled";
      lot.send_at = lot.created_at;
    },
  };
}

describe("#10675 descadastrado não fica devido para sempre no lembrete do formulário", () => {
  it("nao_ativo vira pulo terminal: não volta a ser devido, não gasta GET e não ocupa vaga do teto", async () => {
    const storePath = seededStore();
    const cfg = { ...cfgBase, maxRecipientsPerLot: 2 };
    const d = deps(new Set([1]));
    const day = (n: number) => (T0 + 36 * DAY + n * DAY) * 1000;

    // D+36: os 3 vencem o lembrete; o teto (2) pega a id 1 (âncora mais antiga) e a 2.
    const r1 = await runFollowupRound({ storePath, formLinkSecret: "segredo-de-teste-com-32-caracteres-ou-mais", send: true, cfg, snippets, nowMs: day(0) }, d);
    assert.equal(r1.run.counts.form_lembrete?.nao_ativo, 1);
    assert.equal(r1.run.counts.form_lembrete?.adiado_teto, 1);
    assert.deepEqual(d.lots, [["2"]]);
    const { store } = readStore(storePath);
    assert.deepEqual(store.followup!.people["1"].skips?.map((s) => [s.step, s.motivo]), [["form_lembrete", "nao_ativo"]]);

    // D+37: a id 1 sumiu do plano — a vaga vai para a id 3, sem GET da id 1.
    d.gets.length = 0;
    const r2 = await runFollowupRound({ storePath, formLinkSecret: "segredo-de-teste-com-32-caracteres-ou-mais", send: true, cfg, snippets, nowMs: day(1) }, d);
    assert.deepEqual(d.gets, [3]);
    assert.deepEqual(d.lots[1], ["3"]);
    assert.equal(r2.run.counts.form_lembrete?.nao_ativo, undefined);
    assert.equal(r2.run.counts.form_lembrete?.adiado_teto, undefined);

    // D+40 e muito depois (o cenário da issue: `form` há 40+ dias): nunca mais devido.
    for (const n of [4, 100]) {
      d.gets.length = 0;
      await runFollowupRound({ storePath, formLinkSecret: "segredo-de-teste-com-32-caracteres-ou-mais", send: true, cfg, snippets, nowMs: day(n) }, d);
      assert.ok(!d.gets.includes(1), `D+${36 + n}: nenhuma consulta para quem saiu`);
    }
    const after = readStore(storePath).store.followup!.people["1"];
    assert.equal(after.sends.filter((s) => s.step === "form_lembrete").length, 0, "quem saiu nunca recebe");
    assert.equal(after.skips?.length, 1, "pulo gravado uma vez só");
  });

  it("ativo continua recebendo lembretes sem teto de tempo (decisão do editor de 20/10)", () => {
    const p: FollowupPerson = { kit_subscriber_id: 2, email: "2@x.com", cadastro_at: null, sends: [{ step: "form", at: iso(T0 + 6 * DAY), lot_id: "f" }] };
    const far = T0 + 6 * DAY + 3000 * DAY;
    assert.deepEqual(formStepDue(T0, far, p, cfgBase), { due: "form_lembrete" });
  });

  it("nao_ativo no primeiro `form` também encerra a sequência; `apoia` e consulta falha seguem como antes", () => {
    const people: Record<string, FollowupPerson> = {};
    const n = recordLiveCheckSkips(people, [
      { due: { kit_subscriber_id: 1, email: "1@x.com", kind: "form" }, motivo: "nao_ativo" },
      { due: { kit_subscriber_id: 2, email: "2@x.com", kind: "apoio30" }, motivo: "apoia" },
      { due: { kit_subscriber_id: 3, email: "3@x.com", kind: "form_lembrete" }, motivo: "consulta_falhou" },
    ], iso(T0));
    assert.equal(n, 2);
    assert.deepEqual(formStepDue(T0, T0 + 7 * DAY, people["1"], cfgBase), { due: null, motivo: "saiu" });
    assert.equal(people["1"].apoia, undefined, "nao_ativo não mexe no estado de apoio");
    assert.equal(people["2"].apoia, true);
    assert.equal(people["3"], undefined, "consulta falha nunca vira pulo (volta no dia seguinte)");
  });

  it("pulo nao_ativo numa etapa de APOIO não encerra o formulário", () => {
    const p: FollowupPerson = {
      kit_subscriber_id: 4, email: "4@x.com", cadastro_at: null, sends: [],
      skips: [{ step: "apoio30", at: iso(T0), motivo: "nao_ativo" }],
    };
    assert.deepEqual(formStepDue(T0, T0 + 6 * DAY, p, cfgBase), { due: "form" });
  });

  it("#10685: `state: null` não grava pulo terminal — a pessoa volta no dia seguinte; estado concreto de saída grava", async () => {
    const storePath = seededStore();
    const cfg = { ...cfgBase, maxRecipientsPerLot: 3 };
    let state1: string | null = null;
    const d = deps(new Set(), (id) => (id === 1 ? state1 : "active"));
    const day = (n: number) => (T0 + 36 * DAY + n * DAY) * 1000;

    // D+36: leitura da id 1 sem state → consulta falha (adiada), sem pulo.
    const r1 = await runFollowupRound({ storePath, formLinkSecret: "segredo-de-teste-com-32-caracteres-ou-mais", send: true, cfg, snippets, nowMs: day(0) }, d);
    assert.equal(r1.run.counts.form_lembrete?.nao_ativo, undefined);
    assert.equal(r1.run.counts.form_lembrete?.consulta_falhou, 1);
    assert.equal(readStore(storePath).store.followup!.people["1"].skips, undefined, "state nulo nunca vira pulo terminal");

    // D+37: a id 1 continua devida (nova leitura) e agora vem `cancelled` → pulo terminal.
    state1 = "cancelled";
    d.gets.length = 0;
    const r2 = await runFollowupRound({ storePath, formLinkSecret: "segredo-de-teste-com-32-caracteres-ou-mais", send: true, cfg, snippets, nowMs: day(1) }, d);
    assert.ok(d.gets.includes(1), "quem teve leitura sem state volta no dia seguinte");
    assert.equal(r2.run.counts.form_lembrete?.nao_ativo, 1);
    assert.deepEqual(
      readStore(storePath).store.followup!.people["1"].skips?.map((s) => [s.step, s.motivo]),
      [["form_lembrete", "nao_ativo"]],
    );
  });

  it("#10685: filterDueByLiveCheck trata state nulo/vazio como consulta falha, não nao_ativo", () => {
    const due = [1, 2, 3].map((id) => ({ kit_subscriber_id: id, email: `${id}@x.com`, kind: "form_lembrete" as const }));
    const { send, excluded } = filterDueByLiveCheck(due, new Map([
      [1, { state: null, apoioNivel: "" }],
      [2, { state: "  ", apoioNivel: "" }],
      [3, { state: "bounced", apoioNivel: "" }],
    ]));
    assert.equal(send.length, 0);
    assert.deepEqual(excluded.map((x) => [x.due.kit_subscriber_id, x.motivo]), [[1, "consulta_falhou"], [2, "consulta_falhou"], [3, "nao_ativo"]]);
  });
});
