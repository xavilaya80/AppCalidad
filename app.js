// REGISTRO DE SERVICE WORKER PARA PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.log('Error SW:', err));
}

// ⚠️ PEGA AQUÍ TU URL DESPLEGADA DE GOOGLE APPS SCRIPT
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxsjzw8hWWDvn7DTJBfRRVyCFtXyB2iP__NmGodyAOj3EJvdNozTQ-vUZW79RuiWryQIQ/exec';

// ESTADO LOCAL
let productosCache = [];
let maquinasCache = [];
let historialCache = [];
let html5QrCode = null;

document.addEventListener('DOMContentLoaded', () => {
  checkSession();
  setupNavigation();
  setupEventListeners();
  setupToggles();
  actualizarTurnoAuto();
});

// 1. DETECCIÓN AUTOMÁTICA DE TURNO
function obtenerTurnoAuto() {
  const hora = new Date().getHours();
  return (hora >= 8 && hora < 20) ? "Turno Mañana" : "Turno Noche";
}

function actualizarTurnoAuto() {
  const inputTurno = document.getElementById('input-turno');
  const turnoHeader = document.getElementById('turno-header-badge');
  const turnoActual = obtenerTurnoAuto();
  
  if (inputTurno) inputTurno.value = turnoActual;
  if (turnoHeader) turnoHeader.innerText = turnoActual;
}

// 2. VERIFICACIÓN Y BLOQUEO DE SESIÓN
function checkSession() {
  const usuario = sessionStorage.getItem('usuario_calidad');
  const modal = document.getElementById('login-modal');
  const appContent = document.getElementById('app-content');
  const userDisplay = document.getElementById('user-display');

  if (!usuario) {
    modal.style.display = 'flex';
    appContent.style.display = 'none';
    
    document.getElementById('login-inspector').value = '';
    document.getElementById('login-pin').value = '';
    document.getElementById('login-error').style.display = 'none';
  } else {
    modal.style.display = 'none';
    appContent.style.display = 'block';
    userDisplay.innerText = `Inspector: ${usuario}`;
    
    loadCatalogData();
  }
}

// 3. NAVEGACIÓN ENTRE PESTAÑAS
function setupNavigation() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
      
      tab.classList.add('active');
      const targetView = document.getElementById(tab.dataset.target);
      if (targetView) targetView.classList.add('active');

      if (tab.dataset.target === 'view-historial') {
        renderHistorialInspector();
      }
    });
  });
}

// 4. CONFIGURACIÓN DE BUSCADORES DINÁMICOS EN MÁQUINAS Y PRODUCTOS
function setupSearchInputs() {
  const selectMaq = document.getElementById('select-maquina');
  if (selectMaq && !document.getElementById('search-maquina')) {
    const inputMaq = document.createElement('input');
    inputMaq.id = 'search-maquina';
    inputMaq.type = 'text';
    inputMaq.placeholder = '🔍 Escribe para buscar máquina...';
    inputMaq.className = 'ind-input-sm';
    inputMaq.style.width = '100%';
    inputMaq.style.marginBottom = '6px';
    inputMaq.style.boxSizing = 'border-box';
    inputMaq.addEventListener('input', (e) => filtrarMaquinas(e.target.value));
    selectMaq.parentNode.insertBefore(inputMaq, selectMaq);
  }

  const selectProd = document.getElementById('select-producto');
  if (selectProd && !document.getElementById('search-producto')) {
    const inputProd = document.createElement('input');
    inputProd.id = 'search-producto';
    inputProd.type = 'text';
    inputProd.placeholder = '🔍 Escribe para buscar producto...';
    inputProd.className = 'ind-input-sm';
    inputProd.style.width = '100%';
    inputProd.style.marginBottom = '6px';
    inputProd.style.boxSizing = 'border-box';
    inputProd.addEventListener('input', (e) => filtrarProductos(e.target.value));
    selectProd.parentNode.insertBefore(inputProd, selectProd);
  }
}

function filtrarMaquinas(filtro = '') {
  const selectMaq = document.getElementById('select-maquina');
  if (!selectMaq) return;
  const term = filtro.toLowerCase().trim();
  const valActual = selectMaq.value;

  selectMaq.innerHTML = '<option value="">-- Seleccionar Máquina --</option>';
  maquinasCache
    .filter(m => (m.nombre || '').toLowerCase().includes(term) || (m.id || '').toLowerCase().includes(term))
    .forEach(m => {
      const texto = (m.nombre && m.nombre !== m.id) ? `${m.nombre} (${m.id})` : m.id;
      selectMaq.innerHTML += `<option value="${m.id}">${texto}</option>`;
    });
  selectMaq.value = valActual;
}

