if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.log('Error SW:', err));
}

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxsjzw8hWWDvn7DTJBfRRVyCFtXyB2iP__NmGodyAOj3EJvdNozTQ-vUZW79RuiWryQIQ/exec';

let productosCache = [];
let maquinasCache = [];
let historialCache = [];
let operariosCache = [];
let pendientesCache = [];
let resumenTurnosCache = [];
let desviacionesCache = [];   // C2: cavidades que fallaron, ronda por ronda
let configActaCache = { destinatarios: [], jefeTurno: '' };
let estadoMaquinasCache = {};   // que maquinas estan detenidas AHORA
let metaHistorial = { dias: 7, desde: '', truncado: 0 };   // ventana que envió el backend
let filasHistorialVisibles = 0;                            // paginado del render
let html5QrCode = null;
let currentRondaId = null;
let chartTendenciaInstance = null;

document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupEventListeners();
  setupToggles();
  setupValidacionAutomatica();
  actualizarTurnoAuto();
  setupCustomComboboxes();
  setupNavegacionCavidades();
  setupModalTurno();
  setupModalActa();
  setupModalReactivar();
  setupEstadoConexion();
  checkSession();

  // Renderizar contenedores multicavidad iniciales
  renderContenedorCavidadesTerreno(1);
  renderContenedorCavidadesLab(1);

  // Escucha cambios en el número de cavidades
  const inputCav = document.getElementById('input-cavidad');
  if (inputCav) {
    // `input` llega en CADA tecla: escribir "18" pasa antes por "1". Repintar
    // ahi hace saltar el foco y el scroll, asi que se espera a que termine.
    // (Aunque se colara un repintado, la memoria de cavidades lo cubre.)
    let temporizadorCav = null;

    const aplicarNumCavidades = () => {
      let val = parseInt(inputCav.value, 10);
      if (isNaN(val) || val < 1) val = 1;
      if (val > 24) val = 24;
      redimensionarCavidades(val);
      return val;
    };

    inputCav.addEventListener('input', () => {
      if (inputCav.value === "") return;
      clearTimeout(temporizadorCav);
      temporizadorCav = setTimeout(aplicarNumCavidades, 400);
    });

    inputCav.addEventListener('change', () => {
      clearTimeout(temporizadorCav);
      inputCav.value = aplicarNumCavidades();
    });
  }
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

/* ===================================================================
 * TURNOS OPERATIVOS
 *   08:00 - 19:59  ->  Turno Mañana, fecha operativa = ese mismo día
 *   20:00 - 23:59  ->  Turno Noche,  fecha operativa = ese mismo día
 *   00:00 - 07:59  ->  Turno Noche,  fecha operativa = el día ANTERIOR
 * Misma regla que getInfoTurnoOperativo() en el backend.
 * =================================================================== */

function partesSantiago(fecha) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(fecha || new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});

  let hora = parseInt(p.hour, 10);
  if (hora === 24) hora = 0;
  return { iso: `${p.year}-${p.month}-${p.day}`, hora, minuto: parseInt(p.minute, 10) };
}

// Aritmética sobre la fecha ISO usando mediodía UTC: inmune al horario de verano.
function sumarDiasISO(iso, dias) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function infoTurnoOperativo(fecha) {
  const p = partesSantiago(fecha);
  const turno = (p.hora >= 8 && p.hora < 20) ? 'Turno Mañana' : 'Turno Noche';
  const fechaOperativa = (p.hora < 8) ? sumarDiasISO(p.iso, -1) : p.iso;
  return { turno, fechaOperativa, hora: p.hora, minuto: p.minuto };
}

/*
 * Qué turno propone la app al presionar "Cerrar Turno".
 *
 * Dentro de las 2 horas siguientes a un cambio de turno se propone el turno
 * ANTERIOR: nadie cierra un turno que acaba de empezar. Es exactamente el caso
 * que rompía antes (cerrar el Turno Mañana a las 20:05 consolidaba el Noche).
 */
function sugerirTurnoACerrar() {
  const info = infoTurnoOperativo(new Date());
  const reciénCambiado = (info.hora === 8 || info.hora === 9 || info.hora === 20 || info.hora === 21);

  if (!reciénCambiado) {
    return { turno: info.turno, fechaOperativa: info.fechaOperativa, aviso: '' };
  }

  if (info.turno === 'Turno Noche') {
    // Son las 20:00-21:59: el Turno Mañana de HOY es el que se está cerrando.
    return {
      turno: 'Turno Mañana',
      fechaOperativa: info.fechaOperativa,
      aviso: `Son las ${String(info.hora).padStart(2, '0')}:${String(info.minuto).padStart(2, '0')}. ` +
             `El Turno Noche recién comenzó, así que se propone cerrar el Turno Mañana de hoy. ` +
             `Cámbialo si no es lo que buscas.`
    };
  }

  // Son las 08:00-09:59: el Turno Noche empezó AYER a las 20:00.
  return {
    turno: 'Turno Noche',
    fechaOperativa: sumarDiasISO(info.fechaOperativa, -1),
    aviso: `Son las ${String(info.hora).padStart(2, '0')}:${String(info.minuto).padStart(2, '0')}. ` +
           `El Turno Mañana recién comenzó, así que se propone cerrar el Turno Noche que empezó ayer. ` +
           `Cámbialo si no es lo que buscas.`
  };
}

function actualizarTurnoAuto() {
  const inputTurno = document.getElementById('input-turno');
  const turnoHeader = document.getElementById('turno-header-badge');
  const turnoActual = obtenerTurnoAuto();
  if (inputTurno) inputTurno.value = turnoActual;
  if (turnoHeader) turnoHeader.innerText = turnoActual;
}

/* ===================================================================
 * SESION EN TABLET COMPARTIDA
 *
 * La tablet es una sola y rota entre tres inspectores y dos roles. El riesgo
 * real no es el acceso: es el ARRASTRE. Lo que dejo el anterior seguia en
 * pantalla, y sobre todo seguia en memoria currentRondaId, que no se ve.
 *
 * Se guarda en sessionStorage y no en localStorage a proposito: sobrevive a un
 * F5 o a que el sistema recargue la PWA -que es lo que se quiere evitar-, pero
 * no deja una sesion abierta para siempre en un equipo compartido.
 *
 * La COLA OFFLINE no es parte de la sesion: pertenece a la tablet. Cambiar de
 * inspector nunca la toca, o se perderian los registros de quien se fue.
 * =================================================================== */

var SESION = {
  USUARIO: 'usuario_calidad',
  ROL: 'rol_calidad',
  RONDA: 'ronda_activa_calidad'
};

const PIN_VALIDO = (pin) => pin === '1234' || pin === '0000';

function sesionActual() {
  return {
    usuario: sessionStorage.getItem(SESION.USUARIO) || '',
    rol: sessionStorage.getItem(SESION.ROL) || ''
  };
}

function haySesion() {
  const s = sesionActual();
  return !!(s.usuario && s.rol);
}

// Cada rol aterriza en la vista donde efectivamente trabaja.
const vistaDeRol = (rol) => (rol === 'Laboratorio' ? 'view-borradores' : 'view-nueva');

function irAVista(target) {
  const tab = document.querySelector(`.nav-tab[data-target="${target}"]`);
  if (tab) tab.click();
  return !!tab;
}

/*
 * La ronda que el laboratorio tiene abierta.
 *
 * Persistirla es lo que evita que un F5 accidental obligue a buscarla de nuevo
 * entre los pendientes; borrarla al cambiar de usuario es lo que evita que el
 * siguiente inspector se encuentre la ronda del anterior ya cargada.
 */
function setRondaActiva(id) {
  currentRondaId = id || null;
  if (id) sessionStorage.setItem(SESION.RONDA, id);
  else sessionStorage.removeItem(SESION.RONDA);
}

function restaurarRondaActiva() {
  const id = sessionStorage.getItem(SESION.RONDA);
  if (!id || currentRondaId === id) return;

  if (sesionActual().rol !== 'Laboratorio') {
    sessionStorage.removeItem(SESION.RONDA);
    return;
  }

  // Si otro inspector la cerro o cancelo mientras tanto, no hay nada que reabrir.
  if (!pendientesCache.some(p => p.idInspeccion === id)) {
    sessionStorage.removeItem(SESION.RONDA);
    return;
  }
  cargarPendiente(id);
}

/*
 * Borra de la pantalla todo lo que era del inspector anterior.
 *
 * Lo critico no es lo visible sino currentRondaId: si queda apuntando a la ronda
 * del turno anterior, actualizarModoFormulario() abre el modo laboratorio y el
 * cierre terminaria firmado con el nombre del recien llegado.
 */
function limpiarInterfazSesion() {
  setRondaActiva(null);
  resetFormularioIdentificacion();

  // El historial se vacia aunque la pestaña este oculta: si no, el siguiente
  // inspector encuentra ahi las rondas del anterior al entrar a "Mi Historial".
  filasHistorialVisibles = 0;
  const tbodyHist = document.getElementById('tabla-historial-body');
  if (tbodyHist) tbodyHist.innerHTML = '';
  const nota = document.getElementById('historial-nota');
  if (nota) nota.innerText = '';

  if (chartTendenciaInstance) { chartTendenciaInstance.destroy(); chartTendenciaInstance = null; }
  const selAnalisis = document.getElementById('select-analisis-producto');
  if (selAnalisis) selAnalisis.value = '';

  // Un modal abierto -o peor, la camara encendida- sobrevivia al relevo.
  ['turno-modal', 'cola-modal'].forEach(id => {
    const m = document.getElementById(id);
    if (m) m.style.display = 'none';
  });
  const qr = document.getElementById('qr-modal');
  if (qr && qr.style.display === 'flex') stopQRScanner();
}

/*
 * Abre la pantalla de sesion.
 *   modoCambio = false -> primer ingreso: se oculta la app.
 *   modoCambio = true  -> relevo: la app queda detras y se puede cancelar.
 */
function mostrarLogin(modoCambio) {
  const modal = document.getElementById('login-modal');
  const appContent = document.getElementById('app-content');
  const s = sesionActual();

  const titulo = document.getElementById('login-titulo');
  if (titulo) titulo.innerText = modoCambio ? 'Cambiar Inspector' : 'Iniciar Sesión';

  const contexto = document.getElementById('login-contexto');
  if (contexto) {
    contexto.innerText = (modoCambio && s.usuario)
      ? `Ahora está registrado ${s.usuario} como ${s.rol}. Al entrar se cerrará su sesión y se limpiará la pantalla.`
      : '';
  }

  // "Cancelar" solo si hay a donde volver.
  const cancelar = document.getElementById('btn-login-cancelar');
  if (cancelar) cancelar.style.display = (modoCambio && haySesion()) ? 'inline-flex' : 'none';

  // Nunca se deja preseleccionado al anterior: elegir tiene que ser un acto
  // explicito, o se termina fichando rondas a nombre de quien ya se fue.
  const selUser = document.getElementById('login-inspector');
  const selRol = document.getElementById('login-rol');
  const pin = document.getElementById('login-pin');
  const error = document.getElementById('login-error');
  if (selUser) selUser.value = '';
  if (selRol) selRol.selectedIndex = 0;
  if (pin) pin.value = '';
  if (error) error.innerText = '';

  if (modal) modal.style.display = 'flex';
  if (!modoCambio && appContent) appContent.style.display = 'none';
}

function ocultarLogin() {
  const modal = document.getElementById('login-modal');
  if (modal) modal.style.display = 'none';
  const pin = document.getElementById('login-pin');
  if (pin) pin.value = '';
}

/*
 * Aplica una identidad a la interfaz.
 *
 * La comparacion con la sesion previa separa dos casos que parecen iguales:
 *   - recargar la pagina (F5): misma persona y mismo rol, no se toca nada;
 *   - cambio de inspector o de rol: se limpia entero y se cambia de vista.
 */
async function aplicarSesion(usuario, rol) {
  const previa = sesionActual();
  const cambio = (previa.usuario !== usuario || previa.rol !== rol);

  sessionStorage.setItem(SESION.USUARIO, usuario);
  sessionStorage.setItem(SESION.ROL, rol);

  if (cambio) limpiarInterfazSesion();

  ocultarLogin();
  const appContent = document.getElementById('app-content');
  if (appContent) appContent.style.display = 'block';

  const userDisplay = document.getElementById('user-display');
  if (userDisplay) userDisplay.innerText = '👤 ' + usuario;

  const badgeRol = document.getElementById('rol-header-badge');
  if (badgeRol) {
    badgeRol.innerText = (rol === 'Laboratorio') ? '🧪 Laboratorio' : '📋 Terreno';
    badgeRol.className = (rol === 'Laboratorio') ? 'badge-rol rol-lab' : 'badge-rol rol-terreno';
  }

  actualizarTurnoAuto();
  irAVista(vistaDeRol(rol));

  await loadCatalogData();
  restaurarRondaActiva();
}

function checkSession() {
  const s = sesionActual();
  if (!s.usuario || !s.rol) { mostrarLogin(false); return; }
  aplicarSesion(s.usuario, s.rol);
}

/*
 * Cierre de sesion. Se avisa de lo que se pierde, pero NO se toca la cola:
 * esos registros son de la tablet y se sincronizan igual, entre quien entre.
 */
function cerrarSesion(saltarConfirmacion) {
  if (!saltarConfirmacion) {
    let aviso = `¿Cerrar la sesión de ${sesionActual().usuario || 'este inspector'}?`;

    if (currentRondaId) {
      aviso += `\n\n\u26a0\ufe0f Hay una ronda abierta en laboratorio (${currentRondaId}). ` +
               `Las mediciones que no hayas guardado se perderán; la ronda vuelve a Pendientes.`;
    }

    const enCola = colaPendientes().length;
    if (enCola > 0) {
      aviso += `\n\n\u2139\ufe0f Quedan ${enCola} registro(s) sin sincronizar. No se pierden: ` +
               `se envían solos cuando haya conexión, aunque entre otro inspector.`;
    }

    if (!confirm(aviso)) return;
  }

  limpiarInterfazSesion();
  sessionStorage.removeItem(SESION.USUARIO);
  sessionStorage.removeItem(SESION.ROL);
  mostrarLogin(false);
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
  
  const isDetenida = document.getElementById('check-maquina-detenida').checked;
  toggleModoDetenida(isDetenida);
  
  document.getElementById('btn-cerrar-ronda').style.display = 'none';
  document.getElementById('btn-cancelar-ronda').style.display = 'none';
}

function toggleModoDetenida(activado) {
  const secDetencion = document.getElementById('seccion-detencion');
  const bloqueProd = document.getElementById('bloque-datos-produccion');
  const btnIniciar = document.getElementById('btn-iniciar-ronda');
  const btnDetenida = document.getElementById('btn-registrar-detenida');
  const bannerSpecs = document.getElementById('specs-banner');

  if (activado) {
    secDetencion.style.display = 'block';
    bloqueProd.style.display = 'none';
    btnIniciar.style.display = 'none';
    btnDetenida.style.display = 'block';
    if (bannerSpecs) bannerSpecs.style.display = 'none';
  } else {
    secDetencion.style.display = 'none';
    bloqueProd.style.display = 'block';
    btnIniciar.style.display = 'block';
    btnDetenida.style.display = 'none';
  }
}

function mostrarModoEsperaPendiente() {
  document.getElementById('msg-seleccionar-pendiente').style.display = 'block';
  document.getElementById('ronda-info-banner').style.display = 'none';
  document.getElementById('card-identificacion').style.display = 'none';
  document.getElementById('card-mediciones').style.display = 'none';
  document.getElementById('specs-banner').style.display = 'none';
  document.getElementById('btn-iniciar-ronda').style.display = 'none';
  document.getElementById('btn-registrar-detenida').style.display = 'none';
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
  document.getElementById('btn-registrar-detenida').style.display = 'none';
  document.getElementById('btn-cerrar-ronda').style.display = 'block';
  document.getElementById('btn-cancelar-ronda').style.display = 'block';
}

/* ===================================================================
 * NAVEGACION POR CAVIDAD
 *
 * Con moldes de hasta 24 cavidades una lista plana era inllenable: habia que
 * hacer scroll a ciegas y no se sabia cual faltaba. Ahora se muestra UNA cavidad
 * a la vez, con una fila de chips numerados que hace de indice y de semaforo:
 *
 *   gris   = sin empezar      ambar = incompleta
 *   verde  = completa          rojo  = tiene un "No Cumple"
 *
 * Los paneles de todas las cavidades siguen en el DOM (solo se ocultan), asi
 * que moverse entre cavidades nunca pierde lo ya escrito.
 * =================================================================== */

