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
import { describe, it, before, beforeEach, after, afterEach } from "node:test";
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
  parseBoxCategoria,
  stripNomeLine,
  buildBoxContentWithNome,
  extractBoxNotas,
  extractBoxConteudo,
  buildBoxContent,
  extractConteudoTitulo,
  replaceBoxContentTitle,
  resolveBoxDisplayName,
  readBoxSlotsState,
  replaceBoxesDivulgacaoBlock,
  saveBoxSlots,
  readParaEncerrarState, // #4274
  replaceParaEncerrarBlock, // #4274
  saveParaEncerrar, // #4274
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

  it("#4290: com slot0 preenchido -> incluído no mapa filename -> slot (0)", () => {
    const slot0Root = mkdtempSync(join(tmpdir(), "studio-boxes-slots-slot0-"));
    writeFileSync(
      join(slot0Root, "platform.config.json"),
      JSON.stringify({
        boxes_divulgacao: { slot0: "z.md", slot1: "a.md", slot2: "b.md", slot3: "c.md" },
      }),
    );
    assert.deepEqual(readBoxSlotAssignments(slot0Root), { "z.md": 0, "a.md": 1, "b.md": 2, "c.md": 3 });
    rmSync(slot0Root, { recursive: true, force: true });
  });

  it("#4290: slot0 null (default de vazio, ver platform.config.json real) -> não entra no mapa", () => {
    const slot0NullRoot = mkdtempSync(join(tmpdir(), "studio-boxes-slots-slot0-null-"));
    writeFileSync(
      join(slot0NullRoot, "platform.config.json"),
      JSON.stringify({
        boxes_divulgacao: { slot0: null, slot1: "a.md", slot2: "b.md", slot3: "c.md" },
      }),
    );
    assert.deepEqual(readBoxSlotAssignments(slot0NullRoot), { "a.md": 1, "b.md": 2, "c.md": 3 });
    rmSync(slot0NullRoot, { recursive: true, force: true });
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

// ─── categoria: rótulo pra newsletter, notas/conteúdo separados (pura, #3979/#3981) ─

describe("parseBoxCategoria (#3981)", () => {
  it("extrai `categoria:` do header de comentário", () => {
    assert.equal(parseBoxCategoria("<!--\ncategoria: Recomendado\ndoc\n-->\n\n# Título"), "Recomendado");
  });
  it("é case-insensitive na chave e trima o valor", () => {
    assert.equal(parseBoxCategoria("<!--\nCategoria:   Achado da semana   \n-->\ntexto"), "Achado da semana");
  });
  it("null quando o header não tem categoria:", () => {
    assert.equal(parseBoxCategoria("<!--\nsó doc, sem categoria\n-->\ntexto"), null);
  });
  it("null quando não há header de comentário", () => {
    assert.equal(parseBoxCategoria("# Título direto\n\ntexto"), null);
  });
  it("ignora `categoria:` que esteja no CORPO, não no header", () => {
    assert.equal(parseBoxCategoria("# Título\n\ncategoria: isso não conta"), null);
  });
  it("nome: e categoria: convivem no mesmo header, sem interferência mútua", () => {
    const content = "<!--\nnome: Rótulo Interno\ncategoria: Recomendado\ndoc\n-->\n\n# T";
    assert.equal(parseBoxNome(content), "Rótulo Interno");
    assert.equal(parseBoxCategoria(content), "Recomendado");
  });
});

describe("extractBoxNotas / extractBoxConteudo (#3979)", () => {
  it("extractBoxNotas: header menos nome:/categoria:, trimado", () => {
    const content = "<!--\nnome: X\ncategoria: Y\nInstruções de uso do snippet.\n-->\n\nConteúdo.";
    assert.equal(extractBoxNotas(content), "Instruções de uso do snippet.");
  });
  it("extractBoxNotas: '' quando o header só tinha nome:/categoria:", () => {
    assert.equal(extractBoxNotas("<!--\nnome: X\ncategoria: Y\n-->\n\nConteúdo."), "");
  });
  it("extractBoxNotas: '' quando não há header", () => {
    assert.equal(extractBoxNotas("Conteúdo sem header."), "");
  });
  it("extractBoxNotas: preserva blocos multi-parágrafo internos do doc", () => {
    const content = "<!--\nnome: X\nParágrafo 1 do doc.\n\nParágrafo 2 do doc.\n-->\n\nConteúdo.";
    assert.equal(extractBoxNotas(content), "Parágrafo 1 do doc.\n\nParágrafo 2 do doc.");
  });
  it("extractBoxConteudo: remove o bloco de comentário INTEIRO (não só uma linha)", () => {
    const content = "<!--\nnome: X\ndoc\n-->\n\n# Título público\n\ncorpo";
    assert.equal(extractBoxConteudo(content), "# Título público\n\ncorpo");
  });
  it("extractBoxConteudo: sem header -> devolve o conteúdo como está", () => {
    assert.equal(extractBoxConteudo("# Só conteúdo"), "# Só conteúdo");
  });
});

// ─── título de conteúdo: campo dedicado (pura, #4079) ─────────────────────

describe("extractConteudoTitulo (#4079)", () => {
  it("heading -> texto sem os '#'", () => {
    assert.equal(extractConteudoTitulo("## Um heading\n\ncorpo"), "Um heading");
  });
  it("texto puro -> a 1ª linha não-vazia", () => {
    assert.equal(extractConteudoTitulo("Olá, leitor!\n\ncorpo"), "Olá, leitor!");
  });
  it("conteúdo vazio/só branco -> '' (NÃO o sentinel '(vazio)' de exibição)", () => {
    assert.equal(extractConteudoTitulo(""), "");
    assert.equal(extractConteudoTitulo("\n\n   \n"), "");
  });
});

describe("replaceBoxContentTitle (#4079)", () => {
  it("heading: reescreve só o TEXTO, preserva o nível (#, ##, etc.)", () => {
    const out = replaceBoxContentTitle("## Título antigo\n\ncorpo preservado", "Título novo");
    assert.equal(out, "## Título novo\n\ncorpo preservado");
  });

  it("heading nível 1 preservado (não vira nível 2 nem vice-versa)", () => {
    assert.equal(replaceBoxContentTitle("# T1\n\ncorpo", "T2"), "# T2\n\ncorpo");
    assert.equal(replaceBoxContentTitle("### T1\n\ncorpo", "T2"), "### T2\n\ncorpo");
  });

  it("texto puro: reescreve a linha inteira como texto puro (nunca vira heading)", () => {
    const out = replaceBoxContentTitle("Título antigo\n\ncorpo preservado", "Título novo");
    assert.equal(out, "Título novo\n\ncorpo preservado");
    assert.ok(!out.startsWith("#"));
  });

  it("preserva o RESTO do corpo intacto, byte a byte, incluindo formatação interna", () => {
    const body = "Título antigo\n\nParágrafo 1.\n\n- item 1\n- item 2\n\n**negrito**";
    const out = replaceBoxContentTitle(body, "Título novo");
    assert.equal(out, "Título novo\n\nParágrafo 1.\n\n- item 1\n- item 2\n\n**negrito**");
  });

  it("preserva linhas em branco ANTES da 1ª linha não-vazia", () => {
    const out = replaceBoxContentTitle("\n\nTítulo antigo\ncorpo", "Novo");
    assert.equal(out, "\n\nNovo\ncorpo");
  });

  it("byte-estável quando o título já é o desejado (heading) — não reescreve nada", () => {
    const body = "##   Título   \n\ncorpo"; // espaçamento não-canônico de propósito
    assert.equal(replaceBoxContentTitle(body, "Título"), body);
  });

  it("byte-estável quando o título já é o desejado (texto puro) — não reescreve nada", () => {
    const body = "Título igual\n\ncorpo";
    assert.equal(replaceBoxContentTitle(body, "Título igual"), body);
  });

  it("titulo vazio/whitespace -> no-op, preserva o conteúdo como está", () => {
    const body = "# Título\n\ncorpo";
    assert.equal(replaceBoxContentTitle(body, ""), body);
    assert.equal(replaceBoxContentTitle(body, "   "), body);
  });

  it("corpo vazio -> cria a 1ª linha do zero, como texto puro", () => {
    assert.equal(replaceBoxContentTitle("", "Título novo"), "Título novo");
  });

  it("corpo só com linhas em branco -> cria a 1ª linha do zero", () => {
    assert.equal(replaceBoxContentTitle("\n\n   \n", "Título novo"), "Título novo");
  });

  it("titulo com espaço nas pontas é trimado antes de comparar/escrever", () => {
    assert.equal(replaceBoxContentTitle("Título\n\ncorpo", "  Título  "), "Título\n\ncorpo"); // sem mudança real -> byte-estável
    assert.equal(replaceBoxContentTitle("Título\n\ncorpo", "  Novo  "), "Novo\n\ncorpo");
  });

  // #4141 finding 1: split(/\r?\n/) + join("\n") normalizava CRLF->LF do
  // ARQUIVO INTEIRO quando o título mudava de fato — o resto do corpo (e até
  // o terminador da própria linha do título) deve sobreviver byte a byte,
  // qualquer que seja o EOL original.
  describe("preservação de EOL (#4141 finding 1)", () => {
    it("corpo 100% CRLF: só o TEXTO da 1ª linha muda, todo \\r\\n sobrevive", () => {
      const body = "## Título antigo\r\n\r\ncorpo preservado\r\n- item 1\r\n- item 2";
      const out = replaceBoxContentTitle(body, "Título novo");
      assert.equal(out, "## Título novo\r\n\r\ncorpo preservado\r\n- item 1\r\n- item 2");
    });

    it("corpo 100% CRLF, texto puro: idem, sem introduzir LF nenhum", () => {
      const body = "Título antigo\r\n\r\ncorpo preservado\r\n";
      const out = replaceBoxContentTitle(body, "Título novo");
      assert.equal(out, "Título novo\r\n\r\ncorpo preservado\r\n");
      // toda ocorrência de "\n" no output está imediatamente precedida de "\r"
      // (nenhum LF solto foi introduzido pela reescrita)
      assert.ok([...out.matchAll(/\n/g)].every((m) => out[m.index! - 1] === "\r"));
    });

    it("corpo 100% LF: comportamento inalterado (regressão)", () => {
      const body = "## Título antigo\n\ncorpo preservado\n- item 1\n- item 2";
      const out = replaceBoxContentTitle(body, "Título novo");
      assert.equal(out, "## Título novo\n\ncorpo preservado\n- item 1\n- item 2");
      assert.ok(!out.includes("\r"));
    });

    it("corpo MISTO (1ª linha CRLF, resto LF): cada linha preserva o PRÓPRIO EOL", () => {
      const body = "## Título antigo\r\n\ncorpo em LF\ndemais linhas em LF\n";
      const out = replaceBoxContentTitle(body, "Título novo");
      assert.equal(out, "## Título novo\r\n\ncorpo em LF\ndemais linhas em LF\n");
    });

    it("corpo MISTO (1ª linha LF, resto CRLF): a linha do título fica LF, o resto continua CRLF", () => {
      const body = "Título antigo\n\r\ncorpo em CRLF\r\ndemais linhas em CRLF\r\n";
      const out = replaceBoxContentTitle(body, "Novo");
      assert.equal(out, "Novo\n\r\ncorpo em CRLF\r\ndemais linhas em CRLF\r\n");
    });

    it("byte-estável em CRLF quando o título já é o desejado — não normaliza nada", () => {
      const body = "##   Título   \r\n\r\ncorpo\r\n";
      assert.equal(replaceBoxContentTitle(body, "Título"), body);
    });
  });
});

describe("buildBoxContent (#3979/#3981)", () => {
  it("monta header com nome + categoria + notas, nessa ordem, + conteúdo", () => {
    const out = buildBoxContent(
      { nome: "Rótulo", categoria: "Recomendado", notas: "Doc interno." },
      "# Título\n\ncorpo",
    );
    assert.equal(out, "<!--\nnome: Rótulo\ncategoria: Recomendado\nDoc interno.\n-->\n\n# Título\n\ncorpo");
  });
  it("campos vazios/whitespace são omitidos (sem linha órfã 'nome: ' ou 'categoria: ')", () => {
    const out = buildBoxContent({ nome: "", categoria: "   ", notas: "Só notas." }, "corpo");
    assert.ok(!/nome:/i.test(out));
    assert.ok(!/categoria:/i.test(out));
    assert.equal(out, "<!--\nSó notas.\n-->\n\ncorpo");
  });
  it("nome/categoria/notas todos vazios -> sem comentário no topo (conteúdo puro)", () => {
    assert.equal(buildBoxContent({ nome: "", categoria: "", notas: "" }, "# Só conteúdo"), "# Só conteúdo");
    assert.equal(buildBoxContent({}, "# Só conteúdo"), "# Só conteúdo");
  });
  it("só categoria (sem nome/notas): header com 1 linha só", () => {
    const out = buildBoxContent({ categoria: "Achado da semana" }, "corpo");
    assert.equal(out, "<!--\ncategoria: Achado da semana\n-->\n\ncorpo");
  });
  it("categoria com espaço nas pontas é trimada na reconstrução", () => {
    const out = buildBoxContent({ categoria: "  Recomendado  " }, "corpo");
    assert.match(out, /categoria: Recomendado\n/);
  });
  it("round-trip: build(parse(x)) === x quando o arquivo segue a convenção canônica (header + 1 linha em branco + conteúdo)", () => {
    // #3979: risco explícito do PR — recompor precisa ser BYTE-ESTÁVEL quando
    // nada muda (context/snippets/*.md entra no prompt cache, CLAUDE.md
    // "Otimização de tokens" — diff fantasma invalida o cache à toa).
    const x =
      "<!--\nnome: Rótulo Interno\ncategoria: Recomendado\nInstruções de uso.\nMais uma linha de doc.\n-->\n\n" +
      "**Título na edição**\n\ncorpo\nmais corpo\n";
    const rebuilt = buildBoxContent(
      { nome: parseBoxNome(x), categoria: parseBoxCategoria(x), notas: extractBoxNotas(x) },
      extractBoxConteudo(x),
    );
    assert.equal(rebuilt, x);
  });
  it("round-trip byte-estável contra o formato REAL de context/snippets/apoio-divulgacao.md (regressão do formato canônico)", () => {
    // Fixture inline reproduzindo a FORMA real (header multi-parágrafo, 1
    // linha em branco antes do conteúdo) sem depender do conteúdo editorial
    // de verdade do repo (que pode mudar) nem escrever no arquivo real.
    const x =
      "<!--\nBloco canônico de DIVULGAÇÃO do programa de apoio (apoia.se/diaria).\n\n" +
      "Parágrafo 2 do doc, com **markdown** dentro do comentário (nunca renderiza).\n-->\n\n" +
      "Apoie a diar.ia.br\n\nTexto do corpo.\n\n[Quero apoiar](https://apoia.se/diaria)\n";
    const rebuilt = buildBoxContent(
      { nome: parseBoxNome(x), categoria: parseBoxCategoria(x), notas: extractBoxNotas(x) },
      extractBoxConteudo(x),
    );
    assert.equal(rebuilt, x);
  });
  it("round-trip: sem header nenhum no original", () => {
    const x = "# Título direto\n\ncorpo, sem comentário no topo.\n";
    const rebuilt = buildBoxContent(
      { nome: parseBoxNome(x), categoria: parseBoxCategoria(x), notas: extractBoxNotas(x) },
      extractBoxConteudo(x),
    );
    assert.equal(rebuilt, x);
  });
  it("INVARIANTE: nome/categoria nunca sobrevivem ao strip de comentário do render (snippet-loader.ts)", () => {
    const built = buildBoxContent({ nome: "SEGREDO", categoria: "Rótulo Interno de Teste" }, "# Público\n\ncorpo visível");
    const rendered = built.replace(/<!--[\s\S]*?-->/g, "").trim();
    assert.ok(!rendered.includes("SEGREDO"));
    assert.ok(!rendered.includes("Rótulo Interno de Teste"));
    assert.match(rendered, /# Público/);
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
      '    "slot0": null,',
      '    "slot1": "recomendacao-leitura.md",',
      '    "slot2": "livros-divulgacao.md",',
      '    "slot3": "apoio-divulgacao.md"',
      "  },",
      '  "drive_sync": false',
      "}",
    ].join("\n");

    const out = replaceBoxesDivulgacaoBlock(raw, {
      slot0: "",
      slot1: "outra.md",
      slot2: "",
      slot3: "apoio-divulgacao.md",
    });

    // As chaves ANTES e DEPOIS do bloco reescrito ficam byte-a-byte intactas.
    assert.ok(out.startsWith('{\n  "newsletter": "beehiiv",\n  "socials": [\n    "linkedin",\n    "facebook"\n  ],\n'));
    assert.ok(out.endsWith('\n  "drive_sync": false\n}'));
    // O bloco em si reflete os novos valores.
    assert.match(out, /"slot0": ""/);
    assert.match(out, /"slot1": "outra\.md"/);
    assert.match(out, /"slot2": ""/);
    assert.match(out, /"slot3": "apoio-divulgacao\.md"/);
    // JSON continua válido e as outras chaves sobrevivem semanticamente.
    const parsed = JSON.parse(out);
    assert.equal(parsed.newsletter, "beehiiv");
    assert.deepEqual(parsed.socials, ["linkedin", "facebook"]);
    assert.equal(parsed.drive_sync, false);
    assert.deepEqual(parsed.boxes_divulgacao, { slot0: "", slot1: "outra.md", slot2: "", slot3: "apoio-divulgacao.md" });
  });

  it("#4290: slot0 preenchido também é gravado no bloco", () => {
    const raw = '{\n  "boxes_divulgacao": {\n    "slot0": null,\n    "slot1": "",\n    "slot2": "",\n    "slot3": ""\n  }\n}';
    const out = replaceBoxesDivulgacaoBlock(raw, { slot0: "intro-box.md", slot1: "", slot2: "", slot3: "" });
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.boxes_divulgacao, { slot0: "intro-box.md", slot1: "", slot2: "", slot3: "" });
  });

  it("byte-a-byte contra o platform.config.json REAL do repo (regressão do formato canônico)", () => {
    const raw = readFileSync(resolvePlatformConfigPath(), "utf8");
    const out = replaceBoxesDivulgacaoBlock(raw, { slot0: "", slot1: "x.md", slot2: "y.md", slot3: "" });
    // Só a região do bloco boxes_divulgacao muda — tudo antes e depois idêntico.
    const blockStart = raw.indexOf('"boxes_divulgacao"');
    assert.ok(blockStart > 0, "fixture do repo precisa ter boxes_divulgacao");
    assert.equal(out.slice(0, blockStart), raw.slice(0, blockStart));
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.boxes_divulgacao, { slot0: "", slot1: "x.md", slot2: "y.md", slot3: "" });
  });

  it("insere o bloco (defensivo) quando boxes_divulgacao ainda não existe no arquivo", () => {
    const raw = '{\n  "newsletter": "beehiiv"\n}';
    const out = replaceBoxesDivulgacaoBlock(raw, { slot0: "", slot1: "a.md", slot2: "", slot3: "" });
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.boxes_divulgacao, { slot0: "", slot1: "a.md", slot2: "", slot3: "" });
    assert.equal(parsed.newsletter, "beehiiv");
  });

  it("lança em vez de escrever algo potencialmente corrompido quando não há ponto de inserção seguro", () => {
    assert.throws(() =>
      replaceBoxesDivulgacaoBlock("não é json de jeito nenhum", { slot0: "", slot1: "", slot2: "", slot3: "" }),
    );
  });
});

