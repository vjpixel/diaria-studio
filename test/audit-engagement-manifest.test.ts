/**
 * audit-engagement-manifest.test.ts (#7197)
 *
 * Cobre `readActualCounts` — o único helper de I/O do script, que traduz o
 * manifest + diretório em disco no `Map<post_id, count>` que alimenta
 * `reconcileManifestWithDisk` (lógica pura coberta em
 * `test/beehiiv-engagement-manifest.test.ts`). Sem exercitar `main()`
 * diretamente (mesmo padrão dos outros scripts deste módulo — I/O de CLI
 * fica sem teste unitário, só os helpers exportados).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { readActualCounts, readLineShapeReports, auditVerdict, postsNeedingAnchor } from "../scripts/audit-engagement-manifest.ts";
import type { EngagementManifest, LineShapeReport } from "../scripts/lib/beehiiv-engagement-manifest.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "audit-engagement-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("readActualCounts", () => {
  it("conta linhas reais do .jsonl de cada post_id do manifest", () => {
    const outDir = setup();
    writeFileSync(resolve(outDir, "post_1.jsonl"), '{"subscriber_id":"a"}\n{"subscriber_id":"b"}\n');
    writeFileSync(resolve(outDir, "post_2.jsonl"), '{"subscriber_id":"c"}\n');
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [
        { post_id: "post_1", status: "ok", count: 2 },
        { post_id: "post_2", status: "ok", count: 1 },
      ],
    };
    const counts = readActualCounts(manifest, outDir);
    assert.equal(counts.get("post_1"), 2);
    assert.equal(counts.get("post_2"), 1);
  });

  it("post_id sem .jsonl no disco conta como 0 (nunca lança)", () => {
    const outDir = setup();
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_fantasma", status: "ok", count: 40 }],
    };
    const counts = readActualCounts(manifest, outDir);
    assert.equal(counts.get("post_fantasma"), 0);
  });

  it("ignora linhas em branco no final do jsonl (mesma tolerância de countExistingLines)", () => {
    const outDir = setup();
    writeFileSync(resolve(outDir, "post_1.jsonl"), '{"a":1}\n{"a":2}\n\n');
    const manifest: EngagementManifest = { generated_at: "t", posts: [{ post_id: "post_1", status: "ok", count: 2 }] };
    assert.equal(readActualCounts(manifest, outDir).get("post_1"), 2);
  });
});

describe("auditVerdict — o modo degradado nunca se declara completo (#7197)", () => {
  it("sem --skip-recipients e com a ancora cobrindo todos os posts: completo", () => {
    assert.equal(auditVerdict(false, 0), "completo");
  });

  it("--skip-recipients nunca da veredito completo, nem com a ancora integralmente disponivel", () => {
    // Sem `recipients`, a auditoria so compara manifest x disco — par que bate
    // em 256/256 posts do acervo real, inclusive nos 191 truncados. Chamar isso
    // de "acervo integro" foi o erro que a issue documenta.
    assert.equal(auditVerdict(true, 0), "parcial-sem-ancora");
  });

  it("ancora parcialmente indisponivel degrada o veredito em vez de silenciar", () => {
    assert.equal(auditVerdict(false, 3), "parcial-ancora-incompleta");
  });

  it("--skip-recipients tem precedencia sobre a contagem de indisponiveis", () => {
    assert.equal(auditVerdict(true, 3), "parcial-sem-ancora");
  });
});

describe("readLineShapeReports — guard de shape por linha (#7417)", () => {
  const good = '{"subscriber_id":"0987bafd-e2db-49dd-b63d-3bbd5d8f6f6b","email":"orobobraga@gmail.com","status":"delivered","timestamp":"2026-03-18T07:14:36Z"}\n';
  const placeholder = '{"subscriber_id":"sub1"}\n';

  it("post com todas as linhas válidas: 0 violações", () => {
    const outDir = setup();
    writeFileSync(resolve(outDir, "post_ok.jsonl"), good.repeat(3));
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_ok", status: "ok", count: 3 }],
    };
    const report = readLineShapeReports(manifest, outDir).get("post_ok") as LineShapeReport;
    assert.equal(report.total, 3);
    assert.equal(report.violations.length, 0);
  });

  it("reproduz o #7417: 100 linhas placeholder → 100 violações", () => {
    const outDir = setup();
    writeFileSync(resolve(outDir, "post_077f565f.jsonl"), Array.from({ length: 100 }, (_, i) => `{"subscriber_id":"sub${i + 1}"}\n`).join(""));
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_077f565f", status: "ok", count: 100 }],
    };
    const report = readLineShapeReports(manifest, outDir).get("post_077f565f") as LineShapeReport;
    assert.equal(report.total, 100);
    assert.equal(report.violations.length, 100);
    assert.ok(report.violations[0].error.includes("subscriber_id"));
  });

  it("post sem .jsonl em disco: não entra no mapa (já pending pela contagem)", () => {
    const outDir = setup();
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_ghost", status: "ok", count: 40 }],
    };
    assert.equal(readLineShapeReports(manifest, outDir).has("post_ghost"), false);
  });

  it("mistura: 2 boas + 1 inválida → 1 violação na linha 3", () => {
    const outDir = setup();
    writeFileSync(
      resolve(outDir, "post_mixed.jsonl"),
      good + good + placeholder,
    );
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_mixed", status: "ok", count: 3 }],
    };
    const report = readLineShapeReports(manifest, outDir).get("post_mixed") as LineShapeReport;
    assert.equal(report.total, 3);
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].line, 3);
  });

  it("ignora linhas em branco no final do jsonl (mesma tolerância de countExistingLines)", () => {
    const outDir = setup();
    writeFileSync(resolve(outDir, "post_ok.jsonl"), good + "\n\n");
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_ok", status: "ok", count: 1 }],
    };
    const report = readLineShapeReports(manifest, outDir).get("post_ok") as LineShapeReport;
    assert.equal(report.total, 1);
    assert.equal(report.violations.length, 0);
  });

  it("linha JSON malformada não faz o parse -- registrada como violação, não throw", () => {
    const outDir = setup();
    writeFileSync(resolve(outDir, "post_bad.jsonl"), good + placeholder + "not-json\n");
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_bad", status: "ok", count: 3 }],
    };
    const report = readLineShapeReports(manifest, outDir).get("post_bad") as LineShapeReport;
    assert.equal(report.total, 3);
    assert.equal(report.violations.length, 2, "1 placeholder + 1 JSON inválido");
    const parseViolation = report.violations.find((v) => v.error.includes("JSON parse falhou"));
    assert.ok(parseViolation, "deve existir violação de parse falho");
    assert.equal(parseViolation!.line, 3);
    const placeholderViolation = report.violations.find((v) => v.error.includes("subscriber_id"));
    assert.equal(placeholderViolation!.line, 2);
  });
});

describe("postsNeedingAnchor — a ancora so julga o que pode julgar (#7197)", () => {
  const manifest: EngagementManifest = {
    generated_at: "t",
    posts: [
      { post_id: "ok_1", status: "ok", count: 10 },
      { post_id: "pend", status: "pending" },
      { post_id: "part", status: "partial", count: 3 },
      { post_id: "err", status: "error" },
      { post_id: "na", status: "not_applicable" },
      { post_id: "ok_2", status: "ok", count: 20 },
    ],
  };

  it("so entradas ok — as demais nem sao consultadas por reconcileManifestWithDisk", () => {
    assert.deepEqual(postsNeedingAnchor(manifest).map((e) => e.post_id), ["ok_1", "ok_2"]);
  });

  it("um post ja pending nao pode degradar o veredito da auditoria", () => {
    // Sem o filtro, um 404 num post pending entraria em `unavailable` e o
    // veredito viraria "parcial" por causa de um post que nao muda resultado
    // nenhum — alem de gastar quota da Beehiiv a toa.
    assert.equal(postsNeedingAnchor(manifest).some((e) => e.post_id === "pend"), false);
  });

  it("manifest so com entradas nao-ok nao gera nenhuma chamada", () => {
    assert.deepEqual(postsNeedingAnchor({ generated_at: "t", posts: [{ post_id: "p", status: "pending" }] }), []);
  });
});
