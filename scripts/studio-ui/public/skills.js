// skills.js (#4270) — página de catálogo das skills versionadas.
//
// Fetch de `GET /api/skills` (studio-skills.ts): lê `.claude/skills/*/SKILL.md`
// do filesystem a cada request, sem lista hardcoded. Somente leitura — o
// único affordance de ação é "Copiar comando" (clipboard local, nunca
// dispara a skill). Mesmo padrão vanilla/sem-build de utms.js/integracoes.js.

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  execModeValue: document.getElementById("exec-mode-value"),
  error: document.getElementById("skills-error"),
  count: document.getElementById("skills-count"),
  search: document.getElementById("filter-search"),
  refreshBtn: document.getElementById("refresh-btn"),
  lastUpdated: document.getElementById("last-updated"),
  groups: document.getElementById("skills-groups"),
  empty: document.getElementById("skills-empty"),
};

let data = { execMode: null, generatedAt: null, skills: [], errors: [], groupOrder: [], groupLabels: {} };
const filters = { search: "" };

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setFetchStatus(status, label) {
  el.fetchDot.className = "dot " + status;
  el.fetchLabel.textContent = label;
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function flagsHtml(flags) {
  if (!flags) return "";
  const chips = [];
  if (flags.model) chips.push(`<span class="skill-flag">model: ${escapeHtml(flags.model)}</span>`);
  if (flags.effort) chips.push(`<span class="skill-flag">effort: ${escapeHtml(flags.effort)}</span>`);
  if (flags.disableModelInvocation) {
    chips.push(`<span class="skill-flag skill-flag-disabled">disable-model-invocation</span>`);
  }
  return chips.join("");
}

function skillCardHtml(skill) {
  const descClass = skill.description ? "skill-description" : "skill-description is-missing";
  const argsBlock = skill.argumentsMarkdown
    ? `<pre class="skill-args">${escapeHtml(skill.argumentsMarkdown)}</pre>`
    : "";
  const heading = skill.usageHeading ? escapeHtml(skill.usageHeading) : escapeHtml(skill.invocable);
  return `
    <article class="skill-card" data-skill-id="${escapeHtml(skill.id)}">
      <div class="skill-card-header">
        <code class="skill-invocable">${heading}</code>
        <button type="button" class="skill-copy-btn" data-copy="${escapeHtml(skill.invocable)}">Copiar comando</button>
      </div>
      <p class="${descClass}">${escapeHtml(skill.description)}</p>
      <div class="skill-flags">${flagsHtml(skill.flags)}</div>
      ${argsBlock}
      <div class="skill-source"><code>${escapeHtml(skill.sourcePath)}</code></div>
    </article>
  `;
}

function matchesFilter(skill, search) {
  if (!search) return true;
  const haystack = `${skill.invocable} ${skill.description}`.toLowerCase();
  return haystack.includes(search);
}

function renderGroups() {
  const search = filters.search.trim().toLowerCase();
  const all = data.skills ?? [];
  const filtered = all.filter((s) => matchesFilter(s, search));
  el.count.textContent = String(filtered.length);

  if (filtered.length === 0) {
    el.empty.hidden = false;
    el.empty.textContent = all.length > 0 && search ? "0 resultados para esta busca." : "Nenhuma skill encontrada.";
    el.groups.innerHTML = "";
    return;
  }
  el.empty.hidden = true;

  const order = data.groupOrder && data.groupOrder.length ? data.groupOrder : ["pipeline-diaria", "mensal-semanal", "dev-sessions", "auxiliares"];
  const labels = data.groupLabels ?? {};
  const byGroup = new Map();
  for (const skill of filtered) {
    const g = skill.group || "auxiliares";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(skill);
  }

  const html = [];
  for (const g of order) {
    const skills = byGroup.get(g);
    if (!skills || skills.length === 0) continue;
    html.push(`<section class="skills-group">`);
    html.push(`<h3 class="skills-group-title">${escapeHtml(labels[g] ?? g)} (${skills.length})</h3>`);
    for (const skill of skills) html.push(skillCardHtml(skill));
    html.push(`</section>`);
  }
  el.groups.innerHTML = html.join("");
}

async function copyCommand(invocable, btn) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(invocable);
    } else {
      // Fallback pra ambiente sem Clipboard API (ex: http local sem contexto seguro).
      const ta = document.createElement("textarea");
      ta.value = invocable;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    const original = btn.textContent;
    btn.textContent = "Copiado!";
    btn.dataset.copied = "1";
    setTimeout(() => {
      btn.textContent = original;
      delete btn.dataset.copied;
    }, 1500);
  } catch (e) {
    btn.textContent = "Falhou — copie manualmente";
    setTimeout(() => {
      btn.textContent = "Copiar comando";
    }, 2000);
  }
}

async function refresh() {
  setFetchStatus("", "carregando…");
  try {
    const res = await fetch("/api/skills");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    if (data.errors && data.errors.length) {
      el.error.hidden = false;
      el.error.textContent = `${data.errors.length} skill(s) com SKILL.md ilegível: ${data.errors
        .map((e) => `${e.id} (${e.error})`)
        .join(" | ")}`;
    } else {
      el.error.hidden = true;
    }
    el.execModeValue.textContent = data.execMode ? `ambiente: ${data.execMode}` : "—";
    renderGroups();
    setFetchStatus("ok", `${(data.skills ?? []).length} skill(s)`);
    el.lastUpdated.textContent = data.generatedAt ? `gerado em ${fmtTime(data.generatedAt)}` : "";
  } catch (e) {
    el.error.hidden = false;
    el.error.textContent = `Falha ao carregar skills: ${e.message}`;
    setFetchStatus("down", "erro");
  }
}

el.search.addEventListener("input", () => {
  filters.search = el.search.value;
  renderGroups();
});

el.refreshBtn.addEventListener("click", () => refresh());

el.groups.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-copy]");
  if (btn) copyCommand(btn.getAttribute("data-copy"), btn);
});

refresh();
