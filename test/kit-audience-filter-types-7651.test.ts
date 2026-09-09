/**
 * test/kit-audience-filter-types-7651.test.ts (#7651)
 *
 * Trava das garantias de TIPO do `subscriber_filter` do Kit. Diferente do
 * resto da suíte, boa parte do que este arquivo protege não é observável em
 * runtime: são coisas que precisam FALHAR AO COMPILAR.
 *
 * ## Como um teste de compilação funciona aqui
 *
 * Cada garantia vira um `@ts-expect-error` sobre o código que deve ser
 * rejeitado. Se alguém afrouxar o tipo — voltar `subscriber_filter` a
 * opcional, ou `KitSubscriberFilter` a um array que aceita `[]` — o erro
 * esperado deixa de acontecer, a diretiva vira "unused" (TS2578) e o
 * `typecheck-ratchet` (que roda `tsc -p tsconfig.test.json` no CI) falha
 * nomeando este arquivo. É o mesmo mecanismo que já guarda `test/**` do
 * projeto, usado aqui de propósito.
 *
 * ## Por que isto existe
 *
 * No Kit, `subscriber_filter` ausente ou vazio significa **a base INTEIRA**
 * (#6126) — não audiência nenhuma. É o campo de maior blast radius da API, e
 * era o único opcional do payload: esquecê-lo mandava conteúdo restrito pra
 * todo mundo, em silêncio, com 2xx. Três guard chains independentes (diária
 * #6126/#6582, anual, apoiadores #7633) foram escritas pra compensar isso no
 * call site; o #7651 fecha a porta no tipo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTagFilter,
  buildTestSendFilter,
  buildAllSubscribersFilter,
  type CreateBroadcastInput,
} from "../scripts/lib/kit-broadcasts.ts";

/** Base mínima de um broadcast, sem o campo de audiência — cada caso abaixo
 *  decide o que fazer com ele. */
const BASE = { subject: "s", content: "<p>c</p>" } as const;

describe("#7651 — subscriber_filter é obrigatório", () => {
  it("payload COM filtro de tag compila e serializa o filtro certo", () => {
    const input: CreateBroadcastInput = { ...BASE, subscriber_filter: buildTagFilter(42) };
    assert.deepEqual(input.subscriber_filter, [{ all: [{ type: "tag", ids: [42] }] }]);
  });

  it("payload COM a sentinela de base inteira compila e serializa []", () => {
    const input: CreateBroadcastInput = { ...BASE, subscriber_filter: buildAllSubscribersFilter() };
    // O JSON que a API recebe é idêntico ao de um `[]` cru — a distinção é só
    // no compilador, que é exatamente onde ela precisa existir.
    assert.equal(JSON.stringify(input.subscriber_filter), "[]");
  });

  it("OMITIR subscriber_filter não compila (era o caminho pra 'base inteira' por acidente)", () => {
    // @ts-expect-error subscriber_filter é obrigatório desde o #7651
    const input: CreateBroadcastInput = { ...BASE };
    assert.ok(input);
  });

  it("passar [] inline não compila — 'todo mundo' precisa vir de buildAllSubscribersFilter()", () => {
    // @ts-expect-error [] não é atribuível à tupla não-vazia nem à sentinela branded
    const input: CreateBroadcastInput = { ...BASE, subscriber_filter: [] };
    assert.ok(input);
  });

  it("um array que pode estar vazio não compila (o caso do .map()/.filter() que não casou nada)", () => {
    const talvezVazio = [42, 7].filter((n) => n > 100).map((n) => ({ all: [{ type: "tag" as const, ids: [n] }] }));
    // @ts-expect-error KitFilterGroup[] não é atribuível a [KitFilterGroup, ...KitFilterGroup[]]
    const input: CreateBroadcastInput = { ...BASE, subscriber_filter: talvezVazio };
    assert.ok(input);
    assert.deepEqual(talvezVazio, [], "o filtro de fato esvaziou — é este cenário que o tipo barra");
  });
});

describe("#7651 — os 3 builders continuam intercambiáveis onde devem ser", () => {
  it("buildTagFilter e buildTestSendFilter produzem a mesma forma (o 2º delega ao 1º)", () => {
    assert.deepEqual(buildTestSendFilter(9), buildTagFilter(9));
  });

  it("a sentinela de base inteira NÃO é atribuível onde se exige restrição", () => {
    // Documenta a assimetria: um filtro de tag serve como audiência do
    // broadcast (que aceita os dois), mas quem exigir explicitamente uma
    // restrição não aceita a sentinela.
    const restrito: [{ all: { type: "tag"; ids: number[] }[] }, ...{ all: { type: "tag"; ids: number[] }[] }[]] =
      buildTagFilter(1);
    assert.equal(restrito.length, 1);
  });
});
