/**
 * test/render-erro-intencional.test.ts (#911)
 *
 * Cobre helpers puros + integração CLI da seção ERRO INTENCIONAL na
 * newsletter. Concurso mensal "Ache o erro" — newsletter revela gabarito
 * da edição anterior + chama leitor pra acertar erro da atual.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import {
  findPreviousIntentionalError,
  composeRevealText,
  renderSection,
  insertOrUpdateSection,
  currentHasIntentionalErrorFlag,
  boldQuotedStrings,
  extractIntentionalErrorFromMd,
  findPreviousIntentionalErrorFromMd,
} from "../scripts/render-erro-intencional.ts";
import type { IntentionalError } from "../scripts/lib/intentional-errors.ts";

describe("findPreviousIntentionalError (#911)", () => {
  it("retorna o erro mais recente anterior à edição atual", () => {
    const errors: IntentionalError[] = [
      { edition: "260505", error_type: "factual", is_feature: true, detail: "X" },
      { edition: "260506", error_type: "factual", is_feature: true, detail: "Y" },
      { edition: "260507", error_type: "factual", is_feature: true, detail: "Z" },
    ];
    const r = findPreviousIntentionalError(errors, "260507");
    assert.equal(r?.edition, "260506");
  });

  it("retorna null quando não há erro anterior", () => {
    const errors: IntentionalError[] = [
      { edition: "260507", error_type: "factual", is_feature: true, detail: "Z" },
    ];
    const r = findPreviousIntentionalError(errors, "260505");
    assert.equal(r, null);
  });

  it("ignora entries com is_feature: false", () => {
    const errors: IntentionalError[] = [
      { edition: "260506", error_type: "factual", is_feature: false, detail: "X" },
      { edition: "260505", error_type: "factual", is_feature: true, detail: "Y" },
    ];
    const r = findPreviousIntentionalError(errors, "260507");
    assert.equal(r?.edition, "260505");
  });
});

describe("composeRevealText (#1079)", () => {
  it("usa narrative quando disponível (novo formato)", () => {
    const prev = {
      edition: "260510",
      error_type: "count_mismatch",
      is_feature: true,
      narrative: "eu disse que a OpenAI lançou 4 modelos, mas listei 3",
    } as IntentionalError & { narrative: string };
    const text = composeRevealText(prev);
    assert.match(text, /^Na última edição, eu disse/);
    assert.match(text, /OpenAI lançou 4 modelos, mas listei 3/);
  });

  it("compõe a partir de detail + gabarito legados quando narrative ausente", () => {
    const prev = {
      edition: "260506",
      error_type: "wrong_number",
      is_feature: true,
      detail: "Texto trazia '220 anos' onde deveria ser '22 anos'",
      gabarito: "22 anos",
    } as IntentionalError & { gabarito: string };
    const text = composeRevealText(prev);
    assert.match(text, /^Na última edição, /);
    assert.match(text, /220 anos/);
    assert.match(text, /mas o correto era/);
    assert.match(text, /22 anos/);
  });

  it("usa só detail quando gabarito + narrative ausentes", () => {
    const prev: IntentionalError = {
      edition: "260505",
      error_type: "version_inconsistency",
      is_feature: true,
      detail: "V4 no título, V5/V6/V7 nos parágrafos do D2",
    };
    const text = composeRevealText(prev);
    assert.match(text, /^Na última edição, /);
    assert.match(text, /V4/);
  });

  it("fallback genérico quando detail/gabarito/narrative todos ausentes", () => {
    const prev: IntentionalError = {
      edition: "260504",
      error_type: "factual",
      is_feature: true,
    };
    const text = composeRevealText(prev);
    assert.match(text, /^Na última edição, houve um erro intencional/);
  });

  it("#915: strings entre aspas duplas saem em negrito", () => {
    const prev = {
      edition: "260506",
      error_type: "wrong_number",
      is_feature: true,
      narrative: 'escrevi "fundadores de 220 anos" onde deveria ser "fundadores de 22 anos"',
    } as IntentionalError & { narrative: string };
    const text = composeRevealText(prev);
    assert.match(text, /\*\*"fundadores de 220 anos"\*\*/);
    assert.match(text, /\*\*"fundadores de 22 anos"\*\*/);
  });

  it("#915: strings entre aspas simples (legacy) também saem em negrito", () => {
    const prev = {
      edition: "260506",
      error_type: "wrong_number",
      is_feature: true,
      detail: "Texto trazia '220 anos' onde deveria ser '22 anos'",
      gabarito: "22 anos",
    } as IntentionalError & { gabarito: string };
    const text = composeRevealText(prev);
    assert.match(text, /\*\*'220 anos'\*\*/);
    assert.match(text, /\*\*'22 anos'\*\*/);
  });
});