// id: sufijo del elemento en el DOM | clave: nombre del campo en el payload
const CAMPOS_TERRENO = [
  { id: 'color',    clave: 'color',    label: 'Color / Apariencia', tipo: 'text' },
  { id: 'ciclo',    clave: 'ciclo',    label: 'Ciclo (s)',          tipo: 'number', step: '0.1' },
  { id: 'peso',     clave: 'peso',     label: 'Peso (g)',           tipo: 'number', step: '0.01' },
  { id: 'probador', clave: 'probador', label: 'Probador',           tipo: 'text' }
];

const CAMPOS_LAB = [
  { id: 'espesor',       clave: 'espesor',       label: 'Espesor Pared',  tipo: 'number', step: '0.01' },
  { id: 'calce',         clave: 'calce',         label: 'Calce Tapa',     tipo: 'text' },
  { id: 'filtracion',    clave: 'filtracion',    label: 'Filtración',     tipo: 'text' },
  { id: 'hcuello',       clave: 'hcuello',       label: 'H Cuello',       tipo: 'number', step: '0.01' },
  { id: 'phi-int',       clave: 'phi_int',       label: 'Φ Int. Gollete', tipo: 'number', step: '0.01' },
  { id: 'phi-hilo',      clave: 'phi_hilo',      label: 'Φ Hilo Gollete', tipo: 'number', step: '0.01' },
  { id: 'phi-trinquete', clave: 'phi_trinquete', label: 'Φ Trinquete',    tipo: 'number', step: '0.01' },
  { id: 'rebalse',       clave: 'rebalse',       label: 'Rebalse',        tipo: 'number', step: '0.1' },
  { id: 'caida',         clave: 'caida',         label: 'Caída Libre',    tipo: 'text' }
];

// Estado vivo de cada contenedor, para que la navegacion sepa que esta pintado.
const CONTENEDORES_CAV = {
  'contenedor-cavidades-terreno': { prefijo: 'cav-t-', campos: CAMPOS_TERRENO, num: 0 },
  'contenedor-cavidades-lab':     { prefijo: 'cav-',   campos: CAMPOS_LAB,     num: 0 }
};

/*
 * Escapa un valor antes de meterlo en innerHTML.
 *
 * No es una precaucion teorica: los nombres de producto, maquina, operario,
 * lote y las observaciones los escriben personas. Basta un producto llamado
 * 5/8" x 3/4" o una observacion con "<" para que el navegador interprete el
 * texto como etiquetas y la tabla salga rota o vacia.
 *
 * Se escapa tambien la comilla simple: el mismo valor puede terminar dentro de
 * un atributo delimitado con comillas simples.
 */
function escapeHTML(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function claseToggle(estado) {
  if (estado === 'No Cumple') return 'active-nocumple';
  if (estado === 'No Aplica') return 'active-noaplica';
  return 'active-cumple';
}

/* ===================================================================
 * VALIDACION AUTOMATICA CONTRA TOLERANCIA (C1)
 *
 * Antes la especificacion era un cartel arriba y el inspector comparaba de
 * memoria, cavidad por cavidad, hasta 24 veces por ronda. Eso es donde se
 * escapan las desviaciones: no por criterio, por cansancio.
 *
 * Ahora, al escribir un valor con rango conocido, la app marca sola:
 *     dentro del rango -> Cumple      fuera -> No Cumple
 *
 * Tres reglas que sostienen esto:
 *
 *   1. Sin rango NO se marca nada. Si la especificacion es un numero suelto
 *      (nominal sin tolerancia) o texto, el boton se queda como estaba y
 *      decide la persona. Marcar "Cumple" sin poder comprobarlo es el error
 *      que se corrigio en A2 y termina en certificados falsos.
 *
 *   2. La ultima palabra es del inspector. En cuanto toca el boton, ese campo
 *      queda en manual y la automatica no lo vuelve a tocar: es lo que permite
 *      dejar "No Aplica" cuando el ensayo no corresponde.
 *
 *   3. La marca manual sobrevive a los repintados (ver B6), o cambiar el
 *      numero de cavidades borraria silenciosamente un "No Aplica".
 * =================================================================== */

// Campo del formulario -> variable de Productos_Specs.
// Los que no estan aca (color, probador, calce, filtracion, caida) son
// apreciaciones, no medidas: no tienen rango y siguen siendo manuales.
const SPEC_DE_CAMPO = {
  peso:          'peso',
  ciclo:         'ciclo',
  espesor:       'espesor',
  hcuello:       'hcuello',
  phi_int:       'diametroInterior',
  phi_hilo:      'diametroHilo',
  phi_trinquete: 'diametroTrinquete',
  rebalse:       'rebalse'
};

let toleranciasActivas = {};   // tolerancias del producto seleccionado

function rangoDeCampo(clave) {
  const spec = SPEC_DE_CAMPO[clave];
  if (!spec) return null;
  const r = toleranciasActivas[spec];
  if (!r) return null;
  // validable = tiene al menos un extremo. Un nominal suelto no sirve.
  const min = (r.min === null || r.min === undefined) ? null : Number(r.min);
  const max = (r.max === null || r.max === undefined) ? null : Number(r.max);
  if (min === null && max === null) return null;
  return { min, max };
}

// "23 – 24" / "≥ 23" / "≤ 24"
function textoRango(r) {
  const n = (x) => String(Number(x));
  if (r.min !== null && r.max !== null) return `${n(r.min)} – ${n(r.max)}`;
  if (r.min !== null) return `≥ ${n(r.min)}`;
  return `≤ ${n(r.max)}`;
}

function numeroDeTexto(txt) {
  const s = String(txt || '').trim().replace(',', '.');
  if (s === '') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Pinta el boton y el campo oculto de un estado, sin marcarlo como manual.
function fijarEstado(idVal, estado) {
  const oculto = document.getElementById(idVal);
  if (!oculto || oculto.value === estado) return;
  oculto.value = estado;

  const btn = document.querySelector(`.btn-toggle[data-target="${idVal}"]`);
  if (btn) {
    btn.className = 'btn-toggle ' + claseToggle(estado);
    btn.innerText = estado;
  }
}

/*
 * Evalua un campo de medicion contra su rango.
 * Devuelve 'dentro' | 'fuera' | null (no evaluable).
 */
function evaluarMedicion(input) {
  if (!input || !input.dataset) return null;
  const idVal = input.dataset.val;
  const oculto = idVal ? document.getElementById(idVal) : null;
  const fila = input.closest ? input.closest('.medicion-row') : null;

  const limpiar = () => {
    if (fila && fila.classList) {
      fila.classList.remove('med-dentro');
      fila.classList.remove('med-fuera');
    }
    return null;
  };

  if (!oculto) return limpiar();
  if (oculto.dataset.manual === '1') return limpiar();   // decidio la persona

  const r = rangoDeCampo(input.dataset.clave);
  if (!r) return limpiar();

  const n = numeroDeTexto(input.value);
  if (n === null) {
    // Campo vacio: se vuelve al estado inicial en vez de dejar un veredicto
    // sobre un valor que ya no existe.
    fijarEstado(idVal, 'Cumple');
    return limpiar();
  }

  const dentro = (r.min === null || n >= r.min) && (r.max === null || n <= r.max);
  fijarEstado(idVal, dentro ? 'Cumple' : 'No Cumple');

  if (fila && fila.classList) {
    fila.classList.toggle('med-dentro', dentro);
    fila.classList.toggle('med-fuera', !dentro);
  }
  return dentro ? 'dentro' : 'fuera';
}

/*
 * Reevalua un contenedor entero y escribe el rango al lado de cada campo.
 * Se llama al repintar y al cambiar de producto.
 */
function refrescarValidacion(contenedorId) {
  const ids = contenedorId
    ? [contenedorId]
    : ['contenedor-cavidades-terreno', 'contenedor-cavidades-lab'];

  ids.forEach(id => {
    const cfg = CONTENEDORES_CAV[id];
    if (!cfg || !cfg.num) return;

    for (let c = 1; c <= cfg.num; c++) {
      cfg.campos.forEach(f => {
        const input = document.getElementById(`${cfg.prefijo}${c}-${f.id}`);
        const etiqueta = document.getElementById(`${cfg.prefijo}${c}-${f.id}-rango`);
        const r = rangoDeCampo(f.clave);

        if (etiqueta) etiqueta.innerText = r ? textoRango(r) : '';
        if (input) evaluarMedicion(input);
      });
    }
    refrescarEstadoCavidades(id);
  });
}

function filaMedicionHTML(prefijo, c, campo, datos) {
  const med = datos[campo.clave + '_med'] || '';
  const val = datos[campo.clave + '_val'] || 'Cumple';
  const idMed = `${prefijo}${c}-${campo.id}`;
  const idVal = `${prefijo}${c}-val-${campo.id}`;
  const attrs = campo.tipo === 'number'
    ? `type="number" step="${campo.step}" inputmode="decimal"`
    : 'type="text"';

  // La marca manual viaja en los datos: si se perdiera al repintar, un
  // "No Aplica" puesto a mano lo borraria la validacion automatica (ver B6).
  const manual = datos[campo.clave + '_manual'] === '1' ? ' data-manual="1"' : '';

  return `<div class="medicion-row">
    <label for="${idMed}">${campo.label}<small class="med-rango" id="${idMed}-rango"></small></label>
    <input ${attrs} id="${idMed}" value="${escapeHTML(med)}" placeholder="Valor..."
           data-clave="${escapeHTML(campo.clave)}" data-val="${idVal}">
    <button type="button" class="btn-toggle ${claseToggle(val)}" data-target="${idVal}">${val}</button>
    <input type="hidden" id="${idVal}" value="${escapeHTML(val)}"${manual}>
  </div>`;
}

/*
 * Pinta el contenedor completo (barra de navegacion + chips + un panel por cavidad).
 * `datosGuardados` es un objeto { 1: {...}, 2: {...} } y permite repintar sin
 * perder lo escrito (por ejemplo al corregir el numero de cavidades).
 * `contextoTerreno` es opcional: el chequeo que terreno hizo en esa misma cavidad.
 */
function renderCavidades(contenedorId, numCavidades, datosGuardados, contextoTerreno) {
  const cont = document.getElementById(contenedorId);
  const cfg = CONTENEDORES_CAV[contenedorId];
  if (!cont || !cfg) return;

  const num = Math.max(1, Math.min(24, parseInt(numCavidades, 10) || 1));
  cfg.num = num;
  // Se recuerda para poder repintar sin perderlo (ver redimensionarCavidades).
  cfg.contexto = contextoTerreno || null;

  const datos = datosGuardados || {};
  const terrenoPorCav = {};
  (contextoTerreno || []).forEach(t => { terrenoPorCav[Number(t.cavidad)] = t; });

  let chips = '';
  let paneles = '';

  for (let c = 1; c <= num; c++) {
    chips += `<button type="button" class="cav-chip" data-cav-ir="${c}" data-cont="${contenedorId}">${c}</button>`;

    const filas = cfg.campos.map(f => filaMedicionHTML(cfg.prefijo, c, f, datos[c] || {})).join('');

    // Resumen de lo que midio terreno en esta misma cavidad (solo en laboratorio).
    let ctx = '';
    const t = terrenoPorCav[c];
    if (t) {
      ctx = `<div class="cav-contexto">📋 Terreno cav ${c} &nbsp;·&nbsp;
        Color: <b>${escapeHTML(t.color_med || '-')}</b> &nbsp;·&nbsp;
        Ciclo: <b>${escapeHTML(t.ciclo_med || '-')}</b> &nbsp;·&nbsp;
        Peso: <b>${escapeHTML(t.peso_med || '-')}</b> &nbsp;·&nbsp;
        Probador: <b>${escapeHTML(t.probador_med || '-')}</b></div>`;
    }

    paneles += `<div class="cav-panel${c === 1 ? ' activa' : ''}" data-cav="${c}">
      <div class="cav-panel-head">
        <span class="cav-titulo">🔹 CAVIDAD ${c} <small>de ${num}</small></span>
        <button type="button" class="cav-copiar" data-cav-copiar="${c}" data-cont="${contenedorId}">⧉ Copiar a todas</button>
      </div>
      ${ctx}
      ${filas}
      <div class="cav-pie">
        <button type="button" class="cav-nav-btn" data-cav-nav="prev" data-cont="${contenedorId}">‹ Anterior</button>
        <button type="button" class="cav-nav-btn" data-cav-nav="next" data-cont="${contenedorId}">Siguiente ›</button>
      </div>
    </div>`;
  }

  cont.innerHTML = `
    <div class="cav-barra">
      <div class="cav-chips">${chips}</div>
      <div class="cav-progreso" data-progreso="${contenedorId}"></div>
    </div>
    <div class="cav-paneles">${paneles}</div>`;

  // C1: los valores restaurados tambien se validan, y se escriben los rangos.
  refrescarValidacion(contenedorId);
  // C2: y se avisa si alguna cavidad viene fallando.
  refrescarAlertasCavidad(contenedorId);
  refrescarEstadoCavidades(contenedorId);
}

// Wrappers: conservan los nombres que ya usaba el resto de la app.
function renderContenedorCavidadesTerreno(num, datos) {
  renderCavidades('contenedor-cavidades-terreno', num, datos);
}
function renderContenedorCavidadesLab(num, datos, contextoTerreno) {
  renderCavidades('contenedor-cavidades-lab', num, datos, contextoTerreno);
}

// gris / ambar / verde / rojo segun lo que lleva escrito la cavidad
function estadoCavidad(prefijo, campos, c) {
  let vacios = 0, noCumple = 0, escritos = 0, noAplica = 0;

  campos.forEach(f => {
    const val = document.getElementById(`${prefijo}${c}-val-${f.id}`);
    const med = document.getElementById(`${prefijo}${c}-${f.id}`);
    if (!val || !med) return;
    if (val.value === 'No Aplica') { noAplica++; return; }
    if (val.value === 'No Cumple') noCumple++;
    if (med.value.trim()) escritos++; else vacios++;
  });

  if (noCumple > 0 && vacios === 0) return 'nocumple';
  if (vacios > 0) return (escritos > 0 || noAplica > 0) ? 'incompleta' : 'vacia';
  return 'completa';
}

function refrescarEstadoCavidades(contenedorId) {
  const cfg = CONTENEDORES_CAV[contenedorId];
  const cont = document.getElementById(contenedorId);
  if (!cfg || !cont || !cfg.num) return;

  let completas = 0, conFalla = 0;

  for (let c = 1; c <= cfg.num; c++) {
    const estado = estadoCavidad(cfg.prefijo, cfg.campos, c);
    if (estado === 'completa' || estado === 'nocumple') completas++;
    if (estado === 'nocumple') conFalla++;

    const chip = cont.querySelector(`.cav-chip[data-cav-ir="${c}"]`);
    if (chip) {
      // Se reconstruye la clase entera, asi que hay que reponer las marcas que
      // no dependen del estado actual: la de cavidad activa y la de C2.
      const activa = chip.classList.contains('activa') ? ' activa' : '';
      const recurrente = chip.classList.contains('cav-recurrente') ? ' cav-recurrente' : '';
      chip.className = 'cav-chip cav-' + estado + activa + recurrente;
    }
  }

  const activa = cont.querySelector('.cav-panel.activa');
  const nro = activa ? activa.dataset.cav : 1;
  const chipActivo = cont.querySelector(`.cav-chip[data-cav-ir="${nro}"]`);
  if (chipActivo) chipActivo.classList.add('activa');

  const prog = cont.querySelector(`[data-progreso="${contenedorId}"]`);
  if (prog) {
    const pendientes = cfg.num - completas;
    prog.innerHTML = pendientes > 0
      ? `<span class="prog-pend">${pendientes} cavidad(es) por completar</span>`
      : (conFalla > 0
          ? `<span class="prog-falla">✓ ${cfg.num} completas · ${conFalla} con No Cumple</span>`
          : `<span class="prog-ok">✓ ${cfg.num} cavidades completas</span>`);
  }
}

function irACavidad(contenedorId, nro) {
  const cont = document.getElementById(contenedorId);
  const cfg = CONTENEDORES_CAV[contenedorId];
  if (!cont || !cfg) return;

  const destino = Math.max(1, Math.min(cfg.num, nro));
  cont.querySelectorAll('.cav-panel').forEach(p => {
    p.classList.toggle('activa', Number(p.dataset.cav) === destino);
  });
  cont.querySelectorAll('.cav-chip').forEach(ch => {
    ch.classList.toggle('activa', Number(ch.dataset.cavIr) === destino);
  });

  const chip = cont.querySelector(`.cav-chip[data-cav-ir="${destino}"]`);
  if (chip && chip.scrollIntoView) chip.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function cavidadActiva(contenedorId) {
  const activa = document.querySelector(`#${contenedorId} .cav-panel.activa`);
  return activa ? Number(activa.dataset.cav) : 1;
}

// Copia la cavidad visible al resto. En la practica color y probador se repiten
// en todo el molde, asi solo hay que corregir peso y ciclo.
function copiarCavidadATodas(contenedorId, origen) {
  const cfg = CONTENEDORES_CAV[contenedorId];
  if (!cfg || cfg.num < 2) return;
  if (!confirm(`¿Copiar los valores de la cavidad ${origen} a las otras ${cfg.num - 1}?\n\nSe sobrescribe lo que ya esté escrito.`)) return;

  cfg.campos.forEach(f => {
    const medOrig = document.getElementById(`${cfg.prefijo}${origen}-${f.id}`);
    const valOrig = document.getElementById(`${cfg.prefijo}${origen}-val-${f.id}`);
    if (!medOrig || !valOrig) return;

    for (let c = 1; c <= cfg.num; c++) {
      if (c === origen) continue;
      const med = document.getElementById(`${cfg.prefijo}${c}-${f.id}`);
      const val = document.getElementById(`${cfg.prefijo}${c}-val-${f.id}`);
      const btn = document.querySelector(`.btn-toggle[data-target="${cfg.prefijo}${c}-val-${f.id}"]`);
      if (med) { med.value = medOrig.value; med.style.borderColor = '#64748b'; }
      if (val) val.value = valOrig.value;
      if (btn) { btn.className = 'btn-toggle ' + claseToggle(valOrig.value); btn.innerText = valOrig.value; }
    }
  });

  refrescarEstadoCavidades(contenedorId);
}

// Un solo listener delegado para los dos contenedores.
function setupNavegacionCavidades() {
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cav-ir]');
    if (chip) { e.preventDefault(); irACavidad(chip.dataset.cont, Number(chip.dataset.cavIr)); return; }

    const nav = e.target.closest('[data-cav-nav]');
    if (nav) {
      e.preventDefault();
      const cont = nav.dataset.cont;
      irACavidad(cont, cavidadActiva(cont) + (nav.dataset.cavNav === 'next' ? 1 : -1));
      return;
    }

    const copiar = e.target.closest('[data-cav-copiar]');
    if (copiar) { e.preventDefault(); copiarCavidadATodas(copiar.dataset.cont, Number(copiar.dataset.cavCopiar)); }
  });

  ['input', 'change'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      const cont = e.target.closest('#contenedor-cavidades-terreno, #contenedor-cavidades-lab');
      if (cont) refrescarEstadoCavidades(cont.id);
    });
  });
}

