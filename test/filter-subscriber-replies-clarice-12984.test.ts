/**
 * #12984: (1) pedido de exclusão de dados classificado `ambiguo` (junto com
 * suporte ou "quero") e `ambiguo` sem corpo sumiam na contagem agregada do
 * gate; (2) a mesma resposta voltava ao gate por 14 dias mesmo depois de a
 * triagem da Clarice suprimir o contato.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clariceReplyTriagedIn,
  filterSubscriberReplies,
  formatClariceRepliesReport,
  loadClariceTriagePlans,
  type ClariceNewsReply,
} from "../scripts/filter-subscriber-replies.ts";
import { buildTriagePlan, type TriagePlan } from "../scripts/lib/clarice-replies-classify.ts";

const SUBJ = "Re: Notícias do mês sobre IA: Google retoma a liderança na corrida";
const base = { subject: SUBJ, to: "pixel@diar.ia.br", date: "2026-11-12T10:00:00Z" };

const deletionPlusSupport = {
  ...base,
  thread_id: "d1",
  from: "Ana <ana.lgpd@gmail.com>",
  body: "Quero que apaguem meus dados pessoais. Também não consigo acessar minha conta, a senha não funciona.",
};
const unsubscribe = {
  ...base,
  thread_id: "s1",
  from: "leitora.clarice@gmail.com",
  body: "Por favor, me descadastre desta lista.",
};
const noBody = { ...base, thread_id: "n1", from: "sem.corpo@gmail.com", body: undefined };

function appliedPlan(over: Partial<TriagePlan["applied"]> = {}): TriagePlan {
  const plan = buildTriagePlan(
    [
      { message_id: "m-s1", thread_id: "s1", from: "leitora.clarice@gmail.com", subject: SUBJ, date: base.date, body: unsubscribe.body },
      { message_id: "m-d1", thread_id: "d1", from: "ana.lgpd@gmail.com", subject: SUBJ, date: base.date, body: deletionPlusSupport.body },
    ],
    { now: "2026-11-12T12:00:00Z" },
  );
  plan.applied = { ...plan.applied, saida_store_done: ["leitora.clarice@gmail.com"], last_applied_at: "2026-11-12T12:30:00Z", ...over };
  return plan;
}

describe("#12984 item 1: exclusão de dados e ambíguos nomeados no gate", () => {
  it("exclusão de dados junto com suporte é `ambiguo` com data_deletion e sai nomeada", () => {
    const r = filterSubscriberReplies([deletionPlusSupport]);
    assert.equal(r.clariceReplies[0].kind, "ambiguo");
    assert.equal(r.clariceReplies[0].data_deletion, true);
    const lines = formatClariceRepliesReport(r.clariceReplies);
    assert.ok(
      lines.some((l) => /EXCLUSÃO DE DADOS/.test(l) && l.includes("ana.lgpd@gmail.com") && l.includes("Notícias do mês")),
      lines.join("\n"),
    );
  });

  it("`ambiguo` sem corpo sai nomeado pelo remetente", () => {
    const lines = formatClariceRepliesReport(filterSubscriberReplies([noBody]).clariceReplies);
    assert.ok(lines.some((l) => /ambígua/.test(l) && l.includes("sem.corpo@gmail.com")), lines.join("\n"));
  });
});

describe("#12984 item 2: resposta já triada não repete o alarme", () => {
  it("saída suprimida no store (saida_store_done) sai como triada, por e-mail", () => {
    const r = filterSubscriberReplies([unsubscribe], { clariceTriagePlans: [appliedPlan()] });
    assert.ok(r.clariceReplies[0].triaged_in);
    const lines = formatClariceRepliesReport(r.clariceReplies);
    assert.ok(!lines.some((l) => /PEDIDO DE SAÍDA/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /já triada/.test(l) && l.includes("leitora.clarice@gmail.com")));
  });

  it("plano listado mas não aplicado não marca nada", () => {
    const plan = appliedPlan({ saida_store_done: [], last_applied_at: null });
    const r = filterSubscriberReplies([unsubscribe, deletionPlusSupport], { clariceTriagePlans: [plan] });
    assert.ok(r.clariceReplies.every((x) => !x.triaged_in));
    assert.ok(formatClariceRepliesReport(r.clariceReplies).some((l) => /PEDIDO DE SAÍDA/.test(l)));
  });

  it("`ambiguo` no plano aplicado continua pendente (a triagem não age sobre ele)", () => {
    const r = filterSubscriberReplies([deletionPlusSupport], { clariceTriagePlans: [appliedPlan()] });
    assert.equal(r.clariceReplies[0].triaged_in, undefined);
  });

  it("suporte: mesma thread num plano aplicado conta; mensagem posterior à aplicação não", () => {
    const reply: ClariceNewsReply = { thread_id: "t9", from: "x@y.com", subject: SUBJ, date: "2026-11-12T10:00:00Z", kind: "suporte", reason: "", data_deletion: false };
    const plan = buildTriagePlan(
      [{ message_id: "m9", thread_id: "t9", from: "x@y.com", subject: SUBJ, date: reply.date!, body: "Não consigo acessar minha conta, a senha não funciona." }],
    );
    plan.applied.last_applied_at = "2026-11-12T11:00:00Z";
    assert.equal(clariceReplyTriagedIn(reply, [plan]), plan.batch_id);
    assert.equal(clariceReplyTriagedIn({ ...reply, date: "2026-11-13T09:00:00Z" }, [plan]), null);
  });

  it("loadClariceTriagePlans: diretório ausente = []; plano ilegível vira aviso", () => {
    assert.deepEqual(loadClariceTriagePlans(join(tmpdir(), "nao-existe-12984-xyz")), []);
    const dir = mkdtempSync(join(tmpdir(), "triage-12984-"));
    const plan = appliedPlan();
    writeFileSync(join(dir, `triage-${plan.batch_id}.json`), JSON.stringify(plan));
    writeFileSync(join(dir, "triage-aaaaaaaaaaaa.json"), "{ quebrado");
    const warns: string[] = [];
    const plans = loadClariceTriagePlans(dir, (m) => warns.push(m));
    assert.equal(plans.length, 1);
    assert.equal(warns.length, 1);
  });

  it("CLI: --clarice-triage-dir lê os planos e o stderr não repete o PEDIDO DE SAÍDA triado", () => {
    const dir = mkdtempSync(join(tmpdir(), "fsr-12984-"));
    const triageDir = join(dir, "clarice-replies");
    mkdirSync(triageDir);
    const plan = appliedPlan();
    writeFileSync(join(triageDir, `triage-${plan.batch_id}.json`), JSON.stringify(plan));
    const inPath = join(dir, "captured.json");
    writeFileSync(inPath, JSON.stringify([unsubscribe]));
    const res = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/filter-subscriber-replies.ts", "--in", inPath, "--clarice-triage-dir", triageDir],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).clariceReplies[0].triaged_in, plan.batch_id);
    assert.doesNotMatch(res.stderr, /PEDIDO DE SAÍDA/);
    assert.match(res.stderr, /já triada/);
  });
});