describe("boldQuotedStrings (#915)", () => {
  it("envolve strings entre aspas duplas em negrito", () => {
    assert.equal(
      boldQuotedStrings('escrevi "X" onde deveria ser "Y"'),
      'escrevi **"X"** onde deveria ser **"Y"**',
    );
  });

  it("envolve strings entre aspas simples em negrito", () => {
    assert.equal(
      boldQuotedStrings("escrevi 'X' onde deveria ser 'Y'"),
      "escrevi **'X'** onde deveria ser **'Y'**",
    );
  });

  it("idempotente: não dobra negrito quando já bold", () => {
    const already = 'escrevi **"X"** onde deveria ser **"Y"**';
    assert.equal(boldQuotedStrings(already), already);
  });

  it("não modifica texto sem aspas", () => {
    assert.equal(
      boldQuotedStrings("texto sem aspas pra tocar"),
      "texto sem aspas pra tocar",
    );
  });

  it("preserva texto fora das aspas", () => {
    const out = boldQuotedStrings('Disse "olá" e foi embora.');
    assert.equal(out, 'Disse **"olá"** e foi embora.');
  });
});

describe("renderSection (#1079)", () => {
  it("inclui header + reveal + placeholder pra declaração corrente quando ausente", () => {
    const block = renderSection("Na última edição, X.");
    assert.match(block, /\*\*ERRO INTENCIONAL\*\*/);
    assert.match(block, /Na última edição, X\./);
    assert.match(block, /\{PREENCHER_NARRATIVA_DO_ERRO\}/);
    // Sem o convite/sorteio mensal (movido pra bloco SORTEIO separado #1079)
    assert.doesNotMatch(block, /sorteio mensal/);
    assert.doesNotMatch(block, /Esta edição tem um erro proposital/);
  });

  it("usa fallback neutro pro reveal quando reveal=null", () => {
    const block = renderSection(null);
    assert.match(block, /\*\*ERRO INTENCIONAL\*\*/);
    assert.match(block, /não trazia erro intencional declarado/);
    // Ainda mostra placeholder pra declaração corrente
    assert.match(block, /\{PREENCHER_NARRATIVA_DO_ERRO\}/);
  });

  it("preserva declaração corrente passada (não usa placeholder)", () => {
    const decl = "Nessa edição, eu disse X, mas Y é o correto.";
    const block = renderSection("Na última edição, A.", decl);
    assert.match(block, /Na última edição, A\./);
    assert.match(block, /Nessa edição, eu disse X, mas Y é o correto\./);
    assert.doesNotMatch(block, /\{PREENCHER_NARRATIVA_DO_ERRO\}/);
  });

  it("placeholder quando currentDeclaration é string vazia", () => {
    const block = renderSection("Na última edição, A.", "");
    assert.match(block, /\{PREENCHER_NARRATIVA_DO_ERRO\}/);
  });
});

