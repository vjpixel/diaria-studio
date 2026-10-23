/**
 * test/circle-stack.test.ts (#10904)
 *
 * Publicador semanal no Circle da Stack via webhook n8n da Stack: payload
 * `{titulo, corpo}` em Markdown, confirmação `{ok:true}` + timeout, seleção
 * por interesse, render do post, idempotência em dois tempos por ciclo,
 * decisão/conteúdo do aviso ao editor e resolução de config/ciclo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStackPostPayload, sendStackPost } from "../scripts/lib/stack-webhook.ts";
import {
  renderCircleStackPost,
  circleStackTitle,
  buildCircleStackUrl,
  DEFAULT_CIRCLE_STACK_OPENING,
  type CircleStackItem,
  type CircleStackSelection,
} from "../scripts/lib/circle-stack-render.ts";
import { scoreCandidate, selectCircleStack, parseInterestProfile } from "../scripts/lib/circle-stack-select.ts";
import type { WeeklyRawCandidate } from "../scripts/lib/weekly-linkedin-parse.ts";
import {
  resolveCircleStackConfig,
  readCircleStackPublishedState,
  circleStackPublishBlockReason,
  buildCircleStackReadyFinding,
  buildCircleStackAmbiguousFinding,
  decideCircleStackNotify,
  publishCircleStackCycle,
  parseStoredCircleStackSelection,
  closeCircleStackNotifyIssues,
  closeStaleCircleStackNotifyIssues,
  planStaleCircleStackNotifyCloses,
  circleStackCycleFromFingerprint,
  circleStackCycleStateFromDisk,
} from "../scripts/publish-circle-stack.ts";
import { resolveCircleStackState } from "../scripts/lib/publish-state.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";
import { currentOrPreviousMondayAAMMDD } from "../scripts/lib/weekly-linkedin-cycle.ts";
import { alarmFindingMarker } from "../scripts/lib/alarm-issues.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const item = (over: Partial<CircleStackItem>): CircleStackItem => ({
  editionDate: "261013", url: "https://ex.com/x", title: "T", body: "Corpo.", why: "", ...over,
});

const selection: CircleStackSelection = {
  cycle: "26w42",
  contentWindow: ["261012", "261013", "261014", "261015", "261016"],
  destaques: [
    item({ url: "https://cloud.google.com/blog/x", title: "Gemini vira colega com e-mail & agenda", body: "Parágrafo um.\n\nParágrafo dois.", why: "Porque sim." }),
    item({ editionDate: "261099", url: "https://ex.com/a", title: "Sem edição" }),
  ],
  lancamentos: [item({ url: "https://ex.com/l", title: "Lovable 3", body: "Lançou.", stackNote: "Nota para builders." })],
  useMelhor: [item({ url: "https://ex.com/um", title: "Curso grátis", body: "Descrição." })],
  radar: [],
  weeklyEditions: [{ editionDate: "261013", url: "https://diar.ia.br/p/gemini", destaques: ["A", "B", "C"] }],
};

describe("buildStackPostPayload", () => {
  it("monta titulo/corpo", () => {
    assert.deepEqual(buildStackPostPayload("T", "**x**"), { titulo: "T", corpo: "**x**" });
  });
  it("recusa vazio, HTML e imagem (o webhook remove/recusa)", () => {
    assert.throws(() => buildStackPostPayload(" ", "x"), /Título/);
    assert.throws(() => buildStackPostPayload("T", "<p>x</p>"), /HTML/);
    assert.throws(() => buildStackPostPayload("T", "![a](https://x/a.png)"), /imagem/);
  });
});

describe("sendStackPost", () => {
  const url = "https://n8n.example/webhook/x";
  function fake(status: number, body: string, seen: RequestInit[] = []) {
    return (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response(body, { status });
    }) as unknown as typeof fetch;
  }
  const payload = { titulo: "T", corpo: "c" };

  it("200 com ok:true é sucesso e manda a chave no header", async () => {
    const seen: RequestInit[] = [];
    await sendStackPost(url, "k", payload, fake(200, '{"ok": true}', seen));
    assert.equal((seen[0].headers as Record<string, string>)["X-Webhook-Key"], "k");
    assert.deepEqual(JSON.parse(seen[0].body as string), payload);
  });
  it("200 sem ok:true não confirma publicação", async () => {
    await assert.rejects(sendStackPost(url, "k", payload, fake(200, "{}")), /não confirmada/);
    await assert.rejects(sendStackPost(url, "k", payload, fake(200, "aceito")), /não confirmada/);
  });
  it("502 vira erro do Circle; outro status vira HTTP", async () => {
    await assert.rejects(sendStackPost(url, "k", payload, fake(502, "")), /Circle recusou/);
    await assert.rejects(sendStackPost(url, "k", payload, fake(401, "")), /HTTP 401/);
  });
  it("sem URL, URL http ou sem chave não chama a rede", async () => {
    const seen: RequestInit[] = [];
    await assert.rejects(sendStackPost("", "k", payload, fake(200, '{"ok":true}', seen)), /STACK_WEBHOOK_URL/);
    await assert.rejects(sendStackPost("http://x", "k", payload, fake(200, '{"ok":true}', seen)), /https/);
    await assert.rejects(sendStackPost(url, "", payload, fake(200, '{"ok":true}', seen)), /STACK_WEBHOOK_KEY/);
    assert.equal(seen.length, 0);
  });
  it("manda AbortSignal e rejeita quando o webhook não responde no prazo", async () => {
    const hanging = ((_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        assert.ok(init.signal, "fetch sem signal");
        init.signal.addEventListener("abort", () => rej(init.signal?.reason));
      })) as unknown as typeof fetch;
    await assert.rejects(sendStackPost(url, "k", payload, hanging, 20), /timeout|abort/i);
  });
});

describe("renderCircleStackPost", () => {
  const { title, markdown: md } = renderCircleStackPost(selection);

  it("título cobre segunda a sexta da semana de conteúdo", () => {
    assert.equal(title, "Semana de 12/10 a 16/10");
    assert.equal(circleStackTitle(["261012"]), "Semana de 12/10 a 12/10");
  });

  it("sai em Markdown, sem nenhuma tag HTML", () => {
    assert.ok(!/<\/?[a-z][^>]*>/i.test(md));
    assert.doesNotThrow(() => buildStackPostPayload(title, md));
  });

  it("título do destaque vira link para a fonte; abertura default", () => {
    assert.ok(md.includes("### [Gemini vira colega com e-mail & agenda](https://cloud.google.com/blog/x)"));
    assert.ok(md.includes(DEFAULT_CIRCLE_STACK_OPENING));
  });

  it("destaque sem 'Por que isso importa' (nem why nem stackNote entram)", () => {
    assert.ok(!md.includes("Por que isso importa"));
    assert.ok(!md.includes("Porque sim."));
  });

  it("fonte sem UTM; edição e CTA com UTM stack/circle", () => {
    assert.ok(md.includes("](https://cloud.google.com/blog/x)"));
    assert.ok(!md.includes("Leia na fonte"));
    assert.ok(!md.includes("Na edição de"));
    assert.ok(md.includes(`(${buildCircleStackUrl("https://diar.ia.br/p/gemini", "26w42", "edicao")})`));
    assert.ok(md.includes("utm_content=cta-fim"));
  });

  it("última linha: link de assinatura e fecho na mesma linha, no fim do post", () => {
    const cta = `[Assine a diar.ia.br](${buildCircleStackUrl("https://diar.ia.br", "26w42", "cta-fim")}). Chega de segunda a sexta, de graça, no seu e-mail.`;
    assert.ok(md.trimEnd().endsWith(cta));
    assert.ok(!md.includes("Assinar a diar.ia.br"));
  });

  it("fecho de várias linhas: anteriores antes, a última junta ao CTA, que fica no fim", () => {
    const r = renderCircleStackPost(selection, { closing: "Obrigado por ler.\nVolte toda segunda." });
    const tail = r.markdown.trimEnd().split("\n\n").slice(-2);
    assert.equal(tail[0], "Obrigado por ler.");
    assert.ok(/^\[Assine a diar\.ia\.br\]\([^)]*\)\. Volte toda segunda\.$/.test(tail[1]));
  });

  it("fecho só com espaços cai no default", () => {
    const r = renderCircleStackPost(selection, { closing: "   " });
    assert.ok(r.markdown.trimEnd().endsWith(". Chega de segunda a sexta, de graça, no seu e-mail."));
  });

  it("subscribeUrl alternativo vai na última linha", () => {
    const r = renderCircleStackPost(selection, { subscribeUrl: "https://go.pm3.com.br/x" });
    assert.ok(r.markdown.trimEnd().endsWith("[Assine a diar.ia.br](https://go.pm3.com.br/x). Chega de segunda a sexta, de graça, no seu e-mail."));
  });

  it("título do destaque com colchetes, parênteses e barra invertida não quebra o link", () => {
    const r = renderCircleStackPost({ ...selection, destaques: [item({ title: "Modelo [beta] \\", url: "https://ex.com/a_(b)" })] });
    assert.ok(r.markdown.includes("### [Modelo (beta) \\\\](https://ex.com/a_%28b%29)"));
  });

  it("edições da semana ignoram título vazio", () => {
    const r = renderCircleStackPost({ ...selection, weeklyEditions: [{ editionDate: "261013", url: "https://diar.ia.br/p/g", destaques: ["A", "  ", "B"] }] });
    assert.ok(r.markdown.includes("- A\n- B"));
    assert.ok(!/^- $/m.test(r.markdown));
  });

  it("edições da semana: data com link em parágrafo próprio e um título por linha", () => {
    const d = `[13/10](${buildCircleStackUrl("https://diar.ia.br/p/gemini", "26w42", "edicao")})`;
    assert.ok(md.includes(`${d}\n\n- A\n- B\n- C`));
    assert.ok(!md.includes(" · "));
    // Regressão: link dentro de negrito sai como Markdown cru no Circle da Stack.
    assert.ok(!/\*\*\[[^\]]*\]\([^)]*\)\*\*/.test(md));
  });

  it("nunca usa seta (#9721)", () => {
    assert.ok(!/[→←]/.test(md));
  });

  it("stackNote substitui a descrição no item de lista; seção vazia some", () => {
    assert.ok(md.includes("## Lançamentos\n\n- [Lovable 3](https://ex.com/l): Nota para builders."));
    assert.ok(!md.includes("## Radar"));
  });

  it("stackNote no destaque é ignorado", () => {
    const r = renderCircleStackPost({ ...selection, destaques: [item({ why: "Original.", stackNote: "Para quem constrói." })] });
    assert.ok(!r.markdown.includes("Para quem constrói."));
    assert.ok(!r.markdown.includes("Original."));
  });

  it("colchetes no rótulo e parênteses na URL não quebram o link", () => {
    const r = renderCircleStackPost({ ...selection, lancamentos: [item({ title: "Modelo [beta]", url: "https://ex.com/a_(b)", body: "" })] });
    assert.ok(r.markdown.includes("- [Modelo (beta)](https://ex.com/a_%28b%29)"));
  });

  it("subscribeUrl alternativo entra sem UTM adicionada", () => {
    const r = renderCircleStackPost(selection, { subscribeUrl: "https://go.pm3.com.br/x" });
    assert.ok(r.markdown.includes("(https://go.pm3.com.br/x)"));
    assert.ok(!r.markdown.includes("utm_content=cta-fim"));
  });

  it("seleção sem destaques é erro", () => {
    assert.throws(() => renderCircleStackPost({ ...selection, destaques: [] }), /sem destaques/);
  });
});

