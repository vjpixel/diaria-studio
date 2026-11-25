/**
 * Regressão #13907 (resíduo da #13884): `source-not-read` ficava mudo para
 * item de pool cuja página baixou com sucesso, embora nenhum writer leia esse
 * texto. Caso real (edição 261124): item de LANÇAMENTOS da microsoft.ai, Stage
 * 2 baixa a página (manifest `ok`), a descrição sai só do `summary` curto, e o
 * gate 4 não acusa mais. Além disso `fetchSourceText` conta como `ok` qualquer
 * texto não vazio (casca de página montada por JS).
 *
 * Contrato:
 *   - download `ok` do pool não limpa a regra do resumo curto (gate 4 e gate 1)
 *     enquanto o `writer-pool` não reescreveu a descrição a partir dele (sem a
 *     URL em `pool-sources/descriptions-applied.json`, #13884);
 *   - falha do download do pool segue acrescentando o motivo;
 *   - no manifest do fact-check (o fact-checker lê o texto), `ok` com menos de
 *     `SOURCE_TEXT_MIN_WORDS` palavras conta como não lida.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SOURCE_TEXT_MIN_WORDS,
  checkSourceNotRead,
  findUnreadItemsInEdition,
  readSourceDownloads,
} from "../scripts/lib/diaria/source-readability.ts";
import { sourceNotReadMarker } from "../scripts/render-categorized-md.ts";
import type { Article } from "../scripts/lib/types/article.ts";

const MS = "https://microsoft.ai/news/seven-new-world-class-models-at-scalable-price-performance/";
const LONG_URL = "https://long.example.com/post";
const BLOCKED = "https://blocked.example.com/post";
const D1 = "https://ex.com/d1";
const D2 = "https://ex.com/d2";
const LONG = "Um resumo de verdade, com o fato, quem fez, quanto e por que importa para o leitor.";

function poolEntry(url: string, over: Record<string, unknown> = {}) {
  return { url, bucket: "lancamento", title: "t", file: "x.txt", status: "ok", erro: null, bytes: 4000, fetched_at: "x", completeness: "full", words: 800, ...over };
}

function setupEdition(): string {
  const ed = mkdtempSync(join(tmpdir(), "src-13907-"));
  const internal = join(ed, "_internal");
  mkdirSync(join(internal, "pool-sources"), { recursive: true });
  mkdirSync(join(internal, "fact-check-sources"), { recursive: true });
  writeFileSync(
    join(internal, "01-approved.json"),
    JSON.stringify({
      highlights: [
        { rank: 1, url: D1, article: { url: D1, title: "d1", summary: "Curto." } },
        { rank: 2, url: D2, article: { url: D2, title: "d2", summary: LONG } },
      ],
      lancamento: [{ url: MS, title: "Seven new world-class models", verify_verdict: "accessible", summary: "Microsoft lança modelos." }],
      radar: [
        { url: LONG_URL, title: "Longo", verify_verdict: "accessible", summary: LONG },
        { url: BLOCKED, title: "Bloqueado", verify_verdict: "accessible", summary: LONG },
      ],
    }),
  );
  writeFileSync(
    join(internal, "pool-sources", "manifest.json"),
    JSON.stringify([
      poolEntry(MS),
      poolEntry(LONG_URL, { bucket: "radar", words: 12 }),
      poolEntry(BLOCKED, { bucket: "radar", status: "blocked", erro: "HTTP 403: fonte bloqueada", file: null, bytes: 0 }),
    ]),
  );
  writeFileSync(
    join(internal, "fact-check-sources", "manifest.json"),
    JSON.stringify([
      // D1: página lida pelo fact-checker, com texto de verdade: vence o resumo curto.
      { destaque: 1, url: D1, status: "ok", erro: null, bytes: 9000, fetched_at: "x", completeness: "full", words: 900 },
      // D2: "ok", mas casca de JS.
      { destaque: 2, url: D2, status: "ok", erro: null, bytes: 300, fetched_at: "x", completeness: "full", words: 25 },
    ]),
  );
  writeFileSync(
    join(ed, "02-reviewed.md"),
    `**DESTAQUE 1 | X**\n\n[d1](${D1})\n\n**DESTAQUE 2 | Y**\n\n[d2](${D2})\n\n**LANÇAMENTOS**\n\n[MS](${MS})\n\n**RADAR**\n\n[L](${LONG_URL})\n\n[B](${BLOCKED})\n`,
    "utf8",
  );
  return ed;
}

describe("source-not-read com download ok do pool (#13907)", () => {
  it("premissa: piso de palavras é 100", () => {
    assert.equal(SOURCE_TEXT_MIN_WORDS, 100);
  });

  it("cenário 261124: manifest ok + resumo curto continua acusado no gate 4", () => {
    const ed = setupEdition();
    try {
      const v = checkSourceNotRead(ed);
      // #13884: pool (MS + bloqueado) é error; o D2 de casca de JS segue warning.
      assert.deepEqual(v.map((x) => x.severity), ["error", "warning"]);
      assert.match(v[0].message, /"Seven new world-class models" \(resumo de 24 caracteres \(mínimo 60\)\)/);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("download ok do pool não gera entrada; falha do pool segue com o motivo do download", () => {
    const ed = setupEdition();
    try {
      const downloads = readSourceDownloads(join(ed, "_internal"));
      assert.equal(downloads.has(MS), false);
      assert.equal(downloads.has(LONG_URL), false, "casca de JS no pool também não muda nada: resumo longo segue lido");
      assert.match(downloads.get(BLOCKED)!.reason!, /download da página falhou: HTTP 403/);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("fact-check: ok com texto real vence o resumo curto; ok abaixo do piso conta como não lida", () => {
    const ed = setupEdition();
    try {
      const downloads = readSourceDownloads(join(ed, "_internal"));
      assert.deepEqual(downloads.get(D1), { ok: true });
      assert.deepEqual(downloads.get(D2), { ok: false, reason: "página baixada com 25 palavras (mínimo 100)" });
      const md = `[d1](${D1}) [d2](${D2}) [MS](${MS}) [L](${LONG_URL}) [B](${BLOCKED})`;
      const items = findUnreadItemsInEdition(readApproved(ed), md, downloads);
      assert.deepEqual(
        items.map((i) => [i.url, i.highlight]).sort(),
        [[BLOCKED, false], [D2, true], [MS, false]].sort(),
      );
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("gate 1 re-renderizado depois do Stage 2 mantém a marca do resumo curto", () => {
    const ed = setupEdition();
    try {
      const downloads = readSourceDownloads(join(ed, "_internal"));
      const a = { url: MS, title: "MS", date: "2026-11-24", summary: "Microsoft lança modelos.", verify_verdict: "accessible" } as unknown as Article;
      assert.equal(sourceNotReadMarker(a, downloads), "📄❌ (fonte não lida: resumo de 24 caracteres (mínimo 60))");
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });
});

function readApproved(ed: string): unknown {
  return JSON.parse(readFileSync(join(ed, "_internal", "01-approved.json"), "utf8"));
}
