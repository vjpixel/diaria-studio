/**
 * test/onboarding-form-link-sig-10657.test.ts (#10657)
 *
 * Regressão: o Worker `workers/onboarding-form` aceitava POST em `/enviar`
 * com QUALQUER e-mail — qualquer um marcava outra pessoa como "preencheu"
 * (parando os lembretes dela) ou sobrescrevia as respostas dela no KV. Agora
 * o link é assinado por pessoa (HMAC do e-mail), o Worker só grava com a
 * assinatura certa para aquele e-mail, e o executor trava o envio do
 * formulário sem o segredo, sem o campo no Kit ou quando o Worker recusa o
 * link de sonda (fail-closed).
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkFormEmailSig,
  checkLinkSecret,
  constantTimeEqual,
  FORM_SIG_KIT_FIELD,
  MIN_LINK_SECRET_LENGTH,
  signFormEmail,
  verifyFormEmailSig,
} from "../scripts/lib/onboarding-form-link-sig.ts";
import {
  buildFormLink,
  FORM_LINK_PROBE_EMAIL,
  formContentGate,
  isFailedFollowupRun,
  parseFollowupSnippet,
  renderFollowupBody,
  resolveFollowupConfig,
  type FollowupRunRecord,
  type FollowupSnippets,
  type LiveSubscriberCheck,
} from "../scripts/lib/onboarding-followup.ts";
import {
  probeFormLinkEndToEnd,
  provisionFormSigs,
  runFollowupRound,
  type FollowupRoundDeps,
  type FormSigWriteResult,
} from "../scripts/onboarding-followup-run.ts";
import { emptyStore, readStore, writeStore, type OnboardingEntry } from "../scripts/lib/onboarding-store.ts";
import worker, { type Env } from "../workers/onboarding-form/src/index.ts";
import { FORM_QUESTIONS } from "../scripts/lib/onboarding-form-contract.ts";

const SECRET = "segredo-de-teste-10657-com-mais-de-32-caracteres";
const stored = (value: string): FormSigWriteResult => ({ kind: "stored", value });

describe("#10657 assinatura do link (HMAC-SHA256, Web Crypto)", () => {
  it("assina e verifica; e-mail normalizado (caixa/espaços) assina igual", async () => {
    const sig = await signFormEmail("Ana@Exemplo.com ", SECRET);
    assert.match(sig, /^[A-Za-z0-9_-]{43}$/, "base64url de 32 bytes, sem padding");
    assert.equal(sig, await signFormEmail("ana@exemplo.com", SECRET));
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", sig, SECRET), true);
    assert.equal(await verifyFormEmailSig("ANA@EXEMPLO.COM", sig, SECRET), true);
  });

  it("e-mail trocado, assinatura adulterada ou segredo errado: recusa com motivo", async () => {
    const sig = await signFormEmail("ana@exemplo.com", SECRET);
    assert.deepEqual(await checkFormEmailSig("bia@exemplo.com", sig, SECRET), { ok: false, reason: "sig_divergente" });
    const tampered = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", tampered, SECRET), false);
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", sig.slice(0, -1), SECRET), false);
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", sig, SECRET + "x"), false);
  });

  it("faltando segredo, e-mail ou assinatura: recusa com motivo sem lançar; assinar com segredo vazio lança", async () => {
    const sig = await signFormEmail("ana@exemplo.com", SECRET);
    assert.deepEqual(await checkFormEmailSig("ana@exemplo.com", sig, ""), { ok: false, reason: "segredo_invalido" });
    assert.deepEqual(await checkFormEmailSig("ana@exemplo.com", sig, undefined), { ok: false, reason: "segredo_invalido" });
    assert.deepEqual(await checkFormEmailSig("ana@exemplo.com", "", SECRET), { ok: false, reason: "sig_vazia" });
    assert.deepEqual(await checkFormEmailSig("ana@exemplo.com", null, SECRET), { ok: false, reason: "sig_vazia" });
    assert.deepEqual(await checkFormEmailSig("  ", sig, SECRET), { ok: false, reason: "email_vazio" });
    await assert.rejects(() => signFormEmail("ana@exemplo.com", ""), /ausente/);
  });

  it("segredo normalizado num lugar só: quebra de linha/espaço nas pontas não muda a assinatura", async () => {
    const sig = await signFormEmail("ana@exemplo.com", SECRET);
    assert.equal(await signFormEmail("ana@exemplo.com", `${SECRET}\n`), sig);
    assert.equal(await signFormEmail("ana@exemplo.com", `  ${SECRET}\r\n`), sig);
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", sig, `${SECRET}\n`), true);
    assert.deepEqual(checkLinkSecret(`${SECRET}\n`), { ok: true, secret: SECRET });
  });

  it(`segredo com menos de ${MIN_LINK_SECRET_LENGTH} caracteres é recusado no lado que assina`, async () => {
    const short = "x".repeat(MIN_LINK_SECRET_LENGTH - 1);
    assert.equal(checkLinkSecret(short).ok, false);
    assert.equal(checkLinkSecret(` ${short} `).ok, false, "o trim não conta");
    await assert.rejects(() => signFormEmail("ana@exemplo.com", short), /mínimo 32/);
    assert.equal(checkLinkSecret("x".repeat(MIN_LINK_SECRET_LENGTH)).ok, true);
  });

  it("comparação em tempo constante", () => {
    assert.equal(constantTimeEqual("abc", "abc"), true);
    assert.equal(constantTimeEqual("abc", "abd"), false);
    assert.equal(constantTimeEqual("abc", "abcd"), false);
  });
});

describe("#10657 executor: link com assinatura, envio travado sem segredo / campo / Worker", () => {
  const cfg = resolveFollowupConfig({ enabled: true, form_url: "https://form.example/", form_responses_url: "https://form.example/api/respostas" });
  const ok = parseFollowupSnippet(`<!--\nassunto: "A"\npreview_text: "P"\n-->\nResponda: {{FORM_URL}}`);
  const formSnippets: FollowupSnippets = { apoio30: null, apoio90: null, apoio180: null, apoio360: null, form: ok, form_lembrete: ok };

  it("o link leva o e-mail CRU (sem filtro Liquid) e a assinatura do custom field form_sig", () => {
    assert.equal(FORM_SIG_KIT_FIELD, "form_sig");
    const out = renderFollowupBody("{{FORM_URL}}", "https://form.example/?ref=x");
    assert.equal(out, "https://form.example/?ref=x&email={{ subscriber.email_address }}&sig={{ subscriber.form_sig }}");
    assert.ok(!out.includes("url_encode"), "url_encode não confirmado no Kit — revertido por decisão do coordenador");
  });

  it("segredo ausente, vazio, só espaços ou curto trava o formulário (fail-closed) e conta como falha (alarme)", () => {
    for (const s of [undefined, null, "", "   ", "curto-demais"]) {
      const g = formContentGate(formSnippets, cfg, s);
      assert.equal(g.blocked, true);
      assert.equal((g as { motivo: string }).motivo, "assinatura_nao_configurada");
    }
    const run: FollowupRunRecord = {
      at: "2026-01-01T00:00:00Z", apoio_blocked: null, lots_created: 0, lots_failed: 0, over_cap: 0, lookups_failed: 0, counts: {},
      form_blocked: { motivo: "assinatura_nao_configurada", detalhe: "x" },
    };
    assert.equal(isFailedFollowupRun(run), true);
    // Liberado: devolve o segredo JÁ normalizado, que é o que assina.
    assert.deepEqual(formContentGate(formSnippets, cfg, `${SECRET}\n`), { blocked: false, linkSecret: SECRET });
  });

  const DAY = 86_400;
  const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  function entry(id: number): OnboardingEntry {
    return {
      subscription_id: String(id), email: `${id}@x.com`, status_detectado: "active", created_at: T0, detected_at: iso(T0),
      email1_sent_at: iso(T0), email1_brevo_id: null, email2_sent_at: null, email2_brevo_id: null,
      email3_state: "pending", email3_campaign_id: null, email3_decided_at: null,
    };
  }
  function storeWith(ids: number[]): string {
    const p = join(mkdtempSync(join(tmpdir(), "followup-10657-")), "store.json");
    const store = emptyStore();
    for (const id of ids) store.entries[String(id)] = entry(id);
    writeStore(store, p);
    return p;
  }
  const nowMs = (T0 + 6 * DAY + 3600) * 1000; // D+6: o `form` vence

  type Tracked = FollowupRoundDeps & { sets: [number, string][]; lots: string[][]; bodies: string[]; probes: string[] };
  function deps(over: Partial<FollowupRoundDeps> = {}): Tracked {
    const sets: [number, string][] = [];
    const lots: string[][] = [];
    const bodies: string[] = [];
    const probes: string[] = [];
    return {
      sets,
      lots,
      bodies,
      probes,
      listActiveSubscribers: async () => [],
      // E-mail no Kit em caixa alta: a assinatura cobre o e-mail ATUAL do Kit (normalizado).
      getSubscriber: async (id) => ({ state: "active", apoioNivel: "", email: `${id}@X.com`, formSig: null }),
      listEnvioBrevoEmails: async () => [],
      fetchFormResponses: async () => [],
      async setFormSig(id, sig) {
        sets.push([id, sig]);
        return stored(sig);
      },
      async probeFormLink(url) {
        probes.push(url);
        return 200;
      },
      async runLot(lot, content) {
        lots.push([...lot.recipient_subscription_ids]);
        bodies.push(content.body);
        lot.broadcast_id = 9000 + lots.length;
        lot.tag_id = 5;
        lot.status = "scheduled";
        lot.send_at = lot.created_at;
      },
      ...over,
    };
  }

  it("sem o segredo: nenhum lote do formulário, nenhuma sonda, nenhuma gravação", async () => {
    const d = deps();
    const { run } = await runFollowupRound({ storePath: storeWith([1]), send: true, cfg, snippets: formSnippets, nowMs }, d);
    assert.equal(run.form_blocked?.motivo, "assinatura_nao_configurada");
    assert.deepEqual([d.lots, d.sets, d.probes], [[], [], []]);
  });

  it("com o segredo: sonda o Worker, grava a assinatura do e-mail do Kit e o corpo leva as merge tags", async () => {
    const d = deps();
    const { run } = await runFollowupRound({ storePath: storeWith([1, 2]), send: true, cfg, snippets: formSnippets, nowMs, formLinkSecret: SECRET }, d);
    assert.equal(run.form_blocked, null);
    assert.deepEqual(d.probes, [buildFormLink("https://form.example/", FORM_LINK_PROBE_EMAIL, await signFormEmail(FORM_LINK_PROBE_EMAIL, SECRET))]);
    assert.ok(d.probes[0]!.includes("email=sonda+link@diar.ia.br&sig="), "sonda manda o e-mail CRU, como a merge tag");
    assert.deepEqual(d.sets, [
      [1, await signFormEmail("1@x.com", SECRET)],
      [2, await signFormEmail("2@x.com", SECRET)],
    ]);
    assert.deepEqual(d.lots, [["1", "2"]]);
    assert.ok(d.bodies[0]!.includes("email={{ subscriber.email_address }}&sig={{ subscriber.form_sig }}"));
  });

  it("segredo com quebra de linha no ambiente assina igual ao normalizado", async () => {
    const d = deps();
    await runFollowupRound({ storePath: storeWith([1]), send: true, cfg, snippets: formSnippets, nowMs, formLinkSecret: `${SECRET}\n` }, d);
    assert.deepEqual(d.sets, [[1, await signFormEmail("1@x.com", SECRET)]]);
  });

  for (const status of [403, 404, 503]) {
    it(`sonda recusada pelo Worker (HTTP ${status}): trava o formulário, alarma, ninguém recebe nem é gravado`, async () => {
      const d = deps({ probeFormLink: async () => status });
      const { run } = await runFollowupRound({ storePath: storeWith([1, 2]), send: true, cfg, snippets: formSnippets, nowMs, formLinkSecret: SECRET }, d);
      assert.equal(run.form_blocked?.motivo, "link_rejeitado_pelo_worker");
      assert.match(run.form_blocked!.detalhe, new RegExp(`HTTP ${status}`));
      assert.equal(isFailedFollowupRun(run), true);
      assert.deepEqual([d.lots, d.sets], [[], []]);
      assert.equal(run.counts.form?.link_rejeitado, 2);
    });
  }

  it("sonda: erro de rede ou sonda não configurada também travam", async () => {
    const net = await probeFormLinkEndToEnd("https://form.example/", SECRET, { probeFormLink: async () => Promise.reject(new Error("ECONNREFUSED")) });
    assert.equal(net?.motivo, "link_rejeitado_pelo_worker");
    assert.match(net!.detalhe, /ECONNREFUSED/);
    const none = await probeFormLinkEndToEnd("https://form.example/", SECRET, {});
    assert.equal(none?.motivo, "link_rejeitado_pelo_worker");
    assert.equal(await probeFormLinkEndToEnd("https://form.example/", SECRET, { probeFormLink: async () => 200 }), null);
  });

  it("sonda contra o Worker de verdade: mesmo segredo passa; segredo diferente volta 403", async () => {
    const realProbe = (workerSecret: string) => ({
      probeFormLink: async (url: string) => {
        const e = { ONBOARDING_FORM: { put: async () => {} } as unknown as KVNamespace, ONBOARDING_FORM_LINK_SECRET: workerSecret } as Env;
        return (await worker.fetch(new Request(url), e)).status;
      },
    });
    assert.equal(await probeFormLinkEndToEnd("https://form.example/", SECRET, realProbe(`${SECRET}\n`)), null);
    const bad = await probeFormLinkEndToEnd("https://form.example/", SECRET, realProbe(SECRET + "-outro"));
    assert.match(bad!.detalhe, /HTTP 403/);
  });

  it("assinatura já certa no Kit: não regrava (o lembrete reaproveita)", async () => {
    const sig1 = await signFormEmail("1@x.com", SECRET);
    const d = deps({ getSubscriber: async (id) => ({ state: "active", apoioNivel: "", email: `${id}@x.com`, formSig: id === 1 ? sig1 : "velha" }) });
    await runFollowupRound({ storePath: storeWith([1, 2]), send: true, cfg, snippets: formSnippets, nowMs, formLinkSecret: SECRET }, d);
    assert.deepEqual(d.sets.map(([id]) => id), [2]);
    assert.deepEqual(d.lots, [["1", "2"]]);
  });

  it("Kit não guarda o campo (form_sig inexistente): trava o formulário, alarma, nenhum lote, para no 1º", async () => {
    let setCalls = 0;
    const d = deps({
      setFormSig: async () => {
        setCalls++;
        return { kind: "absent" };
      },
    });
    const storePath = storeWith([1, 2]);
    const { run } = await runFollowupRound({ storePath, send: true, cfg, snippets: formSnippets, nowMs, formLinkSecret: SECRET }, d);
    assert.equal(run.form_blocked?.motivo, "campo_assinatura_ausente");
    assert.deepEqual(d.lots, []);
    assert.equal(run.counts.form?.campo_assinatura_ausente, 2);
    assert.equal(isFailedFollowupRun(run), true);
    assert.equal(setCalls, 1);
    const people = readStore(storePath).store.followup?.people ?? {};
    assert.ok(Object.values(people).every((p) => p.sends.length === 0));
  });

  it("gravação falha para uma pessoa: só ela fica fora (conta como falha da rodada)", async () => {
    const d = deps({
      async setFormSig(id, sig) {
        if (id === 1) throw new Error("HTTP 500");
        return stored(sig);
      },
    });
    const { run } = await runFollowupRound({ storePath: storeWith([1, 2]), send: true, cfg, snippets: formSnippets, nowMs, formLinkSecret: SECRET }, d);
    assert.deepEqual(d.lots, [["2"]]);
    assert.equal(run.lookups_failed, 1);
    assert.equal(run.counts.form?.assinatura_falhou, 1);
  });

  it("dry-run nunca escreve no Kit nem chama o Worker", async () => {
    const d = deps();
    await runFollowupRound({ storePath: storeWith([1]), send: false, cfg, snippets: formSnippets, nowMs, formLinkSecret: SECRET }, d);
    assert.deepEqual([d.sets, d.probes], [[], []]);
  });

  // --- provisionFormSigs isolado -------------------------------------------

  const due = (id: number, kind: "form" | "form_lembrete" = "form") => ({ kit_subscriber_id: id, email: `${id}@x.com`, kind });
  const live = (over: Partial<LiveSubscriberCheck> = {}): LiveSubscriberCheck => ({ state: "active", apoioNivel: "", formSig: null, ...over });
  const noGet = { getSubscriber: async (): Promise<LiveSubscriberCheck> => assert.fail("não relê") };

  it("sem gravação configurada: ninguém sem assinatura confirmada passa", async () => {
    const r = await provisionFormSigs([due(7)], new Map([[7, live()]]), SECRET, noGet);
    assert.deepEqual(r.ok, []);
    assert.equal(r.failed.length, 1);
  });

  it("assina o e-mail ATUAL do Kit; sem e-mail na leitura, cai no e-mail do store", async () => {
    const sets: [number, string][] = [];
    const setFormSig = async (id: number, sig: string) => {
      sets.push([id, sig]);
      return stored(sig);
    };
    const checks = new Map([[1, live({ email: "novo@kit.com" })], [2, live({ email: null })], [3, live()]]);
    const r = await provisionFormSigs([due(1), due(2), due(3)], checks, SECRET, { ...noGet, setFormSig });
    assert.deepEqual(sets, [
      [1, await signFormEmail("novo@kit.com", SECRET)],
      [2, await signFormEmail("2@x.com", SECRET)],
      [3, await signFormEmail("3@x.com", SECRET)],
    ]);
    assert.equal(r.ok.length, 3);
  });

  it("mesma pessoa devida em form e form_lembrete: UMA escrita, as duas em ok, e o lote mantém as duas", async () => {
    let calls = 0;
    const d1 = due(5, "form");
    const d2 = due(5, "form_lembrete");
    const r = await provisionFormSigs([d1, d2], new Map([[5, live()]]), SECRET, {
      ...noGet,
      setFormSig: async (_id, sig) => {
        calls++;
        return stored(sig);
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(r.ok, [d1, d2]);
    // O filtro do executor (`okSet.has(d)`) mantém os dois objetos.
    const okSet = new Set(r.ok);
    assert.deepEqual([d1, d2].filter((d) => okSet.has(d)), [d1, d2]);
  });

  it("gravação: 429 é retentado depois do cooldown, com o mesmo espaçamento das leituras", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const r = await provisionFormSigs([due(7)], new Map([[7, live()]]), SECRET, {
      ...noGet,
      async setFormSig(_id, sig) {
        calls++;
        if (calls === 1) throw Object.assign(new Error("HTTP 429"), { status: 429 });
        return stored(sig);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      isTransientLookupError: (e) => (e as { status?: number }).status === 429,
    }, { spacingMs: 350, retryDelayMs: 60_000, retryPasses: 1 });
    assert.equal(calls, 2);
    assert.deepEqual(r.ok, [due(7)]);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(sleeps, [60_000]);
  });

  it("gravação: 403 não é retentado; transitório que persiste esgota as passadas", async () => {
    let calls = 0;
    const r403 = await provisionFormSigs([due(7)], new Map([[7, live()]]), SECRET, {
      ...noGet,
      async setFormSig() {
        calls++;
        throw Object.assign(new Error("HTTP 403"), { status: 403 });
      },
      isTransientLookupError: (e) => (e as { status?: number }).status !== 403,
    });
    assert.equal(calls, 1);
    assert.equal(r403.failed[0]?.motivo, "assinatura_falhou");

    calls = 0;
    const r503 = await provisionFormSigs([due(7)], new Map([[7, live()]]), SECRET, {
      ...noGet,
      async setFormSig() {
        calls++;
        throw new Error("HTTP 503");
      },
      isTransientLookupError: () => true,
    }, { retryPasses: 2 });
    assert.equal(calls, 3);
    assert.equal(r503.failed.length, 1);
    assert.equal(r503.fieldMissing, null);
  });

  it("429 pendente de retry + campo ausente depois: os dois em failed; ok + failed cobrem todo mundo", async () => {
    const r = await provisionFormSigs([due(1), due(2)], new Map([[1, live()], [2, live()]]), SECRET, {
      ...noGet,
      async setFormSig(id) {
        if (id === 1) throw Object.assign(new Error("HTTP 429"), { status: 429 });
        return { kind: "absent" };
      },
      isTransientLookupError: () => true,
    });
    assert.deepEqual(r.ok, []);
    assert.deepEqual(r.failed.map((f) => [f.due.kit_subscriber_id, f.motivo]).sort(), [[1, "campo_assinatura_ausente"], [2, "campo_assinatura_ausente"]]);
    assert.match(r.fieldMissing ?? "", /form_sig/);
  });

  it("aceito antes, campo ausente depois: quem já confirmou segue em ok, o resto vai para failed sem nova tentativa", async () => {
    let calls = 0;
    const r = await provisionFormSigs([due(1), due(2), due(3)], new Map([[1, live()], [2, live()], [3, live()]]), SECRET, {
      ...noGet,
      async setFormSig(id, sig) {
        calls++;
        return id === 1 ? stored(sig) : { kind: "absent" };
      },
    });
    assert.deepEqual(r.ok.map((d) => d.kit_subscriber_id), [1]);
    assert.deepEqual(r.failed.map((f) => f.due.kit_subscriber_id), [2, 3]);
    assert.equal(calls, 2, "a 3 não chega a ser tentada");
    assert.equal(r.ok.length + r.failed.length, 3);
  });

  it("resposta do PATCH sem fields: relê pelo GET singular antes de concluir", async () => {
    const sig = await signFormEmail("7@x.com", SECRET);
    let gets = 0;
    const okRes = await provisionFormSigs([due(7)], new Map([[7, live()]]), SECRET, {
      async getSubscriber() {
        gets++;
        return live({ formSig: sig });
      },
      setFormSig: async () => ({ kind: "unknown" }),
    });
    assert.equal(gets, 1);
    assert.deepEqual(okRes.ok, [due(7)]);
    assert.equal(okRes.fieldMissing, null);

    const missing = await provisionFormSigs([due(7)], new Map([[7, live()]]), SECRET, {
      getSubscriber: async () => live({ formSig: null }),
      setFormSig: async () => ({ kind: "unknown" }),
    });
    assert.deepEqual(missing.ok, []);
    assert.match(missing.fieldMissing ?? "", /form_sig/);
  });

  it("resposta do PATCH COM fields sem form_sig: campo ausente, sem reler", async () => {
    const r = await provisionFormSigs([due(7)], new Map([[7, live()]]), SECRET, { ...noGet, setFormSig: async () => ({ kind: "absent" }) });
    assert.match(r.fieldMissing ?? "", /form_sig/);
    assert.equal(r.failed[0]?.motivo, "campo_assinatura_ausente");
  });

  it("releitura com OUTRO valor: falha só daquela pessoa (assinatura_divergente_pos_escrita), sem travar o resto", async () => {
    const r = await provisionFormSigs([due(1), due(2)], new Map([[1, live()], [2, live()]]), SECRET, {
      ...noGet,
      setFormSig: async (id, sig) => stored(id === 1 ? "outro-valor" : sig),
    });
    assert.equal(r.fieldMissing, null);
    assert.deepEqual(r.ok.map((d) => d.kit_subscriber_id), [2]);
    assert.equal(r.failed[0]?.motivo, "assinatura_divergente_pos_escrita");
    assert.match(r.failed[0]!.error, /11 caracteres, esperado 43/);
    // Via GET singular também.
    const viaGet = await provisionFormSigs([due(1)], new Map([[1, live()]]), SECRET, {
      getSubscriber: async () => live({ formSig: "outro-valor" }),
      setFormSig: async () => ({ kind: "unknown" }),
    });
    assert.equal(viaGet.failed[0]?.motivo, "assinatura_divergente_pos_escrita");
  });

  it("no executor, divergência conta por pessoa (contagem própria + falha da rodada)", async () => {
    const d = deps({ setFormSig: async (id, sig) => stored(id === 1 ? "outro" : sig) });
    const { run } = await runFollowupRound({ storePath: storeWith([1, 2]), send: true, cfg, snippets: formSnippets, nowMs, formLinkSecret: SECRET }, d);
    assert.equal(run.form_blocked, null);
    assert.deepEqual(d.lots, [["2"]]);
    assert.equal(run.counts.form?.assinatura_divergente_pos_escrita, 1);
    assert.equal(run.lookups_failed, 1);
  });
});

describe("#10657 Worker: só grava com assinatura válida para o e-mail", () => {
  const warns: string[] = [];
  const errors: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  before(() => {
    console.warn = (m: string) => void warns.push(m);
    console.error = (m: string) => void errors.push(m);
  });
  afterEach(() => {
    warns.length = 0;
    errors.length = 0;
  });
  after(() => {
    console.warn = origWarn;
    console.error = origError;
  });

  function env(secret: string | null = SECRET) {
    const puts: [string, string][] = [];
    const ns = {
      async put(k: string, v: string) {
        puts.push([k, v]);
      },
      async get() {
        return null;
      },
      async list() {
        return { keys: [], list_complete: true, cursor: undefined };
      },
    };
    const e = { ONBOARDING_FORM: ns as unknown as KVNamespace, RESPONSES_TOKEN: "tok", ...(secret !== null ? { ONBOARDING_FORM_LINK_SECRET: secret } : {}) } as Env;
    return { e, puts };
  }
  /** Respostas mínimas válidas: as obrigatórias com a 1ª opção. */
  function answers(): [string, string][] {
    return FORM_QUESTIONS.filter((q) => q.required && "options" in q).map((q) => [q.id, (q as { options: readonly string[] }).options[0]!]);
  }
  function post(fields: [string, string][]): Request {
    return new Request("https://form.example/enviar", { method: "POST", body: new URLSearchParams(fields) });
  }

  it("link CRU do e-mail (como a merge tag sem filtro produz): ?email=a+b@x.com verifica e mostra o e-mail fixo", async () => {
    const sig = await signFormEmail("a+b@x.com", SECRET);
    // `+` cru vira espaço na query; `prefillEmailFromQuery` restaura antes de verificar.
    const res = await worker.fetch(new Request(`https://form.example/?email=a+b@x.com&sig=${sig}`), env().e);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('name="sig"') && body.includes('name="email" value="a+b@x.com"'));
  });

  it("assume codificação do Kit (url_encode NÃO é usado hoje): e-mails com +, & e # chegariam inteiros se codificados", async () => {
    for (const email of ["a+b@x.com", "a&b@x.com", "a#b@x.com"]) {
      const sig = await signFormEmail(email, SECRET);
      const res = await worker.fetch(new Request(`https://form.example/?email=${encodeURIComponent(email)}&sig=${sig}`), env().e);
      assert.equal(res.status, 200, email);
      const body = await res.text();
      assert.ok(body.includes(`name="email" value="${email.replace(/&/g, "&amp;")}"`), email);
      const { e, puts } = env();
      const post2 = await worker.fetch(post([["email", email], ["sig", sig], ...answers()]), e);
      assert.equal(post2.status, 200, email);
      assert.deepEqual(puts.map(([k]) => k), [`resp:${email}`], email);
    }
  });

  it("resíduo aceito: link CRU com & no local part corta o e-mail e vira link inválido (nunca grava errado)", async () => {
    const sig = await signFormEmail("a&b@x.com", SECRET);
    const res = await worker.fetch(new Request(`https://form.example/?email=a&b@x.com&sig=${sig}`), env().e);
    assert.equal(res.status, 403);
  });

  it("GET sem assinatura ou com assinatura errada: página de link inválido, sem formulário, log só com rota e motivo", async () => {
    const sigOutro = await signFormEmail("outro@x.com", SECRET);
    const cases: [string, string][] = [
      ["?email=a@x.com", "sig_vazia"],
      [`?email=a@x.com&sig=${sigOutro}`, "sig_divergente"],
      ["?email=a@x.com&sig=xyz", "sig_divergente"],
      ["", "email_vazio"],
    ];
    for (const [q, reason] of cases) {
      warns.length = 0;
      const res = await worker.fetch(new Request(`https://form.example/${q}`), env().e);
      assert.equal(res.status, 403, q);
      const body = await res.text();
      assert.ok(body.includes("Link inválido") && !body.includes("<form"), q);
      assert.deepEqual(warns.map((w) => JSON.parse(w)), [{ event: "link_invalido", route: "/", reason }], q);
      assert.ok(!warns[0]!.includes("a@x.com") && !warns[0]!.includes(sigOutro), "nunca loga e-mail nem assinatura");
    }
  });

  it("POST com assinatura válida grava", async () => {
    const { e, puts } = env();
    const sig = await signFormEmail("a@x.com", SECRET);
    const res = await worker.fetch(post([["email", "a@x.com"], ["sig", sig], ...answers()]), e);
    assert.equal(res.status, 200);
    assert.deepEqual(puts.map(([k]) => k), ["resp:a@x.com"]);
  });

  it("POST sem assinatura, com assinatura errada ou de OUTRO e-mail: 403, log e nada no KV", async () => {
    const sigVitima = await signFormEmail("vitima@x.com", SECRET);
    const sigAtacante = await signFormEmail("atacante@x.com", SECRET);
    const cases: [string, [string, string][], string][] = [
      ["sem sig", [["email", "vitima@x.com"], ...answers()], "sig_vazia"],
      ["sig vazia", [["email", "vitima@x.com"], ["sig", ""], ...answers()], "sig_vazia"],
      ["sig adulterada", [["email", "vitima@x.com"], ["sig", sigVitima.slice(1) + "A"], ...answers()], "sig_divergente"],
      ["sig de outro e-mail", [["email", "vitima@x.com"], ["sig", sigAtacante], ...answers()], "sig_divergente"],
    ];
    for (const [name, fields, reason] of cases) {
      warns.length = 0;
      const { e, puts } = env();
      const res = await worker.fetch(post(fields), e);
      assert.equal(res.status, 403, name);
      assert.equal(puts.length, 0, name);
      assert.deepEqual(warns.map((w) => JSON.parse(w)), [{ event: "link_invalido", route: "/enviar", reason }], name);
    }
  });

  it("POST com dois campos email e sig repetida: 403, ou grava SÓ na chave do e-mail assinado", async () => {
    const sigAtacante = await signFormEmail("atacante@x.com", SECRET);
    // Vítima primeiro, assinatura do atacante: o 1º e-mail não confere → 403.
    {
      const { e, puts } = env();
      const res = await worker.fetch(post([["email", "vitima@x.com"], ["email", "atacante@x.com"], ["sig", sigAtacante], ["sig", sigAtacante], ...answers()]), e);
      assert.equal(res.status, 403);
      assert.equal(puts.length, 0);
    }
    // Atacante primeiro: grava, mas só na chave do próprio atacante.
    {
      const { e, puts } = env();
      const res = await worker.fetch(post([["email", "atacante@x.com"], ["email", "vitima@x.com"], ["sig", sigAtacante], ["sig", "lixo"], ...answers()]), e);
      assert.equal(res.status, 200);
      assert.deepEqual(puts.map(([k]) => k), ["resp:atacante@x.com"]);
    }
  });

  it("segredo com quebra de linha no Worker verifica igual (mesmo módulo do executor)", async () => {
    const sig = await signFormEmail("a@x.com", SECRET);
    const res = await worker.fetch(new Request(`https://form.example/?email=a@x.com&sig=${sig}`), env(`${SECRET}\n`).e);
    assert.equal(res.status, 200);
  });

  it("sem o segredo (ou curto) no Worker: rotas do formulário 503 com console.error, nada gravado", async () => {
    for (const s of [null, "curto"]) {
      errors.length = 0;
      const { e, puts } = env(s);
      const sig = await signFormEmail("a@x.com", SECRET);
      const res = await worker.fetch(post([["email", "a@x.com"], ["sig", sig], ...answers()]), e);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "not_configured" });
      assert.equal(puts.length, 0);
      const get = await worker.fetch(new Request(`https://form.example/?email=a@x.com&sig=${sig}`), e);
      assert.equal(get.status, 503);
      assert.equal(errors.length, 2);
    }
  });

  it("/api/respostas NÃO depende do segredo do link (senão viraria 'respostas indisponíveis' no executor)", async () => {
    const { e } = env(null);
    const res = await worker.fetch(new Request("https://form.example/api/respostas", { headers: { authorization: "Bearer tok" } }), e);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { responses: [] });
  });
});