describe("readBoxSlotsState (#3937, pure; slot0 #4290)", () => {
  it("sem platform.config.json -> slots vazios, modifiedAt:null", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-slotsstate-none-"));
    assert.deepEqual(readBoxSlotsState(root), { slot0: "", slot1: "", slot2: "", slot3: "", modifiedAt: null });
    rmSync(root, { recursive: true, force: true });
  });

  it("com boxes_divulgacao -> forma direta slot->filename + modifiedAt (slot0 incluído)", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-slotsstate-"));
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ boxes_divulgacao: { slot0: "z.md", slot1: "a.md", slot2: "b.md", slot3: "c.md" } }),
    );
    const state = readBoxSlotsState(root);
    assert.equal(state.slot0, "z.md");
    assert.equal(state.slot1, "a.md");
    assert.equal(state.slot2, "b.md");
    assert.equal(state.slot3, "c.md");
    assert.ok(state.modifiedAt);
    rmSync(root, { recursive: true, force: true });
  });

  it("#4290: slot0 null (default de vazio) -> lido como string vazia, não null", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-slotsstate-slot0-null-"));
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ boxes_divulgacao: { slot0: null, slot1: "a.md", slot2: "b.md", slot3: "c.md" } }),
    );
    const state = readBoxSlotsState(root);
    assert.equal(state.slot0, "");
    rmSync(root, { recursive: true, force: true });
  });

  it("JSON corrompido -> slots vazios mas modifiedAt real (fail-soft, nunca lança)", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-slotsstate-corrupt-"));
    writeFileSync(join(root, "platform.config.json"), "{ not json");
    const state = readBoxSlotsState(root);
    assert.deepEqual(
      { slot0: state.slot0, slot1: state.slot1, slot2: state.slot2, slot3: state.slot3 },
      { slot0: "", slot1: "", slot2: "", slot3: "" },
    );
    assert.ok(state.modifiedAt);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("saveBoxSlots (#3937, pure; slot0 #4290)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-saveslots-"));
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "a.md"), "# A");
    writeFileSync(join(root, "context", "snippets", "b.md"), "# B");
    writeFileSync(join(root, "context", "snippets", "c.md"), "# C");
    writeFileSync(join(root, "context", "snippets", "z.md"), "# Z");
    mkdirSync(join(root, "context", "snippets", "_arquivo"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "_arquivo", "arquivada.md"), "# Arquivada");
  });

  beforeEach(() => {
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify(
        {
          newsletter: "beehiiv",
          boxes_divulgacao: { slot0: null, slot1: "a.md", slot2: "b.md", slot3: "c.md" },
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
    const result = saveBoxSlots(root, { slot0: "", slot1: "b.md", slot2: "a.md", slot3: "" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.slots, { slot0: "", slot1: "b.md", slot2: "a.md", slot3: "", modifiedAt: result.modifiedAt });
  });

  it("#4290: happy path incluindo slot0 preenchido", () => {
    const result = saveBoxSlots(root, { slot0: "z.md", slot1: "b.md", slot2: "a.md", slot3: "" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.slots, {
      slot0: "z.md",
      slot1: "b.md",
      slot2: "a.md",
      slot3: "",
      modifiedAt: result.modifiedAt,
    });
  });

  it("preserva as outras chaves do platform.config.json byte-a-byte, só boxes_divulgacao muda", () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const result = saveBoxSlots(root, { slot0: "", slot1: "c.md", slot2: "", slot3: "a.md" });
    assert.equal(result.ok, true);
    const after = readFileSync(join(root, "platform.config.json"), "utf8");
    const blockStart = before.indexOf('"boxes_divulgacao"');
    assert.equal(after.slice(0, blockStart), before.slice(0, blockStart), "conteúdo ANTES do bloco deve ser idêntico");
    const parsedBefore = JSON.parse(before);
    const parsedAfter = JSON.parse(after);
    assert.equal(parsedAfter.newsletter, parsedBefore.newsletter);
    assert.equal(parsedAfter.drive_sync, parsedBefore.drive_sync);
    assert.deepEqual(parsedAfter.boxes_divulgacao, { slot0: "", slot1: "c.md", slot2: "", slot3: "a.md" });
  });

  it("aceita '(vazio)' — string vazia em qualquer slot, incluindo slot0", () => {
    const result = saveBoxSlots(root, { slot0: "", slot1: "", slot2: "", slot3: "" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.slots, { slot0: "", slot1: "", slot2: "", slot3: "", modifiedAt: result.modifiedAt });
  });

  it("guard 1: rejeita caixa INEXISTENTE, não escreve", () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const result = saveBoxSlots(root, { slot0: "", slot1: "nao-existe.md", slot2: "", slot3: "" });
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.equal(readFileSync(join(root, "platform.config.json"), "utf8"), before, "não deve escrever em atribuição inválida");
  });

  it("guard 1: rejeita caixa ARQUIVADA, não escreve", () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const result = saveBoxSlots(root, { slot0: "", slot1: "arquivada.md", slot2: "", slot3: "" });
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.equal(readFileSync(join(root, "platform.config.json"), "utf8"), before);
  });

  it("guard 1: também vale pro slot0 — caixa INEXISTENTE nesse slot é rejeitada, não escreve", () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const result = saveBoxSlots(root, { slot0: "nao-existe.md", slot1: "a.md", slot2: "b.md", slot3: "c.md" });
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.match(result.error ?? "", /slot0/);
    assert.equal(readFileSync(join(root, "platform.config.json"), "utf8"), before);
  });

  it("guard 2: rejeita a MESMA caixa em 2 slots, não escreve", () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const result = saveBoxSlots(root, { slot0: "", slot1: "a.md", slot2: "a.md", slot3: "" });
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.match(result.error ?? "", /a\.md/);
    assert.equal(readFileSync(join(root, "platform.config.json"), "utf8"), before);
  });

  it("guard 2: também vale pro slot0 — mesma caixa em slot0 E slot1 é rejeitada", () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const result = saveBoxSlots(root, { slot0: "a.md", slot1: "a.md", slot2: "b.md", slot3: "c.md" });
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.match(result.error ?? "", /a\.md/);
    assert.equal(readFileSync(join(root, "platform.config.json"), "utf8"), before);
  });

  it("guard 4 (mtime): expectedModifiedAt divergente -> conflict:true, NÃO sobrescreve", () => {
    const configPath = join(root, "platform.config.json");
    const staleModifiedAt = statSync(configPath).mtime.toISOString();
    writeFileSync(
      configPath,
      JSON.stringify({ boxes_divulgacao: { slot0: null, slot1: "a.md", slot2: "b.md", slot3: "c.md" } }),
      "utf8",
    );
    const bumped = new Date(new Date(staleModifiedAt).getTime() + 2000);
    utimesSync(configPath, bumped, bumped);

    const result = saveBoxSlots(
      root,
      { slot0: "", slot1: "b.md", slot2: "", slot3: "" },
      { expectedModifiedAt: staleModifiedAt },
    );
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.ok(result.currentModifiedAt);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(
      onDisk.boxes_divulgacao,
      { slot0: null, slot1: "a.md", slot2: "b.md", slot3: "c.md" },
      "não deve sobrescrever em conflito",
    );
  });

  it("guard 4: force:true sobrescreve mesmo com expectedModifiedAt divergente", () => {
    const configPath = join(root, "platform.config.json");
    const staleModifiedAt = statSync(configPath).mtime.toISOString();
    const bumped = new Date(new Date(staleModifiedAt).getTime() + 2000);
    utimesSync(configPath, bumped, bumped);

    const result = saveBoxSlots(
      root,
      { slot0: "", slot1: "c.md", slot2: "", slot3: "" },
      { expectedModifiedAt: staleModifiedAt, force: true },
    );
    assert.equal(result.ok, true);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(onDisk.boxes_divulgacao, { slot0: "", slot1: "c.md", slot2: "", slot3: "" });
  });

  it("sem expectedModifiedAt no corpo pula a checagem de conflito", () => {
    const result = saveBoxSlots(root, { slot0: "", slot1: "a.md", slot2: "b.md", slot3: "c.md" });
    assert.equal(result.ok, true);
    assert.equal(result.conflict, undefined);
  });

  it("platform.config.json ausente -> ok:false, sem lançar", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "studio-boxes-saveslots-noconfig-"));
    const result = saveBoxSlots(emptyRoot, { slot0: "", slot1: "", slot2: "", slot3: "" });
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
    const freed = saveBoxSlots(root, { slot0: "", slot1: "a.md", slot2: "", slot3: "c.md" });
    assert.equal(freed.ok, true);

    // ...agora archiveBox segue normalmente.
    const archived = archiveBox(root, "b.md");
    assert.equal(archived.ok, true);
    assert.equal(existsSync(archivedBoxFilePath(root, "b.md")), true);

    // Restaura pro estado original do fixture, pra não vazar pros próximos testes.
    unarchiveBox(root, "b.md");
  });

  // #4290: mesmo loop do teste acima, mas liberando o slot0 (introdução).
  it("fecha o loop com archiveBox: liberar o slot0 aqui desbloqueia o arquivamento (#4290)", () => {
    const assigned = saveBoxSlots(root, { slot0: "z.md", slot1: "a.md", slot2: "b.md", slot3: "c.md" });
    assert.equal(assigned.ok, true);

    const blocked = archiveBox(root, "z.md");
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blockedBySlot, true);
    assert.equal(blocked.slot, 0);

    const freed = saveBoxSlots(root, { slot0: "", slot1: "a.md", slot2: "b.md", slot3: "c.md" });
    assert.equal(freed.ok, true);

    const archived = archiveBox(root, "z.md");
    assert.equal(archived.ok, true);
    assert.equal(existsSync(archivedBoxFilePath(root, "z.md")), true);

    unarchiveBox(root, "z.md");
  });
});

