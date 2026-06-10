/**
 * test/audience-affinity.test.ts (#2063)
 *
 * Testes para `scripts/lib/audience-affinity.ts`:
 *   - match por ferramenta (survey tools)
 *   - match por categoria CTR
 *   - sem dados → null (fallback gracioso)
 *   - freshness warning (mtime > 30d)
 *   - annotateUseMelhorBucket: anota só use_melhor
 *   - normalizeTool: strips accentuation, lowercases
 *
 * Sem rede, sem disco real — usa fixtures sintéticas.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  annotateAudienceAffinity,
  annotateUseMelhorBucket,
  checkFreshness,
  normalizeTool,
  extractSurveyTools,
  loadAudienceSignals,
  AUDIENCE_AFFINITY_FRESHNESS_DAYS,
  type AudienceSignals,
} from "../scripts/lib/audience-affinity.ts";

// ─── Fixtures de sinais ────────────────────────────────────────────────────────

/** Sinais mínimos com dados reais representativos do perfil da Diar.ia */
function makeSignals(opts: { ctrMap?: Map<string, number>; surveyTools?: Set<string> } = {}): AudienceSignals {
  return {
    ctrByCategory: opts.ctrMap ?? new Map([
      ["Treinamento", 5.65],   // 2.43% / 0.43% ≈ 5.65× média
      ["Aplicação", 1.49],     // 0.64% / 0.43% ≈ 1.49×
      ["Pesquisa", 0.84],      // abaixo da média
      ["Curiosidade", 0.33],   // muito abaixo
    ]),
    avgCtr: 0.0043,
    surveyTools: opts.surveyTools ?? new Set(["chatgpt", "claude", "gpt", "cursor", "gemini"]),
    loaded: true,
  };
}

const signals = makeSignals();
const emptySignals: AudienceSignals = { ctrByCategory: new Map(), avgCtr: 0, surveyTools: new Set(), loaded: false };

// ─── normalizeTool ─────────────────────────────────────────────────────────────

describe("normalizeTool", () => {
  it("lowercase", () => assert.equal(normalizeTool("ChatGPT"), "chatgpt"));
  it("remove accents", () => assert.equal(normalizeTool("Aplicação"), "aplicacao"));
  it("remove special chars", () => assert.equal(normalizeTool("fine-tuning!"), "fine-tuning"));
  it("collapses whitespace", () => assert.equal(normalizeTool("a  b   c"), "a b c"));
  it("empty string", () => assert.equal(normalizeTool(""), ""));
});

// ─── extractSurveyTools ────────────────────────────────────────────────────────

describe("extractSurveyTools", () => {
  it("extrai ferramenta conhecida de resposta de survey", () => {
    const responses = [{
      answers: [{
        question_prompt: "Quais ferramentas de IA você usa?",
        answer: "chatgpt, claude, cursor",
      }],
    }];
    const tools = extractSurveyTools(responses);
    assert.ok(tools.has("chatgpt"), "deve extrair chatgpt");
    assert.ok(tools.has("claude"), "deve extrair claude");
    assert.ok(tools.has("cursor"), "deve extrair cursor");
  });

  it("retorna fallback com KNOWN_TOOLS quando survey não tem respostas de ferramentas", () => {
    const responses = [{ answers: [{ question_prompt: "Qual seu cargo?", answer: "gerente" }] }];
    const tools = extractSurveyTools(responses);
    assert.ok(tools.size > 0, "fallback deve ter ferramentas");
  });

  it("ignora perguntas sem palavras-chave de ferramenta", () => {
    const responses = [{ answers: [{ question_prompt: "Nome completo?", answer: "João Silva" }] }];
    const tools = extractSurveyTools(responses);
    // Fallback opera — não deve lançar erro
    assert.ok(tools instanceof Set);
  });

  it("funciona com respostas vazias", () => {
    const tools = extractSurveyTools([]);
    assert.ok(tools instanceof Set);
  });
});

// ─── annotateAudienceAffinity ─────────────────────────────────────────────────

