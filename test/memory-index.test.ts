/**
 * test/memory-index.test.ts (#7533)
 *
 * Trava os dois invariantes centrais do design "índice gerado, não
 * sincronizado" (ver docstring de scripts/lib/memory-index.ts):
 *
 *   (a) round-trip do extrator+gerador é IDÊNTICO quando nada muda;
 *   (b) memória nova não classificada aparece em "Recentes" SEM alterar
 *       nenhuma linha curada existente.
 *
 * Fixtures são sintéticas (não o MEMORY.md real do usuário, que vive fora
 * deste repo git e não deve ser um dado de teste) — um índice pequeno de
 * 2-3 blocos, deliberadamente no mesmo formato do arquivo real.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  extractManifest,
  generateMemoryMd,
  buildMemoryMd,
  deriveIndexLabel,
  truncateForLabel,
  parseMemoryFrontmatter,
  collectReferencedFilenames,
  type MemoryFileEntry,
} from "../scripts/lib/memory-index.ts";

const FIXTURE_MEMORY_MD = `# Memory index

- [Limite de uso da assinatura é o gargalo](project_limite-de-uso.md) — Stage 4 = 48% dos tokens; #6444
- [Sync manual das 3 máquinas](sync-manual-memoria-260906.md) + [claude-config sync](project_claude-config-sync-260809.md) — 267 memórias iguais nas 3; é FOTO

- [Brevo diária: estado 260804](project_brevo-diaria-estado.md) — cap 175, piso n≥3, #4630-4637
- [Nome ≠ hora de envio](brevo-nome-nao-e-hora.md) + [globalStats zerado](brevo-globalstats-zerado.md) — usar sentDate

## Infra/ferramentas
- [taskkill sempre por PID](taskkill-nunca-por-nome.md) — nome de imagem mata sessão alheia; #6982`;

describe("extractManifest + generateMemoryMd — round-trip (#7533)", () => {
  it("produz texto idêntico byte a byte quando nada muda", () => {
    const manifest = extractManifest(FIXTURE_MEMORY_MD);
    const regenerated = generateMemoryMd(manifest);
    assert.equal(regenerated, FIXTURE_MEMORY_MD);
  });

  it("extrai o número correto de blocos, refs e descrições", () => {
    const manifest = extractManifest(FIXTURE_MEMORY_MD);
    assert.equal(manifest.title, "# Memory index");
    assert.equal(manifest.blocks.length, 3);
    assert.equal(manifest.blocks[0].lines.length, 2);
    assert.equal(manifest.blocks[0].lines[1].refs.length, 2);
    assert.equal(manifest.blocks[0].lines[1].refs[0].label, "Sync manual das 3 máquinas");
    assert.equal(manifest.blocks[0].lines[1].refs[0].file, "sync-manual-memoria-260906.md");
    assert.equal(manifest.blocks[2].heading, "Infra/ferramentas");
    assert.equal(manifest.blocks[2].lines[0].description, "nome de imagem mata sessão alheia; #6982");
  });

  it("collectReferencedFilenames enumera todo arquivo citado em qualquer bloco", () => {
    const manifest = extractManifest(FIXTURE_MEMORY_MD);
    const referenced = collectReferencedFilenames(manifest);
    assert.ok(referenced.has("project_limite-de-uso.md"));
    assert.ok(referenced.has("brevo-globalstats-zerado.md"));
    assert.ok(referenced.has("taskkill-nunca-por-nome.md"));
    assert.equal(referenced.size, 7);
  });

  it("buildMemoryMd é idêntico a generateMemoryMd quando todo arquivo já está classificado", () => {
    const manifest = extractManifest(FIXTURE_MEMORY_MD);
    const files: MemoryFileEntry[] = [...collectReferencedFilenames(manifest)].map((filename) => ({
      filename,
      frontmatter: {},
    }));
    const rebuilt = buildMemoryMd(manifest, files);
    assert.equal(rebuilt, FIXTURE_MEMORY_MD);
  });
});

describe("buildMemoryMd — memória nova cai em Recentes sem alterar curadoria (#7533)", () => {
  it("adiciona bloco Recentes com a memória nova e preserva os blocos curados intactos", () => {
    const manifest = extractManifest(FIXTURE_MEMORY_MD);
    const knownFiles: MemoryFileEntry[] = [...collectReferencedFilenames(manifest)].map((filename) => ({
      filename,
      frontmatter: {},
    }));
    const newFile: MemoryFileEntry = {
      filename: "feedback_shared_working_copy_protocol.md",
      frontmatter: { description: "Protocolo para duas sessões na mesma working copy" },
    };

    const result = buildMemoryMd(manifest, [...knownFiles, newFile]);

    // Todo o texto original continua presente, byte a byte, como prefixo.
    assert.ok(result.startsWith(FIXTURE_MEMORY_MD), "blocos curados originais devem permanecer intactos");

    // O novo bloco aparece só no final, depois do texto original.
    const appended = result.slice(FIXTURE_MEMORY_MD.length);
    assert.match(appended, /## Recentes \(não classificadas\)/);
    assert.match(appended, /\[Protocolo para duas sessões na mesma working copy\]\(feedback_shared_working_copy_protocol\.md\)/);
  });

  it("não duplica arquivos já classificados em Recentes mesmo se relistados", () => {
    const manifest = extractManifest(FIXTURE_MEMORY_MD);
    const files: MemoryFileEntry[] = [...collectReferencedFilenames(manifest)].map((filename) => ({
      filename,
      frontmatter: {},
    }));
    const result = buildMemoryMd(manifest, files);
    assert.doesNotMatch(result, /Recentes/);
  });

  it("respeita discardedFilenames — arquivo descartado não reaparece em Recentes", () => {
    const manifest = extractManifest(FIXTURE_MEMORY_MD);
    const knownFiles: MemoryFileEntry[] = [...collectReferencedFilenames(manifest)].map((filename) => ({
      filename,
      frontmatter: {},
    }));
    const discardedFile: MemoryFileEntry = {
      filename: "estado-transitorio-ja-resolvido.md",
      frontmatter: { description: "issue fechada, memória obsoleta" },
    };
    const result = buildMemoryMd(manifest, [...knownFiles, discardedFile], {
      discardedFilenames: ["estado-transitorio-ja-resolvido.md"],
    });
    assert.equal(result, FIXTURE_MEMORY_MD);
  });
});

describe("deriveIndexLabel / truncateForLabel (#7533 item 1-2)", () => {
  it("usa index_label quando presente, mesmo com description também presente", () => {
    const label = deriveIndexLabel(
      { index_label: "Apex é nosso Worker", description: "Descrição bem mais longa sobre o mesmo assunto" },
      "apex-diar-ia-br.md",
    );
    assert.equal(label, "Apex é nosso Worker");
  });

  it("nunca deriva do name — só de index_label, description ou filename", () => {
    const label = deriveIndexLabel(
      { name: "apex-diar-ia-br-fora-da-nossa-zona-cloudflare", description: "O apex é servido pelo nosso Worker desde o cutover" },
      "apex-diar-ia-br-fora-da-nossa-zona-cloudflare.md",
    );
    assert.doesNotMatch(label, /fora-da-nossa-zona/);
  });

  it("cai para description truncada quando index_label ausente", () => {
    const label = deriveIndexLabel(
      { description: "Apagar arquivo no OneDrive não devolve cota — a Lixeira segura por ~30 dias antes de liberar espaço" },
      "onedrive-apagar-nao-libera-cota.md",
    );
    assert.equal(label, "Apagar arquivo no OneDrive não devolve cota");
  });

  it("cai para o nome do arquivo quando não há index_label nem description", () => {
    const label = deriveIndexLabel({}, "memoria-sem-metadata.md");
    assert.equal(label, "memoria-sem-metadata");
  });

  it("truncateForLabel corta em fronteira de palavra dentro do teto", () => {
    const long = "Uma description muito longa sem nenhum separador natural que precisa ser cortada em algum lugar razoável";
    const truncated = truncateForLabel(long, 52);
    assert.ok(truncated.length <= 52);
    assert.ok(!truncated.endsWith(" "));
  });
});

describe("parseMemoryFrontmatter (#7533)", () => {
  it("extrai name/description/index_label ignorando blocos aninhados", () => {
    const content = `---
name: brevo-hourly-ratelimit
description: A API Brevo tem limite HORÁRIO que investigação manual esgota
index_label: Rate limit Brevo é por hora
metadata:
  node_type: memory
  type: feedback
---

Corpo da memória, ignorado por este parser.`;
    const fm = parseMemoryFrontmatter(content);
    assert.equal(fm.name, "brevo-hourly-ratelimit");
    assert.equal(fm.description, "A API Brevo tem limite HORÁRIO que investigação manual esgota");
    assert.equal(fm.index_label, "Rate limit Brevo é por hora");
  });

  it("retorna objeto vazio quando não há frontmatter", () => {
    const fm = parseMemoryFrontmatter("Corpo sem frontmatter nenhum.");
    assert.deepEqual(fm, {});
  });

  it("ignora index_label ausente sem quebrar", () => {
    const fm = parseMemoryFrontmatter(`---\nname: foo\ndescription: "bar"\n---\ncorpo`);
    assert.equal(fm.name, "foo");
    assert.equal(fm.description, "bar");
    assert.equal(fm.index_label, undefined);
  });
});

describe("extractManifest — erros esperados", () => {
  it("lança em MEMORY.md vazio", () => {
    assert.throws(() => extractManifest(""));
  });

  it("lança em linha fora da gramática esperada", () => {
    const bad = "# Memory index\n\n* item sem colchetes nem em dash";
    assert.throws(() => extractManifest(bad));
  });

  it("REGRESSÃO #7601: mensagem de erro é acionável — cita o nº da linha e o que era esperado, não stack trace crua", () => {
    const bad = "# Memory index\n\n- [ok](ok.md) — descrição\n* item sem colchetes nem em dash";
    assert.throws(() => extractManifest(bad), (err: unknown) => {
      const message = (err as Error).message;
      // Linha 4 (1-based): título=1, branco=2, "- [ok]..."=3, a linha ruim=4.
      assert.match(message, /linha 4/);
      assert.match(message, /esperado/i);
      assert.match(message, /item sem colchetes nem em dash/);
      return true;
    });
  });
});

describe("REGRESSÃO #7601: comentário HTML dentro de um bloco é tolerado e preservado no round-trip", () => {
  const FIXTURE_WITH_COMMENT = `# Memory index

- [Entrada normal](normal.md) — descrição normal

## Legado do ZenBook — importado 06/09/2026, NÃO triado
<!-- 50 memórias de um acervo que ficou isolado no ZenBook. Sobreposição medida
     com o acervo curado: 7 de 50, nenhuma forte. Precisam de triagem e
     agrupamento próprio; até lá ficam aqui, localizáveis mas marcadas. -->
- [feedback legado](feedback_legado.md) + [outro legado](outro_legado.md)`;

  it("extrai sem lançar e preserva o comentário verbatim (3 linhas) como entrada própria do bloco", () => {
    const manifest = extractManifest(FIXTURE_WITH_COMMENT);
    const block = manifest.blocks[1];
    assert.equal(block.heading, "Legado do ZenBook — importado 06/09/2026, NÃO triado");
    assert.equal(block.lines.length, 2, "comentário (1 entrada multi-linha) + 1 bullet");
    assert.equal(
      block.lines[0].raw,
      "<!-- 50 memórias de um acervo que ficou isolado no ZenBook. Sobreposição medida\n" +
        "     com o acervo curado: 7 de 50, nenhuma forte. Precisam de triagem e\n" +
        "     agrupamento próprio; até lá ficam aqui, localizáveis mas marcadas. -->",
    );
    assert.deepEqual(block.lines[0].refs, []);
    assert.equal(block.lines[1].refs.length, 2);
  });

  it("round-trip extract → generate é byte a byte idêntico com comentário HTML presente", () => {
    const manifest = extractManifest(FIXTURE_WITH_COMMENT);
    const regenerated = generateMemoryMd(manifest);
    assert.equal(regenerated, FIXTURE_WITH_COMMENT);
  });

  it("lança com mensagem acionável quando o comentário HTML nunca fecha (sem '-->')", () => {
    const unclosed = "# Memory index\n\n<!-- comentário nunca fecha\nmais uma linha solta";
    assert.throws(() => extractManifest(unclosed), /linha 3.*sem fechamento/is);
  });
});

/**
 * REGRESSÃO #7692: `LINE_REGEX` rejeitava um bullet com categoria antes da
 * 1ª ref (`- Categoria: [label](arquivo) + ...`), formato usado nas 8 linhas
 * reais do bloco `## Legado do ZenBook` importado em 06/09/2026 (bloco que
 * hoje não existe mais — as memórias foram triadas em 09/09/2026 — mas o
 * parser precisa continuar aceitando o formato para não travar o round-trip
 * se ele reaparecer, ver docstring de `LINE_REGEX`). Fixture: as 8 linhas
 * reais citadas no corpo da issue #7692, verbatim.
 */
