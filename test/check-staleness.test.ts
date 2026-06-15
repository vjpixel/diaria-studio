import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isStale,
  lagMinutes,
  evaluateStaleness,
  STAGE_CHECKS,
  isImageFile,
  computeFileHash,
  writeImageHashSidecar,
  readImageHashSidecar,
} from "../scripts/check-staleness.ts";

describe("isStale (#120)", () => {
  it("detecta upstream mais novo que downstream com gap grande", () => {
    const downstream = Date.parse("2026-04-24T19:33:34Z");
    const upstream = Date.parse("2026-04-24T22:13:13Z");
    assert.equal(isStale(downstream, upstream), true);
  });

  it("não dispara quando downstream é mais novo (caso normal)", () => {
    const downstream = Date.parse("2026-04-24T22:00:00Z");
    const upstream = Date.parse("2026-04-24T19:00:00Z");
    assert.equal(isStale(downstream, upstream), false);
  });

  it("não dispara em diferença <= tolerance (default 1s)", () => {
    const t = Date.parse("2026-04-24T20:00:00Z");
    assert.equal(isStale(t, t + 500), false);
    assert.equal(isStale(t, t + 1000), false);
    assert.equal(isStale(t, t + 1001), true);
  });

  it("tolerance customizada (5s pra clock skew)", () => {
    const t = Date.parse("2026-04-24T20:00:00Z");
    assert.equal(isStale(t, t + 4000, 5000), false);
    assert.equal(isStale(t, t + 6000, 5000), true);
  });

  it("timestamps idênticos não disparam", () => {
    const t = Date.parse("2026-04-24T20:00:00Z");
    assert.equal(isStale(t, t), false);
  });
});

describe("lagMinutes", () => {
  it("calcula minutos arredondados", () => {
    const d = Date.parse("2026-04-24T19:33:34Z");
    const u = Date.parse("2026-04-24T22:13:13Z");
    assert.equal(lagMinutes(d, u), 160); // ~159.65 → 160
  });

  it("zero quando iguais", () => {
    const t = Date.parse("2026-04-24T20:00:00Z");
    assert.equal(lagMinutes(t, t), 0);
  });
});

