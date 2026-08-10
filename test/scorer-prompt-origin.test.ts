/**
 * test/scorer-prompt-origin.test.ts (#1567 audit, finding E)
 *
 * Guard: os prompts do scorer NÃO podem hardcodar uma direção BR-vs-INT de CTR
 * que contradiga o `context/audience-profile.md` vigente.
 *
 * O #1565 inverteu o sinal (INT passou a ter CTR maior que BR), mas os três
 * prompts seguiam afirmando "conteúdo BR tem CTR ~25% maior que INT" — um fato
 * FALSO enfiado no critério primário, enviesando a seleção a cada edição. O fix
 * removeu a direção hardcoded e mandou o agente ler os números do profile.
 *
 * Este teste falha se alguém reintroduzir uma afirmação de direção BR>INT
 * enquanto o profile disser o contrário (ou vice-versa).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCORER_PROMPTS = ["scorer.md", "scorer-chunk.md", "scorer-monthly.md"];
const PROFILE = resolve(ROOT, "context/audience-profile.md");

/** Lê o CTR de uma origem da seção "Engajamento por origem" (- **BR** — CTR x%). */
function profileOriginCtr(origin: "BR" | "INT"): number | null {
  const md = readFileSync(PROFILE, "utf8");
  const m = md.match(new RegExp(`\\*\\*${origin}\\*\\*[^%\\n]*?CTR\\s*([0-9.]+)%`, "i"));
  return m ? parseFloat(m[1]) : null;
}

/** Detecta uma afirmação hardcoded de que BR tem CTR maior que INT num prompt. */
function claimsBrHigherCtr(txt: string): boolean {
  return (
    /conte[úu]do\s+BR[^.\n]*\bCTR\b[^.\n]*(maior|mais)/i.test(txt) || // "BR tem CTR ~25% maior"
    /\bBR\b[^.\n]*~?\d+\s*%\s*(mais|maior)\s*CTR/i.test(txt) || //        "BR ~25% mais CTR"
    /\bBR\b[^.\n]*\bCTR\b[^.\n]*maior\s*(que\s*)?INT/i.test(txt)
  );
}

describe("scorer prompts — sinal BR/INT não contradiz o profile (#1567 finding E)", () => {
  it("o audience-profile.md expõe CTR de BR e INT (sanity)", () => {
    assert.notEqual(profileOriginCtr("BR"), null, "profile sem linha de CTR BR");
    assert.notEqual(profileOriginCtr("INT"), null, "profile sem linha de CTR INT");
  });

  it("nenhum prompt hardcoda 'BR tem CTR maior' quando o profile diz INT > BR", () => {
    const br = profileOriginCtr("BR");
    const int = profileOriginCtr("INT");
    const profileSaysIntHigher = br !== null && int !== null && int > br;

    for (const f of SCORER_PROMPTS) {
      const txt = readFileSync(resolve(ROOT, ".claude/agents", f), "utf8");
      if (profileSaysIntHigher) {
        assert.ok(
          !claimsBrHigherCtr(txt),
          `${f} afirma que BR tem CTR maior, mas o profile diz INT (${int}%) > BR (${br}%). ` +
            `Remova a direção hardcoded e deixe o agente ler "Engajamento por origem" do audience-profile.md.`,
        );
      }
    }
  });

  it("a regex de detecção de fato pega a afirmação invertida antiga (meta-teste)", () => {
    // Garante que o guard não é vazio: as 3 frases que existiam antes do fix são detectadas.
    assert.ok(claimsBrHigherCtr("conteúdo BR tem CTR ~25% maior que INT"));
    assert.ok(claimsBrHigherCtr("conteúdo BR ~25% mais CTR que INT"));
    assert.ok(claimsBrHigherCtr("conteúdo BR tem CTR ~25% maior historicamente"));
    // E não dispara em texto neutro que apenas manda ler o profile.
    assert.ok(!claimsBrHigherCtr("sinal BR vs INT (ler a direção do audience-profile.md)"));
  });
});

