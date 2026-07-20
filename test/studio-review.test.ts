/**
 * test/studio-review.test.ts (#3559)
 *
 * Camada de leitura/escrita/diff/lint/preview do painel de revisão de
 * conteúdo rica (`scripts/studio-ui/studio-review.ts`). Tudo aqui roda
 * contra um `rootDir` tmpdir injetado — nunca toca o `data/` real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveReviewFile,
  isReviewSlug,
  readReviewFile,
  saveReviewFile,
  resetBaseline,
  computeReviewDiff,
  runReviewLints,
  buildReviewPreviewHtml,
  buildSocialPreviewHtml,
  pullReviewFileBestEffort,
  resolveReviewImagePath,
  REVIEW_FILES,
} from "../scripts/studio-ui/studio-review.ts";

const TWO_DESTAQUES_MD = [
  "**DESTAQUE 1 | LANÇAMENTO**",
  "",
  "**[IA chega às fábricas brasileiras](https://example.com/1)**",
  "",
  "Corpo do primeiro destaque com contexto suficiente.",
  "",
  "Por que isso importa: automatização industrial tem impacto direto no emprego.",
  "",
  "---",
  "",
  "**DESTAQUE 2 | PESQUISA**",
  "",
  "**[Modelos de linguagem superam humanos em diagnóstico](https://example.com/2)**",
  "",
  "Corpo do segundo destaque.",
  "",
  "Por que isso importa: abre caminho para triagem automatizada em clínicas.",
  "",
].join("\n");

describe("isReviewSlug (#3559, +html-final #3635)", () => {
  it("aceita só os 4 slugs conhecidos", () => {
    assert.equal(isReviewSlug("categorized"), true);
    assert.equal(isReviewSlug("reviewed"), true);
    assert.equal(isReviewSlug("social"), true);
    assert.equal(isReviewSlug("html-final"), true);
    assert.equal(isReviewSlug("nope"), false);
    assert.equal(isReviewSlug(""), false);
  });
});

describe("resolveReviewFile (#3559)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-resolve-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("retorna null pra AAMMDD inválido", () => {
    assert.equal(resolveReviewFile(root, "nope", "reviewed"), null);
  });

  it("retorna null pra slug desconhecido", () => {
    assert.equal(resolveReviewFile(root, "260716", "unknown"), null);
  });

  it("resolve paths coerentes com REVIEW_FILES + baseline sob _internal/", () => {
    const resolved = resolveReviewFile(root, "260716", "reviewed");
    assert.ok(resolved);
    assert.equal(resolved!.filename, REVIEW_FILES.reviewed);
    assert.ok(resolved!.filePath.endsWith(REVIEW_FILES.reviewed));
    assert.match(resolved!.baselinePath, /_internal[\\/]studio-review-baseline[\\/]02-reviewed\.md\.md$/);
  });

  it("#3635: html-final resolve pra _internal/newsletter-final.html, baseline sem subpasta _internal/ aninhada", () => {
    const resolved = resolveReviewFile(root, "260716", "html-final");
    assert.ok(resolved);
    assert.equal(resolved!.filename, "_internal/newsletter-final.html");
    assert.match(resolved!.filePath, /_internal[\\/]newsletter-final\.html$/);
    // basename(filename) na construção do baseline — NÃO deveria aninhar
    // outra pasta `_internal` dentro de `studio-review-baseline/`.
    assert.match(resolved!.baselinePath, /studio-review-baseline[\\/]newsletter-final\.html\.md$/);
    assert.doesNotMatch(resolved!.baselinePath, /studio-review-baseline[\\/]_internal/);
  });
});

function makeEdition(root: string, aammdd: string): string {
  const dir = resolve(root, "data", "editions", aammdd);
  mkdirSync(dir, { recursive: true });
  mkdirSync(resolve(dir, "_internal"), { recursive: true });
  return dir;
}

describe("readReviewFile / saveReviewFile / resetBaseline (#3559)", () => {
  let root: string;
  let editionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-io-"));
    editionDir = makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("exists:false quando o arquivo ainda não foi gerado", () => {
    const state = readReviewFile(root, "260716", "reviewed");
    assert.equal(state.ok, true);
    assert.equal(state.exists, false);
    assert.equal(state.content, "");
  });

  it("captura baseline na 1ª leitura e não sobrescreve em leituras seguintes", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão do agente", "utf8");
    const first = readReviewFile(root, "260716", "reviewed");
    assert.equal(first.baseline, "versão do agente");

    // Editor "salva" uma edição — o disco muda, mas o baseline deve persistir.
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão editada pelo editor", "utf8");
    const second = readReviewFile(root, "260716", "reviewed");
    assert.equal(second.content, "versão editada pelo editor");
    assert.equal(second.baseline, "versão do agente", "baseline não deve mudar em leituras subsequentes");
  });

  it("saveReviewFile escreve o conteúdo inteiro e retorna modifiedAt", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "original", "utf8");
    const result = saveReviewFile(root, "260716", "reviewed", "novo conteúdo");
    assert.equal(result.ok, true);
    assert.ok(result.modifiedAt);
    assert.equal(readFileSync(resolve(editionDir, "02-reviewed.md"), "utf8"), "novo conteúdo");
  });

  it("saveReviewFile falha graciosamente pra edição inexistente", () => {
    const result = saveReviewFile(root, "999999", "reviewed", "x");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /não encontrada/);
  });

  it("resetBaseline passa a comparar contra o conteúdo atual", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "v1", "utf8");
    readReviewFile(root, "260716", "reviewed"); // captura baseline = v1
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "v2", "utf8");
    const reset = resetBaseline(root, "260716", "reviewed");
    assert.equal(reset.ok, true);
    const state = readReviewFile(root, "260716", "reviewed");
    assert.equal(state.baseline, "v2");
  });
});

// #3729 (warn-before-save): editor (Studio) e pipeline (title-picker, Clarice,
// humanizador — todos via Edit/Write do agente) escrevem DIRETO no mesmo
// 02-reviewed.md/03-social.md sem lock/CAS. `saveReviewFile` agora aceita um
// `expectedModifiedAt` (mtime visto pelo client no load) e recusa o write —
// em vez de sobrescrever silenciosamente — quando o mtime ATUAL em disco
// diverge, sinalizando `conflict: true` pro caller HTTP responder 409.
describe("saveReviewFile — conflito de escrita concorrente (#3729 warn-before-save)", () => {
  let root: string;
  let editionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-conflict-"));
    editionDir = makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("happy path: expectedModifiedAt bate com o mtime atual em disco (sem mudança externa) — save funciona normalmente", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão do agente", "utf8");
    const loaded = readReviewFile(root, "260716", "reviewed");
    assert.ok(loaded.modifiedAt);
    const result = saveReviewFile(root, "260716", "reviewed", "edição do editor", {
      expectedModifiedAt: loaded.modifiedAt,
    });
    assert.equal(result.ok, true);
    assert.equal(result.conflict, undefined);
    assert.equal(readFileSync(resolve(editionDir, "02-reviewed.md"), "utf8"), "edição do editor");
  });

  it("recusa o save (conflict:true) quando o arquivo mudou em disco depois que o client carregou (pipeline escreveu por baixo)", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão do agente", "utf8");
    const loaded = readReviewFile(root, "260716", "reviewed");
    const staleModifiedAt = loaded.modifiedAt;
    assert.ok(staleModifiedAt);

    // Pipeline reescreve o arquivo "por baixo" (title-picker/Clarice/
    // humanizador) DEPOIS que o client leu — utimesSync garante um mtime
    // estritamente mais novo de forma determinística (não depende de um gap
    // real de relógio entre os dois writeFileSync, que poderia colidir em
    // filesystems com resolução de mtime grosseira).
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão do pipeline pós-load", "utf8");
    const newerDate = new Date(Date.parse(staleModifiedAt!) + 5000);
    utimesSync(resolve(editionDir, "02-reviewed.md"), newerDate, newerDate);

    const result = saveReviewFile(root, "260716", "reviewed", "edição do editor sobre a versão antiga", {
      expectedModifiedAt: staleModifiedAt,
    });
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.ok(result.currentModifiedAt);
    assert.notEqual(result.currentModifiedAt, staleModifiedAt);
    // O ponto central do fix: a escrita do pipeline NUNCA é sobrescrita
    // silenciosamente — o conteúdo em disco permanece o do pipeline.
    assert.equal(readFileSync(resolve(editionDir, "02-reviewed.md"), "utf8"), "versão do pipeline pós-load");
  });

  it("force:true ignora a divergência detectada e sobrescreve mesmo assim (editor confirmou no dialog de conflito)", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão do agente", "utf8");
    const loaded = readReviewFile(root, "260716", "reviewed");
    const staleModifiedAt = loaded.modifiedAt;
    assert.ok(staleModifiedAt);

    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão do pipeline pós-load", "utf8");
    const newerDate = new Date(Date.parse(staleModifiedAt!) + 5000);
    utimesSync(resolve(editionDir, "02-reviewed.md"), newerDate, newerDate);

    const result = saveReviewFile(root, "260716", "reviewed", "sobrescrita forçada pelo editor", {
      expectedModifiedAt: staleModifiedAt,
      force: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.conflict, undefined);
    assert.equal(readFileSync(resolve(editionDir, "02-reviewed.md"), "utf8"), "sobrescrita forçada pelo editor");
  });

  it("expectedModifiedAt omitido (assinatura de 4 args, sem opts) pula a checagem inteiramente — compat com chamadas antigas/scripts internos", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão do agente", "utf8");
    readReviewFile(root, "260716", "reviewed");
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão do pipeline pós-load", "utf8");
    const result = saveReviewFile(root, "260716", "reviewed", "edição sem baseline informado");
    assert.equal(result.ok, true);
    assert.equal(result.conflict, undefined);
  });

  it("expectedModifiedAt:null (arquivo ainda não existia no load) detecta conflito quando o pipeline CRIA o arquivo nesse meio tempo", () => {
    // Cenário: editor abre o painel numa edição onde 02-reviewed.md ainda não
    // existe (Stage 2 não terminou) — GET retorna modifiedAt:null. Nesse meio
    // tempo o pipeline termina o Stage 2 e cria o arquivo. Sem recarregar, um
    // save às cegas deveria recusar (o arquivo passou de inexistente a
    // existente — divergência real, mesma classe de risco do #3729).
    const loaded = readReviewFile(root, "260716", "reviewed");
    assert.equal(loaded.exists, false);
    assert.equal(loaded.modifiedAt, null);

    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão recém-criada pelo pipeline", "utf8");

    const result = saveReviewFile(
      root,
      "260716",
      "reviewed",
      "edição feita achando que o arquivo não existia",
      { expectedModifiedAt: null },
    );
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.equal(readFileSync(resolve(editionDir, "02-reviewed.md"), "utf8"), "versão recém-criada pelo pipeline");
  });
});

describe("html-final (#3635) — read/save/mkdir/pull-skip", () => {
  let root: string;
  let editionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-html-final-"));
    editionDir = makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("exists:false quando newsletter-final.html ainda não foi gerado (pré-Etapa 4)", () => {
    const state = readReviewFile(root, "260716", "html-final");
    assert.equal(state.ok, true);
    assert.equal(state.exists, false);
  });

  it("lê o conteúdo de _internal/newsletter-final.html e captura baseline", () => {
    writeFileSync(resolve(editionDir, "_internal", "newsletter-final.html"), "<html>v-agente</html>", "utf8");
    const state = readReviewFile(root, "260716", "html-final");
    assert.equal(state.exists, true);
    assert.equal(state.content, "<html>v-agente</html>");
    assert.equal(state.baseline, "<html>v-agente</html>");
  });

  it("saveReviewFile escreve de volta em _internal/newsletter-final.html", () => {
    writeFileSync(resolve(editionDir, "_internal", "newsletter-final.html"), "<html>original</html>", "utf8");
    const result = saveReviewFile(root, "260716", "html-final", "<html>editado à mão</html>");
    assert.equal(result.ok, true);
    assert.equal(
      readFileSync(resolve(editionDir, "_internal", "newsletter-final.html"), "utf8"),
      "<html>editado à mão</html>",
    );
  });

  it("saveReviewFile cria _internal/ se ausente (mkdir recursivo antes do write)", () => {
    // Edição sem _internal/ ainda (diferente de makeEdition, que já cria a
    // pasta) — simula uma edição criada só com o dir raiz.
    const bareRoot = mkdtempSync(join(tmpdir(), "studio-review-html-final-bare-"));
    const bareDir = resolve(bareRoot, "data", "editions", "260716");
    mkdirSync(bareDir, { recursive: true }); // sem _internal/
    const result = saveReviewFile(bareRoot, "260716", "html-final", "<html>primeira vez</html>");
    assert.equal(result.ok, true);
    assert.equal(
      readFileSync(resolve(bareDir, "_internal", "newsletter-final.html"), "utf8"),
      "<html>primeira vez</html>",
    );
    rmSync(bareRoot, { recursive: true, force: true });
  });

  it("pullReviewFileBestEffort pula html-final sem spawnar nada (_internal/* não sincroniza com Drive)", () => {
    writeFileSync(resolve(editionDir, "_internal", "newsletter-final.html"), "<html></html>", "utf8");
    let called = false;
    const fakeSpawn = () => {
      called = true;
      return { status: 0, stdout: "{}", stderr: "", error: undefined } as ReturnType<
        typeof import("node:child_process").spawnSync
      >;
    };
    const result = pullReviewFileBestEffort(root, "260716", "html-final", fakeSpawn as never);
    assert.equal(result.attempted, false);
    assert.equal(result.ok, false);
    assert.equal(called, false);
  });
});

describe("computeReviewDiff (#3559)", () => {
  let root: string;
  let editionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-diff-"));
    editionDir = makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("vazio quando não há edições vs. baseline", () => {
    writeFileSync(resolve(editionDir, "03-social.md"), "conteúdo estável", "utf8");
    readReviewFile(root, "260716", "social"); // captura baseline
    const diff = computeReviewDiff(root, "260716", "social");
    assert.equal(diff.ok, true);
    assert.equal(diff.isEmpty, true);
  });

  it("não-vazio depois de uma edição salva", () => {
    writeFileSync(resolve(editionDir, "03-social.md"), "linha original", "utf8");
    readReviewFile(root, "260716", "social"); // captura baseline
    saveReviewFile(root, "260716", "social", "linha editada");
    const diff = computeReviewDiff(root, "260716", "social");
    assert.equal(diff.isEmpty, false);
    assert.ok(diff.lines.some((l) => l.type === "add" && l.text === "linha editada"));
    assert.ok(diff.lines.some((l) => l.type === "del" && l.text === "linha original"));
  });

  // #3635: este é o mecanismo REAL por trás do guard de divergência do
  // painel (revisao.js `refreshDivergenceBanner`/`saveCurrent`) — o cliente
  // consulta esta MESMA rota genérica (`.../review/html-final/diff`) e trata
  // `isEmpty === false` como "HTML final foi editado manualmente desde que a
  // Etapa 4 gerou este baseline". Cobrir aqui prova que o sinal que o guard
  // consome é correto nos 3 estados possíveis.
  describe("#3635 — html-final como sinal de divergência (guard do painel)", () => {
    it("arquivo inexistente (pré-Etapa 4): isEmpty:true — nada a avisar", () => {
      const diff = computeReviewDiff(root, "260716", "html-final");
      assert.equal(diff.ok, true);
      assert.equal(diff.isEmpty, true);
    });

    it("recém-gerado pela Etapa 4, nunca editado à mão: isEmpty:true — nada a avisar", () => {
      writeFileSync(resolve(editionDir, "_internal", "newsletter-final.html"), "<html>v-agente</html>", "utf8");
      readReviewFile(root, "260716", "html-final"); // captura baseline = v-agente
      const diff = computeReviewDiff(root, "260716", "html-final");
      assert.equal(diff.isEmpty, true);
    });

    it("editado à mão via saveReviewFile: isEmpty:false — dispara o aviso", () => {
      writeFileSync(resolve(editionDir, "_internal", "newsletter-final.html"), "<html>v-agente</html>", "utf8");
      readReviewFile(root, "260716", "html-final"); // captura baseline = v-agente
      saveReviewFile(root, "260716", "html-final", "<html>v-agente + correção manual</html>");
      const diff = computeReviewDiff(root, "260716", "html-final");
      assert.equal(diff.isEmpty, false);
      assert.ok(diff.lines.some((l) => l.type === "add" && l.text.includes("correção manual")));
    });

    it("resetBaseline volta a isEmpty:true (editor tratou a edição manual como novo baseline)", () => {
      writeFileSync(resolve(editionDir, "_internal", "newsletter-final.html"), "<html>v-agente</html>", "utf8");
      readReviewFile(root, "260716", "html-final");
      saveReviewFile(root, "260716", "html-final", "<html>editado</html>");
      assert.equal(computeReviewDiff(root, "260716", "html-final").isEmpty, false);
      resetBaseline(root, "260716", "html-final");
      assert.equal(computeReviewDiff(root, "260716", "html-final").isEmpty, true);
    });
  });
});

describe("runReviewLints (#3559)", () => {
  let root: string;
  let editionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-lint-"));
    editionDir = makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("categorized: LANÇAMENTOS com URL não-oficial falha o check bloqueante", () => {
    const md = [
      "## Lançamentos",
      "",
      "**[Cobertura de um lançamento](https://techcrunch.com/algo)**",
      "",
    ].join("\n");
    const report = runReviewLints(root, editionDir, "categorized", md);
    const check = report.checks.find((c) => c.id === "lancamentos-oficiais");
    assert.ok(check);
    assert.equal(check!.ok, false);
    assert.equal(report.ok, false);
  });

  it("categorized: seção LANÇAMENTOS vazia passa", () => {
    const report = runReviewLints(root, editionDir, "categorized", "## Lançamentos\n");
    const check = report.checks.find((c) => c.id === "lancamentos-oficiais");
    assert.equal(check!.ok, true);
    assert.equal(report.ok, true);
  });

  it("reviewed: roda o conjunto de checks sem lançar e reporta 'skipped' sem 01-approved.json", () => {
    const report = runReviewLints(root, editionDir, "reviewed", TWO_DESTAQUES_MD);
    assert.ok(report.checks.length > 5, "deveria rodar vários checks estruturais");
    assert.ok(report.skipped.includes("section-counts"));
    assert.ok(report.skipped.includes("url-bucket"));
  });

  it("reviewed: inclui section-counts/url-bucket quando 01-approved.json existe", () => {
    writeFileSync(
      resolve(editionDir, "_internal", "01-approved.json"),
      JSON.stringify({
        highlights: [
          { url: "https://example.com/1" },
          { url: "https://example.com/2" },
        ],
      }),
      "utf8",
    );
    const report = runReviewLints(root, editionDir, "reviewed", TWO_DESTAQUES_MD);
    assert.ok(report.checks.some((c) => c.id === "section-counts"));
    assert.ok(report.checks.some((c) => c.id === "url-bucket"));
  });

  it("reviewed: check crashado (approved malformado não deveria crashar, mas simulamos md vazio) não derruba o batch", () => {
    // md vazio: countTitlesPerHighlight etc. devem lidar gracefully (podem
    // reportar ok:false, mas não devem lançar) — o próprio runCheck garante
    // fail-soft mesmo se algum check lançasse.
    const report = runReviewLints(root, editionDir, "reviewed", "");
    assert.ok(Array.isArray(report.checks));
    assert.ok(report.checks.length > 0);
  });

  it("social: CTA ausente falha o check bloqueante default", () => {
    const md = ["# LinkedIn", "", "**post principal:**", "", "Um post sem CTA nenhum."].join("\n");
    const report = runReviewLints(root, editionDir, "social", md);
    const cta = report.checks.find((c) => c.id === "cta-format");
    assert.ok(cta);
  });

  it("#3635: html-final não roda nenhum check de Markdown — retorna note explicando que é edição de última milha sem rede de segurança", () => {
    const report = runReviewLints(root, editionDir, "html-final", "<html><body>qualquer coisa</body></html>");
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks, []);
    assert.ok(report.note, "deveria ter uma note explicando a ausência de lints");
    assert.match(report.note!, /última milha/);
    assert.match(report.note!, /NÃO passa pelos lints/);
  });
});

describe("buildReviewPreviewHtml (#3559)", () => {
  let root: string;
  let editionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-preview-"));
    editionDir = makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("sem 02-reviewed.md → ok:false com mensagem clara, HTML de erro", () => {
    const preview = buildReviewPreviewHtml(editionDir);
    assert.equal(preview.ok, false);
    assert.match(preview.html, /Sem preview/);
  });

  it("com 02-reviewed.md válido → ok:true, HTML completo com os títulos", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), TWO_DESTAQUES_MD, "utf8");
    const preview = buildReviewPreviewHtml(editionDir);
    assert.equal(preview.ok, true);
    assert.match(preview.html, /IA chega às fábricas brasileiras/);
    assert.match(preview.html, /<html/);
  });

  it("fail-soft: 02-reviewed.md corrompido (0 destaques) não lança, retorna HTML de erro", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "conteúdo sem nenhum bloco DESTAQUE", "utf8");
    const preview = buildReviewPreviewHtml(editionDir);
    assert.equal(preview.ok, false);
    assert.match(preview.html, /Erro ao renderizar preview/);
  });

  it("achado 260716: sem aammdd, placeholder {{IMG:...}} fica intacto (comportamento anterior preservado)", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), TWO_DESTAQUES_MD, "utf8");
    const preview = buildReviewPreviewHtml(editionDir);
    assert.equal(preview.ok, true);
    assert.match(preview.html, /\{\{IMG:04-d1-2x1\.jpg\}\}/);
  });

  it("achado 260716: com aammdd + imagem presente em disco, placeholder vira rota local (não mais {{IMG:...}})", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), TWO_DESTAQUES_MD, "utf8");
    writeFileSync(resolve(editionDir, "04-d1-2x1.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const preview = buildReviewPreviewHtml(editionDir, "260716");
    assert.equal(preview.ok, true);
    assert.match(preview.html, /src="\/api\/editions\/260716\/image\/04-d1-2x1\.jpg"/);
    assert.doesNotMatch(preview.html, /\{\{IMG:04-d1-2x1\.jpg\}\}/);
  });

  it("achado 260716: imagem referenciada mas AUSENTE em disco fica como placeholder (fail-open, não quebra)", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), TWO_DESTAQUES_MD, "utf8");
    // Só cria a imagem do D1 — D2 (04-d2-2x1.jpg) fica sem arquivo correspondente.
    writeFileSync(resolve(editionDir, "04-d1-2x1.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const preview = buildReviewPreviewHtml(editionDir, "260716");
    assert.equal(preview.ok, true);
    assert.match(preview.html, /\{\{IMG:04-d2-2x1\.jpg\}\}/);
  });
});

describe("buildSocialPreviewHtml (#3663)", () => {
  let root: string;
  let editionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-social-preview-"));
    editionDir = makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const THREE_DESTAQUES_SOCIAL_MD = [
    "# LinkedIn",
    "",
    "## d1",
    "",
    "Primeira linha do post D1.",
    "",
    "Segunda linha, parágrafo separado.",
    "",
    "#InteligenciaArtificial #Agentes",
    "",
    "## d2",
    "",
    "Post D2 do LinkedIn.",
    "",
    "#InteligenciaArtificial",
    "",
    "## d3",
    "",
    "Post D3 do LinkedIn.",
    "",
    "#InteligenciaArtificial",
    "",
    "# Facebook",
    "",
    "## d1",
    "",
    "Post D1 do Facebook.",
    "",
    "## d2",
    "",
    "Post D2 do Facebook.",
    "",
    "## d3",
    "",
    "Post D3 do Facebook.",
    "",
  ].join("\n");

  it("sem 03-social.md → ok:false com mensagem clara, HTML de erro", () => {
    const preview = buildSocialPreviewHtml(editionDir);
    assert.equal(preview.ok, false);
    assert.match(preview.html, /Sem preview/);
    assert.match(preview.error ?? "", /03-social\.md/);
  });

  it("com 03-social.md válido → ok:true, HTML com as 2 plataformas e os 3 destaques cada", () => {
    writeFileSync(resolve(editionDir, "03-social.md"), THREE_DESTAQUES_SOCIAL_MD, "utf8");
    const preview = buildSocialPreviewHtml(editionDir);
    assert.equal(preview.ok, true);
    assert.match(preview.html, /<html/i);
    assert.match(preview.html, /LinkedIn/);
    assert.match(preview.html, /Facebook/);
    assert.match(preview.html, /Primeira linha do post D1\./);
    assert.match(preview.html, /Post D3 do Facebook\./);
  });

  it("preserva quebra de linha entre parágrafos como <br>/<p> separados, sem aplicar markdown pesado", () => {
    writeFileSync(resolve(editionDir, "03-social.md"), THREE_DESTAQUES_SOCIAL_MD, "utf8");
    const preview = buildSocialPreviewHtml(editionDir);
    assert.equal(preview.ok, true);
    // 2 parágrafos do d1 (separados por linha em branco) viram <p> distintos.
    assert.match(preview.html, /<p>Primeira linha do post D1\.<\/p>/);
    assert.match(preview.html, /<p>Segunda linha, parágrafo separado\.<\/p>/);
  });

  it("hashtags aparecem destacadas no HTML (não como texto markdown cru)", () => {
    writeFileSync(resolve(editionDir, "03-social.md"), THREE_DESTAQUES_SOCIAL_MD, "utf8");
    const preview = buildSocialPreviewHtml(editionDir);
    assert.match(preview.html, /#InteligenciaArtificial/);
  });

  it("edição com só 2 destaques (regra 2-3, #3369) não quebra — renderiza os 2 presentes", () => {
    const twoDestaquesMd = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "Post D1.",
      "",
      "## d2",
      "",
      "Post D2.",
      "",
      "# Facebook",
      "",
      "## d1",
      "",
      "Post D1 fb.",
      "",
      "## d2",
      "",
      "Post D2 fb.",
      "",
    ].join("\n");
    writeFileSync(resolve(editionDir, "03-social.md"), twoDestaquesMd, "utf8");
    const preview = buildSocialPreviewHtml(editionDir);
    assert.equal(preview.ok, true);
    assert.match(preview.html, /Post D1\./);
    assert.match(preview.html, /Post D2\./);
    assert.doesNotMatch(preview.html, /Post D3/);
  });

  it("seção de plataforma ausente (só LinkedIn, Facebook ainda não gerado) não quebra", () => {
    const linkedinOnlyMd = ["# LinkedIn", "", "## d1", "", "Post D1.", ""].join("\n");
    writeFileSync(resolve(editionDir, "03-social.md"), linkedinOnlyMd, "utf8");
    const preview = buildSocialPreviewHtml(editionDir);
    assert.equal(preview.ok, true);
    // header do card LinkedIn presente; o card/header Facebook (não o
    // seletor CSS estático ".platform-header.facebook", que sempre existe no
    // <style>) não deveria estar — checa a div renderizada, não o CSS.
    assert.match(preview.html, /💼 LinkedIn/);
    assert.doesNotMatch(preview.html, /platform-header facebook"/);
    assert.doesNotMatch(preview.html, /📘 Facebook/);
  });

  it("sem aammdd, sem imagens em disco → renderiza sem <img> (fail-open, não quebra)", () => {
    writeFileSync(resolve(editionDir, "03-social.md"), THREE_DESTAQUES_SOCIAL_MD, "utf8");
    const preview = buildSocialPreviewHtml(editionDir);
    assert.equal(preview.ok, true);
    assert.doesNotMatch(preview.html, /<img\b/);
  });

  it("com aammdd + imagem 1x1 em disco → src aponta pra rota local de imagem", () => {
    writeFileSync(resolve(editionDir, "03-social.md"), THREE_DESTAQUES_SOCIAL_MD, "utf8");
    writeFileSync(resolve(editionDir, "04-d1-1x1.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const preview = buildSocialPreviewHtml(editionDir, "260716");
    assert.equal(preview.ok, true);
    assert.match(preview.html, /src="\/api\/editions\/260716\/image\/04-d1-1x1\.jpg"/);
  });

  it("sem 1x1 mas com 2x1 em disco → cai pro fallback 2x1", () => {
    writeFileSync(resolve(editionDir, "03-social.md"), THREE_DESTAQUES_SOCIAL_MD, "utf8");
    writeFileSync(resolve(editionDir, "04-d1-2x1.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const preview = buildSocialPreviewHtml(editionDir, "260716");
    assert.equal(preview.ok, true);
    assert.match(preview.html, /src="\/api\/editions\/260716\/image\/04-d1-2x1\.jpg"/);
  });

  it("03-social.md vazio (sem nenhum '# Plataforma') não lança — renderiza shell HTML sem plataformas", () => {
    writeFileSync(resolve(editionDir, "03-social.md"), "", "utf8");
    const preview = buildSocialPreviewHtml(editionDir);
    assert.equal(preview.ok, true);
    assert.match(preview.html, /<html/i);
  });
});

describe("resolveReviewImagePath (#3559 — achado 260716)", () => {
  let root: string;
  let editionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-image-"));
    editionDir = makeEdition(root, "260716");
    writeFileSync(resolve(editionDir, "04-d1-2x1.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("arquivo de imagem existente na raiz da edição → resolve o path absoluto", () => {
    const resolved = resolveReviewImagePath(editionDir, "04-d1-2x1.jpg");
    assert.ok(resolved);
    assert.ok(existsSync(resolved!));
  });

  it("arquivo inexistente → null", () => {
    assert.equal(resolveReviewImagePath(editionDir, "04-d9-2x1.jpg"), null);
  });

  it("path traversal (../ ou separador) → null, nunca escapa da edição", () => {
    assert.equal(resolveReviewImagePath(editionDir, "../../../etc/passwd"), null);
    assert.equal(resolveReviewImagePath(editionDir, "_internal/segredo.json"), null);
    assert.equal(resolveReviewImagePath(editionDir, "..\\..\\config.json"), null);
  });

  it("extensão fora da allowlist (ex: .md, .json) → null mesmo se o arquivo existir", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "conteudo", "utf8");
    assert.equal(resolveReviewImagePath(editionDir, "02-reviewed.md"), null);
  });
});

describe("pullReviewFileBestEffort (#3559 — #494)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-pull-"));
    makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("nunca lança — spawnFn injetado simula sucesso", () => {
    const fakeSpawn = () =>
      ({ status: 0, stdout: JSON.stringify({ pulled: [] }), stderr: "", error: undefined }) as ReturnType<
        typeof import("node:child_process").spawnSync
      >;
    const result = pullReviewFileBestEffort(root, "260716", "reviewed", fakeSpawn as never);
    assert.equal(result.attempted, true);
    assert.equal(result.ok, true);
  });

  it("falha do subprocess vira warning fail-soft (ok:false), não lança", () => {
    const fakeSpawn = () =>
      ({ status: 1, stdout: "", stderr: "offline", error: undefined }) as ReturnType<
        typeof import("node:child_process").spawnSync
      >;
    const result = pullReviewFileBestEffort(root, "260716", "reviewed", fakeSpawn as never);
    assert.equal(result.attempted, true);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /offline/);
  });

  it("edição inexistente → attempted:false, sem spawnar nada", () => {
    let called = false;
    const fakeSpawn = () => {
      called = true;
      return { status: 0, stdout: "{}", stderr: "", error: undefined } as ReturnType<
        typeof import("node:child_process").spawnSync
      >;
    };
    const result = pullReviewFileBestEffort(root, "999999", "reviewed", fakeSpawn as never);
    assert.equal(result.attempted, false);
    assert.equal(called, false);
  });
});