// ─── Variante Patronos: chave irmã boxes_divulgacao_patronos (#4275) ───────

describe("replaceBoxesDivulgacaoBlock com configKey=boxes_divulgacao_patronos (#4275, pure)", () => {
  it("reescreve boxes_divulgacao_patronos, preservando boxes_divulgacao e o resto do arquivo byte-a-byte", () => {
    const raw = [
      "{",
      '  "newsletter": "beehiiv",',
      '  "boxes_divulgacao": {',
      '    "slot0": null,',
      '    "slot1": "historia.md",',
      '    "slot2": "artigo.md",',
      '    "slot3": "clarice.md"',
      "  },",
      '  "boxes_divulgacao_patronos": {',
      '    "slot0": null,',
      '    "slot1": "patronos-bastidores.md",',
      '    "slot2": "patronos-acesso.md",',
      '    "slot3": "patronos-agradecimento.md"',
      "  },",
      '  "drive_sync": false',
      "}",
    ].join("\n");

    const out = replaceBoxesDivulgacaoBlock(
      raw,
      { slot0: "", slot1: "outra-patronos.md", slot2: "", slot3: "patronos-agradecimento.md" },
      "boxes_divulgacao_patronos",
    );

    const parsed = JSON.parse(out);
    // boxes_divulgacao (variante Padrão) sai INTOCADO — só a chave irmã muda.
    assert.deepEqual(parsed.boxes_divulgacao, {
      slot0: null,
      slot1: "historia.md",
      slot2: "artigo.md",
      slot3: "clarice.md",
    });
    assert.deepEqual(parsed.boxes_divulgacao_patronos, {
      slot0: "",
      slot1: "outra-patronos.md",
      slot2: "",
      slot3: "patronos-agradecimento.md",
    });
    assert.equal(parsed.newsletter, "beehiiv");
    assert.equal(parsed.drive_sync, false);
  });

  it("insere o bloco boxes_divulgacao_patronos (defensivo) quando ainda não existe no arquivo", () => {
    const raw = '{\n  "newsletter": "beehiiv",\n  "boxes_divulgacao": {\n    "slot0": null,\n    "slot1": "a.md",\n    "slot2": "",\n    "slot3": ""\n  }\n}';
    const out = replaceBoxesDivulgacaoBlock(
      raw,
      { slot0: "", slot1: "patronos-a.md", slot2: "", slot3: "" },
      "boxes_divulgacao_patronos",
    );
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.boxes_divulgacao_patronos, { slot0: "", slot1: "patronos-a.md", slot2: "", slot3: "" });
    // boxes_divulgacao original preservado.
    assert.deepEqual(parsed.boxes_divulgacao, { slot0: null, slot1: "a.md", slot2: "", slot3: "" });
  });

  it("default (sem 3º argumento) segue reescrevendo boxes_divulgacao — comportamento pré-#4275 intacto", () => {
    const raw = '{\n  "boxes_divulgacao": {\n    "slot0": null,\n    "slot1": "",\n    "slot2": "",\n    "slot3": ""\n  }\n}';
    const out = replaceBoxesDivulgacaoBlock(raw, { slot0: "x.md", slot1: "", slot2: "", slot3: "" });
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.boxes_divulgacao, { slot0: "x.md", slot1: "", slot2: "", slot3: "" });
    assert.equal(parsed.boxes_divulgacao_patronos, undefined);
  });
});