describe("annotateAudienceAffinity — match por ferramenta", () => {
  it("artigo mencionando 'chatgpt' (tool no survey) → affinity > 0", () => {
    const article = { url: "https://blog.ex.com/usar-chatgpt", title: "Como usar ChatGPT no trabalho", summary: "tutorial sobre chatgpt" };
    const result = annotateAudienceAffinity(article, signals);
    assert.ok(result !== null, "deve retornar anotação");
    assert.ok(result.affinity > 0, "affinity deve ser positiva com match de tool");
    assert.ok(result.matched.some(m => m.startsWith("tool:")), "deve mencionar a ferramenta matched");
  });

  it("artigo sem nenhuma ferramenta ou categoria → affinity baixo", () => {
    const article = { url: "https://blog.ex.com/outro", title: "Xyzzy blorb", summary: "texto sem sinais" };
    const result = annotateAudienceAffinity(article, signals);
    assert.ok(result !== null);
    assert.ok(result.affinity < 0.2, "sem match = affinity baixo");
  });

  it("match de múltiplas ferramentas → matched lista todas", () => {
    const article = { url: "https://ex.com/tut", title: "Claude e ChatGPT: comparação e tutoriais", summary: "usando cursor e gemini" };
    const result = annotateAudienceAffinity(article, signals);
    assert.ok(result !== null);
    assert.ok(result.matched.length > 1, "múltiplas ferramentas devem aparecer em matched");
  });

  it("word-boundary: 'rag' NÃO deve dar match em 'storage' (regressão #2063)", () => {
    // Antes do fix, hay.includes('rag') retornava true para 'storage' (sto-rag-e).
    // Com wordMatch, 'rag' precisa aparecer como token separado.
    const withRag = makeSignals({ surveyTools: new Set(["rag", "chatgpt"]) });
    const storageArticle = { url: "https://aws.amazon.com/s3", title: "Cloud storage optimization", summary: "object storage guide" };
    const result = annotateAudienceAffinity(storageArticle, withRag);
    assert.ok(result !== null);
    assert.ok(!result.matched.some(m => m === "tool:rag"), "'rag' não deve matchear em 'storage'");
  });

  it("word-boundary: 'deploy' NÃO deve dar match duplo em artigo com 'deployment' (regressão #2063)", () => {
    // Antes do fix, KNOWN_TOOLS tinha 'deploy' e 'deployment', causando 2 matches
    // de um único conceito. 'deploy' como substring de 'deployment'.
    const withBoth = makeSignals({ surveyTools: new Set(["deploy", "deployment"]) });
    const deployArticle = { url: "https://ex.com/k8s", title: "Kubernetes deployment guide", summary: "production deployment" };
    const result = annotateAudienceAffinity(deployArticle, withBoth);
    assert.ok(result !== null);
    // Com wordMatch: 'deployment' como palavra completa → 1 match (deployment)
    // 'deploy' não aparece como palavra separada no texto → 0 matches para deploy
    const deployMatches = result.matched.filter(m => m.startsWith("tool:deploy"));
    assert.ok(deployMatches.length <= 1, "deployment deve contar como 1 match, não 2");
  });
});

describe("annotateAudienceAffinity — match por categoria CTR", () => {
  it("artigo de treinamento (categoria de alto CTR) → affinity alta", () => {
    const article = { url: "https://fast.ai/course/treinamento", title: "Curso de Machine Learning — treinamento avançado", summary: "treinamento de modelos" };
    const result = annotateAudienceAffinity(article, signals);
    assert.ok(result !== null);
    // Treinamento tem CTR ratio ≈ 5.65 → ctrScore ≈ min(5.65/6, 1) ≈ 0.94
    assert.ok(result.affinity > 0.3, "treinamento = categoria acima da média, affinity deve ser relevante");
    assert.ok(result.matched.some(m => m === "categoria:Treinamento"), "deve matchear categoria Treinamento");
  });

  it("artigo de aplicação → affinity positiva", () => {
    const article = { url: "https://ex.com/x", title: "Aplicação de IA em hospitais", summary: "aplicação prática" };
    const result = annotateAudienceAffinity(article, signals);
    assert.ok(result !== null);
    assert.ok(result.affinity > 0);
  });
});

