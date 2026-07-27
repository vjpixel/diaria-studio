/**
 * format-weekly-social.test.ts (#4101)
 *
 * Teste de regressão exigido pela issue #4101: formatação por rede respeita
 * o limite — Threads ≤500, Twitter/X ≤280 por tweet — inclusive no PIOR CASO
 * (5 títulos longos, próximos do máximo de 52 chars permitido por destaque,
 * ver `context/editorial-rules.md`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatLinkedInWeekly,
  formatFacebookWeekly,
  formatInstagramWeekly,
  formatThreadsWeekly,
  formatTwitterWeeklyThread,
  THREADS_WEEKLY_CHAR_LIMIT,
  TWITTER_WEEKLY_CHAR_LIMIT,
  INSTAGRAM_WEEKLY_CHAR_LIMIT,
} from "../scripts/lib/format-weekly-social.ts";
import { WeeklyD1Item } from "../scripts/lib/select-weekly-d1.ts";

function makeItems(n: number, titleLen = 20): WeeklyD1Item[] {
  const items: WeeklyD1Item[] = [];
  for (let i = 0; i < n; i++) {
    const title = `Título ${i + 1} `.padEnd(titleLen, "x").slice(0, titleLen);
    items.push({
      editionDate: `26042${i}`,
      title,
      url: `https://example.com/artigo-${i + 1}`,
      category: "Notícias",
    });
  }
  return items;
}

// 52 chars = máximo permitido por destaque (context/editorial-rules.md).
const LONG_TITLE = "Título de destaque bem longo perto do limite máximo!"; // 53 chars
function makeLongItems(n: number, urlLen = 40): WeeklyD1Item[] {
  return Array.from({ length: n }, (_, i) => ({
    editionDate: `26042${i}`,
    title: LONG_TITLE,
    url: `https://example.com/${"a".repeat(urlLen)}/${i}`,
    category: "Notícias",
  }));
}

describe("formatLinkedInWeekly / formatFacebookWeekly", () => {
  it("retorna string vazia para 0 itens", () => {
    assert.equal(formatLinkedInWeekly([]), "");
    assert.equal(formatFacebookWeekly([]), "");
  });

  it("inclui todos os títulos e URLs, numerados", () => {
    const items = makeItems(5);
    const li = formatLinkedInWeekly(items);
    const fb = formatFacebookWeekly(items);
    for (const it of items) {
      assert.ok(li.includes(it.title), `LinkedIn deveria incluir "${it.title}"`);
      assert.ok(li.includes(it.url), `LinkedIn deveria incluir "${it.url}"`);
      assert.ok(fb.includes(it.title));
      assert.ok(fb.includes(it.url));
    }
  });

  it("Facebook inclui o CTA de e-mail; LinkedIn não", () => {
    const items = makeItems(3);
    const fb = formatFacebookWeekly(items);
    const li = formatLinkedInWeekly(items);
    assert.ok(fb.includes("diar.ia.br"));
    assert.ok(!li.toLowerCase().includes("assine"));
  });

  it("4 itens (semana incompleta) formata só os 4, sem placeholder de D5", () => {
    const items = makeItems(4);
    const li = formatLinkedInWeekly(items);
    assert.equal((li.match(/^\d+\./gm) ?? []).length, 4);
  });
});

describe("formatInstagramWeekly", () => {
  it("retorna vazio para 0 itens e nunca excede o limite de caption", () => {
    assert.equal(formatInstagramWeekly([]), "");
    const long = formatInstagramWeekly(makeLongItems(5));
    assert.ok(long.length <= INSTAGRAM_WEEKLY_CHAR_LIMIT);
  });

  it('não inclui URLs cruas no corpo (menciona "link da bio")', () => {
    const items = makeItems(5);
    const caption = formatInstagramWeekly(items);
    assert.ok(caption.toLowerCase().includes("bio"));
    for (const it of items) {
      assert.ok(!caption.includes(it.url), `Instagram não deveria incluir URL crua "${it.url}"`);
    }
  });
});

describe("formatThreadsWeekly", () => {
  it("retorna vazio para 0 itens", () => {
    assert.equal(formatThreadsWeekly([]), "");
  });

  it("cabe as 5 manchetes normais dentro do limite de 500 chars", () => {
    const text = formatThreadsWeekly(makeItems(5));
    assert.ok(text.length <= THREADS_WEEKLY_CHAR_LIMIT);
    assert.ok(text.length > 0);
  });

  it("PIOR CASO — 5 títulos longos (52 chars) + URLs — nunca excede 500 chars", () => {
    const text = formatThreadsWeekly(makeLongItems(5, 60));
    assert.ok(
      text.length <= THREADS_WEEKLY_CHAR_LIMIT,
      `esperado ≤${THREADS_WEEKLY_CHAR_LIMIT}, recebeu ${text.length}`,
    );
  });

  it("4 itens (semana incompleta) formata só os 4 e ainda respeita o limite", () => {
    const text = formatThreadsWeekly(makeItems(4));
    assert.ok(text.length <= THREADS_WEEKLY_CHAR_LIMIT);
    assert.equal((text.match(/^\d+\./gm) ?? []).length, 4);
  });
});

describe("formatTwitterWeeklyThread", () => {
  it("retorna [] para 0 itens", () => {
    assert.deepEqual(formatTwitterWeeklyThread([]), []);
  });

  it("gera 1 tweet de abertura + 1 tweet por destaque, cada um ≤280 chars", () => {
    const items = makeItems(5);
    const tweets = formatTwitterWeeklyThread(items);
    assert.equal(tweets.length, 6); // abertura + 5
    for (const t of tweets) {
      assert.ok(t.length <= TWITTER_WEEKLY_CHAR_LIMIT, `tweet excede 280: "${t}" (${t.length})`);
    }
  });

  it("PIOR CASO — 5 títulos longos (52 chars) + URLs — cada tweet ainda ≤280 chars", () => {
    const items = makeLongItems(5, 60);
    const tweets = formatTwitterWeeklyThread(items);
    assert.equal(tweets.length, 6);
    for (const t of tweets) {
      assert.ok(t.length <= TWITTER_WEEKLY_CHAR_LIMIT, `tweet excede 280: "${t}" (${t.length})`);
    }
    // A URL nunca é truncada — só o título é encurtado.
    items.forEach((it, i) => {
      assert.ok(tweets[i + 1].includes(it.url), `tweet ${i + 1} deveria preservar a URL completa`);
    });
  });

  it("4 itens (semana incompleta) gera thread de 5 (abertura + 4)", () => {
    const tweets = formatTwitterWeeklyThread(makeItems(4));
    assert.equal(tweets.length, 5);
  });
});
