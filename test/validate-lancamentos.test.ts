import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractLancamentoUrls,
  validateLancamentos,
  validateLancamentosFromApproved,
} from "../scripts/validate-lancamentos.ts";
import { NPX, isWindows } from "./_helpers/spawn-npx.ts";

describe("extractLancamentoUrls", () => {
  it("captura URLs dentro da seção LANÇAMENTOS", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "https://outside-section.com/x",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "Item 1",
      "https://openai.com/index/x",
      "",
      "Item 2",
      "https://blog.google/y",
      "",
      "---",
      "",
      "PESQUISAS",
      "https://arxiv.org/abs/2501",
    ].join("\n");

    const urls = extractLancamentoUrls(md);
    assert.equal(urls.length, 2);
    assert.equal(urls[0].url, "https://openai.com/index/x");
    assert.equal(urls[1].url, "https://blog.google/y");
  });

  it("ignora URLs fora da seção (DESTAQUE / PESQUISAS / OUTRAS NOTÍCIAS)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "https://destaque.com/x",
      "",
      "---",
      "",
      "PESQUISAS",
      "https://arxiv.org/abs/x",
    ].join("\n");

    const urls = extractLancamentoUrls(md);
    assert.equal(urls.length, 0);
  });

  it("limpa pontuação trailing das URLs", () => {
    const md = [
      "LANÇAMENTOS",
      "Item",
      "Veja em https://openai.com/x.",
    ].join("\n");

    const urls = extractLancamentoUrls(md);
    assert.equal(urls.length, 1);
    assert.equal(urls[0].url, "https://openai.com/x");
  });

  it("seção LANCAMENTOS sem cedilha também funciona", () => {
    const md = ["LANCAMENTOS", "https://openai.com/x"].join("\n");
    const urls = extractLancamentoUrls(md);
    assert.equal(urls.length, 1);
  });
});

describe("validateLancamentos", () => {
  it("status ok quando todas URLs são oficiais", () => {
    const md = [
      "LANÇAMENTOS",
      "Item 1",
      "https://openai.com/index/gpt-5",
      "",
      "Item 2",
      "https://blog.google/technology/gemini-update",
    ].join("\n");

    const r = validateLancamentos(md);
    assert.equal(r.status, "ok");
    assert.equal(r.lancamento_count, 2);
    assert.equal(r.invalid_urls.length, 0);
  });

  it("status error quando há URL não-oficial (TechCrunch, blog pessoal)", () => {
    const md = [
      "LANÇAMENTOS",
      "GPT-5.5 chega",
      "https://openai.com/index/gpt-5-5",
      "",
      "Análise do Simon",
      "https://simonwillison.net/2026/Apr/25/gpt-5-5/",
      "",
      "Anthropic marketplace",
      "https://techcrunch.com/2026/04/25/anthropic-marketplace/",
    ].join("\n");

    const r = validateLancamentos(md);
    assert.equal(r.status, "error");
    assert.equal(r.lancamento_count, 3);
    assert.equal(r.invalid_urls.length, 2);
    assert.ok(r.invalid_urls.some((u) => u.url.includes("simonwillison.net")));
    assert.ok(r.invalid_urls.some((u) => u.url.includes("techcrunch.com")));
  });

  it("seção LANÇAMENTOS vazia passa ok", () => {
    const md = ["LANÇAMENTOS", "", "---"].join("\n");
    const r = validateLancamentos(md);
    assert.equal(r.status, "ok");
    assert.equal(r.lancamento_count, 0);
  });

  it("MD sem seção LANÇAMENTOS passa ok", () => {
    const md = ["DESTAQUE 1 | PRODUTO", "https://openai.com/x"].join("\n");
    const r = validateLancamentos(md);
    assert.equal(r.status, "ok");
    assert.equal(r.lancamento_count, 0);
  });

  it("dedup URL repetida (markdown link [url](url) duplica a URL no source)", () => {
    const md = [
      "LANÇAMENTOS",
      "Item",
      "[https://openai.com/index/x](https://openai.com/index/x)",
    ].join("\n");
    const r = validateLancamentos(md);
    // Mesma URL aparece 2x no markdown link mas conta como 1
    assert.equal(r.lancamento_count, 1);
    assert.equal(r.status, "ok");
  });
});

import { extractLancamentoUrls as extractStage1, validateLancamentos as validateStage1 } from "../scripts/validate-lancamentos.ts";