/*
 * Lee el estado actual de TODAS las cavidades que hay en el DOM.
 *
 * Devuelve tambien las vacias a proposito: si solo devolviera las que tienen
 * algo escrito, un dato que el inspector borro no quedaria registrado como
 * borrado y la memoria lo haria reaparecer en el siguiente repintado.
 */
function leerCavidadesDOM(contenedorId) {
  const cfg = CONTENEDORES_CAV[contenedorId];
  const datos = {};
  if (!cfg || !cfg.num) return datos;

  for (let c = 1; c <= cfg.num; c++) {
    const fila = {};
    cfg.campos.forEach(f => {
      const med = document.getElementById(`${cfg.prefijo}${c}-${f.id}`);
      const val = document.getElementById(`${cfg.prefijo}${c}-val-${f.id}`);
      if (med) fila[f.clave + '_med'] = med.value;
      if (val) {
        fila[f.clave + '_val'] = val.value;
        fila[f.clave + '_manual'] = val.dataset.manual === '1' ? '1' : '';
      }
    });
    datos[c] = fila;
  }
  return datos;
}

/* ===================================================================
 * MEMORIA DE CAVIDADES
 *
 * Leer el DOM antes de repintar alcanza mientras la cavidad siga en pantalla.
 * El problema es lo que se va: bajar de 12 a 8 destruye las cavidades 9 a 12 y
 * con ellas todo lo medido, sin aviso y sin vuelta atras.
 *
 * Dos situaciones reales lo disparan:
 *   - "me equivoque, eran 12" -> bajar y volver a subir;
 *   - escribir 18 sobre 12: el evento `input` llega tecla por tecla, asi que
 *     antes de 18 pasa por 1 y el formulario se queda en UNA cavidad.
 *
 * Por eso lo medido vive fuera del DOM. Solo se olvida cuando la ronda termina
 * o se carga otra: si no, los datos de una ronda apareceran en la siguiente,
 * que es peor que el problema original.
 * =================================================================== */

const MEMORIA_CAV = {
  'contenedor-cavidades-terreno': {},
  'contenedor-cavidades-lab': {}
};

// Vuelca el DOM sobre la memoria. Las cavidades que ya no estan en pantalla
// conservan lo suyo; las que estan mandan su valor actual.
function recordarCavidades(contenedorId) {
  const mem = MEMORIA_CAV[contenedorId] || (MEMORIA_CAV[contenedorId] = {});
  const leido = leerCavidadesDOM(contenedorId);
  Object.keys(leido).forEach(c => { mem[c] = leido[c]; });
  return mem;
}

function olvidarCavidades(contenedorId) {
  if (contenedorId) MEMORIA_CAV[contenedorId] = {};
  else Object.keys(MEMORIA_CAV).forEach(k => { MEMORIA_CAV[k] = {}; });
}

// Repinta ambos contenedores conservando lo ingresado, incluso lo de las
// cavidades que habian salido del formulario.
function redimensionarCavidades(num) {
  const datosTerreno = recordarCavidades('contenedor-cavidades-terreno');
  const datosLab = recordarCavidades('contenedor-cavidades-lab');
  const ctxLab = CONTENEDORES_CAV['contenedor-cavidades-lab'].contexto;

  renderContenedorCavidadesTerreno(num, datosTerreno);
  renderContenedorCavidadesLab(num, datosLab, ctxLab);
}

/*
 * Recolecta las cavidades para el payload. Es la UNICA fuente de las llaves que
 * viajan al backend, asi terreno y laboratorio no pueden desincronizarse.
 */
function recopilarCavidades(contenedorId) {
  const cfg = CONTENEDORES_CAV[contenedorId];
  const salida = [];
  if (!cfg) return salida;

  for (let c = 1; c <= cfg.num; c++) {
    const registro = { cavidad: c };
    cfg.campos.forEach(f => {
      const val = document.getElementById(`${cfg.prefijo}${c}-val-${f.id}`);
      const med = document.getElementById(`${cfg.prefijo}${c}-${f.id}`);
      const estado = val ? val.value : 'Cumple';
      registro[f.clave + '_val'] = estado;
      registro[f.clave + '_med'] = (estado === 'No Aplica')
        ? 'N/A'
        : ((med && med.value.trim()) ? med.value.trim() : 'N/A');
    });
    salida.push(registro);
  }
  return salida;
}

// Devuelve [{cavidad, campo}] de todo lo que falta por llenar.
function faltantesCavidades(contenedorId) {
  const cfg = CONTENEDORES_CAV[contenedorId];
  const faltantes = [];
  if (!cfg) return faltantes;

  for (let c = 1; c <= cfg.num; c++) {
    cfg.campos.forEach(f => {
      const val = document.getElementById(`${cfg.prefijo}${c}-val-${f.id}`);
      const med = document.getElementById(`${cfg.prefijo}${c}-${f.id}`);
      if (!val || !med) return;
      if (val.value === 'No Aplica') { med.style.borderColor = '#64748b'; return; }
      if (!med.value.trim()) {
        med.style.borderColor = '#ef4444';
        faltantes.push({ cavidad: c, campo: f.label });
      } else {
        med.style.borderColor = '#64748b';
      }
    });
  }
  return faltantes;
}

// Alerta unica: resume y deja al usuario parado en la primera cavidad incompleta.
function avisarFaltantes(contenedorId, faltantes) {
  const detalle = faltantes.slice(0, 8).map(f => `Cavidad ${f.cavidad} · ${f.campo}`).join('\n• ');
  const extra = faltantes.length > 8 ? `\n...y ${faltantes.length - 8} más.` : '';
  alert(`⚠️ Faltan datos (o márcalos como "No Aplica"):\n\n• ${detalle}${extra}`);
  irACavidad(contenedorId, faltantes[0].cavidad);
}

function recopilarDatosIdentificacionMultiCavidad() {
  const cavidadesTerreno = recopilarCavidades('contenedor-cavidades-terreno');
  return {
    maquinaId: document.getElementById('select-maquina').value,
    productoId: document.getElementById('select-producto').value,
    operario: document.getElementById('input-search-operario').value,
    lote_mp: document.getElementById('input-lote-mp').value,
    lote_bxa: document.getElementById('input-lote-bxa').value,
    cavidad_molde: cavidadesTerreno.length,
    cavidadesTerreno: cavidadesTerreno,
    // ACTA: se registran aca porque es cuando se saben.
    accion_correctiva: (document.getElementById('input-accion-correctiva') || {}).value || '',
    responsable: (document.getElementById('input-responsable') || {}).value || ''
  };
}

function recopilarDatosMedicionesMultiCavidad() {
  const medicionesPorCavidad = recopilarCavidades('contenedor-cavidades-lab');
  return {
    observaciones: document.getElementById('input-observaciones').value,
    cavidad_molde: medicionesPorCavidad.length,
    medicionesPorCavidad: medicionesPorCavidad
  };
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
  document.getElementById('input-obs-parada').value = '';
  // Las observaciones son puntuales de cada ronda. Este textarea era el unico
  // campo del formulario que nadie limpiaba, asi que el comentario de la ronda
  // anterior quedaba a la vista y se volvia a guardar sin que nadie lo escribiera.
  const obsLab = document.getElementById('input-observaciones');
  if (obsLab) obsLab.value = '';
  const banner = document.getElementById('banner-maquina-detenida');
  if (banner) { banner.style.display = 'none'; banner.innerText = ''; }
  const accCorr = document.getElementById('input-accion-correctiva');
  if (accCorr) accCorr.value = '';
  const respCorr = document.getElementById('input-responsable');
  if (respCorr) respCorr.value = '';
  const selMotivo = document.getElementById('select-motivo-parada');
  if (selMotivo) selMotivo.selectedIndex = 0;
  
  const chk = document.getElementById('check-maquina-detenida');
  if (chk) chk.checked = false;
  toggleModoDetenida(false);

  document.getElementById('specs-banner').style.display = 'none';

  // Empezar de cero es exactamente el momento de olvidar: si no, lo medido en
  // la ronda anterior reaparece al subir el numero de cavidades en la siguiente.
  olvidarCavidades();
  renderContenedorCavidadesTerreno(1);
  renderContenedorCavidadesLab(1);
}

function resetFormularioCompleto() {
  setRondaActiva(null);
  resetFormularioIdentificacion();
}

/* ===================================================================
 * ID DE ENVIO ESTABLE (anti-duplicados)
 *
 * Antes el identificador se acuñaba DENTRO del click:
 *     const idRonda = 'INSP-' + Date.now();
 *
 * Eso protege de los reintentos automaticos de la cola, que reenvian el mismo
 * payload con el mismo id y chocan con la idempotencia del backend. Pero no
 * protege de la persona. Si el servidor tarda mas de TIMEOUT_RED_MS, el fetch se
 * aborta sin saber si la escritura ocurrio o no, y basta con que el inspector
 * vuelva a pulsar para que salga un Date.now() distinto: id nuevo, fila nueva,
 * ronda repetida en la planilla. Por eso pasaba "algunas veces" y no siempre.
 *
 * Ahora el id se acuña UNA vez y se conserva hasta que el envio queda resuelto
 * (confirmado por el backend, o guardado en la cola con ese mismo id). Si se
 * pulsa dos, tres o cuatro veces, las cuatro viaja el mismo identificador y el
 * servidor reconoce que es el mismo registro.
 * =================================================================== */
const CLAVE_ID_ENVIO = 'id_envio_en_curso';

function idEnvioEstable(prefijo) {
  const guardado = sessionStorage.getItem(CLAVE_ID_ENVIO);
  if (guardado && guardado.indexOf(prefijo) === 0) return guardado;
  const nuevo = prefijo + Date.now();
  sessionStorage.setItem(CLAVE_ID_ENVIO, nuevo);
  return nuevo;
}

/*
 * Se llama cuando el envio dejo de estar en el aire: o el backend lo confirmo, o
 * quedo en la cola offline (que ya tiene el id dentro del payload y lo reusara en
 * cada reintento). A partir de aca, el proximo registro merece un id nuevo.
 */
function liberarIdEnvio() {
  sessionStorage.removeItem(CLAVE_ID_ENVIO);
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
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;">No hay rondas pendientes de laboratorio.</td></tr>`;
    return;
  }

  // Rondas cuyo cierre ya esta esperando en la cola: no deben poder cerrarse otra vez.
  const enCola = new Set(colaCache
    .filter(i => i.accion === 'cerrarRonda' && i.estado === 'pendiente')
    .map(i => i.payload && i.payload.idRonda));

  tbody.innerHTML = pendientesCache.map(p => `
    <tr>
      <td>${escapeHTML(p.fechaHora)}</td>
      <td>${escapeHTML(p.maquina)}</td>
      <td>${escapeHTML(p.producto)}</td>
      <td>${escapeHTML(p.correlativoMaquina || '-')}</td>
      <td>${escapeHTML(p.cavidadMolde || 1)}</td>
      <td>${escapeHTML(p.inspector)}</td>
      <td style="display:flex; gap:5px;">
        ${enCola.has(p.idInspeccion)
          ? '<span style="color:#fbbf24; font-size:0.8rem; font-weight:bold;">⏳ Cierre en cola</span>'
          : (rol === 'Laboratorio'
            ? `<button type="button" class="btn btn-primary" style="height:35px; padding:0 10px;"
                       data-pendiente-cargar="${escapeHTML(p.idInspeccion)}">▶️ Completar</button>
               <button type="button" class="btn btn-danger" style="height:35px; padding:0 10px;"
                       data-pendiente-cancelar="${escapeHTML(p.idInspeccion)}">🗑️</button>`
            : '<span style="color:#94a3b8; font-size:0.8rem;">Solo Lab</span>')}
      </td>
    </tr>
  `).join('');
}

// CORREGIDO: Cargar ronda pendiente sin errores de referencia y con cambio de pantalla
window.cargarPendiente = function (id) {
  const rol = sessionStorage.getItem('rol_calidad');
  if (rol !== 'Laboratorio') return;

  const pendiente = pendientesCache.find(p => p.idInspeccion === id);
  if (!pendiente) {
    alert("Esa ronda ya no está pendiente. Actualizando lista...");
    loadCatalogData();
    return;
  }

  const numCav = parseInt(pendiente.cavidadMolde, 10) || 1;

  // Llenar campos internos
  const selMaq = document.getElementById('select-maquina');
  const selProd = document.getElementById('select-producto');
  const inCav = document.getElementById('input-cavidad');

  if (selMaq) selMaq.value = pendiente.maquina;
  if (selProd) selProd.value = pendiente.producto;
  if (inCav) inCav.value = numCav;
  
  // Resumen visual de Terreno en el Banner
  const infoMaq = document.getElementById('ronda-info-maquina');
  const infoProd = document.getElementById('ronda-info-producto');
  const infoOp = document.getElementById('ronda-info-operario');
  const infoCav = document.getElementById('ronda-info-cavidad');
  const infoLoteMp = document.getElementById('ronda-info-lotemp');
  const infoLoteBxa = document.getElementById('ronda-info-lotebxa');
  const infoInsp = document.getElementById('ronda-info-inspector');

  if (infoMaq) infoMaq.innerText = pendiente.maquina || '-';
  if (infoProd) infoProd.innerText = pendiente.producto || '-';
  if (infoOp) infoOp.innerText = pendiente.operario || '-';
  if (infoCav) infoCav.innerText = numCav;
  if (infoLoteMp) infoLoteMp.innerText = pendiente.loteMp || '-';
  if (infoLoteBxa) infoLoteBxa.innerText = pendiente.loteBxa || '-';
  if (infoInsp) infoInsp.innerText = pendiente.inspector || '-';

  actualizarFichaProducto(pendiente.producto);
  // Ronda nueva, observaciones en blanco. Sin esto el textarea conservaba el
  // comentario de la ronda que el laboratorio cerro antes y se guardaba de nuevo.
  const obsRonda = document.getElementById('input-observaciones');
  if (obsRonda) obsRonda.value = '';
  // Otra ronda, otras mediciones: nada de la anterior puede seguir en memoria.
  olvidarCavidades('contenedor-cavidades-lab');
  // El laboratorio ve, en cada cavidad, lo que terreno midio en ESA misma cavidad.
  renderContenedorCavidadesLab(numCav, null, pendiente.cavidadesTerreno);

  setRondaActiva(pendiente.idInspeccion);
  irAVista('view-nueva');
};

