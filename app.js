if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.log('Error SW:', err));
}

// ⚠️ REEMPLAZA ESTA URL POR LA DE TU DESPLIEGUE EN GOOGLE APPS SCRIPT
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxsjzw8hWWDvn7DTJBfRRVyCFtXyB2iP__NmGodyAOj3EJvdNozTQ-vUZW79RuiWryQIQ/exec';

let productosCache = [];
let maquinasCache = [];
let historialCache = [];
let html5QrCode = null;

// Variable para saber si estamos editando un borrador
let currentDraftId = null; 

document.addEventListener('DOMContentLoaded', () => {
  checkSession();
  setupNavigation();
  setupEventListeners();
  setupToggles();
  actualizarTurnoAuto();
  setupCustomComboboxes();
  actualizarContadorBorradores();
});

// CÁLCULO DE HORA Y TURNO CON ZONA HORARIA AMERICA/SANTIAGO
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
  if (!usuario) {
    document.getElementById('login-modal').style.display = 'flex';
    document.getElementById('app-content').style.display = 'none';
  } else {
    document.getElementById('login-modal').style.display = 'none';
    document.getElementById('app-content').style.display = 'block';
    document.getElementById('user-display').innerText = `Inspector: ${usuario}`;
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
      if (tab.dataset.target === 'view-borradores') renderBorradores();
    });
  });
}

// --------------------------------------------------------
// LÓGICA DE BORRADORES (LOCAL STORAGE)
// --------------------------------------------------------

function recopilarDatosFormulario() {
  return {
    maquinaId: document.getElementById('select-maquina').value,
    maquinaSearch: document.getElementById('input-search-maquina').value,
    productoId: document.getElementById('select-producto').value,
    productoSearch: document.getElementById('input-search-producto').value,
    operario: document.getElementById('input-operario').value,
    lote_mp: document.getElementById('input-lote-mp').value,
    lote_bxa: document.getElementById('input-lote-bxa').value,
    observaciones: document.getElementById('input-observaciones').value,
    cavidad_molde: document.getElementById('input-cavidad').value,

    color_med: document.getElementById('med-color').value,
    color_val: document.getElementById('val-color').value,
    espesor_med: document.getElementById('med-espesor').value,
    espesor_val: document.getElementById('val-espesor').value,
    ciclo_med: document.getElementById('med-ciclo').value,
    ciclo_val: document.getElementById('val-ciclo').value,
    peso_med: document.getElementById('med-peso').value,
    peso_val: document.getElementById('val-peso').value,
    calce_med: document.getElementById('med-calce').value,
    calce_val: document.getElementById('val-calce').value,
    filtracion_med: document.getElementById('med-filtracion').value,
    filtracion_val: document.getElementById('val-filtracion').value,
    probador_med: document.getElementById('med-probador').value,
    probador_val: document.getElementById('val-probador').value,
    hcuello_med: document.getElementById('med-hcuello').value,
    hcuello_val: document.getElementById('val-hcuello').value,
    phi_int_med: document.getElementById('med-phi-int').value,
    phi_int_val: document.getElementById('val-phi-int').value,
    phi_hilo_med: document.getElementById('med-phi-hilo').value,
    phi_hilo_val: document.getElementById('val-phi-hilo').value,
    phi_trinquete_med: document.getElementById('med-phi-trinquete').value,
    phi_trinquete_val: document.getElementById('val-phi-trinquete').value,
    rebalse_med: document.getElementById('med-rebalse').value,
    rebalse_val: document.getElementById('val-rebalse').value,
    caida_med: document.getElementById('med-caida').value,
    caida_val: document.getElementById('val-caida').value
  };
}

function guardarComoBorrador() {
  const data = recopilarDatosFormulario();
  
  if (!data.maquinaId || !data.productoId) {
    alert("⚠️ Para guardar un borrador, al menos debes seleccionar una Máquina y un Producto.");
    return;
  }

  const inspectorActual = sessionStorage.getItem('usuario_calidad') || 'Desconocido';
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  
  const nuevoBorrador = {
    id: currentDraftId ? currentDraftId : Date.now().toString(),
    fechaStr: new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' }),
    inspector: inspectorActual,
    formData: data
  };

  // Si estábamos editando uno, lo reemplazamos. Si no, lo agregamos.
  if (currentDraftId) {
    const index = borradores.findIndex(b => b.id === currentDraftId);
    if (index !== -1) borradores[index] = nuevoBorrador;
  } else {
    borradores.push(nuevoBorrador);
  }

  localStorage.setItem('borradores_calidad', JSON.stringify(borradores));
  alert("📝 ¡Borrador guardado con éxito! Puedes continuarlo luego desde la pestaña 'Borradores'.");
  
  resetFormulario();
  actualizarContadorBorradores();
}

function renderBorradores() {
  const tbody = document.getElementById('tabla-borradores-body');
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  const inspectorActual = sessionStorage.getItem('usuario_calidad');
  
  // Filtrar solo los borradores del usuario actual
  borradores = borradores.filter(b => b.inspector === inspectorActual);
  
  if (borradores.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">No tienes borradores pendientes.</td></tr>`;
    return;
  }

  tbody.innerHTML = borradores.map(b => `
    <tr>
      <td>${b.fechaStr}</td>
      <td>${b.formData.maquinaSearch || b.formData.maquinaId}</td>
      <td>${b.formData.productoSearch || b.formData.productoId}</td>
      <td style="display: flex; gap: 5px;">
        <button onclick="cargarBorrador('${b.id}')" class="btn btn-primary" style="margin:0; padding: 6px;">Continuar</button>
        <button onclick="eliminarBorrador('${b.id}')" class="btn btn-danger" style="margin:0; padding: 6px;">🗑️</button>
      </td>
    </tr>
  `).join('');
}

