if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.log('Error SW:', err));
}

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxsjzw8hWWDvn7DTJBfRRVyCFtXyB2iP__NmGodyAOj3EJvdNozTQ-vUZW79RuiWryQIQ/exec';

let productosCache = [];
let maquinasCache = [];
let historialCache = [];
let operariosCache = [];
let pendientesCache = [];
let html5QrCode = null;
let currentRondaId = null;
let chartTendenciaInstance = null;

document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupEventListeners();
  setupToggles();
  actualizarTurnoAuto();
  setupCustomComboboxes();
  checkSession();
});

function obtenerHoraSantiago() {
  const now = new Date();
  const horaStr = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: 'numeric', hour12: false }).format(now);
  let hora = parseInt(horaStr, 10);
  if (hora === 24) hora = 0;
  return hora;
}

function obtenerTurnoAuto() {
  const hora = obtenerHoraSantiago();
  return (hora >= 8 && hora < 20) ? "Turno Mañana" : "Turno Noche";
}

function actualizarTurnoAuto() {
  const inputTurno = document.getElementById('input-turno');
  const turnoHeader = document.getElementById('turno-header-badge');
  const turnoActual = obtenerTurnoAuto();
  if (inputTurno) inputTurno.value = turnoActual;
  if (turnoHeader) turnoHeader.innerText = turnoActual;
}

function checkSession() {
  const usuario = sessionStorage.getItem('usuario_calidad');
  const rol = sessionStorage.getItem('rol_calidad');
  if (!usuario || !rol) {
    document.getElementById('login-modal').style.display = 'flex';
    document.getElementById('app-content').style.display = 'none';
  } else {
    document.getElementById('login-modal').style.display = 'none';
    document.getElementById('app-content').style.display = 'block';
    document.getElementById('user-display').innerText = `Inspector: ${usuario}`;
    document.getElementById('rol-header-badge').innerText = `Rol: ${rol}`;
    const tabInicial = rol === 'Laboratorio' ? 'view-borradores' : 'view-nueva';
    document.querySelector(`.nav-tab[data-target="${tabInicial}"]`).click();
    loadCatalogData();
  }
}

function setupNavigation() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));

      tab.classList.add('active');
      const targetView = document.getElementById(tab.dataset.target);
      if (targetView) targetView.classList.add('active');

      if (tab.dataset.target === 'view-historial') renderHistorialInspector();
      if (tab.dataset.target === 'view-borradores') renderPendientes();
      if (tab.dataset.target === 'view-analisis') renderAnalisis();
      if (tab.dataset.target === 'view-nueva') actualizarModoFormulario();
    });
  });
}

function actualizarModoFormulario() {
  const rol = sessionStorage.getItem('rol_calidad');
  if (currentRondaId) {
    mostrarModoLaboratorio();
  } else if (rol === 'Laboratorio') {
    mostrarModoEsperaPendiente();
  } else {
    mostrarModoTerreno();
  }
}

function mostrarModoTerreno() {
  document.getElementById('msg-seleccionar-pendiente').style.display = 'none';
  document.getElementById('ronda-info-banner').style.display = 'none';
  document.getElementById('card-identificacion').style.display = 'block';
  document.getElementById('card-mediciones').style.display = 'none';
  document.getElementById('btn-iniciar-ronda').style.display = 'block';
  document.getElementById('btn-cerrar-ronda').style.display = 'none';
  document.getElementById('btn-cancelar-ronda').style.display = 'none';
}

function mostrarModoEsperaPendiente() {
  document.getElementById('msg-seleccionar-pendiente').style.display = 'block';
  document.getElementById('ronda-info-banner').style.display = 'none';
  document.getElementById('card-identificacion').style.display = 'none';
  document.getElementById('card-mediciones').style.display = 'none';
  document.getElementById('specs-banner').style.display = 'none';
  document.getElementById('btn-iniciar-ronda').style.display = 'none';
  document.getElementById('btn-cerrar-ronda').style.display = 'none';
  document.getElementById('btn-cancelar-ronda').style.display = 'none';
}

function mostrarModoLaboratorio() {
  document.getElementById('msg-seleccionar-pendiente').style.display = 'none';
  document.getElementById('ronda-info-banner').style.display = 'block';
  document.getElementById('card-identificacion').style.display = 'none';
  document.getElementById('card-mediciones').style.display = 'block';
  document.getElementById('specs-banner').style.display = 'block';
  document.getElementById('btn-iniciar-ronda').style.display = 'none';
  document.getElementById('btn-cerrar-ronda').style.display = 'block';
  document.getElementById('btn-cancelar-ronda').style.display = 'block';
}

