/**
 * test/title-shorts-front-load-12464.test.ts (#12464)
 *
 * O título do D1 é o título do Short (#12463), e o feed de Shorts no celular
 * mostra ~40 caracteres. Regra do editor: front-load (os ~40 primeiros se leem
 * sozinhos), não teto — o D1 segue até 70. Check warning-only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SHORTS_FEED_VISIBLE_TITLE_CHARS,
  checkD1ShortsFrontLoad,
  formatShortsFrontLoadWarning,
  shortsFeedVisibleSlice,
} from "../scripts/lib/lint-checks/title-shorts-front-load.ts";
import { checkTitleLimits, MAX_SUBJECT_LENGTH } from "../scripts/lib/lint-checks/title-limits.ts";
import { STAGE_4_RULES, checkTitleShortsFrontLoadInvariant } from "../scripts/lib/invariant-checks/stage-4.ts";

function edition(d1: string, d2 = "Título curto do segundo"): string {
  return [
    "**DESTAQUE 1 | PRODUTO**",
    "",
    `**[${d1}](https://example.com/1)**`,
    "",
    "Corpo do destaque.",
    "",
    "**DESTAQUE 2 | PESQUISA**",
    "",
    `**[${d2}](https://example.com/2)**`,
    "",
    "Corpo do destaque.",
  ].join("\n");
}

const DANGLING = "Google lança modelo que entende vídeo e áudio ao mesmo tempo";
const FRONT_LOADED = "Itaú lança IA nativa para 300 mil clientes do banco";
// Caso real do #12062: a fatia visível termina em "para" e fica pendurada.
const REAL_DANGLING = "Golpe da selfie: criminosos usam IA para copiar seu rosto";

describe("shortsFeedVisibleSlice (#12464)", () => {
  it("constante única de 40 caracteres", () => {
    assert.equal(SHORTS_FEED_VISIBLE_TITLE_CHARS, 40);
  });

  it("título que cabe volta inteiro", () => {
    assert.equal(shortsFeedVisibleSlice("Itaú lança IA nativa"), "Itaú lança IA nativa");
  });

  it("corta em fronteira de palavra, nunca no meio", () => {
    const v = shortsFeedVisibleSlice("Anthropic lança agente que programa sozinho por horas seguidas");
    assert.equal(v, "Anthropic lança agente que programa");
    assert.ok(Array.from(v).length <= 40);
  });

  it("corte exatamente num espaço mantém a última palavra", () => {
    // 40 grafemas exatos antes do espaço.
    const t = `${"a".repeat(19)} ${"b".repeat(20)} resto`;
    assert.equal(shortsFeedVisibleSlice(t), `${"a".repeat(19)} ${"b".repeat(20)}`);
  });

  it("conta grafemas, não unidades UTF-16 (emoji de bandeira)", () => {
    const t = `🇧🇷 ${"x".repeat(37)} fim do título`;
    assert.equal(shortsFeedVisibleSlice(t), `🇧🇷 ${"x".repeat(37)}`);
  });
});

describe("checkD1ShortsFrontLoad (#12464)", () => {
  it("fatia que termina em palavra de ligação vira aviso, com a fatia no detalhe", () => {
    const r = checkD1ShortsFrontLoad(edition(DANGLING));
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].visible, "Google lança modelo que entende vídeo e");
    assert.equal(r.errors[0].reason, "dangling-word");
    assert.equal(r.errors[0].tail, "e");
    assert.match(formatShortsFrontLoadWarning(r.errors[0]), /feed de Shorts/);
  });

  it("título front-loaded (acima de 40, abaixo de 70) passa: é regra de front-load, não teto", () => {
    assert.ok(Array.from(FRONT_LOADED).length > 40);
    assert.equal(checkD1ShortsFrontLoad(edition(FRONT_LOADED)).ok, true);
    // O teto de 70 do assunto do e-mail continua sendo o limite.
    assert.equal(MAX_SUBJECT_LENGTH, 70);
    assert.equal(checkTitleLimits(edition(FRONT_LOADED)).ok, true);
  });

  it("título da 261104 (#12062): a fatia termina em \"para\" e acende", () => {
    const r = checkD1ShortsFrontLoad(edition(REAL_DANGLING));
    assert.equal(r.errors[0]?.visible, "Golpe da selfie: criminosos usam IA para");
    assert.equal(r.errors[0]?.tail, "para");
  });

  it("título de até 40 caracteres nunca acende", () => {
    assert.equal(checkD1ShortsFrontLoad(edition("OpenAI lança o GPT-6 para todos")).ok, true);
  });

  it("só o D1 conta (D2/D3 não viram Short)", () => {
    assert.equal(checkD1ShortsFrontLoad(edition(FRONT_LOADED, DANGLING)).ok, true);
  });

  it("fatia com uma palavra só (sem espaço nos 40) vira aviso", () => {
    const r = checkD1ShortsFrontLoad(edition(`${"Supercalifragilistico".repeat(2)} e mais coisa`));
    assert.equal(r.errors[0]?.reason, "too-few-words");
  });

  it("não entra no title-length (bloqueante do Stage 2)", () => {
    assert.equal(checkTitleLimits(edition(DANGLING)).ok, true);
  });
});

describe("checkTitleShortsFrontLoadInvariant (#12464)", () => {
  it("vira warning no Stage 4 e está registrado", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-shorts-front-load-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(resolve(dir, "02-reviewed.md"), edition(DANGLING));
    try {
      const v = checkTitleShortsFrontLoadInvariant(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "title-shorts-front-load");
      assert.equal(v[0].source_issue, "#12464");
    } finally {
      rmSync(dir, { recursive: true });
    }
    const rule = STAGE_4_RULES.find((r) => r.id === "title-shorts-front-load");
    assert.ok(rule);
    assert.equal(rule!.stage, 4);
  });
});
