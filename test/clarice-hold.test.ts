import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOLD_SEGMENTS,
  holdSegmentNames,
  parseHoldArg,
  applyHolds,
  describeHolds,
} from "../scripts/lib/clarice-hold.ts";

// Regressão do #4542: o cohort jurídico estava retido só editorialmente —
// nenhuma trava no pipeline. Medido em 260803: 117 dos 124 elegíveis de
// re-envio engajado eram jurídico, com priority_points de até 370, e
// segmentEngajados ordena por priority_points DESC — a próxima build normal
// mandaria pra eles PRIMEIRO.

const juridico = { email: "juridico.foffano@gmail.com" };
const advogado = { email: "mvsales.adv@gmail.com" };
const escritorio = { email: "walter@advocaciabittar.adv.br" };
const comum = { email: "fulano@gmail.com" };

test("parseHoldArg: vazio/ausente não retém nada", () => {
  assert.deepEqual(parseHoldArg(null), []);
  assert.deepEqual(parseHoldArg(undefined), []);
  assert.deepEqual(parseHoldArg(""), []);
  assert.deepEqual(parseHoldArg("   "), []);
});

test("parseHoldArg: aceita nome válido, lista e variação de caixa", () => {
  assert.deepEqual(parseHoldArg("juridico"), ["juridico"]);
  assert.deepEqual(parseHoldArg(" JURIDICO "), ["juridico"]);
  // Dedup: --hold juridico,juridico não pode contar o mesmo contato 2×.
  assert.deepEqual(parseHoldArg("juridico,juridico"), ["juridico"]);
});

test("parseHoldArg: nome desconhecido ABORTA, nunca é ignorado", () => {
  // O modo de falha que a flag existe pra evitar: um typo silencioso manda
  // justamente o segmento que o operador pediu pra segurar.
  for (const ruim of ["jurídico", "legal", "juridicos"]) {
    assert.throws(() => parseHoldArg(ruim), /--hold desconhecido/, `deveria abortar em "${ruim}"`);
  }
  assert.throws(() => parseHoldArg("juridico,legal"), /--hold desconhecido: legal/);
});

test("holdSegmentNames expõe os segmentos registrados", () => {
  assert.ok(holdSegmentNames().includes("juridico"));
  assert.equal(typeof HOLD_SEGMENTS.juridico, "function");
});

test("applyHolds sem holds é no-op (mesmo array, nada retido)", () => {
  const rows = [juridico, comum];
  const r = applyHolds(rows, []);
  assert.deepEqual(r.kept, rows);
  assert.equal(r.heldTotal, 0);
  assert.deepEqual(r.heldBySegment, {});
});

test("applyHolds retém jurídico por handle e por domínio, preserva o resto", () => {
  const r = applyHolds([juridico, advogado, comum, escritorio], ["juridico"]);
  assert.deepEqual(r.kept, [comum], "só o contato comum segue pra seleção");
  assert.equal(r.heldTotal, 3);
  assert.deepEqual(r.heldBySegment, { juridico: 3 });
});

test("applyHolds preserva a ordem da fila entre os mantidos", () => {
  // A ordem da fila carrega a prioridade de envio (priority_points DESC) —
  // reter não pode reordenar quem ficou.
  const fila = [{ email: "a@gmail.com" }, juridico, { email: "b@gmail.com" }, advogado, { email: "c@gmail.com" }];
  const r = applyHolds(fila, ["juridico"]);
  assert.deepEqual(
    r.kept.map((x) => x.email),
    ["a@gmail.com", "b@gmail.com", "c@gmail.com"],
  );
});

test("applyHolds não retém ninguém quando o segmento não casa", () => {
  const rows = [comum, { email: "outro@uol.com.br" }];
  const r = applyHolds(rows, ["juridico"]);
  assert.equal(r.kept.length, 2);
  assert.equal(r.heldTotal, 0);
  assert.equal(describeHolds(r), null, "sem retidos não emite linha de log");
});

test("describeHolds reporta total e detalhe por segmento", () => {
  const r = applyHolds([juridico, advogado, comum], ["juridico"]);
  const linha = describeHolds(r);
  assert.ok(linha, "com retidos precisa emitir linha");
  assert.match(linha as string, /2 contato\(s\) retido\(s\)/);
  assert.match(linha as string, /juridico=2/);
});
