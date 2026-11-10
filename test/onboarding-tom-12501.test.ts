/**
 * #12501: os 3 e-mails de onboarding (fonte versionada em
 * context/templates/onboarding/) seguem o tom dos e-mails pessoais definido
 * pelo editor na #10605, e continuam enviáveis pelo mesmo parser que o
 * executor usa (`parseOnboardingSnippet`/`assertSnippetSendable`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertSnippetSendable, parseOnboardingSnippet } from "../scripts/lib/onboarding-state.ts";

const DIR = resolve(import.meta.dirname, "..", "context", "templates", "onboarding");

function load(n: number) {
  const raw = readFileSync(resolve(DIR, `onboarding-${n}.md`), "utf8");
  const snip = parseOnboardingSnippet(raw, n);
  assert.ok(snip, `onboarding-${n}.md não parseou`);
  return { raw, snip };
}

function paragraphs(body: string): string[] {
  return [...body.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
}

for (const n of [1, 2, 3]) {
  test(`#12501 onboarding-${n}: enviável pelo parser do executor`, () => {
    const { snip } = load(n);
    assert.doesNotThrow(() => assertSnippetSendable(snip));
    assert.equal(snip.hasPendingMarker, false);
    assert.ok(snip.previewText, "preview_text ausente");
  });

  test(`#12501 onboarding-${n}: abre com "Olá! Tudo bem?" num parágrafo próprio`, () => {
    const { snip } = load(n);
    const ps = paragraphs(snip.body);
    assert.equal(ps[0], "Olá! Tudo bem?");
    assert.ok(ps.length >= 3, "texto precisa começar no parágrafo seguinte");
  });

  test(`#12501 onboarding-${n}: sem apresentação, sem seta, sem "tô"/"tá", sem markdown`, () => {
    const { snip } = load(n);
    const text = paragraphs(snip.body).join("\n");
    assert.doesNotMatch(text, /Pixel aqui|Eu sou o Pixel|Sou o Pixel/i);
    assert.doesNotMatch(snip.body, /[→←]/);
    // Lookaround com \p{L}: `\b` do JS não trata "ô"/"á" como letra.
    assert.doesNotMatch(text, /(?<!\p{L})(tô|tá)(?!\p{L})/iu);
    assert.doesNotMatch(snip.body, /\*\*|^#|^- /m);
    // Antítese-revelação vetada pelo editor ("não é X, é Y").
    assert.doesNotMatch(text, /não é [^.,:;]+, é /i);
  });

  test(`#12501 onboarding-${n}: assina "Pixel" no último parágrafo`, () => {
    const { snip } = load(n);
    const ps = paragraphs(snip.body);
    assert.match(ps[ps.length - 1], /(^|\s|,)Pixel$/);
  });
}

test("#12501: links e valores dos e-mails continuam no texto", () => {
  // O endereço literal fica fora do git (guard de PII #6753); o template usa o
  // placeholder, trocado à mão ao copiar para data/snippets/ (ver cabeçalho).
  assert.match(load(1).snip.body, /mailto:\{\{EMAIL_CONTATO\}\}">\{\{EMAIL_CONTATO\}\}</);
  const b2 = load(2).snip.body;
  assert.match(b2, /youtube\.com\/@diariabr\?sub_confirmation=1/);
  assert.match(b2, /youtu\.be\/OCtGv0f_6sg/);
  const b3 = load(3).snip.body;
  assert.match(b3, /https:\/\/apoia\.se\/diaria/);
  assert.match(b3, /R\$5\/mês/);
  assert.match(b3, /R\$10\/mês/);
  assert.match(b3, /Obrigado,<br>Pixel/);
});
