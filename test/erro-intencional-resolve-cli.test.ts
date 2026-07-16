/**
 * test/render-erro-intencional.test.ts (#911)
 *
 * Cobre helpers puros + integração CLI da seção ERRO INTENCIONAL na
 * newsletter. Concurso mensal "Ache o erro" — newsletter revela gabarito
 * da edição anterior + chama leitor pra acertar erro da atual.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  findPreviousIntentionalError,
  currentHasIntentionalErrorFlag,
  extractCurrentDeclarationFromMd,
  findPreviousIntentionalErrorFromMd,
  resolvePreviousError,
  ensureIntentionalErrorJson,
  narrativeIsGenericPlaceholder,
} from "../scripts/render-erro-intencional.ts";
import type { IntentionalError } from "../scripts/lib/intentional-errors.ts";
import {
  loadIntentionalErrorJson,
  intentionalErrorJsonPath,
  type IntentionalErrorJson,
} from "../scripts/lib/intentional-errors.ts";

describe("currentHasIntentionalErrorFlag (#911, migrado pra JSON #3222)", () => {
  it("detecta presença do record _internal/intentional-error.json", () => {
    const record: IntentionalErrorJson = { description: "X", location: "D1" };
    assert.equal(currentHasIntentionalErrorFlag(record), true);
  });

  it("retorna true mesmo com record vazio (presença-only, valores são responsabilidade do lint Stage 5)", () => {
    assert.equal(currentHasIntentionalErrorFlag({}), true);
  });

  it("retorna false quando record é null (arquivo ausente)", () => {
    assert.equal(currentHasIntentionalErrorFlag(null), false);
  });

  it("retorna false quando record é undefined", () => {
    assert.equal(currentHasIntentionalErrorFlag(undefined), false);
  });
});

describe("extractCurrentDeclarationFromMd (#961 / #1079)", () => {
  it("#1079: extrai narrative livre (sem aspas)", () => {
    const md = `Nessa edição, eu disse que a OpenAI lançou 4 modelos, mas listei 3 (que é o número correto).`;
    const r = extractCurrentDeclarationFromMd(md);
    assert.equal(r?.narrative, "eu disse que a OpenAI lançou 4 modelos, mas listei 3 (que é o número correto)");
    // detail/gabarito ficam undefined nesse caso (não bate com regex legacy)
    assert.equal(r?.detail, undefined);
    assert.equal(r?.gabarito, undefined);
  });

  it("extrai narrative + detail/gabarito da linha legacy 'escrevi \"X\" onde deveria ser \"Y\"' (back-compat)", () => {
    const md = `Texto.\n\nNessa edição, escrevi "iPhone 5 e 6" onde deveria ser "iPhone 15 e 16".\n\nMais texto.`;
    const r = extractCurrentDeclarationFromMd(md);
    assert.equal(r?.detail, "iPhone 5 e 6");
    assert.equal(r?.gabarito, "iPhone 15 e 16");
    assert.match(r?.narrative ?? "", /escrevi "iPhone 5 e 6" onde deveria ser "iPhone 15 e 16"/);
  });

  it("extrai com aspas simples (caso histórico)", () => {
    const md = `Nessa edição, escrevi 'V4' onde deveria ser 'V8'.`;
    const r = extractCurrentDeclarationFromMd(md);
    assert.equal(r?.detail, "V4");
    assert.equal(r?.gabarito, "V8");
  });

  it("retorna null quando linha não existe", () => {
    const md = `Nada de erro intencional aqui.`;
    assert.equal(extractCurrentDeclarationFromMd(md), null);
  });

  it("captura narrativa parcial quando linha está malformada legacy (#1079: pega texto livre)", () => {
    // No formato novo (#1079), qualquer linha "Nessa edição, X." vira narrative.
    // O regex legacy de aspas só roda como sub-extração; quando falha, retorna só narrative.
    const md = `Nessa edição, escrevi "X" mas esqueci o resto.`;
    const r = extractCurrentDeclarationFromMd(md);
    assert.equal(r?.narrative, `escrevi "X" mas esqueci o resto`);
    assert.equal(r?.detail, undefined);
    assert.equal(r?.gabarito, undefined);
  });

  it("#991: aceita aspas duplas em ambos os lados", () => {
    const md = `Nessa edição, escrevi "X" onde deveria ser "Y".`;
    const r = extractCurrentDeclarationFromMd(md);
    assert.equal(r?.detail, "X");
    assert.equal(r?.gabarito, "Y");
  });

  it("#991: aceita aspas simples em ambos os lados", () => {
    const md = `Nessa edição, escrevi 'X' onde deveria ser 'Y'.`;
    const r = extractCurrentDeclarationFromMd(md);
    assert.equal(r?.detail, "X");
    assert.equal(r?.gabarito, "Y");
  });

  it("#991: aceita aspas mistas — duplas no detail + simples no gabarito (cada lado consistente)", () => {
    const md = `Nessa edição, escrevi "X" onde deveria ser 'Y'.`;
    const r = extractCurrentDeclarationFromMd(md);
    assert.equal(r?.detail, "X");
    assert.equal(r?.gabarito, "Y");
  });

  it("#1079: regex de narrative permite pontos internos quando tudo na mesma linha", () => {
    // Non-greedy [^\n]+? ancorado em \.\s*(\n|$) captura até o último ponto
    // antes da quebra. Narrativas com pontos internos cabem se tudo em 1 linha.
    const md = `Nessa edição, eu disse X. Depois corrigi pra Y.`;
    const r = extractCurrentDeclarationFromMd(md);
    assert.equal(r?.narrative, "eu disse X. Depois corrigi pra Y");
  });

  it("#1079: regex de narrative para na primeira quebra de parágrafo", () => {
    // Em reviewed.md real, parágrafos são separados por \n\n. A regex termina
    // no primeiro \n, então linhas subsequentes não são capturadas.
    const md = `Nessa edição, X.\n\nOutro parágrafo. Não capturar.`;
    const r = extractCurrentDeclarationFromMd(md);
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
    const r = extractCurrentDeclarationFromMd(md);
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
    const r = extractCurrentDeclarationFromMd(md);
    assert.equal(r, null, "deve retornar null em placeholder + ignorar PARA ENCERRAR");
  });

  it("#1099: vírgula obrigatória — 'Nessa edição da Diar.ia' (sem vírgula) não matcha", () => {
    const md = `Texto blah.

Nessa edição da **Diar.ia**, usei Claude Code para escrever.
`;
    // Sem header ERRO INTENCIONAL → busca global, mas vírgula é obrigatória.
    // "Nessa edição da Diar.ia" não tem vírgula entre "edição" e "da" → não matcha.
    const r = extractCurrentDeclarationFromMd(md);
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

describe("resolvePreviousError (#1854/#1860)", () => {
  const jsonl = (edition: string, extra: Partial<IntentionalError> = {}): IntentionalError => ({
    edition,
    error_type: "factual",
    is_feature: true,
    detail: `detail-${edition}`,
    ...extra,
  });
  const md = (edition: string, extra: Partial<Record<string, string>> = {}) => ({
    edition,
    detail: `md-detail-${edition}`,
    gabarito: `md-gabarito-${edition}`,
    narrative: `md-narrativa-${edition}`,
    ...extra,
  });

  it("mesma edição → enriquece JSONL com campos do MD (source jsonl+md)", () => {
    const r = resolvePreviousError(jsonl("260603"), md("260603"));
    assert.equal(r.source, "jsonl+md");
    assert.equal(r.gap, false);
    assert.equal(r.prev?.edition, "260603");
    // JSONL não tinha narrativa → puxa do MD
    assert.equal(r.prev?.narrative, "md-narrativa-260603");
  });

  it("#1589: mesma edição com drift → MD frontmatter vence (correct_value)", () => {
    // JSONL tem correct_value stale (publish-time); editor corrigiu o MD
    // depois. MD é autoritativo — evita o "reveal Frankenstein" do 260528→260529.
    const r = resolvePreviousError(
      jsonl("260603", { correct_value: "valor-stale-do-jsonl" }),
      md("260603", { correct_value: "Satya Nadella" }),
    );
    assert.equal(r.prev?.correct_value, "Satya Nadella");
  });

  it("#1589: mesma edição com drift → MD frontmatter vence (detail)", () => {
    const r = resolvePreviousError(
      jsonl("260603", { detail: "detail-stale-do-jsonl" }),
      md("260603", { detail: "detail-corrigido-no-md" }),
    );
    assert.equal(r.prev?.detail, "detail-corrigido-no-md");
    // narrative/gabarito sempre vêm do MD (JSONL nunca os carrega).
    assert.equal(r.prev?.narrative, "md-narrativa-260603");
    assert.equal(r.prev?.gabarito, "md-gabarito-260603");
  });

  it("#1589: MD sem correct_value → preserva o do JSONL (não apaga)", () => {
    // Old behavior: `...(fromMd.correct_value ? {…} : {})` — MD só sobrescreve
    // quando tem valor. Sem valor no MD, mantém o do JSONL.
    const r = resolvePreviousError(
      jsonl("260603", { correct_value: "do-jsonl" }),
      md("260603"), // md() não inclui correct_value
    );
    assert.equal(r.prev?.correct_value, "do-jsonl");
  });

  it("MD mais recente que JSONL → gap-fill do MD (source md, gap true)", () => {
    // JSONL parou em 260603; 260604 declarou erro só na prosa.
    const r = resolvePreviousError(jsonl("260603"), md("260604"));
    assert.equal(r.source, "md");
    assert.equal(r.gap, true);
    assert.equal(r.prev?.edition, "260604");
    assert.equal(r.prev?.narrative, "md-narrativa-260604");
  });

  it("MD mais antigo que JSONL → usa JSONL (source jsonl, sem gap)", () => {
    const r = resolvePreviousError(jsonl("260604"), md("260602"));
    assert.equal(r.source, "jsonl");
    assert.equal(r.gap, false);
    assert.equal(r.prev?.edition, "260604");
  });

  it("só JSONL → source jsonl", () => {
    const r = resolvePreviousError(jsonl("260604"), null);
    assert.equal(r.source, "jsonl");
    assert.equal(r.gap, false);
    assert.equal(r.prev?.edition, "260604");
  });

  it("só MD → source md (sem gap, JSONL nunca existiu)", () => {
    const r = resolvePreviousError(null, md("260604"));
    assert.equal(r.source, "md");
    assert.equal(r.gap, false);
    assert.equal(r.prev?.edition, "260604");
  });

  it("nenhum → null", () => {
    const r = resolvePreviousError(null, null);
    assert.equal(r.prev, null);
    assert.equal(r.source, null);
    assert.equal(r.gap, false);
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

  it("#2411 fix: integração — prev tem description catálogo (sem reveal) + corpo genérico → sem reveal válido (fallback neutro)", () => {
    // Regressão #2411: antes, description catálogo virava reveal público quebrado.
    // Após o fix: body genérico é filtrado, sem `reveal` no record → prev_revealed=false.
    // Reveal na próxima edição: "A edição anterior não trazia erro intencional declarado."
    const dir = mkdtempSync(join(tmpdir(), "render-erro-int-2411-"));
    try {
      const editionsRoot = join(dir, "editions");
      mkdirSync(join(editionsRoot, "260520", "_internal"), { recursive: true });
      mkdirSync(join(editionsRoot, "260521"), { recursive: true });

      // Edição anterior 260520: record com description catálogo (sem reveal) + corpo genérico
      // (padrão real observado em 260617/260618 — descrição com "DESTAQUE N", #3222: agora em JSON)
      writeFileSync(
        join(editionsRoot, "260520", "_internal", "intentional-error.json"),
        JSON.stringify({
          description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA",
          location: "DESTAQUE 2",
          category: "factual",
          correct_value: "Perplexity ou Copilot",
        }, null, 2),
        "utf8",
      );
      writeFileSync(
        join(editionsRoot, "260520", "02-reviewed.md"),
        [
          "Body.",
          "",
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, foo.",
          "",
          "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
          "",
        ].join("\n"),
        "utf8",
      );

      // Edição atual 260521: MD que vai receber a seção ERRO INTENCIONAL
      const mdPath = join(editionsRoot, "260521", "02-reviewed.md");
      writeFileSync(
        mdPath,
        ["OUTRAS NOTÍCIAS", "", "Item.", "", "---", "", "**ASSINE**", "X"].join("\n"),
        "utf8",
      );

      const r = runCli([
        "--edition",
        "260521",
        "--md",
        mdPath,
        "--editions-dir",
        editionsRoot,
        "--errors",
        join(dir, "ghost.jsonl"), // forçar caminho MD
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      // Sem fonte válida de reveal (body genérico + sem narrative no frontmatter)
      assert.equal(out.prev_revealed, false, "sem fonte first-person → sem reveal válido");
      const updated = readFileSync(mdPath, "utf8");
      // A linha "Na última edição, ..." não deve conter label interno "DESTAQUE N"
      const revealLine = updated.split("\n").find((l) => l.startsWith("Na última edição,")) ?? "";
      assert.doesNotMatch(revealLine, /DESTAQUE\s+\d/, "reveal não deve vazar label interno DESTAQUE N");
      // Fallback neutro correto
      assert.match(updated, /não trazia erro intencional declarado/, "deve usar fallback neutro");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2411 fix: integração — prev MD com body first-person → reveal correto, sem label interno", () => {
    // Caso onde o editor escreveu a prosa first-person no corpo (como deveria):
    // o reveal deve usar essa prosa e NÃO vazar labels internos.
    const dir = mkdtempSync(join(tmpdir(), "render-erro-int-2411-fp-"));
    try {
      const editionsRoot = join(dir, "editions");
      mkdirSync(join(editionsRoot, "260520", "_internal"), { recursive: true });
      mkdirSync(join(editionsRoot, "260521"), { recursive: true });

      // Edição anterior 260520: record com description catálogo (sem reveal) + corpo first-person
      writeFileSync(
        join(editionsRoot, "260520", "_internal", "intentional-error.json"),
        JSON.stringify({
          description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA",
          location: "DESTAQUE 2",
          category: "factual",
          correct_value: "Perplexity ou Copilot",
        }, null, 2),
        "utf8",
      );
      writeFileSync(
        join(editionsRoot, "260520", "02-reviewed.md"),
        [
          "Body.",
          "",
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, foo.",
          "",
          "Nessa edição, listei o Spotify como assistente de IA no DESTAQUE 2, mas o correto é Perplexity.",
          "",
        ].join("\n"),
        "utf8",
      );

      const mdPath = join(editionsRoot, "260521", "02-reviewed.md");
      writeFileSync(
        mdPath,
        ["OUTRAS NOTÍCIAS", "", "Item.", "", "---", "", "**ASSINE**", "X"].join("\n"),
        "utf8",
      );

      const r = runCli([
        "--edition",
        "260521",
        "--md",
        mdPath,
        "--editions-dir",
        editionsRoot,
        "--errors",
        join(dir, "ghost.jsonl"),
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.prev_revealed, true, "body first-person → reveal válido");
      const updated = readFileSync(mdPath, "utf8");
      // Reveal usa a prosa first-person do corpo
      assert.match(updated, /Na última edição, listei o Spotify/);
      // O reveal é gramatical e não vaza label "DESTAQUE N" como prefixo
      assert.doesNotMatch(updated, /Na última edição, DESTAQUE/);
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

describe("#2078: prev.no_error branch — frase natural no reveal", () => {
  it("findPreviousIntentionalError inclui entrada no_error=true", () => {
    const errors: IntentionalError[] = [
      { edition: "260605", error_type: "none", is_feature: false, no_error: true },
      { edition: "260604", error_type: "factual", is_feature: true, detail: "X" },
    ];
    const r = findPreviousIntentionalError(errors, "260606");
    // no_error=true deve ser incluído (mais recente)
    assert.equal(r?.edition, "260605");
    assert.equal(r?.no_error, true);
  });

  it("integração CLI: prev no_error=true gera frase natural, não concatenação mecânica", () => {
    const dir = mkdtempSync(join(tmpdir(), "render-erro-none-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const errPath = join(dir, "intentional-errors.jsonl");
      writeFileSync(
        mdPath,
        ["OUTRAS NOTICIAS", "", "Item.", "", "---", "", "**ASSINE**", "X"].join("\n"),
        "utf8",
      );
      writeFileSync(
        errPath,
        JSON.stringify({
          edition: "260605",
          error_type: "none",
          is_feature: false,
          no_error: true,
          source: "frontmatter_02_reviewed",
          detected_by: "sync-intentional-error.ts none scalar (#2016)",
          resolution: "no_error_declared",
        }) + "\n",
        "utf8",
      );

      const projectRoot = join(import.meta.dirname, "..");
      const scriptPath = join(projectRoot, "scripts", "render-erro-intencional.ts");
      const r = spawnSync(process.execPath, ["--import", "tsx", scriptPath,
        "--edition", "260606",
        "--md", mdPath,
        "--errors", errPath,
      ], { cwd: projectRoot, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.prev_revealed, true);
      assert.equal(out.prev_edition, "260605");
      const updated = readFileSync(mdPath, "utf8");
      // Frase natural (#2078)
      assert.match(updated, /Na última edição, não havia erro intencional/);
      assert.match(updated, /quem respondeu que não há erro, acertou/);
      // NÃO pode ter a concatenação mecânica antiga
      assert.doesNotMatch(updated, /o correto é não há erro/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureIntentionalErrorJson (#2284, migrado #3222)", () => {
  // #3222: os testes CRLF/`$`-pattern-corruption (P1 #2300) que existiam aqui
  // testavam a lógica de reescrita regex de um bloco YAML multi-linha existente
  // em `02-reviewed.md` (detecção de line-ending, replacer function evitando
  // interpretação de `$1` como capture group). `ensureIntentionalErrorJson` não
  // reescreve texto nenhum — ou o arquivo não existe (escreve um JSON novo via
  // `JSON.stringify`) ou já existe (no-op). Não há bloco existente pra
  // corromper reescrevendo, então essa classe de bug não pode mais ocorrer;
  // os testes foram removidos.

  it("nada a fazer quando _internal/intentional-error.json já existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "ensure-ie-json-"));
    try {
      const jsonPath = intentionalErrorJsonPath(dir);
      const existing = { description: "x", location: "D1", category: "factual", correct_value: "y" };
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(jsonPath, JSON.stringify(existing, null, 2), "utf8");
      const { inserted } = ensureIntentionalErrorJson(jsonPath);
      assert.equal(inserted, false);
      // Conteúdo original preservado (não sobrescrito)
      const after = JSON.parse(readFileSync(jsonPath, "utf8"));
      assert.deepEqual(after, existing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("insere placeholder com os 5 campos quando arquivo ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "ensure-ie-json-missing-"));
    try {
      const jsonPath = intentionalErrorJsonPath(dir);
      const { inserted } = ensureIntentionalErrorJson(jsonPath);
      assert.equal(inserted, true);
      const record = loadIntentionalErrorJson(jsonPath);
      assert.ok(record !== null, "arquivo deve ter sido criado e ser JSON válido");
      for (const field of ["description", "location", "category", "correct_value", "reveal"] as const) {
        assert.match(record![field] ?? "", /^\{PREENCHER/, `campo ${field} deve ser placeholder`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("idempotente: 2ª chamada não modifica quando placeholder já existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "ensure-ie-json-idempotent-"));
    try {
      const jsonPath = intentionalErrorJsonPath(dir);
      const first = ensureIntentionalErrorJson(jsonPath);
      assert.equal(first.inserted, true, "primeira chamada deve inserir");
      const contentAfterFirst = readFileSync(jsonPath, "utf8");
      const second = ensureIntentionalErrorJson(jsonPath);
      assert.equal(second.inserted, false);
      assert.equal(readFileSync(jsonPath, "utf8"), contentAfterFirst, "conteúdo não deve mudar na 2ª chamada");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("integração CLI: _internal/intentional-error.json criado pelo script quando ausente (#2284/#3222)", () => {
    // Verifica que render-erro-intencional.ts grava o JSON placeholder quando
    // ausente (regressão do bug 260615, agora migrado de frontmatter pra JSON).
    const dir = mkdtempSync(join(tmpdir(), "render-erro-json-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(mdPath, "Corpo sem placeholder.\n\n**ERRO INTENCIONAL**\n\nNessa edição, {PREENCHER}.\n");
      // Sem errors.jsonl — script deve rodar sem crashar e inserir o JSON
      const projectRoot = join(import.meta.dirname, "..");
      const scriptPath = join(projectRoot, "scripts", "render-erro-intencional.ts");
      const r = spawnSync(process.execPath, ["--import", "tsx", scriptPath,
        "--edition", "260616",
        "--md", mdPath,
        "--errors", join(dir, "nonexistent.jsonl"),
      ], { cwd: projectRoot, encoding: "utf8" });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.frontmatter_inserted, true);
      assert.ok(typeof out.json_path === "string" && out.json_path.endsWith("intentional-error.json"));
      const record = loadIntentionalErrorJson(join(dir, "_internal", "intentional-error.json"));
      assert.ok(record !== null);
      assert.match(record!.description ?? "", /\{PREENCHER/);
      assert.match(record!.correct_value ?? "", /\{PREENCHER/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#3485: preencher description/reveal pela 1ª vez em intentional-error.json e re-rodar NÃO corrompe a linha 'Nessa edição, …' do corpo", () => {
    // Regressão do bug relatado pelo auto-reporter (#3485, edição 260716):
    // fluxo real é (1) o script roda uma vez e insere o placeholder
    // "Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}." no corpo do MD (ainda sem
    // o editor ter escrito a narrativa); (2) o editor preenche `description` e
    // `reveal` em _internal/intentional-error.json pela primeira vez (fluxo
    // legado, de antes do #3222, onde o frontmatter alimentava a linha
    // visível); (3) o script roda de novo. Pré-fix, `insertOrUpdateSection`
    // usava `record.reveal` (prosa em 1ª pessoa PASSADA, "Na última edição,
    // escrevi X...", escrita para a edição SEGUINTE revelar) como fallback pra
    // computar a declaração da edição CORRENTE, produzindo
    // "Nessa edição, Na última edição, escrevi X..." — texto corrompido
    // sobrescrevendo o placeholder. Pós-fix, o JSON nunca alimenta a linha
    // "Nessa edição, …" — só a prosa que o editor já escreveu no CORPO conta,
    // então o placeholder permanece intacto até o editor escrever a narrativa
    // diretamente no MD.
    const dir = mkdtempSync(join(tmpdir(), "render-erro-3485-"));
    try {
      const editionDir = join(dir, "editions", "260716-repro");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      const mdPath = join(editionDir, "02-reviewed.md");
      const jsonPath = join(editionDir, "_internal", "intentional-error.json");

      // Estado pós-1º run: placeholder já inserido no corpo, JSON ainda não existe.
      writeFileSync(
        mdPath,
        [
          "OUTRAS NOTÍCIAS",
          "",
          "Item.",
          "",
          "---",
          "",
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, escrevi \"Cursera\" onde o correto é Coursera.",
          "",
          "Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.",
          "",
          "---",
          "",
          "**🎁 SORTEIO**",
          "",
          "Texto sorteio.",
          "",
          "---",
          "",
          "**🙋🏼‍♀️ PARA ENCERRAR**",
          "",
          "Texto encerrar.",
        ].join("\n"),
        "utf8",
      );

      // Editor preenche description + reveal pela 1ª vez (deixa o resto como
      // placeholder, e NÃO toca a linha "Nessa edição, …" do corpo — é
      // exatamente o passo que dispara o bug relatado).
      writeFileSync(
        jsonPath,
        JSON.stringify(
          {
            description: "DESTAQUE 2 cita a startup Acme como fundada em 2020.",
            location: "{PREENCHER — ex: DESTAQUE 2, parágrafo 1}",
            category: "{PREENCHER — factual|ortografico|numeric|attribution|data|version_inconsistency|factual_synthetic}",
            correct_value: "{PREENCHER — valor correto}",
            reveal: "Na última edição, escrevi que a Acme foi fundada em 2020, quando na verdade foi em 2022.",
          },
          null,
          2,
        ),
        "utf8",
      );

      const emptyEditionsRoot = join(dir, "empty-editions-root");
      mkdirSync(emptyEditionsRoot, { recursive: true });

      const projectRoot = join(import.meta.dirname, "..");
      const scriptPath = join(projectRoot, "scripts", "render-erro-intencional.ts");
      const r = spawnSync(process.execPath, ["--import", "tsx", scriptPath,
        "--edition", "260716-repro",
        "--md", mdPath,
        "--editions-dir", emptyEditionsRoot,
        "--errors", join(dir, "nonexistent.jsonl"),
      ], { cwd: projectRoot, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);

      const updated = readFileSync(mdPath, "utf8");
      // Assert central da regressão: nunca "Nessa edição, Na última edição, …"
      // (assinatura exata da corrupção pré-fix).
      assert.doesNotMatch(
        updated,
        /Nessa edição,\s*Na última edição/i,
        "linha 'Nessa edição, …' não pode ser derivada do campo `reveal` (público/tempo verbal diferentes)",
      );
      // Placeholder deve permanecer intacto — editor ainda não escreveu a
      // narrativa desta edição diretamente no corpo.
      assert.match(
        updated,
        /Nessa edição, \{PREENCHER_NARRATIVA_DO_ERRO\}\./,
        "placeholder da narrativa corrente deve ser preservado, não fabricado a partir do JSON",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Regressão #2377: narrativeIsGenericPlaceholder ──────────────────────────────────────────
//
// Root cause fix: o bug foi causado por um `narrative` genérico (copiado do bloco de convite
// ao sorteio) que acabou sendo formatado por composeRevealText como reveal real. O guard
// detecta esse texto genérico e bloqueia no Stage 4 antes da publicação.


describe("narrativeIsGenericPlaceholder (#2377 root cause fix)", () => {
  // ── Input exato do bug — regressão obrigatória (#633) ──────────────────────────────────────
  it("detecta EXATAMENTE o input do bug #2377 como genérico", () => {
    // Este é o narrative que causou o incidente: extraído do bloco de convite ao sorteio
    // em vez de uma declaração real do editor. Causou publish:
    // "Na última edição, há um erro proposital escondido em um dos destaques. Responda este
    //  e-mail com a correção para concorrer ao sorteio, o correto é Microsoft"
    const bugNarrative =
      "há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio";
    assert.equal(
      narrativeIsGenericPlaceholder(bugNarrative),
      true,
      "o narrative exato do bug #2377 deve ser detectado como genérico",
    );
  });

  it("detecta 'há um erro proposital' (variante simples)", () => {
    assert.equal(
      narrativeIsGenericPlaceholder("há um erro proposital em algum dos destaques"),
      true,
    );
  });

  it("detecta 'esta edição tem um erro proposital'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder("esta edição tem um erro proposital escondido"),
      true,
    );
  });

  it("detecta 'responda este e-mail'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder("responda este e-mail com a correção"),
      true,
    );
  });

  it("detecta 'concorrer ao sorteio'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder("para concorrer ao sorteio mensal"),
      true,
    );
  });

  it("detecta 'um erro escondido em'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder("há um erro escondido em um dos destaques"),
      true,
    );
  });

  // ── Declarações reais de primeira pessoa devem passar (false) ──────────────────────────────
  it("passa (false) em declaração real de primeira pessoa — 'escrevi que'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder(
        "escrevi que a empresa parceira da DeepSeek se chamava Macrosoft, quando o correto é Microsoft",
      ),
      false,
    );
  });

  it("passa (false) em declaração real — 'contei que'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder(
        "contei que Karpathy cofundou a OpenAI em 1914, depois liderou a IA da Tesla",
      ),
      false,
    );
  });

  it("passa (false) em declaração real — 'coloquei X onde deveria ser Y'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder(
        "coloquei junho onde deveria ser maio na data de lançamento",
      ),
      false,
    );
  });

  it("passa (false) em texto vazio", () => {
    assert.equal(narrativeIsGenericPlaceholder(""), false);
  });
});