window.cancelarPendiente = async function (id) {
  if (!confirm("¿Descartar esta ronda pendiente? Se perderá el registro.")) return;
  // postAccion ya avisa con el mensaje real del backend si la cancelacion fallo.
  const ok = await postAccion({ action: 'cancelarRonda', idRonda: id });
  if (ok) await loadCatalogData();
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
              // C2: la alerta depende de la maquina tanto como del producto.
              if (cfg.type === 'maquina') {
                refrescarAlertasCavidad();
                actualizarBannerDetenida();
                // Si esta detenida, hay que resolverlo antes de seguir cargando.
                abrirModalReactivar(item.id);
              }
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

function actualizarFichaProducto(prodId) {
  const selected = productosCache.find(p => p.id === prodId || p.nombre === prodId);
  const banner = document.getElementById('specs-banner');

  // C1: cambiar de producto cambia los rangos, asi que hay que revalidar lo
  // que ya estuviera escrito. Sin esto quedarian veredictos del producto anterior.
  toleranciasActivas = (selected && selected.tolerancias) ? selected.tolerancias : {};
  actualizarAvisoTolerancias(selected);
  refrescarValidacion();
  // C2: el producto define contra que historial se comparan las cavidades.
  refrescarAlertasCavidad();

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

/*
 * Dice en el banner cuantas variables se validan solas y cuales no.
 *
 * Es informacion accionable: una variable "sin rango" casi siempre significa
 * que en Productos_Specs quedo el nominal sin tolerancia, y se arregla
 * escribiendo la celda como "23.5 +/- 0.5" o agregando peso_min / peso_max.
 */
function actualizarAvisoTolerancias(producto) {
  const caja = document.getElementById('specs-validacion');
  if (!caja) return;

  if (!producto) { caja.innerText = ''; caja.className = 'specs-validacion'; return; }

  const claves = Object.keys(SPEC_DE_CAMPO);
  const conRango = claves.filter(k => rangoDeCampo(k) !== null);
  const sinRango = claves.filter(k => rangoDeCampo(k) === null);

  const nombre = {
    peso: 'Peso', ciclo: 'Ciclo', espesor: 'Espesor', hcuello: 'H Cuello',
    phi_int: 'Φ Interior', phi_hilo: 'Φ Hilo', phi_trinquete: 'Φ Trinquete',
    rebalse: 'Rebalse'
  };

  if (conRango.length === 0) {
    caja.className = 'specs-validacion specs-validacion-nula';
    caja.innerText = '⚠️ Este producto no tiene tolerancias numéricas cargadas: ' +
                     'Cumple / No Cumple se marca a mano, como hasta ahora.';
    return;
  }

  caja.className = 'specs-validacion';
  let txt = `✅ ${conRango.length} de ${claves.length} variables se validan solas ` +
            `(${conRango.map(k => nombre[k]).join(', ')}).`;
  if (sinRango.length > 0) {
    txt += ` Sin rango en la planilla: ${sinRango.map(k => nombre[k]).join(', ')} — ` +
           `esas se marcan a mano.`;
  }
  caja.innerText = txt;
}

function setupEventListeners() {
  const entrar = () => {
    const user = document.getElementById('login-inspector').value;
    const rol = document.getElementById('login-rol').value;
    const pin = document.getElementById('login-pin').value;
    const error = document.getElementById('login-error');

    if (!user) { error.innerText = '\u26a0\ufe0f Selecciona un inspector.'; return; }
    if (!rol) { error.innerText = '\u26a0\ufe0f Selecciona el rol de este turno.'; return; }
    if (!PIN_VALIDO(pin)) { error.innerText = '\u26a0\ufe0f PIN incorrecto.'; return; }

    error.innerText = '';
    aplicarSesion(user.trim(), rol);
  };

  document.getElementById('btn-login').addEventListener('click', entrar);

  // En la tablet el PIN se escribe con teclado numerico: Enter tiene que entrar.
  const inputPin = document.getElementById('login-pin');
  if (inputPin) inputPin.addEventListener('keydown', (e) => { if (e.key === 'Enter') entrar(); });

  // Relevo rapido: abre la pantalla de sesion SIN cerrar la actual. Si el
  // inspector cancela, no se perdio nada.
  const btnCambiar = document.getElementById('btn-cambiar-inspector');
  if (btnCambiar) btnCambiar.addEventListener('click', () => mostrarLogin(true));

  const btnLoginCancelar = document.getElementById('btn-login-cancelar');
  if (btnLoginCancelar) btnLoginCancelar.addEventListener('click', () => {
    if (haySesion()) ocultarLogin();
  });

  document.getElementById('btn-logout').addEventListener('click', () => cerrarSesion(false));

  /*
   * Botones de la tabla de pendientes. Antes eran onclick="..." con el id
   * interpolado dentro del atributo; el id viaja ahora en un data-* y nunca
   * se ejecuta como codigo.
   */
  document.addEventListener('click', (e) => {
    const cargar = e.target.closest('[data-pendiente-cargar]');
    if (cargar) { cargarPendiente(cargar.dataset.pendienteCargar); return; }

    const cancelar = e.target.closest('[data-pendiente-cancelar]');
    if (cancelar) cancelarPendiente(cancelar.dataset.pendienteCancelar);
  });

  const chkDetenida = document.getElementById('check-maquina-detenida');
  if (chkDetenida) {
    chkDetenida.addEventListener('change', (e) => {
      toggleModoDetenida(e.target.checked);
    });
  }

  const btnDetenida = document.getElementById('btn-registrar-detenida');
  if (btnDetenida) {
    btnDetenida.addEventListener('click', async () => {
      const maquinaId = document.getElementById('select-maquina').value;
      if (!maquinaId) {
        alert("⚠️ Selecciona la máquina que se encuentra detenida.");
        return;
      }

      const inputObs = document.getElementById('input-obs-parada');
      const motivo = document.getElementById('select-motivo-parada').value;
      const obs = inputObs.value.trim();

      // "Otro Motivo" sin detalle deja un registro inservible para el reporte de turno.
      if (motivo === 'Otro Motivo' && !obs) {
        alert("⚠️ Elegiste \"Otro Motivo\": describe la causa en el detalle.");
        inputObs.focus();
        return;
      }

      const detalleObs = obs ? `[DETENIDA - ${motivo}]: ${obs}` : `[DETENIDA - ${motivo}]`;
      const idDetencion = idEnvioEstable('DETENIDA-');

      btnDetenida.disabled = true;
      btnDetenida.innerText = "Registrando Detención...";

      try {
        const resultado = await enviarConCola({
          action: 'registrarDetencion',
          idRonda: idDetencion,
          inspector_calidad: sessionStorage.getItem('usuario_calidad'),
          id_maquina: maquinaId,
          motivo_parada: motivo,
          observaciones: detalleObs
        }, `Detención · ${maquinaId} · ${motivo}`);

        if (resultado.encolado) {
          liberarIdEnvio();
          alert(mensajeEncolado(`Detención de ${maquinaId} (${motivo})`, colaPendientes().length, resultado.reintentable));
          resetFormularioIdentificacion();
          return;
        }

        if (!resultado.ok) { alert(mensajeErrorRed(resultado)); return; }

        liberarIdEnvio();

        const d = resultado.data;
        alert(`\u26d4 Máquina ${maquinaId} registrada como DETENIDA.\n\n` +
              `Motivo: ${d.motivo}\n` +
              `Hora: ${d.hora}  (${d.turno})\n\n` +
              `Es un evento puntual del turno: la máquina sigue disponible para las próximas inspecciones.`);

        resetFormularioIdentificacion();
        await loadCatalogData();
      } finally {
        btnDetenida.disabled = false;
        btnDetenida.innerText = "⛔ Registrar Máquina Detenida";
      }
    });
  }

  // BOTÓN: ENVIAR A LABORATORIO (TERRENO MULTI-CAVIDAD)
  document.getElementById('btn-iniciar-ronda').addEventListener('click', async () => {
    const dataIdent = recopilarDatosIdentificacionMultiCavidad();
    if (!dataIdent.maquinaId || !dataIdent.productoId) {
      alert("⚠️ Selecciona al menos Máquina y Producto para enviar a laboratorio.");
      return;
    }

    const numCav = dataIdent.cavidad_molde;

    const faltantes = faltantesCavidades('contenedor-cavidades-terreno');
    if (faltantes.length > 0) {
      avisarFaltantes('contenedor-cavidades-terreno', faltantes);
      return;
    }

    const btn = document.getElementById('btn-iniciar-ronda');
    // Estable: si este envio ya salio una vez y no se confirmo, se reusa el mismo
    // id para que el backend lo reconozca en vez de escribir una fila nueva.
    const idRonda = idEnvioEstable('INSP-');
    btn.disabled = true; btn.innerText = "Enviando a Laboratorio...";

    try {
      // La cavidad 1 viaja tambien en llaves planas: la cabecera la conserva para
      // el historial y el grafico. El array lleva LAS 24.
      const primeraCav = dataIdent.cavidadesTerreno[0] || {};

      const resultado = await enviarConCola({
        action: 'crearRonda',
        idRonda: idRonda,
        inspector_calidad: sessionStorage.getItem('usuario_calidad'),
        id_maquina: dataIdent.maquinaId,
        id_producto: dataIdent.productoId,
        operario: dataIdent.operario,
        lote_mp: dataIdent.lote_mp,
        lote_bxa: dataIdent.lote_bxa,
        cavidad_molde: numCav,
        cavidadesTerreno: dataIdent.cavidadesTerreno,
        color_med: primeraCav.color_med, color_val: primeraCav.color_val,
        ciclo_med: primeraCav.ciclo_med, ciclo_val: primeraCav.ciclo_val,
        peso_med: primeraCav.peso_med, peso_val: primeraCav.peso_val,
        probador_med: primeraCav.probador_med, probador_val: primeraCav.probador_val
      }, `Ronda de terreno · ${dataIdent.maquinaId} · ${dataIdent.productoId} · ${numCav} cav.`);

      if (resultado.encolado) {
        // El id ya viaja dentro del payload encolado y se reusara en cada
        // reintento: este envio esta resuelto y el siguiente empieza limpio.
        liberarIdEnvio();
        alert(mensajeEncolado(
          `Ronda de ${dataIdent.maquinaId} (${numCav} cavidades)`, colaPendientes().length, resultado.reintentable));
        resetFormularioIdentificacion();
        return;
      }

      // Rechazo del backend: NO se libera el id. Si la persona corrige y reenvia,
      // tiene que ir con el mismo identificador.
      if (!resultado.ok) { alert(mensajeErrorRed(resultado)); return; }

      liberarIdEnvio();

      const d = resultado.data;
      if (d.duplicado) {
        alert(`\u2139\ufe0f Esta ronda ya estaba registrada.\n\n` +
              `No se creó una copia: se conservó el registro original ${d.id}.\n` +
              `Ronda N° ${d.correlativoMaquina} de esta máquina en el turno.`);
        resetFormularioIdentificacion();
        await loadCatalogData();
        return;
      }

      alert(`🧪 Inspección enviada a Laboratorio.\n\n` +
            `Cavidades registradas: ${d.cavidadesRegistradas} de ${d.cavidadesDeclaradas}\n` +
            `Ronda N° ${d.correlativoMaquina} de esta máquina en el turno.`);

      resetFormularioIdentificacion();
      await loadCatalogData();
    } finally {
      btn.disabled = false; btn.innerText = "🧪 Enviar a Laboratorio";
    }
  });

  // BOTÓN: CERRAR Y GUARDAR REGISTRO FINAL (LABORATORIO MULTI-CAVIDAD)
  document.getElementById('btn-cerrar-ronda').addEventListener('click', async () => {
    if (!currentRondaId) { alert("No hay una ronda seleccionada."); return; }

    const numCavidades = CONTENEDORES_CAV['contenedor-cavidades-lab'].num || 1;

    const faltantes = faltantesCavidades('contenedor-cavidades-lab');
    if (faltantes.length > 0) {
      avisarFaltantes('contenedor-cavidades-lab', faltantes);
      return;
    }

    const btn = document.getElementById('btn-cerrar-ronda');
    const idCerrado = currentRondaId;
    btn.disabled = true; btn.innerText = "Guardando en Drive (Multicavidad)...";

    const payload = Object.assign(
      { action: 'cerrarRonda', idRonda: currentRondaId, inspector_lab: sessionStorage.getItem('usuario_calidad') },
      recopilarDatosMedicionesMultiCavidad()
    );

    try {
      const resultado = await enviarConCola(
        payload, `Cierre de laboratorio · ${idCerrado} · ${numCavidades} cav.`);

      if (resultado.encolado) {
        alert(mensajeEncolado(`Cierre de laboratorio de ${idCerrado}`, colaPendientes().length, resultado.reintentable));
        resetFormularioCompleto();
        document.querySelector('.nav-tab[data-target="view-borradores"]').click();
        return;
      }

      if (!resultado.ok) { alert(mensajeErrorRed(resultado)); return; }

      const d = resultado.data;
      let resumen = `\u2705 Registro cerrado y guardado en Google Drive.\n\n` +
                    `Cavidades registradas: ${d.cavidadesGuardadas} de ${d.cavidadesDeclaradas}`;

      if (d.cavidadesSinEnsayar) {
        resumen += `\n\u26a0\ufe0f ${d.cavidadesSinEnsayar} cavidad(es) quedaron sin ensayar (No Aplica).`;
      }
      resumen += d.desviaciones
        ? `\n\u274c ${d.desviaciones} característica(s) fuera de especificación.`
        : `\n\u2713 Todas las características dentro de especificación.`;

      alert(resumen);

      resetFormularioCompleto();
      await loadCatalogData();
      const rolActual = sessionStorage.getItem('rol_calidad');
      const siguienteTab = rolActual === 'Laboratorio' ? 'view-borradores' : 'view-nueva';
      document.querySelector(`.nav-tab[data-target="${siguienteTab}"]`).click();
    } finally {
      btn.disabled = false; btn.innerText = "✅ GUARDAR REGISTRO FINAL (MULTICAVIDAD)";
    }
  });

  document.getElementById('btn-cancelar-ronda').addEventListener('click', () => {
    resetFormularioCompleto();
    document.querySelector('.nav-tab[data-target="view-borradores"]').click();
  });

  document.getElementById('btn-cerrar-turno').addEventListener('click', cerrarTurno);
  document.getElementById('btn-generar-pdf-ahora').addEventListener('click', generarConsolidado);
  document.getElementById('btn-qr').addEventListener('click', startQRScanner);
  document.getElementById('btn-close-qr').addEventListener('click', stopQRScanner);
  /*
   * El boton llamaba a loadCatalogData() directo. Como esa funcion es async y
   * atrapa sus propios errores (solo console.error), al pulsar no pasaba nada
   * visible: ni mientras cargaba, ni al terminar bien, ni al fallar. Desde la
   * tablet era indistinguible de un boton muerto. Ahora informa los tres casos.
   */
  document.getElementById('btn-refresh-historial').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (btn.disabled) return;              // evita recargas encimadas al doble toque

    const textoOriginal = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '\u23F3 Actualizando...';

    let mensaje = null;
    try {
      const ok = await loadCatalogData();
      btn.innerHTML = ok ? '\u2705 Actualizado' : '\u26A0 Sin conexion';
      if (!ok) {
        mensaje = 'No se pudo actualizar el historial.\n\n' +
                  'Revisa la senal e intentalo de nuevo. Los registros que tengas ' +
                  'en cola no se pierden.';
      }
    } catch (err) {
      btn.innerHTML = '\u26A0 Error';
      mensaje = 'No se pudo actualizar el historial.\n\n' + (err && err.message ? err.message : err);
    } finally {
      setTimeout(() => { btn.innerHTML = textoOriginal; btn.disabled = false; }, 1800);
    }

    if (mensaje) alert(mensaje);           // fuera del finally: no bloquea el reset del boton
  });

  // C3: los tres selectores del analisis repintan el mismo grafico.
  ['select-analisis-producto', 'select-analisis-cavidad', 'select-analisis-variable']
    .forEach(id => {
      const sel = document.getElementById(id);
      if (sel) sel.addEventListener('change', renderAnalisis);
    });
}

// TOGGLE DE 3 ESTADOS: Cumple -> No Cumple -> No Aplica -> Cumple
/*
 * Validacion mientras se escribe.
 *
 * Se espera un momento en vez de evaluar tecla por tecla: escribiendo "23.5"
 * el primer "2" queda fuera de rango y el boton parpadearia en rojo.
 */
