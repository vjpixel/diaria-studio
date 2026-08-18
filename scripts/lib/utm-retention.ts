/**
 * Retenção de UTM por braço — §8.4 do protocolo do teste de 3 canais (2608),
 * `data/aquisicao/campanhas-260816/00-PROTOCOLO.md`.
 *
 * ## O problema que isto mede
 *
 * O navegador embutido de Facebook/Instagram e o shim `l.facebook.com` podem
 * cortar a query string do clique. Quando isso acontece, o assinante chega na
 * home SEM `utm_source`: ele cai em `referring_site` e **não entra em nenhuma
 * chave paga** de `CHANNEL_KEY_SPECS`. O cadastro existe, foi pago, e some do
 * braço — o gasto fica no numerador do custo por leitor e o cadastro nunca
 * chega ao denominador. O mesmo vale, em menor grau, para o app do Google no
 * Android e para os parceiros sindicalizados da Microsoft.
 *
 * Até esta issue **nada media isso**. O relatório de CAC produzia um custo por
 * leitor por braço sem nenhum sinal de quanto de cada braço tinha evaporado no
 * caminho — e um braço que perde 30% dos cadastros parece simplesmente caro.
 *
 * ## A conta
 *
 *   retenção = atribuídos ÷ (atribuídos + órfãos)
 *
 * - **atribuídos** = cadastros com o `utm_source` do braço.
 * - **órfãos** = cadastros da MESMA janela cujo `referring_site` é de uma
 *   plataforma do braço E cujo `utm_source` está vazio.
 *
 * ## Duas fontes de erro, em direções OPOSTAS — leia antes de confiar no número
 *
 * **(1) Contaminação orgânica — empurra a retenção medida para BAIXO.** Nesses
 * baldes de referrer também cai tráfego orgânico: o projeto publica em
 * Facebook, Instagram e LinkedIn, e recebe busca orgânica do Google e do Bing.
 * Um cadastro orgânico vindo de `instagram.com` sem UTM é contado como órfão,
 * embora nunca tenha sido pago. Contra ESTA fonte de erro a métrica é
 * conservadora: ela reprova braço bom, nunca aprova braço ruim.
 *
 * **(2) Cadastro inatribuível — empurra a retenção medida para CIMA.** Um
 * cadastro que perde o UTM *e* chega com referrer vazio ou irreconhecível
 * (privacidade do navegador, app que não manda referrer, encurtador) não entra
 * nem no numerador nem no denominador de braço nenhum: some. Se ele era um
 * clique pago que perdeu o UTM — exatamente o cenário que esta métrica existe
 * pra pegar — a retenção medida fica MAIOR que a real.
 *
 * Por isso a garantia **não é** "se passou no corte, está limpo". Ela é: passar
 * no corte descarta a perda por referrer conhecido, e nada mais. O tamanho do
 * buraco (2) é contado por `countInatribuiveis` e sai no relatório ao lado da
 * tabela — um número grande ali invalida a leitura da tabela, por mais bonita
 * que ela esteja.
 *
 * ## O corte
 *
 * Retenção < 85% em qualquer braço, **ou** divergência > 15 pontos entre
 * braços, **mata a comparação de custo** (regra (a) da §3.3). Não é um aviso
 * cosmético: com retenções diferentes entre braços, a diferença de custo por
 * leitor mede quanto cada plataforma preserva a query string, não quanto cada
 * plataforma custa.
 */

import type { BeehiivBackupSubscriber } from "./beehiiv-backup-snapshots.ts";

/** Retenção mínima aceitável em QUALQUER braço (fração 0-1). Abaixo disto a
 *  comparação de custo entre braços morre — §8.4. */
export const RETENTION_MIN = 0.85;

/** Divergência máxima aceitável entre o melhor e o pior braço, em PONTOS
 *  percentuais (0-1 na mesma escala da retenção). Acima disto a diferença de
 *  custo por leitor está medindo retenção, não canal. */