window.cargarBorrador = function(id) {
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  const borrador = borradores.find(b => b.id === id);
  if (!borrador) return;

  const d = borrador.formData;
  
  // Restaurar valores visuales y ocultos
  document.getElementById('select-maquina').value = d.maquinaId;
  document.getElementById('input-search-maquina').value = d.maquinaSearch;
  document.getElementById('select-producto').value = d.productoId;
  document.getElementById('input-search-producto').value = d.productoSearch;
  document.getElementById('input-operario').value = d.operario;
  document.getElementById('input-lote-mp').value = d.lote_mp;
  document.getElementById('input-lote-bxa').value = d.lote_bxa;
  document.getElementById('input-observaciones').value = d.observaciones;
  document.getElementById('input-cavidad').value = d.cavidad_molde || 1;

  // Restaurar Banner de Producto si existe
  if(d.productoId) actualizarFichaProducto(d.productoId);

  // Restaurar Mediciones
  const medicionesIds = ['color', 'espesor', 'ciclo', 'peso', 'calce', 'filtracion', 'probador', 'hcuello', 'phi-int', 'phi-hilo', 'phi-trinquete', 'rebalse', 'caida'];
  
  medicionesIds.forEach(m => {
    document.getElementById(`med-${m}`).value = d[`${m.replace('-','')}_med`] || '';
    const valState = d[`${m.replace('-','')}_val`] || 'Cumple';
    document.getElementById(`val-${m}`).value = valState;
    
    // Restaurar los colores de los botones Cumple/No Cumple
    const btn = document.querySelector(`.btn-toggle[data-target="val-${m}"]`);
    if (btn) {
      if (valState === 'Cumple') {
        btn.className = 'btn-toggle active-cumple';
        btn.innerText = 'Cumple';
      } else {
        btn.className = 'btn-toggle active-nocumple';
        btn.innerText = 'No Cumple';
      }
    }
  });

  currentDraftId = id; // Fijamos que estamos editando
  
  // Cambiar a la vista principal
  document.querySelector('.nav-tab[data-target="view-nueva"]').click();
  alert("Datos cargados. Complete las mediciones faltantes y guarde el registro final.");
};

window.eliminarBorrador = function(id) {
  if(!confirm("¿Seguro que deseas descartar este borrador permanentemente?")) return;
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  borradores = borradores.filter(b => b.id !== id);
  localStorage.setItem('borradores_calidad', JSON.stringify(borradores));
  renderBorradores();
  actualizarContadorBorradores();
};

function actualizarContadorBorradores() {
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  const inspectorActual = sessionStorage.getItem('usuario_calidad');
  const misBorradores = borradores.filter(b => b.inspector === inspectorActual).length;
  const contador = document.getElementById('contador-borradores');
  if (contador) contador.innerText = misBorradores;
}

// --------------------------------------------------------
// LÓGICA DE CATÁLOGOS Y COMBOBOXES
// --------------------------------------------------------

function setupCustomComboboxes() {
  const inputs = [
    { in: 'input-search-maquina', drop: 'dropdown-maquina', dataObj: () => maquinasCache, type: 'maquina' },
    { in: 'input-search-producto', drop: 'dropdown-producto', dataObj: () => productosCache, type: 'producto' }
  ];

  inputs.forEach(el => {
    const inputEl = document.getElementById(el.in);
    const dropEl = document.getElementById(el.drop);
    
    const abrirMenu = (e) => {
      if(e) e.stopPropagation();
      renderComboboxOptions(inputEl, dropEl, el.dataObj(), el.type);
    };
    
    inputEl.addEventListener('focus', abrirMenu);
    inputEl.addEventListener('click', abrirMenu);
    inputEl.addEventListener('input', abrirMenu);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.form-group')) {
      document.getElementById('dropdown-maquina').style.display = 'none';
      document.getElementById('dropdown-producto').style.display = 'none';
    }
  });
}

function renderComboboxOptions(inputEl, dropEl, data, tipo) {
  const filter = inputEl.value.toLowerCase().trim();
  dropEl.innerHTML = '';
  
  const matches = data.filter(item => (item.id || '').toLowerCase().includes(filter) || (item.nombre || '').toLowerCase().includes(filter));

  if (matches.length === 0) {
    dropEl.innerHTML = `<div class="combobox-item" style="color:#94a3b8;">Sin coincidencias</div>`;
  } else {
    matches.forEach(item => {
      const div = document.createElement('div');
      div.className = 'combobox-item';
      const labelText = (item.nombre && item.nombre !== item.id) ? `${item.nombre} (${item.id})` : item.id;
      div.innerText = labelText;
      
      div.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        inputEl.value = labelText;
        document.getElementById(`select-${tipo}`).value = item.id;
        inputEl.classList.remove('input-error');
        dropEl.style.display = 'none';
        if (tipo === 'producto') actualizarFichaProducto(item.id);
      });
      dropEl.appendChild(div);
    });
  }
  dropEl.style.display = 'block';
}

