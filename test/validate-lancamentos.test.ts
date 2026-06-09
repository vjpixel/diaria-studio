import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractLancamentoUrls,
  validateLancamentos,
  validateLancamentosFromApproved,
  isNonProductLancamento,
  hasProductSignal,
  isVerifiedTool,
} from "../scripts/validate-lancamentos.ts";
import { spawnNpx } from "./_helpers/spawn-npx.ts";

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
      // #1968: slug com sinal de produto (`gpt-5`) pra status seguir "ok" — o
      // foco do teste é o dedup, não o gate de ferramenta.
      "[https://openai.com/index/gpt-5](https://openai.com/index/gpt-5)",
    ].join("\n");
    const r = validateLancamentos(md);
    // Mesma URL aparece 2x no markdown link mas conta como 1
    assert.equal(r.lancamento_count, 1);
    assert.equal(r.status, "ok");
  });
});

describe("#1968 — verificação POSITIVA de ferramenta", () => {
  it("hasProductSignal: verbo/substantivo/família/versão = produto", () => {
    assert.ok(hasProductSignal("https://openai.com/index/introducing-gpt-5"));
    assert.ok(hasProductSignal("https://www.anthropic.com/news/claude-opus-4-5"));
    assert.ok(hasProductSignal("https://blog.google/technology/gemini-2-5-flash"));
    assert.ok(hasProductSignal("https://openai.com/index/sora")); // família IA
    assert.ok(hasProductSignal("https://x.com/launch-new-api")); // verbo + noun
    assert.ok(hasProductSignal("https://blog.google/products/notebooklm/x")); // path /products/
  });

  it("hasProductSignal: parceria/programa/evento/contratação = SEM sinal", () => {
    assert.ok(!hasProductSignal("https://nvidia.com/data-center/nvidia-and-lg-group-ai-factory"));
    assert.ok(!hasProductSignal("https://openai.com/index/economic-research-exchange"));
    assert.ok(!hasProductSignal("https://www.anthropic.com/news/hiring-engineers"));
  });

  it("hasProductSignal: ANO no slug NÃO conta como versão (#1968 code-review)", () => {
    // Furo achado no review: `-\d+` casava `-2025`; `\d+(?:[.\-]\d+)+` casava
    // `2026-01`/`2023-2024` → qualquer slug DATADO (parceria/evento/relatório)
    // passava como ferramenta. Regressão: ano não é versão.
    assert.ok(!hasProductSignal("https://blogs.nvidia.com/blog/nvidia-and-lg-2025-partnership/"));
    assert.ok(!hasProductSignal("https://openai.com/index/economic-research-2024-agenda/"));
    assert.ok(!hasProductSignal("https://blogs.nvidia.com/blog/gtc-2025-keynote/"));
    assert.ok(!hasProductSignal("https://blogs.microsoft.com/blog/2026/06/02/microsoft-build-2026-x/"));
    assert.ok(!hasProductSignal("https://openai.com/index/2026-01-recap/"));
    assert.ok(!hasProductSignal("https://anthropic.com/news/2023-2024-review/"));
    assert.ok(!hasProductSignal("https://x.ai/news/series-c-2025/"));
  });

  it("hasProductSignal: versão de modelo de 1-2 dígitos AINDA conta (não regrediu)", () => {
    assert.ok(hasProductSignal("https://huggingface.co/blog/nvidia/cosmos-3-for-physical-ai")); // single-version
    assert.ok(hasProductSignal("https://allenai.org/olmo-2"));
    assert.ok(hasProductSignal("https://www.anthropic.com/news/claude-opus-4-5")); // multipart
    assert.ok(hasProductSignal("https://blog.google/technology/gemini-2-5-flash"));
    assert.ok(hasProductSignal("https://openai.com/index/o3")); // série o1-o9
    assert.ok(hasProductSignal("https://mistral.ai/news/mistral-7b")); // param count
  });

  it("isVerifiedTool: governança vence sinal (alta precisão, reforço #1799)", () => {
    // mesmo com 'update' no slug, 'policy' marca governança → não é ferramenta
    assert.ok(!isVerifiedTool("https://openai.com/index/public-policy-update"));
  });

  it("isVerifiedTool: allowlist faz override de slug atípico", () => {
    const url = "https://nvidia.com/blog/jetson-thor-edge"; // hardware, slug sem sinal
    assert.ok(!isVerifiedTool(url), "sem allowlist → não verificado");
    assert.ok(isVerifiedTool(url, undefined, ["nvidia.com/blog/jetson"]), "allowlist → verificado");
  });

  it("validateLancamentos: item oficial sem sinal → not_a_tool + status error (hard-block)", () => {
    const md = ["LANÇAMENTOS", "Item", "https://openai.com/index/economic-research-exchange", "", "---"].join("\n");
    const r = validateLancamentos(md);
    assert.equal(r.not_a_tool.length, 1);
    assert.equal(r.verified_product.length, 0);
    assert.equal(r.status, "error");
  });

  it("validateLancamentos: lançamento real → verified_product + status ok", () => {
    const md = ["LANÇAMENTOS", "Item", "https://openai.com/index/introducing-gpt-5", "", "---"].join("\n");
    const r = validateLancamentos(md);
    assert.equal(r.verified_product.length, 1);
    assert.equal(r.not_a_tool.length, 0);
    assert.equal(r.status, "ok");
  });

  it("validateLancamentos: allowlist (param) suprime not_a_tool", () => {
    const md = ["LANÇAMENTOS", "Item", "https://openai.com/index/jetson-thor", "", "---"].join("\n");
    assert.equal(validateLancamentos(md).status, "error");
    const r = validateLancamentos(md, ["openai.com/index/jetson"]);
    assert.equal(r.not_a_tool.length, 0);
    assert.equal(r.status, "ok");
  });

  it("validateLancamentosFromApproved: não-oficial não dupla-flaga not_a_tool (só removed)", () => {
    const approved = { lancamento: [{ url: "https://techcrunch.com/2026/01/x", title: "Cobertura" }] };
    const s = validateLancamentosFromApproved(approved);
    assert.equal(s.removed.length, 1); // não-oficial
    assert.equal(s.not_a_tool.length, 0); // not_a_tool só avalia oficiais
  });

  it("#1978: MD-mode captura título de [Título](url) e passa pra isVerifiedTool", () => {
    // slug SEM sinal de produto, mas título COM ('introducing' + 'gpt') → agora
    // verified no MD-mode (antes era not_a_tool — título era descartado).
    const md = [
      "LANÇAMENTOS",
      "**[Introducing GPT-5.5](https://openai.com/index/frontier-x)**",
      "Resumo do lançamento.",
      "",
      "---",
    ].join("\n");
    const urls = extractLancamentoUrls(md);
    assert.equal(urls.length, 1);
    assert.equal(urls[0].title, "Introducing GPT-5.5");
    const r = validateLancamentos(md);
    assert.equal(r.verified_product.length, 1, "título com sinal → verified");
    assert.equal(r.not_a_tool.length, 0);
    assert.equal(r.status, "ok");
  });

  it("#1978: slug E título sem sinal → segue not_a_tool (não afrouxa o gate)", () => {
    const md = [
      "LANÇAMENTOS",
      "**[Parceria institucional](https://openai.com/index/economic-exchange)**",
      "Resumo.",
      "",
      "---",
    ].join("\n");
    const r = validateLancamentos(md);
    assert.equal(r.not_a_tool.length, 1);
    assert.equal(r.status, "error");
  });

  it("validateLancamentosFromApproved: oficial sem sinal → not_a_tool (usa título)", () => {
    const approved = {
      lancamento: [
        { url: "https://openai.com/index/economic-research-exchange", title: "Economic Research Exchange" },
        { url: "https://www.anthropic.com/news/claude-opus-4-5", title: "Claude Opus 4.5" },
      ],
    };
    const s = validateLancamentosFromApproved(approved);
    assert.equal(s.not_a_tool.length, 1);
    assert.equal(s.not_a_tool[0].url, "https://openai.com/index/economic-research-exchange");
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

describe("CLI args (#902, #926)", () => {
  function setupTmpMd(): { tmp: string; mdPath: string } {
    const tmp = mkdtempSync(join(tmpdir(), "validate-lancamentos-cli-"));
    const mdPath = join(tmp, "02-reviewed.md");
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "Item",
      // #1968: slug com sinal positivo de produto (`introducing` + versão) pra
      // o CLI passar — estes testes exercitam o parsing de args, não o gate.
      "https://openai.com/index/introducing-gpt-5",
      "",
      "---",
      "",
    ].join("\n");
    writeFileSync(mdPath, md, "utf8");
    return { tmp, mdPath };
  }

  it("aceita posicional <md-path> (retrocompat)", () => {
    const { tmp, mdPath } = setupTmpMd();
    try {
      const r = spawnNpx(["tsx", "scripts/validate-lancamentos.ts", mdPath], {
        encoding: "utf8",
      });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(String(r.stdout));
      assert.equal(out.status, "ok");
      assert.equal(out.lancamento_count, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("aceita --md <md-path> (#902)", () => {
    const { tmp, mdPath } = setupTmpMd();
    try {
      const r = spawnNpx(["tsx", "scripts/validate-lancamentos.ts", "--md", mdPath], {
        encoding: "utf8",
      });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(String(r.stdout));
      assert.equal(out.status, "ok");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("aceita --in <md-path> (#902)", () => {
    const { tmp, mdPath } = setupTmpMd();
    try {
      const r = spawnNpx(["tsx", "scripts/validate-lancamentos.ts", "--in", mdPath], {
        encoding: "utf8",
      });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(String(r.stdout));
      assert.equal(out.status, "ok");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("não-produto (governança/política) — #1799", () => {
  it("isNonProductLancamento flaga o item OpenAI policy de 260604", () => {
    assert.ok(
      isNonProductLancamento(
        "https://openai.com/index/public-policy-agenda",
        "OpenAI apresenta sua agenda de política pública",
      ),
    );
  });

  it("isNonProductLancamento NÃO flaga lançamento de produto real", () => {
    assert.ok(!isNonProductLancamento("https://openai.com/index/gpt-5", "GPT-5"));
    assert.ok(!isNonProductLancamento("https://blog.google/technology/gemini-2", "Gemini 2"));
    assert.ok(!isNonProductLancamento("https://www.nvidia.com/rtx-spark", "RTX Spark"));
  });

  it("#1852: flaga pesquisa/case-study em domínio oficial (backstop do gate)", () => {
    // Defesa-em-profundidade: itens que escaparam o categorize via type_hint.
    assert.ok(isNonProductLancamento("https://blogs.nvidia.com/blog/cvpr-research-grasping/"), "cvpr");
    assert.ok(isNonProductLancamento("https://x.com/index/some-arxiv-paper"), "arxiv");
    assert.ok(isNonProductLancamento("https://x.com/blog/acme-case-study"), "case study");
  });

  it("#1852 review: NÃO flaga lançamento de CLI/SDK (é produto — cli/sdk fora do regex)", () => {
    // Um CLI/SDK É software; a mensagem "não software/hardware" seria errada.
    assert.ok(!isNonProductLancamento("https://github.blog/github-cli-2-0"));
    assert.ok(!isNonProductLancamento("https://vercel.com/blog/vercel-ai-sdk"));
  });

  it("#1852: NÃO flaga lançamento real sem sinal de pesquisa/case-study", () => {
    assert.ok(!isNonProductLancamento("https://openai.com/index/introducing-gpt-5", "GPT-5"));
    assert.ok(!isNonProductLancamento("https://blog.google/technology/gemini-3", "Gemini 3"));
  });

  it("NÃO flaga 'framework'/'agenda'/'blueprint' (produto real — review #1817)", () => {
    // framework/agenda/blueprint são comuns em produto; removidos do regex.
    assert.ok(!isNonProductLancamento("https://x.com/langgraph-framework", "LangGraph framework"));
    assert.ok(!isNonProductLancamento("https://x.com/agenda-ai-app", "Agenda AI — calendário inteligente"));
    assert.ok(!isNonProductLancamento("https://x.com/blueprint-builder", "Blueprint Builder"));
  });

  it("MD: item bold mixed-case NÃO trunca a seção (review #1817)", () => {
    const md = [
      "**🚀 LANÇAMENTOS**",
      "",
      "**Produto v2 anunciado**",
      "[GPT-5](https://openai.com/index/gpt-5) — modelo.",
      "",
      "**📡 RADAR**",
      "",
      "[radar](https://exemplo.com/y)",
    ].join("\n");
    const urls = extractLancamentoUrls(md);
    // o item bold mixed-case 'Produto v2 anunciado' NÃO encerra a seção → o
    // GPT-5 (linha seguinte) ainda é extraído; RADAR (uppercase) encerra.
    assert.equal(urls.length, 1);
    assert.match(urls[0].url, /openai\.com\/index\/gpt-5/);
  });

  it("flaga não-produto MESMO em domínio oficial (independente do #160)", () => {
    // openai.com é oficial → NÃO entra em removed, mas É governança → flagged.
    const approved = {
      lancamento: [
        { url: "https://openai.com/index/public-policy-agenda", title: "Agenda de política pública" },
        { url: "https://openai.com/index/gpt-5", title: "GPT-5" },
      ],
    };
    const r = validateLancamentosFromApproved(approved);
    assert.equal(r.removed.length, 0, "ambos oficiais → nenhum removido");
    assert.equal(r.flagged_non_product.length, 1, "só o policy é flagado");
    assert.match(r.flagged_non_product[0].url, /public-policy-agenda/);
  });

  it("MD: regex casa header bold+emoji **🚀 LANÇAMENTOS** (antes era no-op)", () => {
    const md = [
      "**🚀 LANÇAMENTOS**",
      "",
      "[GPT-5](https://openai.com/index/gpt-5) — modelo novo.",
      "",
      "**📡 RADAR**",
      "",
      "[outra coisa](https://exemplo.com/x)",
    ].join("\n");
    const urls = extractLancamentoUrls(md);
    assert.equal(urls.length, 1, "deve extrair só o item de LANÇAMENTOS (RADAR encerra)");
    assert.match(urls[0].url, /openai\.com\/index\/gpt-5/);
  });

  it("MD: non_product populado para item de governança", () => {
    const md = [
      "LANÇAMENTOS",
      "",
      "https://openai.com/index/public-policy-agenda",
      "",
      "---",
    ].join("\n");
    const r = validateLancamentos(md);
    assert.equal(r.non_product.length, 1);
  });
});