describe("config", () => {
  it("interests do config substituem o perfil default; inválido é erro", () => {
    const c = resolveCircleStackConfig({ circle_stack: { interests: [{ pattern: "foo", weight: 1 }] } });
    assert.deepEqual(c.interests, [{ label: "foo", pattern: "foo", weight: 1 }]);
    assert.throws(() => parseInterestProfile([{ pattern: "x" }]), /weight/);
    assert.throws(() => parseInterestProfile([]), /não vazia/);
  });
});

const cand = (over: Partial<WeeklyRawCandidate>): WeeklyRawCandidate => ({
  editionDate: "261013", url: `https://ex.com/${Math.random()}`, title: "Título neutro", body: "Corpo neutro.",
  why: "", kind: "section", category: "RADAR", section: "radar", ...over,
});

describe("scoreCandidate", () => {
  it("título pesa em dobro e registra os termos casados", () => {
    const s = scoreCandidate(cand({ title: "Lovable lança agentes", body: "" }));
    assert.equal(s.score, 4 * 2 + 3 * 2);
    assert.deepEqual(s.matchedTerms, ["Lovable", "agentes"]);
  });
  it("respeita borda de palavra (apple não casa app; cursorial não casa cursor)", () => {
    assert.equal(scoreCandidate(cand({ title: "Apple e o cursorial", body: "" })).score, 0);
  });
  it("bônus de seção prática", () => {
    assert.equal(scoreCandidate(cand({ section: "lancamentos" })).score, 2);
  });
});

