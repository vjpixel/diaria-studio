#!/usr/bin/env node
/**
 * scripts/check-kv-image-binding.ts (#7663)
 *
 * Smoke test do binding KV `POLL` de `workers/site` — a lacuna que a #7663
 * descreve: `test/site-img-same-origin-7657.test.ts` só confere
 * ESTATICAMENTE que o `id` bate entre `workers/site/wrangler.toml` e
 * `workers/poll/wrangler.toml` (pega typo no arquivo-fonte). Um deploy
 * parcial, drift entre preview/produção, ou o namespace ser renomeado do
 * lado da Cloudflare deixa o `id` declarado correto mas `env.POLL.get(key)`
 * devolvendo `null` pra TODA key — um 404 com CORS, aparentemente saudável.
 * Sem este check, nada distingue *"esta capa não existe"* de *"o binding
 * inteiro está morto e NENHUMA imagem carrega de novo"*.
 *
 * Lógica pura (classificação `ok`/`binding-morto`/`cannot-verify` + a key
 * estável usada como âncora) em `scripts/lib/kv-image-smoke.ts` — ver a
 * docstring de lá pra prova de que a key existe hoje e nunca é deletada.
 *
 * ## Task agendada, não passo de deploy — decisão desta unidade
 *
 * A issue oferece duas formas, "não exclusivas": (1) passo no
 * `deploy-worker.yml`/`deploy-site.yml`, que pega drift só nos NOSSOS
 * deploys; (2) task agendada, que pega TAMBÉM drift fora de deploy (a
 * própria classe de falha que a issue descreve — namespace renomeado do
 * lado da Cloudflare — não acontece num `git push` nosso). A forma 2 é
 * estritamente mais abrangente (cobre tudo que a 1 cobre, mais o resto) e
 * mais barata de operar sozinha: só ela, sem a 1, já fecha o modo de falha
 * central da issue. Registrado só como task agendada nesta unidade — ver
 * `scripts/lib/scheduled-tasks.ts` (`Diaria-Kv-Image-Binding-Smoke`,
 * DECLARADA, NÃO ARMADA). Um passo adicional no workflow de deploy do
 * `site` fica como possível trabalho futuro (ganho marginal: latência de
 * detecção de ~1 dia pra ~1 min só nos deploys nossos), fora do escopo P3
 * desta unidade.
 *
 * Uso:
 *   npx tsx scripts/check-kv-image-binding.ts               # avalia + persiste + alarma se NOVA queda
 *   npx tsx scripts/check-kv-image-binding.ts --dry-run      # avalia + imprime, NÃO persiste/alarma
 *   npx tsx scripts/check-kv-image-binding.ts --to email@x   # override do destinatário do alarme
 *
 * Env: nenhuma credencial necessária pra AVALIAR (GET público, sem auth) —
 * só pra ENVIAR o e-mail de alarme quando `binding-morto` é detectado
 * (`data/.credentials.json` com o scope `gmail.send`, mesmo requisito dos
 * outros alarmes locais deste repo).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { logEvent } from "./lib/run-log.ts";
import {
  runKvImageSmokeCheck,
  KV_IMAGE_SMOKE_URL,
  KV_IMAGE_SMOKE_KEY,
  type KvImageSmokeResult,
  type KvImageBindingStatus,
} from "./lib/kv-image-smoke.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "kv-image-smoke", "state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[check-kv-image-binding]";

export interface KvImageSmokeState {
  /** Último status observado — usado só pra decidir se o alarme atual é uma
   *  QUEDA NOVA (dedup: nunca manda e-mail repetido todo dia enquanto o
   *  binding continua morto). */
  lastStatus: KvImageBindingStatus | null;
  lastCheckedAt: string | null;
}

export function emptyState(): KvImageSmokeState {
  return { lastStatus: null, lastCheckedAt: null };
}

export function loadState(statePath: string = STATE_PATH): KvImageSmokeState {
  if (!existsSync(statePath)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<KvImageSmokeState>;
    const lastStatus: KvImageBindingStatus | null =
      raw.lastStatus === "ok" || raw.lastStatus === "binding-morto" || raw.lastStatus === "cannot-verify"
        ? raw.lastStatus
        : null;
    const lastCheckedAt = typeof raw.lastCheckedAt === "string" ? raw.lastCheckedAt : null;
    return { lastStatus, lastCheckedAt };
  } catch {
    return emptyState();
  }
}