describe("REGRESSÃO #7692: bullet com categoria (prefixo) antes da 1ª ref", () => {
  const FIXTURE_WITH_PREFIX = `# Memory index

## Legado do ZenBook — importado 06/09/2026, NÃO triado
- Beehiiv/editor: [autor vazio](feedback_beehiiv_empty_author_correct.md) + [3-dot do template](feedback_beehiiv_template_click_3dot.md)
- Escrita/estilo: [URLs clicáveis](feedback_clickable_urls.md) + [regras do erro intencional](feedback_erro_intencional_regras.md)
- Overnight/PR: [hook de review na PR](feedback_auto_code_review_pr_hook.md)
- Testes/CI: [guard de imports na CLI](feedback_cli_guard_imports.md)
- Clarice/dados: [programa de e-mail](project_clarice_email_program.md)
- Design/layout: [teal em landing pages](feedback_teal_accent_landing_pages.md)
- Infra/ferramentas: [falso positivo do link check Amazon](feedback_amazon_link_check_false_positive.md)
- Processo: [caveman muda decisões da skill](feedback_caveman_skill_changes_decisions.md)`;

  it("extrai as 8 linhas sem lançar, capturando o prefixo de categoria em cada uma", () => {
    const manifest = extractManifest(FIXTURE_WITH_PREFIX);
    const block = manifest.blocks[0];
    assert.equal(block.heading, "Legado do ZenBook — importado 06/09/2026, NÃO triado");
    assert.equal(block.lines.length, 8);
    assert.equal(block.lines[0].prefix, "Beehiiv/editor");
    assert.equal(block.lines[0].refs.length, 2);
    assert.equal(block.lines[0].refs[0].label, "autor vazio");
    assert.equal(block.lines[2].prefix, "Overnight/PR");
    assert.equal(block.lines[7].prefix, "Processo");
    assert.equal(block.lines[7].refs[0].file, "feedback_caveman_skill_changes_decisions.md");
  });

  it("round-trip extract → generate é byte a byte idêntico com prefixo de categoria presente", () => {
    const manifest = extractManifest(FIXTURE_WITH_PREFIX);
    const regenerated = generateMemoryMd(manifest);
    assert.equal(regenerated, FIXTURE_WITH_PREFIX);
  });

  it("round-trip é idempotente numa 2ª rodada (extract → generate → extract → generate)", () => {
    const first = generateMemoryMd(extractManifest(FIXTURE_WITH_PREFIX));
    const second = generateMemoryMd(extractManifest(first));
    assert.equal(second, first);
    assert.equal(second, FIXTURE_WITH_PREFIX);
  });

  it("bullet sem prefixo continua sem o campo `prefix` (não regride o formato já aceito)", () => {
    const manifest = extractManifest(
      "# Memory index\n\n- [label](arquivo.md) — descrição\n- [a](a.md) + [b](b.md)",
    );
    assert.equal(manifest.blocks[0].lines[0].prefix, undefined);
    assert.equal(manifest.blocks[0].lines[1].prefix, undefined);
  });

  it("descrição contendo ': ' não é confundida com prefixo quando a linha não abre com categoria", () => {
    // ": " só é tratado como delimitador de prefixo quando aparece ANTES da
    // 1ª ref — depois da 1ª ref, ": " dentro da descrição é texto comum.
    const manifest = extractManifest(
      "# Memory index\n\n- [label](arquivo.md) — nota: detalhe com dois-pontos",
    );
    assert.equal(manifest.blocks[0].lines[0].prefix, undefined);
    assert.equal(manifest.blocks[0].lines[0].description, "nota: detalhe com dois-pontos");
  });
});