describe("insertOrUpdateSection (#911)", () => {
  it("insere a seção antes de ASSINE quando ausente", () => {
    const md = [
      "OUTRAS NOTÍCIAS",
      "",
      "[N1](https://n.com/1)",
      "Desc.",
      "",
      "---",
      "",
      "**ASSINE**",
      "Convite para assinar.",
    ].join("\n");
    const r = insertOrUpdateSection(md, "Reveal X.");
    assert.equal(r.action, "inserted");
    assert.match(r.md, /\*\*ERRO INTENCIONAL\*\*/);
    // ERRO INTENCIONAL deve aparecer ANTES de ASSINE
    const erroIdx = r.md.indexOf("ERRO INTENCIONAL");
    const assineIdx = r.md.indexOf("ASSINE");
    assert.ok(erroIdx > 0 && erroIdx < assineIdx);
  });

  it("idempotente: segunda chamada com mesmo input atualiza, não duplica", () => {
    const md = [
      "OUTRAS NOTÍCIAS",
      "",
      "Item.",
      "",
      "---",
      "",
      "**ASSINE**",
      "X",
    ].join("\n");
    const first = insertOrUpdateSection(md, "Reveal X.");
    assert.equal(first.action, "inserted");
    const second = insertOrUpdateSection(first.md, "Reveal X.");
    // Segunda chamada com o mesmo conteúdo: no_change
    assert.equal(second.action, "no_change");
    // Só uma ocorrência de ERRO INTENCIONAL
    const matches = first.md.match(/\*\*ERRO INTENCIONAL\*\*/g);
    assert.equal(matches?.length, 1);
  });

  it("update: nova reveal substitui a antiga sem duplicar", () => {
    const md = [
      "OUTRAS NOTÍCIAS",
      "",
      "Item.",
      "",
      "---",
      "",
      "**ASSINE**",
      "X",
    ].join("\n");
    const first = insertOrUpdateSection(md, "Reveal antiga.");
    const second = insertOrUpdateSection(first.md, "Reveal nova.");
    assert.equal(second.action, "updated");
    assert.match(second.md, /Reveal nova/);
    assert.doesNotMatch(second.md, /Reveal antiga/);
    const matches = second.md.match(/\*\*ERRO INTENCIONAL\*\*/g);
    assert.equal(matches?.length, 1);
  });

  it("se não há ASSINE/Encerramento, insere no fim", () => {
    const md = ["OUTRAS NOTÍCIAS", "", "Item.", "", "---"].join("\n");
    const r = insertOrUpdateSection(md, "Reveal X.");
    assert.equal(r.action, "inserted");
    assert.match(r.md, /\*\*ERRO INTENCIONAL\*\*/);
  });

  it("#1279: por default, reveal computado SOBRESCREVE existente (evita stale herdado)", () => {
    // Bug recorrente em 260513-260515: template MD da nova edição herdava
    // "Na última edição..." stale da edição anterior, e #1079 preservava
    // silenciosamente. Agora freshly-computed wins por default.
    const md = [
      "OUTRAS NOTÍCIAS",
      "",
      "Item.",
      "",
      "---",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, texto STALE herdado de N-2.",
      "",
      "Nessa edição, eu disse X, mas Y é o correto.",
      "",
      "---",
      "",
      "**ASSINE**",
      "X",
    ].join("\n");
    const r = insertOrUpdateSection(md, "Na última edição, reveal FRESH computado de N-1.");
    assert.match(r.md, /reveal FRESH computado de N-1/);
    assert.doesNotMatch(r.md, /STALE herdado de N-2/);
    // Declaração corrente "Nessa edição..." continua preservada (é tracking do editor)
    assert.match(r.md, /eu disse X, mas Y é o correto/);
  });

  it("#1279: --preserve-existing-reveal opt-in mantém wording manual do editor", () => {
    // Editor pode opt-in pra preservar reveal editado manualmente.
    const md = [
      "Item.",
      "",
      "---",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, wording manual editado pelo Pixel.",
      "",
      "Nessa edição, X.",
      "",
      "---",
      "",
      "**ASSINE**",
      "X",
    ].join("\n");
    const r = insertOrUpdateSection(md, "Reveal CALCULADO DIFERENTE.", {
      preserveExistingReveal: true,
    });
    assert.match(r.md, /wording manual editado pelo Pixel/);
    assert.doesNotMatch(r.md, /CALCULADO DIFERENTE/);
  });

  it("#1079: idempotência com seção completa pré-existente", () => {
    const md = [
      "Item.",
      "",
      "---",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, A.",
      "",
      "Nessa edição, B.",
      "",
      "---",
      "",
      "**ASSINE**",
      "X",
    ].join("\n");
    const first = insertOrUpdateSection(md, "Na última edição, A.");
    const second = insertOrUpdateSection(first.md, "Na última edição, A.");
    assert.equal(second.action, "no_change");
  });
});

