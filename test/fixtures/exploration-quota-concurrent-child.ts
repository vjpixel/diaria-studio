/**
 * Filho do teste de concorrência da cota de exploração (#8407).
 *
 * Roda o caminho de produção (`applyExplorationQuotaBackstop`) para uma
 * edição, contra um `statePath` compartilhado com o outro filho. Dois
 * recursos existem só pra tornar a corrida DETERMINÍSTICA:
 *
 * - `--start-at`: barreira de relógio de parede, pra que os dois processos
 *   entrem na seção read→decide→write ao mesmo tempo.
 * - `--delay-ms`: alarga a janela entre a leitura do estado e a gravação,
 *   injetado pelo `ctrByCategory.get` dos sinais de audiência (consultado
 *   pela decisão, que acontece entre as duas). Sem isso a janela é de
 *   milissegundos e a corrida seria flaky; com isso, uma implementação que lê
 *   FORA do lock perde um registro de forma reprodutível.
 */
import {
  applyExplorationQuotaBackstop,
  type AssembledOutput,
} from "../../scripts/assemble-scored.ts";
import type { AudienceSignals } from "../../scripts/lib/audience-affinity.ts";
import type { FinalistLike } from "../../scripts/lib/negative-impact-promotion.ts";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) throw new Error(`faltou --${name}`);
  return process.argv[i + 1];
}

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const statePath = arg("state-path");
const edition = arg("edition");
const startAt = Number(arg("start-at"));
const delayMs = Number(arg("delay-ms"));

/** Map que dorme na primeira consulta — alarga a janela read→write. */
class SlowCtrMap extends Map<string, number> {
  private slept = false;
  override get(key: string): number | undefined {
    if (!this.slept) {
      this.slept = true;
      sleepSync(delayMs);
    }
    return super.get(key);
  }
}

const signals: AudienceSignals = {
  ctrByCategory: new SlowCtrMap([["Treinamento", 6.0]]),
  avgCtr: 0.01,
  surveyTools: new Set(["chatgpt"]),
  source: "ctr+survey",
  loaded: true,
};

const assembled: AssembledOutput = {
  highlights: [
    { rank: 1, score: 95, url: "https://a", article: { url: "https://a", title: "Treinamento com ChatGPT" } },
    { rank: 2, score: 90, url: "https://b", article: { url: "https://b", title: "Treinamento novo" } },
    { rank: 3, score: 85, url: "https://c", article: { url: "https://c", title: "Treinamento de times" } },
  ],
  runners_up: [],
  all_scored: [],
};

const finalists: FinalistLike[] = [
  {
    url: `https://exogeno/${edition}`,
    score: 80,
    bucket: "noticias",
    article: { url: `https://exogeno/${edition}`, title: "Anatel abre consulta sobre uso de IA" },
  },
];

sleepSync(startAt - Date.now());
applyExplorationQuotaBackstop(assembled, finalists, edition, { signals, statePath, log: () => {} });
