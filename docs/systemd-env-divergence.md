# Aviso "já está definida no ambiente com um valor diferente" nas units do 300 (#12477)

O `env-loader` (`scripts/lib/env-loader.ts`) compara cada chave do `.env` com
o que já está em `process.env` e avisa quando os valores diferem (#8237). O
ambiente vence, de propósito.

## O caso do `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` (08/11/2026)

O aviso saía em todo log de task do `300` para essa chave. A causa não era uma
segunda credencial. As units geradas pelo repo fazem
`EnvironmentFile=-{repo}/.env` (#5114), então o systemd lê o mesmo `.env` antes
do script, com outro parser:

- `materialize-google-ads-credentials.ts` grava o JSON da service account sem
  aspas (#6704, para escapar da corrupção do dotenv em valor com aspas duplas,
  #6450);
- num valor sem aspas, o systemd trata `\` como escape e remove a barra, e os
  `\n` da `private_key` viram `n`. O JSON continua fazendo parse, mas a chave
  PEM fica inválida;
- o dotenv guarda o valor literal, que é o correto.

Desde o #12477 o `env-loader` reconhece esse caso: se o valor do ambiente é
exatamente o que o systemd leria do `.env` e difere do que o dotenv lê, ele
adota o valor do dotenv e não avisa. O parser do systemd está em
`scripts/lib/systemd-env-file.ts`. A comparação é por igualdade exata, então
qualquer valor vindo de outra fonte continua vencendo e continua avisando.

O valor canônico é o do `.env` sincronizado do Doppler, lido pelo dotenv.

## Se o aviso continuar saindo sob systemd

Então o valor vem de outra fonte, não do `.env` desta unit. Onde olhar no `300`:

1. `systemctl --user cat <unit>`: linhas `Environment=` e drop-ins em
   `~/.config/systemd/user/<unit>.d/`.
2. `systemctl --user show-environment`: ambiente do user manager (herda de
   `systemctl --user import-environment` ou `set-environment` feitos antes).
3. `~/.config/environment.d/*.conf`.
4. Um `.env` diferente do que o script lê (unit gerada para outro checkout).

A correção é remover a fonte extra (`systemctl --user unset-environment
GOOGLE_ADS_SERVICE_ACCOUNT_JSON`, ou apagar a linha do drop-in/environment.d) e
deixar o `.env` como única origem. Rotação da chave se faz no Doppler, depois
`npm run sync-env` e `npx tsx scripts/materialize-google-ads-credentials.ts`.
