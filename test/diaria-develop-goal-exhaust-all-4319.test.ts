/**
 * test/diaria-develop-goal-exhaust-all-4319.test.ts (#4319)
 *
 * Trava o Goal de esgotamento TOTAL do /diaria-develop: por padrão a sessão
 * ataca o backlog aberto inteiro em 4 ondas priorizadas (bugs → bloqueadas →
 * P0/P1 → resto) até nenhuma issue estar aberta, sem os caps mecânicos de
 * re-scan/findings que #4297 herdou do overnight — quem segura a sessão
 * agora é só o editor (gate do grupo 3 + Fallback de ausência).
 *
 * Não testa comportamento do LLM (SKILL.md é prompt); testa presença/ausência
 * de strings no texto-fonte, como diaria-develop-frontload.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEVELOP_SKILL_MD = resolve(ROOT, ".claude/skills/diaria-develop/SKILL.md");
const OVERNIGHT_SKILL_MD = resolve(ROOT, ".claude/skills/diaria-overnight/SKILL.md");
const CLAUDE_MD = resolve(ROOT, "CLAUDE.md");

const develop = readFileSync(DEVELOP_SKILL_MD, "utf8");
const overnight = readFileSync(OVERNIGHT_SKILL_MD, "utf8");
const claudeMd = readFileSync(CLAUDE_MD, "utf8");

describe("diaria-develop goal_policy — 3 valores, exhaust_all é o default (#4319)", () => {
  it("goal_policy aceita exhaust_all | blocked_only | table_only, default exhaust_all", () => {
    assert.match(develop, /`exhaust_all`/, "exhaust_all deve existir");
    assert.match(develop, /`blocked_only`/, "blocked_only deve existir");
    assert.match(develop, /`table_only`/, "table_only deve existir (inalterado desde #4297)");
    assert.match(develop, /\*\*default desde #4319\*\*/, "exhaust_all documentado como novo default");
  });

  it("briefing item 7 (Fase 0.5) apresenta as 3 opções, --no-implement continua forçando table_only sem perguntar", () => {
    assert.match(
      develop,
      /Política de esgotamento.*agora com 3 opções/i,
      "item 7 do briefing deve declarar as 3 opções",
    );
    assert.match(
      develop,
      /Pulada se `--no-implement` está ativo/,
      "--no-implement segue pulando a pergunta e forçando table_only",
    );
  });

  it("plan.json legado com policy: exhaust é lido como blocked_only, nunca exhaust_all", () => {
    assert.match(develop, /\*\*Migração de legado \(#4319\)/, "seção de migração de legado deve existir");
    assert.match(
      develop,
      /goal\.policy:\s*"exhaust"`\s*—\s*ler esse valor como \*\*`blocked_only`\*\*, nunca como `exhaust_all`/,
      "regra de migração explícita: exhaust legado -> blocked_only, nunca exhaust_all",
    );
  });
});

describe("diaria-develop 4 ondas priorizadas (#4319)", () => {
  it("ondas 1a -> 1b -> 2 -> 3 documentadas em ordem fixa, cada uma esgotada antes da próxima", () => {
    assert.match(develop, /\*\*1a\*\*/, "onda 1a documentada");
    assert.match(develop, /\*\*1b\*\*/, "onda 1b documentada");
    assert.match(develop, /Ordem fixa.*um grupo só é montado depois que o anterior está esgotado/i);
  });

  it("bug tem precedência absoluta sobre bloqueio e prioridade na classificação de tier", () => {
    assert.match(develop, /\*\*`bug` ganha de tudo\*\*/, "precedência de bug documentada explicitamente");
    assert.match(
      develop,
      /Um bug bloqueado vai pra \*\*1a\*\*, não pra 1b/,
      "bug bloqueado vai pra 1a, não 1b",
    );
    assert.match(
      develop,
      /Um bug P0 elegível vai pra \*\*1a\*\*, não pra 2/,
      "bug P0 elegível vai pra 1a, não 2",
    );
  });

  it("elegivel_especial, not-this-week (issue inteira) e fora-do-escopo ficam fora do target_set em qualquer política", () => {
    assert.match(develop, /\*\*Não entra no alvo em NENHUMA política\*\*/);
    assert.match(develop, /`fora-do-escopo`/);
    assert.match(develop, /`elegivel_especial`/);
  });

  it("ondas são montadas DEPOIS do filtro --bugs/--priority/--issues/--only; Goal avaliado contra o escopo filtrado", () => {
    assert.match(
      develop,
      /as ondas são montadas depois desse filtro, não antes/i,
      "ordem explícita: filtro primeiro, ondas depois",
    );
  });
});

describe("diaria-develop re-varredura sem cap (#4319)", () => {
  it("cap de 2 re-scans do #4297 foi eliminado; rescan-limit some do enum de motivos do develop", () => {
    assert.match(
      develop,
      /O cap de 2 re-scans, que existia em #4297, foi eliminado no develop/,
      "eliminação do cap documentada explicitamente",
    );
    assert.match(
      develop,
      /deixou de existir no develop/,
      "rescan-limit deixa de existir no develop",
    );
  });

  it("dois momentos de re-varredura documentados: re-checagem entre ondas + re-varredura de convergência, ambos sem cap", () => {
    assert.match(develop, /\*\*Re-checagem entre ondas\*\*/);
    assert.match(develop, /\*\*Re-varredura de convergência\*\*/);
    assert.match(develop, /ambos \*\*sem cap\*\*/);
  });

  it("re-checagem entre ondas pode reclassificar issue nova pra um tier anterior (current_tier volta)", () => {
    assert.match(
      develop,
      /`current_tier` \*\*volta\*\* pra (esse|ele)/,
      "current_tier reabre tier anterior quando issue nova cai lá",
    );
  });

  it("rescans_done e findings_depth viram contadores puros de observabilidade no develop — nenhum ramo de lógica os lê pra decidir parar", () => {
    assert.match(
      develop,
      /`rescans_done`.*vira \*\*contador puro de observabilidade\*\*/s,
      "rescans_done documentado como contador puro",
    );
    assert.match(
      develop,
      /contadores puros de observabilidade no develop desde #4319.*sem cap, nenhuma lógica de parada lê o valor/s,
      "declaração explícita de que nenhuma lógica ramifica nos contadores",
    );
  });
});

describe("diaria-develop findings deixam de ser classe especial (#4319)", () => {
  it("finding vira issue como qualquer outra, classificada por tier — sem mini-rodada numerada nem exclusão por created_at", () => {
    assert.match(develop, /\*\*Findings não são mais classe especial no develop \(#4319\)\.\*\*/);
    assert.match(
      develop,
      /o finding vira uma issue igual a qualquer outra.*classificado no tier dele pelas mesmas regras/is,
    );
    assert.doesNotMatch(
      develop,
      /mini-rodada 1.*mini-rodada 2/is,
      "develop não deve mais descrever o fluxo de mini-rodadas numeradas do overnight como próprio",
    );
  });

  it("Fase 2 reporta a cadeia de findings (gerados/consumidos/profundidade) como substituto do cap", () => {
    assert.match(develop, /\*\*Cadeia de findings \(#4319/);
    assert.match(develop, /substitui o cap de profundidade como sinal/i);
  });
});

describe("diaria-develop gate do grupo 3 (#4319)", () => {
  it("gate obrigatório com 3 opções (entrar/parar/escolher), dispara sempre — inclusive em reentradas", () => {
    assert.match(develop, /## Gate do grupo 3 \(decisão do editor, #4319\)/);
    assert.match(develop, /\*\*entrar\*\* — monta as ondas do grupo 3 normalmente/);
    assert.match(develop, /\*\*parar aqui\*\*/);
    assert.match(develop, /\*\*escolher quais\*\*/);
    assert.match(develop, /o gate pergunta \*\*de novo\*\*/, "reentrada dispara o gate de novo");
  });

  it("gate NÃO é pulável por wave_policy=auto; sem resposta = parar (Fallback de ausência)", () => {
    assert.match(develop, /\*\*Este gate não é pulável por `wave_policy: auto`\*\*/);
    assert.match(develop, /\*\*Sem resposta = parar\*\*, não = entrar/);
  });

  it("issues do grupo 3 não-entrado vão pro resíduo SEM virar pulada", () => {
    assert.match(
      develop,
      /\*\*sem\*\* marcar as issues como `pulada`/,
      "grupo 3 não-entrado não deve virar pulada — elas não foram recusadas",
    );
  });
});

describe("diaria-develop agrupamento por colisão vira 1 PR (#4319)", () => {
  it("issues que colidem em arquivo fundem numa unidade só, com Closes por issue", () => {
    assert.match(develop, /\*\*fundem numa única unidade\*\*/);
    assert.match(develop, /`Closes #N` explícito pra CADA issue do cluster/);
    assert.doesNotMatch(
      develop,
      /serializam entre si \(rebase em master após o cluster-mate mergear\)/,
      "não deve mais descrever colisão como motivo de serializar em ondas separadas",
    );
  });

  it("cat D continua sempre solo, nunca funde mesmo colidindo", () => {
    assert.match(develop, /Unidades cat\. D \(blast-radius\) rodam \*\*sempre solo\*\*/);
    assert.match(develop, /nunca fundem com ninguém, mesmo colidindo em arquivo/);
  });

  it("revert é tudo-ou-nada pra issues fundidas; agrupamento por tema sem colisão real não foi pedido", () => {
    assert.match(develop, /\*\*Revert é tudo-ou-nada\*\* pras issues fundidas/);
    assert.match(develop, /O editor \*\*não\*\* pediu agrupamento por tema\/área sem colisão real de arquivo/);
  });
});

describe("diaria-develop plan.json schema — goal.tiers / current_tier / tier3_gate (#4319)", () => {
  it("exemplo de goal no schema documenta tiers, current_tier e tier3_gate", () => {
    assert.match(develop, /"tiers":\s*\{\s*"1a":/);
    assert.match(develop, /"current_tier":\s*"1a"/);
    assert.match(develop, /"tier3_gate":\s*\{/);
    assert.match(develop, /`decision` ∈ `entrar`\|`parar`\|`escolher`\|`sem-resposta`/);
  });
});

describe("diaria-develop Fase 2 — abre com Goal, lista resíduo por tier (#4319)", () => {
  it("linha de abertura inclui a política e, quando não atingido, resíduo por tier", () => {
    assert.match(
      develop,
      /Goal \(escopo: \{descrição do escopo efetivo\}, política: \{exhaust_all\|blocked_only\}\)/,
    );
    assert.match(develop, /listar o resíduo \*\*por tier\*\*/);
  });
});

describe("diaria-develop x overnight — não é mais 'espelho invertido' (#4319)", () => {
  it("SKILL.md descreve como superconjunto em escopo, não em modo", () => {
    assert.match(develop, /\*\*superconjunto em escopo, mas não em modo\*\*/);
    assert.doesNotMatch(
      develop,
      /Espelho invertido do `\/diaria-overnight` \(#2021\): onde o overnight é autônomo e recusa tudo que está bloqueado/,
      "não deve mais afirmar que develop só ataca o bloqueado como definição central",
    );
  });

  it("CLAUDE.md não descreve mais develop como 'espelho invertido do overnight' sem qualificação", () => {
    assert.doesNotMatch(
      claudeMd,
      /o \*\*espelho invertido do overnight\*\* \(#2636\)\. Roda \*\*com o editor presente\*\* e ataca justamente o backlog \*\*BLOQUEADO\*\*/,
      "CLAUDE.md deve refletir o exhaust_all como default, não só o bloqueado",
    );
    assert.match(claudeMd, /superconjunto do overnight em escopo, não em modo/);
  });
});

describe("diaria-overnight — caps K=2 e findings_depth 2 permanecem, com nota de divergência (#4319)", () => {
  it("overnight mantém o cap K=2 de rescans_done, com comentário explicando por que diverge do develop", () => {
    assert.match(overnight, /Guard de convergência.*K=2/s);
    assert.match(
      overnight,
      /Este cap NÃO existe no `\/diaria-develop`.*overnight roda desassistido/s,
      "overnight deve comentar por que mantém o cap diferente do develop",
    );
  });

  it("overnight mantém o depth limit 2 de findings_depth, com nota de divergência", () => {
    assert.match(
      overnight,
      /Este cap de profundidade 2.*NÃO existem no `\/diaria-develop`/s,
      "overnight deve comentar por que mantém o cap de findings diferente do develop",
    );
  });

  it("Fallback de ausência e os 3 gates humanos do develop continuam intactos (não afrouxados por #4319)", () => {
    assert.match(develop, /\*\*Fallback de ausência\*\* segue intacto/);
    assert.match(develop, /Gate 1, Gate de Onda, Gate B e o \*\*gate do grupo 3\*\* \*\*não\*\* viram automáticos/);
  });
});