function actualizarFichaProducto(prodId) {
  const selected = productosCache.find(p => p.id === prodId);
  const banner = document.getElementById('specs-banner');
  if (selected) {
    document.getElementById('spec-color').innerText = selected.color || '-';
    document.getElementById('spec-peso').innerText = selected.peso || '-';
    document.getElementById('spec-ciclo').innerText = selected.ciclo || '-';
    document.getElementById('spec-diametros').innerText = `${selected.diametroHilo || '-'} / ${selected.diametroInterior || '-'}`;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

// --------------------------------------------------------
// EVENTOS PRINCIPALES Y GUARDADO FINAL
// --------------------------------------------------------

function setupEventListeners() {
  document.getElementById('btn-login').addEventListener('click', () => {
    const userSelect = document.getElementById('login-inspector').value;
    const pin = document.getElementById('login-pin').value;
    if (!userSelect) {
      document.getElementById('login-error').innerText = '⚠️ Debes seleccionar un inspector.';
      document.getElementById('login-error').style.display = 'block';
      return;
    }
    if (pin === '1234' || pin === '0000') {
      sessionStorage.setItem('usuario_calidad', userSelect.trim());
      document.getElementById('login-error').style.display = 'none';
      checkSession();
      actualizarContadorBorradores();
    } else {
      document.getElementById('login-error').innerText = '⚠️ PIN incorrecto.';
      document.getElementById('login-error').style.display = 'block';
    }
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    sessionStorage.removeItem('usuario_calidad');
    checkSession();
  });

  // BOTÓN: GUARDAR COMO BORRADOR
  document.getElementById('btn-guardar-borrador').addEventListener('click', guardarComoBorrador);

  // BOTÓN: GUARDAR REGISTRO FINAL OBLIGATORIO
  document.getElementById('btn-guardar-registro').addEventListener('click', async () => {
    const dataForm = recopilarDatosFormulario();

    if (!dataForm.maquinaId || !dataForm.productoId) {
      alert("⚠️ Faltan datos clave de Máquina o Producto.");
      return;
    }

    const medicionesDef = [
      { id: 'med-color', nombre: 'Color y Apariencia' }, { id: 'med-espesor', nombre: 'Espesor de Pared' },
      { id: 'med-ciclo', nombre: 'Ciclo de Soplado' }, { id: 'med-peso', nombre: 'Peso del Producto' },
      { id: 'med-calce', nombre: 'Calce Tapa' }, { id: 'med-filtracion', nombre: 'Hermeticidad' },
      { id: 'med-probador', nombre: 'Probador' }, { id: 'med-hcuello', nombre: 'H Cuello' },
      { id: 'med-phi-int', nombre: 'Φ Int. Gollete' }, { id: 'med-phi-hilo', nombre: 'Φ Hilo' },
      { id: 'med-phi-trinquete', nombre: 'Φ Trinquete' }, { id: 'med-rebalse', nombre: 'Rebalse' },
      { id: 'med-caida', nombre: 'Caída Libre' }
    ];

    let faltantes = [];
    medicionesDef.forEach(m => {
      const el = document.getElementById(m.id);
      if (!el.value.trim()) {
        el.classList.add('input-error');
        faltantes.push(m.nombre);
      } else {
        el.classList.remove('input-error');
      }
    });

    if (faltantes.length > 0) {
      alert("⚠️ NO SE PUEDE GUARDAR EL REGISTRO FINAL. Faltan completar:\n\n• " + faltantes.join("\n• "));
      return;
    }

    const btnGuardar = document.getElementById('btn-guardar-registro');
    btnGuardar.disabled = true;
    btnGuardar.innerText = "Enviando a Drive...";

    const exito = await enviarAGoogleSheets(dataForm);

    if (exito) {
      alert("¡Registro FINAL guardado exitosamente!");
      
      // Si el registro provenía de un borrador, lo eliminamos.
      if (currentDraftId) {
        let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
        borradores = borradores.filter(b => b.id !== currentDraftId);
        localStorage.setItem('borradores_calidad', JSON.stringify(borradores));
      }

      resetFormulario();
      actualizarContadorBorradores();
      await loadCatalogData();
    }

    btnGuardar.disabled = false;
    btnGuardar.innerText = "✅ GUARDAR REGISTRO FINAL";
  });

  // RESTO DE BOTONES
  document.getElementById('btn-cerrar-turno').addEventListener('click', cerrarTurno);
  if(document.getElementById('btn-generar-pdf-ahora')) document.getElementById('btn-generar-pdf-ahora').addEventListener('click', generarConsolidado);
  document.getElementById('btn-qr').addEventListener('click', startQRScanner);
  document.getElementById('btn-close-qr').addEventListener('click', stopQRScanner);
  document.getElementById('btn-refresh-historial').addEventListener('click', loadCatalogData);
}

function setupToggles() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-toggle');
    if (!btn) return;
    e.preventDefault();
    const targetInput = document.getElementById(btn.dataset.target);
    if (btn.classList.contains('active-cumple')) {
      btn.classList.replace('active-cumple', 'active-nocumple');
      btn.innerText = 'No Cumple';
      if (targetInput) targetInput.value = 'No Cumple';
    } else {
      btn.classList.replace('active-nocumple', 'active-cumple');
      btn.innerText = 'Cumple';
      if (targetInput) targetInput.value = 'Cumple';
    }
  });
}