function filtrarProductos(filtro = '') {
  const selectProd = document.getElementById('select-producto');
  if (!selectProd) return;
  const term = filtro.toLowerCase().trim();
  const valActual = selectProd.value;

  selectProd.innerHTML = '<option value="">-- Seleccionar Producto --</option>';
  productosCache
    .filter(p => (p.nombre || '').toLowerCase().includes(term) || (p.id || '').toLowerCase().includes(term))
    .forEach(p => {
      const texto = (p.nombre && p.nombre !== p.id) ? `${p.nombre} (${p.id})` : p.id;
      selectProd.innerHTML += `<option value="${p.id}">${texto}</option>`;
    });
  
  selectProd.value = valActual;
  selectProd.dispatchEvent(new Event('change'));
}

// 5. CONFIGURACIÓN DE EVENTOS GENERALES
function setupEventListeners() {
  // Login de Inspectores
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
    } else {
      document.getElementById('login-error').innerText = '⚠️ PIN incorrecto.';
      document.getElementById('login-error').style.display = 'block';
    }
  });

  // Logout
  document.getElementById('btn-logout').addEventListener('click', () => {
    sessionStorage.removeItem('usuario_calidad');
    checkSession();
  });

  // Ficha técnica dinámica
  document.getElementById('select-producto').addEventListener('change', (e) => {
    const selected = productosCache.find(p => p.id === e.target.value);
    const banner = document.getElementById('specs-banner');

    if (selected) {
      document.getElementById('spec-color').innerText = selected.color || 'Estándar';
      document.getElementById('spec-peso').innerText = selected.peso || 'Estándar';
      document.getElementById('spec-ciclo').innerText = selected.ciclo || 'Estándar';
      document.getElementById('spec-diametros').innerText = `${selected.diametroHilo || '-'} / ${selected.diametroInterior || '-'}`;
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  });

  // Escáner QR
  document.getElementById('btn-qr').addEventListener('click', startQRScanner);
  document.getElementById('btn-close-qr').addEventListener('click', stopQRScanner);

  // Botón Guardar Registro
  const btnGuardar = document.getElementById('btn-guardar-registro') || document.getElementById('btn-imprimir-pdf');
  if (btnGuardar) {
    btnGuardar.addEventListener('click', async () => {
      const maquina = document.getElementById('select-maquina').value;
      const producto = document.getElementById('select-producto').value;

      if (!maquina || !producto) {
        alert("Por favor selecciona Máquina y Producto.");
        return;
      }

      btnGuardar.disabled = true;
      btnGuardar.innerText = "Guardando...";

      const exito = await enviarAGoogleSheets();

      if (exito) {
        alert("¡Registro guardado exitosamente!");
        resetFormulario();
        await loadCatalogData();
      }

      btnGuardar.disabled = false;
      btnGuardar.innerText = "💾 GUARDAR REGISTRO";
    });
  }

  // Refrescar Historial manualmente
  document.getElementById('btn-refresh-historial').addEventListener('click', loadCatalogData);
}

// 6. BOTONES TOGGLE CUMPLE / NO CUMPLE
function setupToggles() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-toggle');
    if (!btn) return;

    e.preventDefault();
    const targetInput = document.getElementById(btn.dataset.target);

    if (btn.classList.contains('active-cumple')) {
      btn.classList.remove('active-cumple');
      btn.classList.add('active-nocumple');
      btn.innerText = 'No Cumple';
      if (targetInput) targetInput.value = 'No Cumple';
    } else {
      btn.classList.remove('active-nocumple');
      btn.classList.add('active-cumple');
      btn.innerText = 'Cumple';
      if (targetInput) targetInput.value = 'Cumple';
    }
  });
}

// 7. CARGA DE DATOS DESDE GOOGLE SHEETS
async function loadCatalogData() {
  try {
    const response = await fetch(GOOGLE_SCRIPT_URL);
    const data = await response.json();

    maquinasCache = data.maquinas || [];
    productosCache = data.productos || [];
    historialCache = data.historial || [];

    setupSearchInputs();

    const inputMaq = document.getElementById('search-maquina');
    const inputProd = document.getElementById('search-producto');
    
    filtrarMaquinas(inputMaq ? inputMaq.value : '');
    filtrarProductos(inputProd ? inputProd.value : '');

    renderHistorialInspector();

  } catch (err) {
    console.error("Error al obtener datos desde Google Sheets:", err);
  }
}

// 8. RENDERIZAR HISTORIAL FILTRADO POR INSPECTOR LOGUEADO
function renderHistorialInspector() {
  const usuarioActual = (sessionStorage.getItem('usuario_calidad') || '').trim().toLowerCase();
  const tbody = document.getElementById('tabla-historial-body');

  if (!tbody) return;

  const misRegistros = historialCache.filter(item => 
    (item.inspector || '').trim().toLowerCase() === usuarioActual
  );

  if (misRegistros.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px;">No tienes registros guardados aún.</td></tr>`;
    return;
  }

  tbody.innerHTML = misRegistros.map(reg => `
    <tr>
      <td><strong>${reg.idInspeccion}</strong></td>
      <td>${reg.correlativo}</td>
      <td>${reg.fechaHora}</td>
      <td>${reg.turno}</td>
      <td>${reg.maquina}</td>
      <td>${reg.producto}</td>
      <td>${reg.observaciones || '-'}</td>
    </tr>
  `).join('');
}

