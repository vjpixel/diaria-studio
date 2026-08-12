/**
 * test/clarice-abc-state.test.ts (#5055)
 *
 * Cobre `scripts/lib/clarice-abc-state.ts` — o estado durável do teste A/B/C
 * de assunto da Clarice News.
 *
 * Os testes aqui existem pra travar as DUAS invariantes que a #5055 pediu e
 * que, sem teste, um refactor bem-intencionado desfaz sem perceber:
 *
 *   1. **`encerrado` nunca vira `aberto` por recálculo.** Nenhuma função deste
 *      módulo é chamada por caminho automático nenhum; só `reopenClariceAbcTest`
 *      volta atrás. O teste de integração que fecha isso do lado do consumidor
 *      (recomendação recalculada NÃO reabre) vive em `clarice-wave-plan.test.ts`.
 *   2. **`encerrado` sem assunto não trava nada.** Um estado escrito pela
 *      metade (crash no meio da escrita, sync do OneDrive) não pode virar um
 *      assunto vazio/undefined saindo pra milhares de pessoas — cai pra
 *      `aberto` COM aviso, que é chato mas conhecido.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readClariceAbcState,
  closeClariceAbcTest,
  reopenClariceAbcTest,
  lockedSubjectFromState,
  describeAbcState,
  clariceAbcStatePath,
} from "../scripts/lib/clarice-abc-state.ts";

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "abc-state-"));
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Escreve conteúdo cru no arquivo de estado (para os casos inválidos). */
function writeRaw(root: string, content: string): void {
  writeFileSync(clariceAbcStatePath(root), content, "utf8");
}

/** Coleta avisos em vez de poluir o stdout do runner. */
function collector(): { warns: string[]; onInvalid: (m: string) => void } {
  const warns: string[] = [];
  return { warns, onInvalid: (m) => warns.push(m) };
}

describe("readClariceAbcState — as três leituras", () => {
  it("arquivo AUSENTE → aberto, sem aviso (default = comportamento pré-#5055)", () => {
    withRoot((root) => {
      const c = collector();
      const s = readClariceAbcState(root, { onInvalid: c.onInvalid });
      assert.equal(s.status, "aberto");
      assert.equal(s.subject, null);
      assert.equal(s.invalidReason, null);
      assert.deepEqual(c.warns, []);
    });
  });

  it("arquivo VÁLIDO e encerrado → devolve o assunto travado", () => {
    withRoot((root) => {
      closeClariceAbcTest(root, { subject: "Assunto vencedor", winner: "A", rationale: "decidido no chat" });
      const c = collector();
      const s = readClariceAbcState(root, { onInvalid: c.onInvalid });
      assert.equal(s.status, "encerrado");
      assert.equal(s.subject, "Assunto vencedor");
      assert.equal(s.winner, "A");
      assert.equal(s.rationale, "decidido no chat");
      assert.equal(s.decidedBy, "editor");
      assert.ok(s.decidedAt, "decidedAt deve ser gravado");
      assert.equal(s.invalidReason, null);
      assert.deepEqual(c.warns, []);
    });
  });

  it("JSON inválido → aberto COM aviso (nunca silencioso)", () => {
    withRoot((root) => {
      writeRaw(root, "{ isso não é json");
      const c = collector();
      const s = readClariceAbcState(root, { onInvalid: c.onInvalid });
      assert.equal(s.status, "aberto");
      assert.ok(s.invalidReason, "invalidReason deve explicar a queda");
      assert.equal(c.warns.length, 1);
      assert.match(c.warns[0], /ABERTO/);
    });
  });

  it("status desconhecido → aberto COM aviso", () => {
    withRoot((root) => {
      writeRaw(root, JSON.stringify({ status: "pausado", subject: "x" }));
      const c = collector();
      const s = readClariceAbcState(root, { onInvalid: c.onInvalid });
      assert.equal(s.status, "aberto");
      assert.match(String(s.invalidReason), /status/);
      assert.equal(c.warns.length, 1);
    });
  });

  it('INVARIANTE 2: encerrado SEM subject → aberto COM aviso, nunca "encerrado com assunto vazio"', () => {
    withRoot((root) => {
      for (const half of [{ status: "encerrado" }, { status: "encerrado", subject: "" }, { status: "encerrado", subject: "   " }, { status: "encerrado", subject: 42 }]) {
        writeRaw(root, JSON.stringify(half));
        const c = collector();
        const s = readClariceAbcState(root, { onInvalid: c.onInvalid });
        assert.equal(s.status, "aberto", `estado pela metade não pode travar: ${JSON.stringify(half)}`);
        assert.equal(s.subject, null);
        assert.equal(lockedSubjectFromState(s), null);
        assert.equal(c.warns.length, 1);
      }
    });
  });

  it("subject com espaço sobrando (arquivo hand-edited) é TRIMADO na leitura, não repassado cru", () => {
    // Achado do silent-failure-hunter: só a escrita trimava, então um arquivo
    // editado à mão entrava como válido e o espaço ia parar no assunto da
    // campanha, sem aviso nenhum.
    withRoot((root) => {
      writeRaw(root, JSON.stringify({ status: "encerrado", subject: "  Assunto com espaço  " }));
      const c = collector();
      const s = readClariceAbcState(root, { onInvalid: c.onInvalid });
      assert.equal(s.status, "encerrado");
      assert.equal(s.subject, "Assunto com espaço");
      assert.deepEqual(c.warns, [], "trimável não é inválido — não avisa, só normaliza");
    });
  });

  it("arquivo com status aberto explícito → aberto, sem aviso", () => {
    withRoot((root) => {
      reopenClariceAbcTest(root, { rationale: "novo teste em setembro" });
      const c = collector();
      const s = readClariceAbcState(root, { onInvalid: c.onInvalid });
      assert.equal(s.status, "aberto");
      assert.equal(s.rationale, "novo teste em setembro");
      assert.equal(s.invalidReason, null);
      assert.deepEqual(c.warns, []);
    });
  });
});