async function enviarAGoogleSheets(dataForm) {
  const inspectorActual = sessionStorage.getItem('usuario_calidad');
  const payload = {
    turno: obtenerTurnoAuto(),
    inspector_calidad: inspectorActual,
    id_maquina: dataForm.maquinaId,
    id_producto: dataForm.productoId,
    operario: dataForm.operario,
    lote_mp: dataForm.lote_mp,
    lote_bxa: dataForm.lote_bxa,
    observaciones: dataForm.observaciones,
    cavidad_molde: dataForm.cavidad_molde,
    color_med: dataForm.color_med, color_val: dataForm.color_val,
    espesor_med: dataForm.espesor_med, espesor_val: dataForm.espesor_val,
    ciclo_med: dataForm.ciclo_med, ciclo_val: dataForm.ciclo_val,
    peso_med: dataForm.peso_med, peso_val: dataForm.peso_val,
    calce_med: dataForm.calce_med, calce_val: dataForm.calce_val,
    filtracion_med: dataForm.filtracion_med, filtracion_val: dataForm.filtracion_val,
    probador_med: dataForm.probador_med, probador_val: dataForm.probador_val,
    hcuello_med: dataForm.hcuello_med, hcuello_val: dataForm.hcuello_val,
    phi_int_med: dataForm.phi_int_med, phi_int_val: dataForm.phi_int_val,
    phi_hilo_med: dataForm.phi_hilo_med, phi_hilo_val: dataForm.phi_hilo_val,
    phi_trinquete_med: dataForm.phi_trinquete_med, phi_trinquete_val: dataForm.phi_trinquete_val,
    rebalse_med: dataForm.rebalse_med, rebalse_val: dataForm.rebalse_val,
    caida_med: dataForm.caida_med, caida_val: dataForm.caida_val
  };

  try {
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    return true;
  } catch (err) {
    alert("Error de conexión al guardar en la nube.");
    return false;
  }
}

function resetFormulario() {
  currentDraftId = null; // Reiniciamos el identificador
  
  document.querySelectorAll('input:not([type="hidden"]):not(#input-cavidad):not(#input-turno), textarea').forEach(el => {
    el.value = ''; el.classList.remove('input-error');
  });
  
  document.getElementById('select-maquina').value = '';
  document.getElementById('select-producto').value = '';
  document.getElementById('specs-banner').style.display = 'none';
  
  document.querySelectorAll('.btn-toggle').forEach(btn => {
    btn.innerText = 'Cumple';
    btn.className = 'btn-toggle active-cumple';
    const targetHidden = document.getElementById(btn.dataset.target);
    if (targetHidden) targetHidden.value = 'Cumple';
  });
  actualizarTurnoAuto();
}

// --------------------------------------------------------
// DATOS EXTERNOS Y CIERRE DE TURNO
// --------------------------------------------------------

async function loadCatalogData() {
  try {
    const response = await fetch(GOOGLE_SCRIPT_URL);
    const data = await response.json();
    maquinasCache = data.maquinas || [];
    productosCache = data.productos || [];
    historialCache = data.historial || [];
    renderHistorialInspector();
  } catch (err) { console.error("Error al obtener datos:", err); }
}

function renderHistorialInspector() {
  const usuarioActual = (sessionStorage.getItem('usuario_calidad') || '').trim().toLowerCase();
  const tbody = document.getElementById('tabla-historial-body');
  if (!tbody) return;

  const misRegistros = historialCache.filter(item => (item.inspector || '').trim().toLowerCase() === usuarioActual);
  if (misRegistros.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;">No tienes registros guardados finales aún.</td></tr>`;
    return;
  }

  tbody.innerHTML = misRegistros.map(reg => `
    <tr><td><strong>${reg.idInspeccion}</strong></td><td>${reg.correlativo}</td><td>${reg.fechaHora}</td><td>${reg.turno}</td><td>${reg.maquina}</td><td>${reg.operario || '-'}</td><td>${reg.producto}</td><td>${reg.observaciones || '-'}</td></tr>
  `).join('');
}

async function cerrarTurno() {
  const turno = obtenerTurnoAuto();
  if (!confirm(`¿Deseas cerrar el ${turno}, generar los reportes PDF y finalizar tu sesión?`)) return;
  
  const btn = document.getElementById('btn-cerrar-turno');
  btn.disabled = true; btn.innerText = "Procesando...";
  try {
    await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'cerrarTurno', turnoActual: turno }) });
    alert("✅ Proceso de Cierre de Turno enviado a Drive.");
  } catch (err) { alert("✅ Turno enviado."); }

  resetFormulario();
  sessionStorage.removeItem('usuario_calidad');
  checkSession();
  btn.disabled = false; btn.innerText = "Cerrar Turno";
}

async function generarConsolidado() {
  const btn = document.getElementById('btn-generar-pdf-ahora');
  btn.disabled = true; btn.innerText = "Generando PDF...";
  try {
    await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'generarConsolidado', turnoActual: obtenerTurnoAuto() }) });
    alert("Proceso enviado a Google Drive.");
  } catch (err) { alert("Enviado."); }
  btn.disabled = false; btn.innerText = "📄 Forzar PDF Consolidado Ahora";
}

// --------------------------------------------------------
// LÓGICA DEL ESCÁNER QR
// --------------------------------------------------------
function startQRScanner() {
  document.getElementById('qr-modal').style.display = 'flex';
  html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start(
    { facingMode: "environment" }, { fps: 10, qrbox: { width: 220, height: 220 } },
    (decodedText) => {
      const match = maquinasCache.find(m => m.id === decodedText || (m.nombre && m.nombre.toLowerCase().includes(decodedText.toLowerCase())));
      if (match) {
        document.getElementById('select-maquina').value = match.id;
        document.getElementById('input-search-maquina').value = match.nombre ? `${match.nombre} (${match.id})` : match.id;
      } else {
        document.getElementById('select-maquina').value = decodedText;
        document.getElementById('input-search-maquina').value = decodedText;
      }
      document.getElementById('input-search-maquina').classList.remove('input-error');
      stopQRScanner();
    }, () => {}
  ).catch(err => console.log("Error QR:", err));
}

function stopQRScanner() {
  if (html5QrCode) {
    html5QrCode.stop().then(() => document.getElementById('qr-modal').style.display = 'none').catch(() => document.getElementById('qr-modal').style.display = 'none');
  } else { document.getElementById('qr-modal').style.display = 'none'; }
}if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.log('Error SW:', err));
}

