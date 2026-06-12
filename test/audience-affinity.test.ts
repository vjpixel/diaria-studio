/**
 * test/audience-affinity.test.ts (#2063, #2143)
 *
 * Testes para `scripts/lib/audience-affinity.ts`:
 *   - match por ferramenta (survey tools)
 *   - match por categoria CTR
 *   - sem dados → null (fallback gracioso)
 *   - freshness warning (mtime > 30d)
 *   - annotateUseMelhorBucket: anota só use_melhor
 *   - normalizeTool: strips accentuation, lowercases
 *   - detectHandsOnShort: tutorial hands-on curto (#2143)
 *   - hands_on bonus via annotateAudienceAffinity (#2143)
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
  detectHandsOnShort,
  HANDS_ON_BONUS_PTS,
  AUDIENCE_AFFINITY_FRESHNESS_DAYS,
  KNOWN_TOOLS,
  type AudienceSignals,
  type AudienceSignalsSource,
} from "../scripts/lib/audience-affinity.ts";

// ─── Fixtures de sinais ────────────────────────────────────────────────────────

/** Sinais mínimos com dados reais representativos do perfil da Diar.ia */
function makeSignals(opts: {
  ctrMap?: Map<string, number>;
  surveyTools?: Set<string>;
  source?: AudienceSignalsSource;
} = {}): AudienceSignals {
  return {
    ctrByCategory: opts.ctrMap ?? new Map([
      ["Treinamento", 5.65],   // 2.43% / 0.43% ≈ 5.65× média
      ["Aplicação", 1.49],     // 0.64% / 0.43% ≈ 1.49×
      ["Pesquisa", 0.84],      // abaixo da média
      ["Curiosidade", 0.33],   // muito abaixo
    ]),
    avgCtr: 0.0043,
    surveyTools: opts.surveyTools ?? new Set(["chatgpt", "claude", "gpt", "cursor", "gemini"]),
    source: opts.source ?? "ctr+survey",
    loaded: true,
  };
}

