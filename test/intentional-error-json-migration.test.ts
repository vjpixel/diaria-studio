/**
 * test/intentional-error-json-migration.test.ts (#3222, closes #3205)
 *
 * Regressão para a causa raiz de #3205/#3222: `drive-sync.ts` faz round-trip
 * de `02-reviewed.md` via Google Docs (push → editor abre/edita no Doc →
 * pull). O exportador do Google Docs não preserva indentação/quebras de
 * linha dentro de blocos `---...---`, então o antigo frontmatter YAML de
 * `intentional_error` (description/location/category/correct_value/reveal)
 * colapsava numa única linha corrompida — reproduzido 4x (#3205), sempre no
 * mesmo bloco.
 *
 * A correção (#3222) move os campos estruturados pra
 * `_internal/intentional-error.json`, que NUNCA sincroniza com o Drive
 * (convenção `_internal/*`, #959) — elimina a classe de corrupção na origem.
 *
 * Este arquivo prova 2 invariantes:
 *
 *   1. Uma fixture representando "o que a corrupção do Google Docs parecia"
 *      no formato ANTIGO (YAML colapsado numa linha `## intentional_error:
 *      description: "..." location: "..." ...`) é agora IRRELEVANTE — não
 *      existe mais YAML frontmatter em `02-reviewed.md` pra colapsar. Uma
 *      "corrupção" desse tipo no corpo do MD (simulando o Google Docs
 *      reescrevendo o texto) não afeta em nada os dados estruturados, porque
 *      eles nunca estiveram lá.
 *
 *   2. O dado sobrevive a uma mutação/reformatação que toque SOMENTE
 *      `02-reviewed.md` (simulando um round-trip do Google Docs) — o JSON
 *      permanece intocado e os dados continuam íntegros e legíveis por
 *      `checkIntentionalError` / `render-erro-intencional.ts`.
 *
 *   3. O fluxo cross-edition de `render-erro-intencional.ts` continua
 *      funcionando: a narrativa "Nessa edição, …" da edição CORRENTE
 *      (prosa, ainda em `02-reviewed.md` — não afetada pela migração) e o
 *      reveal "Na última edição, …" da edição ANTERIOR (agora lido de
 *      `_internal/intentional-error.json` da edição anterior) continuam
 *      corretos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { checkIntentionalError } from "../scripts/lib/lint-checks/intentional-error.ts";
import {
  loadIntentionalErrorJson,
  intentionalErrorJsonPath,
  writeIntentionalErrorJson,
} from "../scripts/lib/intentional-errors.ts";

function runRenderErroIntencional(args: string[]) {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "render-erro-intencional.ts");
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

const VALID_RECORD = {
  description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA",
  location: "DESTAQUE 2, parágrafo 2",
  category: "factual",
  correct_value: "Perplexity",
  reveal: "Na última edição, listei o Spotify como assistente de IA, o correto é Perplexity.",
};

describe("#3222/#3205: intentional_error sobrevive à corrupção do round-trip Google Docs", () => {
  it("1. fixture do formato de corrupção ANTIGO (YAML colapsado no corpo do MD) não afeta o JSON — a classe de bug é estruturalmente impossível agora", () => {
    const dir = mkdtempSync(join(tmpdir(), "ie-migration-old-corruption-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const jsonPath = intentionalErrorJsonPath(dir);
      writeIntentionalErrorJson(jsonPath, VALID_RECORD);

      // Simula EXATAMENTE o padrão de corrupção documentado em #3205/#3222:
      // o Google Docs, ao exportar de volta, reconstruía o antigo bloco YAML
      // como uma única linha de heading fora do frontmatter:
      // "## intentional_error: description: "X" location: "Y" category: "Z" ..."
      // Esse texto agora é só PROSA INERTE no corpo — não existe mais parser
      // de frontmatter que tente interpretá-lo, então "corromper" esse texto
      // não pode mais corromper os dados estruturados (eles não vivem ali).
      const corruptedBody = [
        "DESTAQUE 1",
        "",
        "Corpo do destaque.",
        "",
        "## intentional_error: description: \"X\" location: \"Y\" category: \"Z\" correct_value: \"W\" reveal: \"V\"",
        "",
      ].join("\n");
      writeFileSync(mdPath, corruptedBody, "utf8");

      // checkIntentionalError nem olha pro corpo do MD pra este campo — só
      // confirma que o md existe e lê o JSON sibling.
      const result = checkIntentionalError(mdPath);
      assert.equal(result.ok, true, `esperava ok=true (JSON intacto), label: ${result.label}`);
      assert.equal(result.parsed?.description, VALID_RECORD.description);
      assert.equal(result.parsed?.correct_value, VALID_RECORD.correct_value);
      assert.equal(result.parsed?.reveal, VALID_RECORD.reveal);

      // O JSON no disco continua byte-idêntico ao que foi escrito — a
      // "corrupção" do corpo do MD não vazou pro arquivo estruturado.
      const rawJson = readFileSync(jsonPath, "utf8");
      assert.deepEqual(JSON.parse(rawJson), VALID_RECORD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2. dado sobrevive a `02-reviewed.md` sendo mutado/reformatado (simulando round-trip Google Docs) — JSON intocado", () => {
    const dir = mkdtempSync(join(tmpdir(), "ie-migration-md-mutation-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const jsonPath = intentionalErrorJsonPath(dir);

      writeFileSync(mdPath, "DESTAQUE 1\n\nTexto original.\n", "utf8");
      writeIntentionalErrorJson(jsonPath, VALID_RECORD);

      const jsonMtimeBefore = readFileSync(jsonPath, "utf8");

      // Simula o Google Docs "reformatando" o MD no pull: normaliza espaços,
      // reescreve line endings, insere/remove linhas em branco — qualquer
      // mutação que TOQUE SÓ o 02-reviewed.md.
      const reformatted = "DESTAQUE 1\r\n\r\nTexto   reformatado\r\npelo   Google Docs.\r\n\r\n---\r\n\r\nOutra seção qualquer.\r\n";
      writeFileSync(mdPath, reformatted, "utf8");

      // JSON permanece byte-idêntico — drive-sync.ts nunca toca em _internal/*.
      const jsonAfter = readFileSync(jsonPath, "utf8");
      assert.equal(jsonAfter, jsonMtimeBefore, "_internal/intentional-error.json não deve mudar quando só o MD é reformatado");

      // E os dados continuam corretos e legíveis via checkIntentionalError.
      const result = checkIntentionalError(mdPath);
      assert.equal(result.ok, true);
      assert.equal(result.parsed?.description, VALID_RECORD.description);
      assert.equal(result.parsed?.location, VALID_RECORD.location);
      assert.equal(result.parsed?.category, VALID_RECORD.category);
      assert.equal(result.parsed?.correct_value, VALID_RECORD.correct_value);
      assert.equal(result.parsed?.reveal, VALID_RECORD.reveal);

      // loadIntentionalErrorJson direto também confirma
      const record = loadIntentionalErrorJson(jsonPath);
      assert.deepEqual(record, VALID_RECORD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3. render-erro-intencional.ts: narrativa 'Nessa edição' da edição corrente (prosa no MD) + reveal 'Na última edição' da edição anterior (JSON) — cross-edition read", () => {
    const dir = mkdtempSync(join(tmpdir(), "ie-migration-cross-edition-"));
    try {
      const editionsRoot = join(dir, "editions");
      const prevDir = join(editionsRoot, "260709");
      const currDir = join(editionsRoot, "260710");
      mkdirSync(prevDir, { recursive: true });
      mkdirSync(currDir, { recursive: true });

      // Edição ANTERIOR (260709): declarou o erro via prosa no corpo (fonte
      // primária) — o JSON estruturado também existe (escrito por
      // render-erro-intencional no fim do Stage 2 daquela edição), simulando
      // round-trip que "reformatou" o MD sem afetar o JSON.
      writeFileSync(
        join(prevDir, "02-reviewed.md"),
        [
          "OUTRAS NOTÍCIAS",
          "",
          "Item qualquer.",
          "",
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, Y.",
          "",
          "Nessa edição, listei o Spotify entre os assistentes de IA, mas o correto é Perplexity.",
          "",
        ].join("\n"),
        "utf8",
      );
      writeIntentionalErrorJson(intentionalErrorJsonPath(prevDir), {
        description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA",
        location: "DESTAQUE 2",
        category: "factual",
        correct_value: "Perplexity",
      });

      // Edição CORRENTE (260710): o writer já emitiu a prosa "Nessa edição, …"
      // (o editor escreveu isso diretamente no corpo — não é dado estruturado).
      const currMdPath = join(currDir, "02-reviewed.md");
      writeFileSync(
        currMdPath,
        [
          "OUTRAS NOTÍCIAS",
          "",
          "Item da edição atual.",
          "",
          "**ASSINE**",
          "Convite.",
        ].join("\n"),
        "utf8",
      );

      const r = runRenderErroIntencional([
        "--edition",
        "260710",
        "--md",
        currMdPath,
        "--editions-dir",
        editionsRoot,
        "--errors",
        join(dir, "ghost-jsonl-forces-md-path.jsonl"), // força o fallback MD (sem JSONL)
      ]);
      assert.equal(r.status, 0, `exit 0 esperado, stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.prev_edition, "260709");
      assert.equal(out.prev_revealed, true);

      const updated = readFileSync(currMdPath, "utf8");
      // Reveal da edição anterior corretamente propagado (fonte: prosa
      // "Nessa edição, …" do 02-reviewed.md ANTERIOR — o JSON da edição
      // anterior não tinha `reveal` preenchido, então cai no fallback de
      // prosa, que segue funcionando inalterado pela migração #3222).
      assert.match(updated, /Na última edição, listei o Spotify/);
      assert.doesNotMatch(updated, /DESTAQUE\s+\d/, "reveal não deve vazar label interno DESTAQUE N");

      // #3222: garante que o JSON da edição CORRENTE foi criado (placeholder)
      // — nunca escreve frontmatter de volta no MD.
      const currJsonPath = intentionalErrorJsonPath(currDir);
      assert.ok(existsSync(currJsonPath), "_internal/intentional-error.json da edição corrente deve ter sido criado");
      const currRecord = loadIntentionalErrorJson(currJsonPath);
      assert.match(currRecord?.description ?? "", /PREENCHER/);
      // E o MD da edição corrente NUNCA ganha frontmatter YAML de volta —
      // checa especificamente o INÍCIO do arquivo (posição 0), não qualquer
      // `---` (que também é usado como separador visual entre seções do
      // corpo, uso legítimo e não relacionado a frontmatter).
      assert.ok(
        !updated.startsWith("---"),
        "02-reviewed.md não deve ganhar frontmatter YAML de volta no topo (#3222)",
      );
      assert.doesNotMatch(updated, /^intentional_error\s*:/m, "02-reviewed.md não deve conter a chave intentional_error como texto (#3222)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("4. reveal da edição anterior lido do JSON (_internal/intentional-error.json) quando prosa ausente no MD anterior", () => {
    // Cobre o caso onde a prosa "Nessa edição, …" nunca foi escrita no corpo
    // (ex: publicação manual), mas o campo `reveal` foi preenchido
    // diretamente no JSON estruturado — render-erro-intencional deve usar
    // esse valor.
    const dir = mkdtempSync(join(tmpdir(), "ie-migration-json-reveal-"));
    try {
      const editionsRoot = join(dir, "editions");
      const prevDir = join(editionsRoot, "260709");
      const currDir = join(editionsRoot, "260710");
      mkdirSync(prevDir, { recursive: true });
      mkdirSync(currDir, { recursive: true });

      writeFileSync(
        join(prevDir, "02-reviewed.md"),
        ["OUTRAS NOTÍCIAS", "", "Item.", "", "**ASSINE**", "Convite."].join("\n"),
        "utf8",
      );
      writeIntentionalErrorJson(intentionalErrorJsonPath(prevDir), VALID_RECORD);

      const currMdPath = join(currDir, "02-reviewed.md");
      writeFileSync(
        currMdPath,
        ["OUTRAS NOTÍCIAS", "", "Item atual.", "", "**ASSINE**", "Convite."].join("\n"),
        "utf8",
      );

      const r = runRenderErroIntencional([
        "--edition",
        "260710",
        "--md",
        currMdPath,
        "--editions-dir",
        editionsRoot,
        "--errors",
        join(dir, "ghost.jsonl"),
      ]);
      assert.equal(r.status, 0, `exit 0 esperado, stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.prev_revealed, true);
      const updated = readFileSync(currMdPath, "utf8");
      assert.match(updated, new RegExp(VALID_RECORD.reveal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