function setupValidacionAutomatica() {
  let espera = null;
  let ultimo = null;

  document.addEventListener('input', (e) => {
    const input = e.target;
    if (!input || !input.dataset || !input.dataset.val) return;

    ultimo = input;
    clearTimeout(espera);
    espera = setTimeout(() => {
      evaluarMedicion(ultimo);
      const cont = ultimo.closest('#contenedor-cavidades-terreno, #contenedor-cavidades-lab');
      if (cont) refrescarEstadoCavidades(cont.id);
    }, 250);
  });

  // Al salir del campo se resuelve de inmediato: no se pasa a la cavidad
  // siguiente con el veredicto todavia pendiente.
  document.addEventListener('focusout', (e) => {
    const input = e.target;
    if (!input || !input.dataset || !input.dataset.val) return;
    clearTimeout(espera);
    evaluarMedicion(input);
    const cont = input.closest('#contenedor-cavidades-terreno, #contenedor-cavidades-lab');
    if (cont) refrescarEstadoCavidades(cont.id);
  });
}

/* ===================================================================
 * CAVIDADES CON DESVIACION RECURRENTE (C2)
 *
 * Una cavidad suelta fuera de rango es ruido de proceso. La MISMA cavidad
 * fallando ronda tras ronda no lo es: apunta a un problema fisico de ese
 * postizo -refrigeracion tapada, desgaste, venteo- y se arregla en el molde,
 * no ajustando la maquina.
 *
 * Ese patron es justo el que se pierde en el papel: cada ronda se mira sola.
 * Aca se cruzan las rondas del turno para la maquina y el producto en curso.
 *
 * Que cuenta como racha: rondas CONSECUTIVAS del mismo turno operativo, misma
 * maquina y mismo producto, en las que esa cavidad tuvo al menos un
 * "No Cumple". Una ronda conforme en el medio corta la racha.
 * =================================================================== */

const UMBRAL_RACHA = 2;     // 2 rondas seguidas ya es señal, no casualidad

const NOMBRE_VARIABLE = {
  color: 'Color', espesor: 'Espesor', ciclo: 'Ciclo', peso: 'Peso',
  calce: 'Calce', filtracion: 'Filtración', probador: 'Probador',
  hcuello: 'H Cuello', phi_int: 'Φ Interior', phi_hilo: 'Φ Hilo',
  phi_trinquete: 'Φ Trinquete', rebalse: 'Rebalse', caida: 'Caída'
};

/*
 * Rachas abiertas por cavidad para una maquina y producto.
 *
 * Devuelve { 7: { racha: 3, variables: ['peso'], desde: '...' }, ... }
 * Solo incluye las cavidades que llegan al umbral.
 */
function rachasPorCavidad(maquina, producto, referencia) {
  const salida = {};
  if (!maquina || !producto) return salida;

  const info = infoTurnoOperativo(referencia || new Date());

  // Todas las rondas cerradas del turno para esa maquina y producto, en orden.
  // Hacen falta TODAS, no solo las que fallaron: una ronda conforme corta.
  const rondas = historialCache
    .filter(r => r.maquina === maquina && r.producto === producto &&
                 r.fechaOperativa === info.fechaOperativa &&
                 r.turnoOperativo === info.turno)
    .slice()
    .sort((a, b) => String(a.fechaHora).localeCompare(String(b.fechaHora)));

  if (rondas.length < UMBRAL_RACHA) return salida;

  // Fallas indexadas por ronda y cavidad.
  const fallas = {};
  desviacionesCache.forEach(d => {
    if (d.maquina !== maquina || d.producto !== producto) return;
    if (!fallas[d.idInspeccion]) fallas[d.idInspeccion] = {};
    fallas[d.idInspeccion][Number(d.cavidad)] = d.fallas || [];
  });

  // Cuantas cavidades mirar: el molde mas grande visto en el turno.
  let maxCav = 1;
  rondas.forEach(r => { maxCav = Math.max(maxCav, parseInt(r.cavidadMolde, 10) || 1); });

  for (let cav = 1; cav <= maxCav; cav++) {
    let racha = 0;
    const variables = new Set();
    let desde = '';

    // Desde la ronda mas reciente hacia atras: interesa la racha ABIERTA.
    // Una racha que ya se corto es historia, no una alerta que atender ahora.
    for (let i = rondas.length - 1; i >= 0; i--) {
      const delaRonda = fallas[rondas[i].idInspeccion];
      const dela = delaRonda ? delaRonda[cav] : null;
      if (!dela || dela.length === 0) break;
      racha++;
      dela.forEach(v => variables.add(v));
      desde = rondas[i].fechaHora;
    }

    if (racha >= UMBRAL_RACHA) {
      salida[cav] = { racha, variables: [...variables], desde, total: rondas.length };
    }
  }

  return salida;
}

function textoAlertaCavidad(cav, info) {
  const vars = info.variables.map(v => NOMBRE_VARIABLE[v] || v).join(', ');
  return `⚠️ Cavidad N° ${cav} con ${info.racha} desviaciones consecutivas en este turno` +
         (vars ? ` (${vars}).` : '.') +
         ` Revisar el postizo: no es dispersión de proceso.`;
}

/*
 * Pinta las alertas en los paneles y en los chips.
 *
 * Se inyecta despues de renderizar porque la maquina y el producto se eligen
 * DESPUES de que el contenedor ya esta pintado.
 */
function refrescarAlertasCavidad(contenedorId) {
  const ids = contenedorId
    ? [contenedorId]
    : ['contenedor-cavidades-terreno', 'contenedor-cavidades-lab'];

  const maquina = (document.getElementById('select-maquina') || {}).value || '';
  const producto = (document.getElementById('select-producto') || {}).value || '';
  const rachas = rachasPorCavidad(maquina, producto);

  ids.forEach(id => {
    const cont = document.getElementById(id);
    const cfg = CONTENEDORES_CAV[id];
    if (!cont || !cfg || !cfg.num) return;

    for (let cav = 1; cav <= cfg.num; cav++) {
      const panel = cont.querySelector(`.cav-panel[data-cav="${cav}"]`);
      const chip = cont.querySelector(`.cav-chip[data-cav-ir="${cav}"]`);
      const info = rachas[cav];

      if (chip && chip.classList) chip.classList.toggle('cav-recurrente', !!info);
      if (!panel) continue;

      let aviso = panel.querySelector('.cav-alerta');

      if (!info) {
        if (aviso) aviso.innerHTML = '';
        continue;
      }

      if (!aviso) {
        // El aviso va PRIMERO en el panel: si queda al final, con 9 mediciones
        // el inspector lo lee despues de haber medido.
        const cabecera = panel.querySelector('.cav-panel-head');
        aviso = document.createElement('div');
        aviso.className = 'cav-alerta';
        if (cabecera && cabecera.parentNode === panel) {
          panel.insertBefore(aviso, cabecera.nextSibling);
        } else {
          panel.insertBefore(aviso, panel.firstChild);
        }
      }
      aviso.innerHTML = escapeHTML(textoAlertaCavidad(cav, info));
    }
  });
}

function setupToggles() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-toggle');
    if (!btn) return;
    e.preventDefault();
    const target = document.getElementById(btn.dataset.target);
    const inputFila = btn.closest('.medicion-row')?.querySelector('input:not([type="hidden"])');

    if (btn.classList.contains('active-cumple')) {
      btn.className = 'btn-toggle active-nocumple';
      btn.innerText = 'No Cumple';
      if (target) target.value = 'No Cumple';
    } else if (btn.classList.contains('active-nocumple')) {
      btn.className = 'btn-toggle active-noaplica';
      btn.innerText = 'No Aplica';
      if (target) target.value = 'No Aplica';
      if (inputFila) inputFila.style.borderColor = '#64748b';
    } else {
      btn.className = 'btn-toggle active-cumple';
      btn.innerText = 'Cumple';
      if (target) target.value = 'Cumple';
    }

    // C1: a partir de aca decide la persona. La validacion automatica no
    // vuelve a tocar este campo, que es lo que hace posible dejar "No Aplica".
    if (target) target.dataset.manual = '1';
    const filaMed = btn.closest('.medicion-row');
    if (filaMed && filaMed.classList) {
      filaMed.classList.remove('med-dentro');
      filaMed.classList.remove('med-fuera');
    }

    const cont = btn.closest('#contenedor-cavidades-terreno, #contenedor-cavidades-lab');
    if (cont) refrescarEstadoCavidades(cont.id);
  });
}

/* ===================================================================
 * CAPA DE RED
 *
 * Antes se usaba `mode: 'no-cors'`, que devuelve una respuesta OPACA: no se puede
 * leer ni el codigo HTTP ni el cuerpo, y el fetch resuelve siempre. Con eso la app
 * mostraba "guardado con exito" aunque Apps Script hubiera respondido
 * {status:"error"} o no hubiera respondido nada.
 *
 * Ahora se lee la respuesta real. Detalle clave: el Content-Type es "text/plain"
 * a proposito. Es uno de los tres tipos que el navegador considera "simples", asi
 * que NO dispara el preflight OPTIONS, que Apps Script no sabe responder. El
 * cuerpo sigue siendo JSON y el backend lo lee igual con
 * JSON.parse(e.postData.contents). Usar "application/json" romperia la llamada.
 * =================================================================== */

const TIMEOUT_RED_MS = 25000;

/*
 * Envia una accion y devuelve la respuesta REAL del backend. Nunca lanza:
 *   { ok:true,  data:{...} }
 *   { ok:false, message:'...', sinRed:true|false, data:{...}? }
 */
async function enviarAlBackend(payload) {
  const control = new AbortController();
  // Sin timeout, una red de planta que no responde deja el boton bloqueado para siempre.
  const alarma = setTimeout(() => control.abort(), TIMEOUT_RED_MS);

  let respuesta;
  try {
    respuesta = await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      redirect: 'follow',   // Apps Script responde 302 hacia googleusercontent.com
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: control.signal
    });
  } catch (err) {
    return {
      ok: false,
      sinRed: true,
      message: (err && err.name === 'AbortError')
        ? `El servidor no respondió en ${TIMEOUT_RED_MS / 1000} segundos. No se pudo confirmar si quedó guardado; se reintentará solo.`
        : 'Sin conexión con Google Drive. El registro NO se guardó.'
    };
  } finally {
    clearTimeout(alarma);
  }

  if (!respuesta.ok) {
    return { ok: false, message: `El servidor respondió ${respuesta.status} ${respuesta.statusText}. El registro NO se guardó.` };
  }

  let texto;
  try {
    texto = await respuesta.text();
  } catch (err) {
    return { ok: false, sinRed: true, message: 'Se perdió la conexión al leer la respuesta. El registro NO se guardó.' };
  }

  let datos;
  try {
    datos = JSON.parse(texto);
  } catch (err) {
    // Caso tipico: el despliegue no esta como "Cualquier usuario" y Google
    // devuelve el HTML de la pantalla de inicio de sesion.
    if (/<html|<!doctype/i.test(texto)) {
      return {
        ok: false,
        message: 'Google devolvió una página de inicio de sesión en vez de datos.\n\n' +
                 'Revisa que el Apps Script esté implementado con acceso "Cualquier usuario".'
      };
    }
    return { ok: false, message: 'Respuesta ilegible del servidor:\n' + String(texto).slice(0, 150) };
  }

  if (!datos || datos.status !== 'success') {
    return {
      ok: false,
      data: datos,
      // "busy" es el backend diciendo que no pudo tomar el lock (ver B2). Es una
      // condicion transitoria: hay que reintentar, no descartar el registro.
      reintentable: !!(datos && (datos.reintentable || datos.status === 'busy')),
      message: (datos && datos.message) ? datos.message : 'El servidor rechazó la operación.'
    };
  }

  return { ok: true, data: datos };
}

function mensajeErrorRed(resultado) {
  return (resultado.sinRed ? '📴 SIN CONEXIÓN\n\n' : '❌ NO SE GUARDÓ\n\n') + resultado.message;
}

/*
 * Compatibilidad para los llamados que solo necesitan saber si funciono.
 * A diferencia de antes, `true` ahora significa que el backend CONFIRMO el guardado.
 */
async function postAccion(payload) {
  const resultado = await enviarAlBackend(payload);
  if (!resultado.ok) alert(mensajeErrorRed(resultado));
  return resultado.ok;
}

/* ===================================================================
 * COLA OFFLINE (IndexedDB)
 *
 * El WiFi industrial se corta. Sin cola, un envio fallido se perdia y el
 * inspector tenia que rehacer la ronda de memoria (o no la rehacia).
 *
 * Reglas:
 *  - Solo se encola cuando el fallo es DE RED (resultado.sinRed). Si el backend
 *    rechazo la accion por una razon de negocio, reintentarla daria el mismo
 *    rechazo para siempre y taparia la cola.
 *  - Se envia en orden de insercion, que es el orden cronologico. Importa: el
 *    cierre de laboratorio de una ronda debe ir despues de su creacion.
 *  - Un fallo de red durante la sincronizacion DETIENE el barrido (seguimos sin
 *    señal); un rechazo del backend marca ese item como "error" y continua.
 *  - Nada se borra solo: los items con error quedan visibles para decidir.
 *
 * Los reintentos son seguros porque el backend es idempotente por idRonda: si el
 * primer envio si llego, el segundo responde exito sin duplicar la fila.
 * =================================================================== */

const COLA_DB = 'appcalidad-cola';
const COLA_DB_VERSION = 1;
const COLA_STORE = 'pendientes';
const COLA_REINTENTO_MS = 60000;

let colaDBPromise = null;
let sincronizando = false;
let colaCache = [];
let temporizadorCola = null;

function abrirColaDB() {
  if (colaDBPromise) return colaDBPromise;
  colaDBPromise = new Promise((resolver, rechazar) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      rechazar(new Error('Este navegador no soporta IndexedDB.'));
      return;
    }
    const solicitud = indexedDB.open(COLA_DB, COLA_DB_VERSION);
    solicitud.onupgradeneeded = () => {
      const db = solicitud.result;
      if (!db.objectStoreNames.contains(COLA_STORE)) {
        const almacen = db.createObjectStore(COLA_STORE, { keyPath: 'id', autoIncrement: true });
        almacen.createIndex('estado', 'estado');
        almacen.createIndex('creado', 'creado');
      }
    };
    solicitud.onsuccess = () => resolver(solicitud.result);
    solicitud.onerror = () => rechazar(solicitud.error);
  });
  return colaDBPromise;
}

function colaAgregar(item) {
  return abrirColaDB().then(db => new Promise((resolver, rechazar) => {
    const tx = db.transaction(COLA_STORE, 'readwrite');
    const solicitud = tx.objectStore(COLA_STORE).add(item);
    solicitud.onsuccess = () => { item.id = solicitud.result; };
    tx.oncomplete = () => resolver(item);
    tx.onerror = () => rechazar(tx.error);
    tx.onabort = () => rechazar(tx.error);
  }));
}

function colaGuardar(item) {
  return abrirColaDB().then(db => new Promise((resolver, rechazar) => {
    const tx = db.transaction(COLA_STORE, 'readwrite');
    tx.objectStore(COLA_STORE).put(item);
    tx.oncomplete = () => resolver(item);
    tx.onerror = () => rechazar(tx.error);
  }));
}

function colaEliminar(id) {
  return abrirColaDB().then(db => new Promise((resolver, rechazar) => {
    const tx = db.transaction(COLA_STORE, 'readwrite');
    tx.objectStore(COLA_STORE).delete(id);
    tx.oncomplete = () => resolver(true);
    tx.onerror = () => rechazar(tx.error);
  }));
}

function colaTodos() {
  return abrirColaDB().then(db => new Promise((resolver, rechazar) => {
    const tx = db.transaction(COLA_STORE, 'readonly');
    const solicitud = tx.objectStore(COLA_STORE).getAll();
    // El id es autoincremental, asi que ordenar por id ES el orden cronologico.
    solicitud.onsuccess = () => resolver((solicitud.result || []).sort((a, b) => a.id - b.id));
    tx.onerror = () => rechazar(tx.error);
  }));
}

async function refrescarColaCache() {
  try {
    colaCache = await colaTodos();
  } catch (err) {
    console.error('Cola offline no disponible:', err);
    colaCache = [];
  }
  actualizarIndicadorSync();
  return colaCache;
}

/*
 * C4: como se nombra cada accion en el panel. El inspector no piensa en
 * "crearRonda": piensa en "la ronda de la 3".
 */
const TIPO_ACCION = {
  crearRonda:         { icono: '📋', texto: 'Ronda de terreno' },
  cerrarRonda:        { icono: '🧪', texto: 'Cierre de laboratorio' },
  registrarDetencion: { icono: '⛔', texto: 'Máquina detenida' },
  cancelarRonda:      { icono: '🗑️', texto: 'Cancelación de ronda' },
  cerrarTurno:        { icono: '📊', texto: 'Cierre de turno' },
  generarConsolidado: { icono: '📄', texto: 'PDF consolidado' }
};

