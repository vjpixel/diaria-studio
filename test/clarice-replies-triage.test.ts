import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openClariceDb, recomputeDerived, markSuppressedNow } from "../scripts/lib/clarice-db.ts";
import {
  classifyReply,
  stripQuoted,
  buildTriagePlan,
  computeBatchId,
  gmailMessageToReply,
  type ReplyMessage,
} from "../scripts/lib/clarice-replies-classify.ts";
import { applyTriagePlan, main, planPath } from "../scripts/clarice-replies-triage.ts";

// ---------------------------------------------------------------------------
// Fixtures — respostas típicas à Clarice News (#12227)
// ---------------------------------------------------------------------------

const QUOTE =
  "\n\nEm qua., 4 de nov. de 2026 às 10:02, Clarice.ai <ti@clarice.ai>\nescreveu:\n> Notícias do mês sobre IA\n> Quer prioridade? Responda quero.\n> Para sair da lista, descadastre-se aqui.\n";

let seq = 0;
function msg(body: string, extra: Partial<ReplyMessage> = {}): ReplyMessage {
  seq++;
  return {
    message_id: `m${seq}`,
    thread_id: `t${seq}`,
    from: `pessoa${seq}@exemplo.com.br`,
    subject: "Re: Notícias do mês sobre IA",
    date: `2026-11-04T10:${String(seq % 60).padStart(2, "0")}:00.000Z`,
    body,
    ...extra,
  };
}

const cases: Array<[string, string, string, boolean?]> = [
  ["quero", "quero", "quero curto"],
  ["Quero!", "quero", "Quero! com pontuação"],
  ["Quero sim, obrigada pela newsletter", "quero", "quero sim + agradecimento"],
  ["Sim", "quero", "sim sozinho"],
  ["pode me tirar da lista", "saida", "tirar da lista"],
  ["Gostaria de me descadastrar", "saida", "descadastrar"],
  ["Não quero mais receber esses e-mails.", "saida", "não quero mais receber"],
  ["quero sair", "saida", "quero sair não é optin"],
  ["Por favor, removam meu e-mail da base.", "saida", "remover email da base"],
  ["Pela LGPD peço que excluam todos os meus dados.", "saida", "LGPD + exclusão de dados", true],
  ["Quero cancelar minha compra", "suporte", "cancelar compra (produto Clarice)"],
  ["Preciso dos dados do projeto que fiz na plataforma", "suporte", "dados do projeto"],
  ["Fui cobrado duas vezes, quero reembolso", "ambiguo", "suporte + quero (conflito)"],
  ["Achei interessante a matéria sobre agentes", "ambiguo", "nenhuma regra"],
  ["Não quero", "ambiguo", "não quero sem saída explícita"],
];

for (const [body, kind, label, dataDeletion] of cases) {
  test(`#12227 classifyReply: ${label} → ${kind}`, () => {
    const c = classifyReply(msg(body + QUOTE));
    assert.equal(c.kind, kind, `${JSON.stringify(body)}: ${c.reason}`);
    assert.equal(c.data_deletion, !!dataDeletion);
  });
}

test("#12227 a citação do e-mail original (que tem 'descadastre-se' e 'quero') nunca entra na classificação", () => {
  assert.equal(stripQuoted("Obrigado!" + QUOTE), "Obrigado!");
  // corpo vazio + só citação → ruído, nunca saída por causa do rodapé citado
  assert.equal(classifyReply(msg(QUOTE)).kind, "ruido");
});

test("#12227 resposta automática de férias é ruído (header, assunto ou texto)", () => {
  assert.equal(
    classifyReply(msg("Estou de férias até dia 20. Quero dizer, retorno no dia 20.", {
      headers: { "auto-submitted": "auto-replied" },
    })).kind,
    "ruido",
  );
  assert.equal(classifyReply(msg("Retorno em breve.", { subject: "Resposta automática: Notícias do mês sobre IA" })).kind, "ruido");
  assert.equal(classifyReply(msg("Olá! Estou de férias e retorno no dia 10/11." + QUOTE)).kind, "ruido");
  assert.equal(classifyReply(msg("quero", { from: "MAILER-DAEMON@googlemail.com" })).kind, "ruido");
});

// ---------------------------------------------------------------------------
// Plano
// ---------------------------------------------------------------------------