describe("currentHasIntentionalErrorFlag (#911)", () => {
  it("detecta intentional_error no frontmatter", () => {
    const md = [
      "---",
      "intentional_error:",
      "  description: X",
      "  location: D1",
      "---",
      "",
      "Body",
    ].join("\n");
    assert.equal(currentHasIntentionalErrorFlag(md), true);
  });

  it("retorna false quando frontmatter sem intentional_error", () => {
    const md = ["---", "title: X", "---", "", "Body"].join("\n");
    assert.equal(currentHasIntentionalErrorFlag(md), false);
  });

  it("retorna false quando sem frontmatter", () => {
    const md = "Apenas body sem frontmatter.";
    assert.equal(currentHasIntentionalErrorFlag(md), false);
  });
});

describe("extractIntentionalErrorFromMd (#961 / #1079)", () => {
  it("#1079: extrai narrative livre (sem aspas)", () => {
    const md = `Nessa edição, eu disse que a OpenAI lançou 4 modelos, mas listei 3 (que é o número correto).`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.narrative, "eu disse que a OpenAI lançou 4 modelos, mas listei 3 (que é o número correto)");
    // detail/gabarito ficam undefined nesse caso (não bate com regex legacy)
    assert.equal(r?.detail, undefined);
    assert.equal(r?.gabarito, undefined);
  });

  it("extrai narrative + detail/gabarito da linha legacy 'escrevi \"X\" onde deveria ser \"Y\"' (back-compat)", () => {
    const md = `Texto.\n\nNessa edição, escrevi "iPhone 5 e 6" onde deveria ser "iPhone 15 e 16".\n\nMais texto.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.detail, "iPhone 5 e 6");
    assert.equal(r?.gabarito, "iPhone 15 e 16");
    assert.match(r?.narrative ?? "", /escrevi "iPhone 5 e 6" onde deveria ser "iPhone 15 e 16"/);
  });

  it("extrai com aspas simples (caso histórico)", () => {
    const md = `Nessa edição, escrevi 'V4' onde deveria ser 'V8'.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.detail, "V4");
    assert.equal(r?.gabarito, "V8");
  });

  it("retorna null quando linha não existe", () => {
    const md = `Nada de erro intencional aqui.`;
    assert.equal(extractIntentionalErrorFromMd(md), null);
  });

  it("captura narrativa parcial quando linha está malformada legacy (#1079: pega texto livre)", () => {
    // No formato novo (#1079), qualquer linha "Nessa edição, X." vira narrative.
    // O regex legacy de aspas só roda como sub-extração; quando falha, retorna só narrative.
    const md = `Nessa edição, escrevi "X" mas esqueci o resto.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.narrative, `escrevi "X" mas esqueci o resto`);
    assert.equal(r?.detail, undefined);
    assert.equal(r?.gabarito, undefined);
  });

  it("#991: aceita aspas duplas em ambos os lados", () => {
    const md = `Nessa edição, escrevi "X" onde deveria ser "Y".`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.detail, "X");
    assert.equal(r?.gabarito, "Y");
  });

  it("#991: aceita aspas simples em ambos os lados", () => {
    const md = `Nessa edição, escrevi 'X' onde deveria ser 'Y'.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.detail, "X");
    assert.equal(r?.gabarito, "Y");
  });

  it("#991: aceita aspas mistas — duplas no detail + simples no gabarito (cada lado consistente)", () => {
    const md = `Nessa edição, escrevi "X" onde deveria ser 'Y'.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.detail, "X");
    assert.equal(r?.gabarito, "Y");
  });

  it("#1079: regex de narrative permite pontos internos quando tudo na mesma linha", () => {
    // Non-greedy [^\n]+? ancorado em \.\s*(\n|$) captura até o último ponto
    // antes da quebra. Narrativas com pontos internos cabem se tudo em 1 linha.
    const md = `Nessa edição, eu disse X. Depois corrigi pra Y.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.narrative, "eu disse X. Depois corrigi pra Y");
  });

  it("#1079: regex de narrative para na primeira quebra de parágrafo", () => {
    // Em reviewed.md real, parágrafos são separados por \n\n. A regex termina
    // no primeiro \n, então linhas subsequentes não são capturadas.
    const md = `Nessa edição, X.\n\nOutro parágrafo. Não capturar.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.narrative, "X");
  });

  it("#1099: ancorado em bloco ERRO INTENCIONAL — ignora 'Nessa edição da Diar.ia' do PARA ENCERRAR", () => {
    const md = `Para esta edição...

---

**DESTAQUE 1 | 🇧🇷 BRASIL**

Texto.

---

**ERRO INTENCIONAL**

Na última edição, foo.

Nessa edição, escrevi 'X' onde deveria ser 'Y'.

---

**🙋🏼‍♀️ PARA ENCERRAR**

Nessa edição da **Diar.ia**, usei Claude Code para automatizar...
`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.narrative, "escrevi 'X' onde deveria ser 'Y'");
    // Confirma que NÃO pegou o PARA ENCERRAR
    assert.doesNotMatch(r?.narrative ?? "", /Diar\.ia|Claude Code/);
  });

  it("#1099: retorna null quando ERRO INTENCIONAL tem só placeholder (não preenchido)", () => {
    const md = `**ERRO INTENCIONAL**

Na última edição, foo.

Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.

---

**🙋🏼‍♀️ PARA ENCERRAR**

Nessa edição da **Diar.ia**, usei Claude Code...
`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r, null, "deve retornar null em placeholder + ignorar PARA ENCERRAR");
  });

  it("#1099: vírgula obrigatória — 'Nessa edição da Diar.ia' (sem vírgula) não matcha", () => {
    const md = `Texto blah.

Nessa edição da **Diar.ia**, usei Claude Code para escrever.
`;
    // Sem header ERRO INTENCIONAL → busca global, mas vírgula é obrigatória.
    // "Nessa edição da Diar.ia" não tem vírgula entre "edição" e "da" → não matcha.
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r, null, "frase do PARA ENCERRAR sem vírgula não deve matchar");
  });
});

describe("findPreviousIntentionalErrorFromMd (#961)", () => {
  it("encontra a edição anterior mais recente com declaração (pulando vazias)", () => {
    const root = mkdtempSync(join(tmpdir(), "preheat-erro-"));
    try {
      mkdirSync(join(root, "260505"), { recursive: true });
      mkdirSync(join(root, "260506"), { recursive: true });
      mkdirSync(join(root, "260507"), { recursive: true });
      writeFileSync(
        join(root, "260505", "02-reviewed.md"),
        `Nessa edição, escrevi "antigo" onde deveria ser "novo".`,
        "utf8",
      );
      writeFileSync(
        join(root, "260506", "02-reviewed.md"),
        `Nessa edição, escrevi "X" onde deveria ser "Y".`,
        "utf8",
      );
      writeFileSync(
        join(root, "260507", "02-reviewed.md"),
        `Sem declaração aqui.`,
        "utf8",
      );

      // 260507 não tem declaração — script pula e usa 260506 (próxima mais recente)
      const r = findPreviousIntentionalErrorFromMd(root, "260508");
      assert.equal(r?.edition, "260506");
      assert.equal(r?.detail, "X");
      assert.equal(r?.gabarito, "Y");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("pula edição anterior sem declaração e usa a anterior", () => {
    const root = mkdtempSync(join(tmpdir(), "preheat-erro-skip-"));
    try {
      mkdirSync(join(root, "260505"), { recursive: true });
      mkdirSync(join(root, "260506"), { recursive: true });
      mkdirSync(join(root, "260507"), { recursive: true });
      writeFileSync(
        join(root, "260505", "02-reviewed.md"),
        `Nessa edição, escrevi "X" onde deveria ser "Y".`,
        "utf8",
      );
      writeFileSync(join(root, "260506", "02-reviewed.md"), `Sem declaração.`, "utf8");
      writeFileSync(join(root, "260507", "02-reviewed.md"), `Outro sem.`, "utf8");

      const r = findPreviousIntentionalErrorFromMd(root, "260508");
      assert.equal(r?.edition, "260505");
      assert.equal(r?.detail, "X");
      assert.equal(r?.gabarito, "Y");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("retorna null quando não há edições anteriores com declaração", () => {
    const root = mkdtempSync(join(tmpdir(), "preheat-erro-empty-"));
    try {
      mkdirSync(join(root, "260505"), { recursive: true });
      writeFileSync(join(root, "260505", "02-reviewed.md"), `Vazio.`, "utf8");
      const r = findPreviousIntentionalErrorFromMd(root, "260508");
      assert.equal(r, null);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("retorna null quando editionsRoot não existe", () => {
    const r = findPreviousIntentionalErrorFromMd("/path/que/nao/existe", "260508");
    assert.equal(r, null);
  });

  it("ignora edições com sufixos não-AAMMDD (backups)", () => {
    const root = mkdtempSync(join(tmpdir(), "preheat-erro-backups-"));
    try {
      mkdirSync(join(root, "260507"), { recursive: true });
      mkdirSync(join(root, "260507-backup-20260507T2352Z"), { recursive: true });
      writeFileSync(
        join(root, "260507", "02-reviewed.md"),
        `Nessa edição, escrevi "A" onde deveria ser "B".`,
        "utf8",
      );
      writeFileSync(
        join(root, "260507-backup-20260507T2352Z", "02-reviewed.md"),
        `Nessa edição, escrevi "BACKUP" onde deveria ser "WRONG".`,
        "utf8",
      );

      const r = findPreviousIntentionalErrorFromMd(root, "260508");
      assert.equal(r?.edition, "260507", "deve usar a versão canônica AAMMDD");
      assert.equal(r?.detail, "A");
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe("render-erro-intencional CLI (#911)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "render-erro-intencional.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("integração: insere seção lendo errors.jsonl + MD", () => {
    const dir = mkdtempSync(join(tmpdir(), "render-erro-int-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const errPath = join(dir, "intentional-errors.jsonl");
      writeFileSync(
        mdPath,
        [
          "OUTRAS NOTÍCIAS",
          "",
          "Item.",
          "",
          "---",
          "",
          "**ASSINE**",
          "Convite.",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        errPath,
        JSON.stringify({
          edition: "260506",
          error_type: "wrong_number",
          is_feature: true,
          detail: "Texto trazia '220 anos' onde deveria ser '22 anos'",
          gabarito: "22 anos",
        }) + "\n",
        "utf8",
      );

      const r = runCli([
        "--edition",
        "260507",
        "--md",
        mdPath,
        "--errors",
        errPath,
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.action, "inserted");
      assert.equal(out.prev_edition, "260506");
      assert.equal(out.prev_revealed, true);
      const updated = readFileSync(mdPath, "utf8");
      assert.match(updated, /\*\*ERRO INTENCIONAL\*\*/);
      // #1079: reveal agora começa com "Na última edição, ..."
      assert.match(updated, /Na última edição/);
      assert.match(updated, /22 anos/);
      // Placeholder pra autor escrever o erro corrente
      assert.match(updated, /\{PREENCHER_NARRATIVA_DO_ERRO\}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("integração: errors.jsonl ausente → seção com placeholder neutro", () => {
    const dir = mkdtempSync(join(tmpdir(), "render-erro-int-noerr-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        ["OUTRAS NOTÍCIAS", "", "Item.", "", "---", "", "**ASSINE**", "X"].join("\n"),
        "utf8",
      );
      const ghostErrPath = join(dir, "ghost.jsonl");
      const r = runCli([
        "--edition",
        "260507",
        "--md",
        mdPath,
        "--errors",
        ghostErrPath,
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.prev_revealed, false);
      const updated = readFileSync(mdPath, "utf8");
      assert.match(updated, /não trazia erro intencional declarado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
