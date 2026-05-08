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

describe("composeRevealText (#911)", () => {
  it("usa gabarito + detail quando ambos disponíveis", () => {
    const prev: IntentionalError = {
      edition: "260506",
      error_type: "wrong_number",
      is_feature: true,
      detail: "Texto trazia '220 anos' onde deveria ser '22 anos'",
      // @ts-expect-error — gabarito é campo extra do schema do editor
      gabarito: "22 anos",
    };
    const text = composeRevealText(prev);
    assert.match(text, /260506/);
    assert.match(text, /220 anos/);
    assert.match(text, /22 anos/);
  });

  it("usa só detail quando gabarito ausente", () => {
    const prev: IntentionalError = {
      edition: "260505",
      error_type: "version_inconsistency",
      is_feature: true,
      detail: "V4 no título, V5/V6/V7 nos parágrafos do D2",
    };
    const text = composeRevealText(prev);
    assert.match(text, /V4/);
    assert.match(text, /260505/);
  });

  it("fallback genérico quando detail vazio", () => {
    const prev: IntentionalError = {
      edition: "260504",
      error_type: "factual",
      is_feature: true,
    };
    const text = composeRevealText(prev);
    assert.match(text, /erro intencional/);
  });

  it("#915: strings entre aspas duplas saem em negrito", () => {
    const prev: IntentionalError = {
      edition: "260506",
      error_type: "wrong_number",
      is_feature: true,
      detail: 'escrevi "fundadores de 220 anos" onde deveria ser "fundadores de 22 anos"',
    };
    const text = composeRevealText(prev);
    assert.match(text, /\*\*"fundadores de 220 anos"\*\*/);
    assert.match(text, /\*\*"fundadores de 22 anos"\*\*/);
  });

  it("#915: strings entre aspas simples (legacy) também saem em negrito", () => {
    const prev: IntentionalError = {
      edition: "260506",
      error_type: "wrong_number",
      is_feature: true,
      detail: "Texto trazia '220 anos' onde deveria ser '22 anos'",
      // @ts-expect-error — gabarito é campo extra
      gabarito: "22 anos",
    };
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

describe("renderSection (#911)", () => {
  it("inclui header + reveal + convite quando reveal presente", () => {
    const block = renderSection("A edição anterior (260506) tinha um erro: X.");
    assert.match(block, /\*\*ERRO INTENCIONAL\*\*/);
    assert.match(block, /tinha um erro: X/);
    assert.match(block, /sorteio mensal/);
  });

  it("usa fallback neutro quando reveal=null", () => {
    const block = renderSection(null);
    assert.match(block, /\*\*ERRO INTENCIONAL\*\*/);
    assert.match(block, /não trazia erro intencional declarado/);
    assert.match(block, /sorteio mensal/);
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

describe("extractIntentionalErrorFromMd (#961)", () => {
  it("extrai detail/gabarito da linha 'Nessa edição, escrevi \"X\" onde deveria ser \"Y\"' (aspas duplas)", () => {
    const md = `Texto.\n\nNessa edição, escrevi "iPhone 5 e 6" onde deveria ser "iPhone 15 e 16".\n\nMais texto.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.deepEqual(r, { detail: "iPhone 5 e 6", gabarito: "iPhone 15 e 16" });
  });

  it("extrai com aspas simples (caso histórico)", () => {
    const md = `Nessa edição, escrevi 'V4' onde deveria ser 'V8'.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.deepEqual(r, { detail: "V4", gabarito: "V8" });
  });

  it("retorna null quando linha não existe", () => {
    const md = `Nada de erro intencional aqui.`;
    assert.equal(extractIntentionalErrorFromMd(md), null);
  });

  it("retorna null quando linha está malformada", () => {
    const md = `Nessa edição, escrevi "X" mas esqueci o resto.`;
    assert.equal(extractIntentionalErrorFromMd(md), null);
  });

  it("#991: rejeita aspas cruzadas (open=\" close=' no detail)", () => {
    const md = `Nessa edição, escrevi "X' onde deveria ser "Y".`;
    assert.equal(
      extractIntentionalErrorFromMd(md),
      null,
      "back-reference \\1 deve forçar mesma aspa abrindo e fechando",
    );
  });

  it("#991: aceita aspas duplas em ambos os lados", () => {
    const md = `Nessa edição, escrevi "X" onde deveria ser "Y".`;
    assert.deepEqual(extractIntentionalErrorFromMd(md), { detail: "X", gabarito: "Y" });
  });

  it("#991: aceita aspas simples em ambos os lados", () => {
    const md = `Nessa edição, escrevi 'X' onde deveria ser 'Y'.`;
    assert.deepEqual(extractIntentionalErrorFromMd(md), { detail: "X", gabarito: "Y" });
  });

  it("#991: aceita aspas mistas — duplas no detail + simples no gabarito (cada lado consistente)", () => {
    const md = `Nessa edição, escrevi "X" onde deveria ser 'Y'.`;
    assert.deepEqual(extractIntentionalErrorFromMd(md), { detail: "X", gabarito: "Y" });
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
      assert.deepEqual(r, { edition: "260505", detail: "X", gabarito: "Y" });
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
      assert.match(updated, /22 anos/);
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