test("#12227 buildTriagePlan: ações por tipo, saída prevalece sobre quero do mesmo e-mail, id determinístico", () => {
  const msgs = [
    msg("quero", { from: "a@x.com" }),
    msg("Quero!", { from: "B@X.com" }),
    msg("pode me tirar da lista", { from: "c@x.com" }),
    msg("quero", { from: "d@x.com" }),
    msg("não quero mais receber", { from: "d@x.com" }),
    msg("Pela LGPD excluam meus dados", { from: "e@x.com" }),
    msg("Quero cancelar minha compra", { from: "f@x.com" }),
    msg("e aí, tudo bem?", { from: "g@x.com" }),
  ];
  const plan = buildTriagePlan(msgs, { now: "2026-11-05T00:00:00.000Z" });
  assert.deepEqual(plan.actions.optin, ["a@x.com", "b@x.com"]);
  assert.deepEqual(plan.actions.saida, ["c@x.com", "d@x.com", "e@x.com"]);
  assert.deepEqual(plan.actions.conflitos, ["d@x.com"]);
  assert.deepEqual(plan.actions.data_deletion, ["e@x.com"]);
  assert.deepEqual(plan.actions.suporte.map((s) => s.email), ["f@x.com"]);
  assert.deepEqual(plan.actions.pendentes.map((p) => p.email), ["g@x.com"]);
  assert.equal(plan.batch_id, buildTriagePlan([...msgs].reverse()).batch_id, "ordem de leitura não muda o id");
  assert.notEqual(plan.batch_id, computeBatchId([...plan.items, { message_id: "novo", kind: "quero" }]));
});

test("#12227 gmailMessageToReply: From com nome, headers em minúsculas, corpo text/plain base64url", () => {
  const data = Buffer.from("Quero!\n\n> citação").toString("base64url");
  const r = gmailMessageToReply({
    id: "abc",
    threadId: "th",
    internalDate: String(Date.UTC(2026, 10, 4, 12)),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "\"Maria Silva\" <Maria.Silva@Gmail.com>" },
        { name: "Subject", value: "Re: Notícias do mês sobre IA" },
        { name: "Auto-Submitted", value: "no" },
      ],
      parts: [{ mimeType: "text/plain", body: { data } }],
    },
  });
  assert.equal(r.from, "maria.silva@gmail.com");
  assert.equal(r.from_name, "Maria Silva");
  assert.equal(r.headers?.["auto-submitted"], "no");
  assert.equal(r.date, "2026-11-04T12:00:00.000Z");
  assert.equal(classifyReply(r).kind, "quero");
});

// ---------------------------------------------------------------------------
// Aplicação — supressão imediata, idempotência, falha parcial da Brevo
// ---------------------------------------------------------------------------

function seededDb() {
  const db = openClariceDb(":memory:");
  const ins = db.prepare(
    "INSERT INTO clarice_users (email, tier, cohort, mv_bucket) VALUES (?, 1, 'assinantes-ativos', 'verified')",
  );
  for (const e of ["c@x.com", "d@x.com", "filosofo.daniel@gmail.com"]) ins.run(e);
  recomputeDerived(db);
  return db;
}

function eligibility(db: ReturnType<typeof openClariceDb>, email: string) {
  return db
    .prepare("SELECT unsubscribed, email_blacklisted, send_eligible, ineligible_reason FROM clarice_users WHERE email = ?")
    .get(email) as { unsubscribed: number; email_blacklisted: number; send_eligible: number; ineligible_reason: string | null };
}

test("#12227 regressão: saída aplicada deixa send_eligible=0 NA HORA, sem esperar o clarice-sync-brevo", async () => {
  const db = seededDb();
  assert.equal(eligibility(db, "c@x.com").send_eligible, 1, "pré-condição: elegível antes");
  const plan = buildTriagePlan([msg("pode me tirar da lista", { from: "c@x.com" })]);
  const calls: string[] = [];
  await applyTriagePlan(plan, { db, blacklist: async (e) => void calls.push(e) });
  const row = eligibility(db, "c@x.com");
  assert.equal(row.unsubscribed, 1);
  assert.equal(row.send_eligible, 0);
  assert.equal(row.ineligible_reason, "unsubscribed");
  assert.deepEqual(calls, ["c@x.com"]);
  db.close();
});

test("#12227 saída de variante Gmail sem pontos suprime e blacklista o e-mail canônico do store", async () => {
  const db = seededDb();
  const plan = buildTriagePlan([msg("descadastrar", { from: "filosofodaniel@gmail.com" })]);
  const calls: string[] = [];
  await applyTriagePlan(plan, { db, blacklist: async (e) => void calls.push(e) });
  assert.equal(eligibility(db, "filosofo.daniel@gmail.com").send_eligible, 0);
  assert.deepEqual(calls, ["filosofo.daniel@gmail.com"]);
  db.close();
});

