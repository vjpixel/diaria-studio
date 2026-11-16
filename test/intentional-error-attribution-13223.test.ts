/**
 * #13223 — o scrub do erro intencional trocava um nome REAL em todas as
 * ocorrências. Caso real: a 261008 plantou "Sonnet" no lugar de "Haiku"
 * (`category: "attribution"`). "Sonnet" tem mais de 3 letras e nenhum dígito,
 * então `isAmbiguousWrongValue` o tratava como grafia errada e o scrub trocava
 * as 6 ocorrências, inclusive as legítimas: o título derivado virava "Haiku
 * 5.5 supera o Haiku 5", e o guard recusava qualquer draft que citasse Sonnet.
 *
 * Regra nova: quem decide é a `category` do registro. Só grafia
 * (`ortografico`/`spelling`) troca em todas as ocorrências e bloqueia no
 * guard; nome real trocado vai pelo caminho ambíguo (seção de `location`,
 * guard só avisa).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findDraftIntentionalErrorLeaks,
  findScopedIntentionalErrorLeaks,
  isAmbiguousPair,
  loadIntentionalErrorPair,
  pairFromRecord,
  readReviewedMdScrubbed,
  scrubIntentionalError,
} from "../scripts/lib/intentional-error-scrub.ts";
import { annualScrubScope, destaquesForPost } from "../scripts/collect-annual.ts";
import type { UnifiedCachedPost } from "../scripts/lib/shared/edition-cache-reader.ts";

/** Registro real: `data/editions/2610/261008/_internal/intentional-error.json`. */
const ERR_261008 = {
  description: "trocou o nome do modelo no destaque sobre o corte de preço do Claude Haiku 5.5",
  location: "DESTAQUE 1, parágrafo 2",
  category: "attribution",
  correct_value: "Haiku",
  wrong_value: "Sonnet",
  reveal: 'Na última edição, escrevi "Sonnet" no destaque sobre o Claude Haiku 5.5, onde o certo era "Haiku".',
};

/** Trecho real do `02-reviewed.md` da 261008 (título + DESTAQUE 1 + início do D2). */
const MD_261008 = [
  "TÍTULO",
  "",
  "Haiku 5.5 supera o Sonnet 5 e custa até 95% menos",
  "",
  "---",
  "",
  "**DESTAQUE 1 | 💰 MERCADO**",
  "",
  "**[Haiku 5.5 supera o Sonnet 5 e custa até 95% menos](https://www.anthropic.com/claude-haiku-5-5)**  ",
  "",
  "A Anthropic lançou o Claude Haiku 5.5 e passou a cobrar US$ 0,10 por milhão de tokens de entrada, contra US$ 1,00 no Haiku 4.5 e US$ 2,00 no Sonnet 5.",
  "",
  "É o modelo mais rápido da casa na velocidade padrão e o primeiro Sonnet com ajuste de esforço.",
  "",
  "No mesmo anúncio, a leitura de cache do Sonnet 5.5 caiu pela metade.",
  "",
  "Por que isso importa:",
  "",
  "A Anthropic aponta o Haiku 5.5 para tarefas curtas e repetitivas, e admite que Sonnet e Opus seguem melhores em programação complexa.",
  "",
  "---",
  "",
  "**DESTAQUE 2 | 🚀 LANÇAMENTO**",
  "",
  "**[Nano Banana 2.1 bate o Pro, mas tropeça no texto](https://deepmind.google/models/model-cards/nano-banana-2-1/)**  ",
  "",
  "Um modelo da linha Flash superou o Pro na avaliação do próprio Google.",
  "",
].join("\n");

const tmpRoots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function writeEdition(dir: string, md: string, rec: Record<string, unknown>): void {
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), md);
  writeFileSync(join(dir, "_internal", "intentional-error.json"), JSON.stringify(rec, null, 2));
}

describe("#13223 categoria decide se o valor é ambíguo", () => {
  it("pairFromRecord leva a category (JSON) ou o error_type (JSONL)", () => {
    assert.equal(pairFromRecord("261008", ERR_261008)?.category, "attribution");
    assert.equal(
      pairFromRecord("261008", { wrong_value: "Sonnet", correct_value: "Haiku", error_type: "attribution" })?.category,
      "attribution",
    );
    assert.equal("category" in (pairFromRecord("261008", { wrong_value: "Sonnet", correct_value: "Haiku" }) ?? {}), false);
  });

  it("isAmbiguousPair: nome real trocado é ambíguo; grafia errada não", () => {
    assert.equal(isAmbiguousPair({ wrong: "Sonnet", category: "attribution" }), true);
    assert.equal(isAmbiguousPair({ wrong: "Google", category: "attribution" }), true);
    assert.equal(isAmbiguousPair({ wrong: "Bluesky", category: "factual" }), true);
    assert.equal(isAmbiguousPair({ wrong: "Appel", category: "ortografico" }), false);
    assert.equal(isAmbiguousPair({ wrong: "Anthropik", category: "spelling" }), false);
    assert.equal(isAmbiguousPair({ wrong: "Appel", category: "Ortográfico" }), false);
    // Sem categoria (ou `unknown` do frontmatter antigo): só a forma da string.
    assert.equal(isAmbiguousPair({ wrong: "Appel" }), false);
    assert.equal(isAmbiguousPair({ wrong: "Appel", category: "unknown" }), false);
    // Número continua ambíguo mesmo como grafia.
    assert.equal(isAmbiguousPair({ wrong: "2025", category: "ortografico" }), true);
  });
});

