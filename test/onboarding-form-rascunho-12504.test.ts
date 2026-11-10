/**
 * test/onboarding-form-rascunho-12504.test.ts (#12504)
 *
 * O formulário v3 tem até 12 perguntas; quem preenchia parte e fechava a
 * página perdia tudo. Agora o rascunho fica no KV do Worker, preso ao link
 * assinado. Trava, com as decisões do editor de 09/11/2026:
 *  - `POST /rascunho`: assinatura, tamanho, rate limit, limpeza tolerante,
 *    TTL de 90 dias, nada depois do envio; o `GET /` retoma com o aviso;
 *  - o envio apaga o rascunho; rascunho NÃO é resposta (lembretes seguem);
 *  - `/api/respostas?rascunhos=1` + `fetchAllFormDrafts`;
 *  - perfil de audiência por pergunta com o N de cada pergunta, cada pessoa
 *    uma vez (a resposta enviada vence o rascunho);
 *  - Q12 "Sim, topo" do rascunho na lista de conversas, marcado "não enviou";
 *  - abandono por pergunta no `--status`;
 *  - lembretes com a variante "rascunho" (lote próprio), que nunca trava o
 *    lembrete quando o texto dela está pendente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FORM_CONVERSA_SIM,
  FORM_DRAFT_TTL_S,
  FORM_QUESTIONS,
  FORM_VERSION,
  decideFormDraftWrite,
  draftPrefill,
  fetchAllFormDrafts,
  formDraftKey,
  formDraftsUrl,
  formResponseKey,
  parseFormDraft,
  parseFormDraftsPage,
  summarizeFormDrafts,
  unsentFormDrafts,
  type FormDraft,
  type FormResponse,
} from "../scripts/lib/onboarding-form-contract.ts";
import { signFormEmail } from "../scripts/lib/onboarding-form-link-sig.ts";
import { onboardingFormToSurveyResponses } from "../scripts/lib/audience-survey-questions.ts";
import { formRespondentsNote, questionNLine, questionRespondents, renderWhoTheyAreBlocks } from "../scripts/update-audience.ts";
import { SURVEY_MATCHERS } from "../scripts/lib/audience-survey-questions.ts";
import { conversaRows, renderConversaTable } from "../scripts/onboarding-form-conversas.ts";
import { formStatusReport, initFollowupSnippets, loadReminderDraftSnippets, runFollowupRound, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import {
  FORM_REMINDER_DRAFT_VARIANTS,
  buildFollowupLotId,
  findLatestFollowupLot,
  parseFollowupSnippet,
  reminderDraftVariantGate,
  resolveFollowupConfig,
  splitReminderRecipientsByDraft,
  type FollowupLot,
  type FollowupPerson,
  type FollowupSnippets,
} from "../scripts/lib/onboarding-followup.ts";
import { emptyStore, readStore, writeStore } from "../scripts/lib/onboarding-store.ts";
import { FORM_AUTOSAVE_NOTICE, FORM_RESUMED_NOTICE, FORM_SCRIPT, renderFormHtml } from "../workers/onboarding-form/src/render.ts";
import worker, { type Env } from "../workers/onboarding-form/src/index.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SECRET = "segredo-de-teste-com-32-caracteres-ou-mais";
const NADA = "Nada me atrapalha";

function kvEnv() {
  const kv = new Map<string, string>();
  const ttl = new Map<string, number | undefined>();
  const ns = {
    async get(k: string) {
      return kv.get(k) ?? null;
    },
    async put(k: string, v: string, o?: { expirationTtl?: number }) {
      kv.set(k, v);
      ttl.set(k, o?.expirationTtl);
    },
    async delete(k: string) {
      kv.delete(k);
    },
    async list({ prefix }: { prefix: string }) {
      return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
  };
  return { kv, ttl, env: { ONBOARDING_FORM: ns as unknown as KVNamespace, RESPONSES_TOKEN: "tok", ONBOARDING_FORM_LINK_SECRET: SECRET } as Env };
}

const draft = (email: string, answers: Record<string, string>, at = "2026-11-09T10:00:00.000Z", last: string | null = null): FormDraft => ({
  email,
  answers,
  updated_at: at,
  last_question: last,
  form_version: FORM_VERSION,
});

describe("#12504 parseFormDraft (limpeza tolerante)", () => {
  it("descarta o que não vale em vez de recusar o rascunho inteiro", () => {
    const r = parseFormDraft({
      email: "A@X.com",
      uso_ia: "opção inventada",
      situacao: "Estudante",
      dificuldades: ["Falta tempo para aprender", "Muita coisa só em inglês", "Não sei qual ferramenta usar para cada coisa", "Preocupação com privacidade ou com os dados que envio", NADA],
      relato_falha: "<b>inventou</b> números",
      desconhecida: "x",
    });
    assert.ok(r);
    assert.equal(r.email, "a@x.com");
    assert.equal(r.answers.uso_ia, undefined, "opção desconhecida some");
    assert.equal(r.answers.situacao, "Estudante");
    assert.equal(r.answers.dificuldades.split(" | ").length, 3, "acima de 'Marque até 3': ficam as 3 primeiras na ordem da pergunta");
    assert.ok(!r.answers.dificuldades.includes(NADA), "exclusiva junto com outras: sai a exclusiva");
    assert.equal(r.answers.relato_falha, "inventou números", "mesma limpeza das respostas");
    assert.equal(r.answers.desconhecida, undefined);
    assert.equal(r.last_question, "relato_falha");
  });

  it("escolha única fora das marcadas some; pergunta escondida some; e-mail inválido = null", () => {
    const r = parseFormDraft({
      email: "a@x.com",
      produto_formato: ["Curso online gravado, no meu ritmo", "Aula ou workshop ao vivo"],
      produto_escolha: "Mentoria individual ou em grupo pequeno",
      quem_paga: "Ninguém: só uso versões gratuitas",
      gasto_mensal: "Até R$ 50",
    });
    assert.equal(r!.answers.produto_escolha, undefined);
    assert.equal(r!.answers.gasto_mensal, undefined, "gasto mensal só aparece para quem paga do bolso");
    assert.equal(parseFormDraft({ email: "x" }), null);
  });

  it("draftPrefill relê o rascunho guardado pelas perguntas atuais e confere o e-mail", () => {
    const raw = JSON.stringify(draft("a@x.com", { situacao: "Estudante", area: "Opção que saiu", dificuldades: "Falta tempo para aprender | Muita coisa só em inglês" }));
    assert.deepEqual(draftPrefill(raw, "A@x.com"), { situacao: "Estudante", dificuldades: "Falta tempo para aprender | Muita coisa só em inglês" });
    assert.equal(draftPrefill(raw, "b@x.com"), null, "rascunho de outro e-mail não preenche");
    assert.equal(draftPrefill("{lixo", "a@x.com"), null);
    assert.equal(draftPrefill(null, "a@x.com"), null);
  });

  it("draftPrefill não retoma rascunho mais antigo que a resposta enviada (delete do envio falhou)", () => {
    const raw = JSON.stringify(draft("a@x.com", { situacao: "Estudante" }, "2026-11-09T10:00:00.000Z"));
    const resp = (at: string) => JSON.stringify({ email: "a@x.com", submitted_at: at, answers: { situacao: "Estudante" } });
    assert.equal(draftPrefill(raw, "a@x.com", undefined, resp("2026-11-09T10:05:00.000Z")), null, "enviou depois do rascunho: sem aviso de retomada");
    assert.deepEqual(draftPrefill(raw, "a@x.com", undefined, resp("2026-11-08T10:00:00.000Z")), { situacao: "Estudante" }, "rascunho novo depois de um envio antigo: retoma");
    assert.deepEqual(draftPrefill(raw, "a@x.com", undefined, "{lixo"), { situacao: "Estudante" }, "resposta ilegível não impede a retomada");
  });
});

describe("#12504 decideFormDraftWrite", () => {
  const now = Date.parse("2026-11-09T10:00:10.000Z");
  it("grava, apaga (tudo desmarcado), limita por e-mail e ignora o beacon pós-envio", () => {
    assert.deepEqual(decideFormDraftWrite(2, null, null, now), { action: "write" });
    assert.deepEqual(decideFormDraftWrite(0, null, null, now), { action: "delete" });
    const prev = JSON.stringify({ updated_at: new Date(now - 500).toISOString() });
    assert.deepEqual(decideFormDraftWrite(2, prev, null, now), { action: "skip", reason: "rate_limited" });
    const old = JSON.stringify({ updated_at: new Date(now - 5_000).toISOString() });
    assert.deepEqual(decideFormDraftWrite(2, old, null, now), { action: "write" });
    const justSent = JSON.stringify({ submitted_at: new Date(now - 30_000).toISOString() });
    assert.deepEqual(decideFormDraftWrite(2, null, justSent, now), { action: "skip", reason: "after_submit" });
    const sentLongAgo = JSON.stringify({ submitted_at: "2025-11-01T00:00:00.000Z" });
    assert.deepEqual(decideFormDraftWrite(2, null, sentLongAgo, now), { action: "write" }, "quem respondeu há um ano recomeça (reenvio anual)");
    assert.deepEqual(decideFormDraftWrite(2, "{lixo", "{lixo", now), { action: "write" });
  });
});

describe("#12504 Worker", () => {
  it("POST /rascunho: sem assinatura válida = 403 e nada no KV", async () => {
    const { kv, env } = kvEnv();
    const res = await worker.fetch(new Request("https://f.example/rascunho", { method: "POST", body: new URLSearchParams([["email", "a@x.com"], ["sig", "x"], ["situacao", "Estudante"]]) }), env);
    assert.equal(res.status, 403);
    assert.equal(kv.size, 0);
  });

  it("POST /rascunho grava com TTL de 90 dias; corpo grande = 413; GET / retoma com o aviso", async () => {
    const { kv, ttl, env } = kvEnv();
    const sig = await signFormEmail("a@x.com", SECRET);
    const body = new URLSearchParams([["email", "a@x.com"], ["sig", sig], ["situacao", "Estudante"], ["relato_falha", "inventou"]]);
    const res = await worker.fetch(new Request("https://f.example/rascunho", { method: "POST", body }), env);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), JSON.stringify({ ok: true }), "a resposta nunca devolve o conteúdo");
    const saved = JSON.parse(kv.get(formDraftKey("a@x.com"))!) as FormDraft;
    assert.deepEqual(saved.answers, { situacao: "Estudante", relato_falha: "inventou" });
    assert.equal(saved.last_question, "relato_falha");
    assert.equal(ttl.get(formDraftKey("a@x.com")), FORM_DRAFT_TTL_S);
    assert.equal(kv.has(formResponseKey("a@x.com")), false, "rascunho não é resposta");

    const big = new URLSearchParams([["email", "a@x.com"], ["sig", sig], ["relato_falha", "x".repeat(40_000)]]);
    const r413 = await worker.fetch(new Request("https://f.example/rascunho", { method: "POST", body: big }), env);
    assert.equal(r413.status, 413);

    const page = await (await worker.fetch(new Request(`https://f.example/?email=a@x.com&sig=${encodeURIComponent(sig)}`), env)).text();
    assert.ok(page.includes(`<p class="aviso">${FORM_RESUMED_NOTICE}</p>`));
    assert.match(page, /name="situacao" value="Estudante" required checked/);
    assert.ok(page.includes(">inventou</textarea>"));
    assert.ok(page.includes('data-draft="/rascunho"'));
  });

  it("segunda gravação em menos de 1 s = 429; envio apaga o rascunho; beacon logo depois do envio não o ressuscita", async () => {
    const { kv, env } = kvEnv();
    const sig = await signFormEmail("a@x.com", SECRET);
    const post = (pairs: [string, string][]) =>
      worker.fetch(new Request("https://f.example/rascunho", { method: "POST", body: new URLSearchParams([["email", "a@x.com"], ["sig", sig], ...pairs]) }), env);
    assert.equal((await post([["situacao", "Estudante"]])).status, 200);
    assert.equal((await post([["situacao", "Servidor(a) público(a)"]])).status, 429);

    const required = FORM_QUESTIONS.filter((q) => q.required && !q.shownWhen && "options" in q && q.options).map((q) => [q.id, q.options![0]!] as [string, string]);
    // #12587: a 1ª opção de quem_paga é "do bolso", então o gasto mensal aparece e é obrigatório.
    required.push(["gasto_mensal", "Até R$ 50"]);
    const sent = await worker.fetch(new Request("https://f.example/enviar", { method: "POST", body: new URLSearchParams([["email", "a@x.com"], ["sig", sig], ...required]) }), env);
    assert.equal(sent.status, 200);
    assert.equal(kv.has(formDraftKey("a@x.com")), false, "o envio apaga o rascunho");
    const late = await post([["situacao", "Estudante"]]);
    assert.equal(late.status, 202);
    assert.equal(kv.has(formDraftKey("a@x.com")), false, "o beacon pós-envio é ignorado");
  });

  it("GET /api/respostas?rascunhos=1 exige o token e lista os rascunhos; fetchAllFormDrafts lê", async () => {
    const { kv, env } = kvEnv();
    kv.set(formDraftKey("a@x.com"), JSON.stringify(draft("a@x.com", { situacao: "Estudante" })));
    kv.set(formResponseKey("b@x.com"), JSON.stringify({ email: "b@x.com", submitted_at: "2026-11-01T00:00:00.000Z", answers: {} }));
    const unauth = await worker.fetch(new Request("https://f.example/api/respostas?rascunhos=1"), env);
    assert.equal(unauth.status, 401);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => worker.fetch(new Request(String(input), init), env)) as typeof fetch;
    const drafts = await fetchAllFormDrafts("https://f.example/api/respostas", "tok", { fetchImpl });
    assert.deepEqual(drafts.map((d) => d.email), ["a@x.com"], "só rascunhos, nunca respostas");
    assert.equal(formDraftsUrl("https://f.example/api/respostas?historico=1"), "https://f.example/api/respostas?rascunhos=1");
    assert.throws(() => parseFormDraftsPage({ responses: [] }), /sem o array `drafts`/);
  });

  it("a página só promete o salvamento com JavaScript; sem autosave não há rota nem aviso", () => {
    const html = renderFormHtml("a@x.com", "S");
    assert.ok(html.includes(`<span class="js-only" hidden>${FORM_AUTOSAVE_NOTICE} </span>`));
    assert.match(FORM_SCRIPT, /js\[z\]\.hidden=false/);
    assert.match(FORM_SCRIPT, /sendBeacon/);
    assert.match(FORM_SCRIPT, /addEventListener\('submit',function\(\)\{sent=true/);
    const off = renderFormHtml("a@x.com", "S", undefined, null, { autosave: false });
    assert.ok(!off.includes('data-draft="') && !off.includes(FORM_AUTOSAVE_NOTICE));
  });
});

describe("#12504 consumidores dos rascunhos", () => {
  const responses: FormResponse[] = [{ email: "b@x.com", submitted_at: "2026-11-01T00:00:00.000Z", answers: { situacao: "Estudante", conversa: FORM_CONVERSA_SIM } }];
  const drafts = [
    draft("a@x.com", { situacao: "Servidor(a) público(a)", conversa: FORM_CONVERSA_SIM }, undefined, "conversa"),
    draft("b@x.com", { situacao: "Autônomo(a) ou freelancer" }, undefined, "situacao"), // b já enviou: a resposta vence
    draft("c@x.com", { uso_ia: "Uso pouco: só testei ou uso de vez em quando" }, undefined, "uso_ia"),
    draft("d@x.com", {}),
  ];

  it("unsentFormDrafts: só quem não enviou e tem alguma resposta", () => {
    assert.deepEqual(unsentFormDrafts(drafts, responses).map((d) => d.email), ["a@x.com", "c@x.com"]);
  });

  it("perfil: cada pessoa uma vez, rascunho marcado, N por pergunta", () => {
    const conv = onboardingFormToSurveyResponses(responses, undefined, drafts);
    assert.equal(conv.responses.length, 3);
    assert.equal(conv.responses.filter((r) => r.draft === true).length, 2);
    const situacao = questionRespondents(conv.responses, SURVEY_MATCHERS.situation);
    assert.deepEqual(situacao, { total: 2, drafts: 1 }, "b conta pela resposta enviada, não pelo rascunho");
    assert.deepEqual(questionRespondents(conv.responses, SURVEY_MATCHERS.aiUse), { total: 1, drafts: 1 });
    const block = renderWhoTheyAreBlocks(conv.responses).join("\n");
    assert.ok(block.includes("N = 2 pessoas (1 sem enviar o formulário)."), block);
    assert.ok(!block.includes("Autônomo"), "o rascunho de quem já enviou não entra");
    assert.match(formRespondentsNote(conv.responses), /3 do formulário do onboarding, 2 sem enviar/);
    assert.equal(questionNLine({ total: 1, drafts: 0 }), "N = 1 pessoa.");
  });

  it("conversas: 'Sim, topo' do rascunho entra marcado 'não enviou'", () => {
    const rows = conversaRows(responses, {}, drafts);
    assert.deepEqual(rows.map((r) => [r.email, r.enviou]).sort(), [["a@x.com", false], ["b@x.com", true]]);
    assert.match(renderConversaTable(rows), /a@x\.com {2}\(não enviou\)/);
  });

  it("--status: abandono por pergunta numerada (subpergunta conta na mãe)", () => {
    const s = summarizeFormDrafts([draft("a@x.com", {}, undefined, "relato_falha"), draft("c@x.com", {}, undefined, "uso_ia"), draft("e@x.com", {}, undefined, null)]);
    assert.deepEqual(s, { rascunhos: 3, parou_na_pergunta: { "1 uso_ia": 1, "7 dificuldades": 1, "?": 1 } });
    const rep = formStatusReport(responses, drafts);
    assert.deepEqual((rep.abandono as { rascunhos: number }).rascunhos, 2);
    assert.deepEqual(formStatusReport(responses, "falhou").abandono, { erro: "falhou" });
  });
});

describe("#12504 variante 'rascunho' dos lembretes", () => {
  const variants = loadReminderDraftSnippets(resolve(ROOT, "context/templates/onboarding-followup"));

  it("os textos versionados nascem pendentes, com o link e o 1º parágrafo do editor", () => {
    for (const v of FORM_REMINDER_DRAFT_VARIANTS) {
      const s = variants[v.kind]!;
      assert.equal(s.hasPendingMarker, true, v.snippetFile);
      assert.ok(s.body.includes("{{FORM_URL}}"), v.snippetFile);
      assert.equal(reminderDraftVariantGate(v.kind, variants).blocked, true, "pendente = travada");
    }
    assert.ok(variants.form_lembrete!.body.includes("Você começou o formulário e parou no meio. O que você já marcou está salvo, então é só continuar de onde parou."));
    assert.ok(variants.form_lembrete2!.body.includes("As suas estão pela metade, e o que você já marcou continua salvo."));
    assert.ok(variants.form_lembrete3!.body.includes("Suas respostas continuam salvas: se quiser terminar, o link está aqui embaixo."));
    // Mesmo assunto do lembrete padrão.
    for (const [v, base] of [["formulario-lembrete-1-rascunho.md", "formulario-lembrete-1.md"]]) {
      const head = (f: string) => readFileSync(resolve(ROOT, "context/templates/onboarding-followup", f), "utf8").match(/assunto: "[^"]+"/)![0];
      assert.equal(head(v), head(base));
    }
  });

  it("--init-snippets semeia as variantes com o marcador", () => {
    const dir = mkdtempSync(join(tmpdir(), "followup-12504-"));
    initFollowupSnippets(dir);
    const seeded = loadReminderDraftSnippets(dir);
    for (const v of FORM_REMINDER_DRAFT_VARIANTS) assert.equal(seeded[v.kind]?.hasPendingMarker, true, v.snippetFile);
  });

  it("lote da variante tem sequência própria", () => {
    assert.equal(buildFollowupLotId("form_lembrete", "2026-12-01", 1, "rascunho"), "form_lembrete-rascunho-2026-12-01-01");
    const lot = (id: string, variant?: "rascunho") => ({ lot_id: id, kind: "form_lembrete", ...(variant ? { variant } : {}) }) as FollowupLot;
    const lots = { a: lot("form_lembrete-2026-12-01-01"), b: lot("form_lembrete-rascunho-2026-12-01-01", "rascunho") };
    assert.equal(findLatestFollowupLot(lots, "form_lembrete", "2026-12-01")?.lot.lot_id, "form_lembrete-2026-12-01-01");
    assert.equal(findLatestFollowupLot(lots, "form_lembrete", "2026-12-01", "rascunho")?.lot.lot_id, "form_lembrete-rascunho-2026-12-01-01");
  });

  it("split casa também pelo e-mail anterior da pessoa", () => {
    const people = { "2": { kit_subscriber_id: 2, email: "novo@x.com", cadastro_at: null, sends: [], previous_emails: ["velho@x.com"] } as FollowupPerson };
    const r = splitReminderRecipientsByDraft([{ kit_subscriber_id: 1, email: "a@x.com" }, { kit_subscriber_id: 2, email: "novo@x.com" }, { kit_subscriber_id: 3, email: "c@x.com" }], new Set(["a@x.com", "velho@x.com"]), people);
    assert.deepEqual(r.rascunho.map((x) => x.kit_subscriber_id), [1, 2]);
    assert.deepEqual(r.padrao.map((x) => x.kit_subscriber_id), [3]);
    assert.deepEqual(splitReminderRecipientsByDraft([{ kit_subscriber_id: 1, email: "a@x.com" }], null, {}).rascunho, []);
  });

  describe("rodada do executor (sem rede)", () => {
    const cfg = resolveFollowupConfig({ enabled: true, form_url: "https://f.example/", form_responses_url: "https://f.example/api/respostas" });
    const ok = (txt: string) => parseFollowupSnippet(`<!--\nassunto: "Viu meu pedido?"\n-->\n${txt} {{FORM_URL}}`);
    const snippets: FollowupSnippets = { form: ok("convite"), form_lembrete: ok("PADRAO"), form_lembrete2: ok("PADRAO2"), form_lembrete3: ok("PADRAO3") };
    const NOW = Date.parse("2026-12-20T12:00:00Z");

    function setup(): string {
      const p = join(mkdtempSync(join(tmpdir(), "followup-12504-run-")), "store.json");
      const store = emptyStore();
      const base = new Date(NOW - 40 * 86_400_000).toISOString();
      const person = (id: number): FollowupPerson => ({
        kit_subscriber_id: id,
        email: `${id}@x.com`,
        cadastro_at: null,
        sends: [{ step: "form_base", at: base, lot_id: "b" }],
        form_invite: "form_base",
      });
      store.followup = { people: { "1": person(1), "2": person(2) }, lots: {} };
      writeStore(store, p);
      return p;
    }

    function deps(over: Partial<FollowupRoundDeps> = {}): FollowupRoundDeps & { lots: { lot: FollowupLot; body: string }[] } {
      const lots: { lot: FollowupLot; body: string }[] = [];
      let seq = 0;
      return {
        lots,
        listActiveSubscribers: async () => [],
        getSubscriber: async () => ({ state: "active", apoioNivel: "" }),
        listEnvioBrevoEmails: async () => [],
        setFormSig: async (_id: number, sig: string) => ({ kind: "stored" as const, value: sig }),
        probeFormLink: async () => ({ status: 200, bodyHasForm: true }),
        fetchFormResponses: async () => [],
        fetchFormDrafts: async () => [draft("2@x.com", { situacao: "Estudante" })],
        async runLot(lot, content) {
          lots.push({ lot: { ...lot }, body: content.body });
          lot.broadcast_id = 7000 + ++seq;
          lot.tag_id = 5;
          lot.status = "scheduled";
          lot.send_at = lot.created_at;
        },
        ...over,
      };
    }

    it("variante aprovada: quem tem rascunho sai num lote próprio com o texto dela; os dois contam como o mesmo lembrete", async () => {
      const storePath = setup();
      const d = deps();
      const reminderDraftSnippets = { form_lembrete: ok("RASCUNHO") };
      const r = await runFollowupRound({ storePath, formLinkSecret: SECRET, send: true, cfg, snippets, reminderDraftSnippets, nowMs: NOW }, d);
      assert.equal(r.run.form_blocked, null);
      const byVariant = Object.fromEntries(d.lots.map((x) => [x.lot.variant ?? "padrao", x]));
      assert.deepEqual(byVariant.padrao!.lot.recipient_subscription_ids, ["1"]);
      assert.deepEqual(byVariant.rascunho!.lot.recipient_subscription_ids, ["2"]);
      assert.ok(byVariant.padrao!.body.includes("PADRAO") && !byVariant.padrao!.body.includes("RASCUNHO"));
      assert.ok(byVariant.rascunho!.body.includes("RASCUNHO"));
      assert.equal(r.run.counts.form_lembrete?.enviado, 2);
      assert.equal(r.run.counts.form_lembrete?.enviado_rascunho, 1);
      const people = readStore(storePath).store.followup!.people;
      assert.ok(people["2"]!.sends.some((s) => s.step === "form_lembrete"), "a variante registra o mesmo lembrete");
      assert.equal(people["2"]!.form_filled_at ?? null, null, "rascunho não marca 'preencheu'");
    });

    it("variante pendente: todo mundo no texto padrão, num lote só (nada sai com texto não aprovado)", async () => {
      const storePath = setup();
      const d = deps();
      const r = await runFollowupRound({ storePath, formLinkSecret: SECRET, send: true, cfg, snippets, reminderDraftSnippets: variants, nowMs: NOW }, d);
      assert.equal(d.lots.length, 1);
      assert.deepEqual(d.lots[0]!.lot.recipient_subscription_ids, ["1", "2"]);
      assert.equal(d.lots[0]!.lot.variant, undefined);
      assert.equal(r.run.form_blocked, null);
    });

    it("rascunhos ilegíveis: lembrete sai no padrão e a rodada não conta como falha", async () => {
      const storePath = setup();
      const d = deps({ fetchFormDrafts: async () => Promise.reject(new Error("HTTP 503")) });
      const r = await runFollowupRound({ storePath, formLinkSecret: SECRET, send: true, cfg, snippets, reminderDraftSnippets: { form_lembrete: ok("RASCUNHO") }, nowMs: NOW }, d);
      assert.equal(d.lots.length, 1);
      assert.equal(d.lots[0]!.lot.variant, undefined);
      assert.match(r.run.form_drafts_unavailable ?? "", /503/);
      assert.equal(r.run.lookups_failed, 0);
    });
  });
});
