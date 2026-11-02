/**
 * Regressão #11812 — na `/diaria-mensal` (Etapa 2d), o draft inteiro mandado
 * de uma vez a `mcp__clarice__correct_text` estourou o teto de 30s do cliente
 * MCP. O caminho novo divide o draft em blocos pequenos (todas as seções,
 * inclusive APRESENTAÇÃO, USE MELHOR e rodapé), o agente chama o MCP bloco a
 * bloco, e o merge aplica as sugestões no bloco que o MCP viu.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildChunkManifest,
  ChunkMergeError,
  main,
  mergeChunkResponses,
} from "../scripts/clarice-mcp-chunks.ts";
import { CLARICE_MCP_CHUNK_MAX_CHARS } from "../scripts/lib/clarice-chunk.ts";

function para(seed: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${seed} frase número ${i} sobre inteligência artificial no mês.`).join(" ");
}

// Draft com o formato da mensal: seções separadas por `---`, ~12k chars.
const SECTIONS = ["APRESENTAÇÃO", "DESTAQUE 1", "DESTAQUE 2", "DESTAQUE 3", "USE MELHOR", "RADAR", "RODAPÉ"];
const DRAFT = SECTIONS.map(
  (s, i) => `**${s}**\n\nSeção ${i} os resultado variam. ${para(`Texto ${i}`, 12)}\n\n${para(`Mais texto ${i}`, 8)}\n`,
).join("\n---\n\n");

test("#11812: draft da mensal é maior que o bloco MCP (o cenário do estouro)", () => {
  assert.ok(DRAFT.length > CLARICE_MCP_CHUNK_MAX_CHARS * 3, `draft tem ${DRAFT.length} chars`);
});

test("#11812: split gera blocos <= teto, cobre todas as seções e reconstrói o texto", () => {
  const { manifest, contents } = buildChunkManifest(DRAFT);
  assert.ok(manifest.chunks.length > 1);
  for (const c of contents) assert.ok(c.length <= CLARICE_MCP_CHUNK_MAX_CHARS, `bloco com ${c.length} chars`);
  assert.equal(contents.join(""), DRAFT);
  const sent = contents.filter((_, i) => manifest.chunks[i].send).join("");
  for (const s of SECTIONS) assert.ok(sent.includes(`**${s}**`), `seção ${s} fora dos blocos enviados`);
});

test("#11812: bloco só com separador não é enviado ao MCP", () => {
  const { manifest } = buildChunkManifest(`${"a ".repeat(200)}\n\n---\n\n${"b ".repeat(200)}`, 400);
  assert.ok(manifest.chunks.some((c) => c.send));
  const { manifest: m2 } = buildChunkManifest("\n\n---\n\n", 200);
  assert.equal(m2.chunks[0].send, false);
});

test("#11812: merge aplica âncora única por bloco, recusa ruído e reporta bloco sem resposta", () => {
  const { manifest, contents } = buildChunkManifest(DRAFT);
  // "os resultado" aparece em todos os blocos: ambígua no texto inteiro,
  // única dentro de cada bloco que tem uma seção.
  const raw = contents.map((c, i) => {
    if (i === 1) return undefined; // chamada do bloco 2 falhou
    const out: unknown[] = [];
    const m = c.match(/Seção \d os resultado/);
    if (m) out.push({ from: m[0], to: m[0].replace("os resultado", "os resultados") });
    out.push({ from: "Mais", to: "\n\nMais" }); // ruído do #11798
    return out;
  });
  const r = mergeChunkResponses(DRAFT, manifest, raw, () => {});
  assert.deepEqual(r.missingChunks, [2]);
  assert.ok(r.applied.length >= 2);
  assert.ok(r.skipped.some((s) => s.reason === "whitespace_only"));
  assert.ok(!r.text.includes("\n\n\n\nMais"));
  // O bloco 2 ficou como estava; os outros ganharam a correção.
  assert.ok(r.text.includes(contents[1]));
  assert.equal(r.text.length, DRAFT.length + r.applied.length);
});

test("#11812: merge recusa texto alterado depois do split", () => {
  const { manifest } = buildChunkManifest(DRAFT);
  assert.throws(
    () => mergeChunkResponses(`${DRAFT}x`, manifest, [], () => {}),
    (e: unknown) => e instanceof ChunkMergeError && e.exitCode === 3,
  );
});

test("#11812: merge recusa resposta em formato inválido", () => {
  const { manifest } = buildChunkManifest(DRAFT);
  const raw = manifest.chunks.map(() => [{ texto: "sem from/to" }]);
  assert.throws(
    () => mergeChunkResponses(DRAFT, manifest, raw, () => {}),
    (e: unknown) => e instanceof ChunkMergeError && e.exitCode === 2,
  );
});

test("#11812: CLI split → respostas por bloco → merge grava draft corrigido", () => {
  const dir = mkdtempSync(join(tmpdir(), "clarice-mcp-chunks-"));
  try {
    const draft = join(dir, "draft.md");
    const chunksDir = join(dir, "chunks");
    writeFileSync(draft, DRAFT, "utf8");
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      assert.equal(main(["split", "--in", draft, "--out-dir", chunksDir]), 0);
      const manifest = JSON.parse(readFileSync(join(chunksDir, "manifest.json"), "utf8"));
      for (const entry of manifest.chunks) {
        const content = readFileSync(join(chunksDir, entry.file), "utf8");
        const m = content.match(/Seção \d os resultado/);
        const sugg = m ? [{ from: m[0], to: m[0].replace("os resultado", "os resultados") }] : [];
        writeFileSync(join(chunksDir, entry.suggestionsFile), JSON.stringify(sugg), "utf8");
      }
      const report = join(dir, "report.json");
      const all = join(dir, "all.json");
      assert.equal(
        main(["merge", "--in", draft, "--out-dir", chunksDir, "--out", draft, "--suggestions-out", all, "--report", report]),
        0,
      );
      const out = readFileSync(draft, "utf8");
      for (let i = 0; i < SECTIONS.length; i++) assert.ok(out.includes(`Seção ${i} os resultados`), `seção ${i} sem correção`);
      const rep = JSON.parse(readFileSync(report, "utf8"));
      assert.deepEqual(rep.missing_chunks, []);
      assert.equal(rep.applied, SECTIONS.length);
      assert.equal(JSON.parse(readFileSync(all, "utf8")).length, SECTIONS.length);

      // Novo split apaga resposta velha: não pode ser lida como do bloco novo.
      assert.equal(main(["split", "--in", draft, "--out-dir", chunksDir]), 0);
      const m2 = JSON.parse(readFileSync(join(chunksDir, "manifest.json"), "utf8"));
      for (const entry of m2.chunks) assert.ok(!existsSync(join(chunksDir, entry.suggestionsFile)));
      // E merge com o texto mudado depois do split sai 3.
      writeFileSync(draft, `${out}\nlinha nova`, "utf8");
      const origErr = console.error;
      console.error = () => {};
      try {
        assert.equal(main(["merge", "--in", draft, "--out-dir", chunksDir, "--out", draft]), 3);
      } finally {
        console.error = origErr;
      }
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