function recopilarDatosIdentificacion() {
  return {
    maquinaId: document.getElementById('select-maquina').value,
    productoId: document.getElementById('select-producto').value,
    operario: document.getElementById('input-search-operario').value,
    lote_mp: document.getElementById('input-lote-mp').value,
    lote_bxa: document.getElementById('input-lote-bxa').value,
    cavidad_molde: document.getElementById('input-cavidad').value,
    color_med: document.getElementById('med-color').value, color_val: document.getElementById('val-color').value,
    ciclo_med: document.getElementById('med-ciclo').value, ciclo_val: document.getElementById('val-ciclo').value,
    peso_med: document.getElementById('med-peso').value, peso_val: document.getElementById('val-peso').value,
    probador_med: document.getElementById('med-probador').value, probador_val: document.getElementById('val-probador').value
  };
}

function recopilarDatosMediciones() {
  return {
    observaciones: document.getElementById('input-observaciones').value,
    espesor_med: document.getElementById('med-espesor').value, espesor_val: document.getElementById('val-espesor').value,
    calce_med: document.getElementById('med-calce').value, calce_val: document.getElementById('val-calce').value,
    filtracion_med: document.getElementById('med-filtracion').value, filtracion_val: document.getElementById('val-filtracion').value,
    hcuello_med: document.getElementById('med-hcuello').value, hcuello_val: document.getElementById('val-hcuello').value,
    phi_int_med: document.getElementById('med-phi-int').value, phi_int_val: document.getElementById('val-phi-int').value,
    phi_hilo_med: document.getElementById('med-phi-hilo').value, phi_hilo_val: document.getElementById('val-phi-hilo').value,
    phi_trinquete_med: document.getElementById('med-phi-trinquete').value, phi_trinquete_val: document.getElementById('val-phi-trinquete').value,
    rebalse_med: document.getElementById('med-rebalse').value, rebalse_val: document.getElementById('val-rebalse').value,
    caida_med: document.getElementById('med-caida').value, caida_val: document.getElementById('val-caida').value
  };
}

function resetMedicionRowsEnContenedor(idContenedor) {
  const contenedor = document.getElementById(idContenedor);
  if (!contenedor) return;
  contenedor.querySelectorAll('.medicion-row input').forEach(el => { el.value = ''; el.style.borderColor = '#64748b'; });
  contenedor.querySelectorAll('.btn-toggle').forEach(btn => {
    btn.innerText = 'Cumple';
    btn.className = 'btn-toggle active-cumple';
    const t = document.getElementById(btn.dataset.target);
    if (t) t.value = 'Cumple';
  });
}

function resetFormularioIdentificacion() {
  document.getElementById('select-maquina').value = '';
  document.getElementById('input-search-maquina').value = '';
  document.getElementById('select-producto').value = '';
  document.getElementById('input-search-producto').value = '';
  document.getElementById('input-search-operario').value = '';
  document.getElementById('input-lote-mp').value = '';
  document.getElementById('input-lote-bxa').value = '';
  document.getElementById('input-cavidad').value = 1;
  document.getElementById('specs-banner').style.display = 'none';
  resetMedicionRowsEnContenedor('card-identificacion');
}

function resetFormularioMediciones() {
  document.getElementById('input-observaciones').value = '';
  resetMedicionRowsEnContenedor('card-mediciones');
}

function resetFormularioCompleto() {
  currentRondaId = null;
  resetFormularioIdentificacion();
  resetFormularioMediciones();
}

function actualizarContadorBorradores() {
  const el = document.getElementById('contador-borradores');
  if (el) el.innerText = pendientesCache.length;
}