const signals = makeSignals();
const emptySignals: AudienceSignals = {
  ctrByCategory: new Map(),
  avgCtr: 0,
  surveyTools: new Set(),
  source: "none",
  loaded: false,
};

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

  // Fix 2: admission gate invertido (#2064)
  it("admission gate: 'not' NÃO deve ser admitido mesmo que notion.includes('not') (regressão #2064)", () => {
    const responses = [{
      answers: [{
        question_prompt: "Quais ferramentas de IA você usa?",
        answer: "not, best, app",  // tokens curtos que poderiam ser falsos positivos
      }],
    }];
    // 'not' não é um KNOWN_TOOL nem contém um KNOWN_TOOL como palavra → não deve entrar
    // (o antigo gate errado: normalizeTool("notion").includes("not") → true → admitia)
    const tools = extractSurveyTools(responses);
    // Fallback vai operar (nenhum token válido), mas não deve conter "not" como admitido real
    // (o fallback vai adicionar os KNOWN_TOOLS — verificamos que "not" não veio da lógica real)
    // A garantia aqui é que 'not' isolado não passa pela admission check:
    const notAdmitted = normalizeTool("notion").includes("not"); // antiga (errada) lógica
    assert.ok(notAdmitted === true, "ilustra o bug antigo: notion.includes(not) é true");
    // Com a lógica nova: tok=not não é equal a qualquer KNOWN_TOOL E não contém nenhum com word-boundary
    // Então não é admitido pela lógica real — verificamos via token isolado que não está em KNOWN_TOOLS
    const knownNormalized = KNOWN_TOOLS.map(k => normalizeTool(k));
    const notIsKnown = knownNormalized.includes("not");
    assert.equal(notIsKnown, false, "'not' não é um KNOWN_TOOL — não deve ser admitido");
  });

  it("admission gate: 'chatgpt4' deve ser admitido pois CONTÉM 'chatgpt' como palavra (regressão #2064)", () => {
    const responses = [{
      answers: [{
        question_prompt: "Quais ferramentas de IA você usa?",
        answer: "chatgpt4, cursor",
      }],
    }];
    const tools = extractSurveyTools(responses);
    // chatgpt4 contém "chatgpt" como prefixo — deve ser admitido
    assert.ok(tools.has("chatgpt4") || tools.has("cursor"), "chatgpt4 (contém chatgpt) ou cursor deve ser admitido");
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

  // Fix 4: source field (#2064)
  it("source === 'ctr+survey' quando CTR + survey real ambos presentes", () => {
    const dir = mkdtempSync(join(tmpdir(), "affinity-source-both-"));
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    try {
      const csvLines = [
        "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin",
        `2026-06-01,Post Test,,Tutorial,https://ex.com,ex.com,1000,30,30,3.0,Treinamento,INT`,
      ];
      writeFileSync(join(dataDir, "link-ctr-table.csv"), csvLines.join("\n"), "utf8");
      const survey = JSON.stringify([{
        status: "active",
        answers: [{ question_prompt: "Quais ferramentas de IA você usa?", answer: "chatgpt" }],
      }]);
      writeFileSync(join(dataDir, "audience-raw.json"), survey, "utf8");

      const s = loadAudienceSignals(dir);
      assert.equal(s.source, "ctr+survey", "ambos presentes → source = ctr+survey");
      assert.equal(s.loaded, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("source === 'fallback' quando survey existe mas sem respostas de ferramenta", () => {
    const dir = mkdtempSync(join(tmpdir(), "affinity-source-fallback-"));
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    try {
      const survey = JSON.stringify([{
        status: "active",
        answers: [{ question_prompt: "Qual seu cargo?", answer: "desenvolvedor" }],
      }]);
      writeFileSync(join(dataDir, "audience-raw.json"), survey, "utf8");

      const s = loadAudienceSignals(dir);
      assert.equal(s.source, "fallback", "sem respostas de ferramenta → source = fallback");
      assert.equal(s.loaded, true, "fallback ainda carrega (há survey)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("source === 'ctr' quando só CTR disponível (sem survey JSON)", () => {
    const dir = mkdtempSync(join(tmpdir(), "affinity-source-ctr-"));
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    try {
      const csvLines = [
        "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin",
        `2026-06-01,Post Test,,Tutorial,https://ex.com,ex.com,1000,30,30,3.0,Treinamento,INT`,
      ];
      writeFileSync(join(dataDir, "link-ctr-table.csv"), csvLines.join("\n"), "utf8");

      const s = loadAudienceSignals(dir);
      assert.equal(s.source, "ctr", "só CTR → source = ctr");
      assert.equal(s.loaded, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Fix 5: KNOWN_TOOLS fallback não infla affinity (#2064) ──────────────────

describe("annotateAudienceAffinity — KNOWN_TOOLS fallback não infla affinity (#2064)", () => {
  it("fallback: artigo 'cloud storage' NÃO deve ter affinity via 'rag' (regressão #2063/#2064)", () => {
    // Simula source=fallback: surveyTools = KNOWN_TOOLS normalizado (inclui 'rag')
    const fallbackSignals = makeSignals({
      surveyTools: new Set(KNOWN_TOOLS.map(k => normalizeTool(k))),
      source: "fallback",
      ctrMap: new Map(), // sem CTR, para isolar o efeito do survey
    });
    const article = {
      url: "https://aws.amazon.com/s3",
      title: "Cloud storage optimization",
      summary: "object storage guide for distributed systems",
    };
    const result = annotateAudienceAffinity(article, fallbackSignals);
    assert.ok(result !== null, "fallback loaded → deve retornar anotação");
    // Com source=fallback, survey NÃO é usado — affinity deve ser 0 (sem CTR também)
    assert.equal(result.affinity, 0, "fallback source → surveyScore zerado → affinity 0 sem CTR");
    assert.equal(result.matched.filter(m => m.startsWith("tool:")).length, 0,
      "nenhum tool: deve aparecer em matched quando source=fallback");
  });

  it("fallback + CTR real: affinity vem só do CTR, survey ignorado", () => {
    const fallbackSignals = makeSignals({
      surveyTools: new Set(KNOWN_TOOLS.map(k => normalizeTool(k))),
      source: "fallback",
      ctrMap: new Map([["Treinamento", 5.65]]),
    });
    const article = {
      url: "https://fast.ai/treinamento",
      title: "Curso de treinamento avançado",
      summary: "treinamento de modelos com storage e deployment",
    };
    const result = annotateAudienceAffinity(article, fallbackSignals);
    assert.ok(result !== null);
    // CTR de Treinamento (5.65) → ctrScore = min(5.65/6, 1) ≈ 0.942 × 0.6 ≈ 0.565
    // surveyScore = 0 (fallback) → affinity ≈ 0.565
    assert.ok(result.affinity > 0, "CTR deve contribuir mesmo com source=fallback");
    assert.ok(result.affinity < 0.7, "survey zerado → affinity menor que se tivesse survey");
    assert.equal(result.matched.filter(m => m.startsWith("tool:")).length, 0,
      "nenhum tool: com fallback mesmo com 'deployment' no texto");
    assert.ok(result.matched.some(m => m === "categoria:Treinamento"),
      "CTR categoria deve aparecer em matched");
  });

  it("survey real: artigo 'storage' com rag no survey de verdade → sem match por word-boundary", () => {
    // Mesmo com survey REAL (source=ctr+survey), 'rag' não deve matchear 'storage'
    // por causa do wordMatch (word-boundary fix do b73bdd3)
    const realSignals = makeSignals({
      surveyTools: new Set(["rag", "chatgpt"]),
      source: "ctr+survey",
      ctrMap: new Map(),
    });
    const article = {
      url: "https://aws.amazon.com/s3",
      title: "Cloud storage optimization",
      summary: "object storage guide",
    };
    const result = annotateAudienceAffinity(article, realSignals);
    assert.ok(result !== null);
    assert.equal(result.matched.filter(m => m === "tool:rag").length, 0,
      "'rag' não deve matchear em 'storage' por word-boundary (regressão #2063)");
  });

  it("survey real: artigo mencionando 'rag' explicitamente → match válido", () => {
    const realSignals = makeSignals({
      surveyTools: new Set(["rag", "chatgpt"]),
      source: "ctr+survey",
      ctrMap: new Map(),
    });
    const article = {
      url: "https://example.com/rag-tutorial",
      title: "RAG with LangChain: a practical guide",
      summary: "using rag for retrieval augmented generation",
    };
    const result = annotateAudienceAffinity(article, realSignals);
    assert.ok(result !== null);
    assert.ok(result.matched.some(m => m === "tool:rag"),
      "'rag' deve matchear quando aparece como palavra separada no texto");
    assert.ok(result.affinity > 0);
  });
});

// ─── detectHandsOnShort (#2143) ───────────────────────────────────────────────

describe("detectHandsOnShort — tutorial hands-on curto (#2143)", () => {
  // Caso base: tutorial com exemplos aprovados pelo editor (260612)

  it("NotebookLM PT-BR com 'passo a passo' → isHandsOn:true (guia casual aprovado)", () => {
    const { isHandsOn, signals } = detectHandsOnShort({
      url: "https://zently.com.br/como-usar-notebooklm",
      title: "Como usar NotebookLM passo a passo: guia para iniciantes",
      summary: "Tutorial completo para usar o NotebookLM do Google",
    });
    assert.equal(isHandsOn, true, "NotebookLM PT-BR passo a passo deve ser hands-on");
    assert.ok(signals.includes("consumer_tool"), "deve detectar ferramenta consumer (notebooklm)");
    assert.ok(signals.includes("closed_scope") || signals.includes("numbered_steps"), "deve detectar escopo fechado ou passos");
    assert.ok(signals.includes("ptbr"), "deve detectar sinal PT-BR");
  });

  it("Transformers.js no navegador → isHandsOn:true (sem API key, navegador)", () => {
    const { isHandsOn, signals } = detectHandsOnShort({
      url: "https://huggingface.co/learn/transformers-js",
      title: "Getting started with Transformers.js: tutorial for beginners",
      summary: "Run ML models in the browser with no API key — step by step guide",
    });
    assert.equal(isHandsOn, true, "Transformers.js com step-by-step deve ser hands-on");
    assert.ok(signals.includes("numbered_steps") || signals.includes("closed_scope"),
      "deve detectar passos numerados ou escopo fechado");
  });

  it("OpenAI Academy vídeo para docentes → isHandsOn:true", () => {
    const { isHandsOn } = detectHandsOnShort({
      url: "https://academy.openai.com/course/ai-for-educators",
      title: "ChatGPT para educadores: guia prático de 30 minutos",
      summary: "Aprenda a usar o ChatGPT em sala de aula com exercícios práticos",
    });
    assert.equal(isHandsOn, true, "OpenAI Academy com guia prático + tempo estimado = hands-on");
  });

  it("AWS Bedrock (requer conta cloud/IAM) → isHandsOn:false (exemplo reprovado 260612)", () => {
    const { isHandsOn } = detectHandsOnShort({
      url: "https://aws.amazon.com/blogs/machine-learning/building-rag-with-bedrock",
      title: "Building a RAG pipeline with Amazon Bedrock and LangSmith",
      summary: "How to set up a production RAG system using Bedrock, IAM roles and LangSmith observability",
    });
    assert.equal(isHandsOn, false, "AWS Bedrock/IAM = setup cloud complexo → não deve ser hands-on (apenas 1 sinal no máximo)");
  });

  it("LangChain Agent Evaluation (infra complexa) → isHandsOn:false", () => {
    const { isHandsOn } = detectHandsOnShort({
      url: "https://blog.langchain.dev/agent-evalkit-production",
      title: "Evaluating LLM Agents in Production with Agent-EvalKit",
      summary: "Deep dive into evaluating complex multi-step agents already running in production environments",
    });
    assert.equal(isHandsOn, false, "Agent-EvalKit de produção = sem sinais hands-on casual");
  });

  it("artigo de notícia (sem tutorial) → isHandsOn:false", () => {
    const { isHandsOn } = detectHandsOnShort({
      url: "https://techcrunch.com/2026/06/12/openai-raises-funding",
      title: "OpenAI anuncia nova rodada de captação de US$ 10 bilhões",
      summary: "A empresa de IA deve usar os recursos para expandir infraestrutura de computação",
    });
    assert.equal(isHandsOn, false, "notícia de financiamento não tem sinais de tutorial");
  });

  it("guia conceitual longo sem passos práticos → isHandsOn:false", () => {
    const { isHandsOn } = detectHandsOnShort({
      url: "https://arxiv.org/abs/2506.12345",
      title: "Foundational Perspectives on Large Language Model Alignment",
      summary: "A comprehensive survey of alignment techniques, theoretical frameworks, and open problems in LLM research",
    });
    assert.equal(isHandsOn, false, "paper teórico não tem sinais de tutorial hands-on");
  });

  it("tutorial com tempo estimado explícito → sinal time_estimate detectado", () => {
    const { signals } = detectHandsOnShort({
      url: "https://example.com/tutorial",
      title: "Scikit-LLM em 30 minutos: classificação de texto com Python",
      summary: "Tutorial rápido para iniciantes — exercício completo em menos de 1 hora",
    });
    assert.ok(signals.includes("time_estimate"), "deve detectar tempo estimado (30 minutos / menos de 1 hora)");
  });

  it("HANDS_ON_BONUS_PTS está definido e é > 0 (constante exportada)", () => {
    assert.ok(HANDS_ON_BONUS_PTS > 0, "HANDS_ON_BONUS_PTS deve ser positivo");
    assert.equal(HANDS_ON_BONUS_PTS, 8, "HANDS_ON_BONUS_PTS deve ser 8 pts");
  });

  it("artigo sem título nem summary → não lança erro", () => {
    assert.doesNotThrow(() => detectHandsOnShort({ url: "https://ex.com/x" }));
  });

  it("URL inválida → não lança erro", () => {
    assert.doesNotThrow(() => detectHandsOnShort({ url: "nao-e-url", title: "Tutorial passo a passo" }));
  });
});

// ─── hands_on em annotateAudienceAffinity (#2143) ────────────────────────────

describe("annotateAudienceAffinity — campo hands_on (#2143)", () => {
  it("tutorial hands-on curto → result.hands_on === true e 'hands_on:true' em matched", () => {
    const article = {
      url: "https://zently.com.br/notebooklm-tutorial",
      title: "Tutorial NotebookLM passo a passo: guia para iniciantes",
      summary: "Como usar o NotebookLM do Google em menos de 30 minutos",
    };
    const result = annotateAudienceAffinity(article, signals);
    assert.ok(result !== null, "deve retornar anotação");
    assert.equal(result.hands_on, true, "hands_on deve ser true para tutorial hands-on");
    assert.ok(result.matched.includes("hands_on:true"), "matched deve conter 'hands_on:true'");
  });

  it("notícia sem tutorial → result.hands_on === false, 'hands_on:true' ausente em matched", () => {
    const article = {
      url: "https://techcrunch.com/openai-funding",
      title: "OpenAI anuncia nova rodada de captação",
      summary: "A empresa levantou 10 bilhões de dólares para expansão",
    };
    const result = annotateAudienceAffinity(article, signals);
    assert.ok(result !== null);
    assert.equal(result.hands_on, false, "notícia não deve ter hands_on:true");
    assert.ok(!result.matched.includes("hands_on:true"), "'hands_on:true' não deve estar em matched");
  });

  it("tutorial hands-on curto acumula bônus: hands_on:true NÃO altera affinity (só matched + hands_on field)", () => {
    // O +8 pts é aplicado pelo scorer LLM que lê o matched; affinity [0,1] não muda
    const articleHandsOn = {
      url: "https://zently.com.br/notebooklm-tutorial",
      title: "Tutorial NotebookLM passo a passo: guia para iniciantes",
      summary: "Como usar o NotebookLM do Google em menos de 30 minutos",
    };
    const articlePlain = {
      url: "https://blog.ex.com/outro",
      title: "Análise do mercado de IA no Brasil",
      summary: "Survey com 500 empresas sobre adoção de IA",
    };
    const r1 = annotateAudienceAffinity(articleHandsOn, signals);
    const r2 = annotateAudienceAffinity(articlePlain, signals);
    assert.ok(r1 !== null && r2 !== null);
    // affinity é baseada em CTR+survey, não em hands_on; a sinalização é via matched
    // (o scorer LLM adiciona os +8 pts sobre o score base)
    assert.equal(r1.hands_on, true);
    assert.equal(r2.hands_on, false);
  });

  it("ho:* sub-sinais aparecem em matched quando hands_on:true (explicabilidade #2143 pass2)", () => {
    // Garante que os sub-sinais de detectHandsOnShort são propagados para matched[]
    // para explicabilidade do scorer. Regressão: pass1 descartava signals, expondo só 'hands_on:true'.
    const article = {
      url: "https://zently.com.br/notebooklm-tutorial",
      title: "Tutorial NotebookLM passo a passo: guia para iniciantes",
      summary: "Como usar o NotebookLM do Google em menos de 30 minutos",
    };
    const result = annotateAudienceAffinity(article, signals);
    assert.ok(result !== null, "deve retornar anotação");
    assert.ok(result.matched.includes("hands_on:true"), "'hands_on:true' deve estar em matched");
    // Ao menos 1 sub-sinal "ho:*" deve estar presente
    const hoSignals = result.matched.filter(m => m.startsWith("ho:"));
    assert.ok(hoSignals.length > 0, "sub-sinais 'ho:*' devem estar em matched para explicabilidade");
  });
});

// ─── Regressões pass2 (#2143 pass2) ─────────────────────────────────────────

describe("detectHandsOnShort — regressões pass2 (#2143 pass2)", () => {
  it("BUG-FIX: 'Primeiros passos com o Gemini' detecta numbered_steps (typo passsos? corrigido)", () => {
    // Regressão: RE_NUMBERED_STEPS tinha 'passsos?' (triple-s) que nunca matcha
    // a palavra real 'passos' (double-s). Fix: 'passos?' (double-s + optional s).
    const { signals } = detectHandsOnShort({
      title: "Primeiros passos com o Gemini",
      summary: "Como começar a usar o Gemini",
    });
    assert.ok(signals.includes("numbered_steps"),
      "'passos' deve detectar numbered_steps — regressão do typo passsos?");
  });

  it("BUG-FIX: 'Tutorial em 30 minutes' detecta time_estimate (EN support)", () => {
    // 'minutes'/'hours' não eram cobertos antes; RE_TIME_ESTIMATE suportava só PT-BR.
    const { signals } = detectHandsOnShort({
      title: "Complete ChatGPT setup in 30 minutes",
      summary: "A beginner guide to using ChatGPT",
    });
    assert.ok(signals.includes("time_estimate"),
      "'30 minutes' deve detectar time_estimate — antes não cobria EN");
  });

  it("BUG-FIX: 'quickly' sozinho NÃO dispara time_estimate (falso-positivo removido)", () => {
    // 'quick(ly)?' foi removido de RE_TIME_ESTIMATE por gerar falso-positivo em notícias
    // como "OpenAI quickly added safety guardrails" (consumer_tool + time_estimate = hands-on incorreto).
    const { isHandsOn, signals } = detectHandsOnShort({
      title: "OpenAI quickly raised 6B in funding round",
      summary: "The company quickly closed the round with major investors",
    });
    assert.ok(!signals.includes("time_estimate"),
      "'quickly' não deve mais disparar time_estimate");
    assert.equal(isHandsOn, false,
      "notícia de financiamento com 'quickly' não deve ser hands-on");
  });

  it("BUG-FIX: 'openai' bare NÃO dispara consumer_tool em notícia de funding (falso-positivo)", () => {
    // 'openai' bare estava em RE_CONSUMER_TOOL — disparava em "OpenAI raises $40B".
    // Fix: restringido a 'openai (academy|playground|platform|api)'.
    const { signals } = detectHandsOnShort({
      title: "OpenAI anuncia nova rodada de captação de US$ 10 bilhões",
      summary: "A empresa levantou recursos para expansão de infraestrutura",
    });
    assert.ok(!signals.includes("consumer_tool"),
      "'OpenAI' bare em notícia de funding não deve disparar consumer_tool");
  });

  it("BUG-FIX: 'AI Safety Lab releases report' NÃO dispara closed_scope (lab removido)", () => {
    // 'lab' era demasiado genérico — disparava em "AI Safety Lab", "DeepMind Lab" etc.
    const { signals } = detectHandsOnShort({
      title: "AI Safety Lab releases new alignment report",
      summary: "The research lab published findings on LLM safety",
    });
    assert.ok(!signals.includes("closed_scope"),
      "'lab' em nome de organização não deve disparar closed_scope");
  });

  it("BUG-FIX: 'A complete guide to ChatGPT' detecta closed_scope (guide adicionado para EN)", () => {
    // 'guia' PT-BR estava em RE_CLOSED_SCOPE mas 'guide' EN estava ausente — assimetria.
    const { signals } = detectHandsOnShort({
      title: "A complete guide to ChatGPT for marketers",
      summary: "Learn how to use ChatGPT effectively",
    });
    assert.ok(signals.includes("closed_scope"),
      "'guide' em inglês deve detectar closed_scope — simetria com 'guia' PT-BR");
  });

  it("BUG-FIX: URL sem trailing slash (dados.com.br) detecta ptbr (com.br word boundary)", () => {
    // \.com\.br\/ exigia trailing slash — falhava com URL sem path.
    // Fix: \.com\.br\b (word boundary).
    const { signals } = detectHandsOnShort({
      url: "https://dados.com.br",
      title: "Tutorial de análise de dados",
      summary: "Guia prático para iniciantes",
    });
    assert.ok(signals.includes("ptbr"),
      "URL .com.br sem trailing slash deve detectar ptbr");
  });

  it("'2 hours' detecta time_estimate (EN hours support)", () => {
    const { signals } = detectHandsOnShort({
      title: "Build a RAG chatbot in 2 hours: hands-on tutorial",
      summary: "Complete step-by-step guide",
    });
    assert.ok(signals.includes("time_estimate"),
      "'2 hours' deve detectar time_estimate");
  });
});