// ⚠️ REEMPLAZA ESTA URL POR LA DE TU DESPLIEGUE EN GOOGLE APPS SCRIPT
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/TU_SCRIPT_ID_AQUI/exec';

let productosCache = [];
let maquinasCache = [];
let historialCache = [];
let html5QrCode = null;

// Variable para saber si estamos editando un borrador
let currentDraftId = null; 

document.addEventListener('DOMContentLoaded', () => {
  checkSession();
  setupNavigation();
  setupEventListeners();
  setupToggles();
  actualizarTurnoAuto();
  setupCustomComboboxes();
  actualizarContadorBorradores();
});

// CÁLCULO DE HORA Y TURNO CON ZONA HORARIA AMERICA/SANTIAGO
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
  if (!usuario) {
    document.getElementById('login-modal').style.display = 'flex';
    document.getElementById('app-content').style.display = 'none';
  } else {
    document.getElementById('login-modal').style.display = 'none';
    document.getElementById('app-content').style.display = 'block';
    document.getElementById('user-display').innerText = `Inspector: ${usuario}`;
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
      if (tab.dataset.target === 'view-borradores') renderBorradores();
    });
  });
}

// --------------------------------------------------------
// LÓGICA DE BORRADORES (LOCAL STORAGE)
// --------------------------------------------------------

function recopilarDatosFormulario() {
  return {
    maquinaId: document.getElementById('select-maquina').value,
    maquinaSearch: document.getElementById('input-search-maquina').value,
    productoId: document.getElementById('select-producto').value,
    productoSearch: document.getElementById('input-search-producto').value,
    operario: document.getElementById('input-operario').value,
    lote_mp: document.getElementById('input-lote-mp').value,
    lote_bxa: document.getElementById('input-lote-bxa').value,
    observaciones: document.getElementById('input-observaciones').value,
    cavidad_molde: document.getElementById('input-cavidad').value,

    color_med: document.getElementById('med-color').value,
    color_val: document.getElementById('val-color').value,
    espesor_med: document.getElementById('med-espesor').value,
    espesor_val: document.getElementById('val-espesor').value,
    ciclo_med: document.getElementById('med-ciclo').value,
    ciclo_val: document.getElementById('val-ciclo').value,
    peso_med: document.getElementById('med-peso').value,
    peso_val: document.getElementById('val-peso').value,
    calce_med: document.getElementById('med-calce').value,
    calce_val: document.getElementById('val-calce').value,
    filtracion_med: document.getElementById('med-filtracion').value,
    filtracion_val: document.getElementById('val-filtracion').value,
    probador_med: document.getElementById('med-probador').value,
    probador_val: document.getElementById('val-probador').value,
    hcuello_med: document.getElementById('med-hcuello').value,
    hcuello_val: document.getElementById('val-hcuello').value,
    phi_int_med: document.getElementById('med-phi-int').value,
    phi_int_val: document.getElementById('val-phi-int').value,
    phi_hilo_med: document.getElementById('med-phi-hilo').value,
    phi_hilo_val: document.getElementById('val-phi-hilo').value,
    phi_trinquete_med: document.getElementById('med-phi-trinquete').value,
    phi_trinquete_val: document.getElementById('val-phi-trinquete').value,
    rebalse_med: document.getElementById('med-rebalse').value,
    rebalse_val: document.getElementById('val-rebalse').value,
    caida_med: document.getElementById('med-caida').value,
    caida_val: document.getElementById('val-caida').value
  };
}

function guardarComoBorrador() {
  const data = recopilarDatosFormulario();
  
  if (!data.maquinaId || !data.productoId) {
    alert("⚠️ Para guardar un borrador, al menos debes seleccionar una Máquina y un Producto.");
    return;
  }

  const inspectorActual = sessionStorage.getItem('usuario_calidad') || 'Desconocido';
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  
  const nuevoBorrador = {
    id: currentDraftId ? currentDraftId : Date.now().toString(),
    fechaStr: new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' }),
    inspector: inspectorActual,
    formData: data
  };

  // Si estábamos editando uno, lo reemplazamos. Si no, lo agregamos.
  if (currentDraftId) {
    const index = borradores.findIndex(b => b.id === currentDraftId);
    if (index !== -1) borradores[index] = nuevoBorrador;
  } else {
    borradores.push(nuevoBorrador);
  }

  localStorage.setItem('borradores_calidad', JSON.stringify(borradores));
  alert("📝 ¡Borrador guardado con éxito! Puedes continuarlo luego desde la pestaña 'Borradores'.");
  
  resetFormulario();
  actualizarContadorBorradores();
}

function renderBorradores() {
  const tbody = document.getElementById('tabla-borradores-body');
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  const inspectorActual = sessionStorage.getItem('usuario_calidad');
  
  // Filtrar solo los borradores del usuario actual
  borradores = borradores.filter(b => b.inspector === inspectorActual);
  
  if (borradores.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">No tienes borradores pendientes.</td></tr>`;
    return;
  }

  tbody.innerHTML = borradores.map(b => `
    <tr>
      <td>${b.fechaStr}</td>
      <td>${b.formData.maquinaSearch || b.formData.maquinaId}</td>
      <td>${b.formData.productoSearch || b.formData.productoId}</td>
      <td style="display: flex; gap: 5px;">
        <button onclick="cargarBorrador('${b.id}')" class="btn btn-primary" style="margin:0; padding: 6px;">Continuar</button>
        <button onclick="eliminarBorrador('${b.id}')" class="btn btn-danger" style="margin:0; padding: 6px;">🗑️</button>
      </td>
    </tr>
  `).join('');
}