describe("#13223 scrub: nome real nunca é trocado em todas as ocorrências", () => {
  const pair = pairFromRecord("261008", ERR_261008)!;

  it("261008 real: várias ocorrências no DESTAQUE 1 → texto intacto (nada de 'Haiku 5.5 supera o Haiku 5')", () => {
    const out = scrubIntentionalError(MD_261008, pair);
    assert.equal(out, MD_261008);
    assert.match(out, /Haiku 5\.5 supera o Sonnet 5/);
    assert.doesNotMatch(out, /supera o Haiku 5\b/);
    assert.doesNotMatch(out, /US\$ 2,00 no Haiku 5/);
  });

  it("readReviewedMdScrubbed com o registro real da 261008 não corrompe o título nem o corpo", () => {
    const dir = tmp("ie-13223-read-");
    writeEdition(dir, MD_261008, ERR_261008);
    assert.equal(loadIntentionalErrorPair(dir, "261008")?.category, "attribution");
    assert.equal(readReviewedMdScrubbed(dir, "261008"), MD_261008);
  });

  it("única ocorrência na seção de location → troca só ela, o nome legítimo fora da seção fica", () => {
    const md = [
      "**DESTAQUE 1 | MERCADO**",
      "",
      "A Google lançou o iPhone 18.",
      "",
      "**DESTAQUE 2 | LANÇAMENTO**",
      "",
      "O Google atualizou o Gemini.",
      "",
    ].join("\n");
    const out = scrubIntentionalError(md, {
      edition: "260910",
      wrong: "Google",
      correct: "Apple",
      location: "DESTAQUE 1",
      category: "attribution",
    });
    assert.match(out, /A Apple lançou o iPhone 18/);
    assert.match(out, /O Google atualizou o Gemini/);
  });

  it("nome real é sensível a maiúsculas ('SONNET' em caixa alta não é o erro plantado)", () => {
    const out = scrubIntentionalError("TÍTULO EM CAIXA: SONNET 5 vs Sonnet.", { ...pair, location: undefined });
    assert.equal(out, "TÍTULO EM CAIXA: SONNET 5 vs Haiku.");
  });

  it("grafia (ortografico) segue trocando todas as ocorrências, em qualquer caixa", () => {
    const out = scrubIntentionalError("Appel e APPEL", { edition: "261111", wrong: "Appel", correct: "Apple", category: "ortografico" });
    assert.equal(out, "Apple e APPLE");
  });
});

describe("#13223 guard: nome real trocado só avisa", () => {
  it("draft mensal/anual que cita Sonnet/Google não é recusado (advisory, não blocking)", () => {
    const pairs = [
      pairFromRecord("261008", ERR_261008)!,
      pairFromRecord("260910", { wrong_value: "Google", correct_value: "Apple", category: "attribution" })!,
      pairFromRecord("261111", { wrong_value: "Appel", correct_value: "Apple", category: "ortografico" })!,
    ];
    const r = findDraftIntentionalErrorLeaks("O Google e a Anthropic: Sonnet 5 contra Haiku 5.5. Appel.", pairs);
    assert.deepEqual(r.blocking.map((l) => l.wrong), ["Appel"]);
    assert.deepEqual(r.advisory.map((l) => l.wrong).sort(), ["Google", "Sonnet"]);
  });

  it("segmento sem origem com 'Google' não bloqueia o carrossel semanal", () => {
    const pairs = [pairFromRecord("260910", { wrong_value: "Google", correct_value: "Apple", category: "attribution" })!];
    const r = findScopedIntentionalErrorLeaks([{ edition: null, text: "Abertura: o Google na semana." }], pairs);
    assert.equal(r.blocking.length, 0);
    assert.equal(r.advisory.length, 1);
  });
});

describe("#13223 anual: scrub campo a campo não corrompe o título", () => {
  it("destaquesForPost com a 261008 real mantém 'supera o Sonnet 5' no título", () => {
    const root = tmp("ie-13223-annual-");
    const dir = join(root, "261008");
    writeEdition(dir, MD_261008, ERR_261008);
    const pair = pairFromRecord("261008", ERR_261008)!;
    assert.equal(annualScrubScope(pair), 1);
    const post: UnifiedCachedPost = { origin: "beehiiv", status: "confirmed", slug: "post-x", content: { free: { web: "<html></html>" } } };
    const r = destaquesForPost(post, "261008", new Map([["261008", dir]]), []);
    assert.equal(r.source, "edicoes-locais");
    assert.ok(r.destaques.length >= 1);
    assert.match(r.destaques[0].title, /supera o Sonnet 5/);
    assert.doesNotMatch(JSON.stringify(r.destaques), /supera o Haiku 5\b|no Haiku 5\b/);
  });
});