/**
 * REGRESSÃO #7601: round-trip contra o `MEMORY.md` REAL desta máquina, não
 * só a fixture sintética acima — é o guard que faltava (o formato só quebrou
 * porque nada verificava que o gerador relê o que escreve, ver issue). O
 * arquivo real vive fora do repo git (`~/.claude/projects/{slug}/memory/`,
 * caminho varia por máquina/usuário) — o teste localiza o diretório
 * `.../memory/` deste projeto sob `~/.claude/projects/` por convenção de
 * nome (contém "diaria-studio") e degrada para no-op quando não encontra
 * (CI, outra máquina, clone fresco) em vez de falhar por ausência de dado
 * local.
 */
describe("REGRESSÃO #7601: round-trip contra o MEMORY.md real desta máquina (quando presente)", () => {
  function findRealMemoryMd(): string | null {
    const projectsDir = join(homedir(), ".claude", "projects");
    if (!existsSync(projectsDir)) return null;
    let entries: string[] = [];
    try {
      entries = readdirSync(projectsDir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().includes("diaria-studio")) continue;
      const candidate = join(projectsDir, entry, "memory", "MEMORY.md");
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  it("extract → generate reproduz o arquivo real byte a byte (skip silencioso se ausente nesta máquina)", () => {
    const path = findRealMemoryMd();
    if (!path) {
      // Sem MEMORY.md real acessível nesta máquina/sessão — nada a validar
      // aqui; o guard de fixture sintética acima já cobre a gramática.
      return;
    }
    const raw = readFileSync(path, "utf-8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
    let manifest;
    try {
      manifest = extractManifest(raw);
    } catch (e) {
      assert.fail(`extractManifest falhou no MEMORY.md real (${path}): ${(e as Error).message}`);
    }
    const regenerated = generateMemoryMd(manifest);
    assert.equal(regenerated, raw, "round-trip extract→generate deve reproduzir o arquivo real byte a byte");
  });
});