describe("selectCircleStack", () => {
  it("prioriza destaques aderentes e completa o mínimo mesmo sem aderência", () => {
    const picks = selectCircleStack([
      cand({ kind: "destaque", section: "destaque", title: "Eleição e TSE" }),
      cand({ kind: "destaque", section: "destaque", title: "Cursor ganha agentes" }),
    ]);
    assert.equal(picks.destaques.length, 2);
    assert.equal(picks.destaques[0].title, "Cursor ganha agentes");
  });
  it("seções exigem aderência acima do bônus; URL nunca repete; links próprios saem", () => {
    const picks = selectCircleStack([
      cand({ url: "https://a.com/1", kind: "destaque", section: "destaque", title: "n8n 2.0" }),
      cand({ url: "https://a.com/1", section: "radar", title: "n8n 2.0" }),
      cand({ section: "lancamentos", title: "Modelo de imagem" }),
      cand({ section: "lancamentos", title: "Replit Agent" }),
      cand({ url: "https://diar.ia.br/p/x", section: "radar", title: "Claude Code" }),
    ]);
    assert.deepEqual(picks.lancamentos.map((c) => c.title), ["Replit Agent"]);
    assert.equal(picks.radar.length, 0);
    assert.equal(picks.destaques[0].title, "n8n 2.0");
  });
});

