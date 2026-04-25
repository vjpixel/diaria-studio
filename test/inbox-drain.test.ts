import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  extractUrls,
  URL_REGEX,
  isLabelQuery,
  extractLabelName,
  labelExistsInList,
  incrementEmptyDrain,
  resetEmptyDrain,
  shouldWarnEmptyDrains,
  EMPTY_DRAIN_WARN_THRESHOLD,
} from "../scripts/inbox-drain.ts";

describe("extractUrls() — extração via URL_REGEX + strip de pontuação", () => {
  it("extrai URL limpa de texto corrido", () => {
    const body = "Olha essa matéria: https://openai.com/blog/gpt-5 muito boa.";
    assert.deepEqual(extractUrls(body), ["https://openai.com/blog/gpt-5"]);
  });

  it("remove ponto final agarrado na URL", () => {
    const body = "Link: https://anthropic.com/news/claude.";
    assert.deepEqual(extractUrls(body), ["https://anthropic.com/news/claude"]);
  });

  it("remove parêntese de fechamento agarrado", () => {
    const body = "Ver (https://arxiv.org/abs/2501.12345) no arxiv";
    assert.deepEqual(extractUrls(body), ["https://arxiv.org/abs/2501.12345"]);
  });

  it("remove vírgula de fechamento", () => {
    const body = "Leia https://example.com/artigo, muito interessante";
    assert.deepEqual(extractUrls(body), ["https://example.com/artigo"]);
  });

  it("para antes de > em URL dentro de <https://...>", () => {
    const body = "Linkaram <https://openai.com/index/chatgpt> aqui";
    assert.deepEqual(extractUrls(body), ["https://openai.com/index/chatgpt"]);
  });

  it("extrai múltiplas URLs em um só e-mail", () => {
    const body = `Dois papers bons:
      - https://arxiv.org/abs/2501.00001
      - https://huggingface.co/papers/2501.00002.
    `;
    assert.deepEqual(extractUrls(body), [
      "https://arxiv.org/abs/2501.00001",
      "https://huggingface.co/papers/2501.00002",
    ]);
  });

  it("filtra URLs muito curtas (< 10 chars)", () => {
    // "https://x" tem 9 chars — filtrado
    const body = "tudo mundo linka https://x mas é curto demais";
    assert.deepEqual(extractUrls(body), []);
  });

  it("URL_REGEX tem flag global (stateful match() funciona)", () => {
    // Apenas garantir que a regex está realmente configurada como global
    assert.ok(URL_REGEX.global, "URL_REGEX deve ter flag /g");
  });
});

describe("isLabelQuery() — detecta query baseada em label:", () => {
  it("reconhece 'label:Diaria'", () => {
    assert.equal(isLabelQuery("label:Diaria"), true);
  });

  it("reconhece com whitespace e composição", () => {
    assert.equal(isLabelQuery("  label:Diaria after:2026/01/01"), true);
    assert.equal(isLabelQuery("LABEL:foo"), true);
  });

  it("rejeita queries sem label:", () => {
    assert.equal(isLabelQuery("from:vjpixel@gmail.com"), false);
    assert.equal(isLabelQuery("in:inbox"), false);
    assert.equal(isLabelQuery(""), false);
  });
});

describe("extractLabelName() — pega o nome do label da query", () => {
  it("extrai nome simples", () => {
    assert.equal(extractLabelName("label:Diaria"), "Diaria");
  });

  it("para no primeiro whitespace (ignora resto da query)", () => {
    assert.equal(extractLabelName("label:Diaria after:2026/01/01"), "Diaria");
  });

  it("retorna string vazia se não houver label:", () => {
    assert.equal(extractLabelName("from:editor@x.com"), "");
  });
});

describe("labelExistsInList() — checagem case-insensitive", () => {
  it("encontra label existente", () => {
    const labels = [{ name: "Diaria" }, { name: "INBOX" }];
    assert.equal(labelExistsInList(labels, "Diaria"), true);
  });

  it("é case-insensitive", () => {
    const labels = [{ name: "Diaria" }];
    assert.equal(labelExistsInList(labels, "diaria"), true);
    assert.equal(labelExistsInList(labels, "DIARIA"), true);
  });

  it("retorna false quando não acha", () => {
    const labels = [{ name: "Other" }];
    assert.equal(labelExistsInList(labels, "Diaria"), false);
  });

  it("aceita lista vazia", () => {
    assert.equal(labelExistsInList([], "Diaria"), false);
  });

  it("string-target vazio passa (não há nome pra validar)", () => {
    assert.equal(labelExistsInList([{ name: "X" }], ""), true);
  });
});

describe("contador de drains vazios consecutivos", () => {
  it("incrementEmptyDrain a partir de cursor sem campo", () => {
    const c = incrementEmptyDrain({ last_drain_iso: null });
    assert.equal(c.consecutive_empty_drains, 1);
    assert.equal(c.last_drain_iso, null);
  });

  it("incrementEmptyDrain incrementa N+1", () => {
    const c = incrementEmptyDrain({
      last_drain_iso: "2026-04-20T00:00:00Z",
      consecutive_empty_drains: 2,
    });
    assert.equal(c.consecutive_empty_drains, 3);
    assert.equal(c.last_drain_iso, "2026-04-20T00:00:00Z");
  });

  it("resetEmptyDrain zera o contador", () => {
    const c = resetEmptyDrain({
      last_drain_iso: "2026-04-20T00:00:00Z",
      consecutive_empty_drains: 5,
    });
    assert.equal(c.consecutive_empty_drains, 0);
  });

  it("shouldWarnEmptyDrains compara com THRESHOLD", () => {
    assert.equal(shouldWarnEmptyDrains({ last_drain_iso: null }), false);
    assert.equal(
      shouldWarnEmptyDrains({
        last_drain_iso: null,
        consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD - 1,
      }),
      false,
    );
    assert.equal(
      shouldWarnEmptyDrains({
        last_drain_iso: null,
        consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD,
      }),
      true,
    );
    assert.equal(
      shouldWarnEmptyDrains({
        last_drain_iso: null,
        consecutive_empty_drains: EMPTY_DRAIN_WARN_THRESHOLD + 5,
      }),
      true,
    );
  });
});
