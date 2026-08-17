#!/usr/bin/env node
/**
 * scripts/verify-preflight-utm.ts (#5545)
 *
 * O CORAÇÃO da unidade. Dado um `--campaign` de preflight e os endereços de
 * teste já cadastrados (um por braço), consulta a Beehiiv (`GET
 * .../subscriptions/by_email/{email}` — mesma leitura já usada por
 * `scripts/evaluate-brevo-diaria.ts`/`scripts/lib/shared/beehiiv-origem-original.ts`,
 * não um caminho novo) e imprime, por braço, `esperado → obtido` + o
 * veredito PASSOU/FALHOU do critério de aprovação da #5522 — sem exigir
 * leitura humana de JSON.
 *
 * **O que isto NÃO faz:** não abre navegador, não clica em nada, não
 * substitui a passada real (#5522). Ver `docs/roteiro-preflight-utm-3-canais.md`
 * pro roteiro completo — este script é o passo 7 dele (rodar depois do
 * cadastro + confirmação de double opt-in dos 3 braços).
 *
 * Uso:
 *   npx tsx scripts/verify-preflight-utm.ts \
 *     --campaign preflight-2608 \
 *     --emails google-ads=preflight-google@x.com,microsoft-ads=preflight-microsoft@x.com,meta-ads=preflight-meta@x.com
 *
 * `--emails` aceita 1 a 3 braços (`google-ads`, `microsoft-ads`, `meta-ads`)
 * — braço omitido não é avaliado (aparece como "não testado nesta chamada",
 * não como FALHOU). O veredito geral só é PASSOU quando os 3 braços foram
 * passados E todos passaram.
 *
 * Env: `BEEHIIV_API_KEY` (obrigatório), `BEEHIIV_PUBLICATION_ID` opcional
 * (fallback `platform.config.json`) — mesmo contrato de `loadBeehiivConfig`
 * (`scripts/lib/beehiiv-config.ts`). Leitura pura (`GET`) — não é ação de
 * publish/schedule/send, permitido em sessão overnight/develop.
 *
 * Exit codes: 0 = todos os braços passados passaram; 1 = pelo menos 1 braço
 * falhou/não foi encontrado, ou nenhum dos 3 braços foi passado; 2 = args/
 * config inválidos.
 */
import "dotenv/config";
import { loadBeehiivConfig } from "./lib/beehiiv-config.ts";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import {
  PREFLIGHT_UTM_ARMS,
  parseArmEmailPairs,
  evaluateArm,
  formatVerdictTable,
  allPassed,
  fetchBeehiivSubscriptionUtm,
  type ArmVerdict,
} from "./lib/preflight-utm.ts";

const LOG_PREFIX = "[verify-preflight-utm]";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const campaign = getStringArg(argv, "campaign", { example: "preflight-2608" });
  const emailsRaw = getStringArg(argv, "emails", {
    example: "google-ads=teste@x.com,microsoft-ads=teste2@x.com,meta-ads=teste3@x.com",
  });

  if (!campaign || !emailsRaw) {
    console.error(
      `${LOG_PREFIX} uso: --campaign <utm_campaign> --emails braço=email,braço=email,... ` +
        `(braços válidos: ${PREFLIGHT_UTM_ARMS.map((a) => a.id).join(", ")})`,
    );
    process.exitCode = 2;
    return;
  }

  let pairs: Record<string, string>;
  try {
    pairs = parseArmEmailPairs(emailsRaw);
  } catch (e) {
    console.error(`${LOG_PREFIX} ${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }

  const armsToCheck = PREFLIGHT_UTM_ARMS.filter((a) => pairs[a.id]);
  if (armsToCheck.length === 0) {
    console.error(`${LOG_PREFIX} --emails não trouxe nenhum braço reconhecido.`);
    process.exitCode = 2;
    return;
  }

  const { apiKey, publicationId } = loadBeehiivConfig(LOG_PREFIX);

  const verdicts: ArmVerdict[] = [];
  for (const arm of armsToCheck) {
    const email = pairs[arm.id];
    console.log(`${LOG_PREFIX} consultando ${arm.id} (${email})...`);
    const subscription = await fetchBeehiivSubscriptionUtm(publicationId, apiKey, email);
    verdicts.push(evaluateArm(arm, email, campaign, subscription));
  }

  console.log("");
  console.log(formatVerdictTable(verdicts));
  console.log("");

  const missingArms = PREFLIGHT_UTM_ARMS.filter((a) => !pairs[a.id]).map((a) => a.id);
  if (missingArms.length > 0) {
    console.log(`${LOG_PREFIX} braço(s) não testado(s) nesta chamada: ${missingArms.join(", ")}`);
  }

  if (allPassed(verdicts) && missingArms.length === 0) {
    console.log(
      `${LOG_PREFIX} VEREDITO GERAL: PASSOU — os ${verdicts.length} braços chegaram com utm_source ` +
        `exato e utm_campaign preservado.`,
    );
  } else {
    console.log(
      `${LOG_PREFIX} VEREDITO GERAL: FALHOU — não acender nada (critério da #5522). ` +
        `Ver detalhes acima; se o mecanismo de atribuição first-touch já documentado na #5522 ` +
        `for a causa, repetir o teste com uma janela anônima NOVA por braço (ver o roteiro).`,
    );
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
