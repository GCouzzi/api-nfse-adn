(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 25;
  const state = { cnpj: "", notas: [], offset: 0, hasMore: false, filtro: "" };

  // ---------- utilidades ----------
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const onlyDigits = (v) => String(v || "").replace(/\D/g, "");
  const maskCnpj = (v) => {
    const d = onlyDigits(v).slice(0, 14);
    return d
      .replace(/^(\d{2})(\d)/, "$1.$2")
      .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d)/, ".$1/$2")
      .replace(/(\d{4})(\d)/, "$1-$2");
  };
  const fmtCnpj = (v) => (onlyDigits(v).length === 14 ? maskCnpj(v) : v || "—");
  const brl = (n) => Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const fmtDate = (v) => {
    if (!v) return "—";
    const d = new Date(v);
    return isNaN(d) ? esc(v) : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: v.length > 10 ? "short" : undefined });
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function toast(msg, type = "info") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  // ---------- API ----------
  const getToken = () => localStorage.getItem("nfse_api_token") || "";

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (opts.body) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401) {
      toast("Token inválido ou ausente. Informe o API Token.", "error");
      $("modalToken").showModal();
      throw new Error("Não autorizado");
    }
    return res;
  }

  async function apiJson(path, opts) {
    const res = await api(path, opts);
    const json = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(json.error || json.message || `Erro HTTP ${res.status}`);
    return { status: res.status, json };
  }

  // Download autenticado (o Bearer não vai em <a href>, então usamos fetch + blob)
  async function download(path, fallbackName) {
    try {
      const res = await api(path);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Erro HTTP ${res.status}`);
      }
      const cd = res.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="?([^";]+)"?/i);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: m ? m[1] : fallbackName });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast(`Download iniciado: ${m ? m[1] : fallbackName}`, "success");
    } catch (e) {
      if (e.message !== "Não autorizado") toast(e.message, "error");
    }
  }

  // ---------- status do servidor ----------
  async function loadInfo() {
    const pill = $("envPill");
    try {
      const info = await (await fetch("/")).json();
      pill.className = "pill up";
      pill.querySelector("span").textContent = `${info.environment}${info.mockMode ? " · MOCK" : ""}`;
      $("dbPill").textContent = info.database;
      if (info.authRequired && !getToken()) $("modalToken").showModal();
    } catch {
      pill.className = "pill down";
      pill.querySelector("span").textContent = "API offline";
    }
  }

  // ---------- listagem ----------
  function getCnpj() {
    const c = onlyDigits($("cnpj").value);
    if (c.length !== 14) {
      toast("Informe um CNPJ válido com 14 dígitos.", "error");
      $("cnpj").focus();
      return null;
    }
    return c;
  }

  function skeleton() {
    $("tbody").innerHTML = Array.from({ length: 6 }, () =>
      `<tr class="skeleton">${"<td><div></div></td>".repeat(7)}</tr>`).join("");
  }

  async function buscar(offset = 0) {
    const cnpj = getCnpj();
    if (!cnpj) return;
    state.cnpj = cnpj;
    state.offset = offset;

    $("empty").hidden = true;
    $("tableCard").hidden = false;
    skeleton();
    $("btnBuscar").disabled = true;

    const qs = new URLSearchParams({ cnpj, papel: $("papel").value, limit: PAGE_SIZE + 1, offset });
    if ($("status").value) qs.set("status", $("status").value);

    try {
      const { json } = await apiJson(`/api/notas?${qs}`);
      const data = json.data || [];
      state.hasMore = data.length > PAGE_SIZE;
      state.notas = data.slice(0, PAGE_SIZE);
      render();
      loadStats(cnpj);
    } catch (e) {
      $("tbody").innerHTML = "";
      if (e.message !== "Não autorizado") toast(e.message, "error");
    } finally {
      $("btnBuscar").disabled = false;
    }
  }

  function render() {
    const q = state.filtro.toLowerCase();
    const rows = state.notas.filter((n) =>
      !q || [n.numero_nfse, n.chave_acesso, n.razao_social_prestador, n.razao_social_tomador, n.cnpj_prestador, n.cnpj_tomador]
        .some((v) => String(v || "").toLowerCase().includes(q)));

    if (!rows.length) {
      $("tbody").innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:40px">Nenhuma nota encontrada. Tente sincronizar com o ADN.</td></tr>`;
    } else {
      $("tbody").innerHTML = rows.map((n) => `
        <tr>
          <td><b>${esc(n.numero_nfse || "—")}</b>${n.serie ? `<br><small style="color:var(--muted)">série ${esc(n.serie)}</small>` : ""}</td>
          <td>${fmtDate(n.data_emissao)}</td>
          <td class="who"><strong title="${esc(n.razao_social_prestador)}">${esc(n.razao_social_prestador || "—")}</strong><small>${esc(fmtCnpj(n.cnpj_prestador))}</small></td>
          <td class="who"><strong title="${esc(n.razao_social_tomador)}">${esc(n.razao_social_tomador || "—")}</strong><small>${esc(n.cnpj_tomador ? fmtCnpj(n.cnpj_tomador) : n.cpf_tomador || "—")}</small></td>
          <td class="num">${brl(n.valor_servicos)}</td>
          <td><span class="st ${esc(n.status)}">${esc(n.status)}</span></td>
          <td class="num"><span class="row-actions">
            <button class="btn btn-ghost btn-sm" data-act="detalhe" data-chave="${esc(n.chave_acesso)}">Detalhes</button>
            <button class="btn btn-ghost btn-sm" data-act="xml" data-chave="${esc(n.chave_acesso)}">XML</button>
          </span></td>
        </tr>`).join("");
    }
    $("pageInfo").textContent = `Página ${Math.floor(state.offset / PAGE_SIZE) + 1} · ${state.notas.length} nota(s)`;
    $("btnPrev").disabled = state.offset === 0;
    $("btnNext").disabled = !state.hasMore;
  }

  async function loadStats(cnpj) {
    // Totais calculados sobre até 1000 notas do CNPJ com os filtros atuais
    try {
      const qs = new URLSearchParams({ cnpj, papel: $("papel").value, limit: 1000 });
      if ($("status").value) qs.set("status", $("status").value);
      const { json } = await apiJson(`/api/notas?${qs}`);
      const all = json.data || [];
      $("stTotal").textContent = all.length >= 1000 ? "1000+" : all.length;
      $("stAut").textContent = all.filter((n) => n.status === "AUTORIZADA").length;
      $("stCan").textContent = all.filter((n) => n.status === "CANCELADA").length;
      $("stVal").textContent = brl(all.filter((n) => n.status === "AUTORIZADA").reduce((s, n) => s + Number(n.valor_servicos || 0), 0));
      const s = await apiJson(`/api/sync/${cnpj}`);
      $("stNsu").textContent = s.json.data?.ultimo_nsu ?? "—";
      $("stats").hidden = false;
    } catch { /* estatísticas são opcionais */ }
  }

  // ---------- sincronização ----------
  function setSync(badge, cls, msg, running) {
    $("syncCard").hidden = false;
    const b = $("syncBadge");
    b.textContent = badge;
    b.className = `badge ${cls}`;
    $("syncMsg").textContent = msg;
    const bar = $("syncBar");
    bar.className = running ? "bar indeterminate" : "bar";
    bar.style.width = running ? "" : badge === "COMPLETED" ? "100%" : "0";
  }

  async function sincronizar() {
    const cnpj = getCnpj();
    if (!cnpj) return;
    $("btnSync").disabled = true;
    setSync("ENFILEIRANDO", "run", "Enviando solicitação ao ADN…", true);
    try {
      const { status, json } = await apiJson("/api/sync", { method: "POST", body: JSON.stringify({ cnpj }) });
      const job = json.data;
      if (!job?.id) throw new Error(json.error || "Resposta inesperada da API.");
      if (status === 409) toast("Já havia uma sincronização em andamento. Acompanhando…", "info");

      let j = job;
      while (j.status === "QUEUED" || j.status === "PROCESSING") {
        setSync(j.status, "run",
          `NSU ${j.nsu_inicial ?? 0} → ${j.nsu_final ?? "…"} · ${j.novos_documentos} documento(s) · ${j.ciclos_executados} ciclo(s)`, true);
        await sleep(1500);
        j = (await apiJson(`/api/sync/jobs/${job.id}`)).json.data;
      }

      if (j.status === "COMPLETED") {
        setSync("COMPLETED", "ok",
          `Concluído: ${j.novos_documentos} documento(s) novos · ${j.total_notas} nota(s) · ${j.total_eventos} evento(s) · NSU final ${j.nsu_final}`, false);
        toast("Sincronização concluída!", "success");
        await buscar(0);
      } else {
        setSync("FAILED", "bad", j.erro || "A sincronização falhou.", false);
        toast(j.erro || "Falha na sincronização.", "error");
      }
    } catch (e) {
      setSync("ERRO", "bad", e.message, false);
      if (e.message !== "Não autorizado") toast(e.message, "error");
    } finally {
      $("btnSync").disabled = false;
    }
  }

  // ---------- detalhes ----------
  async function abrirDetalhe(chave) {
    $("dTitle").textContent = "Carregando…";
    $("dChave").textContent = chave;
    $("dBody").innerHTML = "";
    $("overlay").hidden = false;
    $("drawer").classList.add("open");
    $("drawer").setAttribute("aria-hidden", "false");
    try {
      const { json } = await apiJson(`/api/notas/${encodeURIComponent(chave)}`);
      const n = json.data;
      $("dTitle").textContent = `NFS-e ${n.numero_nfse || ""}`.trim();
      const docs = n.documentos || [];
      const evs = n.eventos || [];
      $("dBody").innerHTML = `
        <div class="kv">
          <div><span>Status</span><b><span class="st ${esc(n.status)}">${esc(n.status)}</span></b></div>
          <div><span>Valor dos serviços</span><b>${brl(n.valor_servicos)}</b></div>
          <div><span>Valor líquido</span><b>${brl(n.valor_liquido)}</b></div>
          <div><span>Emissão</span><b>${fmtDate(n.data_emissao)}</b></div>
          <div><span>Competência</span><b>${fmtDate(n.competencia)}</b></div>
          <div><span>NSU</span><b>${esc(n.nsu)}</b></div>
          <div class="full"><span>Prestador</span><b>${esc(n.razao_social_prestador || "—")}<br><small>${esc(fmtCnpj(n.cnpj_prestador))}</small></b></div>
          <div class="full"><span>Tomador</span><b>${esc(n.razao_social_tomador || "—")}<br><small>${esc(n.cnpj_tomador ? fmtCnpj(n.cnpj_tomador) : n.cpf_tomador || "—")}</small></b></div>
          <div class="full"><span>Serviço</span><b>${esc(n.descricao_servico || "—")}</b></div>
        </div>
        <div>
          <h3 class="section-title">Documentos XML (${docs.length})</h3>
          ${docs.map((d) => `
            <div class="doc-item">
              <div><b>${esc(d.tipo_documento)}${d.tipo_evento ? " · " + esc(d.tipo_evento) : ""}</b><small>${fmtDate(d.data_hora_geracao)}</small></div>
              <span class="row-actions">
                <button class="btn btn-ghost btn-sm" data-act="ver" data-id="${d.id}" data-label="${esc(d.tipo_documento)}">Ver</button>
                <button class="btn btn-primary btn-sm" data-act="baixar" data-id="${d.id}">Baixar</button>
              </span>
            </div>`).join("") || "<small style='color:var(--muted)'>Nenhum XML.</small>"}
        </div>
        <div>
          <h3 class="section-title">Eventos (${evs.length})</h3>
          ${evs.map((e) => `
            <div class="doc-item"><div><b>${esc(e.tipo_evento)}</b>
              <small>${esc(e.descricao_evento || e.motivo || "")} · ${fmtDate(e.data_hora_evento)}</small></div></div>`).join("")
            || "<small style='color:var(--muted)'>Sem eventos.</small>"}
        </div>
        <button class="btn btn-accent" data-act="zipnota" data-chave="${esc(n.chave_acesso)}">⬇ Baixar ZIP (NFS-e + eventos)</button>`;
    } catch (e) {
      $("dBody").innerHTML = `<p style="color:var(--bad)">${esc(e.message)}</p>`;
    }
  }

  function fecharDetalhe() {
    $("drawer").classList.remove("open");
    $("drawer").setAttribute("aria-hidden", "true");
    $("overlay").hidden = true;
  }

  async function verXml(id, label) {
    try {
      const res = await api(`/api/notas/documento/${id}/xml`);
      if (!res.ok) throw new Error(`Erro HTTP ${res.status}`);
      $("xmlTitle").textContent = `${label} #${id}`;
      $("xmlPre").textContent = await res.text();
      $("modalXml").showModal();
    } catch (e) {
      if (e.message !== "Não autorizado") toast(e.message, "error");
    }
  }

  // ---------- eventos ----------
  function bind() {
    $("cnpj").addEventListener("input", (e) => (e.target.value = maskCnpj(e.target.value)));
    $("cnpj").addEventListener("keydown", (e) => e.key === "Enter" && buscar(0));
    $("btnBuscar").addEventListener("click", () => buscar(0));
    $("btnSync").addEventListener("click", sincronizar);
    $("papel").addEventListener("change", () => state.cnpj && buscar(0));
    $("status").addEventListener("change", () => state.cnpj && buscar(0));
    $("filtroTexto").addEventListener("input", (e) => { state.filtro = e.target.value; render(); });
    $("btnPrev").addEventListener("click", () => buscar(Math.max(0, state.offset - PAGE_SIZE)));
    $("btnNext").addEventListener("click", () => buscar(state.offset + PAGE_SIZE));
    $("btnZipCnpj").addEventListener("click", () => download(`/api/notas/cnpj/${state.cnpj}/zip`, `Pacote_XMLs_${state.cnpj}.zip`));

    $("tbody").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      if (b.dataset.act === "detalhe") abrirDetalhe(b.dataset.chave);
      if (b.dataset.act === "xml") download(`/api/notas/${b.dataset.chave}/xml`, `NFSe_${b.dataset.chave}.xml`);
    });
    $("dBody").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      if (b.dataset.act === "ver") verXml(b.dataset.id, b.dataset.label);
      if (b.dataset.act === "baixar") download(`/api/notas/documento/${b.dataset.id}/xml`, `documento_${b.dataset.id}.xml`);
      if (b.dataset.act === "zipnota") download(`/api/notas/${b.dataset.chave}/zip`, `NFSe_${b.dataset.chave}.zip`);
    });

    $("dClose").addEventListener("click", fecharDetalhe);
    $("overlay").addEventListener("click", fecharDetalhe);
    document.addEventListener("keydown", (e) => e.key === "Escape" && fecharDetalhe());
    $("xmlClose").addEventListener("click", () => $("modalXml").close());

    $("btnSettings").addEventListener("click", () => {
      $("tokenInput").value = getToken();
      $("modalToken").showModal();
    });
    $("modalToken").addEventListener("close", () => {
      if ($("modalToken").returnValue === "ok") {
        localStorage.setItem("nfse_api_token", $("tokenInput").value.trim());
        toast("Token salvo neste navegador.", "success");
      }
    });

    const last = localStorage.getItem("nfse_last_cnpj");
    if (last) $("cnpj").value = maskCnpj(last);
    $("cnpj").addEventListener("change", () => localStorage.setItem("nfse_last_cnpj", onlyDigits($("cnpj").value)));
  }

  bind();
  loadInfo();
})();