const etiquetaAccion = (a) => TIPO_ACCION[a] || { icono: '•', texto: a || 'Registro' };

// Id del registro que se esta enviando en este momento, para poder mostrarlo
// en el panel sin escribir un estado intermedio en IndexedDB.
let idEnviando = null;

const colaPendientes = () => colaCache.filter(i => i.estado === 'pendiente');
const colaConError = () => colaCache.filter(i => i.estado === 'error');

/*
 * Envia y, si el fallo fue de red, encola en vez de perder el registro.
 * Devuelve el resultado de enviarAlBackend con `encolado:true` cuando quedo guardado local.
 */
async function enviarConCola(payload, descripcion) {
  const resultado = await enviarAlBackend(payload);
  if (resultado.ok) {
    // Si esta llamada funciono estamos en linea: buen momento para vaciar la cola.
    if (colaPendientes().length > 0) sincronizarCola(false);
    return resultado;
  }

  // Rechazo definitivo del backend: NO se encola, reintentarlo daria el mismo rechazo.
  // Un "busy" si se encola: el servidor estaba ocupado, no rechazo el contenido.
  if (!resultado.sinRed && !resultado.reintentable) return resultado;

  try {
    await colaAgregar({
      creado: new Date().toISOString(),
      accion: payload.action,
      // C4: el panel muestra la maquina, asi que se guarda aparte en vez de
      // depender de que venga escrita dentro de la descripcion.
      maquina: payload.id_maquina || '',
      descripcion: descripcion || payload.action,
      payload: payload,
      estado: 'pendiente',
      intentos: 0,
      ultimoError: resultado.message || ''
    });
    await refrescarColaCache();
    programarReintento();
    return Object.assign({}, resultado, { encolado: true });
  } catch (err) {
    return Object.assign({}, resultado, {
      encolado: false,
      message: resultado.message + '\n\nAdemás falló el guardado local: ' + err.message
    });
  }
}

function mensajeEncolado(descripcion, total, ocupado) {
  const cabecera = ocupado ? '⏳ SERVIDOR OCUPADO' : '⚠️ SIN CONEXIÓN';
  const cola = ocupado
    ? 'Se enviarán solos en cuanto el servidor se libere.'
    : 'Se enviarán solos cuando vuelva la señal.';
  return cabecera + '\n\n' +
         'Registro guardado localmente en la tablet:\n' + descripcion + '\n\n' +
         `Quedan ${total} registro(s) por sincronizar. ` + cola;
}

/*
 * Vacia la cola en orden. `manual` solo cambia los avisos que se muestran.
 */
async function sincronizarCola(manual) {
  if (sincronizando) {
    // Ya hay un barrido en curso (por ejemplo el automatico al volver la señal).
    // Sin este aviso, tocar "Sincronizar ahora" no daba ninguna respuesta visible.
    if (manual) alert('⏳ Ya se está sincronizando. Espera a que termine.');
    return { enviados: 0, fallidos: 0, sinRed: false, ocupado: false, yaEnCurso: true };
  }
  const pendientes = colaPendientes();
  if (pendientes.length === 0) {
    if (manual) alert('✅ No hay registros pendientes de sincronizar.');
    return { enviados: 0, fallidos: 0, sinRed: false, ocupado: false };
  }

  sincronizando = true;
  actualizarIndicadorSync();

  let enviados = 0, fallidos = 0, sinRed = false, ocupado = false;

  try {
    for (const item of pendientes) {
      // C4: se marca cual se esta enviando y se repinta, para que el panel
      // avance registro por registro en vez de quedarse quieto hasta el final.
      idEnviando = item.id;
      renderColaModal();

      const resultado = await enviarAlBackend(item.payload);

      if (resultado.ok) {
        await colaEliminar(item.id);
        enviados++;
        await refrescarColaCache();
        renderColaModal();
        continue;
      }

      if (resultado.sinRed || resultado.reintentable) {
        // Sin señal, o el servidor ocupado con otra operación. En ambos casos hay
        // que parar: reintentar el resto ahora solo gastaría tiempo, y seguir
        // adelante podría romper el orden cronológico de la cola.
        item.intentos++;
        item.ultimoError = resultado.message;
        await colaGuardar(item);
        if (resultado.sinRed) sinRed = true; else ocupado = true;
        break;
      }

      // El backend lo rechazó: no se reintenta más, pero tampoco se borra.
      item.estado = 'error';
      item.intentos++;
      item.ultimoError = resultado.message;
      await colaGuardar(item);
      fallidos++;
    }
  } finally {
    sincronizando = false;
    idEnviando = null;
    await refrescarColaCache();
  }

  if (enviados > 0) await loadCatalogData();

  if (manual || enviados > 0 || fallidos > 0) {
    let msg = '';
    if (enviados > 0) msg += `✅ ${enviados} registro(s) sincronizado(s) con Google Drive.\n`;
    if (fallidos > 0) msg += `❌ ${fallidos} registro(s) rechazado(s) por el servidor. Revísalos en el indicador de sincronización.\n`;
    if (sinRed) msg += `📴 Sigue sin conexión: quedan ${colaPendientes().length} en espera.\n`;
    if (ocupado) msg += `⏳ El servidor estaba ocupado: quedan ${colaPendientes().length} en espera, se reintentará solo.\n`;
    if (!msg && manual) msg = 'No hubo cambios.';
    if (msg) alert(msg.trim());
  }

  if (colaPendientes().length > 0) programarReintento();
  return { enviados, fallidos, sinRed, ocupado };
}

function programarReintento() {
  if (temporizadorCola) return;
  temporizadorCola = setInterval(() => {
    if (colaPendientes().length === 0) {
      clearInterval(temporizadorCola);
      temporizadorCola = null;
      return;
    }
    if (navigator.onLine === false) return;
    sincronizarCola(false);
  }, COLA_REINTENTO_MS);
}

/* ---- Indicador de la barra superior -------------------------------- */

function actualizarIndicadorSync() {
  const chip = document.getElementById('sync-estado');
  const boton = document.getElementById('btn-sincronizar');
  if (!chip) return;

  const pend = colaPendientes().length;
  const errs = colaConError().length;
  const hayRed = navigator.onLine !== false;

  chip.className = 'sync-estado';

  if (sincronizando) {
    chip.classList.add('sync-trabajando');
    chip.innerText = '⏳ Sincronizando...';
  } else if (pend > 0) {
    chip.classList.add('sync-offline');
    chip.innerText = `🟠 ${pend} registro(s) por sincronizar`;
  } else if (errs > 0) {
    chip.classList.add('sync-error');
    chip.innerText = `🔴 ${errs} registro(s) rechazado(s)`;
  } else if (!hayRed) {
    chip.classList.add('sync-offline');
    chip.innerText = '🟠 Modo Offline';
  } else {
    chip.classList.add('sync-online');
    chip.innerText = '🟢 En línea';
  }

  if (boton) {
    boton.style.display = (pend > 0 || errs > 0) ? 'inline-block' : 'none';
    boton.disabled = sincronizando;
  }

  // C4: contador en el encabezado, visible desde cualquier pestaña.
  const badge = document.getElementById('btn-cola-header');
  if (badge) {
    const total = pend + errs;
    badge.style.display = total > 0 ? 'inline-flex' : 'none';
    badge.innerText = errs > 0 ? `📦 ${total} ⚠️` : `📦 ${total}`;
    badge.className = 'btn btn-cola-badge ' + (errs > 0 ? 'btn-danger' : 'btn-warning');
  }

  actualizarAvisoColaTurno();
  renderColaModal();
}

// Compatibilidad con A4: ahora el estado de red vive en el indicador de arriba.
function marcarConexion(hayRed) {
  if (!hayRed && typeof navigator !== 'undefined') { /* navigator.onLine manda */ }
  actualizarIndicadorSync();
}

/*
 * Panel de la cola. Tres datos por registro, que son los que permiten
 * reconocerlo: cuando se tomo, en que maquina y de que se trata.
 */
