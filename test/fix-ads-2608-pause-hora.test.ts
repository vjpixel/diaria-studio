/**
 * test/fix-ads-2608-pause-hora.test.ts (#8242)
 *
 * Cobre só as 2 funções PURAS de `scripts/fix-ads-2608-pause-hora.ts` (o
 * script em si é um one-off de I/O sobre `data/`, fora do escopo de teste
 * automatizado — mesma disciplina de `scripts/ads-test-d0.ts`). Regressão:
 * garante que o texto de `revisao.motivo`/`fonte` (CSV) é reescrito sem
 * deixar `09h10` residual e sem tocar nada além do texto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fixMotivo, fixFonteText } from "../scripts/fix-ads-2608-pause-hora.ts";

describe("#8242 — fix-ads-2608-pause-hora: fixMotivo", () => {
  it("troca só o trecho da hora errada, preservando o resto do texto", () => {
    const before =
      "pausa simetrica dos 3 bracos 09/09 09h10 -> retomada 17/09 ~00h16 BRT a pedido do editor; fim_janela/coorte_madura/apuracao recalculados mantendo 15 dias completos de veiculacao (05-08/09 + 17-27/09; 09/09 parcial excluido).";
    const after = fixMotivo(before);
    assert.ok(!after.includes("09h10"), "não deve sobrar '09h10' no motivo corrigido");
    assert.ok(after.includes("16h05 (Google/Meta) / 16h18 (Microsoft)"));
    assert.ok(after.includes("retomada 17/09 ~00h16 BRT a pedido do editor"), "resto do texto preservado");
  });

  it("idempotente: motivo já corrigido não muda de novo", () => {
    const already = fixMotivo("pausa simetrica dos 3 bracos 09/09 09h10 -> retomada 17/09");
    assert.equal(fixMotivo(already), already);
  });
});

describe("#8242 — fix-ads-2608-pause-hora: fixFonteText", () => {
  it("troca '~09h10 BRT' (com til) sem deixar '09h10' residual", () => {
    const before = "CAMPANHA PAUSED desde 09/09 ~09h10 BRT (pausa total a pedido do editor, edicoes.jsonl).";
    const after = fixFonteText(before);
    assert.ok(!after.includes("09h10"));
    assert.ok(after.includes("desde 09/09 16h05 BRT (Google/Meta) / 16h18 (Microsoft)"));
  });

  it("troca '09h10 BRT' (sem til) sem deixar '09h10' residual", () => {
    const before = "PAUSADO nos 3 bracos desde 09/09 09h10 BRT (pedido do editor) ate a retomada de 17/09 ~00h16 BRT: gasto do dia R$ 0,00.";
    const after = fixFonteText(before);
    assert.ok(!after.includes("09h10"));
    assert.ok(after.includes("desde 09/09 16h05 BRT (Google/Meta) / 16h18 (Microsoft)"));
    // resto do texto (números, datas) intacto
    assert.ok(after.includes("ate a retomada de 17/09 ~00h16 BRT: gasto do dia R$ 0,00."));
  });

  it("texto sem '09h10' passa inalterado", () => {
    const text = "gasto: Google Ads API GAQL, sem menção de pausa aqui.";
    assert.equal(fixFonteText(text), text);
  });
});
