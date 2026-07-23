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
 *      (conteúdo + save, incluindo o conflito 409 e o retry com `force`),
 *      `GET/PUT /api/boxes/slots` (#3937 — gestão de slots pela UI).
 */
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resolvePlatformConfigPath = () => join(REPO_ROOT, "platform.config.json");
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
  readBoxSlotsState,
  replaceBoxesDivulgacaoBlock,
  saveBoxSlots,
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
    // Simula outra sessão escrevendo por baixo. `utimesSync` força o mtime 2s
    // pra frente pra o teste ser DETERMINÍSTICO — sem isso, num FS com
    // granularidade grossa de mtime (runner CI), a escrita cairia no mesmo tick
    // do `statSync` acima, o mtime não mudaria, e o conflito não dispararia
    // (flake histórica, quebrou o CI da PR #3935).
    writeFileSync(filePath, "# Box A\n\nEscrita concorrente.", "utf8");
    const bumped = new Date(new Date(staleModifiedAt).getTime() + 2000);
    utimesSync(filePath, bumped, bumped);

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
    const bumped = new Date(new Date(staleModifiedAt).getTime() + 2000);
    utimesSync(filePath, bumped, bumped); // determinismo de mtime (ver teste acima)

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

// ─── gestão de slots pela UI (pura, #3937) ─────────────────────────────────

describe("replaceBoxesDivulgacaoBlock (#3937, pure)", () => {
  it("reescreve só o bloco boxes_divulgacao, preservando o resto byte-a-byte", () => {
    const raw = [
      "{",
      '  "newsletter": "beehiiv",',
      '  "socials": [',
      '    "linkedin",',
      '    "facebook"',
      "  ],",
      '  "boxes_divulgacao": {',
      '    "slot1": "recomendacao-leitura.md",',
      '    "slot2": "livros-divulgacao.md",',
      '    "slot3": "apoio-divulgacao.md"',
      "  },",
      '  "drive_sync": false',
      "}",
    ].join("\n");

    const out = replaceBoxesDivulgacaoBlock(raw, { slot1: "outra.md", slot2: "", slot3: "apoio-divulgacao.md" });

    // As chaves ANTES e DEPOIS do bloco reescrito ficam byte-a-byte intactas.
    assert.ok(out.startsWith('{\n  "newsletter": "beehiiv",\n  "socials": [\n    "linkedin",\n    "facebook"\n  ],\n'));
    assert.ok(out.endsWith('\n  "drive_sync": false\n}'));
    // O bloco em si reflete os novos valores.
    assert.match(out, /"slot1": "outra\.md"/);
    assert.match(out, /"slot2": ""/);
    assert.match(out, /"slot3": "apoio-divulgacao\.md"/);
    // JSON continua válido e as outras chaves sobrevivem semanticamente.
    const parsed = JSON.parse(out);
    assert.equal(parsed.newsletter, "beehiiv");
    assert.deepEqual(parsed.socials, ["linkedin", "facebook"]);
    assert.equal(parsed.drive_sync, false);
    assert.deepEqual(parsed.boxes_divulgacao, { slot1: "outra.md", slot2: "", slot3: "apoio-divulgacao.md" });
  });

  it("byte-a-byte contra o platform.config.json REAL do repo (regressão do formato canônico)", () => {
    const raw = readFileSync(resolvePlatformConfigPath(), "utf8");
    const out = replaceBoxesDivulgacaoBlock(raw, { slot1: "x.md", slot2: "y.md", slot3: "" });
    // Só a região do bloco boxes_divulgacao muda — tudo antes e depois idêntico.
    const blockStart = raw.indexOf('"boxes_divulgacao"');
    assert.ok(blockStart > 0, "fixture do repo precisa ter boxes_divulgacao");
    assert.equal(out.slice(0, blockStart), raw.slice(0, blockStart));
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.boxes_divulgacao, { slot1: "x.md", slot2: "y.md", slot3: "" });
  });

  it("insere o bloco (defensivo) quando boxes_divulgacao ainda não existe no arquivo", () => {
    const raw = '{\n  "newsletter": "beehiiv"\n}';
    const out = replaceBoxesDivulgacaoBlock(raw, { slot1: "a.md", slot2: "", slot3: "" });
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.boxes_divulgacao, { slot1: "a.md", slot2: "", slot3: "" });
    assert.equal(parsed.newsletter, "beehiiv");
  });

  it("lança em vez de escrever algo potencialmente corrompido quando não há ponto de inserção seguro", () => {
    assert.throws(() => replaceBoxesDivulgacaoBlock("não é json de jeito nenhum", { slot1: "", slot2: "", slot3: "" }));
  });
});