describe("annotateAudienceAffinity — sem dados (fallback gracioso)", () => {
  it("signals.loaded === false → retorna null", () => {
    const article = { url: "https://ex.com", title: "Tutorial ChatGPT", summary: "chatgpt tutorial" };
    const result = annotateAudienceAffinity(article, emptySignals);
    assert.equal(result, null, "sem dados = null (sem bônus/penalidade)");
  });

  it("artigo sem título nem summary → não lança erro", () => {
    const article = { url: "https://ex.com/x" };
    const result = annotateAudienceAffinity(article, signals);
    assert.ok(result !== null || result === null); // não lança
  });

  it("URL inválida → não lança erro", () => {
    const article = { url: "nao-e-url", title: "Tutorial" };
    assert.doesNotThrow(() => annotateAudienceAffinity(article, signals));
  });
});

// ─── annotateUseMelhorBucket ──────────────────────────────────────────────────

describe("annotateUseMelhorBucket", () => {
  it("anota apenas artigos do bucket use_melhor, não outros", () => {
    const categorized: Record<string, Array<{
      url?: string; title?: string; summary?: string; category?: string;
      audience_affinity?: unknown;
    }>> = {
      lancamento: [{ url: "https://a.com", title: "Lançamento ChatGPT" }],
      radar: [{ url: "https://b.com", title: "Notícia ChatGPT" }],
      use_melhor: [
        { url: "https://c.com/tutorial", title: "Tutorial ChatGPT no trabalho" },
      ],
      video: [],
    };

    const count = annotateUseMelhorBucket(categorized, signals);
    assert.equal(count, 1, "deve anotar 1 artigo use_melhor");
    assert.ok(categorized.use_melhor[0].audience_affinity !== undefined, "use_melhor[0] deve ter audience_affinity");
    assert.equal((categorized.lancamento[0] as { audience_affinity?: unknown }).audience_affinity, undefined, "lancamento não deve ter audience_affinity");
    assert.equal((categorized.radar[0] as { audience_affinity?: unknown }).audience_affinity, undefined, "radar não deve ter audience_affinity");
  });

  it("signals.loaded === false → retorna 0, não anota nada", () => {
    const categorized = { use_melhor: [{ url: "https://ex.com", title: "Tutorial" }] };
    const count = annotateUseMelhorBucket(categorized, emptySignals);
    assert.equal(count, 0);
    assert.equal((categorized.use_melhor[0] as { audience_affinity?: unknown }).audience_affinity, undefined);
  });

  it("bucket use_melhor ausente → retorna 0 sem erro", () => {
    const count = annotateUseMelhorBucket({ lancamento: [] }, signals);
    assert.equal(count, 0);
  });

  it("bucket use_melhor vazio → retorna 0", () => {
    const count = annotateUseMelhorBucket({ use_melhor: [] }, signals);
    assert.equal(count, 0);
  });
});

// ─── checkFreshness ───────────────────────────────────────────────────────────

