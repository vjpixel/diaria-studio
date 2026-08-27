/**
 * test/sync-beehiiv-subscribers-kit-load-bearing-6339.test.ts (#6339, item 2
 * da issue — rede de segurança pro que o item 1 NÃO cobriu)
 *
 * O item 1 do #6339 (`promoteKitSubscription`/`verifyPromotedToKit` em
 * `evaluate-brevo-diaria.ts`) fez a promoção por SCORE parar de depender da
 * ponte `sync-beehiiv-subscribers-kit.ts` — ela escreve direto no backend
 * real (`newsletterBackend`) e não fica mais tautológica.
 *
 * A auto-confirmação (Passo 1, `beehiivStatus === "active"` →
 * `applySelfConfirmed`) CONTINUA dependendo dessa ponte: quando alguém
 * confirma o double opt-in da Beehiiv por conta própria, este script só
 * desvincula o contato da fila Brevo — quem de fato o coloca pra receber a
 * diária, quando `publishing.newsletter.backend === "kit"`, é a task diária
 * `Diaria-Kit-Subscriber-Sync` (`scripts/sync-beehiiv-subscribers-kit.ts
 * --push`, até 24h de atraso). Documentado como risco aceito no PR body do
 * #6339 (volume residual — só quem confirma opt-in de um pool que já não
 * cresce, ver nota "Pool Pending é FINITO" em `sync-pending-to-brevo.ts`).
 *
 * Este teste é a rede de segurança pedida pelo item 2 da issue: se alguém
 * remover `scripts/sync-beehiiv-subscribers-kit.ts` (ou a task agendada que
 * o roda) tratando-o como código morto — leitura plausível, já que nenhuma
 * skill deste repo o invoca diretamente, mesma classe de erro do
 * #6056/#6059 pro kind `continuo` — a auto-confirmação vira um dead end
 * silencioso: o contato sai da fila Brevo e nunca aparece no Kit. Mesmo
 * padrão de `test/continuo-infra-consumidor-externo.test.ts`.
 *
 * **Se você chegou aqui porque este teste falhou:** antes de "consertar"
 * deletando-o, confirme que a auto-confirmação de `evaluate-brevo-diaria.ts`
 * (Passo 1, `applySelfConfirmed`) foi corrigida pra escrever direto no Kit
 * (mesmo padrão do item 1 do #6339) — só depois disso a ponte deixa de ser
 * load-bearing pra esse caminho específico.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("sync-beehiiv-subscribers-kit.ts — load-bearing pra auto-confirmação do canal Brevo diária (#6339)", () => {
  it("o script existe (ponte Beehiiv -> Kit que a auto-confirmação de evaluate-brevo-diaria.ts ainda depende)", () => {
    assert.ok(
      existsSync(resolve(ROOT, "scripts/sync-beehiiv-subscribers-kit.ts")),
      "scripts/sync-beehiiv-subscribers-kit.ts foi removido — a auto-confirmação (Passo 1) de evaluate-brevo-diaria.ts " +
        "vira dead end silencioso quando publishing.newsletter.backend === 'kit'. Ver o docstring deste teste.",
    );
  });

  it("a task agendada Diaria-Kit-Subscriber-Sync continua registrada e aponta pro script com --push", () => {
    const task = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Kit-Subscriber-Sync");
    assert.ok(task, "task Diaria-Kit-Subscriber-Sync removida do registry — sem ela o sync Beehiiv -> Kit não roda mais sozinho.");
    const syncStep = task!.steps.find((s) => s.script === "scripts/sync-beehiiv-subscribers-kit.ts");
    assert.ok(syncStep, "task Diaria-Kit-Subscriber-Sync não aponta mais pra scripts/sync-beehiiv-subscribers-kit.ts.");
    assert.ok(syncStep!.args?.includes("--push"), "task deixou de rodar --push — viraria dry-run silencioso, nunca escrevendo no Kit de verdade.");
  });

  it("evaluate-brevo-diaria.ts documenta a dependência residual (guard textual — falha se a nota #6339 for removida sem substituição)", () => {
    const src = readFileSync(resolve(ROOT, "scripts/evaluate-brevo-diaria.ts"), "utf8");
    assert.match(
      src,
      /#6339, ESCOPO NÃO COBERTO/,
      "a nota que documenta a dependência da auto-confirmação na ponte sync-beehiiv-subscribers-kit.ts sumiu de evaluate-brevo-diaria.ts — " +
        "se foi removida porque o caminho foi corrigido (auto-confirmação escrevendo direto no Kit), atualize este teste também.",
    );
  });
});