window.cargarBorrador = function(id) {
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  const borrador = borradores.find(b => b.id === id);
  if (!borrador) return;

  const d = borrador.formData;
  
  // Restaurar valores visuales y ocultos
  document.getElementById('select-maquina').value = d.maquinaId;
  document.getElementById('input-search-maquina').value = d.maquinaSearch;
  document.getElementById('select-producto').value = d.productoId;
  document.getElementById('input-search-producto').value = d.productoSearch;
  document.getElementById('input-operario').value = d.operario;
  document.getElementById('input-lote-mp').value = d.lote_mp;
  document.getElementById('input-lote-bxa').value = d.lote_bxa;
  document.getElementById('input-observaciones').value = d.observaciones;
  document.getElementById('input-cavidad').value = d.cavidad_molde || 1;

  // Restaurar Banner de Producto si existe
  if(d.productoId) actualizarFichaProducto(d.productoId);

  // Restaurar Mediciones
  const medicionesIds = ['color', 'espesor', 'ciclo', 'peso', 'calce', 'filtracion', 'probador', 'hcuello', 'phi-int', 'phi-hilo', 'phi-trinquete', 'rebalse', 'caida'];
  
  medicionesIds.forEach(m => {
    document.getElementById(`med-${m}`).value = d[`${m.replace('-','')}_med`] || '';
    const valState = d[`${m.replace('-','')}_val`] || 'Cumple';
    document.getElementById(`val-${m}`).value = valState;
    
    // Restaurar los colores de los botones Cumple/No Cumple
    const btn = document.querySelector(`.btn-toggle[data-target="val-${m}"]`);
    if (btn) {
      if (valState === 'Cumple') {
        btn.className = 'btn-toggle active-cumple';
        btn.innerText = 'Cumple';
      } else {
        btn.className = 'btn-toggle active-nocumple';
        btn.innerText = 'No Cumple';
      }
    }
  });

  currentDraftId = id; // Fijamos que estamos editando
  
  // Cambiar a la vista principal
  document.querySelector('.nav-tab[data-target="view-nueva"]').click();
  alert("Datos cargados. Complete las mediciones faltantes y guarde el registro final.");
};

window.eliminarBorrador = function(id) {
  if(!confirm("¿Seguro que deseas descartar este borrador permanentemente?")) return;
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  borradores = borradores.filter(b => b.id !== id);
  localStorage.setItem('borradores_calidad', JSON.stringify(borradores));
  renderBorradores();
  actualizarContadorBorradores();
};

function actualizarContadorBorradores() {
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  const inspectorActual = sessionStorage.getItem('usuario_calidad');
  const misBorradores = borradores.filter(b => b.inspector === inspectorActual).length;
  const contador = document.getElementById('contador-borradores');
  if (contador) contador.innerText = misBorradores;
}

// --------------------------------------------------------
// LÓGICA DE CATÁLOGOS Y COMBOBOXES
// --------------------------------------------------------

function setupCustomComboboxes() {
  const inputs = [
    { in: 'input-search-maquina', drop: 'dropdown-maquina', dataObj: () => maquinasCache, type: 'maquina' },
    { in: 'input-search-producto', drop: 'dropdown-producto', dataObj: () => productosCache, type: 'producto' }
  ];

  inputs.forEach(el => {
    const inputEl = document.getElementById(el.in);
    const dropEl = document.getElementById(el.drop);
    
    const abrirMenu = (e) => {
      if(e) e.stopPropagation();
      renderComboboxOptions(inputEl, dropEl, el.dataObj(), el.type);
    };
    
    inputEl.addEventListener('focus', abrirMenu);
    inputEl.addEventListener('click', abrirMenu);
    inputEl.addEventListener('input', abrirMenu);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.form-group')) {
      document.getElementById('dropdown-maquina').style.display = 'none';
      document.getElementById('dropdown-producto').style.display = 'none';
    }
  });
}

function renderComboboxOptions(inputEl, dropEl, data, tipo) {
  const filter = inputEl.value.toLowerCase().trim();
  dropEl.innerHTML = '';
  
  const matches = data.filter(item => (item.id || '').toLowerCase().includes(filter) || (item.nombre || '').toLowerCase().includes(filter));

  if (matches.length === 0) {
    dropEl.innerHTML = `<div class="combobox-item" style="color:#94a3b8;">Sin coincidencias</div>`;
  } else {
    matches.forEach(item => {
      const div = document.createElement('div');
      div.className = 'combobox-item';
      const labelText = (item.nombre && item.nombre !== item.id) ? `${item.nombre} (${item.id})` : item.id;
      div.innerText = labelText;
      
      div.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        inputEl.value = labelText;
        document.getElementById(`select-${tipo}`).value = item.id;
        inputEl.classList.remove('input-error');
        dropEl.style.display = 'none';
        if (tipo === 'producto') actualizarFichaProducto(item.id);
      });
      dropEl.appendChild(div);
    });
  }
  dropEl.style.display = 'block';
}

