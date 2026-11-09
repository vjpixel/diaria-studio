/**
 * systemd-env-file.ts (#12477)
 *
 * Parser puro do formato `EnvironmentFile=` do systemd, porta da máquina de
 * estados de `parse_env_file_internal` (`src/basic/env-file.c`). Serve para uma
 * pergunta só: "este valor que está no ambiente veio do MESMO `.env`, lido pelo
 * systemd em vez do dotenv?".
 *
 * **Por que existe.** As units do `300` fazem `EnvironmentFile=-{repo}/.env`
 * (#5114, `scripts/lib/systemd-units.ts`). O systemd e o `dotenv` leem o mesmo
 * arquivo com regras diferentes de escape, e a diferença morde justamente no
 * `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` que `materialize-google-ads-credentials.ts`
 * grava SEM aspas (#6704): num valor sem aspas o systemd trata `\` como escape
 * e o remove, então os `\n` da `private_key` viram `n`; o dotenv guarda o
 * valor literal. O resultado é o aviso de divergência do `env-loader` em todo
 * log de task (#12477) e, pior, um JSON que ainda faz parse mas com a chave PEM
 * corrompida no `process.env` das units.
 *
 * Regras portadas (só o que muda o valor):
 * - linha que começa (após espaço) com `#` ou `;` é comentário;
 * - sem aspas: espaço inicial ignorado, final aparado, `\x` vira `x`,
 *   `\` + quebra de linha continua a linha; `#` no meio do valor é literal;
 * - aspas simples: tudo literal até a próxima `'` (pode atravessar linhas);
 * - aspas duplas: `\"`, `\\`, `` \` `` e `\$` viram o caractere; `\` + quebra
 *   de linha continua; qualquer outro `\x` fica como `\x`;
 * - depois de fechar aspas o valor continua (`"a"b` vira `ab`);
 * - chave repetida: a última vence.
 *
 * Não valida nome de chave nem UTF-8 como o systemd faz. Isso é seguro para o
 * único uso (comparação de igualdade exata em `env-loader.ts`): uma diferença
 * de parser aqui só faz a comparação falhar, e aí o aviso de divergência
 * continua saindo como antes. Nunca mascara uma divergência real.
 */

const WHITESPACE = " \t\n\r";
const NEWLINE = "\n\r";
const COMMENTS = "#;";
const DOUBLE_QUOTE_ESCAPABLE = '"\\`$';

type State =
  | "PRE_KEY"
  | "KEY"
  | "PRE_VALUE"
  | "VALUE"
  | "VALUE_ESCAPE"
  | "SINGLE_QUOTE_VALUE"
  | "DOUBLE_QUOTE_VALUE"
  | "DOUBLE_QUOTE_VALUE_ESCAPE"
  | "COMMENT"
  | "COMMENT_ESCAPE";

export function parseSystemdEnvironmentFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  let state: State = "PRE_KEY";
  let key = "";
  let value = "";
  // Comprimento do valor antes do espaço final em curso (só no estado VALUE,
  // sem aspas) — o systemd apara o espaço final do valor não-citado.
  let valueTrimAt = -1;
  // Idem para a chave (`KEY = v` vira `KEY`).
  let keyTrimAt = -1;

  const push = (): void => {
    const k = keyTrimAt >= 0 ? key.slice(0, keyTrimAt) : key;
    if (k.length > 0) out[k] = value;
    key = "";
    value = "";
    valueTrimAt = -1;
    keyTrimAt = -1;
  };

  for (const c of content) {
    switch (state) {
      case "PRE_KEY":
        if (COMMENTS.includes(c)) state = "COMMENT";
        else if (!WHITESPACE.includes(c)) {
          state = "KEY";
          key = c;
          keyTrimAt = -1;
        }
        break;
      case "KEY":
        if (NEWLINE.includes(c)) {
          // linha sem `=`: ignorada
          state = "PRE_KEY";
          key = "";
          keyTrimAt = -1;
        } else if (c === "=") {
          state = "PRE_VALUE";
          value = "";
          valueTrimAt = -1;
        } else {
          if (!WHITESPACE.includes(c)) keyTrimAt = -1;
          else if (keyTrimAt < 0) keyTrimAt = key.length;
          key += c;
        }
        break;
      case "PRE_VALUE":
        if (NEWLINE.includes(c)) {
          state = "PRE_KEY";
          push();
        } else if (c === "'") state = "SINGLE_QUOTE_VALUE";
        else if (c === '"') state = "DOUBLE_QUOTE_VALUE";
        else if (c === "\\") state = "VALUE_ESCAPE";
        else if (!WHITESPACE.includes(c)) {
          state = "VALUE";
          value += c;
        }
        break;
      case "VALUE":
        if (NEWLINE.includes(c)) {
          if (valueTrimAt >= 0) value = value.slice(0, valueTrimAt);
          state = "PRE_KEY";
          push();
        } else if (c === "\\") {
          state = "VALUE_ESCAPE";
          valueTrimAt = -1;
        } else {
          if (!WHITESPACE.includes(c)) valueTrimAt = -1;
          else if (valueTrimAt < 0) valueTrimAt = value.length;
          value += c;
        }
        break;
      case "VALUE_ESCAPE":
        state = "VALUE";
        if (!NEWLINE.includes(c)) value += c;
        break;
      case "SINGLE_QUOTE_VALUE":
        if (c === "'") state = "PRE_VALUE";
        else value += c;
        break;
      case "DOUBLE_QUOTE_VALUE":
        if (c === '"') state = "PRE_VALUE";
        else if (c === "\\") state = "DOUBLE_QUOTE_VALUE_ESCAPE";
        else value += c;
        break;
      case "DOUBLE_QUOTE_VALUE_ESCAPE":
        state = "DOUBLE_QUOTE_VALUE";
        if (DOUBLE_QUOTE_ESCAPABLE.includes(c)) value += c;
        else if (c !== "\n") value += "\\" + c;
        break;
      case "COMMENT":
        if (c === "\\") state = "COMMENT_ESCAPE";
        else if (NEWLINE.includes(c)) state = "PRE_KEY";
        break;
      case "COMMENT_ESCAPE":
        state = "COMMENT";
        break;
    }
  }

  // Fim de arquivo sem quebra de linha final: o systemd ainda grava o par.
  if (state === "VALUE") {
    if (valueTrimAt >= 0) value = value.slice(0, valueTrimAt);
    push();
  } else if (
    state === "PRE_VALUE" ||
    state === "VALUE_ESCAPE" ||
    state === "SINGLE_QUOTE_VALUE" ||
    state === "DOUBLE_QUOTE_VALUE" ||
    state === "DOUBLE_QUOTE_VALUE_ESCAPE"
  ) {
    push();
  }

  return out;
}