function renderColaModal() {
  const lista = document.getElementById('cola-lista');
  const resumen = document.getElementById('cola-resumen');
  if (!lista) return;

  const pend = colaPendientes().length;
  const errs = colaConError().length;

  if (resumen) {
    if (colaCache.length === 0) {
      resumen.className = 'cola-resumen cola-resumen-ok';
      resumen.innerText = '✅ Todo sincronizado. No queda nada en la tablet.';
    } else {
      resumen.className = 'cola-resumen' + (errs > 0 ? ' cola-resumen-error' : '');
      let t = `${pend} registro(s) esperando envío`;
      if (errs > 0) t += ` · ${errs} rechazado(s) por el servidor`;
      resumen.innerText = t + '.';
    }
  }

  if (colaCache.length === 0) {
    lista.innerHTML = '<p style="color:#94a3b8; text-align:center; padding:16px;">No hay registros en espera. Todo está sincronizado.</p>';
    return;
  }

  lista.innerHTML = colaCache.map(item => {
    const esError = item.estado === 'error';
    const enviando = item.id === idEnviando;
    const tipo = etiquetaAccion(item.accion);

    // "2026-08-26T14:03:11.000Z" -> "26/08 14:03"
    const iso = String(item.creado || '');
    const hora = iso.length >= 16
      ? `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`
      : iso;

    const marca = enviando ? '⏳ Enviando…' : (esError ? '🔴 Rechazado' : '🟠 En espera');

    return `<div class="cola-item ${esError ? 'cola-item-error' : ''} ${enviando ? 'cola-item-enviando' : ''}">
      <div class="cola-item-cab">
        <span>${escapeHTML(marca)}</span>
        <span class="cola-item-hora">🕒 ${escapeHTML(hora)}</span>
      </div>
      <div class="cola-item-tipo">${escapeHTML(tipo.icono)} ${escapeHTML(tipo.texto)}</div>
      <div class="cola-item-maquina">🏭 ${escapeHTML(item.maquina || 'Sin máquina')}</div>
      <div class="cola-item-desc">${escapeHTML(item.descripcion)}</div>
      ${item.ultimoError ? `<div class="cola-item-err">${escapeHTML(item.ultimoError)}</div>` : ''}
      ${esError ? `<div class="cola-item-acciones">
        <button type="button" class="btn-cola-mini" data-cola-reintentar="${escapeHTML(item.id)}">↻ Reintentar</button>
        <button type="button" class="btn-cola-mini btn-cola-borrar" data-cola-descartar="${escapeHTML(item.id)}">🗑 Descartar</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

function abrirColaModal() {
  const modal = document.getElementById('cola-modal');
  if (!modal) return;
  renderColaModal();
  modal.style.display = 'flex';
}

function setupCola() {
  const chip = document.getElementById('sync-estado');
  if (chip) chip.addEventListener('click', abrirColaModal);

  const btnSync = document.getElementById('btn-sincronizar');
  if (btnSync) btnSync.addEventListener('click', () => sincronizarCola(true));

  const badge = document.getElementById('btn-cola-header');
  if (badge) badge.addEventListener('click', abrirColaModal);

  const btnColaSync = document.getElementById('btn-cola-sync');
  if (btnColaSync) btnColaSync.addEventListener('click', () => sincronizarCola(true));

  const btnCerrar = document.getElementById('btn-cola-cerrar');
  if (btnCerrar) btnCerrar.addEventListener('click', () => {
    document.getElementById('cola-modal').style.display = 'none';
  });

  document.addEventListener('click', async (e) => {
    const reintentar = e.target.closest('[data-cola-reintentar]');
    if (reintentar) {
      const id = Number(reintentar.dataset.colaReintentar);
      const item = colaCache.find(i => i.id === id);
      if (item) {
        item.estado = 'pendiente';
        item.ultimoError = '';
        await colaGuardar(item);
        await refrescarColaCache();
        sincronizarCola(true);
      }
      return;
    }

    const descartar = e.target.closest('[data-cola-descartar]');
    if (descartar) {
      const id = Number(descartar.dataset.colaDescartar);
      const item = colaCache.find(i => i.id === id);
      if (item && confirm(`¿Descartar definitivamente este registro?\n\n${item.descripcion}\n\nNo se podrá recuperar.`)) {
        await colaEliminar(id);
        await refrescarColaCache();
      }
    }
  });

  window.addEventListener('online', () => {
    actualizarIndicadorSync();
    loadCatalogData();
    sincronizarCola(false);
  });
  window.addEventListener('offline', actualizarIndicadorSync);

  refrescarColaCache().then(() => {
    if (colaPendientes().length > 0) {
      programarReintento();
      if (navigator.onLine !== false) sincronizarCola(false);
    }
  });
}

// Reemplaza a setupEstadoConexion de A4.
function setupEstadoConexion() {
  setupCola();
}

async function loadCatalogData() {
  try {
    const res = await fetch(GOOGLE_SCRIPT_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    maquinasCache = data.maquinas || [];
    productosCache = data.productos || [];
    operariosCache = data.operarios || [];
    historialCache = data.historial || [];
    pendientesCache = data.pendientes || [];
    resumenTurnosCache = data.resumenTurnos || [];
    desviacionesCache = data.desviaciones || [];
    configActaCache = data.configActa || { destinatarios: [], jefeTurno: '' };
    estadoMaquinasCache = data.estadoMaquinas || {};
    metaHistorial = {
      dias: data.historialDias || 7,
      desde: data.historialDesde || '',
      truncado: data.historialTruncado || 0
    };
    filasHistorialVisibles = 0;   // cada recarga vuelve a empezar el paginado

    marcarConexion(true);
    // C2: llegaron rondas nuevas, las rachas pueden haber cambiado.
    refrescarAlertasCavidad();
    renderHistorialInspector();
    renderPendientes();
    actualizarContadorBorradores();
    poblarSelectAnalisis();
    return true;
  } catch (err) {
    // Antes esto quedaba solo en la consola y el inspector veia listas vacias sin
    // saber que eran datos viejos y no "no hay rondas".
    console.error("Error API:", err);
    marcarConexion(false);
    return false;
  }
}

/* ===================================================================
 * HISTORIAL
 *
 * El backend ya solo manda una ventana acotada (ver B4), pero aun asi una semana
 * cargada puede traer varios cientos de filas. Se pintan de a tandas para que la
 * tablet no se congele armando una tabla enorme de una sola vez.
 * =================================================================== */

const HISTORIAL_POR_TANDA = 100;

// Nota informativa sobre la ventana. Se crea desde JS para no tocar el HTML.
function actualizarNotaHistorial(mostradas, totales) {
  const vista = document.getElementById('view-historial');
  if (!vista) return;

  let nota = document.getElementById('historial-nota');
  if (!nota) {
    nota = document.createElement('div');
    nota.id = 'historial-nota';
    nota.className = 'historial-nota';
    const titulo = vista.querySelector('h3');
    if (titulo && titulo.parentNode) titulo.parentNode.insertBefore(nota, titulo.nextSibling);
    else vista.insertBefore(nota, vista.firstChild);
  }

  let texto = `Mostrando <strong>${escapeHTML(mostradas)}</strong> de ${escapeHTML(totales)} registro(s) tuyos ` +
              `en los últimos <strong>${escapeHTML(metaHistorial.dias)} días</strong>`;
  if (metaHistorial.desde) texto += ` (desde el ${escapeHTML(metaHistorial.desde)})`;
  texto += '.';

  if (metaHistorial.truncado > 0) {
    texto += ` <span class="hist-aviso">⚠️ El servidor omitió ${escapeHTML(metaHistorial.truncado)} registro(s) ` +
             `más antiguos de la ventana por volumen. Consúltalos en la planilla.</span>`;
  }

  nota.innerHTML = texto;
}

function renderHistorialInspector(agregarTanda) {
  const user = (sessionStorage.getItem('usuario_calidad') || '').toLowerCase();
  const tbody = document.getElementById('tabla-historial-body');
  if (!tbody) return;

  // Copia ordenada: NO se toca historialCache, del que depende el gráfico de
  // tendencia (que espera orden cronológico ascendente).
  const mis = historialCache
    .filter(i => (i.inspector || '').toLowerCase() === user ||
                 (i.inspectorLab || '').toLowerCase() === user)
    .slice()
    .sort((a, b) => String(b.fechaHora).localeCompare(String(a.fechaHora)));   // más reciente primero

  if (mis.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;">No tienes registros en los últimos ${escapeHTML(metaHistorial.dias)} días.</td></tr>`;
    actualizarNotaHistorial(0, 0);
    return;
  }

  filasHistorialVisibles = agregarTanda
    ? Math.min(mis.length, filasHistorialVisibles + HISTORIAL_POR_TANDA)
    : Math.min(mis.length, HISTORIAL_POR_TANDA);

  const visibles = mis.slice(0, filasHistorialVisibles);

  const claseEstado = (e) =>
    e === 'Pendiente' ? 'est-pend' : (e === 'Detenida' ? 'est-det' : 'est-ok');

  let html = visibles.map(r => `<tr>
    <td>${escapeHTML(r.idInspeccion)}</td>
    <td>${escapeHTML(r.correlativo)}</td>
    <td>${escapeHTML(r.fechaHora)}</td>
    <td>${escapeHTML(r.turno)}</td>
    <td>${escapeHTML(r.maquina)}</td>
    <td>${escapeHTML(r.producto)}</td>
    <td>${escapeHTML(r.cavidadMolde || 1)}</td>
    <td class="${claseEstado(r.estado)}">${escapeHTML(r.estado)}</td>
    <td>${escapeHTML(r.inspector)}</td>
    <td>${escapeHTML(r.inspectorLab || '-')}</td>
  </tr>`).join('');

  if (filasHistorialVisibles < mis.length) {
    const faltan = mis.length - filasHistorialVisibles;
    html += `<tr><td colspan="10" style="text-align:center; padding:10px;">
      <button type="button" id="btn-historial-mas" class="btn btn-secondary">
        ⬇ Mostrar ${Math.min(HISTORIAL_POR_TANDA, faltan)} más (quedan ${faltan})
      </button></td></tr>`;
  }

  tbody.innerHTML = html;
  actualizarNotaHistorial(visibles.length, mis.length);

  const btnMas = document.getElementById('btn-historial-mas');
  if (btnMas) btnMas.addEventListener('click', () => renderHistorialInspector(true));
}

/* ===================================================================
 * CIERRE DE TURNO
 * El servidor ya no adivina el turno por la hora: la app manda turno y fecha
 * operativa explícitos, confirmados por el inspector.
 * =================================================================== */

let modoTurnoModal = 'cerrar';   // 'cerrar' | 'consolidar'

/*
 * Aviso dentro del modal de turno.
 *
 * Antes esto era un bloqueo duro: con la cola llena no se abria el modal. El
 * problema es que sin señal la cola NO se puede vaciar, asi que el turno
 * quedaba imposible de cerrar justo cuando mas urgia. Ahora se avisa aca, y la
 * confirmacion escalonada de ejecutarCierreTurno decide.
 */
function actualizarAvisoColaTurno() {
  const caja = document.getElementById('turno-cola-aviso');
  if (!caja) return;

  const pend = colaPendientes().length;
  if (pend === 0) { caja.style.display = 'none'; caja.innerText = ''; return; }

  caja.style.display = 'block';
  caja.innerText = `⚠️ Hay ${pend} registro(s) guardados en esta tablet que todavía no ` +
                   `llegaron a Google Drive. Si consolidas ahora, el PDF saldrá sin ellos.`;
}

/*
 * Confirmacion escalonada antes de consolidar.
 *
 * Primero se ofrece sincronizar. Si despues de intentarlo siguen quedando
 * registros -tipicamente porque no hay señal- se puede seguir igual, pero
 * diciendo exactamente que consecuencia tiene. Bloquear sin salida seria peor:
 * dejaria el turno sin cerrar y sin PDF.
 */
async function confirmarColaAntesDeConsolidar(esCierre) {
  const pend = colaPendientes().length;
  if (pend === 0) return true;

  const que = esCierre ? 'cerrar el turno' : 'generar el consolidado';

  const intentar = confirm(
    `⚠️ Hay ${pend} registro(s) guardados en esta tablet que TODAVÍA NO llegaron a Google Drive.\n\n` +
    `Si vas a ${que} ahora, el PDF saldrá SIN esos registros.\n\n` +
    `Aceptar = intentar sincronizarlos ahora\n` +
    `Cancelar = no ${que} todavía`);

  if (!intentar) return false;

  await sincronizarCola(true);

  const quedan = colaPendientes().length;
  if (quedan === 0) return true;

  return confirm(
    `Siguen quedando ${quedan} registro(s) sin subir (lo más probable es que no haya señal).\n\n` +
    `Esos registros NO se pierden: se envían solos cuando vuelva la conexión. Pero van a ` +
    `quedar FUERA del PDF que se genere ahora, y después habrá que volver a generar el ` +
    `consolidado de este turno.\n\n` +
    `¿${esCierre ? 'Cerrar el turno' : 'Generar el PDF'} de todos modos?`);
}

function abrirModalTurno(modo) {
  modoTurnoModal = modo;
  const sugerencia = sugerirTurnoACerrar();

  document.getElementById('turno-modal-titulo').innerText =
    (modo === 'cerrar') ? 'Cerrar turno y generar PDF' : 'Generar PDF consolidado';
  document.getElementById('btn-turno-confirmar').innerText =
    (modo === 'cerrar') ? '✅ Cerrar turno' : '📄 Generar PDF';

  document.getElementById('select-turno-cerrar').value = sugerencia.turno;
  document.getElementById('input-fecha-turno').value = sugerencia.fechaOperativa;

  const aviso = document.getElementById('turno-aviso');
  aviso.innerText = sugerencia.aviso;
  aviso.style.display = sugerencia.aviso ? 'block' : 'none';

  actualizarAvisoColaTurno();
  actualizarResumenTurno();
  document.getElementById('turno-modal').style.display = 'flex';
}

// Muestra cuántos registros tiene el turno elegido ANTES de confirmar.
function actualizarResumenTurno() {
  const caja = document.getElementById('turno-resumen');
  if (!caja) return;

  const turno = document.getElementById('select-turno-cerrar').value;
  const fecha = document.getElementById('input-fecha-turno').value;
  const r = resumenTurnosCache.find(x => x.turno === turno && x.fechaOperativa === fecha);

  if (!r) {
    caja.className = 'turno-resumen turno-resumen-vacio';
    caja.innerHTML = `<strong>Sin registros</strong><br>
      No hay inspecciones cargadas para ${escapeHTML(turno)} del ${escapeHTML(fecha || '—')}.`;
    return;
  }

  caja.className = 'turno-resumen' + (r.pendientes > 0 ? ' turno-resumen-alerta' : '');
  caja.innerHTML = `<strong>${escapeHTML(r.total)} registro(s)</strong> ` +
    `en ${escapeHTML(turno)} del ${escapeHTML(fecha)}<br>
    <span class="tr-ok">✓ ${escapeHTML(r.cerradas)} cerrada(s)</span>
    <span class="tr-pend">⏳ ${escapeHTML(r.pendientes)} pendiente(s) de laboratorio</span>
    <span class="tr-det">⛔ ${escapeHTML(r.detenciones)} detención(es)</span>` +
    (r.pendientes > 0
      ? `<div class="tr-nota">Las pendientes saldrán marcadas como tales en el PDF.</div>`
      : '');
}

async function ejecutarCierreTurno() {
  const turno = document.getElementById('select-turno-cerrar').value;
  const fecha = document.getElementById('input-fecha-turno').value;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    alert('⚠️ Selecciona una fecha operativa válida.');
    return;
  }

  const esCierre = (modoTurnoModal === 'cerrar');

  // C4: lo que siga en la tablet no va a entrar en este PDF. Se avisa antes de
  // enviar nada, no despues.
  if (!(await confirmarColaAntesDeConsolidar(esCierre))) return;

  if (esCierre && !confirm(`¿Cerrar ${turno} del ${fecha} y generar los PDF consolidados?`)) return;

  const btn = document.getElementById('btn-turno-confirmar');
  const textoOriginal = btn.innerText;
  btn.disabled = true;
  btn.innerText = 'Generando...';

  try {
    const resultado = await enviarAlBackend({
      action: esCierre ? 'cerrarTurno' : 'generarConsolidado',
      turnoActual: turno,
      fechaOperativa: fecha
    });

    if (!resultado.ok) { alert(mensajeErrorRed(resultado)); return; }

    const d = resultado.data;
    alert(`✅ ${d.turno} del ${d.fechaOperativa} consolidado.\n\n` +
          `${d.registros} registro(s) en ${d.count} PDF, uno por máquina.`);

    document.getElementById('turno-modal').style.display = 'none';

    // ACTA: recien ahora el turno esta cerrado y todas sus rondas cuentan.
    // Se abre ANTES de cerrar la sesion, porque el acta la firma quien la vivio.
    await loadCatalogData();
    abrirModalActa(d.turno, d.fechaOperativa);

    if (esCierre) {
      // La sesion se cierra al salir del acta, no antes: si se cerrara aca, el
      // inspector perderia el acta a medio llenar.
      cierreDeSesionPendiente = true;
    }
  } finally {
    btn.disabled = false;
    btn.innerText = textoOriginal;
  }
}

/* ===================================================================
 * ACTA DE TRASPASO (BEL-SGC-004.04)
 *
 * Los consolidados por maquina son el detalle. El acta es lo que se entrega al
 * turno siguiente: UNA fila por maquina con que se corria, que se desvio, que
 * se hizo y como queda la maquina.
 *
 * Se abre despues de cerrar el turno, no antes: el acta tiene que reflejar el
 * turno ya cerrado, con todas sus rondas dentro.
 * =================================================================== */

let datosActa = { turno: '', fechaOperativa: '' };

// Cuando el acta viene de un cierre de turno, la sesion se cierra al salir de
// ella. Guardarlo aparte evita que el modal desaparezca a mitad de camino.
let cierreDeSesionPendiente = false;

function abrirModalActa(turno, fecha) {
  datosActa = { turno, fechaOperativa: fecha };

  const modal = document.getElementById('acta-modal');
  if (!modal) return;

  const sub = document.getElementById('acta-subtitulo');
  if (sub) sub.innerText = `${turno} · ${fecha}`;

  // El jefe de turno y los correos se recuerdan: son los mismos casi siempre.
  const jefe = document.getElementById('input-acta-jefe');
  if (jefe) jefe.value = configActaCache.jefeTurno || '';

  const correos = document.getElementById('input-acta-correos');
  if (correos) correos.value = (configActaCache.destinatarios || []).join(', ');

  const obs = document.getElementById('input-acta-obs');
  if (obs) obs.value = '';

  const estado = document.getElementById('acta-estado');
  if (estado) { estado.innerText = ''; estado.className = 'acta-estado'; }

  mostrarResumenActa();
  modal.style.display = 'flex';
}

/*
 * Adelanto de lo que va a salir en el acta, calculado con lo que ya tiene la
 * tablet. Sirve para notar ANTES de generar que falta una maquina.
 */
function mostrarResumenActa() {
  const caja = document.getElementById('acta-resumen');
  if (!caja) return;

  const rondas = historialCache.filter(r =>
    r.fechaOperativa === datosActa.fechaOperativa && r.turnoOperativo === datosActa.turno);

  const maquinasConRondas = new Set(rondas.map(r => r.maquina).filter(Boolean));
  const totalMaquinas = maquinasCache.length;
  const sinRegistro = maquinasCache
    .filter(m => !maquinasConRondas.has(m.id))
    .map(m => m.nombre || m.id);

  const detenidas = new Set(rondas.filter(r => r.estado === 'Detenida').map(r => r.maquina));

  let html = `<div><strong>${maquinasConRondas.size}</strong> de ${totalMaquinas} máquina(s) ` +
             `con rondas · <strong>${rondas.length}</strong> registro(s) en el turno.</div>`;

  if (detenidas.size > 0) {
    html += `<div class="acta-linea-det">⛔ ${detenidas.size} máquina(s) con detención registrada.</div>`;
  }

  if (sinRegistro.length > 0) {
    html += `<div class="acta-linea-falta">⚠️ Sin ninguna ronda: ` +
            `${escapeHTML(sinRegistro.slice(0, 6).join(', '))}` +
            `${sinRegistro.length > 6 ? ` y ${sinRegistro.length - 6} más` : ''}. ` +
            `Van a salir en el acta marcadas como "SIN REGISTRO".</div>`;
  }

  caja.innerHTML = html;
}

function leerCorreosActa() {
  const campo = document.getElementById('input-acta-correos');
  return String(campo ? campo.value : '')
    .split(/[,;\n]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

async function ejecutarActa(enviar) {
  const estado = document.getElementById('acta-estado');
  const correos = leerCorreosActa();

  if (enviar && correos.length === 0) {
    if (estado) {
      estado.className = 'acta-estado acta-estado-error';
      estado.innerText = '⚠️ Escribe al menos un correo, o usa "Solo Generar".';
    }
    return;
  }

  const botones = ['btn-acta-enviar', 'btn-acta-generar', 'btn-acta-cerrar']
    .map(id => document.getElementById(id)).filter(Boolean);
  botones.forEach(b => { b.disabled = true; });

  if (estado) {
    estado.className = 'acta-estado acta-estado-trabajando';
    estado.innerText = enviar ? '⏳ Generando el acta y enviándola...' : '⏳ Generando el acta...';
  }

  try {
    const jefe = (document.getElementById('input-acta-jefe') || {}).value || '';

    // El acta NO se encola: necesita leer la planilla del servidor para armar
    // el resumen, asi que sin conexion no hay nada que guardar para despues.
    const resultado = await enviarAlBackend({
      action: 'generarActa',
      turnoActual: datosActa.turno,
      fechaOperativa: datosActa.fechaOperativa,
      inspector: sesionActual().usuario,
      jefeTurno: jefe,
      observaciones: (document.getElementById('input-acta-obs') || {}).value || '',
      destinatarios: correos,
      enviar: !!enviar
    });

    if (!resultado.ok) {
      if (estado) {
        estado.className = 'acta-estado acta-estado-error';
        estado.innerText = mensajeErrorRed(resultado);
      }
      return;
    }

    const d = resultado.data;

    // Se recuerdan para el proximo turno, pero solo si el acta salio bien.
    if (correos.length > 0 || jefe) {
      configActaCache = { destinatarios: correos, jefeTurno: jefe };
      enviarAlBackend({ action: 'guardarConfigActa', destinatarios: correos, jefeTurno: jefe });
    }

    let msg = `✅ Acta generada: ${d.maquinasConRondas} de ${d.maquinas} máquina(s) con rondas`;
    if (d.detenidas) msg += ` · ${d.detenidas} detenida(s)`;
    if (d.maquinasSinRegistro) msg += ` · ${d.maquinasSinRegistro} sin registro`;
    msg += '.';

    if (d.enviado) {
      msg += `\n📧 Enviada a: ${d.destinatarios.join(', ')}`;
    } else if (d.message) {
      msg += `\n⚠️ ${d.message}`;
    }
    if (d.invalidos && d.invalidos.length) {
      msg += `\n⚠️ Direcciones ignoradas por estar mal escritas: ${d.invalidos.join(', ')}`;
    }

    if (estado) {
      estado.className = 'acta-estado' + (d.enviado || !enviar ? ' acta-estado-ok' : ' acta-estado-error');
      estado.innerText = msg;
    }

    alert(msg + `\n\nEl acta también quedó en Drive.`);
    if (d.url) window.open(d.url, '_blank');
  } finally {
    botones.forEach(b => { b.disabled = false; });
  }
}

/* ===================================================================
 * REACTIVACION DE MAQUINA DETENIDA
 *
 * Una detencion dejo de ser un registro puntual: la maquina QUEDA detenida
 * hasta que alguien va, comprueba que se arreglo y lo deja asentado.
 *
 * Por eso, al elegir una maquina detenida para inspeccionarla, la app pregunta
 * primero. Son las dos cosas que el acta necesita y que despues nadie recuerda:
 * que se hizo y quien lo hizo.
 *
 * Si la falla no se corrigio no hay nada que inspeccionar: la maquina no esta
 * produciendo. En ese caso se cancela la seleccion en vez de dejar abrir una
 * ronda de una maquina parada.
 * =================================================================== */

function maquinaDetenida(idMaquina) {
  const e = estadoMaquinasCache[idMaquina];
  return (e && e.detenida) ? e : null;
}

function textoDetencion(info) {
  let t = 'Detenida';
  if (info.desde) t += ` desde el ${info.desde}`;
  if (info.motivo) t += `\nMotivo: ${info.motivo}`;
  if (info.detalle) t += `\nDetalle: ${info.detalle}`;
  return t;
}

// Aviso permanente mientras la maquina elegida siga detenida.
function actualizarBannerDetenida() {
  const banner = document.getElementById('banner-maquina-detenida');
  if (!banner) return;

  const id = (document.getElementById('select-maquina') || {}).value || '';
  const info = maquinaDetenida(id);

  if (!info) { banner.style.display = 'none'; banner.innerText = ''; return; }

  banner.style.display = 'block';
  banner.innerText = `⛔ Esta máquina figura DETENIDA. ${textoDetencion(info)}`;
}

let maquinaAReactivar = null;

function abrirModalReactivar(idMaquina) {
  const info = maquinaDetenida(idMaquina);
  if (!info) return false;

  maquinaAReactivar = idMaquina;

  const nombre = (maquinasCache.find(m => m.id === idMaquina) || {}).nombre || idMaquina;
  const detalle = document.getElementById('reactivar-detalle');
  if (detalle) detalle.innerText = `${nombre}\n\n${textoDetencion(info)}`;

  const campos = document.getElementById('reactivar-campos');
  if (campos) campos.style.display = 'none';
  const confirmar = document.getElementById('reactivar-confirmar');
  if (confirmar) confirmar.style.display = 'none';

  ['input-reactivar-accion', 'input-reactivar-mecanico'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const error = document.getElementById('reactivar-error');
  if (error) error.innerText = '';

  const modal = document.getElementById('reactivar-modal');
  if (modal) modal.style.display = 'flex';
  return true;
}

function cerrarModalReactivar() {
  const modal = document.getElementById('reactivar-modal');
  if (modal) modal.style.display = 'none';
  maquinaAReactivar = null;
}

/*
 * Sigue detenida: se deshace la seleccion. Inspeccionar una maquina parada
 * generaria una ronda de un producto que no se esta fabricando.
 */
function mantenerDetenida() {
  const sel = document.getElementById('select-maquina');
  const busq = document.getElementById('input-search-maquina');
  if (sel) sel.value = '';
  if (busq) busq.value = '';

  cerrarModalReactivar();
  actualizarBannerDetenida();
  actualizarFichaProducto('');

  alert('La máquina sigue detenida.\n\nNo se abre una ronda: primero tiene que ' +
        'volver a producir. La detención ya está registrada y saldrá en el acta del turno.');
}

/*
 * Se corrigio: los datos van a los campos del acta, que es donde el resto del
 * flujo ya sabe leerlos.
 */
function confirmarReactivacion() {
  const accion = (document.getElementById('input-reactivar-accion') || {}).value.trim();
  const mecanico = (document.getElementById('input-reactivar-mecanico') || {}).value.trim();
  const error = document.getElementById('reactivar-error');

  if (!accion) {
    if (error) error.innerText = '⚠️ Indica qué se hizo para corregir la falla.';
    return;
  }
  if (!mecanico) {
    if (error) error.innerText = '⚠️ Indica qué mecánico de mantención la reparó.';
    return;
  }

  const campoAccion = document.getElementById('input-accion-correctiva');
  if (campoAccion) campoAccion.value = accion;
  const campoResp = document.getElementById('input-responsable');
  if (campoResp) campoResp.value = mecanico;

  // Deja de estar detenida en cuanto la ronda se guarde; para la pantalla, ya.
  if (maquinaAReactivar && estadoMaquinasCache[maquinaAReactivar]) {
    estadoMaquinasCache[maquinaAReactivar].detenida = false;
  }

  cerrarModalReactivar();
  actualizarBannerDetenida();
}

function setupModalReactivar() {
  const si = document.getElementById('btn-reactivar-si');
  if (si) si.addEventListener('click', () => {
    const campos = document.getElementById('reactivar-campos');
    if (campos) campos.style.display = 'block';
    const confirmar = document.getElementById('reactivar-confirmar');
    if (confirmar) confirmar.style.display = 'block';
    const foco = document.getElementById('input-reactivar-accion');
    if (foco) foco.focus();
  });

  const no = document.getElementById('btn-reactivar-no');
  if (no) no.addEventListener('click', mantenerDetenida);

  const guardar = document.getElementById('btn-reactivar-guardar');
  if (guardar) guardar.addEventListener('click', confirmarReactivacion);
}

function setupModalActa() {
  const enviar = document.getElementById('btn-acta-enviar');
  if (enviar) enviar.addEventListener('click', () => ejecutarActa(true));

  const generar = document.getElementById('btn-acta-generar');
  if (generar) generar.addEventListener('click', () => ejecutarActa(false));

  const cerrar = document.getElementById('btn-acta-cerrar');
  if (cerrar) cerrar.addEventListener('click', () => {
    document.getElementById('acta-modal').style.display = 'none';
    if (cierreDeSesionPendiente) {
      cierreDeSesionPendiente = false;
      cerrarSesion(true);
    }
  });
}

function setupModalTurno() {
  const sel = document.getElementById('select-turno-cerrar');
  const fec = document.getElementById('input-fecha-turno');
  if (sel) sel.addEventListener('change', actualizarResumenTurno);
  if (fec) fec.addEventListener('change', actualizarResumenTurno);

  const confirmar = document.getElementById('btn-turno-confirmar');
  if (confirmar) confirmar.addEventListener('click', ejecutarCierreTurno);

  const cancelar = document.getElementById('btn-turno-cancelar');
  if (cancelar) cancelar.addEventListener('click', () => {
    document.getElementById('turno-modal').style.display = 'none';
  });
}

function cerrarTurno() { abrirModalTurno('cerrar'); }
function generarConsolidado() { abrirModalTurno('consolidar'); }

function poblarSelectAnalisis() {
  const sel = document.getElementById('select-analisis-producto');
  if (!sel) return;
  const seleccionActual = sel.value;
  sel.innerHTML = '<option value="">-- Selecciona un producto --</option>' +
    productosCache.map(p =>
      `<option value="${escapeHTML(p.id)}">${escapeHTML(p.nombre)}</option>`).join('');
  if (seleccionActual) sel.value = seleccionActual;
}

/* ===================================================================
 * TENDENCIA POR CAVIDAD (C3)
 *
 * El grafico anterior mostraba el peso y el ciclo de la ronda, tomados de la
 * cavidad mas baja. Con un molde de 24 eso es una muestra de 1 en 24: una
 * cavidad que se va no aparece, y el promedio del molde tampoco.
 *
 * Ahora se elige cavidad y variable, y se dibujan los limites de la
 * especificacion. Con los limites a la vista deja de ser una curva bonita y
 * pasa a ser una carta de control: se ve la deriva ANTES de que un valor caiga
 * fuera de rango.
 *
 * Por que una variable a la vez y no las tres juntas: peso (~23 g), ciclo
 * (~12 s) y espesor (~1.3 mm) no comparten escala. Superponerlas obliga a
 * varios ejes y, sobre todo, a seis lineas de limite; el grafico deja de
 * leerse justo en lo que importa. Se cambia de variable con el selector.
 * =================================================================== */

// idx es la posicion dentro de la tupla [cavidad, peso, ciclo, espesor] que
// manda el backend; spec es la variable de Productos_Specs con sus limites.
const VARIABLES_ANALISIS = [
  { clave: 'peso',    idx: 1, label: 'Peso (g)',     spec: 'peso',    color: '#0284c7' },
  { clave: 'ciclo',   idx: 2, label: 'Ciclo (s)',    spec: 'ciclo',   color: '#f59e0b' },
  { clave: 'espesor', idx: 3, label: 'Espesor (mm)', spec: 'espesor', color: '#a78bfa' }
];

const MAX_PUNTOS_ANALISIS = 30;

// Rondas cerradas del producto, de la mas antigua a la mas reciente.
function rondasAnalisis(producto) {
  return historialCache
    .filter(r => r.producto === producto && r.estado === 'Cerrada')
    .slice()
    .sort((a, b) => String(a.fechaHora).localeCompare(String(b.fechaHora)))
    .slice(-MAX_PUNTOS_ANALISIS);
}

// Cuantas cavidades llegó a tener este producto en la ventana cargada.
function maxCavidadesProducto(producto) {
  let max = 1;
  historialCache.forEach(r => {
    if (r.producto !== producto) return;
    max = Math.max(max, parseInt(r.cavidadMolde, 10) || 1);
    (r.porCavidad || []).forEach(t => { max = Math.max(max, Number(t[0]) || 1); });
  });
  return max;
}

/*
 * Series a graficar.
 *   cavidad = ''  -> promedio del molde, mas la banda minimo/maximo entre
 *                    cavidades. Esa banda es el dato util: si se abre, el
 *                    molde esta desbalanceado aunque el promedio siga centrado.
 *   cavidad = N   -> solo esa cavidad.
 */
function serieAnalisis(rondas, cavidad, idx) {
  const promedio = [], minimos = [], maximos = [];
  const cav = cavidad === '' ? null : Number(cavidad);

  rondas.forEach(r => {
    const tuplas = Array.isArray(r.porCavidad) ? r.porCavidad : [];

    if (cav !== null) {
      const t = tuplas.find(x => Number(x[0]) === cav);
      const v = t ? t[idx] : null;
      promedio.push(typeof v === 'number' ? v : null);
      minimos.push(null);
      maximos.push(null);
      return;
    }

    const vals = tuplas.map(t => t[idx]).filter(v => typeof v === 'number');
    if (vals.length === 0) {
      promedio.push(null); minimos.push(null); maximos.push(null);
      return;
    }
    const suma = vals.reduce((a, b) => a + b, 0);
    promedio.push(Math.round((suma / vals.length) * 1000) / 1000);
    minimos.push(Math.min.apply(null, vals));
    maximos.push(Math.max.apply(null, vals));
  });

  return { promedio, minimos, maximos };
}

// Limites del producto para una variable, o null si no hay.
function limitesAnalisis(producto, spec) {
  const p = productosCache.find(x => x.id === producto || x.nombre === producto);
  const t = p && p.tolerancias ? p.tolerancias[spec] : null;
  if (!t) return null;
  const min = (t.min === null || t.min === undefined) ? null : Number(t.min);
  const max = (t.max === null || t.max === undefined) ? null : Number(t.max);
  const nominal = (t.nominal === null || t.nominal === undefined) ? null : Number(t.nominal);
  if (min === null && max === null && nominal === null) return null;
  return { min, max, nominal };
}

// El selector de cavidad se arma con lo que el producto realmente tuvo.
function poblarSelectCavidades(producto) {
  const sel = document.getElementById('select-analisis-cavidad');
  if (!sel) return;

  const previo = sel.value;

  if (!producto) {
    sel.innerHTML = '<option value="">Todas</option>';
    sel.disabled = true;
    return;
  }

  const max = maxCavidadesProducto(producto);
  let html = '<option value="">Todas las cavidades</option>';
  for (let c = 1; c <= max; c++) html += `<option value="${c}">Cavidad ${c}</option>`;
  sel.innerHTML = html;
  sel.disabled = false;

  // Se conserva la cavidad elegida si el producto nuevo la tiene: cambiar de
  // producto no deberia sacarte de la cavidad que estabas siguiendo.
  if (previo && Number(previo) <= max) sel.value = previo;
}

function renderAnalisis() {
  const selProd = document.getElementById('select-analisis-producto');
  const selCav = document.getElementById('select-analisis-cavidad');
  const selVar = document.getElementById('select-analisis-variable');
  const nota = document.getElementById('analisis-nota');
  const leyenda = document.getElementById('analisis-leyenda');
  if (!selProd) return;

  const producto = selProd.value;
  poblarSelectCavidades(producto);
  if (selVar) selVar.disabled = !producto;

  const limpiar = (msg) => {
    if (chartTendenciaInstance) { chartTendenciaInstance.destroy(); chartTendenciaInstance = null; }
    if (nota) nota.innerText = msg || '';
    if (leyenda) leyenda.innerText = '';
  };

  if (!producto) {
    limpiar('Elige un producto para ver su tendencia.');
    return;
  }

  const variable = VARIABLES_ANALISIS.find(v => v.clave === (selVar ? selVar.value : 'peso'))
                   || VARIABLES_ANALISIS[0];
  const cavidad = selCav ? selCav.value : '';
  const rondas = rondasAnalisis(producto);

  if (rondas.length === 0) {
    limpiar('No hay rondas cerradas de este producto en los últimos ' +
            metaHistorial.dias + ' días.');
    return;
  }

  const serie = serieAnalisis(rondas, cavidad, variable.idx);
  const conDato = serie.promedio.filter(v => v !== null).length;

  if (conDato === 0) {
    limpiar(`No hay mediciones de ${variable.label.toLowerCase()} ` +
            (cavidad ? `en la cavidad ${cavidad} ` : '') +
            `en las últimas ${rondas.length} ronda(s).`);
    return;
  }

  if (typeof Chart === 'undefined') return;   // sin la libreria no hay grafico

  const etiquetas = rondas.map(r => String(r.fechaHora).slice(5, 16));
  const lim = limitesAnalisis(producto, variable.spec);
  const constante = (v) => (v === null ? null : etiquetas.map(() => v));

  const datasets = [{
    label: cavidad ? `${variable.label} · cavidad ${cavidad}` : `${variable.label} · promedio del molde`,
    data: serie.promedio,
    borderColor: variable.color,
    backgroundColor: variable.color + '26',
    borderWidth: 2,
    tension: 0.2,
    spanGaps: true
  }];

  if (!cavidad) {
    datasets.push(
      { label: 'Mínimo entre cavidades', data: serie.minimos, borderColor: '#64748b',
        borderWidth: 1, borderDash: [3, 3], pointRadius: 0, tension: 0.2, spanGaps: true },
      { label: 'Máximo entre cavidades', data: serie.maximos, borderColor: '#64748b',
        borderWidth: 1, borderDash: [3, 3], pointRadius: 0, tension: 0.2, spanGaps: true }
    );
  }

  if (lim) {
    if (lim.max !== null) datasets.push({
      label: `Límite superior (${lim.max})`, data: constante(lim.max),
      borderColor: '#dc2626', borderWidth: 2, borderDash: [6, 4], pointRadius: 0, fill: false
    });
    if (lim.min !== null) datasets.push({
      label: `Límite inferior (${lim.min})`, data: constante(lim.min),
      borderColor: '#dc2626', borderWidth: 2, borderDash: [6, 4], pointRadius: 0, fill: false
    });
    if (lim.nominal !== null) datasets.push({
      label: `Nominal (${lim.nominal})`, data: constante(lim.nominal),
      borderColor: '#4ade80', borderWidth: 1, borderDash: [2, 4], pointRadius: 0, fill: false
    });
  }

  const lienzo = document.getElementById('chartTendencia');
  if (!lienzo || !lienzo.getContext) return;
  if (chartTendenciaInstance) chartTendenciaInstance.destroy();

  chartTendenciaInstance = new Chart(lienzo.getContext('2d'), {
    type: 'line',
    data: { labels: etiquetas, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#cbd5e1', boxWidth: 14, font: { size: 11 } } } },
      scales: {
        y: { title: { display: true, text: variable.label, color: '#94a3b8' },
             ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
        x: { ticks: { color: '#94a3b8', maxRotation: 60, minRotation: 45, font: { size: 9 } },
             grid: { color: '#1e293b' } }
      }
    }
  });

  if (nota) {
    nota.innerText = `Últimas ${rondas.length} ronda(s) cerradas` +
      (cavidad ? ` · cavidad ${cavidad}` : ' · promedio de todas las cavidades') + '.';
  }

  if (leyenda) {
    if (!lim) {
      leyenda.innerText = '⚠️ Este producto no tiene límites cargados en Productos_Specs, ' +
                          'así que el gráfico va sin líneas de referencia.';
      leyenda.className = 'analisis-leyenda analisis-leyenda-aviso';
    } else {
      const fuera = serie.promedio.filter(v => v !== null &&
        ((lim.min !== null && v < lim.min) || (lim.max !== null && v > lim.max))).length;
      leyenda.className = 'analisis-leyenda' + (fuera > 0 ? ' analisis-leyenda-aviso' : '');
      leyenda.innerText = fuera > 0
        ? `⚠️ ${fuera} de ${conDato} punto(s) fuera de especificación.`
        : `✅ Los ${conDato} puntos están dentro de especificación.`;
    }
  }
}

function startQRScanner() {
  document.getElementById('qr-modal').style.display = 'flex'; html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 220, height: 220 } }, (text) => {
    const m = maquinasCache.find(x => x.id === text || (x.nombre && x.nombre.toLowerCase().includes(text.toLowerCase())));
    document.getElementById('select-maquina').value = m ? m.id : text;
    document.getElementById('input-search-maquina').value = m ? `${m.nombre} (${m.id})` : text;
    stopQRScanner();
    // El QR es la otra puerta de entrada: tiene que preguntar lo mismo.
    actualizarBannerDetenida();
    abrirModalReactivar(m ? m.id : text);
  }, () => {}).catch(err => console.log(err));
}
function stopQRScanner() { if (html5QrCode) html5QrCode.stop().then(() => document.getElementById('qr-modal').style.display='none').catch(()=>document.getElementById('qr-modal').style.display='none'); else document.getElementById('qr-modal').style.display='none'; }