export const RETENTION_MAX_SPREAD = 0.15;

/**
 * Abaixo deste número de cadastros somados (atribuídos + órfãos) a retenção é
 * calculada mas marcada como instável: com n pequeno, 1 ou 2 órfãos movem a
 * fração dezenas de pontos e o corte dispararia por ruído.
 *
 * Não suprime o número (nunca esconder dado) — só marca.
 */
export const RETENTION_SMALL_SAMPLE = 20;

/**
 * Folga para comparar o spread contra `RETENTION_MAX_SPREAD`. Muito menor que
 * qualquer diferença que importe (1e-9 de fração = 1e-7 pontos percentuais) e
 * grande o bastante pra absorver o erro de uma subtração de doubles.
 */
export const FLOAT_TOLERANCE = 1e-9;

export interface ArmRetentionSpec {
  /** Nome do braço, igual ao usado na coluna `canal` de `spend.csv`. */
  canal: string;
  /** O `utm_source` que NÓS escrevemos na URL final dos anúncios deste braço. */
  utmSource: string;
  /**
   * Hosts de referrer que denunciam "veio desta plataforma, mas sem UTM".
   * Comparados por host exato OU sufixo de domínio (`m.facebook.com` casa
   * `facebook.com`), nunca por substring solta — `notfacebook.com.br` não casa.
   */
  referrerBuckets: readonly string[];
}

/** Baldes da §8.4, transcritos do protocolo. */
export const ARM_RETENTION_SPECS: readonly ArmRetentionSpec[] = [
  {
    canal: "Google Ads (teste 2608)",
    utmSource: "google-ads",
    referrerBuckets: ["googleadservices.com", "googlesyndication.com", "android.googlequicksearchbox"],
  },
  {
    canal: "Microsoft Ads (teste 2608)",
    utmSource: "microsoft-ads",
    referrerBuckets: ["bing.com", "duckduckgo.com", "search.yahoo.com", "ecosia.org"],
  },
  {
    canal: "Meta Ads (teste 2608)",
    utmSource: "meta-ads",
    referrerBuckets: [
      "facebook.com",
      "l.facebook.com",
      "lm.facebook.com",
      "m.facebook.com",
      "instagram.com",
      "l.instagram.com",
    ],
  },
];

/**
 * Extrai o host de um `referring_site`, que no snapshot aparece tanto como URL
 * completa (`https://l.facebook.com/`) quanto como host cru (`facebook.com`)
 * quanto como token sem ponto (`android.googlequicksearchbox`).
 *
 * @pure
 */
export function referrerHost(referringSite: string): string {
  const raw = (referringSite ?? "").trim().toLowerCase();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    const host = new URL(withScheme).host;
    return host.replace(/^www\./, "");
  } catch {
    // Não é URL parseável — trata o valor cru como host (o caso
    // `android.googlequicksearchbox`, que não tem TLD).
    return raw.replace(/^www\./, "");
  }
}

/**
 * `true` se o host pertence ao balde: igual ao bucket, ou subdomínio dele.
 * Casamento por SUFIXO COM PONTO de propósito — `xfacebook.com` não casa
 * `facebook.com`, `m.facebook.com` casa.
 *
 * @pure
 */
export function hostMatchesBucket(host: string, bucket: string): boolean {
  if (!host || !bucket) return false;
  return host === bucket || host.endsWith(`.${bucket}`);
}

export interface ArmRetention {
  canal: string;
  utmSource: string;
  /** Cadastros que chegaram COM o `utm_source` do braço. */
  atribuidos: number;
  /** Cadastros sem `utm_source` cujo referrer é de uma plataforma do braço. */
  orfaos: number;
  /** `atribuidos / (atribuidos + orfaos)`, ou `null` quando o denominador é 0
   *  (sem dado — nunca 1,0 otimista por omissão). */
  retencao: number | null;
  /** `true` quando o denominador é pequeno demais pro corte ser confiável. */
  amostraPequena: boolean;
  /** Hosts órfãos encontrados, com contagem — pra investigar sem re-rodar. */
  orfaosPorHost: Record<string, number>;
}