test("#12227 erro da Brevo num contato não aborta os demais; store suprime mesmo assim; reaplicar retenta só o que falhou", async () => {
  const db = seededDb();
  const plan = buildTriagePlan([
    msg("quero", { from: "a@x.com" }),
    msg("pode me tirar da lista", { from: "c@x.com" }),
    msg("não quero mais receber", { from: "d@x.com" }),
  ]);
  const calls: string[] = [];
  await applyTriagePlan(plan, {
    db,
    blacklist: async (e) => {
      calls.push(e);
      if (e === "c@x.com") throw new Error("Brevo API PUT falhou (500)");
    },
  });
  assert.deepEqual(calls, ["c@x.com", "d@x.com"], "d@x.com foi tentado apesar da falha em c@x.com");
  assert.deepEqual(plan.applied.failures.map((f) => [f.email, f.step]), [["c@x.com", "brevo"]]);
  assert.equal(eligibility(db, "c@x.com").send_eligible, 0, "supressão local não depende da Brevo");

  // reaplicação: optin não duplica, Brevo só pra quem falhou
  calls.length = 0;
  await applyTriagePlan(plan, { db, blacklist: async (e) => void calls.push(e) });
  assert.deepEqual(calls, ["c@x.com"]);
  assert.deepEqual(plan.applied.failures, []);
  assert.deepEqual(plan.applied.saida_brevo_done.sort(), ["c@x.com", "d@x.com"]);
  const optins = db.prepare("SELECT COUNT(*) AS n FROM priority_optin").get() as { n: number };
  assert.equal(optins.n, 1);

  // terceira vez: nada a fazer, nada chamado
  calls.length = 0;
  await applyTriagePlan(plan, { db, blacklist: async (e) => void calls.push(e) });
  assert.deepEqual(calls, []);
  db.close();
});

test("#12227 markSuppressedNow só liga flags e ignora conta de teste do editor", () => {
  const db = openClariceDb(":memory:");
  assert.equal(markSuppressedNow(db, "Novo@X.com"), true);
  assert.equal(markSuppressedNow(db, "novo@x.com"), true);
  const r = db.prepare("SELECT COUNT(*) AS n, MAX(unsubscribed) AS u FROM clarice_users").get() as { n: number; u: number };
  assert.deepEqual([r.n, r.u], [1, 1]);
  assert.equal(markSuppressedNow(db, "vjpixel+test3@gmail.com"), false);
  db.close();
});

// ---------------------------------------------------------------------------
// CLI — listar não aplica; aplicar exige o id do lote mostrado
// ---------------------------------------------------------------------------

test("#12227 CLI: listar grava o plano sem aplicar; --apply sem --confirm ou com id errado recusa; com id aplica e falha visível", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clarice-replies-"));
  const dbPath = join(dir, "users.db");
  const seed = openClariceDb(dbPath);
  seed.prepare("INSERT INTO clarice_users (email, tier, cohort, mv_bucket) VALUES ('c@x.com', 1, 'assinantes-ativos', 'verified')").run();
  recomputeDerived(seed);
  seed.close();

  const reader = {
    async list() {
      return [msg("pode me tirar da lista", { from: "c@x.com" }), msg("quero", { from: "a@x.com" })];
    },
  };
  const base = ["--plan-dir", dir, "--db", dbPath];
  const origErr = console.error;
  const origLog = console.log;
  let out = "";
  console.error = () => {};
  console.log = (s: string) => void (out += s);
  try {
    assert.equal(await main(base, { reader }), 0);
    const { batch_id } = JSON.parse(out) as { batch_id: string };
    assert.ok(existsSync(planPath(dir, batch_id)));
    const db1 = openClariceDb(dbPath);
    assert.equal(eligibility(db1, "c@x.com").send_eligible, 1, "listar não aplica nada");
    db1.close();

    assert.equal(await main([...base, "--apply"], { blacklist: async () => {} }), 1);
    assert.equal(await main([...base, "--apply", "--confirm", "000000000000"], { blacklist: async () => {} }), 1);

    out = "";
    assert.equal(
      await main([...base, "--apply", "--confirm", batch_id], {
        blacklist: async () => {
          throw new Error("401 unauthorized");
        },
      }),
      1,
      "falha da Brevo sai com exit != 0",
    );
    const saved = JSON.parse(readFileSync(planPath(dir, batch_id), "utf8"));
    assert.deepEqual(saved.applied.failures.map((f: { email: string }) => f.email), ["c@x.com"]);
    assert.deepEqual(saved.applied.saida_store_done, ["c@x.com"]);

    // listar de novo o mesmo lote preserva o estado de aplicação
    out = "";
    assert.equal(await main(base, { reader }), 0);
    const again = JSON.parse(readFileSync(planPath(dir, batch_id), "utf8"));
    assert.deepEqual(again.applied.saida_store_done, ["c@x.com"]);

    assert.equal(await main([...base, "--apply", "--confirm", batch_id], { blacklist: async () => {} }), 0);
    const db2 = openClariceDb(dbPath);
    assert.equal(eligibility(db2, "c@x.com").send_eligible, 0);
    db2.close();
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
});