function actualizarFichaProducto(prodId) {
  const selected = productosCache.find(p => p.id === prodId);
  const banner = document.getElementById('specs-banner');
  if (selected) {
    document.getElementById('spec-color').innerText = selected.color || '-';
    document.getElementById('spec-peso').innerText = selected.peso || '-';
    document.getElementById('spec-ciclo').innerText = selected.ciclo || '-';
    document.getElementById('spec-diametros').innerText = `${selected.diametroHilo || '-'} / ${selected.diametroInterior || '-'}`;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

// --------------------------------------------------------
// EVENTOS PRINCIPALES Y GUARDADO FINAL
// --------------------------------------------------------

function setupEventListeners() {
  document.getElementById('btn-login').addEventListener('click', () => {
    const userSelect = document.getElementById('login-inspector').value;
    const pin = document.getElementById('login-pin').value;
    if (!userSelect) {
      document.getElementById('login-error').innerText = '⚠️ Debes seleccionar un inspector.';
      document.getElementById('login-error').style.display = 'block';
      return;
    }
    if (pin === '1234' || pin === '0000') {
      sessionStorage.setItem('usuario_calidad', userSelect.trim());
      document.getElementById('login-error').style.display = 'none';
      checkSession();
      actualizarContadorBorradores();
    } else {
      document.getElementById('login-error').innerText = '⚠️ PIN incorrecto.';
      document.getElementById('login-error').style.display = 'block';
    }
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    sessionStorage.removeItem('usuario_calidad');
    checkSession();
  });

  // BOTÓN: GUARDAR COMO BORRADOR
  document.getElementById('btn-guardar-borrador').addEventListener('click', guardarComoBorrador);

  // BOTÓN: GUARDAR REGISTRO FINAL OBLIGATORIO
  document.getElementById('btn-guardar-registro').addEventListener('click', async () => {
    const dataForm = recopilarDatosFormulario();

    if (!dataForm.maquinaId || !dataForm.productoId) {
      alert("⚠️ Faltan datos clave de Máquina o Producto.");
      return;
    }

    const medicionesDef = [
      { id: 'med-color', nombre: 'Color y Apariencia' }, { id: 'med-espesor', nombre: 'Espesor de Pared' },
      { id: 'med-ciclo', nombre: 'Ciclo de Soplado' }, { id: 'med-peso', nombre: 'Peso del Producto' },
      { id: 'med-calce', nombre: 'Calce Tapa' }, { id: 'med-filtracion', nombre: 'Hermeticidad' },
      { id: 'med-probador', nombre: 'Probador' }, { id: 'med-hcuello', nombre: 'H Cuello' },
      { id: 'med-phi-int', nombre: 'Φ Int. Gollete' }, { id: 'med-phi-hilo', nombre: 'Φ Hilo' },
      { id: 'med-phi-trinquete', nombre: 'Φ Trinquete' }, { id: 'med-rebalse', nombre: 'Rebalse' },
      { id: 'med-caida', nombre: 'Caída Libre' }
    ];

    let faltantes = [];
    medicionesDef.forEach(m => {
      const el = document.getElementById(m.id);
      if (!el.value.trim()) {
        el.classList.add('input-error');
        faltantes.push(m.nombre);
      } else {
        el.classList.remove('input-error');
      }
    });

    if (faltantes.length > 0) {
      alert("⚠️ NO SE PUEDE GUARDAR EL REGISTRO FINAL. Faltan completar:\n\n• " + faltantes.join("\n• "));
      return;
    }

    const btnGuardar = document.getElementById('btn-guardar-registro');
    btnGuardar.disabled = true;
    btnGuardar.innerText = "Enviando a Drive...";

    const exito = await enviarAGoogleSheets(dataForm);

    if (exito) {
      alert("¡Registro FINAL guardado exitosamente!");
      
      // Si el registro provenía de un borrador, lo eliminamos.
      if (currentDraftId) {
        let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
        borradores = borradores.filter(b => b.id !== currentDraftId);
        localStorage.setItem('borradores_calidad', JSON.stringify(borradores));
      }

      resetFormulario();
      actualizarContadorBorradores();
      await loadCatalogData();
    }

    btnGuardar.disabled = false;
    btnGuardar.innerText = "✅ GUARDAR REGISTRO FINAL";
  });

  // RESTO DE BOTONES
  document.getElementById('btn-cerrar-turno').addEventListener('click', cerrarTurno);
  if(document.getElementById('btn-generar-pdf-ahora')) document.getElementById('btn-generar-pdf-ahora').addEventListener('click', generarConsolidado);
  document.getElementById('btn-qr').addEventListener('click', startQRScanner);
  document.getElementById('btn-close-qr').addEventListener('click', stopQRScanner);
  document.getElementById('btn-refresh-historial').addEventListener('click', loadCatalogData);
}

function setupToggles() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-toggle');
    if (!btn) return;
    e.preventDefault();
    const targetInput = document.getElementById(btn.dataset.target);
    if (btn.classList.contains('active-cumple')) {
      btn.classList.replace('active-cumple', 'active-nocumple');
      btn.innerText = 'No Cumple';
      if (targetInput) targetInput.value = 'No Cumple';
    } else {
      btn.classList.replace('active-nocumple', 'active-cumple');
      btn.innerText = 'Cumple';
      if (targetInput) targetInput.value = 'Cumple';
    }
  });
}