/**
 * Calcula a retenção de UM braço sobre uma lista de assinantes já filtrada pela
 * janela do teste (o chamador aplica a janela — este módulo não conhece datas).
 *
 * @pure
 */
export function computeArmRetention(
  subs: readonly BeehiivBackupSubscriber[],
  spec: ArmRetentionSpec,
): ArmRetention {
  let atribuidos = 0;
  let orfaos = 0;
  const orfaosPorHost: Record<string, number> = {};

  for (const sub of subs) {
    const utm = (sub.utm_source ?? "").trim().toLowerCase();
    if (utm === spec.utmSource) {
      atribuidos++;
      continue;
    }
    // Só conta como órfão quem NÃO tem utm_source nenhum. Um cadastro com
    // utm_source de OUTRO braço não é órfão deste — é do outro, e contá-lo
    // aqui inflaria o denominador e deprimiria a retenção deste braço.
    if (utm !== "") continue;

    const host = referrerHost(sub.referring_site);
    if (!host) continue;
    if (spec.referrerBuckets.some((b) => hostMatchesBucket(host, b))) {
      orfaos++;
      orfaosPorHost[host] = (orfaosPorHost[host] ?? 0) + 1;
    }
  }

  const denominador = atribuidos + orfaos;
  return {
    canal: spec.canal,
    utmSource: spec.utmSource,
    atribuidos,
    orfaos,
    retencao: denominador > 0 ? atribuidos / denominador : null,
    amostraPequena: denominador > 0 && denominador < RETENTION_SMALL_SAMPLE,
    orfaosPorHost,
  };
}

/**
 * Três estados, não um booleano — e a razão é um bug real que a 1ª versão tinha.
 *
 * Com `passa: boolean`, "não dá pra avaliar" não era representável: um braço sem
 * denominador não gerava motivo de reprovação, então `passa` saía `true` e o
 * exit code do CLI dizia "siga" exatamente no cenário que esta métrica existe
 * pra pegar. O markdown imprimia um aviso, mas o contrato de máquina aprovava.
 * Duas revisões independentes acharam a mesma coisa por caminhos diferentes (o
 * caso "nenhum braço medido" e o caso "2 de 3 medidos").
 *
 * - `passa` — todos os braços medidos, nenhum violou o corte.
 * - `reprova` — algum braço violou o corte (§3.3 regra (a)): comparação morta.
 * - `incompleto` — nenhuma violação, mas ALGUM braço não tem denominador. Não é
 *   falha: o protocolo (§248) permite declarar o teste de 2 braços. Mas isso tem
 *   de ser uma DECLARAÇÃO humana, nunca uma inferência silenciosa de um script.
 */
export type RetentionOutcome = "passa" | "reprova" | "incompleto";

export interface RetentionVerdict {
  /** Fonte única da verdade. Não existe `passa: boolean` derivado ao lado — um
   *  booleano guardado junto do dado que o determina dessincroniza. */
  outcome: RetentionOutcome;
  /** Violações do corte. Vazio quando `outcome !== "reprova"`. */
  motivos: string[];
  /** Maior diferença em pontos entre dois braços com retenção medida, ou `null`. */
  spread: number | null;
  /** Braços sem denominador — nunca somem do relatório, e forçam `incompleto`. */
  semDado: string[];
}

/**
 * Exit code do CLI por veredito. Códigos DISTINTOS de propósito: um wrapper de
 * apuração precisa distinguir "reprovou" de "não deu pra avaliar" — as duas
 * exigem ação humana, mas ações diferentes.
 *
 * @pure
 */
export function exitCodeForOutcome(outcome: RetentionOutcome): number {
  switch (outcome) {
    case "passa":
      return 0;
    case "reprova":
      return 2;
    case "incompleto":
      return 3;
  }
}