describe("checkFreshness (#2063 item 2)", () => {
  it("arquivo ausente → não emite warning, não lança", () => {
    // Captura stderr para verificar ausência de output
    const origWrite = process.stderr.write.bind(process.stderr);
    const msgs: string[] = [];
    process.stderr.write = (chunk: unknown, ...args: unknown[]) => {
      msgs.push(String(chunk));
      return origWrite(chunk as Parameters<typeof origWrite>[0]);
    };
    try {
      checkFreshness("/nao/existe.json", "teste.json");
      const warnings = msgs.filter(m => m.includes("[audience-affinity] WARN"));
      assert.equal(warnings.length, 0, "arquivo ausente não deve emitir warning");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("arquivo recente (< 30d) → sem warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "affinity-freshness-"));
    const p = join(dir, "ctr.csv");
    try {
      writeFileSync(p, "data", "utf8");
      const origWrite = process.stderr.write.bind(process.stderr);
      const msgs: string[] = [];
      process.stderr.write = (chunk: unknown, ...args: unknown[]) => {
        msgs.push(String(chunk));
        return origWrite(chunk as Parameters<typeof origWrite>[0]);
      };
      try {
        checkFreshness(p, "ctr.csv", new Date());
        const warnings = msgs.filter(m => m.includes("[audience-affinity] WARN"));
        assert.equal(warnings.length, 0, "arquivo recente não emite warning");
      } finally {
        process.stderr.write = origWrite;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo com mtime > 30d → emite warning no stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "affinity-freshness-old-"));
    const p = join(dir, "ctr-old.csv");
    try {
      writeFileSync(p, "data", "utf8");
      // Set mtime to 35 days ago
      const oldTime = new Date(Date.now() - (AUDIENCE_AFFINITY_FRESHNESS_DAYS + 5) * 86_400_000);
      utimesSync(p, oldTime, oldTime);

      const origWrite = process.stderr.write.bind(process.stderr);
      const msgs: string[] = [];
      process.stderr.write = (chunk: unknown, ...args: unknown[]) => {
        msgs.push(String(chunk));
        return origWrite(chunk as Parameters<typeof origWrite>[0]);
      };
      try {
        checkFreshness(p, "ctr-old.csv", new Date());
        const warnings = msgs.filter(m => m.includes("[audience-affinity] WARN"));
        assert.ok(warnings.length > 0, "deve emitir warning para arquivo antigo");
        assert.ok(warnings[0].includes("diaria-atualiza-audiencia"), "warning deve mencionar o comando de atualização");
      } finally {
        process.stderr.write = origWrite;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nunca bloqueia mesmo com arquivo antigo (checkFreshness retorna void)", () => {
    const dir = mkdtempSync(join(tmpdir(), "affinity-freshness-noblock-"));
    const p = join(dir, "old.csv");
    try {
      writeFileSync(p, "data", "utf8");
      const oldTime = new Date(Date.now() - 90 * 86_400_000);
      utimesSync(p, oldTime, oldTime);
      // Deve retornar undefined sem throw nem process.exit
      const result = checkFreshness(p, "old.csv", new Date());
      assert.equal(result, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── loadAudienceSignals — integração com fixtures ────────────────────────────

describe("loadAudienceSignals — fixture sintética", () => {
  it("retorna loaded:false quando data/ ausente (ex: worktree fresco)", () => {
    const signals = loadAudienceSignals("/caminho/que/nao/existe");
    assert.equal(signals.loaded, false, "sem data/ → loaded:false");
  });

  it("lê CTR de fixtures sintéticos e computa ctrByCategory", () => {
    const dir = mkdtempSync(join(tmpdir(), "affinity-load-"));
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    try {
      // CSV mínimo com header correto (campo `anchor` nomeado — ver update-audience.ts parseCtrFromCsv)
      const csvLines = [
        "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin",
        `2026-06-01,Post Test,,Tutorial ChatGPT,https://ex.com,ex.com,1000,30,30,3.0,Treinamento,INT`,
        `2026-06-01,Post Test,,Notícia Lançamento,https://ex.com,ex.com,1000,5,5,0.5,Lançamento,INT`,
      ];
      writeFileSync(join(dataDir, "link-ctr-table.csv"), csvLines.join("\n"), "utf8");
      // Não criar audience-raw.json — deve funcionar com só o CTR

      const signals = loadAudienceSignals(dir);
      assert.ok(signals.loaded, "deve carregar com CSV presente");
      assert.ok(signals.ctrByCategory.size > 0, "deve ter categorias");
      // Treinamento tem CTR 3.0% vs média esperada ~1.75% → relativo > 1
      const treinamento = signals.ctrByCategory.get("Treinamento");
      assert.ok(treinamento !== undefined, "deve ter categoria Treinamento");
      assert.ok(treinamento > 1, "Treinamento deve ter CTR acima da média relativa");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lê survey tools de fixtures sintéticos", () => {
    const dir = mkdtempSync(join(tmpdir(), "affinity-survey-"));
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    try {
      const survey = JSON.stringify([{
        status: "active",
        answers: [{
          question_prompt: "Quais ferramentas de IA você usa?",
          answer: "chatgpt, cursor",
        }],
      }]);
      writeFileSync(join(dataDir, "audience-raw.json"), survey, "utf8");
      // Não criar CTR — deve funcionar com só o survey

      const signals = loadAudienceSignals(dir);
      assert.ok(signals.loaded, "deve carregar com survey presente");
      assert.ok(signals.surveyTools.size > 0, "deve ter ferramentas do survey");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadAudienceSignals trata erro de parse graciosamente", () => {
    const dir = mkdtempSync(join(tmpdir(), "affinity-bad-"));
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    try {
      writeFileSync(join(dataDir, "audience-raw.json"), "JSON INVÁLIDO {{{", "utf8");
      // Deve retornar sem throw mesmo com JSON corrompido
      assert.doesNotThrow(() => loadAudienceSignals(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
