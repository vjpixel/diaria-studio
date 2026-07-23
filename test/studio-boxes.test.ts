/**
 * test/studio-boxes.test.ts (#3924) — seção "Caixas": listar e editar os
 * snippets de caixa de divulgação (`context/snippets/*.md`).
 *
 * Duas frentes:
 *   1. Lógica PURA de `scripts/studio-ui/studio-boxes.ts` (slug validation,
 *      extração de título, slots via `platform.config.json`, dirty-vs-git
 *      fail-soft, save com guard de mtime #3729) — fixture de diretório
 *      temporário, sem repo git real (exercita o fail-soft de
 *      `checkDirtyVsGit`).
 *   2. Contrato HTTP via `startStudioServer` (mesmo padrão de
 *      `test/studio-apoios-page.test.ts`/`test/studio-review-server.test.ts`):
 *      `GET /caixas` (shell), `GET /api/boxes` (lista), `GET/PUT /api/boxes/:slug`
 *      (conteúdo + save, incluindo o conflito 409 e o retry com `force`).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";
import {
  isValidBoxSlug,
  extractBoxTitle,
  readBoxSlotAssignments,
  checkDirtyVsGit,
  listBoxes,
  readBox,
  saveBox,
  boxFilePath,
  createBox,
  archiveBox,
  unarchiveBox,
  listArchivedBoxes,
  archivedBoxFilePath,
  parseBoxNome,
  stripNomeLine,
  buildBoxContentWithNome,
  resolveBoxDisplayName,
} from "../scripts/studio-ui/studio-boxes.ts";

// ─── lógica pura ──────────────────────────────────────────────────────────

describe("isValidBoxSlug (#3924)", () => {
  it("aceita slug bem-formado (minúsculas/dígitos/hífen + .md)", () => {
    assert.equal(isValidBoxSlug("recomendacao-leitura.md"), true);
    assert.equal(isValidBoxSlug("apoio-divulgacao-2.md"), true);
  });

  it("rejeita README.md explicitamente", () => {
    assert.equal(isValidBoxSlug("README.md"), false);
  });

  it("rejeita traversal (barra, ..)", () => {
    assert.equal(isValidBoxSlug("../secrets.md"), false);
    assert.equal(isValidBoxSlug("../../etc/passwd.md"), false);
    assert.equal(isValidBoxSlug("sub/dir.md"), false);
  });

  it("rejeita extensão errada", () => {
    assert.equal(isValidBoxSlug("foo.txt"), false);
    assert.equal(isValidBoxSlug("foo"), false);
    assert.equal(isValidBoxSlug("foo.MD"), false);
  });

  it("rejeita maiúsculas em qualquer posição (não só README.md)", () => {
    assert.equal(isValidBoxSlug("Foo.md"), false);
    assert.equal(isValidBoxSlug("foo-Bar.md"), false);
  });
});

describe("extractBoxTitle (#3924)", () => {
  it("usa o primeiro heading, sem os '#'", () => {
    assert.equal(extractBoxTitle("# Recomendação de leitura\n\nTexto aqui."), "Recomendação de leitura");
    assert.equal(extractBoxTitle("## Um heading nível 2"), "Um heading nível 2");
  });

  it("usa a primeira linha não-vazia quando não é heading", () => {
    assert.equal(extractBoxTitle("\n\nOlá, leitor!\nSegunda linha."), "Olá, leitor!");
  });

  it("trunca títulos longos a ~80 chars com reticências", () => {
    const long = "A".repeat(120);
    const title = extractBoxTitle(long);
    assert.ok(title.length <= 80);
    assert.ok(title.endsWith("…"));
  });

  it("arquivo vazio (ou só linhas em branco) vira '(vazio)'", () => {
    assert.equal(extractBoxTitle(""), "(vazio)");
    assert.equal(extractBoxTitle("\n\n   \n"), "(vazio)");
  });

  // #3928: TODOS os snippets abrem com um bloco de comentário HTML de doc —
  // sem pular o comentário, o título vazava como literalmente "<!--".
  it("pula bloco de comentário HTML multi-linha e usa o 1º conteúdo real (heading)", () => {
    const content = "<!--\nBloco canônico de DIVULGAÇÃO ...\nvárias linhas de doc\n-->\n\n# Recomendação de leitura\n\nTexto.";
    assert.equal(extractBoxTitle(content), "Recomendação de leitura");
  });

  it("pula comentário HTML multi-linha e usa a 1ª linha de texto puro quando não há heading", () => {
    const content = "<!--\ndoc interna\n-->\nEquipe sua casa com a Alexa+\n\nMais texto.";
    assert.equal(extractBoxTitle(content), "Equipe sua casa com a Alexa+");
  });

  it("pula comentário HTML na mesma linha", () => {
    assert.equal(extractBoxTitle("<!-- nota -->Título inline"), "Título inline");
    assert.equal(extractBoxTitle("<!-- a --> <!-- b -->\n# Depois de dois comentários"), "Depois de dois comentários");
  });

  it("comentário HTML NÃO-fechado (sem -->) nunca vaza '<!--' como título", () => {
    // Degenerado: descarta do <!-- em diante -> nada real sobra -> "(vazio)",
    // NUNCA o literal "<!--".
    const title = extractBoxTitle("<!--\ncomentário que nunca fecha\nmais linhas");
    assert.notEqual(title, "<!--");
    assert.equal(title, "(vazio)");
  });

  it("nenhum dos snippets afetados devolve '<!--' (regressão do sintoma exato)", () => {
    const withHeader = "<!--\nheader de doc\n-->\nConteúdo visível da caixa";
    assert.notEqual(extractBoxTitle(withHeader), "<!--");
    assert.equal(extractBoxTitle(withHeader), "Conteúdo visível da caixa");
  });
});

describe("readBoxSlotAssignments (#3924)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-slots-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("sem platform.config.json -> {} (fail-soft)", () => {
    assert.deepEqual(readBoxSlotAssignments(root), {});
  });

  it("com boxes_divulgacao -> mapa filename -> slot", () => {
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({
        boxes_divulgacao: { slot1: "a.md", slot2: "b.md", slot3: "c.md" },
      }),
    );
    assert.deepEqual(readBoxSlotAssignments(root), { "a.md": 1, "b.md": 2, "c.md": 3 });
  });

  it("JSON corrompido -> {} (fail-soft, nunca lança)", () => {
    const corruptRoot = mkdtempSync(join(tmpdir(), "studio-boxes-slots-corrupt-"));
    writeFileSync(join(corruptRoot, "platform.config.json"), "{ not json");
    assert.deepEqual(readBoxSlotAssignments(corruptRoot), {});
    rmSync(corruptRoot, { recursive: true, force: true });
  });

  it("boxes_divulgacao ausente/malformado -> {} (fail-soft)", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "studio-boxes-slots-other-"));
    writeFileSync(join(otherRoot, "platform.config.json"), JSON.stringify({ newsletter: "beehiiv" }));
    assert.deepEqual(readBoxSlotAssignments(otherRoot), {});
    rmSync(otherRoot, { recursive: true, force: true });
  });
});

describe("checkDirtyVsGit (#3924) — fail-soft sem repo git real", () => {
  it("rootDir que não é um repo git -> false, nunca lança", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-nogit-"));
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "a.md"), "# A");
    assert.equal(checkDirtyVsGit(root, "a.md"), false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("listBoxes (#3924)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-list-"));
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "README.md"), "# Formato dos snippets\n\nDocumentação.");
    writeFileSync(join(root, "context", "snippets", "recomendacao-leitura.md"), "# Recomendação de leitura\n\nConteúdo A.");
    writeFileSync(join(root, "context", "snippets", "apoio-divulgacao.md"), "# Apoio\n\nConteúdo B.");
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ boxes_divulgacao: { slot1: "recomendacao-leitura.md" } }),
    );
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("diretório ausente -> []", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "studio-boxes-nodir-"));
    assert.deepEqual(listBoxes(emptyRoot), []);
    rmSync(emptyRoot, { recursive: true, force: true });
  });

  it("lista dinâmica exclui README.md, ordenada por slug, com título/mtime/slot/dirtyVsGit", () => {
    const boxes = listBoxes(root);
    const slugs = boxes.map((b) => b.slug);
    assert.ok(!slugs.includes("README.md"), "README.md nunca deve aparecer na lista");
    assert.deepEqual(slugs, ["apoio-divulgacao.md", "recomendacao-leitura.md"]);

    const recomendacao = boxes.find((b) => b.slug === "recomendacao-leitura.md")!;
    assert.equal(recomendacao.title, "Recomendação de leitura");
    assert.equal(recomendacao.slot, 1);
    assert.equal(recomendacao.dirtyVsGit, false); // sem repo git real no fixture
    assert.match(recomendacao.mtimeIso, /^\d{4}-\d{2}-\d{2}T/);

    const apoio = boxes.find((b) => b.slug === "apoio-divulgacao.md")!;
    assert.equal(apoio.title, "Apoio");
    assert.equal(apoio.slot, null); // não atribuído a nenhum slot no fixture
  });
});

// ─── leitura/escrita de 1 caixa (pura) ────────────────────────────────────

describe("readBox / saveBox (#3924, pure)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-rw-"));
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "README.md"), "doc");
    writeFileSync(join(root, "context", "snippets", "box-a.md"), "# Box A\n\nOriginal.");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("readBox: slug válido existente -> ok:true com content/modifiedAt", () => {
    const state = readBox(root, "box-a.md");
    assert.equal(state.ok, true);
    assert.match(state.content, /Original/);
    assert.ok(state.modifiedAt);
  });

  it("readBox: README.md -> ok:false (rejeitado explicitamente)", () => {
    const state = readBox(root, "README.md");
    assert.equal(state.ok, false);
  });

  it("readBox: traversal -> ok:false", () => {
    assert.equal(readBox(root, "../README.md").ok, false);
    assert.equal(readBox(root, "..%2fREADME.md").ok, false);
  });

  it("readBox: slug bem-formado mas inexistente -> ok:false", () => {
    const state = readBox(root, "nao-existe.md");
    assert.equal(state.ok, false);
    assert.match(state.error ?? "", /não encontrada/);
  });

  it("saveBox: happy path sobrescreve o conteúdo e devolve novo modifiedAt", () => {
    const loaded = readBox(root, "box-a.md");
    const result = saveBox(root, "box-a.md", "# Box A\n\nAtualizado.", { expectedModifiedAt: loaded.modifiedAt });
    assert.equal(result.ok, true);
    assert.match(readFileSync(boxFilePath(root, "box-a.md"), "utf8"), /Atualizado/);
    assert.notEqual(result.modifiedAt, undefined);
  });

  it("saveBox: expectedModifiedAt divergente -> conflict:true, NÃO sobrescreve", () => {
    const filePath = boxFilePath(root, "box-a.md");
    const staleModifiedAt = statSync(filePath).mtime.toISOString();
    // Simula outra sessão escrevendo por baixo.
    writeFileSync(filePath, "# Box A\n\nEscrita concorrente.", "utf8");

    const result = saveBox(root, "box-a.md", "minha versão local", { expectedModifiedAt: staleModifiedAt });
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.ok(result.currentModifiedAt);
    assert.match(readFileSync(filePath, "utf8"), /Escrita concorrente/, "não deve sobrescrever em caso de conflito");
  });

  it("saveBox: force:true sobrescreve mesmo com expectedModifiedAt divergente", () => {
    const filePath = boxFilePath(root, "box-a.md");
    const staleModifiedAt = statSync(filePath).mtime.toISOString();
    writeFileSync(filePath, "# Box A\n\noutra escrita concorrente 2", "utf8");

    const result = saveBox(root, "box-a.md", "sobrescrita forçada", {
      expectedModifiedAt: staleModifiedAt,
      force: true,
    });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(filePath, "utf8"), "sobrescrita forçada");
  });

  it("saveBox: sem expectedModifiedAt no corpo pula a checagem de conflito", () => {
    const result = saveBox(root, "box-a.md", "sem checagem de mtime");
    assert.equal(result.ok, true);
    assert.equal(result.conflict, undefined);
  });

  it("saveBox: README.md -> notFound:true (rejeitado, nunca escreve)", () => {
    const result = saveBox(root, "README.md", "tentativa de sobrescrever o README");
    assert.equal(result.ok, false);
    assert.equal(result.notFound, true);
    assert.equal(readFileSync(join(root, "context", "snippets", "README.md"), "utf8"), "doc");
  });

  it("saveBox: traversal -> notFound:true, nunca escreve fora de context/snippets/", () => {
    const result = saveBox(root, "../outside.md", "não deveria ir a lugar nenhum");
    assert.equal(result.ok, false);
    assert.equal(result.notFound, true);
  });

  it("saveBox: slug bem-formado mas inexistente -> notFound:true (criação está fora de escopo)", () => {
    const result = saveBox(root, "nova-caixa.md", "conteúdo novo");
    assert.equal(result.ok, false);
    assert.equal(result.notFound, true);
  });
});

// ─── criar / arquivar / restaurar (pura, #3928) ───────────────────────────

describe("createBox (#3928, pure)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-create-"));
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "existente.md"), "# Já existe");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("cria arquivo novo com slug válido e devolve modifiedAt", () => {
    const result = createBox(root, "nova-caixa.md", "# Nova\n\nConteúdo.");
    assert.equal(result.ok, true);
    assert.ok(result.modifiedAt);
    assert.equal(readFileSync(boxFilePath(root, "nova-caixa.md"), "utf8"), "# Nova\n\nConteúdo.");
  });

  it("slug já existente (viva) -> exists:true, NÃO sobrescreve", () => {
    const result = createBox(root, "existente.md", "sobrescrita indevida");
    assert.equal(result.ok, false);
    assert.equal(result.exists, true);
    assert.match(readFileSync(boxFilePath(root, "existente.md"), "utf8"), /Já existe/);
  });

  it("slug já existente (arquivada) -> exists:true (não recria por cima da arquivada)", () => {
    mkdirSync(join(root, "context", "snippets", "_arquivo"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "_arquivo", "arquivada.md"), "# Arquivada");
    const result = createBox(root, "arquivada.md", "nova");
    assert.equal(result.ok, false);
    assert.equal(result.exists, true);
  });

  it("README.md / maiúscula / traversal -> invalidSlug:true, nunca escreve", () => {
    assert.equal(createBox(root, "README.md", "x").invalidSlug, true);
    assert.equal(createBox(root, "Foo.md", "x").invalidSlug, true);
    assert.equal(createBox(root, "../fora.md", "x").invalidSlug, true);
  });
});

describe("archiveBox / unarchiveBox / listArchivedBoxes (#3928, pure)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-archive-"));
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "livre.md"), "# Livre\n\nConteúdo preservável.");
    writeFileSync(join(root, "context", "snippets", "no-slot.md"), "# No slot\n\nAtribuída a um slot.");
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ boxes_divulgacao: { slot1: "no-slot.md" } }),
    );
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("archiveBox: move pra _arquivo/, some de listBoxes, conteúdo preservado byte-a-byte", () => {
    const before = readFileSync(boxFilePath(root, "livre.md"), "utf8");
    const result = archiveBox(root, "livre.md");
    assert.equal(result.ok, true);
    // Sumiu da lista viva…
    assert.ok(!listBoxes(root).some((b) => b.slug === "livre.md"));
    // …mas o arquivo original não existe mais no nível de snippets…
    assert.equal(existsSync(boxFilePath(root, "livre.md")), false);
    // …e o conteúdo está intacto em _arquivo/.
    assert.equal(readFileSync(archivedBoxFilePath(root, "livre.md"), "utf8"), before);
  });

  it("archiveBox: BLOQUEIA caixa em slot ativo (blockedBySlot), não move", () => {
    const result = archiveBox(root, "no-slot.md");
    assert.equal(result.ok, false);
    assert.equal(result.blockedBySlot, true);
    assert.equal(result.slot, 1);
    assert.equal(existsSync(boxFilePath(root, "no-slot.md")), true, "não deve ter movido a caixa com slot");
  });

  it("archiveBox: slug inexistente/ inválido -> notFound", () => {
    assert.equal(archiveBox(root, "nao-existe.md").notFound, true);
    assert.equal(archiveBox(root, "README.md").notFound, true);
  });

  it("listArchivedBoxes: lista só o conteúdo de _arquivo/", () => {
    const archived = listArchivedBoxes(root);
    assert.deepEqual(archived.map((b) => b.slug), ["livre.md"]);
    assert.equal(archived[0].title, "Livre");
  });

  it("unarchiveBox: restaura de volta pra snippets/ e some de _arquivo/", () => {
    const result = unarchiveBox(root, "livre.md");
    assert.equal(result.ok, true);
    assert.equal(existsSync(boxFilePath(root, "livre.md")), true);
    assert.equal(existsSync(archivedBoxFilePath(root, "livre.md")), false);
    assert.ok(listBoxes(root).some((b) => b.slug === "livre.md"));
  });

  it("unarchiveBox: conflito se já existe caixa viva de mesmo slug", () => {
    // Arquiva de novo, depois recria uma viva com o mesmo slug → restaurar deve bloquear.
    archiveBox(root, "livre.md");
    writeFileSync(boxFilePath(root, "livre.md"), "# Livre recriada");
    const result = unarchiveBox(root, "livre.md");
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.match(readFileSync(boxFilePath(root, "livre.md"), "utf8"), /recriada/, "não deve sobrescrever a viva");
  });

  it("unarchiveBox: sem arquivada correspondente -> notFound", () => {
    assert.equal(unarchiveBox(root, "nunca-arquivada.md").notFound, true);
  });
});

// ─── nome interno vs. título de conteúdo (pura, #3933) ─────────────────────

describe("parseBoxNome (#3933)", () => {
  it("extrai `nome:` do header de comentário", () => {
    assert.equal(parseBoxNome("<!--\nnome: Apoio (slot 3)\ndoc\n-->\n\n# Título"), "Apoio (slot 3)");
  });
  it("é case-insensitive na chave e trima o valor", () => {
    assert.equal(parseBoxNome("<!--\nNome:   Recomendação de leitura   \n-->\ntexto"), "Recomendação de leitura");
  });
  it("null quando o header não tem nome:", () => {
    assert.equal(parseBoxNome("<!--\nsó doc, sem nome\n-->\ntexto"), null);
  });
  it("null quando não há header de comentário", () => {
    assert.equal(parseBoxNome("# Título direto\n\ntexto"), null);
  });
  it("ignora `nome:` que esteja no CORPO, não no header", () => {
    assert.equal(parseBoxNome("# Título\n\nnome: isso não conta"), null);
  });
});

describe("stripNomeLine (#3933)", () => {
  it("remove a linha nome: mantendo o resto do header", () => {
    const out = stripNomeLine("<!--\nnome: X\ndoc que fica\n-->\n\n# T");
    assert.ok(!/nome:/.test(out));
    assert.match(out, /doc que fica/);
    assert.match(out, /# T/);
  });
  it("remove o comentário inteiro se ele ficar vazio (só tinha nome:)", () => {
    const out = stripNomeLine("<!--\nnome: X\n-->\n\n# Conteúdo");
    assert.equal(out, "# Conteúdo");
  });
  it("no-op quando não há nome: no header", () => {
    const src = "<!--\ndoc\n-->\ntexto";
    assert.equal(stripNomeLine(src), src);
  });
  it("é idempotente", () => {
    const src = "<!--\nnome: X\ndoc\n-->\ntexto";
    assert.equal(stripNomeLine(stripNomeLine(src)), stripNomeLine(src));
  });
});

describe("buildBoxContentWithNome (#3933)", () => {
  it("prepend header novo quando o body não tem comentário", () => {
    const out = buildBoxContentWithNome("Meu Nome", "# Conteúdo\n\ntexto");
    assert.equal(parseBoxNome(out), "Meu Nome");
    assert.match(out, /# Conteúdo/);
  });
  it("insere nome: dentro do header existente sem apagar o doc", () => {
    const out = buildBoxContentWithNome("Meu Nome", "<!--\ndoc existente\n-->\n\n# C");
    assert.equal(parseBoxNome(out), "Meu Nome");
    assert.match(out, /doc existente/);
  });
  it("nome vazio remove qualquer nome: e não deixa header órfão", () => {
    assert.equal(buildBoxContentWithNome("", "<!--\nnome: X\n-->\n\n# C"), "# C");
    assert.equal(buildBoxContentWithNome("   ", "# C"), "# C");
  });
  it("nunca duplica nome: (body que ainda tinha um)", () => {
    const out = buildBoxContentWithNome("Novo", "<!--\nnome: Velho\ndoc\n-->\ntexto");
    assert.equal(parseBoxNome(out), "Novo");
    assert.equal((out.match(/nome:/gi) ?? []).length, 1);
  });
  it("round-trip: build(parse(x), strip(x)) preserva o nome e o conteúdo", () => {
    const x = "<!--\nnome: Rótulo Interno\ndoc do snippet\n-->\n\n**Título na edição**\n\ncorpo";
    const rebuilt = buildBoxContentWithNome(parseBoxNome(x) ?? "", stripNomeLine(x));
    assert.equal(parseBoxNome(rebuilt), "Rótulo Interno");
    assert.match(rebuilt, /Título na edição/);
    assert.match(rebuilt, /doc do snippet/);
  });
  it("INVARIANTE: o nome: nunca sobrevive ao strip de comentário do render (snippet-loader.ts)", () => {
    // Mesma regex que readSnippetFile usa pra tirar o header antes do conteúdo
    // ir pra newsletter — o nome interno JAMAIS pode vazar pro leitor.
    const built = buildBoxContentWithNome("SEGREDO INTERNO", "# Título público\n\ncorpo visível");
    const rendered = built.replace(/<!--[\s\S]*?-->/g, "").trim();
    assert.ok(!rendered.includes("SEGREDO INTERNO"), "nome interno vazou no conteúdo renderizado");
    assert.ok(!/nome:/i.test(rendered));
    assert.match(rendered, /Título público/);
  });
});

describe("resolveBoxDisplayName (#3933)", () => {
  it("nome: explícito vence o título derivado do conteúdo", () => {
    assert.equal(resolveBoxDisplayName("<!--\nnome: Rótulo\n-->\n# Outro título", "x.md"), "Rótulo");
  });
  it("sem nome:, cai no título derivado do conteúdo", () => {
    assert.equal(resolveBoxDisplayName("<!--\ndoc\n-->\n# Título de conteúdo", "x.md"), "Título de conteúdo");
  });
  it("só-comentário/vazio cai no slug", () => {
    assert.equal(resolveBoxDisplayName("<!--\ndoc\n-->", "minha-caixa.md"), "minha-caixa.md");
    assert.equal(resolveBoxDisplayName("", "vazia.md"), "vazia.md");
  });
});

// ─── contrato HTTP ─────────────────────────────────────────────────────────

describe("GET /caixas + /api/boxes + PUT (#3924)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-http-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "README.md"), "# Formato\n\nDoc.");
    writeFileSync(join(root, "context", "snippets", "recomendacao-leitura.md"), "# Recomendação\n\nConteúdo.");
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ boxes_divulgacao: { slot1: "recomendacao-leitura.md" } }),
    );
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serve o shell caixas.html", async () => {
    const res = await fetch(new URL("/caixas", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("caixas.js"));
    assert.ok(body.includes("boxes-list"));
  });

  it("aceita /caixas/ com trailing slash", async () => {
    const res = await fetch(new URL("/caixas/", server.url));
    assert.equal(res.status, 200);
  });

  it("GET /caixas.js e /caixas.css são servidos com content-type correto", async () => {
    const js = await fetch(new URL("/caixas.js", server.url));
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const css = await fetch(new URL("/caixas.css", server.url));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /css/);
  });

  it("GET /api/boxes lista dinamicamente, sem README.md, com badge de slot", async () => {
    const res = await fetch(new URL("/api/boxes", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    const slugs = body.boxes.map((b: { slug: string }) => b.slug);
    assert.ok(!slugs.includes("README.md"));
    assert.ok(slugs.includes("recomendacao-leitura.md"));
    const box = body.boxes.find((b: { slug: string }) => b.slug === "recomendacao-leitura.md");
    assert.equal(box.slot, 1);
    assert.equal(box.title, "Recomendação");
  });

  it("GET /api/boxes/:slug retorna conteúdo + modifiedAt", async () => {
    const res = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.content, /Conteúdo/);
    assert.ok(body.modifiedAt);
  });

  it("GET /api/boxes/:slug com README.md -> 404", async () => {
    const res = await fetch(new URL("/api/boxes/README.md", server.url));
    assert.equal(res.status, 404);
  });

  it("GET /api/boxes/:slug com traversal -> 404", async () => {
    const res = await fetch(new URL("/api/boxes/foo.txt", server.url));
    assert.equal(res.status, 404);
  });

  it("GET /api/boxes/:slug inexistente -> 404", async () => {
    const res = await fetch(new URL("/api/boxes/nao-existe.md", server.url));
    assert.equal(res.status, 404);
  });

  let loadedModifiedAt = "";

  it("PUT /api/boxes/:slug feliz — salva e devolve novo modifiedAt", async () => {
    const getRes = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url));
    const getBody = await getRes.json();
    loadedModifiedAt = getBody.modifiedAt;

    const put = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Recomendação\n\nEditado via painel.", expectedModifiedAt: loadedModifiedAt }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.equal(putBody.ok, true);
    assert.match(
      readFileSync(join(root, "context", "snippets", "recomendacao-leitura.md"), "utf8"),
      /Editado via painel/,
    );
    loadedModifiedAt = putBody.modifiedAt;
  });

  it("PUT com expectedModifiedAt obsoleto -> 409, não sobrescreve", async () => {
    // `loadedModifiedAt` agora está obsoleto (mtime mudou no teste anterior) —
    // simula outra sessão escrevendo por baixo antes deste PUT.
    writeFileSync(
      join(root, "context", "snippets", "recomendacao-leitura.md"),
      "# Recomendação\n\nEscrita concorrente (outra aba).",
      "utf8",
    );
    const staleModifiedAt = loadedModifiedAt;

    const put = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "minha versão", expectedModifiedAt: staleModifiedAt }),
    });
    assert.equal(put.status, 409);
    const body = await put.json();
    assert.equal(body.conflict, true);
    assert.match(
      readFileSync(join(root, "context", "snippets", "recomendacao-leitura.md"), "utf8"),
      /Escrita concorrente/,
    );
  });

  it("PUT com force:true sobrescreve mesmo com expectedModifiedAt divergente", async () => {
    const put = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "sobrescrita forçada via HTTP", expectedModifiedAt: loadedModifiedAt, force: true }),
    });
    assert.equal(put.status, 200);
    assert.equal(
      readFileSync(join(root, "context", "snippets", "recomendacao-leitura.md"), "utf8"),
      "sobrescrita forçada via HTTP",
    );
  });

  it("PUT /api/boxes/README.md -> 404, nunca escreve", async () => {
    const put = await fetch(new URL("/api/boxes/README.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "tentativa de sobrescrever o README" }),
    });
    assert.equal(put.status, 404);
    assert.equal(readFileSync(join(root, "context", "snippets", "README.md"), "utf8"), "# Formato\n\nDoc.");
  });

  it("PUT com traversal no slug -> 404", async () => {
    const put = await fetch(new URL("/api/boxes/..%2Foutside.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    assert.equal(put.status, 404);
  });

  it("PUT em slug bem-formado mas inexistente -> 404 (criação fora de escopo)", async () => {
    const put = await fetch(new URL("/api/boxes/nova-caixa.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    assert.equal(put.status, 404);
  });

  it("PUT com corpo sem 'content' -> 400", async () => {
    const put = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedModifiedAt: null }),
    });
    assert.equal(put.status, 400);
  });

  it("PUT com corpo não-JSON -> 400", async () => {
    const put = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "não é json",
    });
    assert.equal(put.status, 400);
  });

  it("POST /api/boxes/recomendacao-leitura.md (método não-allowlistado) -> 405 (guard read-only)", async () => {
    const res = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });
});

// ─── contrato HTTP: criar / arquivar / restaurar (#3928) ───────────────────

describe("POST /api/boxes (create) + archive/unarchive + GET /api/boxes/archived (#3928)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-3928-http-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "README.md"), "# Formato\n\nDoc.");
    writeFileSync(join(root, "context", "snippets", "com-slot.md"), "# Com slot\n\nInjetada.");
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ boxes_divulgacao: { slot1: "com-slot.md" } }),
    );
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function post(path: string, body?: unknown) {
    return fetch(new URL(path, server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("POST /api/boxes cria caixa nova -> 201, aparece em /api/boxes", async () => {
    const res = await post("/api/boxes", { slug: "criada-via-http.md", content: "# Criada\n\nOi." });
    assert.equal(res.status, 201);
    assert.equal(
      readFileSync(join(root, "context", "snippets", "criada-via-http.md"), "utf8"),
      "# Criada\n\nOi.",
    );
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    assert.ok(list.boxes.some((b: { slug: string }) => b.slug === "criada-via-http.md"));
  });

  it("POST /api/boxes com slug já existente -> 409", async () => {
    const res = await post("/api/boxes", { slug: "criada-via-http.md", content: "outra" });
    assert.equal(res.status, 409);
  });

  it("POST /api/boxes com slug inválido (README.md) -> 400, nunca escreve", async () => {
    const res = await post("/api/boxes", { slug: "README.md", content: "x" });
    assert.equal(res.status, 400);
    assert.equal(readFileSync(join(root, "context", "snippets", "README.md"), "utf8"), "# Formato\n\nDoc.");
  });

  it("POST /api/boxes sem 'content' -> 400", async () => {
    assert.equal((await post("/api/boxes", { slug: "so-slug.md" })).status, 400);
  });

  it("POST /api/boxes/:slug/archive arquiva -> 200, some de /api/boxes e entra em /archived", async () => {
    const res = await post("/api/boxes/criada-via-http.md/archive");
    assert.equal(res.status, 200);
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    assert.ok(!list.boxes.some((b: { slug: string }) => b.slug === "criada-via-http.md"));
    const archived = await (await fetch(new URL("/api/boxes/archived", server.url))).json();
    assert.ok(archived.boxes.some((b: { slug: string }) => b.slug === "criada-via-http.md"));
  });

  it("POST /api/boxes/:slug/archive BLOQUEIA caixa em slot ativo -> 409, não move", async () => {
    const res = await post("/api/boxes/com-slot.md/archive");
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.blockedBySlot, true);
    assert.equal(existsSync(join(root, "context", "snippets", "com-slot.md")), true);
  });

  it("POST /api/boxes/:slug/archive em inexistente -> 404", async () => {
    assert.equal((await post("/api/boxes/nao-existe.md/archive")).status, 404);
  });

  it("POST /api/boxes/:slug/unarchive restaura -> 200, volta pra /api/boxes", async () => {
    const res = await post("/api/boxes/criada-via-http.md/unarchive");
    assert.equal(res.status, 200);
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    assert.ok(list.boxes.some((b: { slug: string }) => b.slug === "criada-via-http.md"));
  });

  it("GET /api/boxes/archived nunca é confundido com get-por-slug (200, lista)", async () => {
    const res = await fetch(new URL("/api/boxes/archived", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.boxes));
  });
});

// ─── contrato HTTP: nome interno separado do conteúdo (#3933) ──────────────

describe("nome interno via HTTP: GET body/nome, PUT {nome,body}, POST com nome (#3933)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-3933-http-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "README.md"), "# Formato\n\nDoc.");
    writeFileSync(
      join(root, "context", "snippets", "com-nome.md"),
      "<!--\nnome: Rótulo Interno\ndoc do snippet\n-->\n\n**Título na edição**\n\ncorpo",
    );
    writeFileSync(join(root, "context", "snippets", "sem-nome.md"), "# Título derivado\n\ncorpo");
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ boxes_divulgacao: {} }));
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /api/boxes lista com title=nome quando há nome:, e contentTitle separado", async () => {
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    const comNome = list.boxes.find((b: { slug: string }) => b.slug === "com-nome.md");
    assert.equal(comNome.title, "Rótulo Interno");
    assert.equal(comNome.nome, "Rótulo Interno");
    assert.equal(comNome.contentTitle, "**Título na edição**");
    const semNome = list.boxes.find((b: { slug: string }) => b.slug === "sem-nome.md");
    assert.equal(semNome.title, "Título derivado");
    assert.equal(semNome.nome, null);
  });

  it("GET /api/boxes/:slug devolve nome + body (sem a linha nome:)", async () => {
    const res = await fetch(new URL("/api/boxes/com-nome.md", server.url));
    const body = await res.json();
    assert.equal(body.nome, "Rótulo Interno");
    assert.ok(!/nome:/.test(body.body), "body não deve conter a linha nome:");
    assert.match(body.body, /doc do snippet/);
    assert.match(body.body, /Título na edição/);
  });

  it("PUT {nome, body} reconstrói o arquivo com o header e persiste", async () => {
    const get = await (await fetch(new URL("/api/boxes/sem-nome.md", server.url))).json();
    const put = await fetch(new URL("/api/boxes/sem-nome.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: "Nome Novo", body: get.body, expectedModifiedAt: get.modifiedAt }),
    });
    assert.equal(put.status, 200);
    const onDisk = readFileSync(join(root, "context", "snippets", "sem-nome.md"), "utf8");
    assert.match(onDisk, /<!--[\s\S]*nome: Nome Novo[\s\S]*-->/);
    assert.match(onDisk, /Título derivado/);
    // e a lista agora mostra o nome novo
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    assert.equal(list.boxes.find((b: { slug: string }) => b.slug === "sem-nome.md").nome, "Nome Novo");
  });

  it("PUT {content} legado continua funcionando (compat)", async () => {
    const get = await (await fetch(new URL("/api/boxes/com-nome.md", server.url))).json();
    const put = await fetch(new URL("/api/boxes/com-nome.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Reescrito por caller legado", expectedModifiedAt: get.modifiedAt }),
    });
    assert.equal(put.status, 200);
    assert.equal(
      readFileSync(join(root, "context", "snippets", "com-nome.md"), "utf8"),
      "# Reescrito por caller legado",
    );
  });

  it("PUT sem 'body' nem 'content' -> 400", async () => {
    const put = await fetch(new URL("/api/boxes/sem-nome.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: "só nome" }),
    });
    assert.equal(put.status, 400);
  });

  it("POST {slug, nome, content} cria caixa com header nome:", async () => {
    const res = await fetch(new URL("/api/boxes", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "nova-com-nome.md", nome: "Caixa Nomeada", content: "# Público\n\ncorpo" }),
    });
    assert.equal(res.status, 201);
    const onDisk = readFileSync(join(root, "context", "snippets", "nova-com-nome.md"), "utf8");
    assert.match(onDisk, /nome: Caixa Nomeada/);
    // invariante: nome não vaza no render
    assert.ok(!onDisk.replace(/<!--[\s\S]*?-->/g, "").includes("Caixa Nomeada"));
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    assert.equal(list.boxes.find((b: { slug: string }) => b.slug === "nova-com-nome.md").nome, "Caixa Nomeada");
  });
});
