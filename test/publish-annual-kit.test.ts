/**
 * test/publish-annual-kit.test.ts (#7569)
 *
 * O publisher da anual é o único ponto desta skill com efeito externo real —
 * ele cria um broadcast na base própria. Os três invariantes que estes testes
 * travam são justamente os que ninguém percebe quando quebram:
 *
 * 1. **Sempre rascunho.** O broadcast real nasce com `send_at: null`; só o
 *    broadcast descartável de teste tem data de envio. Perder esse `null`
 *    num refactor mandaria a edição para a base inteira sem gate.
 * 2. **O guard de backend.** Rodar com `backend != "kit"` publicaria no lugar
 *    errado (#5608).
 * 3. **Idempotência.** Estado corrompido tratado como "ainda não existe" cria
 *    um SEGUNDO rascunho da mesma edição, e o editor só descobre olhando o
 *    Kit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkKitBackend, readState, normalizeChosenSubject } from "../scripts/publish-annual-kit.ts";
import { tipoFromSlug } from "../scripts/lib/anual/annual-window.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("assunto sem prefixo numérico (#7587 item 6)", () => {
  it("tira o prefixo `N. ` da linha gravada em 02-chosen-subject.txt", () => {
    assert.equal(normalizeChosenSubject("1. Um ano de IA em cinco atos"), "Um ano de IA em cinco atos");
    assert.equal(normalizeChosenSubject("3. Doze meses, cinco viradas\n"), "Doze meses, cinco viradas");
  });

  it("assunto sem prefixo (ex: gravado por outro caminho) passa intocado", () => {
    assert.equal(normalizeChosenSubject("Um ano de IA em cinco atos"), "Um ano de IA em cinco atos");
  });

  it("string vazia continua vazia (o caller decide o que fazer com assunto vazio)", () => {
    assert.equal(normalizeChosenSubject(""), "");
    assert.equal(normalizeChosenSubject("   \n"), "");
  });
});

describe("guard de backend (#5608)", () => {
  it("aceita apenas backend kit", () => {
    assert.equal(checkKitBackend({ publishing: { newsletter: { backend: "kit" } } }).ok, true);
  });

  it("recusa qualquer outro backend, dizendo qual encontrou", () => {
    const r = checkKitBackend({ publishing: { newsletter: { backend: "beehiiv" } } });
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("beehiiv"));
  });

  it("config sem a chave também é recusa, não passe-livre", () => {
    assert.equal(checkKitBackend({}).ok, false);
    assert.equal(checkKitBackend({ publishing: {} }).ok, false);
  });
});

describe("tipo de rodada a partir do slug", () => {
  it("reconhece as duas rodadas", () => {
    assert.equal(tipoFromSlug("2026-aniversario"), "aniversario");
    assert.equal(tipoFromSlug("2026-janeiro"), "janeiro");
  });

  it("slug com erro de digitação FALHA em vez de virar janeiro em silêncio", () => {
    // O modo de falha que isto evita: `2026-anivesario` tratado como rodada
    // de janeiro faria o lint deixar de exigir o bloco de aniversário —
    // justamente na edição que existe por causa dele.
    assert.throws(() => tipoFromSlug("2026-anivesario"), /slug inválido/);
    assert.throws(() => tipoFromSlug("aniversario"), /slug inválido/);
    assert.throws(() => tipoFromSlug("2026"), /slug inválido/);
  });
});

describe("estado do broadcast (idempotência)", () => {
  function withStateFile(content: string | null): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "annual-state-"));
    const path = join(dir, "05-published.json");
    if (content !== null) writeFileSync(path, content);
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("arquivo ausente é o primeiro run — devolve null", () => {
    const { path, cleanup } = withStateFile(null);
    try {
      assert.equal(readState(path), null);
    } finally {
      cleanup();
    }
  });

  it("estado íntegro volta com o broadcast_id", () => {
    const { path, cleanup } = withStateFile(JSON.stringify({ broadcast_id: 42, slug: "2026-aniversario" }));
    try {
      assert.equal(readState(path)?.broadcast_id, 42);
    } finally {
      cleanup();
    }
  });

  it("JSON corrompido LANÇA — tratar como ausente criaria um 2º rascunho", () => {
    const { path, cleanup } = withStateFile('{"broadcast_id": 42, "slug"');
    try {
      assert.throws(() => readState(path), /2º rascunho/);
    } finally {
      cleanup();
    }
  });

  it("JSON válido mas sem broadcast_id também lança", () => {
    // Escrita truncada pode deixar `{}` — sintaticamente válido, inútil na
    // prática, e levaria `updateBroadcast(undefined, ...)` adiante.
    const { path, cleanup } = withStateFile("{}");
    try {
      assert.throws(() => readState(path), /broadcast_id/);
    } finally {
      cleanup();
    }
  });
});

describe("invariante: o broadcast real nasce rascunho", () => {
  it("o único send_at do script é o do broadcast DESCARTÁVEL de teste", () => {
    // Guard textual, não de execução: o caminho real fala com a API do Kit e
    // não dá pra exercitar aqui sem mock da rede. O que se trava é a forma —
    // `send_at: null` no broadcast de produção, e a única data de envio no
    // arquivo pertencendo ao bloco `--send-test`.
    const src = readFileSync(resolve(ROOT, "scripts/publish-annual-kit.ts"), "utf8");

    assert.ok(
      /send_at:\s*null,\s*\/\/ rascunho/.test(src),
      "o createBroadcast de produção precisa manter `send_at: null` com o comentário que explica por quê",
    );

    const sendAts = src.match(/send_at:\s*[^,\n]+/g) ?? [];
    assert.equal(sendAts.length, 2, `esperado 2 ocorrências de send_at (produção + teste), achei ${sendAts.length}`);
    assert.ok(sendAts.some((s) => s.includes("null")));
    assert.ok(
      sendAts.some((s) => s.includes("new Date().toISOString()")),
      "a única data de envio é a do broadcast descartável de teste",
    );
  });

  it("o broadcast de produção vai para toda a base; o de teste, só para a tag de teste", () => {
    const src = readFileSync(resolve(ROOT, "scripts/publish-annual-kit.ts"), "utf8");
    assert.ok(src.includes("buildAllSubscribersFilter()"));
    assert.ok(src.includes("buildTestSendFilter(tagId)"));
  });
});