describe("readBoxSlotAssignments / readBoxSlotsState / saveBoxSlots com variant=patronos (#4275, pure)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-patronos-variant-"));
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "a.md"), "# A");
    writeFileSync(join(root, "context", "snippets", "b.md"), "# B");
  });

  beforeEach(() => {
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify(
        {
          boxes_divulgacao: { slot0: null, slot1: "a.md", slot2: null, slot3: null },
          boxes_divulgacao_patronos: { slot0: null, slot1: "b.md", slot2: null, slot3: null },
        },
        null,
        2,
      ) + "\n",
    );
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("readBoxSlotAssignments(root, 'patronos') inverte boxes_divulgacao_patronos, não boxes_divulgacao", () => {
    assert.deepEqual(readBoxSlotAssignments(root, "patronos"), { "b.md": 1 });
    // default (sem variant) continua lendo boxes_divulgacao.
    assert.deepEqual(readBoxSlotAssignments(root), { "a.md": 1 });
  });

  it("readBoxSlotsState(root, 'patronos') lê boxes_divulgacao_patronos", () => {
    const state = readBoxSlotsState(root, "patronos");
    assert.equal(state.slot1, "b.md");
    // default continua lendo boxes_divulgacao (valor diferente no fixture).
    assert.equal(readBoxSlotsState(root).slot1, "a.md");
  });

  it("saveBoxSlots com variant:'patronos' escreve SÓ boxes_divulgacao_patronos", () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const result = saveBoxSlots(root, { slot0: "", slot1: "a.md", slot2: "b.md", slot3: "" }, { variant: "patronos" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.slots, { slot0: "", slot1: "a.md", slot2: "b.md", slot3: "", modifiedAt: result.modifiedAt });

    const after = readFileSync(join(root, "platform.config.json"), "utf8");
    const parsedBefore = JSON.parse(before);
    const parsedAfter = JSON.parse(after);
    // boxes_divulgacao (Padrão) NÃO foi tocado pelo save da variante Patronos.
    assert.deepEqual(parsedAfter.boxes_divulgacao, parsedBefore.boxes_divulgacao);
    assert.deepEqual(parsedAfter.boxes_divulgacao_patronos, { slot0: "", slot1: "a.md", slot2: "b.md", slot3: "" });
  });

  it("guard 1 (caixa inexistente) e guard 2 (duplicata) valem igualmente pra variant:'patronos'", () => {
    const missing = saveBoxSlots(root, { slot0: "", slot1: "nao-existe.md", slot2: "", slot3: "" }, { variant: "patronos" });
    assert.equal(missing.ok, false);
    assert.equal(missing.invalid, true);

    const dupe = saveBoxSlots(root, { slot0: "a.md", slot1: "a.md", slot2: "", slot3: "" }, { variant: "patronos" });
    assert.equal(dupe.ok, false);
    assert.equal(dupe.invalid, true);
  });

  it("archiveBox bloqueia uma caixa em uso na variante Patronos, mesmo livre na variante Padrão", () => {
    // No estado do beforeEach: "a.md" está no slot1 PADRÃO, "b.md" está no
    // slot1 PATRONOS — nenhum dos dois está livre em AMBAS as variantes.
    const blockedDefault = archiveBox(root, "a.md");
    assert.equal(blockedDefault.ok, false);
    assert.equal(blockedDefault.blockedBySlot, true);

    const blockedPatronos = archiveBox(root, "b.md");
    assert.equal(blockedPatronos.ok, false);
    assert.equal(blockedPatronos.blockedBySlot, true);
    assert.equal(blockedPatronos.slot, 1);
  });
});

