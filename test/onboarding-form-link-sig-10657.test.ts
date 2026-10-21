/**
 * test/onboarding-form-link-sig-10657.test.ts (#10657)
 *
 * Regressão: o Worker `workers/onboarding-form` aceitava POST em `/enviar`
 * com QUALQUER e-mail — qualquer um marcava outra pessoa como "preencheu"
 * (parando os lembretes dela) ou sobrescrevia as respostas dela no KV. Agora
 * o link é assinado por pessoa (HMAC do e-mail), o Worker só grava com a
 * assinatura certa para aquele e-mail, e o executor trava o envio do
 * formulário sem o segredo (fail-closed).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  constantTimeEqual,
  FORM_SIG_KIT_FIELD,
  signFormEmail,
  verifyFormEmailSig,
} from "../scripts/lib/onboarding-form-link-sig.ts";
import {
  formContentGate,
  isFailedFollowupRun,
  parseFollowupSnippet,
  renderFollowupBody,
  resolveFollowupConfig,
  type FollowupSnippets,
} from "../scripts/lib/onboarding-followup.ts";
import { provisionFormSigs, runFollowupRound, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, readStore, writeStore, type OnboardingEntry } from "../scripts/lib/onboarding-store.ts";
import worker, { type Env } from "../workers/onboarding-form/src/index.ts";
import { FORM_QUESTIONS } from "../scripts/lib/onboarding-form-contract.ts";

const SECRET = "segredo-de-teste-10657";

describe("#10657 assinatura do link (HMAC-SHA256, Web Crypto)", () => {
  it("assina e verifica; e-mail normalizado (caixa/espaços) assina igual", async () => {
    const sig = await signFormEmail("Ana@Exemplo.com ", SECRET);
    assert.match(sig, /^[A-Za-z0-9_-]{43}$/, "base64url de 32 bytes, sem padding");
    assert.equal(sig, await signFormEmail("ana@exemplo.com", SECRET));
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", sig, SECRET), true);
    assert.equal(await verifyFormEmailSig("ANA@EXEMPLO.COM", sig, SECRET), true);
  });

  it("e-mail trocado, assinatura adulterada ou segredo errado: recusa", async () => {
    const sig = await signFormEmail("ana@exemplo.com", SECRET);
    assert.equal(await verifyFormEmailSig("bia@exemplo.com", sig, SECRET), false);
    const tampered = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", tampered, SECRET), false);
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", sig.slice(0, -1), SECRET), false);
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", sig, "outro-segredo"), false);
  });

  it("faltando segredo, e-mail ou assinatura: recusa sem lançar; assinar com segredo vazio lança", async () => {
    const sig = await signFormEmail("ana@exemplo.com", SECRET);
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", sig, ""), false);
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", sig, undefined), false);
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", "", SECRET), false);
    assert.equal(await verifyFormEmailSig("ana@exemplo.com", null, SECRET), false);
    assert.equal(await verifyFormEmailSig("", sig, SECRET), false);
    await assert.rejects(() => signFormEmail("ana@exemplo.com", ""), /segredo vazio/);
  });

  it("comparação em tempo constante", () => {
    assert.equal(constantTimeEqual("abc", "abc"), true);
    assert.equal(constantTimeEqual("abc", "abd"), false);
    assert.equal(constantTimeEqual("abc", "abcd"), false);
  });
});

describe("#10657 executor: link com assinatura, envio travado sem o segredo", () => {
  const cfg = resolveFollowupConfig({ enabled: true, form_url: "https://form.example/", form_responses_url: "https://form.example/api/respostas" });
  const ok = parseFollowupSnippet(`<!--\nassunto: "A"\npreview_text: "P"\n-->\nResponda: {{FORM_URL}}`);
  const formSnippets: FollowupSnippets = { apoio30: null, apoio90: null, apoio180: null, apoio360: null, form: ok, form_lembrete: ok };

  it("o link leva e-mail (url_encode) e assinatura por merge tag do custom field form_sig", () => {
    assert.equal(FORM_SIG_KIT_FIELD, "form_sig");
    assert.equal(
      renderFollowupBody("{{FORM_URL}}", "https://form.example/?ref=x"),
      "https://form.example/?ref=x&email={{ subscriber.email_address | url_encode }}&sig={{ subscriber.form_sig }}",
    );
  });

  it("segredo ausente, vazio ou só espaços trava o formulário (fail-closed)", () => {
    for (const s of [undefined, null, "", "   "]) {
      const g = formContentGate(formSnippets, cfg, s);
      assert.equal(g.blocked, true);
      assert.equal((g as { motivo: string }).motivo, "assinatura_nao_configurada");
    }
    assert.deepEqual(formContentGate(formSnippets, cfg, SECRET), { blocked: false });
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

  function deps(over: Partial<FollowupRoundDeps> = {}): FollowupRoundDeps & { sets: [number, string][]; lots: string[][]; bodies: string[] } {
    const sets: [number, string][] = [];
    const lots: string[][] = [];
    const bodies: string[] = [];
    return {
      sets,
      lots,
      bodies,
      listActiveSubscribers: async () => [],
      // E-mail no Kit em caixa alta: a assinatura cobre o e-mail ATUAL do Kit (normalizado).
      getSubscriber: async (id) => ({ state: "active", apoioNivel: "", email: `${id}@X.com`, formSig: null }),
      listEnvioBrevoEmails: async () => [],
      fetchFormResponses: async () => [],
      async setFormSig(id, sig) {
        sets.push([id, sig]);
        return sig;
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

  it("sem o segredo: nenhum lote do formulário, nenhuma gravação de assinatura", async () => {
    const d = deps();
    const { run } = await runFollowupRound({ storePath: storeWith([1]), send: true, cfg, snippets: formSnippets, nowMs }, d);
    assert.equal(run.form_blocked?.motivo, "assinatura_nao_configurada");
    assert.deepEqual(d.lots, []);
    assert.deepEqual(d.sets, []);
  });

  it("com o segredo: grava a assinatura do e-mail do Kit antes do lote e o corpo leva a merge tag", async () => {
    const d = deps();
    const { run } = await runFollowupRound({ storePath: storeWith([1, 2]), send: true, cfg, snippets: formSnippets, nowMs, formLinkSecret: SECRET }, d);
    assert.equal(run.form_blocked, null);
    assert.deepEqual(d.sets, [
      [1, await signFormEmail("1@x.com", SECRET)],
      [2, await signFormEmail("2@x.com", SECRET)],
    ]);
    assert.deepEqual(d.lots, [["1", "2"]]);
    assert.ok(d.bodies[0]!.includes("email={{ subscriber.email_address | url_encode }}&sig={{ subscriber.form_sig }}"));
  });

  it("assinatura já certa no Kit: não regrava (o lembrete reaproveita)", async () => {
    const sig1 = await signFormEmail("1@x.com", SECRET);
    const d = deps({ getSubscriber: async (id) => ({ state: "active", apoioNivel: "", email: `${id}@x.com`, formSig: id === 1 ? sig1 : "velha" }) });
    await runFollowupRound({ storePath: storeWith([1, 2]), send: true, cfg, snippets: formSnippets, nowMs, formLinkSecret: SECRET }, d);
    assert.deepEqual(d.sets.map(([id]) => id), [2]);
    assert.deepEqual(d.lots, [["1", "2"]]);
  });

  it("Kit não guarda o campo (form_sig inexistente): trava o formulário, alarma, nenhum lote", async () => {
    let setCalls = 0;
    const d = deps({
      setFormSig: async () => {
        setCalls++;
        return null;
      },
    });
    const storePath = storeWith([1, 2]);
    const { run } = await runFollowupRound({ storePath, send: true, cfg, snippets: formSnippets, nowMs, formLinkSecret: SECRET }, d);
    assert.equal(run.form_blocked?.motivo, "campo_assinatura_ausente");
    assert.deepEqual(d.lots, []);
    assert.equal(run.counts.form?.assinatura_falhou, 2);
    assert.equal(isFailedFollowupRun(run), true);
    // Para no 1º 2xx sem o campo: não tenta pessoa a pessoa.
    assert.equal(setCalls, 1);
    const people = readStore(storePath).store.followup?.people ?? {};
    assert.ok(Object.values(people).every((p) => p.sends.length === 0));
  });

  it("gravação falha para uma pessoa: só ela fica fora (conta como falha da rodada)", async () => {
    const d = deps({
      async setFormSig(id, sig) {
        if (id === 1) throw new Error("HTTP 500");
        return sig;
      },
    });
    const { run } = await runFollowupRound({ storePath: storeWith([1, 2]), send: true, cfg, snippets: formSnippets, nowMs, formLinkSecret: SECRET }, d);
    assert.deepEqual(d.lots, [["2"]]);
    assert.equal(run.lookups_failed, 1);
    assert.equal(run.counts.form?.assinatura_falhou, 1);
  });

  it("dry-run nunca escreve no Kit", async () => {
    const d = deps();
    await runFollowupRound({ storePath: storeWith([1]), send: false, cfg, snippets: formSnippets, nowMs, formLinkSecret: SECRET }, d);
    assert.deepEqual(d.sets, []);
  });

  it("provisionFormSigs sem gravação configurada: ninguém sem assinatura confirmada passa", async () => {
    const due = [{ kit_subscriber_id: 7, email: "7@x.com", kind: "form" as const }];
    const r = await provisionFormSigs(due, new Map([[7, { state: "active", apoioNivel: "" }]]), SECRET, { getSubscriber: async () => ({ state: "active", apoioNivel: "" }) });
    assert.deepEqual(r.ok, []);
    assert.equal(r.failed.length, 1);
  });

  const due7 = [{ kit_subscriber_id: 7, email: "7@x.com", kind: "form" as const }];
  const checks7 = () => new Map([[7, { state: "active", apoioNivel: "", email: "7@x.com", formSig: null }]]);

  it("gravação: 429 é retentado depois do cooldown, com o mesmo espaçamento das leituras", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const r = await provisionFormSigs(due7, checks7(), SECRET, {
      getSubscriber: async () => assert.fail("não relê com fields na resposta"),
      async setFormSig(_id, sig) {
        calls++;
        if (calls === 1) throw Object.assign(new Error("HTTP 429"), { status: 429 });
        return sig;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      isTransientLookupError: (e) => (e as { status?: number }).status === 429,
    }, { spacingMs: 350, retryDelayMs: 60_000, retryPasses: 1 });
    assert.equal(calls, 2);
    assert.deepEqual(r.ok, due7);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(sleeps, [60_000]);
  });

  it("gravação: erro não transitório (403) não é retentado; transitório que persiste esgota as passadas", async () => {
    let calls = 0;
    const r403 = await provisionFormSigs(due7, checks7(), SECRET, {
      getSubscriber: async () => assert.fail("não relê"),
      async setFormSig() {
        calls++;
        throw Object.assign(new Error("HTTP 403"), { status: 403 });
      },
      isTransientLookupError: (e) => (e as { status?: number }).status !== 403,
    });
    assert.equal(calls, 1);
    assert.equal(r403.failed.length, 1);

    calls = 0;
    const r500 = await provisionFormSigs(due7, checks7(), SECRET, {
      getSubscriber: async () => assert.fail("não relê"),
      async setFormSig() {
        calls++;
        throw new Error("HTTP 503");
      },
      isTransientLookupError: () => true,
    }, { retryPasses: 2 });
    assert.equal(calls, 3);
    assert.equal(r500.failed.length, 1);
    assert.equal(r500.fieldMissing, null);
  });

  it("resposta do PATCH sem fields: relê pelo GET singular antes de concluir", async () => {
    const sig = await signFormEmail("7@x.com", SECRET);
    let gets = 0;
    const ok = await provisionFormSigs(due7, checks7(), SECRET, {
      async getSubscriber() {
        gets++;
        return { state: "active", apoioNivel: "", formSig: sig };
      },
      setFormSig: async () => undefined,
    });
    assert.equal(gets, 1);
    assert.deepEqual(ok.ok, due7);
    assert.equal(ok.fieldMissing, null);

    const missing = await provisionFormSigs(due7, checks7(), SECRET, {
      getSubscriber: async () => ({ state: "active", apoioNivel: "", formSig: null }),
      setFormSig: async () => undefined,
    });
    assert.deepEqual(missing.ok, []);
    assert.match(missing.fieldMissing ?? "", /form_sig/);
  });

  it("resposta do PATCH COM fields sem form_sig: campo ausente, sem reler", async () => {
    const r = await provisionFormSigs(due7, checks7(), SECRET, {
      getSubscriber: async () => assert.fail("não relê com fields na resposta"),
      setFormSig: async () => null,
    });
    assert.match(r.fieldMissing ?? "", /form_sig/);
    assert.equal(r.failed.length, 1);
  });
});

describe("#10657 Worker: só grava com assinatura válida para o e-mail", () => {
  function kv() {
    const puts: [string, string][] = [];
    const ns = {
      puts,
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
    return ns;
  }
  function env(withSecret = true) {
    const ns = kv();
    const e = { ONBOARDING_FORM: ns as unknown as KVNamespace, ...(withSecret ? { ONBOARDING_FORM_LINK_SECRET: SECRET } : {}) } as Env;
    return { e, puts: ns.puts };
  }
  /** Respostas mínimas válidas: as obrigatórias com a 1ª opção. */
  function answers(): [string, string][] {
    return FORM_QUESTIONS.filter((q) => q.required && "options" in q).map((q) => [q.id, (q as { options: readonly string[] }).options[0]!]);
  }
  function post(fields: [string, string][]): Request {
    return new Request("https://form.example/enviar", { method: "POST", body: new URLSearchParams(fields) });
  }

  it("GET com assinatura válida mostra o formulário com o e-mail fixo", async () => {
    const sig = await signFormEmail("a+b@x.com", SECRET);
    // `+` cru no link vira espaço na query; o Worker restaura antes de verificar.
    const res = await worker.fetch(new Request(`https://form.example/?email=a+b@x.com&sig=${sig}`), env().e);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('name="sig"') && body.includes('value="a+b@x.com"'));
  });

  it("e-mails com +, & e # chegam inteiros pelo link com url_encode (GET e POST)", async () => {
    for (const email of ["a+b@x.com", "a&b@x.com", "a#b@x.com"]) {
      const sig = await signFormEmail(email, SECRET);
      // O que `{{ subscriber.email_address | url_encode }}` produz.
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

  it("GET sem assinatura ou com assinatura errada: página de link inválido, sem formulário", async () => {
    const sigOutro = await signFormEmail("outro@x.com", SECRET);
    for (const q of ["?email=a@x.com", `?email=a@x.com&sig=${sigOutro}`, "?email=a@x.com&sig=xyz", ""]) {
      const res = await worker.fetch(new Request(`https://form.example/${q}`), env().e);
      assert.equal(res.status, 403, q);
      const body = await res.text();
      assert.ok(body.includes("Link inválido") && !body.includes("<form"), q);
    }
  });

  it("POST com assinatura válida grava", async () => {
    const { e, puts } = env();
    const sig = await signFormEmail("a@x.com", SECRET);
    const res = await worker.fetch(post([["email", "a@x.com"], ["sig", sig], ...answers()]), e);
    assert.equal(res.status, 200);
    assert.equal(puts.length, 1);
    assert.equal(puts[0]![0], "resp:a@x.com");
  });

  it("POST sem assinatura, com assinatura errada ou de OUTRO e-mail: 403 e nada no KV", async () => {
    const sigVitima = await signFormEmail("vitima@x.com", SECRET);
    const sigAtacante = await signFormEmail("atacante@x.com", SECRET);
    const cases: [string, [string, string][]][] = [
      ["sem sig", [["email", "vitima@x.com"], ...answers()]],
      ["sig vazia", [["email", "vitima@x.com"], ["sig", ""], ...answers()]],
      ["sig adulterada", [["email", "vitima@x.com"], ["sig", sigVitima.slice(1) + "A"], ...answers()]],
      ["sig de outro e-mail", [["email", "vitima@x.com"], ["sig", sigAtacante], ...answers()]],
    ];
    for (const [name, fields] of cases) {
      const { e, puts } = env();
      const res = await worker.fetch(post(fields), e);
      assert.equal(res.status, 403, name);
      assert.equal(puts.length, 0, name);
    }
  });

  it("sem o segredo no Worker: 503 not_configured, nada gravado", async () => {
    const { e, puts } = env(false);
    const sig = await signFormEmail("a@x.com", SECRET);
    const res = await worker.fetch(post([["email", "a@x.com"], ["sig", sig], ...answers()]), e);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "not_configured" });
    assert.equal(puts.length, 0);
  });
});
