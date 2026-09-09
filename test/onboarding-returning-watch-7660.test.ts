/**
 * test/onboarding-returning-watch-7660.test.ts (#7660)
 *
 * Trava o watcher de RECADASTRO — quem volta a se cadastrar não pode receber
 * o e-mail 1 de boas-vindas de novo.
 *
 * O caso concreto: o leitor da #7660 (248 edições, 84,68% de abertura) foi
 * removido do Kit pelo editor em 09/09/2026. Se ele se recadastrar, o
 * pipeline o vê como cadastro novo e manda "Você está dentro. Aqui está o que
 * muda a partir de agora" — a mesma mensagem que ele já recebeu
 * indevidamente no mass-send do #6043, quatro dias antes de o provedor dele
 * registrar queixa de spam.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideWatchEntry,
  pendingWatchEntries,
  emptyWatchlist,
  addToWatchlist,
  markWatchResolved,
  renderWatchDecision,
  type WatchedReturning,
  type WatchKitSubscriber,
} from "../scripts/lib/onboarding-returning-watch.ts";

const NOW = "2026-09-09T12:00:00.000Z";

function watched(over: Partial<WatchedReturning> = {}): WatchedReturning {
  return { email: "pedro@example.com", reason: "#7660", added_at: NOW, seeded_at: null, kit_id: null, ...over };
}
function kitSub(over: Partial<WatchKitSubscriber> = {}): WatchKitSubscriber {
  return { id: 555, email_address: "pedro@example.com", state: "active", created_at: "2026-09-10T08:30:00Z", ...over };
}

test("ainda não recadastrado: aguarda, não faz nada", () => {
  const d = decideWatchEntry(watched(), null, false, false);
  assert.equal(d.kind, "aguardando");
});

test("recadastrou e está limpo: semeia com a data REAL do recadastro", () => {
  const d = decideWatchEntry(watched(), kitSub(), false, false);
  assert.equal(d.kind, "semear");
  assert.equal(d.kind === "semear" && d.kitId, 555);
  assert.equal(
    d.kind === "semear" && d.seedEmail1SentAt,
    "2026-09-10T08:30:00Z",
    "a data é a do recadastro, não `now` — senão o D+3 do e-mail 2 conta do momento errado",
  );
  assert.equal(d.kind === "semear" && d.reason, "#7660", "a origem vira seeded_by");
});

test("existe no Kit mas não está active: não semeia, continua observando", () => {
  for (const state of ["inactive", "cancelled", "bounced", "complained"]) {
    const d = decideWatchEntry(watched(), kitSub({ state }), false, false);
    assert.equal(d.kind, "nao-active", `state=${state} não devia semear`);
  }
});

test("já tem entrada no store pelo E-MAIL: resolvido, nada a semear", () => {
  const d = decideWatchEntry(watched(), kitSub(), true, false);
  assert.equal(d.kind, "ja-no-store");
  assert.match(d.kind === "ja-no-store" ? d.detalhe : "", /e-mail/);
});

test("já tem entrada no store pelo ID: resolvido — cobre quem trocou de endereço", () => {
  // Mesma lição do review da #7674: casar só por e-mail deixa passar quem
  // mudou de endereço, e o write por id sobrescreveria o histórico.
  const d = decideWatchEntry(watched(), kitSub(), false, true);
  assert.equal(d.kind, "ja-no-store");
  assert.match(d.kind === "ja-no-store" ? d.detalhe : "", /555/);
});

test("REGRESSÃO: rodada diária chegou antes ⇒ NÃO semeia por cima", () => {
  // Se o e-mail 1 já saiu (a pessoa entrou no store pela detecção normal),
  // semear agora sobrescreveria a entrada e a faria receber tudo de novo.
  const d = decideWatchEntry(watched(), kitSub(), true, true);
  assert.equal(d.kind, "ja-no-store", "tarde demais é 'não faça nada', nunca 'faça de novo'");
});

test("addToWatchlist é idempotente por e-mail e normaliza a caixa", () => {
  let l = emptyWatchlist();
  l = addToWatchlist(l, "Pedro@Example.COM", "#7660", NOW).list;
  assert.equal(l.entries.length, 1);
  assert.equal(l.entries[0].email, "pedro@example.com");

  const r2 = addToWatchlist(l, "pedro@example.com", "#7660", "2026-09-11T00:00:00.000Z");
  assert.equal(r2.added, false, "re-adicionar quem já está em observação não duplica");
  assert.equal(r2.list.entries.length, 1);
  assert.equal(r2.list.entries[0].added_at, NOW, "nem reseta o added_at");
});

test("quem já foi resolvido pode voltar à observação (saiu de novo)", () => {
  let l = emptyWatchlist();
  l = addToWatchlist(l, "pedro@example.com", "#7660", NOW).list;
  l = markWatchResolved(l, "pedro@example.com", NOW, 555);
  const r = addToWatchlist(l, "pedro@example.com", "#7999", "2026-10-01T00:00:00.000Z");
  assert.equal(r.added, true, "entrada resolvida não bloqueia uma observação nova");
  assert.equal(pendingWatchEntries(r.list).length, 1);
});

test("markWatchResolved tira da fila e registra o id", () => {
  let l = emptyWatchlist();
  l = addToWatchlist(l, "pedro@example.com", "#7660", NOW).list;
  assert.equal(pendingWatchEntries(l).length, 1);
  l = markWatchResolved(l, "pedro@example.com", "2026-09-10T09:00:00.000Z", 555);
  assert.equal(pendingWatchEntries(l).length, 0);
  assert.equal(l.entries[0].seeded_at, "2026-09-10T09:00:00.000Z");
  assert.equal(l.entries[0].kit_id, 555);
});

test("render nomeia a pessoa em toda decisão — log sem nome não é acionável", () => {
  const casos = [
    decideWatchEntry(watched(), null, false, false),
    decideWatchEntry(watched(), kitSub({ state: "inactive" }), false, false),
    decideWatchEntry(watched(), kitSub(), true, false),
    decideWatchEntry(watched(), kitSub(), false, false),
  ];
  for (const d of casos) {
    assert.match(renderWatchDecision(d), /pedro@example\.com/, `decisão ${d.kind} precisa nomear quem`);
  }
});