/**
 * Cadastros que não são atribuíveis a braço NENHUM: `utm_source` vazio e
 * referrer que não bate em nenhum balde de nenhuma spec.
 *
 * Este é o buraco (2) da docstring do módulo, e é a razão de a retenção medida
 * poder ser MAIOR que a real. Contar isso é o que torna o buraco visível em vez
 * de implícito — sem este número, um "PASSA" na tabela pode significar só "não
 * capturamos referrer suficiente pra reprovar".
 *
 * Não é dividido por braço de propósito: por construção não dá pra saber a qual
 * braço cada um pertencia — se desse, não seriam inatribuíveis.
 *
 * @pure
 */
export function countInatribuiveis(
  subs: readonly BeehiivBackupSubscriber[],
  specs: readonly ArmRetentionSpec[] = ARM_RETENTION_SPECS,
): number {
  let n = 0;
  for (const sub of subs) {
    if ((sub.utm_source ?? "").trim() !== "") continue;
    const host = referrerHost(sub.referring_site);
    if (host && specs.some((s) => s.referrerBuckets.some((b) => hostMatchesBucket(host, b)))) continue;
    n++;
  }
  return n;
}

/**
 * Aplica o corte da §8.4 sobre os braços medidos.
 *
 * Braço sem denominador (`retencao === null`) **não reprova nem aprova** — ele
 * é reportado em `semDado`. Tratar "sem dado" como aprovação seria exatamente o
 * silêncio que esta issue existe pra eliminar.
 *
 * @pure
 */
export function evaluateRetentionCut(arms: readonly ArmRetention[]): RetentionVerdict {
  const motivos: string[] = [];
  const semDado = arms.filter((a) => a.retencao == null).map((a) => a.canal);
  const medidos = arms.filter((a): a is ArmRetention & { retencao: number } => a.retencao != null);
  for (const arm of medidos) {
    if (arm.retencao < RETENTION_MIN) {
      motivos.push(
        `${arm.canal}: retenção ${(arm.retencao * 100).toFixed(1)}% < ${(RETENTION_MIN * 100).toFixed(0)}% ` +
          `(${arm.atribuidos} atribuídos, ${arm.orfaos} órfãos)` +
          (arm.amostraPequena ? " — amostra pequena, confirmar antes de agir" : ""),
      );
    }
  }

  let spread: number | null = null;
  if (medidos.length >= 2) {
    const valores = medidos.map((a) => a.retencao);
    spread = Math.max(...valores) - Math.min(...valores);
    // Tolerância obrigatória: `spread` vem de uma SUBTRAÇÃO, que introduz erro
    // de ponto flutuante. Sem isto, 100% vs 85% dá 0.15000000000000002 e uma
    // divergência de exatamente 15 pontos reprovava — contra o que a §8.4
    // define. (Achado pelo teste de fronteira exata; o corte do mínimo não
    // sofre disso porque compara um literal com um literal.)
    if (spread > RETENTION_MAX_SPREAD + FLOAT_TOLERANCE) {
      const melhor = medidos.reduce((a, b) => (a.retencao >= b.retencao ? a : b));
      const pior = medidos.reduce((a, b) => (a.retencao <= b.retencao ? a : b));
      motivos.push(
        `divergência ${(spread * 100).toFixed(1)} pontos entre braços > ${(RETENTION_MAX_SPREAD * 100).toFixed(0)} ` +
          `(${melhor.canal} ${(melhor.retencao * 100).toFixed(1)}% vs ${pior.canal} ${(pior.retencao * 100).toFixed(1)}%)`,
      );
    }
  }

  const outcome: RetentionOutcome =
    motivos.length > 0 ? "reprova" : semDado.length > 0 || medidos.length === 0 ? "incompleto" : "passa";

  return { outcome, motivos, spread, semDado };
}

/**
 * Renderiza o bloco markdown pro relatório congelado.
 *
 * `inatribuiveis` vem de `countInatribuiveis` — passar sempre. É o buraco (2) da
 * docstring do módulo, e omiti-lo devolve o relatório à versão que alegava uma
 * garantia que o código não dá.
 *
 * @pure
 */
