/**
 * test/kit-inactive-reativacao-8192.test.ts (#8192)
 *
 * Corte de 72h desde o e-mail de confirmação do Kit, exclusão de fixtures,
 * candidatos ao MV (dedup pelo store) e cobertura MV medida só sobre o pool
 * da rodada.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  selectKitInactivePastDoiWindow,
  KIT_DOI_WAIT_HOURS,
} from "../scripts/lib/kit-inactive-reativacao.ts";
import { computeKitMvCandidates } from "../scripts/verify-kit-inactive-emails-mv.ts";
import { computeKitMvCoverage } from "../scripts/sync-kit-inactive-to-brevo.ts";
import type { KitSubscriberSummary } from "../scripts/lib/kit-subscribers.ts";
import type { BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const H = 3600 * 1000;

function sub(id: number, email: string, createdMs: number | string): KitSubscriberSummary {
  return {
    id,
    email_address: email,
    state: "inactive",
    created_at: typeof createdMs === "number" ? new Date(createdMs).toISOString() : createdMs,
  };
}

describe("selectKitInactivePastDoiWindow — corte de 72h (#8192)", () => {
  it("janela padrão é 72h", () => {
    assert.equal(KIT_DOI_WAIT_HOURS, 72);
  });

  it("borda: exatamente 72h entra; 72h menos 1s fica de fora", () => {
    const sel = selectKitInactivePastDoiWindow(
      [sub(1, "exato@x.com.br", NOW - 72 * H), sub(2, "quase@x.com.br", NOW - 72 * H + 1000)],
      NOW,
    );
    assert.deepEqual(sel.eligible.map((s) => s.id), [1]);
    assert.equal(sel.tooRecent, 1);
  });

  it("cadastro antigo entra; recém-criado não", () => {
    const sel = selectKitInactivePastDoiWindow(
      [sub(1, "velho@x.com.br", NOW - 30 * 24 * H), sub(2, "novo@x.com.br", NOW - 2 * H)],
      NOW,
    );
    assert.deepEqual(sel.eligible.map((s) => s.id), [1]);
  });

  it("created_at ausente/inválido é excluído (fail-safe), nunca tratado como antigo", () => {
    const sel = selectKitInactivePastDoiWindow([sub(1, "a@x.com.br", ""), sub(2, "b@x.com.br", "não-é-data")], NOW);
    assert.equal(sel.eligible.length, 0);
    assert.equal(sel.invalidCreatedAt, 2);
  });

  it("fixtures de teste ficam de fora mesmo com mais de 72h", () => {
    const old = NOW - 10 * 24 * H;
    const sel = selectKitInactivePastDoiWindow(
      [sub(1, "vjpixel+kittest@gmail.com", old), sub(2, "teste-funil@x.com.br", old), sub(3, "real@x.com.br", old)],
      NOW,
    );
    assert.deepEqual(sel.eligible.map((s) => s.id), [3]);
    assert.equal(sel.fixtures, 2);
  });
});

describe("computeKitMvCandidates — só quem ainda não está no store (#8192)", () => {
  it("exclui qualquer status já tratado no store e normaliza/dedup", () => {
    const store = {
      contacts: [
        { email: "ja@x.com.br", beehiiv_subscription_id: "kit:1", status: "unsubscribed", opens_count: 0, sends_count: 0 },
      ],
    } as unknown as BrevoDiariaStore;
    const out = computeKitMvCandidates([" JA@x.com.br", "Novo@x.com.br", "novo@x.com.br "], store);
    assert.deepEqual(out, ["novo@x.com.br"]);
  });
});

describe("computeKitMvCoverage — cobertura sobre o pool da rodada (#8192)", () => {
  it("só ok/catch_all contam como verificados; rejeitado/unknown contam como processados", () => {
    const { verified, coverage } = computeKitMvCoverage(["a@x", "b@x", "c@x", "d@x"], {
      "a@x": { result: "ok" },
      "b@x": { result: "catch_all" },
      "c@x": { result: "invalid" },
      "d@x": { result: "unknown" },
    });
    assert.deepEqual([...verified].sort(), ["a@x", "b@x"]);
    assert.deepEqual(coverage, { processedCount: 4, poolSize: 4 });
  });

  it("entradas antigas do checkpoint fora do pool NÃO inflam a cobertura", () => {
    const { coverage } = computeKitMvCoverage(["novo@x"], {
      "antigo1@x": { result: "ok" },
      "antigo2@x": { result: "ok" },
    });
    assert.deepEqual(coverage, { processedCount: 0, poolSize: 1 });
  });
});