function renderPendientes() {
  const tbody = document.getElementById('tabla-borradores-body');
  const rol = sessionStorage.getItem('rol_calidad');
  if (!tbody) return;

  if (pendientesCache.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No hay rondas pendientes de laboratorio.</td></tr>`;
    return;
  }

  tbody.innerHTML = pendientesCache.map(p => `
    <tr>
      <td>${p.fechaHora}</td><td>${p.maquina}</td><td>${p.producto}</td><td>${p.correlativoMaquina || '-'}</td><td>${p.inspector}</td>
      <td style="display:flex; gap:5px;">
        ${rol === 'Laboratorio'
          ? `<button onclick="cargarPendiente('${p.idInspeccion}')" class="btn btn-primary" style="height:35px; padding:0 10px;">▶️ Completar</button>
             <button onclick="cancelarPendiente('${p.idInspeccion}')" class="btn btn-danger" style="height:35px; padding:0 10px;">🗑️</button>`
          : '<span style="color:#94a3b8; font-size:0.8rem;">Solo Laboratorio</span>'}
      </td>
    </tr>
  `).join('');
}

// CARGA DE LA RONDA EN LABORATORIO CON TODOS SUS DATOS DE TERRENO Y ESPECIFICACIONES
window.cargarPendiente = function (id) {
  const rol = sessionStorage.getItem('rol_calidad');
  if (rol !== 'Laboratorio') return;

  const pendiente = pendientesCache.find(p => p.idInspeccion === id);
  if (!pendiente) {
    alert("Esa ronda ya no está pendiente. Actualizando lista...");
    loadCatalogData();
    return;
  }

  document.getElementById('select-maquina').value = pendiente.maquina;
  document.getElementById('select-producto').value = pendiente.producto;
  
  // 1. Llenar los datos de identificación
  document.getElementById('ronda-info-maquina').innerText = pendiente.maquina;
  document.getElementById('ronda-info-producto').innerText = pendiente.producto;
  document.getElementById('ronda-info-operario').innerText = pendiente.operario || '-';
  document.getElementById('ronda-info-cavidad').innerText = pendiente.cavidadMolde || 1;
  document.getElementById('ronda-info-lotemp').innerText = pendiente.loteMp || '-';
  document.getElementById('ronda-info-lotebxa').innerText = pendiente.loteBxa || '-';
  document.getElementById('ronda-info-inspector').innerText = pendiente.inspector || '-';

  // 2. Llenar los datos medidos en terreno
  document.getElementById('ronda-info-color').innerText = `${pendiente.color_med || 'S/D'} [${pendiente.color_val || 'Cumple'}]`;
  document.getElementById('ronda-info-ciclo').innerText = `${pendiente.ciclo_med || 'S/D'} s [${pendiente.ciclo_val || 'Cumple'}]`;
  document.getElementById('ronda-info-peso').innerText = `${pendiente.peso_med || 'S/D'} g [${pendiente.peso_val || 'Cumple'}]`;
  document.getElementById('ronda-info-probador').innerText = `${pendiente.probador_med || 'S/D'} [${pendiente.probador_val || 'Cumple'}]`;

  // 3. Desplegar todas las tolerancias y especificaciones técnicas del producto
  actualizarFichaProducto(pendiente.producto);

  currentRondaId = pendiente.idInspeccion;
  document.querySelector('.nav-tab[data-target="view-nueva"]').click();
};

window.cancelarPendiente = async function (id) {
  if (!confirm("¿Descartar esta ronda pendiente? Se perderá el registro de esa pasada por la máquina.")) return;
  await postAccion({ action: 'cancelarRonda', idRonda: id });
  await loadCatalogData();
};

function setupCustomComboboxes() {
  const configs = [
    { inputId: 'input-search-maquina', dropId: 'dropdown-maquina', getData: () => maquinasCache, type: 'maquina' },
    { inputId: 'input-search-producto', dropId: 'dropdown-producto', getData: () => productosCache, type: 'producto' },
    { inputId: 'input-search-operario', dropId: 'dropdown-operario', getData: () => operariosCache, type: 'operario' }
  ];

  configs.forEach(cfg => {
    const inputEl = document.getElementById(cfg.inputId);
    const dropEl = document.getElementById(cfg.dropId);
    if (!inputEl || !dropEl) return;

    const mostrarOpciones = () => {
      const filtro = inputEl.value.toLowerCase().trim();
      const datos = cfg.getData();
      dropEl.innerHTML = '';

      const filtrados = datos.filter(item => {
        const texto = (item.nombre || item.id || '').toLowerCase();
        return texto.includes(filtro);
      });

      if (filtrados.length === 0) {
        dropEl.innerHTML = `<div class="combobox-item" style="color:#94a3b8; cursor:default;">Sin coincidencias</div>`;
      } else {
        filtrados.forEach(item => {
          const div = document.createElement('div');
          div.className = 'combobox-item';
          const textoItem = item.nombre || item.id;
          div.innerText = textoItem;

          div.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            inputEl.value = textoItem;

            if (cfg.type === 'operario') {
              document.getElementById('select-operario').value = textoItem;
            } else {
              document.getElementById(`select-${cfg.type}`).value = item.id;
              if (cfg.type === 'producto') actualizarFichaProducto(item.id);
            }

            dropEl.style.display = 'none';
          });
          dropEl.appendChild(div);
        });
      }
      dropEl.style.display = 'block';
    };

    inputEl.addEventListener('focus', mostrarOpciones);
    inputEl.addEventListener('click', mostrarOpciones);
    inputEl.addEventListener('input', mostrarOpciones);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.form-group')) {
      document.querySelectorAll('.combobox-dropdown').forEach(d => {
        d.style.display = 'none';
      });
    }
  });
}

// FICHA TÉCNICA COMPLETA DEL PRODUCTO
function actualizarFichaProducto(prodId) {
  const selected = productosCache.find(p => p.id === prodId || p.nombre === prodId);
  const banner = document.getElementById('specs-banner');
  if (selected && banner) {
    document.getElementById('spec-peso').innerText = selected.peso || '-';
    document.getElementById('spec-ciclo').innerText = selected.ciclo || '-';
    document.getElementById('spec-color').innerText = selected.color || '-';
    document.getElementById('spec-espesor').innerText = selected.espesor || '-';
    document.getElementById('spec-hcuello').innerText = selected.hcuello || '-';
    document.getElementById('spec-diam-int').innerText = selected.diametroInterior || '-';
    document.getElementById('spec-diam-hilo').innerText = selected.diametroHilo || '-';
    document.getElementById('spec-diam-trinquete').innerText = selected.diametroTrinquete || '-';
    document.getElementById('spec-rebalse').innerText = selected.rebalse || '-';
    banner.style.display = 'block';
  } else if (banner) {
    banner.style.display = 'none';
  }
}

function setupEventListeners() {
  document.getElementById('btn-login').addEventListener('click', () => {
    const user = document.getElementById('login-inspector').value;
    const rol = document.getElementById('login-rol').value;
    const pin = document.getElementById('login-pin').value;
    if (!user) { document.getElementById('login-error').innerText = '⚠️ Selecciona un inspector.'; return; }
    if (pin === '1234' || pin === '0000') {
      sessionStorage.setItem('usuario_calidad', user.trim());
      sessionStorage.setItem('rol_calidad', rol);
      document.getElementById('login-error').innerText = '';
      checkSession();
    } else { document.getElementById('login-error').innerText = '⚠️ PIN incorrecto.'; }
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    sessionStorage.removeItem('usuario_calidad');
    sessionStorage.removeItem('rol_calidad');
    resetFormularioCompleto();
    checkSession();
  });

  // BOTÓN 1: ENVIAR A LABORATORIO (TERRENO)
  document.getElementById('btn-iniciar-ronda').addEventListener('click', async () => {
    const dataId = recopilarDatosIdentificacion();
    if (!dataId.maquinaId || !dataId.productoId) {
      alert("⚠️ Selecciona al menos Máquina y Producto para enviar a laboratorio.");
      return;
    }

    const chequeoTerreno = [
      { id: 'med-color', n: 'Color' }, { id: 'med-ciclo', n: 'Ciclo' },
      { id: 'med-peso', n: 'Peso' }, { id: 'med-probador', n: 'Probador' }
    ];
    let faltantesTerreno = [];
    chequeoTerreno.forEach(m => {
      const el = document.getElementById(m.id);
      if (!el.value.trim()) { el.style.borderColor = 'red'; faltantesTerreno.push(m.n); }
      else { el.style.borderColor = '#64748b'; }
    });
    if (faltantesTerreno.length > 0) {
      alert("⚠️ Antes de enviar a laboratorio debes registrar en la máquina:\n\n• " + faltantesTerreno.join("\n• "));
      return;
    }

    const btn = document.getElementById('btn-iniciar-ronda');
    btn.disabled = true; btn.innerText = "Enviando a Laboratorio...";

    const payload = {
      action: 'crearRonda',
      idRonda: 'INSP-' + Date.now(),
      inspector_calidad: sessionStorage.getItem('usuario_calidad'),
      id_maquina: dataId.maquinaId,
      id_producto: dataId.productoId,
      operario: dataId.operario,
      lote_mp: dataId.lote_mp,
      lote_bxa: dataId.lote_bxa,
      cavidad_molde: dataId.cavidad_molde,
      color_med: dataId.color_med, color_val: dataId.color_val,
      ciclo_med: dataId.ciclo_med, ciclo_val: dataId.ciclo_val,
      peso_med: dataId.peso_med, peso_val: dataId.peso_val,
      probador_med: dataId.probador_med, probador_val: dataId.probador_val
    };

    const exito = await postAccion(payload);
    if (exito) {
      alert("🧪 Inspección enviada a Laboratorio con éxito.");
      resetFormularioIdentificacion();
      await loadCatalogData();
    }

    btn.disabled = false; btn.innerText = "🧪 Enviar a Laboratorio";
  });

  // BOTÓN 2: CERRAR Y GUARDAR REGISTRO FINAL (LABORATORIO)
  document.getElementById('btn-cerrar-ronda').addEventListener('click', async () => {
    if (!currentRondaId) { alert("No hay una ronda seleccionada."); return; }

    const medicionesDef = [
      { id: 'med-espesor', n: 'Espesor' },
      { id: 'med-calce', n: 'Calce' }, { id: 'med-filtracion', n: 'Filtración' },
      { id: 'med-hcuello', n: 'H Cuello' },
      { id: 'med-phi-int', n: 'Φ Int' }, { id: 'med-phi-hilo', n: 'Φ Hilo' },
      { id: 'med-phi-trinquete', n: 'Φ Trinquete' }, { id: 'med-rebalse', n: 'Rebalse' },
      { id: 'med-caida', n: 'Caída' }
    ];

    let faltantes = [];
    medicionesDef.forEach(m => {
      const el = document.getElementById(m.id);
      if (!el.value.trim()) { el.style.borderColor = 'red'; faltantes.push(m.n); }
      else { el.style.borderColor = '#64748b'; }
    });

    if (faltantes.length > 0) {
      alert("⚠️ NO SE PUEDE GUARDAR EL REGISTRO FINAL. Faltan completar en laboratorio:\n\n• " + faltantes.join("\n• "));
      return;
    }

    const btn = document.getElementById('btn-cerrar-ronda');
    btn.disabled = true; btn.innerText = "Guardando en Drive...";

    const payload = Object.assign(
      { action: 'cerrarRonda', idRonda: currentRondaId, inspector_lab: sessionStorage.getItem('usuario_calidad') },
      recopilarDatosMediciones()
    );

    const exito = await postAccion(payload);
    if (exito) {
      alert("✅ ¡Registro final cerrado y guardado exitosamente en Google Drive!");
      resetFormularioCompleto();
      await loadCatalogData();
      const rolActual = sessionStorage.getItem('rol_calidad');
      const siguienteTab = rolActual === 'Laboratorio' ? 'view-borradores' : 'view-nueva';
      document.querySelector(`.nav-tab[data-target="${siguienteTab}"]`).click();
    }

    btn.disabled = false; btn.innerText = "✅ GUARDAR REGISTRO FINAL";
  });

  document.getElementById('btn-cancelar-ronda').addEventListener('click', () => {
    resetFormularioCompleto();
    document.querySelector('.nav-tab[data-target="view-borradores"]').click();
  });

  document.getElementById('btn-cerrar-turno').addEventListener('click', cerrarTurno);
  document.getElementById('btn-generar-pdf-ahora').addEventListener('click', generarConsolidado);
  document.getElementById('btn-qr').addEventListener('click', startQRScanner);
  document.getElementById('btn-close-qr').addEventListener('click', stopQRScanner);
  document.getElementById('btn-refresh-historial').addEventListener('click', loadCatalogData);

  const selectAnalisis = document.getElementById('select-analisis-producto');
  if (selectAnalisis) selectAnalisis.addEventListener('change', renderAnalisis);
}

function setupToggles() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-toggle');
    if (!btn) return;
    e.preventDefault();
    const target = document.getElementById(btn.dataset.target);
    if (btn.classList.contains('active-cumple')) { btn.classList.replace('active-cumple', 'active-nocumple'); btn.innerText = 'No Cumple'; if (target) target.value = 'No Cumple'; }
    else { btn.classList.replace('active-nocumple', 'active-cumple'); btn.innerText = 'Cumple'; if (target) target.value = 'Cumple'; }
  });
}

async function postAccion(payload) {
  try {
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    return true;
  } catch (err) {
    alert("Error al conectar con Drive.");
    return false;
  }
}

async function loadCatalogData() {
  try {
    const res = await fetch(GOOGLE_SCRIPT_URL); const data = await res.json();
    maquinasCache = data.maquinas || [];
    productosCache = data.productos || [];
    operariosCache = data.operarios || [];
    historialCache = data.historial || [];
    pendientesCache = data.pendientes || [];
    renderHistorialInspector();
    renderPendientes();
    actualizarContadorBorradores();
    poblarSelectAnalisis();
  } catch (err) { console.error("Error API:", err); }
}

function renderHistorialInspector() {
  const user = (sessionStorage.getItem('usuario_calidad') || '').toLowerCase();
  const tbody = document.getElementById('tabla-historial-body');
  if (!tbody) return;
  const mis = historialCache.filter(i => (i.inspector || '').toLowerCase() === user || (i.inspectorLab || '').toLowerCase() === user);
  if (mis.length === 0) { tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;">No tienes registros finales aún.</td></tr>`; return; }
  tbody.innerHTML = mis.map(r => `<tr><td>${r.idInspeccion}</td><td>${r.correlativo}</td><td>${r.fechaHora}</td><td>${r.turno}</td><td>${r.maquina}</td><td>${r.producto}</td><td>${r.estado}</td><td>${r.inspector}</td><td>${r.inspectorLab || '-'}</td></tr>`).join('');
}