describe("estado de publicação do ciclo via resolver (#10904, #573)", () => {
  const dir = mkdtempSync(join(tmpdir(), "circle-stack-state-"));

  it("arquivo ausente → draft → --publish liberado", () => {
    const p = join(dir, "ausente.json");
    const state = resolveCircleStackState(readCircleStackPublishedState(p), "26w42");
    assert.equal(state, "draft");
    assert.equal(circleStackPublishBlockReason(state, "26w42", p), null);
  });

  it("state válido do ciclo → published → bloqueia sem --force", () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify({ cycle: "26w42", title: "T", published_at: "2026-10-19T10:31:00.000Z" }));
    const state = resolveCircleStackState(readCircleStackPublishedState(p), "26w42");
    assert.equal(state, "published");
    assert.match(circleStackPublishBlockReason(state, "26w42", p) ?? "", /já publicado/);
  });

  it("JSON ilegível → unknown → bloqueia (nunca rebaixa pra draft e duplica o post)", () => {
    const p = join(dir, "corrompido.json");
    writeFileSync(p, "{nao é json");
    const state = resolveCircleStackState(readCircleStackPublishedState(p), "26w42");
    assert.equal(state, "unknown");
    assert.match(circleStackPublishBlockReason(state, "26w42", p) ?? "", /não confirma o envio/);
  });
});

describe("aviso semanal ao editor (#10904)", () => {
  it("issue por ciclo, bloqueio-execucao, com o comando manual de publicação", () => {
    const f = buildCircleStackReadyFinding("26w42", "Radar Stack", "data/weekly/26w42/circle-stack-26w42.md", "261019");
    assert.equal(f.fingerprint, "26w42");
    assert.equal(f.severity, "acao");
    assert.deepEqual(f.labels, ["bloqueio-execucao"]);
    assert.match(f.body, /--publish-monday 261019 --publish/);
    assert.match(f.body, /nada foi enviado/);
  });
});

describe("task semanal Diaria-Circle-Stack-Weekly-Preview (#10904)", () => {
  const task = getScheduledTaskByName("Diaria-Circle-Stack-Weekly-Preview");

  it("segunda 07:30 BRT, rodando o publisher", () => {
    assert.ok(task);
    assert.deepEqual(task.schedule, { kind: "weekly", dayOfWeek: "Monday", hour: 7, minute: 30 });
    assert.equal(task.steps[0].script, "scripts/publish-circle-stack.ts");
  });

  it("roda em dry-run: nunca --publish, --hello nem --force", () => {
    const args = task?.steps.flatMap((s) => s.args ?? []) ?? [];
    assert.ok(args.includes("--notify"));
    for (const forbidden of ["--publish", "--hello", "--force"]) assert.ok(!args.includes(forbidden), forbidden);
  });
});

