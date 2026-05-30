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