describe("readBoxSlotsState (#3937, pure)", () => {
  it("sem platform.config.json -> slots vazios, modifiedAt:null", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-slotsstate-none-"));
    assert.deepEqual(readBoxSlotsState(root), { slot1: "", slot2: "", slot3: "", modifiedAt: null });
    rmSync(root, { recursive: true, force: true });
  });

  it("com boxes_divulgacao -> forma direta slot->filename + modifiedAt", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-slotsstate-"));
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ boxes_divulgacao: { slot1: "a.md", slot2: "b.md", slot3: "c.md" } }),
    );
    const state = readBoxSlotsState(root);
    assert.equal(state.slot1, "a.md");
    assert.equal(state.slot2, "b.md");
    assert.equal(state.slot3, "c.md");
    assert.ok(state.modifiedAt);
    rmSync(root, { recursive: true, force: true });
  });

  it("JSON corrompido -> slots vazios mas modifiedAt real (fail-soft, nunca lança)", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-slotsstate-corrupt-"));
    writeFileSync(join(root, "platform.config.json"), "{ not json");
    const state = readBoxSlotsState(root);
    assert.deepEqual({ slot1: state.slot1, slot2: state.slot2, slot3: state.slot3 }, { slot1: "", slot2: "", slot3: "" });
    assert.ok(state.modifiedAt);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("saveBoxSlots (#3937, pure)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-saveslots-"));
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "a.md"), "# A");
    writeFileSync(join(root, "context", "snippets", "b.md"), "# B");
    writeFileSync(join(root, "context", "snippets", "c.md"), "# C");
    mkdirSync(join(root, "context", "snippets", "_arquivo"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "_arquivo", "arquivada.md"), "# Arquivada");
  });

  beforeEach(() => {
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify(
        {
          newsletter: "beehiiv",
          boxes_divulgacao: { slot1: "a.md", slot2: "b.md", slot3: "c.md" },
          drive_sync: false,
        },
        null,
        2,
      ) + "\n",
    );
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("happy path: reatribui e devolve o novo estado + modifiedAt", () => {
    const result = saveBoxSlots(root, { slot1: "b.md", slot2: "a.md", slot3: "" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.slots, { slot1: "b.md", slot2: "a.md", slot3: "", modifiedAt: result.modifiedAt });
  });

  it("preserva as outras chaves do platform.config.json byte-a-byte, só boxes_divulgacao muda", () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const result = saveBoxSlots(root, { slot1: "c.md", slot2: "", slot3: "a.md" });
    assert.equal(result.ok, true);
    const after = readFileSync(join(root, "platform.config.json"), "utf8");
    const blockStart = before.indexOf('"boxes_divulgacao"');
    assert.equal(after.slice(0, blockStart), before.slice(0, blockStart), "conteúdo ANTES do bloco deve ser idêntico");
    const parsedBefore = JSON.parse(before);
    const parsedAfter = JSON.parse(after);
    assert.equal(parsedAfter.newsletter, parsedBefore.newsletter);
    assert.equal(parsedAfter.drive_sync, parsedBefore.drive_sync);
    assert.deepEqual(parsedAfter.boxes_divulgacao, { slot1: "c.md", slot2: "", slot3: "a.md" });
  });

  it("aceita '(vazio)' — string vazia em qualquer slot", () => {
    const result = saveBoxSlots(root, { slot1: "", slot2: "", slot3: "" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.slots, { slot1: "", slot2: "", slot3: "", modifiedAt: result.modifiedAt });
  });

  it("guard 1: rejeita caixa INEXISTENTE, não escreve", () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const result = saveBoxSlots(root, { slot1: "nao-existe.md", slot2: "", slot3: "" });
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.equal(readFileSync(join(root, "platform.config.json"), "utf8"), before, "não deve escrever em atribuição inválida");
  });

  it("guard 1: rejeita caixa ARQUIVADA, não escreve", () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const result = saveBoxSlots(root, { slot1: "arquivada.md", slot2: "", slot3: "" });
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.equal(readFileSync(join(root, "platform.config.json"), "utf8"), before);
  });

  it("guard 2: rejeita a MESMA caixa em 2 slots, não escreve", () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const result = saveBoxSlots(root, { slot1: "a.md", slot2: "a.md", slot3: "" });
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.match(result.error ?? "", /a\.md/);
    assert.equal(readFileSync(join(root, "platform.config.json"), "utf8"), before);
  });

  it("guard 4 (mtime): expectedModifiedAt divergente -> conflict:true, NÃO sobrescreve", () => {
    const configPath = join(root, "platform.config.json");
    const staleModifiedAt = statSync(configPath).mtime.toISOString();
    writeFileSync(configPath, JSON.stringify({ boxes_divulgacao: { slot1: "a.md", slot2: "b.md", slot3: "c.md" } }), "utf8");
    const bumped = new Date(new Date(staleModifiedAt).getTime() + 2000);
    utimesSync(configPath, bumped, bumped);

    const result = saveBoxSlots(root, { slot1: "b.md", slot2: "", slot3: "" }, { expectedModifiedAt: staleModifiedAt });
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.ok(result.currentModifiedAt);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(onDisk.boxes_divulgacao, { slot1: "a.md", slot2: "b.md", slot3: "c.md" }, "não deve sobrescrever em conflito");
  });

  it("guard 4: force:true sobrescreve mesmo com expectedModifiedAt divergente", () => {
    const configPath = join(root, "platform.config.json");
    const staleModifiedAt = statSync(configPath).mtime.toISOString();
    const bumped = new Date(new Date(staleModifiedAt).getTime() + 2000);
    utimesSync(configPath, bumped, bumped);

    const result = saveBoxSlots(
      root,
      { slot1: "c.md", slot2: "", slot3: "" },
      { expectedModifiedAt: staleModifiedAt, force: true },
    );
    assert.equal(result.ok, true);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(onDisk.boxes_divulgacao, { slot1: "c.md", slot2: "", slot3: "" });
  });

  it("sem expectedModifiedAt no corpo pula a checagem de conflito", () => {
    const result = saveBoxSlots(root, { slot1: "a.md", slot2: "b.md", slot3: "c.md" });
    assert.equal(result.ok, true);
    assert.equal(result.conflict, undefined);
  });

  it("platform.config.json ausente -> ok:false, sem lançar", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "studio-boxes-saveslots-noconfig-"));
    const result = saveBoxSlots(emptyRoot, { slot1: "", slot2: "", slot3: "" });
    assert.equal(result.ok, false);
    rmSync(emptyRoot, { recursive: true, force: true });
  });

  // #3937 nota "Fecha o loop com o Arquivar (#3928)": uma vez que o slot é
  // liberado por saveBoxSlots, archiveBox deixa de bloquear a mesma caixa.
  it("fecha o loop com archiveBox: liberar o slot aqui desbloqueia o arquivamento (#3928)", () => {
    // No estado do beforeEach, "b.md" está no slot2 -> archiveBox bloqueia.
    const blocked = archiveBox(root, "b.md");
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blockedBySlot, true);

    // Libera o slot2 (vazio) via saveBoxSlots...
    const freed = saveBoxSlots(root, { slot1: "a.md", slot2: "", slot3: "c.md" });
    assert.equal(freed.ok, true);

    // ...agora archiveBox segue normalmente.
    const archived = archiveBox(root, "b.md");
    assert.equal(archived.ok, true);
    assert.equal(existsSync(archivedBoxFilePath(root, "b.md")), true);

    // Restaura pro estado original do fixture, pra não vazar pros próximos testes.
    unarchiveBox(root, "b.md");
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
    // Determinismo de mtime (mesma flake do teste puro): força o mtime pra
    // frente pra garantir divergência mesmo em FS de granularidade grossa.
    const bumped = new Date(new Date(staleModifiedAt).getTime() + 2000);
    utimesSync(join(root, "context", "snippets", "recomendacao-leitura.md"), bumped, bumped);

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

// ─── contrato HTTP: gestão de slots de divulgação (#3937) ──────────────────

describe("GET/PUT /api/boxes/slots (#3937)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-3937-http-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "recomendacao-leitura.md"), "# Recomendação");
    writeFileSync(join(root, "context", "snippets", "livros-divulgacao.md"), "# Livros");
    writeFileSync(join(root, "context", "snippets", "apoio-divulgacao.md"), "# Apoio");
    mkdirSync(join(root, "context", "snippets", "_arquivo"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "_arquivo", "velha.md"), "# Velha");
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify(
        {
          newsletter: "beehiiv",
          boxes_divulgacao: {
            slot1: "recomendacao-leitura.md",
            slot2: "livros-divulgacao.md",
            slot3: "apoio-divulgacao.md",
          },
          drive_sync: false,
        },
        null,
        2,
      ) + "\n",
    );
  });

  it("GET /api/boxes/slots devolve a atribuição atual + modifiedAt", async () => {
    const res = await fetch(new URL("/api/boxes/slots", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.slot1, "recomendacao-leitura.md");
    assert.equal(body.slot2, "livros-divulgacao.md");
    assert.equal(body.slot3, "apoio-divulgacao.md");
    assert.ok(body.modifiedAt);
  });

  it("GET /api/boxes/slots nunca é confundido com get-por-slug (/api/boxes/:slug)", async () => {
    // Sem a checagem explícita antes do regex de slug, isto cairia em
    // readBox(root, "slots") -> 404. Regressão do #3928 pra "archived".
    const res = await fetch(new URL("/api/boxes/slots", server.url));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).slot1, "recomendacao-leitura.md");
  });

  it("PUT /api/boxes/slots feliz — reatribui e devolve o novo estado", async () => {
    const get = await (await fetch(new URL("/api/boxes/slots", server.url))).json();
    const loadedModifiedAt = get.modifiedAt;

    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot1: "livros-divulgacao.md",
        slot2: "",
        slot3: "apoio-divulgacao.md",
        expectedModifiedAt: loadedModifiedAt,
      }),
    });
    assert.equal(put.status, 200);
    const body = await put.json();
    assert.equal(body.ok, true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8")).boxes_divulgacao,
      { slot1: "livros-divulgacao.md", slot2: "", slot3: "apoio-divulgacao.md" },
    );
    // Badge da lista reflete a nova atribuição (refetch, R5) sem restart.
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    const livros = list.boxes.find((b: { slug: string }) => b.slug === "livros-divulgacao.md");
    assert.equal(livros.slot, 1);
    const recomendacao = list.boxes.find((b: { slug: string }) => b.slug === "recomendacao-leitura.md");
    assert.equal(recomendacao.slot, null);
  });

  it("preserva as outras chaves do platform.config.json (newsletter, drive_sync)", async () => {
    const res = await fetch(new URL("/api/boxes/slots", server.url));
    const get = await res.json();
    await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot1: "apoio-divulgacao.md", slot2: "", slot3: "", expectedModifiedAt: get.modifiedAt }),
    });
    const onDisk = JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8"));
    assert.equal(onDisk.newsletter, "beehiiv");
    assert.equal(onDisk.drive_sync, false);
  });

  it("guard 1: rejeita caixa inexistente num slot -> 400, não escreve", async () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot1: "nao-existe.md", slot2: "", slot3: "" }),
    });
    assert.equal(put.status, 400);
    const body = await put.json();
    assert.equal(body.invalid, true);
    assert.equal(readFileSync(join(root, "platform.config.json"), "utf8"), before);
  });

  it("guard 1: rejeita caixa ARQUIVADA num slot -> 400, não escreve", async () => {
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot1: "velha.md", slot2: "", slot3: "" }),
    });
    assert.equal(put.status, 400);
    const body = await put.json();
    assert.equal(body.invalid, true);
  });

  it("guard 2: rejeita a mesma caixa em 2 slots -> 400, não escreve", async () => {
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot1: "apoio-divulgacao.md", slot2: "apoio-divulgacao.md", slot3: "" }),
    });
    assert.equal(put.status, 400);
    const body = await put.json();
    assert.equal(body.invalid, true);
  });

  it("aceita '(vazio)' — todos os slots como string vazia", async () => {
    const get = await (await fetch(new URL("/api/boxes/slots", server.url))).json();
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot1: "", slot2: "", slot3: "", expectedModifiedAt: get.modifiedAt }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8")).boxes_divulgacao,
      { slot1: "", slot2: "", slot3: "" },
    );
  });

  it("guard de mtime: expectedModifiedAt obsoleto -> 409, não sobrescreve", async () => {
    const get = await (await fetch(new URL("/api/boxes/slots", server.url))).json();
    const staleModifiedAt = get.modifiedAt;
    // Simula outra sessão/aba escrevendo por baixo antes deste PUT.
    const configPath = join(root, "platform.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ boxes_divulgacao: { slot1: "recomendacao-leitura.md", slot2: "", slot3: "" } }),
      "utf8",
    );
    const bumped = new Date(new Date(staleModifiedAt).getTime() + 2000);
    utimesSync(configPath, bumped, bumped);

    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot1: "livros-divulgacao.md", slot2: "", slot3: "", expectedModifiedAt: staleModifiedAt }),
    });
    assert.equal(put.status, 409);
    const body = await put.json();
    assert.equal(body.conflict, true);
    assert.deepEqual(
      JSON.parse(readFileSync(configPath, "utf8")).boxes_divulgacao,
      { slot1: "recomendacao-leitura.md", slot2: "", slot3: "" },
      "não deve sobrescrever em conflito",
    );
  });

  it("guard de mtime: force:true sobrescreve mesmo com expectedModifiedAt divergente", async () => {
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot1: "apoio-divulgacao.md",
        slot2: "",
        slot3: "",
        expectedModifiedAt: "2000-01-01T00:00:00.000Z", // deliberadamente obsoleto
        force: true,
      }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8")).boxes_divulgacao,
      { slot1: "apoio-divulgacao.md", slot2: "", slot3: "" },
    );
  });

  it("PUT com corpo não-JSON -> 400", async () => {
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "não é json",
    });
    assert.equal(put.status, 400);
  });

  it("PUT com slot não-string (ex: número) -> 400", async () => {
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot1: 123, slot2: "", slot3: "" }),
    });
    assert.equal(put.status, 400);
  });

  it("fecha o loop com o Arquivar (#3928): liberar o slot aqui desbloqueia POST /archive", async () => {
    // Estado do beforeEach: apoio-divulgacao.md está no slot3 -> archive bloqueia.
    const blocked = await fetch(new URL("/api/boxes/apoio-divulgacao.md/archive", server.url), { method: "POST" });
    assert.equal(blocked.status, 409);

    const get = await (await fetch(new URL("/api/boxes/slots", server.url))).json();
    const freed = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot1: get.slot1, slot2: get.slot2, slot3: "", expectedModifiedAt: get.modifiedAt }),
    });
    assert.equal(freed.status, 200);

    const archived = await fetch(new URL("/api/boxes/apoio-divulgacao.md/archive", server.url), { method: "POST" });
    assert.equal(archived.status, 200);

    // restaura pro fixture não vazar estado pros próximos testes
    await fetch(new URL("/api/boxes/apoio-divulgacao.md/unarchive", server.url), { method: "POST" });
  });
});
