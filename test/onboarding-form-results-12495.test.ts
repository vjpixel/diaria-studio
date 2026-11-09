/**
 * test/onboarding-form-results-12495.test.ts (#12495)
 *
 * Acesso imediato aos resultados para quem responde o formulário DEPOIS do
 * envio da edição especial (decisão do editor de 09/11/2026: edição especial
 * por e-mail + versão web restrita). Trava:
 *
 *  - antes do registro (`results_url` + `results_published_at`) nada muda:
 *    página de obrigado genérica, ninguém avaliado nem contado;
 *  - registrado: a página de obrigado mostra o link; o executor manda o
 *    e-mail `form_resultados` uma vez, só a quem respondeu pela 1ª vez depois
 *    do envio (quem respondeu antes já recebeu a edição especial, inclusive
 *    se responder de novo no reenvio anual);
 *  - o gate do texto (link dos resultados obrigatório, link do formulário
 *    proibido);
 *  - o Worker e o executor leem os MESMOS valores (wrangler.toml × config).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveFormResults } from "../scripts/lib/onboarding-form-contract.ts";
import {
  formResultsContentGate,
  formResultsStepDue,
  parseFollowupSnippet,
  planFollowup,
  renderStepBody,
  resolveFollowupConfig,
  type FollowupPerson,
  type FollowupSnippets,
} from "../scripts/lib/onboarding-followup.ts";
import { runFollowupRound, type FollowupRoundDeps } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, readStore, writeStore } from "../scripts/lib/onboarding-store.ts";
import { renderThanksHtml } from "../workers/onboarding-form/src/render.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PUBLISHED = "2027-03-01T09:00:00.000Z";
const RESULTS_URL = "https://especial.example/resultados-x7";
const baseRaw = { enabled: true, form_url: "https://f.example/", form_responses_url: "https://f.example/api/respostas" };
const cfgOff = resolveFollowupConfig(baseRaw);
const cfgOn = resolveFollowupConfig({ ...baseRaw, results_url: RESULTS_URL, results_published_at: PUBLISHED });

function person(over: Partial<FollowupPerson> = {}): FollowupPerson {
  return { kit_subscriber_id: 1, email: "a@x.com", cadastro_at: null, sends: [], ...over };
}

const resultsText = parseFollowupSnippet(`<!--\nassunto: "Resultados"\n-->\n<p>Leia: {{RESULTADOS_URL}}</p>`);

describe("#12495 registro dos resultados", () => {
  it("só vale com URL https e instante ISO, os dois", () => {
    assert.equal(resolveFormResults("", ""), null);
    assert.equal(resolveFormResults(RESULTS_URL, ""), null);
    assert.equal(resolveFormResults("", PUBLISHED), null);
    assert.equal(resolveFormResults("http://x.example/r", PUBLISHED), null);
    assert.equal(resolveFormResults(RESULTS_URL, "amanhã"), null);
    assert.deepEqual(resolveFormResults(` ${RESULTS_URL} `, PUBLISHED), { url: RESULTS_URL, published_at: PUBLISHED });
    assert.equal(cfgOff.results, null);
    assert.deepEqual(cfgOn.results, { url: RESULTS_URL, published_at: PUBLISHED });
  });

  it("wrangler.toml e platform.config.json trazem os MESMOS valores (o editor preenche os dois)", () => {
    const toml = readFileSync(join(ROOT, "workers/onboarding-form/wrangler.toml"), "utf8");
    const varOf = (name: string) => {
      const m = toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"));
      assert.ok(m, `${name} declarado no [vars] do wrangler.toml`);
      return m![1];
    };
    const cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")).onboarding.followup;
    assert.equal(varOf("RESULTS_URL"), cfg.results_url ?? "");
    assert.equal(varOf("RESULTS_PUBLISHED_AT"), cfg.results_published_at ?? "");
    assert.ok(/^\[vars\]$/m.test(toml));
  });
});

describe("#12495 página de obrigado", () => {
  it("sem resultados: a genérica de sempre, sem link", () => {
    const html = renderThanksHtml(null);
    assert.ok(html.includes("Em breve você para de receber lembretes"));
    assert.ok(!html.includes("edição especial"));
  });

  it("com resultados: link da versão web, escapado, e a página segue fora da busca", () => {
    const html = renderThanksHtml({ url: 'https://x.example/r?a=1&b="2"', published_at: PUBLISHED });
    assert.ok(html.includes('href="https://x.example/r?a=1&amp;b=&quot;2&quot;"'));
    assert.ok(html.includes("edição especial"));
    assert.ok(!html.includes("Artigo Especial"), "nome reservado ao produto dos apoiadores");
    assert.ok(html.includes('<meta name="robots" content="noindex">'));
  });
});

describe("#12495 quem recebe o e-mail", () => {
  const results = cfgOn.results!;

  it("1ª resposta depois do envio: devido uma vez; antes do envio: já recebeu a edição especial", () => {
    assert.deepEqual(formResultsStepDue(person({ form_filled_at: "2027-03-02T00:00:00Z" }), results), { due: "form_resultados" });
    assert.deepEqual(formResultsStepDue(person({ form_filled_at: "2027-02-28T00:00:00Z" }), results), { due: null, motivo: "recebeu_edicao_especial" });
    assert.deepEqual(formResultsStepDue(person({ form_filled_at: PUBLISHED }), results), { due: null, motivo: "recebeu_edicao_especial" });
    assert.deepEqual(formResultsStepDue(person(), results), { due: null, motivo: "nunca_respondeu" });
    const sent = person({ form_filled_at: "2027-03-02T00:00:00Z", sends: [{ step: "form_resultados", at: "2027-03-02T09:00:00Z", lot_id: "r" }] });
    assert.deepEqual(formResultsStepDue(sent, results), { due: null, motivo: "registrado" });
    const saiu = person({ form_filled_at: "2027-03-02T00:00:00Z", skips: [{ step: "form_resultados", at: "2027-03-02T09:00:00Z", motivo: "nao_ativo" }] });
    assert.deepEqual(formResultsStepDue(saiu, results), { due: null, motivo: "registrado" });
  });

  it("quem respondeu antes e responde de novo (reenvio anual) não recebe: conta a 1ª resposta", () => {
    const p = person({ form_filled_at: "2027-11-01T00:00:00Z", form_first_filled_at: "2026-11-01T00:00:00Z" });
    assert.deepEqual(formResultsStepDue(p, results), { due: null, motivo: "recebeu_edicao_especial" });
  });

  it("planFollowup: sem resultados registrados nada é avaliado nem contado", () => {
    const people = { "1": person({ form_filled_at: "2027-03-02T00:00:00Z" }) };
    const base = { apoioCandidates: [], formCandidates: [], people, nowSec: Date.parse("2027-03-03T00:00:00Z") / 1000, apoioBlocked: null, formBlocked: null };
    const off = planFollowup({ ...base, cfg: cfgOff, resultsBlocked: null });
    assert.deepEqual(off, { due: [], counts: {} });
    assert.deepEqual(planFollowup({ ...base, cfg: cfgOn, resultsBlocked: null }).due.map((d) => d.kind), ["form_resultados"]);
    assert.equal(planFollowup({ ...base, cfg: cfgOn, resultsBlocked: "texto_pendente" }).counts.form_resultados?.bloqueado_texto_pendente, 1);
  });
});

describe("#12495 texto do e-mail", () => {
  it("gate: resultados não registrados, texto ausente, sem o link, ou com o link do formulário travam", () => {
    assert.equal((formResultsContentGate({ form_resultados: resultsText }, cfgOff) as { motivo?: string }).motivo, "resultados_nao_publicados");
    assert.equal((formResultsContentGate({}, cfgOn) as { motivo?: string }).motivo, "snippet_ausente");
    const semLink = parseFollowupSnippet(`<!--\nassunto: "R"\n-->\n<p>Leia</p>`);
    assert.equal((formResultsContentGate({ form_resultados: semLink }, cfgOn) as { motivo?: string }).motivo, "snippet_invalido");
    const comForm = parseFollowupSnippet(`<!--\nassunto: "R"\n-->\n{{RESULTADOS_URL}} {{FORM_URL}}`);
    assert.equal((formResultsContentGate({ form_resultados: comForm }, cfgOn) as { motivo?: string }).motivo, "snippet_invalido");
    assert.deepEqual(formResultsContentGate({ form_resultados: resultsText }, cfgOn), { blocked: false });
  });

  it("renderStepBody troca o link dos resultados", () => {
    assert.equal(renderStepBody("form_resultados", "Leia: {{RESULTADOS_URL}}", { formUrl: "https://f.example/", results: cfgOn.results }), `Leia: ${RESULTS_URL}`);
  });

  it("o rascunho versionado nasce travado e com o link dos resultados", () => {
    const raw = readFileSync(join(ROOT, "context/templates/onboarding-followup/formulario-resultados.md"), "utf8");
    const snip = parseFollowupSnippet(raw)!;
    assert.equal(snip.hasPendingMarker, true);
    assert.ok(snip.body.includes("{{RESULTADOS_URL}}"));
    assert.ok(!snip.body.includes("{{FORM_URL}}"));
    assert.ok(!snip.body.includes("→"));
  });
});

describe("#12495 rodada do executor (sem rede)", () => {
  function setup(): string {
    const p = join(mkdtempSync(join(tmpdir(), "followup-12495-")), "store.json");
    const store = emptyStore();
    store.followup = {
      people: {
        "1": person({ kit_subscriber_id: 1, email: "1@x.com", form_filled_at: "2027-02-10T00:00:00.000Z" }),
        "2": person({ kit_subscriber_id: 2, email: "2@x.com", sends: [{ step: "form", at: "2027-02-20T09:00:00.000Z", lot_id: "f" }] }),
      },
      lots: {},
    };
    writeStore(store, p);
    return p;
  }

  function deps(responses: { email: string; submitted_at: string }[]): FollowupRoundDeps & { bodies: string[]; recipients: string[][]; kinds: string[] } {
    const bodies: string[] = [];
    const recipients: string[][] = [];
    const kinds: string[] = [];
    let seq = 0;
    return {
      bodies,
      recipients,
      kinds,
      async listActiveSubscribers() {
        return [];
      },
      async getSubscriber() {
        return { state: "active", apoioNivel: "" };
      },
      async listEnvioBrevoEmails() {
        return [];
      },
      async fetchFormResponses() {
        return responses;
      },
      async runLot(lot, content) {
        kinds.push(lot.kind);
        bodies.push(content.body);
        recipients.push([...lot.recipient_subscription_ids]);
        lot.broadcast_id = 8000 + ++seq;
        lot.tag_id = 5;
        lot.status = "scheduled";
        lot.send_at = lot.created_at;
      },
    };
  }

  // Apoio e formulário travados (textos pendentes): só o e-mail dos resultados pode sair.
  const snippets: FollowupSnippets = { form_resultados: resultsText };
  const now = Date.parse("2027-03-05T12:00:00Z");

  it("quem respondeu depois do envio recebe o link uma vez; quem respondeu antes, não", async () => {
    const storePath = setup();
    const d = deps([{ email: "2@x.com", submitted_at: "2027-03-04T10:00:00.000Z" }]);
    const r = await runFollowupRound({ storePath, formLinkSecret: null, send: true, cfg: cfgOn, snippets, nowMs: now }, d);
    assert.equal(r.run.form_results_blocked, null);
    assert.deepEqual(d.kinds, ["form_resultados"]);
    assert.deepEqual(d.recipients, [["2"]]);
    assert.ok(d.bodies[0]!.includes(RESULTS_URL));
    const again = await runFollowupRound({ storePath, formLinkSecret: null, send: true, cfg: cfgOn, snippets, nowMs: now + 86_400_000 }, d);
    assert.equal(d.recipients.length, 1, "não manda de novo");
    assert.equal(again.run.lots_created, 0);
    const people = readStore(storePath).store.followup!.people;
    assert.equal(people["2"]!.sends.filter((s) => s.step === "form_resultados").length, 1);
    assert.equal(people["1"]!.sends.filter((s) => s.step === "form_resultados").length, 0);
  });

  it("sem resultados registrados: rodada travada dos dois lados não chama nada (nada muda)", async () => {
    const storePath = setup();
    const d = deps([{ email: "2@x.com", submitted_at: "2027-03-04T10:00:00.000Z" }]);
    let fetched = false;
    d.fetchFormResponses = async () => {
      fetched = true;
      return [];
    };
    const r = await runFollowupRound({ storePath, formLinkSecret: null, send: true, cfg: cfgOff, snippets, nowMs: now }, d);
    assert.equal(fetched, false);
    assert.equal("form_results_blocked" in r.run, false);
    assert.deepEqual(d.recipients, []);
  });

  it("respostas indisponíveis: o e-mail dos resultados trava (nunca adivinha quem respondeu)", async () => {
    const storePath = setup();
    const d = deps([]);
    d.fetchFormResponses = async () => {
      throw new Error("503");
    };
    const r = await runFollowupRound({ storePath, formLinkSecret: null, send: true, cfg: cfgOn, snippets, nowMs: now }, d);
    assert.equal(r.run.form_results_blocked?.motivo, "respostas_indisponiveis");
    assert.deepEqual(d.recipients, []);
  });
});
