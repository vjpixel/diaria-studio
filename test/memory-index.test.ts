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
});
