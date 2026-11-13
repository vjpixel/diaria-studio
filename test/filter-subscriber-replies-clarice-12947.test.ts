/**
 * #12947: respostas à Clarice News (reply-to `pixel@diar.ia.br`, assunto
 * "Notícias do mês sobre IA: …") eram descartadas pelo check de `to` do
 * §0-replies, inclusive um pedido de descadastro (achado 261113). Agora saem
 * em `clariceReplies`, classificadas, e o stderr nomeia o pedido de saída.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterSubscriberReplies,
  formatClariceRepliesReport,
  isClariceNewsReply,
  looksLikeSubscriberReply,
} from "../scripts/filter-subscriber-replies.ts";
import { CLARICE_NEWS_SUBJECT } from "../scripts/lib/clarice-replies-classify.ts";
import { DEFAULT_SUBJECT } from "../scripts/clarice-replies-triage.ts";

const SUBJ = "Re: Notícias do mês sobre IA: Google retoma a liderança na corrida";

const unsubscribe = {
  thread_id: "c1",
  subject: SUBJ,
  from: "Isabela <leitora.clarice@gmail.com>",
  to: "pixel@diar.ia.br",
  date: "2026-11-12T10:00:00Z",
  body: "Por favor, me descadastre desta lista.\n\nEm 10/11/2026, Clarice News escreveu:\n> Notícias do mês",
};
const loginProblem = {
  thread_id: "c2",
  subject: SUBJ,
  from: "outro@empresa.com.br",
  to: "diar.ia.br <pixel@diar.ia.br>",
  body: "Não consigo acessar minha conta, a senha não funciona.",
};

describe("#12947: respostas à Clarice News no §0-replies", () => {
  it("fonte única do assunto: triagem e filtro usam o mesmo trecho", () => {
    assert.equal(DEFAULT_SUBJECT, CLARICE_NEWS_SUBJECT);
  });

  it("isClariceNewsReply: pixel@ ou sem `to` com o assunto → true; domínio dedicado da diária ou outro assunto → false", () => {
    assert.ok(isClariceNewsReply({ subject: SUBJ, to: "pixel@diar.ia.br" }));
    assert.ok(isClariceNewsReply({ subject: "RES: noticias do MES sobre ia: x" }), "acento/caixa/prefixo normalizados");
    assert.ok(!isClariceNewsReply({ subject: SUBJ, to: "oi@news.diar.ia.br" }));
    assert.ok(!isClariceNewsReply({ subject: "Re: proposta de parceria", to: "pixel@diar.ia.br" }));
  });

  it("pedido de descadastro sai em clariceReplies como `saida`, fora de replies[] e de droppedByTo", () => {
    const r = filterSubscriberReplies([unsubscribe, loginProblem]);
    assert.equal(r.replies.length, 0, "não vira rascunho da diária nem crédito do concurso");
    assert.equal(r.droppedByToCount, 0, "não some no balde de descartadas (o bug)");
    assert.deepEqual(r.droppedByToSenders, []);
    assert.equal(r.clariceReplies.length, 2);
    const saida = r.clariceReplies.find((x) => x.thread_id === "c1");
    assert.equal(saida?.kind, "saida");
    assert.equal(saida?.from, "leitora.clarice@gmail.com");
    assert.equal(r.clariceReplies.find((x) => x.thread_id === "c2")?.kind, "suporte");
  });

  it("sem corpo capturado → `ambiguo` (nunca `ruido`, que esconderia um pedido de saída)", () => {
    const r = filterSubscriberReplies([{ ...unsubscribe, body: undefined }]);
    assert.equal(r.clariceReplies[0].kind, "ambiguo");
  });

  it("looksLikeSubscriberReply recusa resposta à Clarice mesmo sem `to` (não é da diária)", () => {
    assert.ok(!looksLikeSubscriberReply({ subject: SUBJ, from: "x@y.com" }));
  });

  it("correspondência pessoal em pixel@ continua em droppedByTo (sem regressão do #8997/#9313)", () => {
    const r = filterSubscriberReplies([
      { thread_id: "p", subject: "Re: proposta de parceria", from: "comercial@agencia.com", to: "pixel@diar.ia.br" },
    ]);
    assert.equal(r.droppedByToCount, 1);
    assert.equal(r.clariceReplies.length, 0);
  });

  it("formatClariceRepliesReport: vazio sem respostas; nomeia o pedido de saída e aponta a triagem", () => {
    assert.deepEqual(formatClariceRepliesReport([]), []);
    const lines = formatClariceRepliesReport(filterSubscriberReplies([unsubscribe, loginProblem]).clariceReplies);
    assert.match(lines[0], /2 resposta\(s\) à Clarice News/);
    assert.match(lines[0], /clarice-replies-triage\.ts/);
    assert.ok(lines.some((l) => /PEDIDO DE SAÍDA/.test(l) && l.includes("leitora.clarice@gmail.com")));
    assert.ok(!lines.some((l) => l.includes("outro@empresa.com.br") && /SAÍDA/.test(l)));
  });

  it("CLI: stderr nomeia o pedido de descadastro e stdout traz clariceReplies", () => {
    const dir = mkdtempSync(join(tmpdir(), "fsr-12947-"));
    const inPath = join(dir, "captured.json");
    writeFileSync(inPath, JSON.stringify([unsubscribe]));
    const res = spawnSync(process.execPath, ["--import", "tsx", "scripts/filter-subscriber-replies.ts", "--in", inPath], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.clariceReplies.length, 1);
    assert.equal(out.droppedByToCount, 0);
    assert.match(res.stderr, /PEDIDO DE SAÍDA da Clarice News: leitora\.clarice@gmail\.com/);
  });
});
