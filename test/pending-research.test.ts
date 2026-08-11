/**
 * test/pending-research.test.ts (#4990)
 *
 * Cobre `scripts/lib/pending-research.ts` — o marker que rastreia pedidos de
 * pesquisa nova feitos pelo editor no gate do Stage 4, garantindo que a
 * lacuna nunca fica silenciosa (incidente #4990, edição 260811: USE MELHOR
 * pedido no gate, pesquisa nunca completada, seção sumiu da edição publicada
 * sem nenhum aviso).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  writePendingResearch,
  readPendingResearch,
  resolvePendingResearch,
  checkPendingResearch,
} from "../scripts/lib/pending-research.ts";
import { makeEditionDir } from "./_helpers/make-edition-dir.ts";

function writeApproved(dir: string, buckets: Record<string, unknown[]>): void {
  writeFileSync(
    resolve(dir, "_internal", "01-approved.json"),
    JSON.stringify(buckets),
  );
}

describe("writePendingResearch / readPendingResearch", () => {
  it("grava e lê o marker com status pending", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      const path = writePendingResearch(dir, "use_melhor", "mais 2 tutoriais de RAG");
      assert.ok(existsSync(path));
      const marker = readPendingResearch(dir);
      assert.equal(marker?.bucket, "use_melhor");
      assert.equal(marker?.request, "mais 2 tutoriais de RAG");
      assert.equal(marker?.status, "pending");
      assert.ok(marker?.requestedAt);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("sem marker → readPendingResearch retorna null", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      assert.equal(readPendingResearch(dir), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("marker corrompido (JSON inválido) → readPendingResearch retorna null (fail-soft)", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      writeFileSync(resolve(dir, "_internal", "pending-research.json"), "{not json");
      assert.equal(readPendingResearch(dir), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("2º write sobrescreve o 1º (não é fila)", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      writePendingResearch(dir, "use_melhor", "pedido 1");
      writePendingResearch(dir, "radar", "pedido 2");
      const marker = readPendingResearch(dir);
      assert.equal(marker?.bucket, "radar");
      assert.equal(marker?.request, "pedido 2");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("resolvePendingResearch", () => {
  it("marca status resolved com resolvedAt + resolvedReason", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      writePendingResearch(dir, "use_melhor", "pedido");
      const changed = resolvePendingResearch(dir, "editor desistiu");
      assert.equal(changed, true);
      const marker = readPendingResearch(dir);
      assert.equal(marker?.status, "resolved");
      assert.equal(marker?.resolvedReason, "editor desistiu");
      assert.ok(marker?.resolvedAt);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("sem marker → no-op, retorna false", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      assert.equal(resolvePendingResearch(dir), false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("já resolvido → no-op idempotente, retorna false", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      writePendingResearch(dir, "use_melhor", "pedido");
      resolvePendingResearch(dir, "motivo 1");
      const changed2 = resolvePendingResearch(dir, "motivo 2");
      assert.equal(changed2, false);
      // Preserva o resolvedReason original — não sobrescreve em cima de já-resolvido.
      assert.equal(readPendingResearch(dir)?.resolvedReason, "motivo 1");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("checkPendingResearch (#4990 — o guard do incidente)", () => {
  it("sem marker → { pending: false, reason: 'no-marker' }", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      const result = checkPendingResearch(dir);
      assert.deepEqual(result, { pending: false, reason: "no-marker" });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("marker já resolved → { pending: false, reason: 'already-resolved' }", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      writePendingResearch(dir, "use_melhor", "pedido");
      resolvePendingResearch(dir);
      const result = checkPendingResearch(dir);
      assert.equal(result.pending, false);
      assert.equal((result as { reason: string }).reason, "already-resolved");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it(
    "REGRESSÃO #4990: marker pending + bucket ainda vazio em 01-approved.json → pending:true, nunca silencioso",
    () => {
      const dir = makeEditionDir("pending-research-");
      try {
        writePendingResearch(dir, "use_melhor", "mais 2 tutoriais de RAG, pedido no gate");
        writeApproved(dir, { use_melhor: [], radar: [{ url: "https://x.com/1" }] });

        const result = checkPendingResearch(dir);
        assert.equal(result.pending, true);
        if (result.pending) {
          assert.equal(result.marker.bucket, "use_melhor");
          assert.equal(result.bucketCount, 0);
        }
        // O marker em disco continua pending — não foi silenciosamente descartado.
        assert.equal(readPendingResearch(dir)?.status, "pending");
      } finally {
        rmSync(dir, { recursive: true });
      }
    },
  );

  it("marker pending + bucket populado → auto-resolve (caminho feliz: pesquisa foi completada)", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      writePendingResearch(dir, "use_melhor", "mais tutoriais");
      writeApproved(dir, { use_melhor: [{ url: "https://x.com/novo-tutorial" }] });

      const result = checkPendingResearch(dir);
      assert.equal(result.pending, false);
      assert.equal((result as { reason: string }).reason, "auto-resolved");
      assert.equal((result as { bucketCount: number }).bucketCount, 1);

      // Efeito colateral: o marker em disco foi de fato atualizado pra resolved.
      const marker = readPendingResearch(dir);
      assert.equal(marker?.status, "resolved");
      assert.equal(marker?.resolvedReason, "auto: bucket populado");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("marker pending + 01-approved.json ausente → tratado como bucket vazio (pending:true)", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      writePendingResearch(dir, "use_melhor", "pedido");
      // Sem writeApproved — 01-approved.json não existe.
      const result = checkPendingResearch(dir);
      assert.equal(result.pending, true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("bucket legacy 'tutorial' (pré-#1629) também conta via normalizeCategorizedBuckets", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      writePendingResearch(dir, "use_melhor", "pedido");
      writeApproved(dir, { tutorial: [{ url: "https://x.com/legacy" }] });
      const result = checkPendingResearch(dir);
      assert.equal(result.pending, false);
      assert.equal((result as { reason: string }).reason, "auto-resolved");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("--approved-json custom path é respeitado", () => {
    const dir = makeEditionDir("pending-research-");
    try {
      writePendingResearch(dir, "radar", "pedido");
      const customPath = resolve(dir, "custom-approved.json");
      writeFileSync(customPath, JSON.stringify({ radar: [{ url: "https://x.com/1" }] }));
      const result = checkPendingResearch(dir, customPath);
      assert.equal(result.pending, false);
      assert.equal((result as { reason: string }).reason, "auto-resolved");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