describe("validate-lancamentos compat com Stage 1 categorized.md format (#587)", () => {
  it("extrai URLs de '## Lançamentos' (Stage 1 markdown header)", () => {
    const md = `# Edição
## Destaques
_(mova 3 artigos para cá)_

## Lançamentos

1. [86] Buser lança app no ChatGPT — https://canaltech.com.br/foo — 2026-05-04

## Pesquisas

1. [70] Outro artigo — https://example.com/x — 2026-05-03
`;
    const urls = extractStage1(md);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].url.includes("canaltech"));
  });

  it("validateLancamentos detecta canaltech como não-oficial em Stage 1", () => {
    const md = `## Lançamentos

1. [86] Buser lança app no ChatGPT — https://canaltech.com.br/foo — 2026-05-04
`;
    const result = validateStage1(md);
    assert.equal(result.status, "error");
    assert.equal(result.invalid_urls.length, 1);
    assert.ok(result.invalid_urls[0].url.includes("canaltech"));
  });

  it("compat retroativa: ainda detecta formato Stage 2 (LANÇAMENTOS plain)", () => {
    const md = `LANÇAMENTOS

Buser app

https://canaltech.com.br/foo
`;
    const result = validateStage1(md);
    assert.equal(result.status, "error");
  });
});

describe("validateLancamentosFromApproved (#876)", () => {
  it("retorna summary vazio quando não há lançamentos", () => {
    const r = validateLancamentosFromApproved({});
    assert.equal(r.original_count, 0);
    assert.equal(r.final_count, 0);
    assert.equal(r.removed.length, 0);
  });

  it("mantém URLs oficiais e remove não-oficiais", () => {
    const approved = {
      lancamento: [
        { url: "https://openai.com/index/gpt-5", title: "GPT-5" },
        {
          url: "https://techcrunch.com/2026/04/25/foo",
          title: "Cobertura TechCrunch",
        },
        {
          url: "https://canaltech.com.br/foo",
          title: "Canaltech",
        },
        { url: "https://blog.google/technology/x", title: "Gemini" },
      ],
    };
    const r = validateLancamentosFromApproved(approved);
    assert.equal(r.original_count, 4);
    assert.equal(r.final_count, 2);
    assert.equal(r.removed.length, 2);
    assert.ok(
      r.removed.some((x) => x.url.includes("techcrunch")),
      JSON.stringify(r.removed),
    );
    assert.ok(r.removed.some((x) => x.url.includes("canaltech")));
    for (const x of r.removed) {
      assert.equal(x.reason, "non_official_domain");
    }
  });

  it("ignora itens sem URL", () => {
    const approved = {
      lancamento: [
        { url: "https://openai.com/index/x", title: "OK" },
        { title: "sem url" },
        { url: "" },
      ],
    };
    const r = validateLancamentosFromApproved(approved);
    assert.equal(r.original_count, 1);
    assert.equal(r.final_count, 1);
    assert.equal(r.removed.length, 0);
  });

  it("preserva o título no removed", () => {
    const approved = {
      lancamento: [
        { url: "https://techcrunch.com/2026/04/x", title: "Cobertura terceirizada" },
      ],
    };
    const r = validateLancamentosFromApproved(approved);
    assert.equal(r.removed.length, 1);
    assert.equal(r.removed[0].title, "Cobertura terceirizada");
  });
});

describe("validate-lancamentos CLI --in flag (#902)", () => {
  function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync(
      NPX,
      ["tsx", "scripts/validate-lancamentos.ts", ...args],
      { encoding: "utf8", stdio: "pipe", shell: isWindows },
    );
    if (result.error) throw result.error;
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
    };
  }

  it("aceita --in <path>", () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-902-"));
    try {
      const md = ["LANÇAMENTOS", "https://openai.com/index/x"].join("\n");
      const path = join(dir, "categorized.md");
      writeFileSync(path, md, "utf8");
      const r = runCli(["--in", path]);
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.status, "ok");
      assert.equal(parsed.lancamento_count, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retrocompat: continua aceitando posicional <md-path>", () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-902-pos-"));
    try {
      const md = ["LANÇAMENTOS", "https://openai.com/index/x"].join("\n");
      const path = join(dir, "categorized.md");
      writeFileSync(path, md, "utf8");
      const r = runCli([path]);
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.status, "ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem path → exit 2 com mensagem de uso", () => {
    const r = runCli([]);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /Uso:.*--in/);
  });
});