describe("publishCircleStackCycle — idempotência em dois tempos (#10904)", () => {
  const payload = { titulo: "Radar Stack", corpo: "corpo" };
  const fixedNow = () => new Date("2026-10-26T10:30:00.000Z");
  const fresh = () => join(mkdtempSync(join(tmpdir(), "circle-stack-pub-")), "circle-stack-published.json");
  const base = (statePath: string, send: (p: typeof payload) => Promise<void>, force = false) => ({
    statePath, cycle: "26w43", title: "Radar Stack", payload, force, send, now: fixedNow,
  });

  it("draft → envia 1x e o estado vira published, com tentativa gravada ANTES do envio", async () => {
    const statePath = fresh();
    const seenAtSend: unknown[] = [];
    let calls = 0;
    await publishCircleStackCycle(base(statePath, async () => {
      calls++;
      seenAtSend.push(JSON.parse(readFileSync(statePath, "utf8")));
    }));
    assert.equal(calls, 1);
    // No momento do envio a tentativa já estava no disco, sem published_at.
    assert.deepEqual(seenAtSend[0], { cycle: "26w43", title: "Radar Stack", attempted_at: "2026-10-26T10:30:00.000Z" });
    assert.equal(resolveCircleStackState(readCircleStackPublishedState(statePath), "26w43"), "published");
  });

  it("send rejeita → estado unknown, e a próxima tentativa bloqueia sem --force", async () => {
    const statePath = fresh();
    await assert.rejects(publishCircleStackCycle(base(statePath, async () => { throw new Error("timeout"); })), /timeout/);
    assert.equal(resolveCircleStackState(readCircleStackPublishedState(statePath), "26w43"), "unknown");
    let calls = 0;
    await assert.rejects(publishCircleStackCycle(base(statePath, async () => { calls++; })), /não confirma o envio/);
    assert.equal(calls, 0);
  });

  it("2ª execução no mesmo ciclo bloqueia sem chamar send", async () => {
    const statePath = fresh();
    await publishCircleStackCycle(base(statePath, async () => {}));
    let calls = 0;
    await assert.rejects(publishCircleStackCycle(base(statePath, async () => { calls++; })), /já publicado/);
    assert.equal(calls, 0);
  });

  it("unknown + force envia e confirma", async () => {
    const statePath = fresh();
    writeFileSync(statePath, JSON.stringify({ cycle: "26w43", title: "Radar Stack", attempted_at: "2026-10-26T10:00:00.000Z" }));
    let calls = 0;
    const res = await publishCircleStackCycle(base(statePath, async () => { calls++; }, true));
    assert.equal(calls, 1);
    assert.equal(res.forced, true);
    assert.equal(resolveCircleStackState(readCircleStackPublishedState(statePath), "26w43"), "published");
  });
});

describe("decideCircleStackNotify (#10904)", () => {
  it("draft → prévia pronta; unknown → ambíguo; published → pula", () => {
    assert.equal(decideCircleStackNotify("draft", true), "ready");
    assert.equal(decideCircleStackNotify("unknown", true), "ambiguous");
    assert.equal(decideCircleStackNotify("published", true), "skip-published");
  });
  it("enabled=false pula em qualquer estado", () => {
    for (const s of ["draft", "unknown", "published"] as const) assert.equal(decideCircleStackNotify(s, false), "skip-disabled");
  });
  it("aviso ambíguo é distinto do 'prévia pronta' e manda conferir antes de --publish --force", () => {
    const amb = buildCircleStackAmbiguousFinding("26w42", "Radar Stack", "data/weekly/26w42/_internal/circle-stack-published.json", "261019");
    const ready = buildCircleStackReadyFinding("26w42", "Radar Stack", "x.md", "261019");
    assert.notEqual(amb.fingerprint, ready.fingerprint);
    assert.match(amb.subject, /estado ambíguo, conferir no Radar antes de --publish/);
    assert.doesNotMatch(amb.subject, /prévia pronta/);
    assert.match(amb.body, /--publish-monday 261019 --publish --force/);
  });
  it("avisos da seleção entram no corpo da issue", () => {
    const w = ["Edições sem 02-reviewed.md: 261016", "1 destaque(s) sem nenhum termo de interesse da Stack — revisar a seleção"];
    for (const f of [
      buildCircleStackReadyFinding("26w42", "T", "x.md", "261019", w),
      buildCircleStackAmbiguousFinding("26w42", "T", "s.json", "261019", w),
    ]) {
      assert.match(f.body, /- Edições sem 02-reviewed\.md: 261016/);
      assert.match(f.body, /sem nenhum termo de interesse/);
    }
    assert.doesNotMatch(buildCircleStackReadyFinding("26w42", "T", "x.md", "261019").body, /Avisos da seleção/);
  });
});