describe("evaluateStaleness — orchestration (#120)", () => {
  function mkGetter(mtimes: Record<string, number | null>) {
    return (path: string) => mtimes[path] ?? null;
  }

  it("Stage 6: 03-social.md mais antigo que 02-reviewed.md → flag", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T19:33:34Z"),
      "02-reviewed.md": Date.parse("2026-04-24T22:13:13Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    const social = stale.find((s) => s.downstream === "03-social.md");
    assert.ok(social);
    assert.equal(social!.upstream, "02-reviewed.md");
    assert.equal(social!.lag_minutes, 160);
  });

  it("#1710: Stage 6 imagem 04-d1-2x1 mais antiga que SEU PROMPT também flag", () => {
    const get = mkGetter({
      "04-d1-2x1.jpg": Date.parse("2026-04-24T18:00:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T22:00:00Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    const img = stale.find((s) => s.downstream === "04-d1-2x1.jpg");
    assert.ok(img);
    assert.equal(img!.upstream, "_internal/02-d1-prompt.md");
  });

  it("#1710: imagem mais nova que o PROMPT mas mais velha que 02-reviewed → NÃO stale", () => {
    // O FP do #1710: editor ajusta texto no 02-reviewed pós-imagem (ou sync pull
    // toca o mtime). A imagem deriva do prompt, não do reviewed — não é stale.
    const get = mkGetter({
      "04-d1-2x1.jpg": Date.parse("2026-04-24T20:00:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T19:00:00Z"), // prompt + velho que img
      "02-reviewed.md": Date.parse("2026-04-24T22:00:00Z"), // reviewed editado DEPOIS
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.deepEqual(stale.filter((s) => s.downstream.startsWith("04-d")), []);
  });

  it("Stage 6 limpo: imagens depois dos prompts + social depois do reviewed", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T22:30:00Z"),
      "02-reviewed.md": Date.parse("2026-04-24T22:13:13Z"),
      "04-d1-2x1.jpg": Date.parse("2026-04-24T22:35:00Z"),
      "04-d1-1x1.jpg": Date.parse("2026-04-24T22:35:00Z"),
      "04-d2-1x1.jpg": Date.parse("2026-04-24T22:36:00Z"),
      "04-d3-1x1.jpg": Date.parse("2026-04-24T22:37:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T22:13:13Z"),
      "_internal/02-d2-prompt.md": Date.parse("2026-04-24T22:13:13Z"),
      "_internal/02-d3-prompt.md": Date.parse("2026-04-24T22:13:13Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.deepEqual(stale, []);
  });

  it("downstream ausente: skip silencioso (não trava)", () => {
    const get = mkGetter({
      "02-reviewed.md": Date.parse("2026-04-24T22:00:00Z"),
      // 03-social.md, 04-*.jpg ausentes — Stage 6 nunca rodou
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.deepEqual(stale, []);
  });

  it("upstream ausente: skip silencioso (não trava)", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T22:00:00Z"),
      // 02-reviewed.md ausente — situação anômala, mas não trava
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.deepEqual(stale, []);
  });

  it("#1413/#1710: Stage 4 checa imagem vs prompt + 03-social.md vs 02-reviewed", () => {
    const get = mkGetter({
      "04-d1-2x1.jpg": Date.parse("2026-04-24T19:00:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T22:00:00Z"), // imagem stale vs prompt
      "02-reviewed.md": Date.parse("2026-04-24T22:00:00Z"),
      "03-social.md": Date.parse("2026-04-24T19:00:00Z"), // stale vs reviewed (#1413)
    });
    const stale = evaluateStaleness(STAGE_CHECKS["4"], get);
    // Esperado: 04-d1-2x1.jpg (stale vs prompt) + 03-social.md (stale vs reviewed) = 2
    assert.equal(stale.length, 2);
    const downstreams = stale.map((s) => s.downstream);
    assert.ok(downstreams.includes("04-d1-2x1.jpg"));
    assert.ok(downstreams.includes("03-social.md"));
    assert.equal(stale.find((s) => s.downstream === "04-d1-2x1.jpg")!.upstream, "_internal/02-d1-prompt.md");
  });

  it("Stage não-mapeado: vazio", () => {
    const get = mkGetter({});
    const stale = evaluateStaleness(STAGE_CHECKS["99"] ?? [], get);
    assert.deepEqual(stale, []);
  });

  it("retorna múltiplas entries quando vários downstream estão stale", () => {
    const get = mkGetter({
      "02-reviewed.md": Date.parse("2026-04-24T22:00:00Z"),
      "03-social.md": Date.parse("2026-04-24T19:00:00Z"), // stale vs reviewed
      "04-d1-2x1.jpg": Date.parse("2026-04-24T19:00:00Z"),
      "_internal/02-d1-prompt.md": Date.parse("2026-04-24T22:00:00Z"), // d1 stale vs prompt
      "04-d2-1x1.jpg": Date.parse("2026-04-24T19:00:00Z"),
      "_internal/02-d2-prompt.md": Date.parse("2026-04-24T22:00:00Z"), // d2 stale vs prompt
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.equal(stale.length, 3); // 03-social + 04-d1-2x1 + 04-d2-1x1
  });

  it("formato ISO timestamp no output", () => {
    const get = mkGetter({
      "03-social.md": Date.parse("2026-04-24T19:33:34Z"),
      "02-reviewed.md": Date.parse("2026-04-24T22:13:13Z"),
    });
    const stale = evaluateStaleness(STAGE_CHECKS["6"], get);
    assert.match(stale[0].downstream_mtime, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(stale[0].upstream_mtime, /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("#2287 — content hash (isImageFile + sidecar + evaluateStaleness com getHashState)", () => {
  it("isImageFile detecta extensões de imagem corretamente", () => {
    assert.equal(isImageFile("04-d1-2x1.jpg"), true);
    assert.equal(isImageFile("04-d1-1x1.jpg"), true);
    assert.equal(isImageFile("04-d2-1x1.JPG"), true); // case-insensitive
    assert.equal(isImageFile("04-d3-1x1.png"), true);
    assert.equal(isImageFile("02-reviewed.md"), false);
    assert.equal(isImageFile("03-social.md"), false);
    assert.equal(isImageFile("_internal/02-d1-prompt.md"), false);
    assert.equal(isImageFile("stage-status.md"), false);
  });

  it("sidecar: writeImageHashSidecar + readImageHashSidecar round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      const imgPath = join(dir, "04-d1-2x1.jpg");
      // Escrever conteúdo fake de imagem
      writeFileSync(imgPath, Buffer.from("fake-image-bytes-12345"));
      const hash = writeImageHashSidecar(imgPath);
      assert.ok(hash !== null, "writeImageHashSidecar deve retornar hash não-null");
      assert.match(hash!, /^[0-9a-f]{64}$/, "hash deve ser SHA-256 hex (64 chars)");

      const read = readImageHashSidecar(imgPath);
      assert.equal(read, hash, "sidecar lido deve ser igual ao hash escrito");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sidecar ausente → readImageHashSidecar retorna null", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      const imgPath = join(dir, "04-d1-2x1.jpg");
      writeFileSync(imgPath, Buffer.from("img"));
      // Sem escrever sidecar
      assert.equal(readImageHashSidecar(imgPath), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("computeFileHash: mesmo conteúdo → mesmo hash; conteúdo diferente → hash diferente", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      const p1 = join(dir, "a.jpg");
      const p2 = join(dir, "b.jpg");
      const p3 = join(dir, "c.jpg");
      writeFileSync(p1, Buffer.from("same-content"));
      writeFileSync(p2, Buffer.from("same-content"));
      writeFileSync(p3, Buffer.from("different-content"));
      const h1 = computeFileHash(p1);
      const h2 = computeFileHash(p2);
      const h3 = computeFileHash(p3);
      assert.equal(h1, h2, "mesmo conteúdo → mesmo hash");
      assert.notEqual(h1, h3, "conteúdo diferente → hash diferente");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2287 FP pós-reorder: imagem com sidecar e conteúdo inalterado NÃO é stale mesmo com mtime antigo", () => {
    // Cenário: imagem foi gerada, depois renomeada (reorder de destaques).
    // Após rename: mtime da imagem < mtime do prompt (prompt renomeado = novo mtime).
    // Mas CONTEÚDO da imagem não mudou → sidecar hash bate → NÃO stale.
    const now = Date.parse("2026-06-15T10:00:00Z");
    const imgOldMtime = Date.parse("2026-06-15T08:00:00Z"); // gerada antes do reorder
    const promptNewMtime = Date.parse("2026-06-15T09:30:00Z"); // prompt renomeado = mtime novo

    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      const imgPath = join(dir, "04-d1-2x1.jpg");
      const promptPath = join(dir, "_internal/02-d1-prompt.md");
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(imgPath, Buffer.from("fake-image-content-unchanged"));
      writeFileSync(promptPath, "# prompt content");

      // Gravar sidecar com hash atual da imagem
      const savedHash = writeImageHashSidecar(imgPath);
      assert.ok(savedHash !== null);

      // Simular mtime: imagem velha, prompt novo
      const getMtime = (rel: string) => {
        if (rel === "04-d1-2x1.jpg") return imgOldMtime;
        if (rel === "_internal/02-d1-prompt.md") return promptNewMtime;
        return null;
      };

      // getHashState: retorna {current, saved} lendo sidecar do dir
      const getHashState = (rel: string) => {
        if (!isImageFile(rel)) return null;
        const fullPath = join(dir, rel);
        const saved = readImageHashSidecar(fullPath);
        if (saved === null) return null;
        const current = computeFileHash(fullPath);
        return { current, saved };
      };

      const checks = [
        { downstream: "04-d1-2x1.jpg", upstreams: ["_internal/02-d1-prompt.md"] },
      ];

      // Com getHashState: conteúdo não mudou → NÃO stale (FP eliminado)
      const staleWithHash = evaluateStaleness(checks, getMtime, 1000, getHashState);
      assert.deepEqual(
        staleWithHash,
        [],
        "imagem com sidecar e conteúdo inalterado não deve ser stale (#2287)",
      );

      // Sem getHashState (comportamento anterior): seria stale por mtime (FP)
      const staleWithoutHash = evaluateStaleness(checks, getMtime, 1000, undefined);
      assert.equal(staleWithoutHash.length, 1, "sem hash: seria FP stale por mtime (comportamento anterior)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2287: imagem regenerada (conteúdo diferente do sidecar) → IS stale", () => {
    // Cenário: imagem foi regenerada com novo conteúdo (sem atualizar sidecar manualmente).
    // Hash atual != sidecar hash → stale real.
    const imgOldMtime = Date.parse("2026-06-15T08:00:00Z");
    const promptNewMtime = Date.parse("2026-06-15T09:30:00Z");

    const dir = mkdtempSync(join(tmpdir(), "diaria-staleness-test-"));
    try {
      const imgPath = join(dir, "04-d1-2x1.jpg");
      mkdirSync(join(dir, "_internal"), { recursive: true });

      // Gravar imagem original + sidecar
      writeFileSync(imgPath, Buffer.from("original-image-content"));
      writeImageHashSidecar(imgPath);

      // Simular regeneração: sobrescrever conteúdo
      writeFileSync(imgPath, Buffer.from("new-different-image-content"));

      const getMtime = (rel: string) => {
        if (rel === "04-d1-2x1.jpg") return imgOldMtime;
        if (rel === "_internal/02-d1-prompt.md") return promptNewMtime;
        return null;
      };
      const getHashState = (rel: string) => {
        if (!isImageFile(rel)) return null;
        const saved = readImageHashSidecar(join(dir, rel));
        if (saved === null) return null;
        return { current: computeFileHash(join(dir, rel)), saved };
      };

      const checks = [
        { downstream: "04-d1-2x1.jpg", upstreams: ["_internal/02-d1-prompt.md"] },
      ];
      const stale = evaluateStaleness(checks, getMtime, 1000, getHashState);
      assert.equal(stale.length, 1, "conteúdo diferente → stale real detectado");
      assert.equal(stale[0].check_mode, "content_hash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2287: imagem sem sidecar → fallback mtime (comportamento pré-#2287)", () => {
    // Sidecar não existe (imagem gerada antes do fix) → getHashState retorna null
    // → evaluateStaleness usa mtime como antes.
    const imgOldMtime = Date.parse("2026-06-15T08:00:00Z");
    const promptNewMtime = Date.parse("2026-06-15T09:30:00Z");

    const getMtime = (rel: string) => {
      if (rel === "04-d1-2x1.jpg") return imgOldMtime;
      if (rel === "_internal/02-d1-prompt.md") return promptNewMtime;
      return null;
    };
    // getHashState sempre retorna null (sidecar ausente)
    const getHashState = (_rel: string) => null;

    const checks = [
      { downstream: "04-d1-2x1.jpg", upstreams: ["_internal/02-d1-prompt.md"] },
    ];
    const stale = evaluateStaleness(checks, getMtime, 1000, getHashState);
    // Sidecar ausente → fallback mtime → stale por mtime
    assert.equal(stale.length, 1, "sem sidecar: fallback para mtime (detecção por mtime)");
    assert.equal(stale[0].check_mode, "mtime", "fallback mtime deve ter check_mode: mtime");
  });

  it("check_mode: texto usa 'mtime', imagem com sidecar usa 'content_hash'", () => {
    const imgOldMtime = Date.parse("2026-06-15T08:00:00Z");
    const textOldMtime = Date.parse("2026-06-15T08:00:00Z");
    const newMtime = Date.parse("2026-06-15T09:30:00Z");

    const getMtime = (rel: string) => {
      if (rel === "03-social.md") return textOldMtime;
      if (rel === "02-reviewed.md") return newMtime;
      if (rel === "04-d1-2x1.jpg") return imgOldMtime;
      if (rel === "_internal/02-d1-prompt.md") return newMtime;
      return null;
    };
    // Para texto: getHashState retorna null (não é imagem)
    // Para imagem SEM sidecar: também null → fallback mtime
    const getHashState = (_rel: string) => null;

    const checks = [
      { downstream: "03-social.md", upstreams: ["02-reviewed.md"] },
      { downstream: "04-d1-2x1.jpg", upstreams: ["_internal/02-d1-prompt.md"] },
    ];
    const stale = evaluateStaleness(checks, getMtime, 1000, getHashState);
    assert.equal(stale.length, 2, "dois stale: texto + imagem (sem sidecar → mtime)");
    const social = stale.find((s) => s.downstream === "03-social.md");
    const img = stale.find((s) => s.downstream === "04-d1-2x1.jpg");
    assert.equal(social!.check_mode, "mtime");
    assert.equal(img!.check_mode, "mtime"); // sem sidecar: fallback mtime
  });
});

describe("STAGE_CHECKS config — fixture do desenho (#120)", () => {
  it("Stage 6 cobre 03-social.md + 4 imagens", () => {
    const downstreams = STAGE_CHECKS["6"].map((c) => c.downstream);
    assert.ok(downstreams.includes("03-social.md"));
    assert.ok(downstreams.includes("04-d1-2x1.jpg"));
    assert.ok(downstreams.includes("04-d1-1x1.jpg"));
    assert.ok(downstreams.includes("04-d2-1x1.jpg"));
    assert.ok(downstreams.includes("04-d3-1x1.jpg"));
  });

  it("#1710: 03-social → 02-reviewed; imagens → seu prompt (não reviewed)", () => {
    const byDown = Object.fromEntries(
      STAGE_CHECKS["6"].map((c) => [c.downstream, c.upstreams]),
    );
    assert.deepEqual(byDown["03-social.md"], ["02-reviewed.md"]);
    assert.deepEqual(byDown["04-d1-2x1.jpg"], ["_internal/02-d1-prompt.md"]);
    assert.deepEqual(byDown["04-d1-1x1.jpg"], ["_internal/02-d1-prompt.md"]);
    assert.deepEqual(byDown["04-d2-1x1.jpg"], ["_internal/02-d2-prompt.md"]);
    assert.deepEqual(byDown["04-d3-1x1.jpg"], ["_internal/02-d3-prompt.md"]);
  });

  it("#1413: Stage 4 cobre imagens + 03-social.md", () => {
    const downstreams = STAGE_CHECKS["4"].map((c) => c.downstream);
    assert.ok(downstreams.includes("03-social.md"), "social staleness deve estar coberto em S4");
    assert.ok(downstreams.includes("04-d1-2x1.jpg"));
    assert.ok(downstreams.includes("04-d2-1x1.jpg"));
  });

  it("Stage 3 checa só 03-social.md", () => {
    assert.equal(STAGE_CHECKS["3"].length, 1);
    assert.equal(STAGE_CHECKS["3"][0].downstream, "03-social.md");
  });
});