describe("listBoxes expõe slotPatronos separado de slot (#4275)", () => {
  it("uma caixa em slots DIFERENTES por variante mostra os dois valores; sem atribuição patronos -> null", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-listboxes-patronos-"));
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "a.md"), "# A");
    writeFileSync(join(root, "context", "snippets", "b.md"), "# B");
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({
        boxes_divulgacao: { slot0: null, slot1: "a.md", slot2: null, slot3: null },
        boxes_divulgacao_patronos: { slot0: null, slot1: null, slot2: "a.md", slot3: null },
      }),
    );

    const list = listBoxes(root);
    const a = list.find((b) => b.slug === "a.md");
    const b = list.find((b) => b.slug === "b.md");
    assert.equal(a?.slot, 1);
    assert.equal(a?.slotPatronos, 2);
    assert.equal(b?.slot, null);
    assert.equal(b?.slotPatronos, null);

    rmSync(root, { recursive: true, force: true });
  });
});

// ─── PARA ENCERRAR: slots A/B de texto direto (pura, #4274) ────────────────

describe("replaceParaEncerrarBlock (#4274, pure)", () => {
  it("reescreve só o bloco para_encerrar, preservando o resto byte-a-byte", () => {
    const raw = [
      "{",
      '  "newsletter": "beehiiv",',
      '  "boxes_divulgacao": {',
      '    "slot1": "recomendacao-leitura.md"',
      "  },",
      '  "para_encerrar": {',
      '    "slot_a": "texto A antigo",',
      '    "slot_b": "texto B antigo"',
      "  },",
      '  "drive_sync": false',
      "}",
    ].join("\n");

    const out = replaceParaEncerrarBlock(raw, { slotA: "novo texto A", slotB: "novo texto B" });

    assert.ok(out.startsWith('{\n  "newsletter": "beehiiv",\n  "boxes_divulgacao": {\n    "slot1": "recomendacao-leitura.md"\n  },\n'));
    assert.ok(out.endsWith('\n  "drive_sync": false\n}'));
    assert.match(out, /"slot_a": "novo texto A"/);
    assert.match(out, /"slot_b": "novo texto B"/);
    const parsed = JSON.parse(out);
    assert.equal(parsed.newsletter, "beehiiv");
    assert.deepEqual(parsed.boxes_divulgacao, { slot1: "recomendacao-leitura.md" });
    assert.equal(parsed.drive_sync, false);
    assert.deepEqual(parsed.para_encerrar, { slot_a: "novo texto A", slot_b: "novo texto B" });
  });

  it("preserva newlines internas (\\n) do texto multi-parágrafo — JSON.stringify escapa corretamente", () => {
    const raw = '{\n  "para_encerrar": {\n    "slot_a": "a",\n    "slot_b": "b"\n  }\n}';
    const out = replaceParaEncerrarBlock(raw, { slotA: "parágrafo 1\n\nparágrafo 2", slotB: "b" });
    const parsed = JSON.parse(out);
    assert.equal(parsed.para_encerrar.slot_a, "parágrafo 1\n\nparágrafo 2");
  });

  it("byte-a-byte contra o platform.config.json REAL do repo (regressão do formato canônico)", () => {
    const raw = readFileSync(resolvePlatformConfigPath(), "utf8");
    const out = replaceParaEncerrarBlock(raw, { slotA: "x", slotB: "y" });
    const blockStart = raw.indexOf('"para_encerrar"');
    assert.ok(blockStart > 0, "fixture do repo precisa ter para_encerrar (#4274 já populou)");
    assert.equal(out.slice(0, blockStart), raw.slice(0, blockStart));
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.para_encerrar, { slot_a: "x", slot_b: "y" });
  });

  it("insere o bloco (defensivo) quando para_encerrar ainda não existe no arquivo", () => {
    const raw = '{\n  "newsletter": "beehiiv"\n}';
    const out = replaceParaEncerrarBlock(raw, { slotA: "a", slotB: "b" });
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.para_encerrar, { slot_a: "a", slot_b: "b" });
    assert.equal(parsed.newsletter, "beehiiv");
  });

  it("lança em vez de escrever algo potencialmente corrompido quando não há ponto de inserção seguro", () => {
    assert.throws(() => replaceParaEncerrarBlock("não é json de jeito nenhum", { slotA: "", slotB: "" }));
  });
});

describe("readParaEncerrarState (#4274, pure)", () => {
  it("sem platform.config.json -> slots vazios, modifiedAt:null", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-paraencerrarstate-none-"));
    assert.deepEqual(readParaEncerrarState(root), { slotA: "", slotB: "", modifiedAt: null });
    rmSync(root, { recursive: true, force: true });
  });

  it("com para_encerrar -> devolve slotA/slotB crus + modifiedAt", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-paraencerrarstate-"));
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ para_encerrar: { slot_a: "texto A", slot_b: "texto B" } }),
    );
    const state = readParaEncerrarState(root);
    assert.equal(state.slotA, "texto A");
    assert.equal(state.slotB, "texto B");
    assert.ok(state.modifiedAt);
    rmSync(root, { recursive: true, force: true });
  });

  it("chave para_encerrar ausente (config anterior ao #4274) -> slots vazios, modifiedAt real", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-paraencerrarstate-legacy-"));
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ newsletter: "beehiiv" }));
    const state = readParaEncerrarState(root);
    assert.equal(state.slotA, "");
    assert.equal(state.slotB, "");
    assert.ok(state.modifiedAt);
    rmSync(root, { recursive: true, force: true });
  });

  it("JSON corrompido -> slots vazios mas modifiedAt real (fail-soft, nunca lança)", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-paraencerrarstate-corrupt-"));
    writeFileSync(join(root, "platform.config.json"), "{ not json");
    const state = readParaEncerrarState(root);
    assert.equal(state.slotA, "");
    assert.equal(state.slotB, "");
    assert.ok(state.modifiedAt);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("saveParaEncerrar (#4274, pure)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-saveparaencerrar-"));
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify(
        {
          newsletter: "beehiiv",
          para_encerrar: { slot_a: "A original", slot_b: "B original" },
          drive_sync: false,
        },
        null,
        2,
      ) + "\n",
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("happy path: reescreve e devolve o novo estado + modifiedAt", () => {
    const result = saveParaEncerrar(root, { slotA: "A novo", slotB: "B novo" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.state, { slotA: "A novo", slotB: "B novo", modifiedAt: result.modifiedAt });
  });

  it("trima espaço em branco nas bordas", () => {
    const result = saveParaEncerrar(root, { slotA: "  com espaço  ", slotB: "b" });
    assert.equal(result.ok, true);
    assert.equal(result.state?.slotA, "com espaço");
  });

  it("valor vazio pós-trim vira '' no disco (cai no default do snippet no próximo build, #4274)", () => {
    const result = saveParaEncerrar(root, { slotA: "   ", slotB: "b" });
    assert.equal(result.ok, true);
    assert.equal(result.state?.slotA, "");
  });

  it("preserva as outras chaves do platform.config.json byte-a-byte, só para_encerrar muda", () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const result = saveParaEncerrar(root, { slotA: "novo", slotB: "novo2" });
    assert.equal(result.ok, true);
    const after = readFileSync(join(root, "platform.config.json"), "utf8");
    const blockStart = before.indexOf('"para_encerrar"');
    assert.equal(after.slice(0, blockStart), before.slice(0, blockStart), "conteúdo ANTES do bloco deve ser idêntico");
    const parsedAfter = JSON.parse(after);
    assert.equal(parsedAfter.newsletter, "beehiiv");
    assert.equal(parsedAfter.drive_sync, false);
    assert.deepEqual(parsedAfter.para_encerrar, { slot_a: "novo", slot_b: "novo2" });
  });

  it("guard de mtime: expectedModifiedAt divergente -> conflict:true, NÃO sobrescreve", () => {
    const configPath = join(root, "platform.config.json");
    const staleModifiedAt = statSync(configPath).mtime.toISOString();
    writeFileSync(
      configPath,
      JSON.stringify({ para_encerrar: { slot_a: "A concorrente", slot_b: "B concorrente" } }),
      "utf8",
    );
    const bumped = new Date(new Date(staleModifiedAt).getTime() + 2000);
    utimesSync(configPath, bumped, bumped);

    const result = saveParaEncerrar(root, { slotA: "A tentativa", slotB: "B tentativa" }, { expectedModifiedAt: staleModifiedAt });
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.ok(result.currentModifiedAt);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(onDisk.para_encerrar, { slot_a: "A concorrente", slot_b: "B concorrente" }, "não deve sobrescrever em conflito");
  });

  it("guard de mtime: force:true sobrescreve mesmo com expectedModifiedAt divergente", () => {
    const configPath = join(root, "platform.config.json");
    const staleModifiedAt = statSync(configPath).mtime.toISOString();
    const bumped = new Date(new Date(staleModifiedAt).getTime() + 2000);
    utimesSync(configPath, bumped, bumped);

    const result = saveParaEncerrar(root, { slotA: "forçado", slotB: "forçado2" }, { expectedModifiedAt: staleModifiedAt, force: true });
    assert.equal(result.ok, true);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(onDisk.para_encerrar, { slot_a: "forçado", slot_b: "forçado2" });
  });

  it("sem expectedModifiedAt no corpo pula a checagem de conflito", () => {
    const result = saveParaEncerrar(root, { slotA: "a", slotB: "b" });
    assert.equal(result.ok, true);
    assert.equal(result.conflict, undefined);
  });

  it("platform.config.json ausente -> ok:false, sem lançar", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "studio-boxes-saveparaencerrar-noconfig-"));
    const result = saveParaEncerrar(emptyRoot, { slotA: "", slotB: "" });
    assert.equal(result.ok, false);
    rmSync(emptyRoot, { recursive: true, force: true });
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