describe("currentOrPreviousMondayAAMMDD (#10904 — catch-up do Persistent=true)", () => {
  it("segunda → ela mesma", () => {
    assert.equal(currentOrPreviousMondayAAMMDD(new Date(2026, 9, 26, 7, 30)), "261026");
  });
  it("terça → a segunda anterior (nunca a seguinte)", () => {
    assert.equal(currentOrPreviousMondayAAMMDD(new Date(2026, 9, 27, 9, 0)), "261026");
  });
  it("domingo → a segunda 6 dias antes; atravessa mês", () => {
    assert.equal(currentOrPreviousMondayAAMMDD(new Date(2026, 10, 1, 12, 0)), "261026");
  });
});

describe("parseStoredCircleStackSelection (#10904)", () => {
  const p = "data/weekly/26w42/_internal/circle-stack-selection.json";
  it("aceita a seleção válida e devolve os warnings gravados", () => {
    const r = parseStoredCircleStackSelection(JSON.stringify({ ...selection, warnings: ["aviso X"] }), p, "26w42");
    assert.equal(r.selection.destaques.length, 2);
    assert.deepEqual(r.warnings, ["aviso X"]);
  });
  it("JSON ilegível cita o caminho e --reselect", () => {
    assert.throws(() => parseStoredCircleStackSelection("{quebrado", p, "26w42"), (e: Error) => e.message.includes(p) && e.message.includes("--reselect"));
  });
  it("ciclo divergente é recusado", () => {
    assert.throws(() => parseStoredCircleStackSelection(JSON.stringify(selection), p, "26w43"), /diferente do esperado 26w43/);
  });
  it("item sem campo obrigatório é recusado com a posição", () => {
    const broken = { ...selection, radar: [{ url: "https://ex.com", title: "T" }] };
    assert.throws(() => parseStoredCircleStackSelection(JSON.stringify(broken), p, "26w42"), /radar\[0\]\.editionDate/);
    const noSection = { ...selection } as Record<string, unknown>;
    delete noSection.useMelhor;
    assert.throws(() => parseStoredCircleStackSelection(JSON.stringify(noSection), p, "26w42"), /seção useMelhor ausente/);
  });
});

describe("closeCircleStackNotifyIssues (#10904)", () => {
  it("fecha as issues abertas do ciclo (prévia + ambíguo) e ignora as fechadas", () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[1] === "list") {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify([
            { number: 11, url: "u11", state: "OPEN", body: `x ${alarmFindingMarker("circle-stack-weekly", "26w42")}` },
            { number: 12, url: "u12", state: "CLOSED", body: `x ${alarmFindingMarker("circle-stack-weekly", "26w42-ambiguo")}` },
          ]),
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const res = closeCircleStackNotifyIssues("26w42", "2026-10-26T10:30:00.000Z", "/tmp", run);
    assert.deepEqual(res, { closed: [11], failed: [] });
    const closes = calls.filter((c) => c[1] === "close");
    assert.equal(closes.length, 1);
    assert.equal(closes[0][2], "11");
  });
  it("falha do gh no close vira failed, sem lançar", () => {
    const run = (args: string[]) =>
      args[1] === "list"
        ? { status: 0, stderr: "", stdout: JSON.stringify([{ number: 11, url: "u", state: "OPEN", body: alarmFindingMarker("circle-stack-weekly", "26w42") }]) }
        : { status: 1, stdout: "", stderr: "boom" };
    assert.deepEqual(closeCircleStackNotifyIssues("26w42", "t", "/tmp", run), { closed: [], failed: ["#11"] });
  });
});

