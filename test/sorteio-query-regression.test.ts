/**
 * test/sorteio-query-regression.test.ts (#852)
 *
 * Regression guard contra o bug original de #852: a query do drain Gmail
 * usava `label:Diar.ia` que NÃO bate com label real (não existe nos emails
 * de respostas dos leitores — eles chegam sem label, direto em vjpixel@gmail.com).
 *
 * Resultado: drain retornava 0 threads silenciosamente em produção; nenhuma
 * resposta era processada. 3 números (Mauro #1, Joshu #2 e #3) ficaram só
 * em emails enviados manualmente, fora de `data/contest-entries.jsonl`.
 *
 * Fix em 2026-05-07: query nova procura pela referência ao remetente da
 * Beehiiv (`diaria@mail.beehiiv.com`) no body do reply + exclui mensagens
 * do próprio editor (`-from:vjpixel`).
 *
 * Esse test garante que a query incorreta não volta — falha se algum dos
 * arquivos de prompt mencionar `label:Diar.ia` em contexto de query.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILES_TO_CHECK = [
  ".claude/agents/orchestrator-stage-0-preflight.md",
  ".claude/skills/diaria-sorteio/SKILL.md",
];

describe("sorteio Gmail query regression (#852)", () => {
  it("nenhum prompt menciona a query quebrada `label:Diar.ia`", () => {
    for (const relPath of FILES_TO_CHECK) {
      const abs = resolve(process.cwd(), relPath);
      const content = readFileSync(abs, "utf8");
      // Aceita menções históricas com explicação ("query antiga", "lesson", etc)
      // mas NÃO em contexto de instrução ativa de query.
      const queryMentions = content.match(/`label:Diar\.ia[^`]*`/g) ?? [];
      const activeQueryMentions = queryMentions.filter((match) => {
        // Procura linha com "Use ... `query`" ou "query ... search_threads"
        const idx = content.indexOf(match);
        const lineStart = content.lastIndexOf("\n", idx);
        const lineEnd = content.indexOf("\n", idx);
        const line = content.slice(lineStart, lineEnd).toLowerCase();
        return (
          (line.includes("usar") || line.includes("use ")) &&
          line.includes("search_threads")
        );
      });
      assert.equal(
        activeQueryMentions.length,
        0,
        `${relPath} usa query quebrada \`label:Diar.ia\` (#852). ` +
          `Use \`"diaria@mail.beehiiv.com" -from:vjpixel\` em vez disso.`,
      );
    }
  });

  it("ambos prompts referenciam a query correta `diaria@mail.beehiiv.com`", () => {
    for (const relPath of FILES_TO_CHECK) {
      const abs = resolve(process.cwd(), relPath);
      const content = readFileSync(abs, "utf8");
      assert.match(
        content,
        /diaria@mail\.beehiiv\.com/,
        `${relPath} deve referenciar \`diaria@mail.beehiiv.com\` na query (#852)`,
      );
    }
  });

  it("ambos prompts mencionam `-from:vjpixel` pra excluir self-replies", () => {
    for (const relPath of FILES_TO_CHECK) {
      const abs = resolve(process.cwd(), relPath);
      const content = readFileSync(abs, "utf8");
      assert.match(
        content,
        /-from:vjpixel/,
        `${relPath} deve excluir mensagens do editor com \`-from:vjpixel\` (#852)`,
      );
    }
  });
});
