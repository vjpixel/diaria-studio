/**
 * test/replies-7166-7168.test.ts
 *
 * Regressão (#633) pra dois bugs do §0-replies (`orchestrator-stage-0-
 * preflight.md`):
 *
 * - #7166: a seção não roda desde o #5744 porque continuava sendo tentada
 *   dentro do subprocesso spawnado de `/diaria-edicao` (sem MCP). Prova
 *   aqui: `shouldRunRepliesAtTopLevel` — a decisão de "roda" passa a viver
 *   no top-level, condicionada só a `--no-gates`, sem depender de
 *   propagação de flag entre processos.
 * - #7168: a query `to:vjpixel@gmail.com` perdia toda reply pós-migração
 *   pro Kit (chegam em `oi@news.diar.ia.br`). Prova aqui: uma fixture de
 *   thread `To: oi@news.diar.ia.br` que a lista ANTIGA rejeitava e a lista
 *   ATUAL aceita.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWN_NEWSLETTER_REPLY_ADDRESSES,
  buildRepliesSearchQuery,
  findUncoveredSenderAddresses,
  matchesKnownReplyAddress,
} from "../scripts/lib/newsletter-reply-addresses.ts";
import {
  STAGE1_SUBPROCESS_NEVER_RUNS_REPLIES,
  shouldRunRepliesAtTopLevel,
} from "../scripts/lib/replies-top-level-gate.ts";
import { buildRepliesSkipLogArgs } from "../scripts/lib/replies-skip-log.ts";

// --- #7168: query/matcher cobre o domínio de envio pós-migração Kit ---

test("#7168: lista atual de endereços inclui oi@news.diar.ia.br (Kit) e oi@reativa.diar.ia.br (Brevo)", () => {
  assert.ok(KNOWN_NEWSLETTER_REPLY_ADDRESSES.includes("oi@news.diar.ia.br"));
  assert.ok(KNOWN_NEWSLETTER_REPLY_ADDRESSES.includes("oi@reativa.diar.ia.br"));
  assert.ok(KNOWN_NEWSLETTER_REPLY_ADDRESSES.includes("vjpixel@gmail.com"));
});

test("#7168: fixture real (melina.ribeiro@gmail.com, To: oi@news.diar.ia.br) — filtro ANTIGO perdia, filtro ATUAL captura", () => {
  // Evidência ao vivo citada na issue #7168 (02/09/2026): thread com
  // toRecipients: ["oi@news.diar.ia.br"], resposta a "Re: Gates propõe
  // empregos só para humanos" (edição 260901).
  const toHeader = "oi@news.diar.ia.br";

  const OLD_ADDRESSES = ["vjpixel@gmail.com"]; // comportamento pré-#7168
  assert.equal(
    matchesKnownReplyAddress(toHeader, OLD_ADDRESSES),
    false,
    "regressão: a lista antiga deveria REJEITAR esta fixture (era exatamente o bug)",
  );

  assert.equal(
    matchesKnownReplyAddress(toHeader),
    true,
    "fix: a lista atual deve ACEITAR esta fixture",
  );
});

test("#7168: matchesKnownReplyAddress lida com display-name e múltiplos destinatários", () => {
  assert.equal(matchesKnownReplyAddress("diar.ia.br <oi@news.diar.ia.br>"), true);
  assert.equal(
    matchesKnownReplyAddress("outro@exemplo.com, Nome <oi@reativa.diar.ia.br>"),
    true,
  );
  assert.equal(matchesKnownReplyAddress("alguem-nao-relacionado@exemplo.com"), false);
});

test("#7168: buildRepliesSearchQuery monta a query com os 3 endereços + janela default 14d", () => {
  const query = buildRepliesSearchQuery();
  assert.equal(
    query,
    "to:(vjpixel@gmail.com OR oi@news.diar.ia.br OR oi@reativa.diar.ia.br) subject:(Re OR Res) newer_than:14d",
  );
});

test("#7168: buildRepliesSearchQuery aceita newerThanDays customizado e valida input", () => {
  assert.match(buildRepliesSearchQuery({ newerThanDays: 7 }), /newer_than:7d$/);
  assert.throws(() => buildRepliesSearchQuery({ newerThanDays: 0 }));
  assert.throws(() => buildRepliesSearchQuery({ newerThanDays: 1.5 }));
});

test("#7168 item 3: findUncoveredSenderAddresses aponta endereço de config não coberto pela lista (guard anti-recorrência)", () => {
  assert.deepEqual(
    findUncoveredSenderAddresses(["oi@news.diar.ia.br", "oi@reativa.diar.ia.br"]),
    [],
    "endereços já conhecidos não devem aparecer como descobertos",
  );
  assert.deepEqual(
    findUncoveredSenderAddresses(["oi@novo-dominio.diar.ia.br", undefined, null, ""]),
    ["oi@novo-dominio.diar.ia.br"],
    "endereço de config ausente da lista deve ser reportado (é o que teria evitado o #7168)",
  );
});

// --- #7166: a seção é ALCANÇADA no lugar certo, nunca no subprocesso sem MCP ---

test("#7166: Stage 1 spawnado nunca tenta §0-replies (estrutural, independente de pre_gate)", () => {
  assert.equal(STAGE1_SUBPROCESS_NEVER_RUNS_REPLIES, true);
});

test("#7166: shouldRunRepliesAtTopLevel roda quando o editor está presente (--no-gates ausente)", () => {
  assert.equal(shouldRunRepliesAtTopLevel(false), true, "editor presente (sem --no-gates) → roda");
  assert.equal(shouldRunRepliesAtTopLevel(true), false, "--no-gates passado → sessão desassistida, não roda");
});

// --- #7166 item B: skip nunca é silencioso ---

test("#7166: buildRepliesSkipLogArgs trava a mensagem exata do skip por MCP indisponível", () => {
  const args = buildRepliesSkipLogArgs("gmail_mcp_unavailable", "260903");
  assert.deepEqual(args, [
    "scripts/log-event.ts",
    "--edition",
    "260903",
    "--stage",
    "0",
    "--agent",
    "orchestrator",
    "--level",
    "info",
    "--message",
    "0-replies skipped: Gmail MCP unavailable",
    "--details",
    JSON.stringify({ section: "0-replies", reason: "gmail_mcp_unavailable" }),
  ]);
});

test("#7166: buildRepliesSkipLogArgs cobre o skip por falta de supervisão do editor (mensagem preservada do #2288)", () => {
  const args = buildRepliesSkipLogArgs("no_editor_supervision", "260903");
  assert.ok(args.includes("0-replies skipped: headless --no-gates"));
});