async function enviarAGoogleSheets(dataForm) {
  const inspectorActual = sessionStorage.getItem('usuario_calidad');
  const payload = {
    turno: obtenerTurnoAuto(),
    inspector_calidad: inspectorActual,
    id_maquina: dataForm.maquinaId,
    id_producto: dataForm.productoId,
    operario: dataForm.operario,
    lote_mp: dataForm.lote_mp,
    lote_bxa: dataForm.lote_bxa,
    observaciones: dataForm.observaciones,
    cavidad_molde: dataForm.cavidad_molde,
    color_med: dataForm.color_med, color_val: dataForm.color_val,
    espesor_med: dataForm.espesor_med, espesor_val: dataForm.espesor_val,
    ciclo_med: dataForm.ciclo_med, ciclo_val: dataForm.ciclo_val,
    peso_med: dataForm.peso_med, peso_val: dataForm.peso_val,
    calce_med: dataForm.calce_med, calce_val: dataForm.calce_val,
    filtracion_med: dataForm.filtracion_med, filtracion_val: dataForm.filtracion_val,
    probador_med: dataForm.probador_med, probador_val: dataForm.probador_val,
    hcuello_med: dataForm.hcuello_med, hcuello_val: dataForm.hcuello_val,
    phi_int_med: dataForm.phi_int_med, phi_int_val: dataForm.phi_int_val,
    phi_hilo_med: dataForm.phi_hilo_med, phi_hilo_val: dataForm.phi_hilo_val,
    phi_trinquete_med: dataForm.phi_trinquete_med, phi_trinquete_val: dataForm.phi_trinquete_val,
    rebalse_med: dataForm.rebalse_med, rebalse_val: dataForm.rebalse_val,
    caida_med: dataForm.caida_med, caida_val: dataForm.caida_val
  };

  try {
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    return true;
  } catch (err) {
    alert("Error de conexión al guardar en la nube.");
    return false;
  }
}

function resetFormulario() {
  currentDraftId = null; // Reiniciamos el identificador
  
  document.querySelectorAll('input:not([type="hidden"]):not(#input-cavidad):not(#input-turno), textarea').forEach(el => {
    el.value = ''; el.classList.remove('input-error');
  });
  
  document.getElementById('select-maquina').value = '';
  document.getElementById('select-producto').value = '';
  document.getElementById('specs-banner').style.display = 'none';
  
  document.querySelectorAll('.btn-toggle').forEach(btn => {
    btn.innerText = 'Cumple';
    btn.className = 'btn-toggle active-cumple';
    const targetHidden = document.getElementById(btn.dataset.target);
    if (targetHidden) targetHidden.value = 'Cumple';
  });
  actualizarTurnoAuto();
}

// --------------------------------------------------------
// DATOS EXTERNOS Y CIERRE DE TURNO
// --------------------------------------------------------

async function loadCatalogData() {
  try {
    const response = await fetch(GOOGLE_SCRIPT_URL);
    const data = await response.json();
    maquinasCache = data.maquinas || [];
    productosCache = data.productos || [];
    historialCache = data.historial || [];
    renderHistorialInspector();
  } catch (err) { console.error("Error al obtener datos:", err); }
}

function renderHistorialInspector() {
  const usuarioActual = (sessionStorage.getItem('usuario_calidad') || '').trim().toLowerCase();
  const tbody = document.getElementById('tabla-historial-body');
  if (!tbody) return;

  const misRegistros = historialCache.filter(item => (item.inspector || '').trim().toLowerCase() === usuarioActual);
  if (misRegistros.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;">No tienes registros guardados finales aún.</td></tr>`;
    return;
  }

  tbody.innerHTML = misRegistros.map(reg => `
    <tr><td><strong>${reg.idInspeccion}</strong></td><td>${reg.correlativo}</td><td>${reg.fechaHora}</td><td>${reg.turno}</td><td>${reg.maquina}</td><td>${reg.operario || '-'}</td><td>${reg.producto}</td><td>${reg.observaciones || '-'}</td></tr>
  `).join('');
}

async function cerrarTurno() {
  const turno = obtenerTurnoAuto();
  if (!confirm(`¿Deseas cerrar el ${turno}, generar los reportes PDF y finalizar tu sesión?`)) return;
  
  const btn = document.getElementById('btn-cerrar-turno');
  btn.disabled = true; btn.innerText = "Procesando...";
  try {
    await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'cerrarTurno', turnoActual: turno }) });
    alert("✅ Proceso de Cierre de Turno enviado a Drive.");
  } catch (err) { alert("✅ Turno enviado."); }

  resetFormulario();
  sessionStorage.removeItem('usuario_calidad');
  checkSession();
  btn.disabled = false; btn.innerText = "Cerrar Turno";
}

async function generarConsolidado() {
  const btn = document.getElementById('btn-generar-pdf-ahora');
  btn.disabled = true; btn.innerText = "Generando PDF...";
  try {
    await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'generarConsolidado', turnoActual: obtenerTurnoAuto() }) });
    alert("Proceso enviado a Google Drive.");
  } catch (err) { alert("Enviado."); }
  btn.disabled = false; btn.innerText = "📄 Forzar PDF Consolidado Ahora";
}

// --------------------------------------------------------
// LÓGICA DEL ESCÁNER QR
// --------------------------------------------------------
function startQRScanner() {
  document.getElementById('qr-modal').style.display = 'flex';
  html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start(
    { facingMode: "environment" }, { fps: 10, qrbox: { width: 220, height: 220 } },
    (decodedText) => {
      const match = maquinasCache.find(m => m.id === decodedText || (m.nombre && m.nombre.toLowerCase().includes(decodedText.toLowerCase())));
      if (match) {
        document.getElementById('select-maquina').value = match.id;
        document.getElementById('input-search-maquina').value = match.nombre ? `${match.nombre} (${match.id})` : match.id;
      } else {
        document.getElementById('select-maquina').value = decodedText;
        document.getElementById('input-search-maquina').value = decodedText;
      }
      document.getElementById('input-search-maquina').classList.remove('input-error');
      stopQRScanner();
    }, () => {}
  ).catch(err => console.log("Error QR:", err));
}

function stopQRScanner() {
  if (html5QrCode) {
    html5QrCode.stop().then(() => document.getElementById('qr-modal').style.display = 'none').catch(() => document.getElementById('qr-modal').style.display = 'none');
  } else { document.getElementById('qr-modal').style.display = 'none'; }
}
