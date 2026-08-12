# Sync de `.env` entre máquinas via Doppler (#5149)

## Contexto

O projeto usa ~40 credenciais (`.env`, ver `.env.example`) espalhadas por Beehiiv,
Brevo, Cloudflare, Clarice, Facebook/Instagram/Threads, Stripe, apoia.se, etc.
Até 260812 o único caminho pra popular `.env` numa máquina nova era copiar
cada chave manualmente seguindo os comentários do `.env.example` — funciona,
mas é o tipo de passo que se esquece de repetir quando uma credencial é
rotacionada numa máquina e a outra fica desatualizada em silêncio.

Em 07/08/2026 um workspace Doppler (`diar.ia.br`, plano Developer — grátis até
3 usuários, [doppler.com/pricing](https://www.doppler.com/pricing)) foi criado
e populado com todas as secrets do projeto, mas ficou sem nenhuma integração
com o repo até esta issue (#5149) — o CLI ficava instalado e autenticado sem
nada no código apontar pra ele. Achado ao investigar "a gente instalou uma
ferramenta pra sincronizar o .env?" (a resposta era sim, só não tinha virado
mecanismo).

## Mecanismo

`doppler.yaml` na raiz do repo (committed, sem secrets — só
`project: diaria-studio` / `config: dev`) deixa qualquer máquina logada
(`doppler login`) pronta pra rodar comandos Doppler aqui dentro sem precisar
de `doppler setup` interativo.

`npm run sync-env` (`scripts/sync-env.ts`) baixa o snapshot atual do vault
(`doppler secrets download --no-file --format env`) e escreve em `.env`
**atomicamente** (tmp + rename) — uma falha do Doppler (sessão expirada,
rede, projeto/config errado) nunca trunca um `.env` que já funcionava.
Achado do code-review do PR #5150: a primeira versão usava `> .env` puro,
que zera o arquivo antes do comando rodar, independente do exit code;
reproduzido ao vivo e coberto por regressão em `test/sync-env.test.ts`.
Não é push automático: o vault continua sendo editado manualmente no
dashboard (https://dashboard.doppler.com) ou via `doppler secrets set
NOME=valor` quando uma credencial for gerada/rotacionada — `sync-env` só
puxa.

**Precedência preservada:** `scripts/lib/env-loader.ts` (`loadProjectEnv`)
carrega `.env` com `override: false` — uma var já presente em `process.env`
(por exemplo, setada por `doppler run -- <comando>` em vez de via `.env`)
sempre ganha do arquivo. Os dois caminhos coexistem sem conflito; hoje o
projeto só usa o caminho `.env`, não `doppler run` diretamente nos scripts —
ver "Fora de escopo" abaixo.

## Setup numa máquina nova

```bash
# 1x por máquina — instala o CLI (ver https://docs.doppler.com/docs/install-cli)
# depois autentica (abre browser, pede o login da conta Doppler do projeto):
doppler login

# dentro do repo, a qualquer momento (idempotente, resincroniza sempre que
# uma key mudar no vault):
npm run sync-env
```

Sem acesso ao workspace Doppler (ex: máquina de outra pessoa, ou antes de
pedir convite pro workspace): seguir o fluxo manual antigo — copiar
`.env.example` pra `.env` e preencher cada chave conforme os comentários
(cada uma documenta onde gerar/renovar).

## O que está fora do vault (de propósito)

- `data/.credentials.json` (Google OAuth) e `data/.fb-credentials.json`
  (Facebook Page token) — não são env vars, são arquivos de credencial
  gerados por fluxo OAuth local; continuam fora do Doppler.
- Segredos gerenciados pela claude.ai (Beehiiv MCP OAuth, Gmail MCP OAuth) —
  não passam por `.env`, ver `docs/secret-rotation.md`.

## Fora de escopo desta integração

`doppler run -- <comando>` (injeta as secrets como env vars reais do
processo, sem precisar materializar `.env` em disco) **não foi adotado**
para os scripts da pipeline nem pros units systemd (`Diaria-*`, ver
`CLAUDE.md`) — trocaria o `ExecStart=` de ~15 timers em produção, risco não
justificado pelo ganho (o `.env` gerado por `sync-env` já resolve o problema
original de sync manual). Considerar no futuro se o `.env` em disco virar
um problema de segurança concreto (hoje é gitignored + só local).

## Rotação de credencial

Ao rotacionar qualquer chave (ver `docs/secret-rotation.md`), atualizar o
valor no dashboard Doppler (ou `doppler secrets set NOME=novo_valor`) e
rodar `npm run sync-env` em cada máquina — substitui o passo de editar
`.env` à mão em cada uma.

## Estado (260812)

Vault confirmado como espelho completo do `.env` desta máquina (nenhuma
chave só de um lado) no momento da integração. Setup confirmado ponta a
ponta nas duas máquinas do editor: Linux (integração original) e Windows
(`doppler login` já estava feito desde 07/08 — só faltava o `doppler.yaml`
do repo pra apontar pra ele; `npm run sync-env` gerou as mesmas 41 chaves e
`loadProjectEnv()` leu `CLARICE_API_KEY` corretamente) — fecha #5149.
