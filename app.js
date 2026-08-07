if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.log('Error SW:', err));
}

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxsjzw8hWWDvn7DTJBfRRVyCFtXyB2iP__NmGodyAOj3EJvdNozTQ-vUZW79RuiWryQIQ/exec';

let productosCache = [];
let maquinasCache = [];
let historialCache = [];
let operariosCache = [];
let html5QrCode = null;
let currentDraftId = null; 
let chartInstance = null;

document.addEventListener('DOMContentLoaded', () => {
  checkSession();
  setupNavigation();
  setupEventListeners();
  setupToggles();
  actualizarTurnoAuto();
  setupCustomComboboxes();
  actualizarContadorBorradores();
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

function recopilarDatosFormulario() {
  return {
    maquinaId: document.getElementById('select-maquina').value,
    maquinaSearch: document.getElementById('input-search-maquina').value,
    productoId: document.getElementById('select-producto').value,
    productoSearch: document.getElementById('input-search-producto').value,
    operario: document.getElementById('input-search-operario').value,
    lote_mp: document.getElementById('input-lote-mp').value,
    lote_bxa: document.getElementById('input-lote-bxa').value,
    observaciones: document.getElementById('input-observaciones').value,
    cavidad_molde: document.getElementById('input-cavidad').value,
    color_med: document.getElementById('med-color').value, color_val: document.getElementById('val-color').value,
    espesor_med: document.getElementById('med-espesor').value, espesor_val: document.getElementById('val-espesor').value,
    ciclo_med: document.getElementById('med-ciclo').value, ciclo_val: document.getElementById('val-ciclo').value,
    peso_med: document.getElementById('med-peso').value, peso_val: document.getElementById('val-peso').value,
    calce_med: document.getElementById('med-calce').value, calce_val: document.getElementById('val-calce').value,
    filtracion_med: document.getElementById('med-filtracion').value, filtracion_val: document.getElementById('val-filtracion').value,
    probador_med: document.getElementById('med-probador').value, probador_val: document.getElementById('val-probador').value,
    hcuello_med: document.getElementById('med-hcuello').value, hcuello_val: document.getElementById('val-hcuello').value,
    phi_int_med: document.getElementById('med-phi-int').value, phi_int_val: document.getElementById('val-phi-int').value,
    phi_hilo_med: document.getElementById('med-phi-hilo').value, phi_hilo_val: document.getElementById('val-phi-hilo').value,
    phi_trinquete_med: document.getElementById('med-phi-trinquete').value, phi_trinquete_val: document.getElementById('val-phi-trinquete').value,
    rebalse_med: document.getElementById('med-rebalse').value, rebalse_val: document.getElementById('val-rebalse').value,
    caida_med: document.getElementById('med-caida').value, caida_val: document.getElementById('val-caida').value
  };
}

function guardarComoBorrador() {
  const data = recopilarDatosFormulario();
  if (!data.maquinaId || !data.productoId) { alert("⚠️ Selecciona al menos Máquina y Producto para guardar un borrador."); return; }

  const inspector = sessionStorage.getItem('usuario_calidad') || 'Desconocido';
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  
  const nuevoBorrador = {
    id: currentDraftId ? currentDraftId : Date.now().toString(),
    fechaStr: new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' }),
    inspector: inspector,
    formData: data
  };

  if (currentDraftId) {
    const index = borradores.findIndex(b => b.id === currentDraftId);
    if (index !== -1) borradores[index] = nuevoBorrador;
  } else { borradores.push(nuevoBorrador); }

  localStorage.setItem('borradores_calidad', JSON.stringify(borradores));
  alert("📝 Borrador guardado exitosamente en la tablet.");
  resetFormulario();
  actualizarContadorBorradores();
}

function renderBorradores() {
  const tbody = document.getElementById('tabla-borradores-body');
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  const inspector = sessionStorage.getItem('usuario_calidad');
  borradores = borradores.filter(b => b.inspector === inspector);
  
  if (borradores.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">No tienes borradores pendientes.</td></tr>`;
    return;
  }

  tbody.innerHTML = borradores.map(b => `
    <tr>
      <td>${b.fechaStr}</td><td>${b.formData.maquinaSearch || b.formData.maquinaId}</td><td>${b.formData.productoSearch || b.formData.productoId}</td>
      <td style="display:flex; gap:5px;"><button onclick="cargarBorrador('${b.id}')" class="btn btn-primary" style="height:35px; padding:0 10px;">Continuar</button><button onclick="eliminarBorrador('${b.id}')" class="btn btn-danger" style="height:35px; padding:0 10px;">🗑️</button></td>
    </tr>
  `).join('');
}

window.cargarBorrador = function(id) {
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  const borrador = borradores.find(b => b.id === id);
  if (!borrador) return;
  const d = borrador.formData;
  
  document.getElementById('select-maquina').value = d.maquinaId; document.getElementById('input-search-maquina').value = d.maquinaSearch;
  document.getElementById('select-producto').value = d.productoId; document.getElementById('input-search-producto').value = d.productoSearch;
  document.getElementById('input-search-operario').value = d.operario || '';
  document.getElementById('input-lote-mp').value = d.lote_mp;
  document.getElementById('input-lote-bxa').value = d.lote_bxa; document.getElementById('input-observaciones').value = d.observaciones;
  document.getElementById('input-cavidad').value = d.cavidad_molde || 1;

  if(d.productoId) actualizarFichaProducto(d.productoId);

  const medicionesIds = ['color', 'espesor', 'ciclo', 'peso', 'calce', 'filtracion', 'probador', 'hcuello', 'phi-int', 'phi-hilo', 'phi-trinquete', 'rebalse', 'caida'];
  medicionesIds.forEach(m => {
    document.getElementById(`med-${m}`).value = d[`${m.replace('-','')}_med`] || '';
    const valState = d[`${m.replace('-','')}_val`] || 'Cumple';
    document.getElementById(`val-${m}`).value = valState;
    const btn = document.querySelector(`.btn-toggle[data-target="val-${m}"]`);
    if (btn) {
      if (valState === 'Cumple') { btn.className = 'btn-toggle active-cumple'; btn.innerText = 'Cumple'; }
      else { btn.className = 'btn-toggle active-nocumple'; btn.innerText = 'No Cumple'; }
    }
  });

  currentDraftId = id; 
  document.querySelector('.nav-tab[data-target="view-nueva"]').click();
};

window.eliminarBorrador = function(id) {
  if(!confirm("¿Seguro que deseas descartar este borrador?")) return;
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  borradores = borradores.filter(b => b.id !== id);
  localStorage.setItem('borradores_calidad', JSON.stringify(borradores));
  renderBorradores(); actualizarContadorBorradores();
};

function actualizarContadorBorradores() {
  let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
  const inspector = sessionStorage.getItem('usuario_calidad');
  const misBorradores = borradores.filter(b => b.inspector === inspector).length;
  document.getElementById('contador-borradores').innerText = misBorradores;
}

// --- COMBOBOXES ROBUSTOS Y VISIBLES ---
function setupCustomComboboxes() {
  const inputs = [
    { in: 'input-search-maquina', drop: 'dropdown-maquina', dataObj: () => maquinasCache, type: 'maquina' },
    { in: 'input-search-producto', drop: 'dropdown-producto', dataObj: () => productosCache, type: 'producto' },
    { in: 'input-search-operario', drop: 'dropdown-operario', dataObj: () => operariosCache, type: 'operario' }
  ];

  inputs.forEach(el => {
    const inputEl = document.getElementById(el.in); 
    const dropEl = document.getElementById(el.drop);
    if (!inputEl || !dropEl) return;

    const abrirMenu = (e) => { 
      if(e) e.stopPropagation(); 
      // Cerrar otros dropdowns abiertos
      document.querySelectorAll('.combobox-dropdown').forEach(d => { if(d !== dropEl) d.style.display = 'none'; });
      renderComboboxOptions(inputEl, dropEl, el.dataObj(), el.type); 
    };

    inputEl.addEventListener('focus', abrirMenu); 
    inputEl.addEventListener('click', abrirMenu); 
    inputEl.addEventListener('input', abrirMenu);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.form-group')) { 
      document.querySelectorAll('.combobox-dropdown').forEach(d => d.style.display = 'none'); 
    }
  });
}

function renderComboboxOptions(inputEl, dropEl, data, tipo) {
  const filter = inputEl.value.toLowerCase().trim();
  dropEl.innerHTML = '';
  
  const matches = data.filter(item => {
    const val = (item.nombre || item.id || '').toLowerCase();
    return val.includes(filter);
  });

  if (matches.length === 0) { 
    dropEl.innerHTML = `<div class="combobox-item" style="color:#94a3b8; cursor:default;">Sin coincidencias</div>`; 
  } else {
    matches.forEach(item => {
      const div = document.createElement('div'); 
      div.className = 'combobox-item';
      
      const labelText = item.nombre || item.id;
      div.innerText = labelText;
      
      div.addEventListener('click', (e) => {
        e.preventDefault(); 
        e.stopPropagation();
        inputEl.value = labelText; 
        
        if(tipo === 'operario') {
          document.getElementById('select-operario').value = labelText;
        } else {
          document.getElementById(`select-${tipo}`).value = item.id;
          if (tipo === 'producto') actualizarFichaProducto(item.id);
        }
        
        dropEl.style.display = 'none';
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
    document.getElementById('spec-color').innerText = selected.color || '-'; document.getElementById('spec-peso').innerText = selected.peso || '-';
    document.getElementById('spec-ciclo').innerText = selected.ciclo || '-'; document.getElementById('spec-diametros').innerText = `${selected.diametroHilo || '-'} / ${selected.diametroInterior || '-'}`;
    banner.style.display = 'block';
  } else { banner.style.display = 'none'; }
}

function setupEventListeners() {
  document.getElementById('btn-login').addEventListener('click', () => {
    const user = document.getElementById('login-inspector').value; const pin = document.getElementById('login-pin').value;
    if (!user) { document.getElementById('login-error').innerText = '⚠️ Selecciona un inspector.'; return; }
    if (pin === '1234' || pin === '0000') { sessionStorage.setItem('usuario_calidad', user.trim()); document.getElementById('login-error').innerText = ''; checkSession(); actualizarContadorBorradores(); }
    else { document.getElementById('login-error').innerText = '⚠️ PIN incorrecto.'; }
  });

  document.getElementById('btn-logout').addEventListener('click', () => { sessionStorage.removeItem('usuario_calidad'); checkSession(); });
  document.getElementById('btn-guardar-borrador').addEventListener('click', guardarComoBorrador);

  document.getElementById('btn-guardar-registro').addEventListener('click', async () => {
    const dataForm = recopilarDatosFormulario();
    if (!dataForm.maquinaId || !dataForm.productoId || !dataForm.operario.trim()) { 
      alert("⚠️ Faltan datos clave de Máquina, Producto u Operario."); 
      return; 
    }

    const medicionesDef = [ 
      { id: 'med-color', n: 'Color' }, { id: 'med-espesor', n: 'Espesor' }, 
      { id: 'med-ciclo', n: 'Ciclo' }, { id: 'med-peso', n: 'Peso' }, 
      { id: 'med-calce', n: 'Calce' }, { id: 'med-filtracion', n: 'Filtración' }, 
      { id: 'med-probador', n: 'Probador' }, { id: 'med-hcuello', n: 'H Cuello' }, 
      { id: 'med-phi-int', n: 'Φ Int' }, { id: 'med-phi-hilo', n: 'Φ Hilo' }, 
      { id: 'med-phi-trinquete', n: 'Φ Trinquete' }, { id: 'med-rebalse', n: 'Rebalse' }, 
      { id: 'med-caida', n: 'Caída' } 
    ];
    
    let faltantes = [];
    medicionesDef.forEach(m => {
      const el = document.getElementById(m.id);
      if (!el.value.trim()) { 
        el.style.borderColor = 'red'; 
        faltantes.push(m.n); 
      } else { 
        el.style.borderColor = '#64748b'; 
      }
    });

    if (faltantes.length > 0) { 
      alert("⚠️ NO SE PUEDE GUARDAR EL REGISTRO FINAL. Faltan completar en el laboratorio:\n\n• " + faltantes.join("\n• ")); 
      return; 
    }

    const btn = document.getElementById('btn-guardar-registro'); 
    btn.disabled = true; 
    btn.innerText = "Enviando a Drive...";

    const exito = await enviarAGoogleSheets(dataForm);
    if (exito) {
      alert("¡Registro FINAL guardado exitosamente!");
      if (currentDraftId) {
        let borradores = JSON.parse(localStorage.getItem('borradores_calidad')) || [];
        borradores = borradores.filter(b => b.id !== currentDraftId);
        localStorage.setItem('borradores_calidad', JSON.stringify(borradores));
      }
      resetFormulario(); 
      actualizarContadorBorradores(); 
      loadCatalogData();
    }
    btn.disabled = false; 
    btn.innerText = "✅ GUARDAR REGISTRO FINAL";
  });

  document.getElementById('btn-cerrar-turno').addEventListener('click', cerrarTurno);
  document.getElementById('btn-generar-pdf-ahora').addEventListener('click', generarConsolidado);
  document.getElementById('btn-qr').addEventListener('click', startQRScanner);
  document.getElementById('btn-close-qr').addEventListener('click', stopQRScanner);
  document.getElementById('btn-refresh-historial').addEventListener('click', loadCatalogData);
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

async function enviarAGoogleSheets(data) {
  data.turno = obtenerTurnoAuto(); 
  data.inspector_calidad = sessionStorage.getItem('usuario_calidad'); 
  data.id_maquina = data.maquinaId; 
  data.id_producto = data.productoId;

  try { 
    await fetch(GOOGLE_SCRIPT_URL, { 
      method: 'POST', 
      mode: 'no-cors', 
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, 
      body: JSON.stringify(data) 
    }); 
    return true; 
  } catch (err) { 
    alert("Error al conectar con Drive."); 
    return false; 
  }
}

function resetFormulario() {
  currentDraftId = null;
  document.querySelectorAll('input:not([type="hidden"]):not(#input-cavidad):not(#input-turno), textarea').forEach(el => el.value = '');
  document.getElementById('select-maquina').value = ''; document.getElementById('select-producto').value = ''; document.getElementById('specs-banner').style.display = 'none';
  document.querySelectorAll('.btn-toggle').forEach(btn => { btn.innerText = 'Cumple'; btn.className = 'btn-toggle active-cumple'; const t = document.getElementById(btn.dataset.target); if(t) t.value = 'Cumple'; });
}

async function loadCatalogData() {
  try {
    const res = await fetch(GOOGLE_SCRIPT_URL); const data = await res.json();
    maquinasCache = data.maquinas || []; 
    productosCache = data.productos || []; 
    operariosCache = data.operarios || []; 
    historialCache = data.historial || [];
    renderHistorialInspector();
  } catch (err) { console.error("Error API:", err); }
}

function renderHistorialInspector() {
  const user = (sessionStorage.getItem('usuario_calidad') || '').toLowerCase();
  const tbody = document.getElementById('tabla-historial-body');
  const mis = historialCache.filter(i => (i.inspector || '').toLowerCase() === user);
  if (mis.length === 0) { tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No tienes registros finales aún.</td></tr>`; return; }
  tbody.innerHTML = mis.map(r => `<tr><td>${r.idInspeccion}</td><td>${r.correlativo}</td><td>${r.fechaHora}</td><td>${r.turno}</td><td>${r.maquina}</td><td>${r.producto}</td></tr>`).join('');
}

async function cerrarTurno() {
  const turno = obtenerTurnoAuto(); if (!confirm(`¿Cerrar ${turno} y generar PDFs?`)) return;
  try { await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ action: 'cerrarTurno', turnoActual: turno }) }); alert("Cierre enviado a Drive."); } catch(err){}
  resetFormulario(); sessionStorage.removeItem('usuario_calidad'); checkSession();
}
async function generarConsolidado() {
  try { await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ action: 'generarConsolidado', turnoActual: obtenerTurnoAuto() }) }); alert("Proceso enviado."); } catch(err){}
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
