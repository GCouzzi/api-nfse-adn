(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 25;
  const state = {
    cnpj: "",
    notas: [],
    offset: 0,
    hasMore: false,
    query: null,
    requestId: 0,
    companies: [],
    empresaId: "",
    exportJobs: [],
    exportTimer: null,
    exportCreating: false,
    exportDownloads: new Set(),
    exportRequestId: 0,
  };

  // ---------- utilidades ----------
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
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
  const brl = (n) =>
    Number(n || 0).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  const fmtDate = (v) => {
    if (!v) return "—";
    const d = new Date(v);
    return isNaN(d)
      ? esc(v)
      : d.toLocaleString("pt-BR", {
          dateStyle: "short",
          timeStyle: v.length > 10 ? "short" : undefined,
        });
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
  async function api(path, opts = {}) {
    if (path.startsWith("/api/notas")) {
      const [route, query = ""] = path.split("?");
      const params = new URLSearchParams(query);
      if (!params.has("empresaId")) {
        const selected = state.companies.find(
          (company) => company.cnpj === $("cnpj").value,
        );
        if (selected) params.set("empresaId", selected.id);
      }
      path = `${route}?${params}`;
    }
    return window.NfseApi.request(path, opts);
  }

  async function apiJson(path, opts) {
    const res = await api(path, opts);
    const json = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409)
      throw new Error(json.error || json.message || `Erro HTTP ${res.status}`);
    return { status: res.status, json };
  }

  // O cliente compartilhado mantém a sessão também nos downloads.
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
      const a = Object.assign(document.createElement("a"), {
        href: url,
        download: m ? m[1] : fallbackName,
      });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast(`Download iniciado: ${m ? m[1] : fallbackName}`, "success");
      return true;
    } catch (e) {
      if (e.message !== "Não autorizado") toast(e.message, "error");
      return false;
    }
  }

  // ---------- status do servidor ----------
  async function loadInfo() {
    const pill = $("envPill");
    try {
      const info = await (await fetch("/")).json();
      pill.className = "pill up";
      pill.querySelector("span").textContent =
        `${info.environment}${info.mockMode ? " · MOCK" : ""}`;
      $("dbPill").textContent = info.database;
    } catch {
      pill.className = "pill down";
      pill.querySelector("span").textContent = "API offline";
    }
  }

  async function loadCompanies() {
    const selectedCnpj = $("cnpj").value;
    try {
      const { json } = await apiJson("/api/empresas");
      state.companies = json.data || [];
      const available = state.companies;
      $("cnpj").innerHTML =
        '<option value="">Selecione a empresa</option>' +
        available
          .map(
            (company) =>
              `<option value="${esc(company.cnpj)}">${esc(company.nome)} — ${esc(fmtCnpj(company.cnpj))}${company.ativa ? "" : " (inativa)"}</option>`,
          )
          .join("");
      const last = selectedCnpj || localStorage.getItem("nfse_last_cnpj");
      if (available.some((company) => company.cnpj === last))
        $("cnpj").value = last;
      $("companyHelp").textContent = available.length
        ? "Empresas inativas permitem consultar notas já armazenadas."
        : "Nenhuma empresa cadastrada. Acesse Empresas e certificados para começar.";
    } catch (error) {
      $("cnpj").innerHTML = '<option value="">Empresas indisponíveis</option>';
      $("companyHelp").textContent = error.message;
    }
    watchExports();
  }

  // ---------- listagem ----------
  function getCnpj() {
    const c = onlyDigits($("cnpj").value);
    if (c.length !== 14) {
      toast("Selecione uma empresa cadastrada.", "error");
      $("cnpj").focus();
      return null;
    }
    return c;
  }

  function skeleton() {
    $("tbody").innerHTML = Array.from(
      { length: 6 },
      () => `<tr class="skeleton">${"<td><div></div></td>".repeat(7)}</tr>`,
    ).join("");
  }

  const filterIds = [
    "papel",
    "status",
    "competencia",
    "prestador",
    "tomador",
    "chaveAcesso",
  ];
  const monthKey = (value) =>
    /^\d{4}-(0[1-9]|1[0-2])/.test(value || "") ? value.slice(0, 7) : "";
  const monthLabel = (key) =>
    key
      ? new Date(`${key}-15T12:00:00Z`).toLocaleDateString("pt-BR", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })
      : "Sem competência informada";
  function queryFromForm(cnpj) {
    const qs = new URLSearchParams({ cnpj });
    const company = state.companies.find((company) => company.cnpj === cnpj);
    if (company) qs.set("empresaId", company.id);
    for (const id of filterIds)
      if ($(id).value.trim()) qs.set(id, $(id).value.trim());
    if ($("filtroTexto").value.trim())
      qs.set("busca", $("filtroTexto").value.trim());
    return qs;
  }
  async function baixarMes(month, button) {
    if (!month || !state.cnpj) return;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "Preparando ZIP…";
    try {
      // O mês completo inclui todas as notas e eventos do CNPJ, sem limite de página.
      await download(
        `/api/notas/cnpj/${state.cnpj}/zip?${new URLSearchParams({ competencia: month })}`,
        `Pacote_XMLs_${state.cnpj}_${month}.zip`,
      );
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  async function buscar(offset = 0, reuseQuery = false) {
    const cnpj = reuseQuery ? state.cnpj : getCnpj();
    if (!cnpj) return;
    const qs = reuseQuery
      ? new URLSearchParams(state.query)
      : queryFromForm(cnpj);
    const requestId = ++state.requestId;

    $("empty").hidden = true;
    $("tableCard").hidden = false;
    skeleton();
    $("btnBuscar").disabled = true;
    $("btnPrev").disabled = true;
    $("btnNext").disabled = true;
    $("btnZipCnpj").disabled = true;
    $("btnZipMes").hidden = true;
    $("stats").hidden = true;
    $("tbody").setAttribute("aria-busy", "true");
    qs.set("limit", PAGE_SIZE + 1);
    qs.set("offset", offset);

    try {
      const { json } = await apiJson(`/api/notas?${qs}`);
      if (requestId !== state.requestId) return;
      state.cnpj = cnpj;
      state.empresaId = qs.get("empresaId") || "";
      state.offset = offset;
      state.query = new URLSearchParams(qs);
      const data = json.data || [];
      state.hasMore = data.length > PAGE_SIZE;
      state.notas = data.slice(0, PAGE_SIZE);
      render();
      loadStats(cnpj, qs, requestId);
    } catch (e) {
      if (requestId !== state.requestId) return;
      $("tbody").innerHTML =
        '<tr><td colspan="7">Não foi possível consultar as notas. Tente novamente.</td></tr>';
      $("pageInfo").textContent = "Consulta indisponível";
      if (e.message !== "Não autorizado") toast(e.message, "error");
    } finally {
      if (requestId === state.requestId) {
        $("btnBuscar").disabled = false;
        $("tbody").setAttribute("aria-busy", "false");
      }
    }
  }

  function render() {
    const rows = state.notas;
    const month = state.query.get("competencia");
    $("btnZipCnpj").disabled = false;
    $("btnZipMes").hidden = !month;
    $("btnPdfMes").hidden = !month;
    $("btnPdfTodos").disabled = state.exportCreating;
    $("btnPdfMes").disabled = state.exportCreating;
    $("btnZipMes").textContent = month
      ? `Baixar ${monthLabel(month)} completo (ZIP)`
      : "Baixar mês completo (ZIP)";
    $("resultContext").textContent =
      `CNPJ ${fmtCnpj(state.cnpj)} · ${month ? monthLabel(month) : "Todas as competências"} · Downloads mensais incluem todas as notas do mês.`;
    let previousMonth = null;

    if (!rows.length) {
      $("tbody").innerHTML =
        `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:40px">Nenhuma nota encontrada com estes filtros. Revise os filtros ou sincronize com o portal para importar novas notas.</td></tr>`;
    } else {
      $("tbody").innerHTML = rows
        .map((n) => {
          const month = monthKey(n.competencia);
          let heading = "";
          if (month !== previousMonth) {
            heading = `<tr class="month-heading"><th colspan="7" scope="rowgroup"><div class="month-heading-content"><div><strong>${esc(monthLabel(month))}</strong><small>${rows.filter((row) => monthKey(row.competencia) === month).length} nota(s) nesta página</small></div>${month ? `<div class="actions"><button type="button" class="btn btn-ghost" data-act="pdfmes" data-month="${esc(month)}">PDFs do mês</button><button type="button" class="btn btn-ghost" data-act="zipmes" data-month="${esc(month)}">Baixar mês completo (ZIP)</button></div>` : ""}</div></th></tr>`;
            previousMonth = month;
          }
          return `${heading}
        <tr>
          <td><b>${esc(n.numero_nfse || "—")}</b>${n.serie ? `<br><small style="color:var(--muted)">série ${esc(n.serie)}</small>` : ""}</td>
          <td><b>${esc(monthKey(n.competencia) ? n.competencia.slice(0, 10).split("-").reverse().join("/") : "—")}</b><br><small>Emissão: ${fmtDate(n.data_emissao)}</small></td>
          <td class="who"><strong title="${esc(n.razao_social_prestador)}">${esc(n.razao_social_prestador || "—")}</strong><small>${esc(fmtCnpj(n.cnpj_prestador))}</small></td>
          <td class="who"><strong title="${esc(n.razao_social_tomador)}">${esc(n.razao_social_tomador || "—")}</strong><small>${esc(n.cnpj_tomador ? fmtCnpj(n.cnpj_tomador) : n.cpf_tomador || "—")}</small></td>
          <td class="num">${brl(n.valor_servicos)}</td>
          <td><span class="st ${esc(n.status)}">${esc(n.status)}</span></td>
          <td class="num"><span class="row-actions">
            <button class="btn btn-ghost btn-sm" data-act="detalhe" data-chave="${esc(n.chave_acesso)}">Detalhes</button>
            <button class="btn btn-ghost btn-sm" data-act="xml" data-chave="${esc(n.chave_acesso)}">XML</button>
            <button class="btn btn-ghost btn-sm" data-act="pdf" data-chave="${esc(n.chave_acesso)}">PDF</button>
          </span></td>
        </tr>`;
        })
        .join("");
    }
    $("pageInfo").textContent =
      `Página ${Math.floor(state.offset / PAGE_SIZE) + 1} · ${state.notas.length} nota(s)`;
    $("btnPrev").disabled = state.offset === 0;
    $("btnNext").disabled = !state.hasMore;
  }

  async function loadStats(cnpj, filters, requestId) {
    // Totais calculados sobre até 1000 notas do CNPJ com os filtros atuais
    try {
      const qs = new URLSearchParams(filters);
      qs.set("limit", 1000);
      qs.set("offset", 0);
      const { json } = await apiJson(`/api/notas?${qs}`);
      if (requestId !== state.requestId) return;
      const all = json.data || [];
      $("stTotal").textContent = all.length >= 1000 ? "1000+" : all.length;
      $("stAut").textContent = all.filter(
        (n) => n.status === "AUTORIZADA",
      ).length;
      $("stCan").textContent = all.filter(
        (n) => n.status === "CANCELADA",
      ).length;
      $("stVal").textContent = brl(
        all
          .filter((n) => n.status === "AUTORIZADA")
          .reduce((s, n) => s + Number(n.valor_servicos || 0), 0),
      );
      const s = await apiJson(`/api/sync/${cnpj}`);
      if (requestId !== state.requestId) return;
      $("stNsu").textContent = s.json.data?.ultimo_nsu ?? "—";
      $("stats").hidden = false;
    } catch {
      /* estatísticas são opcionais */
    }
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
      const { status, json } = await apiJson("/api/sync", {
        method: "POST",
        body: JSON.stringify({ cnpj }),
      });
      const job = json.data;
      if (!job?.id)
        throw new Error(json.error || "Resposta inesperada da API.");
      if (status === 409)
        toast("Já havia uma sincronização em andamento. Acompanhando…", "info");

      let j = job;
      while (j.status === "QUEUED" || j.status === "PROCESSING") {
        if ($("cnpj").value !== cnpj) return;
        setSync(
          j.status,
          "run",
          `NSU ${j.nsu_inicial ?? 0} → ${j.nsu_final ?? "…"} · ${j.novos_documentos} documento(s) · ${j.ciclos_executados} ciclo(s)`,
          true,
        );
        await sleep(1500);
        j = (await apiJson(`/api/sync/jobs/${job.id}`)).json.data;
      }

      if (j.status === "COMPLETED") {
        if ($("cnpj").value !== cnpj) return;
        setSync(
          "COMPLETED",
          "ok",
          `Concluído: ${j.novos_documentos} documento(s) novos · ${j.total_notas} nota(s) · ${j.total_eventos} evento(s) · NSU final ${j.nsu_final}`,
          false,
        );
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

  // ---------- exportações ----------
  const exportStatuses = {
    QUEUED: "Na fila",
    PROCESSING: "Gerando PDFs",
    COMPLETED: "Disponível",
    PARTIAL: "Disponível com falhas",
    FAILED: "Falhou",
    EXPIRED: "Removido / expirado",
  };

  function selectedCompany() {
    return state.companies.find((company) => company.cnpj === $("cnpj").value);
  }

  function renderExports() {
    const focusedId =
      document.activeElement?.closest("[data-export-id]")?.dataset.exportId;
    $("exportList").innerHTML = state.exportJobs
      .map((job) => {
        const active = ["QUEUED", "PROCESSING"].includes(job.status);
        const available = ["COMPLETED", "PARTIAL"].includes(job.status);
        const label = job.competencia
          ? monthLabel(job.competencia)
          : "Todas as competências";
        const message = available
          ? `${job.processadas - job.falhas} PDF(s) disponíveis até ${fmtDate(job.expires_at)}. ${job.erro || ""}`
          : job.status === "EXPIRED"
            ? "Pacote removido após transferência ou expiração. Gere outro lote para baixar novamente."
            : job.erro ||
              (job.status === "QUEUED"
                ? "Aguardando processamento."
                : "Gerando o pacote de PDFs…");
        return `<article class="export-item">
        <div class="export-item-heading"><strong>${esc(label)}</strong><span class="badge ${active ? "run" : available ? "ok" : job.status === "FAILED" ? "bad" : ""}">${esc(exportStatuses[job.status] || job.status)}</span></div>
        <small>Solicitado em ${esc(fmtDate(job.created_at))}</small>
        <p>${job.processadas} de ${job.total} nota(s) processadas · ${job.falhas} falha(s).</p>
        ${active ? `<progress value="${job.processadas}" max="${job.total || 1}" aria-label="Progresso de ${esc(label)}"></progress>` : ""}
        <p>${esc(message)}</p>
        ${available ? `<button class="btn btn-primary" type="button" data-export-id="${esc(job.id)}" ${state.exportDownloads.has(job.id) ? "disabled" : ""}>${state.exportDownloads.has(job.id) ? "Baixando…" : "Baixar pacote de PDFs"}</button>` : ""}
      </article>`;
      })
      .join("");
    if (focusedId)
      $("exportList")
        .querySelector(`[data-export-id="${focusedId}"]`)
        ?.focus({ preventScroll: true });
  }

  function watchExports() {
    clearTimeout(state.exportTimer);
    const requestId = ++state.exportRequestId;
    state.exportJobs = [];
    const company = selectedCompany();
    $("exportCard").hidden = !company;
    $("exportList").innerHTML = "";
    if (!company) return;
    $("exportCompany").textContent =
      `${company.nome} · ${fmtCnpj(company.cnpj)}`;
    $("exportMessage").textContent = "Carregando exportações recentes…";
    void refreshExports(requestId, company.id);
  }

  async function refreshExports(requestId, empresaId) {
    try {
      const { json } = await apiJson(
        `/api/notas/pdf/exportacoes?empresaId=${encodeURIComponent(empresaId)}`,
      );
      if (requestId !== state.exportRequestId) return;
      state.exportJobs = json.data || [];
      renderExports();
      $("exportMessage").textContent = state.exportJobs.length
        ? "Últimas 20 exportações. Você pode sair e voltar para baixar os pacotes disponíveis."
        : "Nenhuma exportação recente para esta empresa.";
      const active = state.exportJobs.some((job) =>
        ["QUEUED", "PROCESSING"].includes(job.status),
      );
      state.exportTimer = setTimeout(
        () => refreshExports(requestId, empresaId),
        active ? 1500 : 30000,
      );
    } catch (error) {
      if (requestId !== state.exportRequestId) return;
      $("exportMessage").textContent =
        error.message === "Não autorizado"
          ? "Entre no painel para consultar as exportações."
          : "Não foi possível atualizar as exportações. Tentando novamente…";
      if (error.message !== "Não autorizado")
        state.exportTimer = setTimeout(
          () => refreshExports(requestId, empresaId),
          5000,
        );
    }
  }

  async function exportPdfs(month) {
    if (!state.empresaId || state.exportCreating) return;
    const empresaId = state.empresaId;
    state.exportCreating = true;
    $("btnPdfTodos").disabled = true;
    $("btnPdfMes").disabled = true;
    try {
      await apiJson(
        `/api/notas/pdf/exportacoes?empresaId=${encodeURIComponent(empresaId)}`,
        {
          method: "POST",
          body: JSON.stringify(month ? { competencia: month } : {}),
        },
      );
      toast(
        "Exportação solicitada. Você pode acompanhar o lote nas exportações recentes.",
        "success",
      );
      if (selectedCompany()?.id === empresaId) watchExports();
    } catch (error) {
      if (error.message !== "Não autorizado") toast(error.message, "error");
    } finally {
      state.exportCreating = false;
      $("btnPdfTodos").disabled = !state.empresaId;
      $("btnPdfMes").disabled = !state.empresaId;
    }
  }

  // ---------- detalhes ----------
  async function abrirDetalhe(chave) {
    const requestId = state.requestId;
    $("dTitle").textContent = "Carregando…";
    $("dChave").textContent = chave;
    $("dBody").innerHTML = "";
    $("overlay").hidden = false;
    $("drawer").classList.add("open");
    $("drawer").setAttribute("aria-hidden", "false");
    try {
      const { json } = await apiJson(`/api/notas/${encodeURIComponent(chave)}`);
      if (requestId !== state.requestId) return;
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
          ${
            docs
              .map(
                (d) => `
            <div class="doc-item">
              <div><b>${esc(d.tipo_documento)}${d.tipo_evento ? " · " + esc(d.tipo_evento) : ""}</b><small>${fmtDate(d.data_hora_geracao)}</small></div>
              <span class="row-actions">
                <button class="btn btn-ghost btn-sm" data-act="ver" data-id="${d.id}" data-label="${esc(d.tipo_documento)}">Ver</button>
                <button class="btn btn-primary btn-sm" data-act="baixar" data-id="${d.id}">Baixar</button>
              </span>
            </div>`,
              )
              .join("") ||
            "<small style='color:var(--muted)'>Nenhum XML.</small>"
          }
        </div>
        <div>
          <h3 class="section-title">Eventos (${evs.length})</h3>
          ${
            evs
              .map(
                (e) => `
            <div class="doc-item"><div><b>${esc(e.tipo_evento)}</b>
              <small>${esc(e.descricao_evento || e.motivo || "")} · ${fmtDate(e.data_hora_evento)}</small></div></div>`,
              )
              .join("") ||
            "<small style='color:var(--muted)'>Sem eventos.</small>"
          }
        </div>
        <button class="btn btn-accent" data-act="zipnota" data-chave="${esc(n.chave_acesso)}">⬇ Baixar ZIP (NFS-e + eventos)</button>`;
    } catch (e) {
      $("dBody").innerHTML =
        `<p style="color:var(--bad)">${esc(e.message)}</p>`;
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
    $("cnpj").addEventListener("change", () => {
      localStorage.setItem("nfse_last_cnpj", $("cnpj").value);
      state.requestId++;
      state.cnpj = "";
      state.empresaId = "";
      state.notas = [];
      $("tableCard").hidden = true;
      $("stats").hidden = true;
      $("syncCard").hidden = true;
      $("btnPdfTodos").disabled = true;
      $("btnPdfMes").disabled = true;
      $("empty").hidden = false;
      $("btnBuscar").disabled = false;
      fecharDetalhe();
      watchExports();
    });
    $("searchForm").addEventListener("submit", (e) => {
      e.preventDefault();
      buscar(0);
    });
    $("btnSync").addEventListener("click", sincronizar);
    $("btnLimpar").addEventListener("click", () => {
      for (const id of filterIds) $(id).value = id === "papel" ? "todos" : "";
      $("filtroTexto").value = "";
      if (getCnpj()) buscar(0);
    });
    $("btnPrev").addEventListener("click", () =>
      buscar(Math.max(0, state.offset - PAGE_SIZE), true),
    );
    $("btnNext").addEventListener("click", () =>
      buscar(state.offset + PAGE_SIZE, true),
    );
    $("btnZipMes").addEventListener("click", (e) =>
      baixarMes(state.query.get("competencia"), e.currentTarget),
    );
    $("btnZipCnpj").addEventListener("click", () =>
      download(
        `/api/notas/cnpj/${state.cnpj}/zip`,
        `Pacote_XMLs_${state.cnpj}.zip`,
      ),
    );
    $("btnPdfTodos").addEventListener("click", () => exportPdfs());
    $("btnPdfMes").addEventListener("click", () =>
      exportPdfs(state.query?.get("competencia")),
    );
    $("btnRefreshExports").addEventListener("click", watchExports);
    $("exportList").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-export-id]");
      if (!button || button.disabled) return;
      const job = state.exportJobs.find(
        (item) => item.id === button.dataset.exportId,
      );
      if (!job || state.exportDownloads.has(job.id)) return;
      state.exportDownloads.add(job.id);
      button.disabled = true;
      button.textContent = "Baixando…";
      const ok = await download(
        `/api/notas/pdf/exportacoes/${job.id}/arquivo?empresaId=${encodeURIComponent(job.empresa_id)}`,
        "PDFs.zip",
      );
      state.exportDownloads.delete(job.id);
      button.textContent = ok
        ? "Transferência finalizada"
        : "Transferência indisponível";
      if (selectedCompany()?.id === job.empresa_id) watchExports();
    });

    $("tbody").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      if (b.dataset.act === "zipmes") baixarMes(b.dataset.month, b);
      if (b.dataset.act === "pdfmes") exportPdfs(b.dataset.month);
      if (b.dataset.act === "pdf")
        download(
          `/api/notas/${b.dataset.chave}/pdf`,
          `DANFSe_${b.dataset.chave}.pdf`,
        );
      if (b.dataset.act === "detalhe") abrirDetalhe(b.dataset.chave);
      if (b.dataset.act === "xml")
        download(
          `/api/notas/${b.dataset.chave}/xml`,
          `NFSe_${b.dataset.chave}.xml`,
        );
    });
    $("dBody").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      if (b.dataset.act === "ver") verXml(b.dataset.id, b.dataset.label);
      if (b.dataset.act === "baixar")
        download(
          `/api/notas/documento/${b.dataset.id}/xml`,
          `documento_${b.dataset.id}.xml`,
        );
      if (b.dataset.act === "zipnota")
        download(
          `/api/notas/${b.dataset.chave}/zip`,
          `NFSe_${b.dataset.chave}.zip`,
        );
    });

    $("dClose").addEventListener("click", fecharDetalhe);
    $("overlay").addEventListener("click", fecharDetalhe);
    document.addEventListener(
      "keydown",
      (e) => e.key === "Escape" && fecharDetalhe(),
    );
    $("xmlClose").addEventListener("click", () => $("modalXml").close());

    window.addEventListener("nfse:authchange", loadCompanies);
  }

  bind();
  loadInfo();
  loadCompanies();
})();
