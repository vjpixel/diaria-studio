#!/usr/bin/env tsx
/**
 * onboarding-form-demo-link.ts (#12925)
 *
 * Imprime um link ASSINADO do formulário do onboarding (formulario.diar.ia.br)
 * para o editor mostrar o formulário a quem é de fora. A página só abre com
 * `?email=...&sig=...` (`checkFormEmailSig`, #10657); sem isso cai em "Link
 * inválido". Antes, o link era gerado à mão com `signFormEmail` +
 * `ONBOARDING_FORM_LINK_SECRET`.
 *
 * O e-mail padrão é um endereço de TESTE do editor com `+sufixo`
 * (`DEMO_FORM_EMAIL`), não o endereço dele: o que a pessoa de fora digitar
 * (rascunho) ou enviar fica numa chave do KV separada da resposta real do
 * editor, e `isFormTestEmail` deixa esse endereço fora do resultado parcial do
 * Studio (#12583) e do perfil de audiência (`audience-run.ts`). O link NÃO é
 * somente leitura: o Worker grava rascunho e envio como em qualquer link.
 * `--email` assina outro endereço; um endereço que não é de teste do editor
 * entra nos resultados como respondente de verdade, e o script avisa.
 *
 * Só leitura do lado do projeto: lê `platform.config.json`
 * (`onboarding.followup.form_url`) e o segredo do ambiente (.env/Doppler).
 * Nenhuma chamada de rede, nenhuma escrita.
 *
 * Uso:
 *   npx tsx scripts/onboarding-form-demo-link.ts
 *   npx tsx scripts/onboarding-form-demo-link.ts --email outra+demo@gmail.com
 *
 * Saída: o link no stdout (uma linha); avisos no stderr. Exit 1 com segredo
 * ausente/curto ou `form_url` não configurado; exit 2 com argumento inválido.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findUnknownFlags, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { EDITOR_COPY_EMAIL } from "./lib/editor-copy.ts";
import { checkLinkSecret, ONBOARDING_FORM_LINK_SECRET_ENV, signFormEmail } from "./lib/onboarding-form-link-sig.ts";
import { isFormTestEmail } from "./lib/onboarding-form-partial-results.ts";
import { resolveFollowupConfig, type FollowupConfigRaw } from "./lib/onboarding-followup.ts";
import { normalizeFormEmail } from "./lib/onboarding-form-contract.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Mesmo formato que o Worker aceita (`EMAIL_RE` de `onboarding-form-contract.ts`). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Endereço de demonstração: o Gmail do editor com `+formulario-demo`. */
export const DEMO_FORM_EMAIL = EDITOR_COPY_EMAIL.replace("@", "+formulario-demo@");

export type DemoLinkResult =
  | { ok: true; url: string; email: string; avisos: string[] }
  | { ok: false; erro: string };

/**
 * @pure (fora a assinatura, que é Web Crypto determinístico) — monta o link
 * assinado. O e-mail vai codificado (`encodeURIComponent`): o `+` do sufixo
 * chega como `+` ao Worker, não como espaço.
 */
export async function buildDemoFormLink(
  formUrl: string | null,
  rawSecret: string | null | undefined,
  email: string = DEMO_FORM_EMAIL,
): Promise<DemoLinkResult> {
  if (!formUrl) return { ok: false, erro: "onboarding.followup.form_url não configurado no platform.config.json" };
  const secret = checkLinkSecret(rawSecret);
  if (!secret.ok) return { ok: false, erro: `${secret.detalhe} — defina no .env/Doppler o mesmo valor do secret do Worker` };
  const normalized = normalizeFormEmail(email);
  if (!EMAIL_RE.test(normalized)) return { ok: false, erro: `e-mail inválido: ${email}` };
  const sig = await signFormEmail(normalized, secret.secret);
  const sep = formUrl.includes("?") ? "&" : "?";
  const url = `${formUrl}${sep}email=${encodeURIComponent(normalized)}&sig=${sig}`;
  const avisos = [
    "O link não é somente leitura: o que for digitado vira rascunho e o envio grava resposta no KV do Worker.",
  ];
  if (!isFormTestEmail(normalized)) {
    avisos.push(
      `${normalized} não é endereço de teste do editor: rascunho e resposta feitos por este link contam no resultado do Studio e no perfil de audiência.`,
    );
  }
  return { ok: true, url, email: normalized, avisos };
}

async function main(argv: string[]): Promise<number> {
  if (hasFlag(argv, "help") || hasFlag(argv, "h")) {
    console.log("Uso: npx tsx scripts/onboarding-form-demo-link.ts [--email endereço]");
    return 0;
  }
  const unknown = findUnknownFlags(argv, ["email", "help", "h"]);
  if (unknown.length > 0) {
    console.error(`[onboarding-form-demo-link] flag desconhecida: ${unknown.join(", ")}`);
    return 2;
  }
  let email: string | undefined;
  try {
    email = getStringArg(argv, "email", { example: DEMO_FORM_EMAIL });
  } catch (e) {
    console.error(`[onboarding-form-demo-link] ${(e as Error).message}`);
    return 2;
  }
  loadProjectEnv();
  const raw = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as {
    onboarding?: { followup?: FollowupConfigRaw };
  };
  const cfg = resolveFollowupConfig(raw.onboarding?.followup);
  const result = await buildDemoFormLink(cfg.formUrl, process.env[ONBOARDING_FORM_LINK_SECRET_ENV], email);
  if (!result.ok) {
    console.error(`[onboarding-form-demo-link] ${result.erro}`);
    return 1;
  }
  for (const a of result.avisos) console.error(`[onboarding-form-demo-link] aviso: ${a}`);
  console.log(result.url);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`[onboarding-form-demo-link] ${(e as Error).message}`);
      process.exitCode = 1;
    },
  );
}