export function renderRetentionMarkdown(
  arms: readonly ArmRetention[],
  verdict: RetentionVerdict,
  inatribuiveis?: number,
): string {
  const lines: string[] = [];
  lines.push("### Retenção de UTM por braço (§8.4)");
  lines.push("");
  lines.push(
    "`retenção = atribuídos ÷ (atribuídos + órfãos)`, onde órfão = cadastro sem `utm_source` " +
      "cujo referrer é da plataforma do braço.",
  );
  lines.push("");
  lines.push(
    "Duas fontes de erro, em direções opostas: tráfego **orgânico** nesses baldes empurra a " +
      "retenção medida para BAIXO (conservador); cadastro que perde o UTM **e** chega sem " +
      "referrer reconhecível some da conta e empurra para CIMA. Passar no corte descarta a " +
      "perda por referrer conhecido — e nada além disso.",
  );
  lines.push("");
  lines.push("| Braço | utm_source | Atribuídos | Órfãos | Retenção | Amostra |");
  lines.push("|---|---|---:|---:|---:|---|");
  for (const a of arms) {
    const ret = a.retencao == null ? "— (sem dado)" : `${(a.retencao * 100).toFixed(1)}%`;
    const amostra = a.retencao == null ? "n=0" : a.amostraPequena ? `n=${a.atribuidos + a.orfaos} ⚠ pequena` : `n=${a.atribuidos + a.orfaos}`;
    lines.push(`| ${a.canal} | ${a.utmSource} | ${a.atribuidos} | ${a.orfaos} | ${ret} | ${amostra} |`);
  }
  lines.push("");
  // A prosa deriva do MESMO `outcome` que o exit code. Antes havia um
  // `nenhumMedido` recomputado aqui, e foi essa duplicação que deixou markdown e
  // exit code contando histórias diferentes.
  if (verdict.outcome === "reprova") {
    lines.push("**Corte da §8.4: REPROVA — a comparação de custo entre braços está morta (regra (a) da §3.3).**");
    for (const m of verdict.motivos) lines.push(`- ${m}`);
  } else if (verdict.outcome === "incompleto") {
    const todos = verdict.semDado.length === arms.length;
    lines.push(
      `**Corte da §8.4: INCOMPLETO — ${todos ? "nenhum braço tem" : "há braço sem"} denominador. ` +
        "Isto não é aprovação.**",
    );
    lines.push(
      todos
        ? "  Ou o teste ainda não veiculou, ou o `utm_source` não está chegando ao snapshot em " +
          "braço nenhum (o pior caso do §8.1)."
        : "  Um braço sem dado não pode entrar numa comparação de custo como se estivesse limpo. " +
          "O protocolo permite declarar o teste de 2 braços (§248) — mas isso é uma declaração " +
          "humana registrada, nunca uma inferência silenciosa deste script.",
    );
  } else {
    const spreadTxt = verdict.spread == null ? "n/d" : `${(verdict.spread * 100).toFixed(1)} pontos`;
    lines.push(`**Corte da §8.4: PASSA.** Divergência entre braços: ${spreadTxt}.`);
  }
  if (verdict.semDado.length > 0) {
    lines.push("");
    lines.push(`Sem denominador: ${verdict.semDado.join(", ")}.`);
  }
  if (inatribuiveis != null && inatribuiveis > 0) {
    lines.push("");
    lines.push(
      `**Inatribuíveis: ${inatribuiveis}** cadastro(s) sem \`utm_source\` e sem referrer reconhecido — ` +
        "não entram em numerador nem denominador de braço nenhum. Se parte disso for clique pago " +
        "que perdeu o UTM, a retenção da tabela acima está SUPERESTIMADA. Número grande aqui " +
        "invalida a leitura da tabela.",
    );
  }
  return lines.join("\n") + "\n";
}