// ─── contrato HTTP: notas/conteúdo separados + categoria (#3979/#3981) ────

describe("categoria + notas/conteúdo via HTTP: GET conteudo/notas/categoria, PUT {nome,categoria,notas,conteudo}, POST com categoria (#3979/#3981)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-3979-http-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "README.md"), "# Formato\n\nDoc.");
    writeFileSync(
      join(root, "context", "snippets", "com-header.md"),
      "<!--\nnome: Rótulo Interno\ncategoria: Recomendado\nInstruções de uso do snippet.\n-->\n\n**Título na edição**\n\ncorpo",
    );
    writeFileSync(join(root, "context", "snippets", "sem-header.md"), "# Título derivado\n\ncorpo");
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ boxes_divulgacao: {} }));
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /api/boxes lista com categoria (#3981)", async () => {
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    const comHeader = list.boxes.find((b: { slug: string }) => b.slug === "com-header.md");
    assert.equal(comHeader.categoria, "Recomendado");
    const semHeader = list.boxes.find((b: { slug: string }) => b.slug === "sem-header.md");
    assert.equal(semHeader.categoria, null);
  });

  it("GET /api/boxes/:slug devolve categoria + notas (sem nome:/categoria:) + conteudo (sem header nenhum)", async () => {
    const res = await fetch(new URL("/api/boxes/com-header.md", server.url));
    const body = await res.json();
    assert.equal(body.nome, "Rótulo Interno");
    assert.equal(body.categoria, "Recomendado");
    assert.equal(body.notas, "Instruções de uso do snippet.");
    assert.ok(!/nome:|categoria:/i.test(body.notas), "notas não deve conter as linhas nome:/categoria:");
    assert.equal(body.conteudo, "**Título na edição**\n\ncorpo");
    assert.ok(!body.conteudo.includes("<!--"), "conteudo não deve incluir o comentário-header");
  });

  it("PUT {nome, categoria, notas, conteudo} reconstrói o arquivo inteiro e persiste", async () => {
    const get = await (await fetch(new URL("/api/boxes/sem-header.md", server.url))).json();
    const put = await fetch(new URL("/api/boxes/sem-header.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nome: "Nome Novo",
        categoria: "Achado da semana",
        notas: "Nota interna sobre o uso.",
        conteudo: get.conteudo,
        expectedModifiedAt: get.modifiedAt,
      }),
    });
    assert.equal(put.status, 200);
    const onDisk = readFileSync(join(root, "context", "snippets", "sem-header.md"), "utf8");
    assert.equal(
      onDisk,
      "<!--\nnome: Nome Novo\ncategoria: Achado da semana\nNota interna sobre o uso.\n-->\n\n# Título derivado\n\ncorpo",
    );
    // e a lista agora mostra nome + categoria novos
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    const updated = list.boxes.find((b: { slug: string }) => b.slug === "sem-header.md");
    assert.equal(updated.nome, "Nome Novo");
    assert.equal(updated.categoria, "Achado da semana");
  });

  it("PUT {conteudo} sem nome/categoria/notas -> sem comentário no topo (conteúdo puro)", async () => {
    const get = await (await fetch(new URL("/api/boxes/sem-header.md", server.url))).json();
    const put = await fetch(new URL("/api/boxes/sem-header.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conteudo: "# Só conteúdo, sem header", expectedModifiedAt: get.modifiedAt }),
    });
    assert.equal(put.status, 200);
    assert.equal(
      readFileSync(join(root, "context", "snippets", "sem-header.md"), "utf8"),
      "# Só conteúdo, sem header",
    );
  });

  it("PUT {conteudo} salvando SEM alterar nada é byte-estável (round-trip GET -> PUT idêntico ao original)", async () => {
    // #3979 risco explícito: recompor precisa ser byte-estável quando nada
    // muda (context/snippets/*.md no prompt cache).
    const before = readFileSync(join(root, "context", "snippets", "com-header.md"), "utf8");
    const get = await (await fetch(new URL("/api/boxes/com-header.md", server.url))).json();
    const put = await fetch(new URL("/api/boxes/com-header.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nome: get.nome,
        categoria: get.categoria,
        notas: get.notas,
        conteudo: get.conteudo,
        expectedModifiedAt: get.modifiedAt,
      }),
    });
    assert.equal(put.status, 200);
    assert.equal(readFileSync(join(root, "context", "snippets", "com-header.md"), "utf8"), before);
  });

  it("POST {slug, nome, categoria, content} cria caixa com header nome:+categoria:", async () => {
    const res = await fetch(new URL("/api/boxes", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "nova-com-categoria.md",
        nome: "Caixa Nomeada",
        categoria: "Recomendado",
        content: "# Público\n\ncorpo",
      }),
    });
    assert.equal(res.status, 201);
    const onDisk = readFileSync(join(root, "context", "snippets", "nova-com-categoria.md"), "utf8");
    assert.match(onDisk, /nome: Caixa Nomeada/);
    assert.match(onDisk, /categoria: Recomendado/);
    // invariante: nem nome nem categoria vazam no render
    const rendered = onDisk.replace(/<!--[\s\S]*?-->/g, "");
    assert.ok(!rendered.includes("Caixa Nomeada"));
    assert.ok(!rendered.includes("Recomendado"));
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    const created = list.boxes.find((b: { slug: string }) => b.slug === "nova-com-categoria.md");
    assert.equal(created.nome, "Caixa Nomeada");
    assert.equal(created.categoria, "Recomendado");
  });

  it("POST só com categoria (sem nome) monta header com só categoria:", async () => {
    const res = await fetch(new URL("/api/boxes", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "so-categoria.md", categoria: "Achado da semana", content: "# X\n\ncorpo" }),
    });
    assert.equal(res.status, 201);
    assert.equal(
      readFileSync(join(root, "context", "snippets", "so-categoria.md"), "utf8"),
      "<!--\ncategoria: Achado da semana\n-->\n\n# X\n\ncorpo",
    );
  });
});

// ─── título de conteúdo: campo dedicado via HTTP (#4079) ──────────────────