describe("scorer prompts — sem CTR hardcoded que contradiga o profile (#4845)", () => {
  /**
   * Regressão: scorer.md:37 afirmava "categoria Treinamento tem CTR mais alto
   * do perfil (1.80% geral, 3.02% INT)" — contradizia o audience-profile.md
   * vigente (1.26%) e a própria instrução da linha 26 do mesmo arquivo
   * ("usar os números ATUAIS do profile, não valores fixos"). O fix (#4845)
   * removeu o número fixo, mantendo o bônus de academy sem a justificativa
   * numerada. Este teste falha se um número fixo for reintroduzido junto da
   * afirmação "CTR mais alto do perfil" para a categoria Treinamento.
   */
  const HARDCODED_TREINAMENTO_CTR_RE = /Treinamento[^.\n]*CTR[^.\n]*\(\s*[\d.]+\s*%/i;

  it("scorer.md e scorer-chunk.md não hardcodam percentual de CTR junto da afirmação sobre Treinamento", () => {
    for (const f of ["scorer.md", "scorer-chunk.md"]) {
      const txt = readFileSync(resolve(ROOT, ".claude/agents", f), "utf8");
      assert.ok(
        !HARDCODED_TREINAMENTO_CTR_RE.test(txt),
        `${f} hardcoda um percentual de CTR junto da categoria Treinamento — ` +
          `deve remeter aos números ATUAIS de context/audience-profile.md, nunca um valor fixo (#4845).`,
      );
    }
  });

  it("a regex de detecção pega a frase original do bug (meta-teste)", () => {
    assert.ok(HARDCODED_TREINAMENTO_CTR_RE.test(
      "Rationale: categoria Treinamento tem CTR mais alto do perfil (1.80% geral, 3.02% INT).",
    ));
    assert.ok(!HARDCODED_TREINAMENTO_CTR_RE.test(
      "Rationale: categoria Treinamento tem o CTR mais alto do perfil (ver números ATUAIS em audience-profile.md).",
    ));
  });

  it("scorer.md e scorer-chunk.md marcam 'Outro' como categoria não-acionável (#4845 item 3)", () => {
    for (const f of ["scorer.md", "scorer-chunk.md"]) {
      const txt = readFileSync(resolve(ROOT, ".claude/agents", f), "utf8");
      assert.ok(
        /["“']?Outro["”']?\s+n[ãa]o\s+[ée]\s+acion[áa]vel/i.test(txt),
        `${f} não marca "Outro" como não-acionável (#4845) — categoria é fallback do ` +
          `categorizador (link-ctr-categorize.ts), não pode ser buscada deliberadamente.`,
      );
    }
  });
});

describe("scorer prompts — hands-on agnóstico de bucket (#4843)", () => {
  /**
   * Regressão: o bônus hands-on (#2143) exigia "o artigo está no bucket
   * use_melhor E audience_affinity.matched contém hands_on:true". Auditoria
   * de cliques 260810 mediu lift equivalente no Radar (2,18×) — #4843 tornou
   * o bônus agnóstico de bucket. Este teste falha se a restrição de bucket
   * voltar a aparecer imediatamente antes de "hands_on:true".
   */
  it("scorer.md e scorer-chunk.md não restringem o bônus hands_on ao bucket use_melhor", () => {
    for (const f of ["scorer.md", "scorer-chunk.md"]) {
      const txt = readFileSync(resolve(ROOT, ".claude/agents", f), "utf8");
      assert.ok(
        !/est[áa]\s+no\s+bucket\s+`?use_melhor`?\s+E\s+`?audience_affinity\.matched`?\s+cont[ée]m\s+`?"?hands_on:true/i.test(txt),
        `${f} ainda restringe o bônus hands_on ao bucket use_melhor (#4843 pede agnóstico de bucket).`,
      );
      assert.ok(
        /hands_on.*(agn[óo]stico de bucket|independente do bucket)/i.test(txt) ||
        /(agn[óo]stico de bucket|independente do bucket).*hands_on/i.test(txt),
        `${f} não documenta explicitamente que o bônus hands_on é agnóstico de bucket (#4843).`,
      );
    }
  });
});

describe("scorer-select — presença da guidance de Segurança (#2131)", () => {
  /**
   * Guard: scorer-select.md deve conter a instrução de não subponderar
   * candidatos de Segurança/safety na seleção holística.
   * Falha se alguém remover o bloco durante um cleanup sem repor o corretivo.
   */
  it("scorer-select.md contém o termo 'subpondere' na rubrica principal (#2131)", () => {
    const txt = readFileSync(
      resolve(ROOT, ".claude/agents/scorer-select.md"),
      "utf8",
    );
    assert.ok(
      txt.includes("subpondere"),
      "scorer-select.md não contém 'subpondere' (#2131). " +
        "Reintroduza o bullet anti-viés de Segurança na rubrica principal de seleção (não só no desempate).",
    );
  });

  it("scorer-select.md menciona 'Segurança' na guidance anti-viés (#2131)", () => {
    const txt = readFileSync(
      resolve(ROOT, ".claude/agents/scorer-select.md"),
      "utf8",
    );
    assert.ok(
      txt.includes("Segurança"),
      "scorer-select.md não contém 'Segurança' (#2131). " +
        "Reintroduza o bullet anti-viés de Segurança/safety na rubrica principal de seleção.",
    );
  });

  it("scorer.md contém a mesma guidance anti-viés de Segurança (#2131)", () => {
    const txt = readFileSync(
      resolve(ROOT, ".claude/agents/scorer.md"),
      "utf8",
    );
    assert.ok(
      txt.includes("subpondere"),
      "scorer.md não contém 'subpondere' (#2131). " +
        "Adicione a guidance anti-viés de Segurança na etapa de seleção do scorer (fallback path).",
    );
    assert.ok(
      txt.includes("Segurança"),
      "scorer.md não contém 'Segurança' (#2131). " +
        "Adicione a guidance anti-viés de Segurança/safety na etapa de seleção do scorer (fallback path).",
    );
  });
});