describe("avisos de ciclos anteriores se auto-resolvem no --notify (#10965)", () => {
  const issue = (number: number, fp: string, check = "circle-stack-weekly") => ({ number, body: `corpo ${alarmFindingMarker(check, fp)}` });

  it("circleStackCycleFromFingerprint aceita prévia e ambíguo, recusa lixo", () => {
    assert.equal(circleStackCycleFromFingerprint("26w42"), "26w42");
    assert.equal(circleStackCycleFromFingerprint("26w42-ambiguo"), "26w42");
    assert.equal(circleStackCycleFromFingerprint("abc"), null);
    assert.equal(circleStackCycleFromFingerprint("26w99"), null);
  });

  it("plano: semana pulada (draft) fecha, publicada fecha, ambígua fica; ciclo atual/posterior e outro check ficam de fora", () => {
    const states: Record<string, "draft" | "published" | "unknown"> = { "26w40": "draft", "26w41": "published", "26w39": "unknown" };
    const plan = planStaleCircleStackNotifyCloses(
      [
        issue(1, "26w40"),
        issue(2, "26w41"),
        issue(3, "26w39-ambiguo"),
        issue(4, "26w43"), // ciclo atual
        issue(5, "26w44"), // posterior
        issue(6, "26w40", "outro-alarme"),
        { number: 7, body: null },
      ],
      "26w43",
      (c) => states[c] ?? "draft",
    );
    assert.deepEqual(plan.close, [
      { issueNumber: 1, cycle: "26w40", kind: "unpublished" },
      { issueNumber: 2, cycle: "26w41", kind: "published" },
    ]);
    assert.deepEqual(plan.keep, [{ issueNumber: 3, cycle: "26w39" }]);
  });

  it("cenário da issue: semana pulada fica aberta → o --notify da semana seguinte fecha com \"semana não publicada\"", () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[1] === "list") return { status: 0, stderr: "", stdout: JSON.stringify([issue(20, "26w42"), issue(21, "26w43")]) };
      return { status: 0, stdout: "", stderr: "" };
    };
    const res = closeStaleCircleStackNotifyIssues("26w43", () => "draft", "/tmp", run);
    assert.deepEqual(res, { closed: [20], failed: [], kept: [], listed: true });
    const closes = calls.filter((c) => c[1] === "close");
    assert.equal(closes.length, 1);
    assert.equal(closes[0][2], "20");
    assert.match(closes[0][closes[0].indexOf("--comment") + 1], /Semana não publicada/);
    assert.equal(closes[0][closes[0].indexOf("--reason") + 1], "not planned");
  });

  it("fail-soft: listagem falha ou JSON ruim → nada fechado, listed=false; close falho → failed", () => {
    assert.deepEqual(closeStaleCircleStackNotifyIssues("26w43", () => "draft", "/tmp", () => ({ status: 1, stdout: "", stderr: "x" })), {
      closed: [], failed: [], kept: [], listed: false,
    });
    assert.deepEqual(closeStaleCircleStackNotifyIssues("26w43", () => "draft", "/tmp", () => ({ status: 0, stdout: "{}", stderr: "" })), {
      closed: [], failed: [], kept: [], listed: false,
    });
    const run = (args: string[]) =>
      args[1] === "list" ? { status: 0, stderr: "", stdout: JSON.stringify([issue(30, "26w41")]) } : { status: 1, stdout: "", stderr: "boom" };
    assert.deepEqual(closeStaleCircleStackNotifyIssues("26w43", () => "draft", "/tmp", run), { closed: [], failed: [30], kept: [], listed: true });
  });

  it("estado do ciclo pelo disco: diretório ausente é unknown (data/ não sincronizado), nunca draft", () => {
    const root = mkdtempSync(join(tmpdir(), "circle-stale-"));
    assert.equal(circleStackCycleStateFromDisk(root, "26w40"), "unknown");
    mkdirSync(join(root, "data", "weekly", "26w40", "_internal"), { recursive: true });
    assert.equal(circleStackCycleStateFromDisk(root, "26w40"), "draft");
    writeFileSync(
      join(root, "data", "weekly", "26w40", "_internal", "circle-stack-published.json"),
      JSON.stringify({ cycle: "26w40", title: "t", attempted_at: "2026-10-05T10:00:00Z", published_at: "2026-10-05T10:00:01Z" }),
    );
    assert.equal(circleStackCycleStateFromDisk(root, "26w40"), "published");
  });
});