describe("campo dedicado 'titulo' via HTTP: GET devolve titulo, PUT {titulo} reescreve a 1ª linha (#4079)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-4079-http-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "README.md"), "# Formato\n\nDoc.");
    writeFileSync(
      join(root, "context", "snippets", "com-heading.md"),
      "<!--\nnome: Rótulo Interno\n-->\n\n## Título de conteúdo\n\ncorpo preservado\n\n- item",
    );
    writeFileSync(join(root, "context", "snippets", "texto-puro.md"), "Título em texto puro\n\ncorpo");
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ boxes_divulgacao: {} }));
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /api/boxes/:slug devolve 'titulo' derivado da 1ª linha do conteúdo (heading, sem os '#')", async () => {
    const body = await (await fetch(new URL("/api/boxes/com-heading.md", server.url))).json();
    assert.equal(body.titulo, "Título de conteúdo");
  });

  it("GET /api/boxes/:slug devolve 'titulo' derivado da 1ª linha de texto puro", async () => {
    const body = await (await fetch(new URL("/api/boxes/texto-puro.md", server.url))).json();
    assert.equal(body.titulo, "Título em texto puro");
  });

  it("PUT com 'titulo' reescreve só a 1ª linha do conteúdo (heading), preserva nível + resto do corpo", async () => {
    const get = await (await fetch(new URL("/api/boxes/com-heading.md", server.url))).json();
    const put = await fetch(new URL("/api/boxes/com-heading.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nome: get.nome,
        conteudo: get.conteudo,
        titulo: "Novo título",
        expectedModifiedAt: get.modifiedAt,
      }),
    });
    assert.equal(put.status, 200);
    const onDisk = readFileSync(join(root, "context", "snippets", "com-heading.md"), "utf8");
    assert.equal(onDisk, "<!--\nnome: Rótulo Interno\n-->\n\n## Novo título\n\ncorpo preservado\n\n- item");

    // e a lista reflete o novo contentTitle
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    const updated = list.boxes.find((b: { slug: string }) => b.slug === "com-heading.md");
    assert.equal(updated.contentTitle, "Novo título");
    // nome (rótulo interno) não foi afetado pela troca de título de conteúdo
    assert.equal(updated.nome, "Rótulo Interno");
  });

  it("PUT com 'titulo' reescreve texto puro sem introduzir markdown (nunca converte pra heading)", async () => {
    const get = await (await fetch(new URL("/api/boxes/texto-puro.md", server.url))).json();
    const put = await fetch(new URL("/api/boxes/texto-puro.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conteudo: get.conteudo, titulo: "Título trocado", expectedModifiedAt: get.modifiedAt }),
    });
    assert.equal(put.status, 200);
    const onDisk = readFileSync(join(root, "context", "snippets", "texto-puro.md"), "utf8");
    assert.equal(onDisk, "Título trocado\n\ncorpo");
    assert.ok(!onDisk.startsWith("#"));
  });

  it("PUT sem o campo 'titulo' (omitido) preserva o conteúdo como enviado — comportamento pré-#4079 intacto", async () => {
    const get = await (await fetch(new URL("/api/boxes/texto-puro.md", server.url))).json();
    const put = await fetch(new URL("/api/boxes/texto-puro.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conteudo: get.conteudo, expectedModifiedAt: get.modifiedAt }),
    });
    assert.equal(put.status, 200);
    assert.equal(readFileSync(join(root, "context", "snippets", "texto-puro.md"), "utf8"), get.conteudo);
  });

  it("PUT {conteudo, titulo} salvando SEM alterar o título é byte-estável (round-trip GET -> PUT idêntico ao original)", async () => {
    const before = readFileSync(join(root, "context", "snippets", "com-heading.md"), "utf8");
    const get = await (await fetch(new URL("/api/boxes/com-heading.md", server.url))).json();
    const put = await fetch(new URL("/api/boxes/com-heading.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nome: get.nome,
        conteudo: get.conteudo,
        titulo: get.titulo,
        expectedModifiedAt: get.modifiedAt,
      }),
    });
    assert.equal(put.status, 200);
    assert.equal(readFileSync(join(root, "context", "snippets", "com-heading.md"), "utf8"), before);
  });

  it("PUT com 'titulo' vazio -> no-op sobre a 1ª linha (preserva o conteúdo enviado)", async () => {
    const get = await (await fetch(new URL("/api/boxes/com-heading.md", server.url))).json();
    const put = await fetch(new URL("/api/boxes/com-heading.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: get.nome, conteudo: get.conteudo, titulo: "", expectedModifiedAt: get.modifiedAt }),
    });
    assert.equal(put.status, 200);
    const onDisk = readFileSync(join(root, "context", "snippets", "com-heading.md"), "utf8");
    assert.match(onDisk, /## Novo título/); // valor do teste anterior, intacto
  });
});

// ─── contrato HTTP: gestão de slots de divulgação (#3937) ──────────────────

describe("GET/PUT /api/boxes/slots (#3937; slot0 #4290)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-3937-http-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "recomendacao-leitura.md"), "# Recomendação");
    writeFileSync(join(root, "context", "snippets", "livros-divulgacao.md"), "# Livros");
    writeFileSync(join(root, "context", "snippets", "apoio-divulgacao.md"), "# Apoio");
    writeFileSync(join(root, "context", "snippets", "intro-box.md"), "# Intro");
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
            slot0: null,
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

  it("GET /api/boxes/slots devolve a atribuição atual + modifiedAt (slot0 vazio por default)", async () => {
    const res = await fetch(new URL("/api/boxes/slots", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.slot0, "");
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

  // #4275: variante Patronos via ?variant=patronos (GET) / {variant:"patronos"} (PUT).
  it("GET /api/boxes/slots?variant=patronos lê boxes_divulgacao_patronos — ausente no fixture, todos vazios", async () => {
    const res = await fetch(new URL("/api/boxes/slots?variant=patronos", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.slot0, "");
    assert.equal(body.slot1, "");
    assert.equal(body.slot2, "");
    assert.equal(body.slot3, "");
    // GET sem ?variant continua batendo boxes_divulgacao (Padrão) — as duas
    // rotas não interferem uma na outra.
    const defaultRes = await fetch(new URL("/api/boxes/slots", server.url));
    assert.equal((await defaultRes.json()).slot1, "recomendacao-leitura.md");
  });

  it("PUT /api/boxes/slots com variant:'patronos' escreve boxes_divulgacao_patronos, preserva boxes_divulgacao", async () => {
    const getRes = await fetch(new URL("/api/boxes/slots?variant=patronos", server.url));
    const { modifiedAt } = await getRes.json();

    const putRes = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot0: "",
        slot1: "intro-box.md",
        slot2: "",
        slot3: "",
        variant: "patronos",
        expectedModifiedAt: modifiedAt,
      }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.ok, true);
    assert.equal(putBody.slots.slot1, "intro-box.md");

    // Confirma via GET das duas variantes: Patronos mudou, Padrão não.
    const patronosAfter = await (await fetch(new URL("/api/boxes/slots?variant=patronos", server.url))).json();
    assert.equal(patronosAfter.slot1, "intro-box.md");
    const defaultAfter = await (await fetch(new URL("/api/boxes/slots", server.url))).json();
    assert.equal(defaultAfter.slot1, "recomendacao-leitura.md");

    // Restaura pro estado do beforeEach (evita vazar pro próximo teste).
    await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot0: "", slot1: "", slot2: "", slot3: "", variant: "patronos", force: true }),
    });
  });

  it("PUT /api/boxes/slots com variant desconhecido (typo/ausente) cai no comportamento padrão (boxes_divulgacao)", async () => {
    const getRes = await fetch(new URL("/api/boxes/slots", server.url));
    const { modifiedAt } = await getRes.json();
    const putRes = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot0: "",
        slot1: "recomendacao-leitura.md",
        slot2: "livros-divulgacao.md",
        slot3: "apoio-divulgacao.md",
        variant: "nao-existe",
        expectedModifiedAt: modifiedAt,
      }),
    });
    assert.equal(putRes.status, 200);
    // Sem mudança real de valor (mesmos slots do beforeEach) — só confirma
    // que a chave escrita foi boxes_divulgacao (Padrão), não uma 3ª chave.
    const cfg = JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8"));
    assert.equal(cfg.boxes_divulgacao_patronos, undefined);
  });

  it("PUT /api/boxes/slots feliz — reatribui e devolve o novo estado", async () => {
    const get = await (await fetch(new URL("/api/boxes/slots", server.url))).json();
    const loadedModifiedAt = get.modifiedAt;

    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot0: "",
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
      { slot0: "", slot1: "livros-divulgacao.md", slot2: "", slot3: "apoio-divulgacao.md" },
    );
    // Badge da lista reflete a nova atribuição (refetch, R5) sem restart.
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    const livros = list.boxes.find((b: { slug: string }) => b.slug === "livros-divulgacao.md");
    assert.equal(livros.slot, 1);
    const recomendacao = list.boxes.find((b: { slug: string }) => b.slug === "recomendacao-leitura.md");
    assert.equal(recomendacao.slot, null);
  });

  it("#4290: PUT /api/boxes/slots feliz — atribui slot0 e reflete no badge da lista", async () => {
    const get = await (await fetch(new URL("/api/boxes/slots", server.url))).json();
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot0: "intro-box.md",
        slot1: "recomendacao-leitura.md",
        slot2: "livros-divulgacao.md",
        slot3: "apoio-divulgacao.md",
        expectedModifiedAt: get.modifiedAt,
      }),
    });
    assert.equal(put.status, 200);
    const body = await put.json();
    assert.equal(body.ok, true);
    assert.equal(body.slots.slot0, "intro-box.md");
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8")).boxes_divulgacao,
      {
        slot0: "intro-box.md",
        slot1: "recomendacao-leitura.md",
        slot2: "livros-divulgacao.md",
        slot3: "apoio-divulgacao.md",
      },
    );
    const list = await (await fetch(new URL("/api/boxes", server.url))).json();
    const intro = list.boxes.find((b: { slug: string }) => b.slug === "intro-box.md");
    assert.equal(intro.slot, 0);
  });

  it("preserva as outras chaves do platform.config.json (newsletter, drive_sync)", async () => {
    const res = await fetch(new URL("/api/boxes/slots", server.url));
    const get = await res.json();
    await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot0: "",
        slot1: "apoio-divulgacao.md",
        slot2: "",
        slot3: "",
        expectedModifiedAt: get.modifiedAt,
      }),
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
      body: JSON.stringify({ slot0: "", slot1: "nao-existe.md", slot2: "", slot3: "" }),
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
      body: JSON.stringify({ slot0: "", slot1: "velha.md", slot2: "", slot3: "" }),
    });
    assert.equal(put.status, 400);
    const body = await put.json();
    assert.equal(body.invalid, true);
  });

  it("guard 1: também vale pro slot0 — caixa inexistente nesse slot -> 400, não escreve", async () => {
    const before = readFileSync(join(root, "platform.config.json"), "utf8");
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot0: "nao-existe.md",
        slot1: "recomendacao-leitura.md",
        slot2: "livros-divulgacao.md",
        slot3: "apoio-divulgacao.md",
      }),
    });
    assert.equal(put.status, 400);
    const body = await put.json();
    assert.equal(body.invalid, true);
    assert.equal(readFileSync(join(root, "platform.config.json"), "utf8"), before);
  });

  it("guard 2: rejeita a mesma caixa em 2 slots -> 400, não escreve", async () => {
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot0: "", slot1: "apoio-divulgacao.md", slot2: "apoio-divulgacao.md", slot3: "" }),
    });
    assert.equal(put.status, 400);
    const body = await put.json();
    assert.equal(body.invalid, true);
  });

  it("guard 2: também vale pro slot0 — mesma caixa em slot0 e slot1 -> 400, não escreve", async () => {
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot0: "recomendacao-leitura.md",
        slot1: "recomendacao-leitura.md",
        slot2: "",
        slot3: "",
      }),
    });
    assert.equal(put.status, 400);
    const body = await put.json();
    assert.equal(body.invalid, true);
  });

  it("aceita '(vazio)' — todos os slots como string vazia, incluindo slot0", async () => {
    const get = await (await fetch(new URL("/api/boxes/slots", server.url))).json();
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot0: "", slot1: "", slot2: "", slot3: "", expectedModifiedAt: get.modifiedAt }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8")).boxes_divulgacao,
      { slot0: "", slot1: "", slot2: "", slot3: "" },
    );
  });

  it("guard de mtime: expectedModifiedAt obsoleto -> 409, não sobrescreve", async () => {
    const get = await (await fetch(new URL("/api/boxes/slots", server.url))).json();
    const staleModifiedAt = get.modifiedAt;
    // Simula outra sessão/aba escrevendo por baixo antes deste PUT.
    const configPath = join(root, "platform.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ boxes_divulgacao: { slot0: null, slot1: "recomendacao-leitura.md", slot2: "", slot3: "" } }),
      "utf8",
    );
    const bumped = new Date(new Date(staleModifiedAt).getTime() + 2000);
    utimesSync(configPath, bumped, bumped);

    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot0: "",
        slot1: "livros-divulgacao.md",
        slot2: "",
        slot3: "",
        expectedModifiedAt: staleModifiedAt,
      }),
    });
    assert.equal(put.status, 409);
    const body = await put.json();
    assert.equal(body.conflict, true);
    assert.deepEqual(
      JSON.parse(readFileSync(configPath, "utf8")).boxes_divulgacao,
      { slot0: null, slot1: "recomendacao-leitura.md", slot2: "", slot3: "" },
      "não deve sobrescrever em conflito",
    );
  });

  it("guard de mtime: force:true sobrescreve mesmo com expectedModifiedAt divergente", async () => {
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot0: "",
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
      { slot0: "", slot1: "apoio-divulgacao.md", slot2: "", slot3: "" },
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
      body: JSON.stringify({ slot0: "", slot1: 123, slot2: "", slot3: "" }),
    });
    assert.equal(put.status, 400);
  });

  it("#4290: PUT com slot0 não-string (ex: número) -> 400", async () => {
    const put = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot0: 123, slot1: "", slot2: "", slot3: "" }),
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
      body: JSON.stringify({
        slot0: get.slot0,
        slot1: get.slot1,
        slot2: get.slot2,
        slot3: "",
        expectedModifiedAt: get.modifiedAt,
      }),
    });
    assert.equal(freed.status, 200);

    const archived = await fetch(new URL("/api/boxes/apoio-divulgacao.md/archive", server.url), { method: "POST" });
    assert.equal(archived.status, 200);

    // restaura pro fixture não vazar estado pros próximos testes
    await fetch(new URL("/api/boxes/apoio-divulgacao.md/unarchive", server.url), { method: "POST" });
  });

  // #4290: mesmo loop, mas liberando o slot0 (introdução).
  it("fecha o loop com o Arquivar (#4290): liberar o slot0 aqui desbloqueia POST /archive", async () => {
    const get0 = await (await fetch(new URL("/api/boxes/slots", server.url))).json();
    const assign = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot0: "intro-box.md",
        slot1: get0.slot1,
        slot2: get0.slot2,
        slot3: get0.slot3,
        expectedModifiedAt: get0.modifiedAt,
      }),
    });
    assert.equal(assign.status, 200);

    const blocked = await fetch(new URL("/api/boxes/intro-box.md/archive", server.url), { method: "POST" });
    assert.equal(blocked.status, 409);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.slot, 0);

    const get = await (await fetch(new URL("/api/boxes/slots", server.url))).json();
    const freed = await fetch(new URL("/api/boxes/slots", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slot0: "",
        slot1: get.slot1,
        slot2: get.slot2,
        slot3: get.slot3,
        expectedModifiedAt: get.modifiedAt,
      }),
    });
    assert.equal(freed.status, 200);

    const archived = await fetch(new URL("/api/boxes/intro-box.md/archive", server.url), { method: "POST" });
    assert.equal(archived.status, 200);

    await fetch(new URL("/api/boxes/intro-box.md/unarchive", server.url), { method: "POST" });
  });
});