// 9. ENVÍO DE DATOS A GOOGLE SHEETS
async function enviarAGoogleSheets() {
  const maquina = document.getElementById('select-maquina').value;
  const producto = document.getElementById('select-producto').value;
  const inspectorActual = sessionStorage.getItem('usuario_calidad');

  if (!inspectorActual) {
    alert("Sesión no identificada. Por favor inicia sesión.");
    checkSession();
    return false;
  }

  const medColor = document.getElementById('med-color').value;
  const medEspesor = document.getElementById('med-espesor').value;
  const medCiclo = document.getElementById('med-ciclo').value;
  const medPeso = document.getElementById('med-peso').value;
  const medCalce = document.getElementById('med-calce').value;
  const medFiltracion = document.getElementById('med-filtracion').value;
  const obsUsuario = document.getElementById('input-observaciones').value;

  const resumenMediciones = `[MEDICIONES -> Peso: ${medPeso||'-'} | Espesor: ${medEspesor||'-'} | Ciclo: ${medCiclo||'-'} | Color: ${medColor||'-'} | Calce: ${medCalce||'-'} | Leak: ${medFiltracion||'-'}]`;

  const payload = {
    turno: obtenerTurnoAuto(),
    inspector_calidad: inspectorActual,
    id_maquina: maquina,
    id_producto: producto,
    lote_mp: document.getElementById('input-lote-mp').value,
    lote_bxa: document.getElementById('input-lote-bxa').value,
    observaciones: `${obsUsuario} ${resumenMediciones}`.trim(),
    
    cavidad_molde: document.getElementById('input-cavidad').value,
    color: `${document.getElementById('val-color').value} (${medColor || 'S/D'})`,
    espesor_pared: `${document.getElementById('val-espesor').value} (${medEspesor || 'S/D'})`,
    ciclo: `${document.getElementById('val-ciclo').value} (${medCiclo || 'S/D'})`,
    peso: `${document.getElementById('val-peso').value} (${medPeso || 'S/D'})`,
    calce_ajuste: `${document.getElementById('val-calce').value} (${medCalce || 'S/D'})`,
    filtracion: `${document.getElementById('val-filtracion').value} (${medFiltracion || 'S/D'})`
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
    console.error("Error al enviar a Google Sheets:", err);
    alert("Error de conexión al guardar.");
    return false;
  }
}

// 10. LIMPIAR FORMULARIO
function resetFormulario() {
  document.querySelectorAll('input:not([type="hidden"]):not(#input-cavidad):not(#input-turno), textarea').forEach(el => el.value = '');
  
  const searchMaq = document.getElementById('search-maquina');
  const searchProd = document.getElementById('search-producto');
  if (searchMaq) searchMaq.value = '';
  if (searchProd) searchProd.value = '';

  filtrarMaquinas('');
  filtrarProductos('');

  document.getElementById('specs-banner').style.display = 'none';
  
  document.querySelectorAll('.btn-toggle').forEach(btn => {
    btn.innerText = 'Cumple';
    btn.className = 'btn-toggle active-cumple';
    const targetHidden = document.getElementById(btn.dataset.target);
    if (targetHidden) targetHidden.value = 'Cumple';
  });

  actualizarTurnoAuto();
}

// 11. ESCÁNER QR NATIVO
function startQRScanner() {
  document.getElementById('qr-modal').style.display = 'flex';
  html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 220, height: 220 } },
    (decodedText) => {
      const searchMaq = document.getElementById('search-maquina');
      if (searchMaq) searchMaq.value = '';
      filtrarMaquinas('');

      const selectMaq = document.getElementById('select-maquina');
      for (let i = 0; i < selectMaq.options.length; i++) {
        if (selectMaq.options[i].value === decodedText || selectMaq.options[i].text.toLowerCase().includes(decodedText.toLowerCase())) {
          selectMaq.selectedIndex = i;
          break;
        }
      }
      stopQRScanner();
    },
    () => {}
  ).catch(err => console.log("Error al iniciar cámara QR:", err));
}

function stopQRScanner() {
  if (html5QrCode) {
    html5QrCode.stop().then(() => {
      document.getElementById('qr-modal').style.display = 'none';
    }).catch(() => {
      document.getElementById('qr-modal').style.display = 'none';
    });
  } else {
    document.getElementById('qr-modal').style.display = 'none';
  }
}