async function cerrarTurno() {
  const turno = obtenerTurnoAuto();
  let mensaje = `¿Cerrar ${turno} y generar PDFs?`;
  if (pendientesCache.length > 0) {
    mensaje = `⚠️ Quedan ${pendientesCache.length} ronda(s) sin cerrar en laboratorio.\n\n` + mensaje;
  }
  if (!confirm(mensaje)) return;
  await postAccion({ action: 'cerrarTurno', turnoActual: turno });
  alert("Cierre enviado a Drive.");
  resetFormularioCompleto();
  sessionStorage.removeItem('usuario_calidad');
  sessionStorage.removeItem('rol_calidad');
  checkSession();
}

async function generarConsolidado() {
  await postAccion({ action: 'generarConsolidado', turnoActual: obtenerTurnoAuto() });
  alert("Proceso enviado.");
}

function poblarSelectAnalisis() {
  const sel = document.getElementById('select-analisis-producto');
  if (!sel) return;
  const seleccionActual = sel.value;
  sel.innerHTML = '<option value="">-- Selecciona un producto --</option>' +
    productosCache.map(p => `<option value="${p.id}">${p.nombre}</option>`).join('');
  if (seleccionActual) sel.value = seleccionActual;
}

function renderAnalisis() {
  const sel = document.getElementById('select-analisis-producto');
  if (!sel || typeof Chart === 'undefined') return;

  if (!sel.value) {
    if (chartTendenciaInstance) { chartTendenciaInstance.destroy(); chartTendenciaInstance = null; }
    return;
  }

  const registros = historialCache
    .filter(r => r.producto === sel.value && r.estado === 'Cerrada')
    .slice(-10);

  const labels = registros.map(r => r.fechaHora);
  const pesos = registros.map(r => parseFloat(r.peso_med));
  const ciclos = registros.map(r => parseFloat(r.ciclo_med));

  const ctx = document.getElementById('chartTendencia').getContext('2d');
  if (chartTendenciaInstance) chartTendenciaInstance.destroy();
  chartTendenciaInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label: 'Peso (g)', data: pesos, borderColor: '#0284c7', backgroundColor: 'rgba(2,132,199,0.15)', yAxisID: 'y' },
        { label: 'Ciclo (s)', data: ciclos, borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.15)', yAxisID: 'y1' }
      ]
    },
    options: {
      responsive: true,
      scales: {
        y: { type: 'linear', position: 'left', title: { display: true, text: 'Peso (g)' } },
        y1: { type: 'linear', position: 'right', title: { display: true, text: 'Ciclo (s)' }, grid: { drawOnChartArea: false } }
      }
    }
  });
}

function startQRScanner() {
  document.getElementById('qr-modal').style.display = 'flex'; html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 220, height: 220 } }, (text) => {
    const m = maquinasCache.find(x => x.id === text || (x.nombre && x.nombre.toLowerCase().includes(text.toLowerCase())));
    document.getElementById('select-maquina').value = m ? m.id : text; document.getElementById('input-search-maquina').value = m ? `${m.nombre} (${m.id})` : text;
    stopQRScanner();
  }, () => {}).catch(err => console.log(err));
}
function stopQRScanner() { if (html5QrCode) html5QrCode.stop().then(() => document.getElementById('qr-modal').style.display='none').catch(()=>document.getElementById('qr-modal').style.display='none'); else document.getElementById('qr-modal').style.display='none'; }