// ─── contrato HTTP: slots A/B de texto do PARA ENCERRAR (#4274) ────────────

describe("GET/PUT /api/boxes/para-encerrar (#4274)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-4274-http-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
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
          para_encerrar: { slot_a: "Texto A inicial", slot_b: "Texto B inicial" },
          drive_sync: false,
        },
        null,
        2,
      ) + "\n",
    );
  });

  it("GET /api/boxes/para-encerrar devolve o conteúdo atual + modifiedAt", async () => {
    const res = await fetch(new URL("/api/boxes/para-encerrar", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.slotA, "Texto A inicial");
    assert.equal(body.slotB, "Texto B inicial");
    assert.ok(body.modifiedAt);
  });

  it("GET /api/boxes/para-encerrar nunca é confundido com get-por-slug (/api/boxes/:slug)", async () => {
    // Sem a checagem explícita antes do regex de slug, isto cairia em
    // readBox(root, "para-encerrar") -> 404 (mesma classe de regressão do
    // #3928 pra "archived" / #3937 pra "slots").
    const res = await fetch(new URL("/api/boxes/para-encerrar", server.url));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).slotA, "Texto A inicial");
  });

  it("PUT /api/boxes/para-encerrar feliz — reescreve e devolve o novo estado", async () => {
    const get = await (await fetch(new URL("/api/boxes/para-encerrar", server.url))).json();
    const put = await fetch(new URL("/api/boxes/para-encerrar", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slotA: "Novo texto A, editado no painel Caixas.",
        slotB: "Novo texto B, editado no painel Caixas.",
        expectedModifiedAt: get.modifiedAt,
      }),
    });
    assert.equal(put.status, 200);
    const body = await put.json();
    assert.equal(body.ok, true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8")).para_encerrar,
      { slot_a: "Novo texto A, editado no painel Caixas.", slot_b: "Novo texto B, editado no painel Caixas." },
    );
  });

  it("preserva as outras chaves do platform.config.json (newsletter, drive_sync)", async () => {
    const get = await (await fetch(new URL("/api/boxes/para-encerrar", server.url))).json();
    await fetch(new URL("/api/boxes/para-encerrar", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slotA: "a", slotB: "b", expectedModifiedAt: get.modifiedAt }),
    });
    const onDisk = JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8"));
    assert.equal(onDisk.newsletter, "beehiiv");
    assert.equal(onDisk.drive_sync, false);
  });

  it("409 quando expectedModifiedAt diverge (outra aba/sessão salvou nesse meio tempo), não sobrescreve", async () => {
    const get = await (await fetch(new URL("/api/boxes/para-encerrar", server.url))).json();
    // Simula outra sessão salvando primeiro.
    await fetch(new URL("/api/boxes/para-encerrar", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slotA: "concorrente A", slotB: "concorrente B", expectedModifiedAt: get.modifiedAt }),
    });
    // Tentativa com o mtime STALE (visto antes da escrita concorrente).
    const put = await fetch(new URL("/api/boxes/para-encerrar", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slotA: "tentativa tardia A", slotB: "tentativa tardia B", expectedModifiedAt: get.modifiedAt }),
    });
    assert.equal(put.status, 409);
    const body = await put.json();
    assert.equal(body.conflict, true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8")).para_encerrar,
      { slot_a: "concorrente A", slot_b: "concorrente B" },
      "não deve sobrescrever em conflito",
    );
  });

  it("400 quando slotA/slotB não são string", async () => {
    const put = await fetch(new URL("/api/boxes/para-encerrar", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slotA: 123, slotB: "b" }),
    });
    assert.equal(put.status, 400);
  });

  it("400 quando o corpo não é JSON válido", async () => {
    const put = await fetch(new URL("/api/boxes/para-encerrar", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "não é json",
    });
    assert.equal(put.status, 400);
  });
});