export function saveState(state: KvImageSmokeState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/**
 * Decide se um resultado `binding-morto` merece alarme AGORA — só quando é
 * uma transição NOVA (estado anterior não era já `binding-morto`). Evita
 * mandar o mesmo e-mail toda execução enquanto a queda persiste; o editor já
 * foi avisado na 1ª detecção.
 *
 * `cannot-verify` NUNCA alarma (regra inegociável da issue — rede
 * indisponível/5xx não pode virar falso alarme) e nunca "reseta" o estado
 * pra permitir realarme depois — só `ok` faz isso, porque só `ok` é
 * confirmação positiva de que o binding voltou.
 */
export function shouldAlarmNow(previous: KvImageBindingStatus | null, current: KvImageBindingStatus): boolean {
  return current === "binding-morto" && previous !== "binding-morto";
}

function buildAlarmEmail(result: KvImageSmokeResult): { subject: string; body: string } {
  return {
    subject: "[diar.ia.br] binding KV POLL de workers/site parece morto (/img/ quebrado)",
    body: [
      "Achado automático do smoke-test `Diaria-Kv-Image-Binding-Smoke`",
      "(`scripts/check-kv-image-binding.ts`).",
      "",
      `URL verificada: ${KV_IMAGE_SMOKE_URL}`,
      `Key estável: ${KV_IMAGE_SMOKE_KEY}`,
      `Resultado: ${result.status}`,
      `Detalhe: ${result.detail}`,
      "",
      "Essa key é de convenção fixa, de uma edição já publicada há meses, e",
      "nenhum script do repo a deleta — um 404 nela só é explicável por",
      "binding KV morto (deploy parcial, drift preview/produção, namespace",
      "renomeado do lado da Cloudflare) ou remoção manual da key.",
      "",
      "Se o binding estiver de fato morto: NENHUMA imagem carrega em",
      "diar.ia.br (home sem capas, `/img/{key}` 404 pra tudo). Verificar o",
      "binding KV POLL no painel Cloudflare > Workers > diaria-site >",
      "Settings > Bindings, e comparar com workers/poll (mesmo namespace",
      "esperado — ver workers/site/wrangler.toml).",
      "",
      "Ref #7663.",
    ].join("\n"),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "--dry-run");
  const toOverride = getArg(argv, "--to");

  loadProjectEnv();

  const httpFetch: typeof fetch = fetch;
  const result = await runKvImageSmokeCheck((url, init) => httpFetch(url, init));

  console.log(`${LOG_PREFIX} ${result.status} — ${result.detail}`);

  const previous = loadState();
  const alarmNow = shouldAlarmNow(previous.lastStatus, result.status);

  if (dryRun) {
    console.log(`${LOG_PREFIX} --dry-run: não persiste estado, não alarma. Alarmaria agora? ${alarmNow}`);
    return;
  }

  logEvent(
    {
      edition: null,
      stage: null,
      agent: "check-kv-image-binding",
      level: result.status === "binding-morto" ? "error" : result.status === "cannot-verify" ? "warn" : "info",
      message: `kv-image-smoke: ${result.status} — ${result.detail}`,
      details: { url: KV_IMAGE_SMOKE_URL, key: KV_IMAGE_SMOKE_KEY, status: result.status },
    },
    ROOT,
  );

  if (alarmNow) {
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    const { subject, body } = buildAlarmEmail(result);
    // Mesmo racional de home-meta-check.ts/hub-drift-check.ts: SEM try/catch
    // em volta do envio — se `sendGmailMessage` falhar (credencial ausente,
    // Gmail fora do ar), `main()` deve lançar e o `saveState` abaixo NUNCA
    // roda. Assim a próxima execução ainda vê `lastStatus !== "binding-morto"`
    // e tenta alarmar de novo, em vez de marcar a queda como "já avisado"
    // com o editor nunca tendo recebido nada.
    await sendGmailMessage(to, subject, body);
    console.log(`${LOG_PREFIX} alarme enviado para ${to}`);
  }

  saveState({ lastStatus: result.status, lastCheckedAt: new Date().toISOString() });
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`${LOG_PREFIX} erro fatal:`, error);
    process.exitCode = 1;
  });
}