// ---------------------------------------------------------------------------
// Achados do review da PR #12261
// ---------------------------------------------------------------------------

test("#12261 review: recusar a prioridade não é pedido de saída", () => {
  for (const body of ["Não preciso receber com prioridade, mas adoro a newsletter!", "não quero receber com prioridade"]) {
    const c = classifyReply(msg(body + QUOTE));
    assert.notEqual(c.kind, "saida", `${body}: ${c.reason}`);
  }
  // "não quero mais receber" segue saída
  assert.equal(classifyReply(msg("Não quero mais receber esses e-mails." + QUOTE)).kind, "saida");
});

test("#12261 review: mencionar a LGPD sem pedido não é exclusão de dados", () => {
  const c = classifyReply(msg("A Clarice está adequada à LGPD? Achei interessante." + QUOTE));
  assert.notEqual(c.kind, "saida", c.reason);
  assert.equal(c.data_deletion, false);
  // pedido explícito segue exclusão
  const p = classifyReply(msg("Com base na LGPD, solicito a exclusão dos meus dados." + QUOTE));
  assert.equal(p.kind, "saida");
  assert.equal(p.data_deletion, true);
});

test("#12261 review: citação do Outlook para Mac (com 'Responder a:') e atribuição em 3+ linhas não vazam o rodapé", () => {
  const footer = "\nNotícias do mês sobre IA\nCaso não queira receber a newsletter, pode se descadastrar aqui.\n";
  const outlookMac = "Obrigado!\n\nDe: Clarice.ai <ti@clarice.ai>\nResponder a: pixel@diar.ia.br\nData: quarta-feira, 4 de novembro de 2026 10:02\nPara: Fulano <f@x.com>\nAssunto: Notícias do mês sobre IA" + footer;
  assert.notEqual(classifyReply(msg(outlookMac)).kind, "saida");
  const gmail3 = "Obrigado!\n\nEm qua., 4 de nov. de 2026\nàs 10:02, Clarice.ai\n<ti@clarice.ai> escreveu:" + footer;
  assert.notEqual(classifyReply(msg(gmail3)).kind, "saida");
  // rodapé vazado sem nenhum marcador de citação também corta
  assert.notEqual(classifyReply(msg("Obrigado!" + footer)).kind, "saida");
});

test("#12261 review: o id do lote muda quando o remetente muda (modo --input)", () => {
  const a = computeBatchId([{ message_id: "m1", kind: "saida", email: "a@x.com" }]);
  const b = computeBatchId([{ message_id: "m1", kind: "saida", email: "b@x.com" }]);
  assert.notEqual(a, b);
});

test("#12261 review: conta de teste do editor nunca vai pra blacklist da Brevo", async () => {
  const db = seededDb();
  const plan = buildTriagePlan([msg("descadastrar", { from: "vjpixel+test1@gmail.com" })]);
  const calls: string[] = [];
  await applyTriagePlan(plan, { db, blacklist: async (e) => void calls.push(e) });
  assert.deepEqual(calls, [], "Brevo não chamada para a conta de teste");
  assert.deepEqual(plan.applied.failures, []);
  db.close();
});

test("#12261 re-review: assinante citando o rodapé ou abrindo com 'Em primeiro lugar' não perde o pedido", () => {
  const expect: Array<[string, string]> = [
    ["Vocês dizem 'caso não queira receber a newsletter, pode se descadastrar', mas o link não funciona. Me tirem da lista.", "saida"],
    ["Por favor, me descadastrem. Caso não queira receber mais nada, a quem devo pedir?", "saida"],
    ["Você está recebendo este e-mail de novo, mas pedi para sair. Me descadastrem.", "saida"],
    ["Quero! Caso não queira receber, aviso.", "quero"],
    ["Em primeiro lugar, quero sair da lista.\nObrigado.\nMeu chefe escreveu: tira isso", "saida"],
  ];
  for (const [body, kind] of expect) {
    const c = classifyReply(msg(body + QUOTE));
    assert.equal(c.kind, kind, `${JSON.stringify(body)}: ${c.reason}`);
  }
  // abrir a resposta com a frase exata do rodapé: corte apaga tudo → pendente, nunca ruído
  const c = classifyReply(msg("Caso não queira receber a newsletter, me avisem como sair.\n" + QUOTE));
  assert.equal(c.kind, "ambiguo", c.reason);
  // resposta só com citação segue ruído
  assert.equal(classifyReply(msg(QUOTE)).kind, "ruido");
});