describe("close / reopen", () => {
  it("INVARIANTE 1: só reopen sai de encerrado — reler não reabre", () => {
    withRoot((root) => {
      closeClariceAbcTest(root, { subject: "Travado" });
      // Reler N vezes (é o que o recálculo diário faz) nunca muda o estado.
      for (let i = 0; i < 5; i++) {
        assert.equal(readClariceAbcState(root).status, "encerrado");
      }
      reopenClariceAbcTest(root);
      assert.equal(readClariceAbcState(root).status, "aberto");
    });
  });

  it("close com subject vazio é ERRO — o arquivo inválido nem chega a existir", () => {
    withRoot((root) => {
      assert.throws(() => closeClariceAbcTest(root, { subject: "   " }), /subject/);
      const c = collector();
      assert.equal(readClariceAbcState(root, { onInvalid: c.onInvalid }).status, "aberto");
      assert.deepEqual(c.warns, [], "nenhum arquivo foi escrito, então não há o que avisar");
    });
  });

  it("close grava JSON legível e re-lido idempotentemente (round-trip)", () => {
    withRoot((root) => {
      const written = closeClariceAbcTest(root, {
        subject: "Notícias do mês sobre IA: Agentes saem do controle",
        rationale: "teste encerrado pelo editor",
        now: () => new Date("2026-08-12T00:00:00.000Z"),
      });
      const onDisk = JSON.parse(readFileSync(clariceAbcStatePath(root), "utf8"));
      assert.deepEqual(onDisk, written);
      assert.equal(written.decidedAt, "2026-08-12T00:00:00.000Z");
      const reread = readClariceAbcState(root);
      assert.equal(reread.subject, written.subject);
      assert.equal(reread.decidedAt, written.decidedAt);
    });
  });

  it("winner é opcional — encerramento editorial sem vencedora estatística é válido", () => {
    withRoot((root) => {
      const s = closeClariceAbcTest(root, { subject: "X" });
      assert.equal(s.winner, null);
      assert.equal(readClariceAbcState(root).status, "encerrado");
    });
  });
});

describe("lockedSubjectFromState / describeAbcState", () => {
  it("lockedSubjectFromState devolve null quando aberto e o assunto quando encerrado", () => {
    assert.equal(lockedSubjectFromState({ status: "aberto", subject: null, winner: null, decidedAt: null, decidedBy: null, rationale: null }), null);
    assert.equal(
      lockedSubjectFromState({ status: "encerrado", subject: "S", winner: null, decidedAt: null, decidedBy: null, rationale: null }),
      "S",
    );
  });

  it("describeAbcState fala o assunto travado e a data (visibilidade, item 5 da #5055)", () => {
    const txt = describeAbcState({
      status: "encerrado",
      subject: "Assunto X",
      winner: "A",
      decidedAt: "2026-08-12T03:00:00.000Z",
      decidedBy: "editor",
      rationale: null,
    });
    assert.match(txt, /ENCERRADO/);
    assert.match(txt, /Assunto X/);
    assert.match(txt, /2026-08-12/);
    assert.match(txt, /célula A/);
    assert.match(describeAbcState({ status: "aberto", subject: null, winner: null, decidedAt: null, decidedBy: null, rationale: null }), /ABERTO/);
  });
});
