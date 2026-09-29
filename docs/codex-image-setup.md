# Codex como gerador de imagens (#9088)

`platform.config.json → image_generator = "codex"` gera as imagens (Stage 1 É IA? e Stage 3 destaques) pelo **Codex CLI**, que usa a **assinatura ChatGPT** — sem cobrança por uso (princípio "Zero custo recorrente"). Backend: `scripts/codex-image.js`, mesmo contrato dos outros (`sdPromptPath outJpgPath filenamePrefix`).

## Setup (1x por máquina — Neo E `300`)

A edição diária hoje é rodada à mão (timer agendado do `300` cancelado em 19/08/2026), então o gerador precisa estar logado na máquina onde a sessão roda — o Neo. O `300` só precisa do Codex se uma sessão rodar lá (ou se o agendamento voltar). Nesta máquina e, se for usar, no `300`:

1. Instalar o Codex CLI (binário nativo ou `npm i -g @openai/codex`) — testado com 0.154.
2. `codex login` com a **conta ChatGPT** (nunca API key).
3. Conferir: `codex exec --skip-git-repo-check -m gpt-5.6-luna "reply ok"`.

## Armadilhas

- **Modelo explícito.** O default do `~/.codex/config.toml` (`gpt-6-sol`), `gpt-6-luna` e `gpt-5.6` são **recusados** na conta ChatGPT. O backend sempre passa `-m` (`platform.config.json → codex.model`, default `gpt-5.6-luna`; `gpt-5.5` também funciona). O modelo de *imagem* é interno ao Codex e não é configurável.
- **Sem pay-per-token.** `OPENAI_API_KEY`/`CODEX_API_KEY`/`OPENAI_BASE_URL` são removidas do ambiente do subprocesso (mesma lógica do #5608 pro Claude). O `.env` pode ter a key sem contaminar o Codex.
- **Login ChatGPT forçado:** `-c forced_login_method="chatgpt"` faz o CLI recusar uma API key guardada em `~/.codex/auth.json`.
- **Lento:** ~2 min por imagem (timeout `codex.timeout_seconds`, default 300).
- **Falha barulhenta:** sem arquivo de saída, timeout ou proporção incompatível → exit ≠ 0. Nunca sucesso sem imagem. Com `codex.fallback` configurado (`gemini` no `platform.config.json`; sem a chave não há fallback), `image-generate.ts` e `eia-compose.ts` caem nesse gerador (limitação conhecida: a legenda de crédito segue "Criada com ChatGPT"; o fallback fica no run-log) e a edição não trava; o log traz `image-generate: codex falhou — fallback configurado`.

## Crédito da imagem

Legenda "Criada com ChatGPT" (`imageGeneratorCredit`, `scripts/lib/newsletter-render-html.ts`).

## Config

```json
"image_generator": "codex",
"codex": { "model": "gpt-5.6-luna", "reasoning_effort": "low", "timeout_seconds": 300, "fallback": "gemini" }
```
