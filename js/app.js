/**
 * app.js — arranque, router por hash y render de todas las vistas.
 *
 * Script clasico (sin modulos): expone window.App dentro de una IIFE. Se carga
 * el ultimo, despues de config.js, util.js, graficos.js, camara.js, demo.js,
 * api.js y auth.js.
 *
 * Este es el UNICO archivo que toca el DOM de #vista. Consume window.U,
 * window.Api, window.Auth, window.Camara y window.Graficos con las firmas del
 * contrato (docs/CONTRATO.md, seccion 8).
 *
 * Reglas que este archivo hace cumplir por diseno:
 *  - Ni un innerHTML: todo nodo se crea con U.el (document.createElement) y
 *    todo texto entra por textContent. Ningun dato del servidor ni del usuario
 *    puede convertirse en marcado.
 *  - No existe ningun selector de archivos (input de tipo archivo) en ninguna
 *    vista: la unica via para que entre una foto es window.Camara.
 *  - Ningun token en localStorage, en la URL ni en consola. Aqui no hay console.*.
 *  - Cada vista maneja cargando, vacio, error y sin permiso. Nunca una pantalla
 *    en blanco.
 *  - El router cancela el pintado de una vista que ya se abandono (generacion) y
 *    cierra la camara en cada cambio de vista.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Atajos y respaldos
  // ---------------------------------------------------------------------------

  var U = window.U || {};
  var Api = window.Api || {};
  var Auth = window.Auth || {};
  var Camara = window.Camara || {};
  var Graficos = window.Graficos || {};
  var CFG = window.RETO_CONFIG || {};

  var el = U.el;
  var qs = U.qs;

  var NOTA_MAX = 280;
  // 20 y no 60: cada registro pide hasta 2 miniaturas, y la ruta `foto` sirve
  // una por peticion. Con 60 registros el historial disparaba hasta 120
  // llamadas de golpe. El backend ya le dio a `foto` un cupo propio y alto,
  // pero pedir menos de entrada es lo que hace que el feed cargue rapido.
  // (P1.11 de la revision 2026-09-04.)
  var LIMITE_FEED = 20;
  var LIMITE_FEED_ADMIN = 40;

  var VENTANA_POR_DEFECTO = 7;
  var MIN_DATOS_POR_DEFECTO = 2;

  var SIN_DATO = typeof U.SIN_DATO === 'string' ? U.SIN_DATO : '—';

  function limpiar(nodo) {
    if (typeof U.limpiar === 'function') return U.limpiar(nodo);
    while (nodo && nodo.firstChild) nodo.removeChild(nodo.firstChild);
    return nodo;
  }

  function numero(valor) {
    if (typeof U.numero === 'function') return U.numero(valor);
    if (valor === null || valor === undefined || valor === '') return null;
    var n = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  function fmtHora(valor) {
    if (typeof U.fmtHora === 'function') return U.fmtHora(valor);
    return '';
  }

  function fmtNum(valor, decimales) {
    if (typeof U.fmtNum === 'function') return U.fmtNum(valor, decimales);
    var n = numero(valor);
    if (n === null) return SIN_DATO;
    return n.toFixed(decimales === undefined ? 1 : decimales).replace('.', ',');
  }

  function fmtKg(v) { return U.fmtKg ? U.fmtKg(v) : fmtNum(v, 1) + ' kg'; }
  function fmtPct(v, d) { return U.fmtPct ? U.fmtPct(v, d) : fmtNum(v, d === undefined ? 2 : d) + ' %'; }
  function fmtFecha(v) { return U.fmtFecha ? U.fmtFecha(v) : String(v || SIN_DATO); }
  function fmtFechaCorta(v) { return U.fmtFechaCorta ? U.fmtFechaCorta(v) : String(v || SIN_DATO); }

  function avisoOk(m) { if (U.mostrarOk) U.mostrarOk(m); }
  function avisoError(m) { if (U.mostrarError) U.mostrarError(m); }

  function cargandoEn(contenedor, texto) {
    if (typeof U.cargando === 'function') return U.cargando(contenedor, texto);
    limpiar(contenedor);
    contenedor.appendChild(el('div', {
      clase: 'cargando',
      atributos: { role: 'status', 'aria-live': 'polite' },
      texto: texto || 'Cargando…'
    }));
    return null;
  }

  function vacioEn(contenedor, texto, accion) {
    if (typeof U.vacio === 'function') return U.vacio(contenedor, texto, accion);
    limpiar(contenedor);
    contenedor.appendChild(el('div', { clase: 'vacio', texto: texto }));
    return null;
  }

  function errorEn(contenedor, err, reintentar) {
    if (typeof U.errorEn === 'function') return U.errorEn(contenedor, err, reintentar);
    limpiar(contenedor);
    contenedor.appendChild(el('div', {
      clase: 'error',
      atributos: { role: 'alert' },
      texto: (err && (err.mensaje || err.message)) || 'Algo salió mal.'
    }));
    return null;
  }

  /** Texto para el usuario de un ErrorApi o de un Error de camara. */
  function textoError(err) {
    if (err && typeof err.textoAmable === 'function') {
      try { return err.textoAmable(); } catch (e) { /* se cae al mensaje */ }
    }
    if (typeof U.textoDeMensaje === 'function') return U.textoDeMensaje(err);
    return (err && (err.mensaje || err.message)) || 'Algo salió mal.';
  }

  function codigoDe(err) {
    return err && typeof err.codigo === 'string' ? err.codigo : '';
  }

  // ---------------------------------------------------------------------------
  // Catalogos de texto
  // ---------------------------------------------------------------------------

  // Los cuatro puntos del protocolo de pesada. Se usan como casillas en #/hoy y
  // como recordatorio en #/yo: la misma lista, un solo sitio donde corregirla.
  var PROTOCOLO = [
    { clave: 'ayunas', etiqueta: 'En ayunas: antes de comer o beber nada' },
    { clave: 'bano', etiqueta: 'Después de ir al baño' },
    { clave: 'ropa', etiqueta: 'Con la misma ropa de siempre (o sin ropa)' },
    { clave: 'balanza', etiqueta: 'Con la misma balanza, sobre piso firme y plano' }
  ];

  var ANIMOS = [
    { valor: 'bien', etiqueta: 'Bien' },
    { valor: 'normal', etiqueta: 'Normal' },
    { valor: 'mal', etiqueta: 'Mal' }
  ];

  var ROLES = [
    { valor: 'participante', etiqueta: 'Participante (registra y compite)' },
    { valor: 'admin', etiqueta: 'Administrador (gestiona el reto)' },
    { valor: 'observador', etiqueta: 'Observador (solo mira)' }
  ];

  // Lista blanca de claves de configuracion que el administrador puede cambiar
  // desde la aplicacion. VERSION_ESQUEMA no esta: la mueven las migraciones del
  // backend, no una persona.
  var CLAVES_CONFIG = [
    { clave: 'RETO_NOMBRE', etiqueta: 'Nombre del reto', tipo: 'texto' },
    { clave: 'FECHA_INICIO', etiqueta: 'Fecha de inicio', tipo: 'fecha' },
    { clave: 'FECHA_FIN', etiqueta: 'Fecha de fin', tipo: 'fecha' },
    { clave: 'ZONA_HORARIA', etiqueta: 'Zona horaria', tipo: 'texto' },
    { clave: 'VENTANA_MOVIL_DIAS', etiqueta: 'Días del promedio móvil', tipo: 'entero' },
    { clave: 'MIN_DATOS_PROMEDIO', etiqueta: 'Mínimo de datos para el promedio', tipo: 'entero' },
    { clave: 'DIA_PESADA_OFICIAL', etiqueta: 'Día de la pesada oficial (1 = lunes)', tipo: 'entero' },
    { clave: 'FOTO_BALANZA_DIARIA_OBLIGATORIA', etiqueta: 'Pedir foto de la balanza todos los días', tipo: 'bool' },
    { clave: 'FOTO_BALANZA_OFICIAL_OBLIGATORIA', etiqueta: 'Pedir foto de la balanza el día oficial', tipo: 'bool' },
    { clave: 'CINTURA_OBLIGATORIA_OFICIAL', etiqueta: 'Pedir cintura el día oficial', tipo: 'bool' },
    { clave: 'PESO_MIN_KG', etiqueta: 'Peso mínimo aceptado (kg)', tipo: 'numero' },
    { clave: 'PESO_MAX_KG', etiqueta: 'Peso máximo aceptado (kg)', tipo: 'numero' },
    { clave: 'DELTA_DIARIO_MAX_KG', etiqueta: 'Variación diaria que se marca para revisión (kg)', tipo: 'numero' },
    { clave: 'CINTURA_MIN_CM', etiqueta: 'Cintura mínima aceptada (cm)', tipo: 'numero' },
    { clave: 'CINTURA_MAX_CM', etiqueta: 'Cintura máxima aceptada (cm)', tipo: 'numero' },
    { clave: 'EDICION_MISMO_DIA', etiqueta: 'Permitir corregir el registro el mismo día', tipo: 'bool' },
    { clave: 'OBSERVADOR_VE_FOTOS', etiqueta: 'Los observadores ven las fotos', tipo: 'bool' },
    { clave: 'TASA_SEMANAL_SANA_MIN', etiqueta: 'Ritmo semanal sano, mínimo (% del peso)', tipo: 'numero' },
    { clave: 'TASA_SEMANAL_SANA_MAX', etiqueta: 'Ritmo semanal sano, máximo (% del peso)', tipo: 'numero' }
  ];

  var TXT_METRICA = 'El ranking se mide en porcentaje del peso inicial perdido, ' +
    'no en kilos: así compiten parejo personas de distinto tamaño. Y se compara ' +
    'el promedio de los últimos 7 días, no la pesada de un día suelto, porque el ' +
    'peso sube y baja cada día por el agua y la comida.';

  // ---------------------------------------------------------------------------
  // Estado del arranque y del router
  // ---------------------------------------------------------------------------

  var vista = null;
  var cabTitulo = null;
  var cabUsuario = null;
  var btnSalir = null;
  var nav = null;

  var estado = {
    generacion: 0,      // cada cambio de vista invalida el pintado anterior
    authListo: false,
    autenticado: false,
    correo: null,
    perfil: null,
    sesion: null,
    promesaSesion: null,
    noInscrito: false,
    filtroHistorial: '',
    correosPorId: {},
    obsFotos: null,
    arrancado: false
  };

  function vigente(gen) {
    return gen === estado.generacion;
  }

  function rol() {
    var s = estado.sesion;
    var r = s && s.usuario && typeof s.usuario.rol === 'string' ? s.usuario.rol : '';
    return r.trim().toLowerCase();
  }

  function esAdmin() { return rol() === 'admin'; }
  function esObservador() { return rol() === 'observador'; }
  function puedeRegistrar() { return rol() === 'participante' || rol() === 'admin'; }

  function reto() {
    var s = estado.sesion;
    return (s && s.reto && typeof s.reto === 'object') ? s.reto : {};
  }

  function configReto() {
    var c = reto().config;
    return c && typeof c === 'object' ? c : {};
  }

  /**
   * true solo si la sesion dice que hoy se puede corregir el registro. Se lee
   * primero el campo del reto y, si el backend no lo publica, la clave de
   * configuracion. Ante la duda devuelve false: ofrecer un boton de editar que
   * el servidor va a rechazar es peor que no ofrecerlo.
   */
  function edicionPermitida() {
    var r = reto();
    if (typeof r.edicionMismoDia === 'boolean') return r.edicionMismoDia;
    var c = configReto();
    if (typeof c.EDICION_MISMO_DIA === 'boolean') return c.EDICION_MISMO_DIA;
    if (typeof c.EDICION_MISMO_DIA === 'string') {
      return c.EDICION_MISMO_DIA.trim().toUpperCase() === 'TRUE';
    }
    return false;
  }

  function requisitos() {
    var r = estado.sesion && estado.sesion.requisitos;
    if (!r || typeof r !== 'object') {
      return { fotoEjercicio: true, fotoBalanza: false, cintura: false, protocolo: true };
    }
    return {
      fotoEjercicio: r.fotoEjercicio !== false,
      fotoBalanza: !!r.fotoBalanza,
      cintura: !!r.cintura,
      protocolo: r.protocolo !== false
    };
  }

  // ---------------------------------------------------------------------------
  // Piezas de interfaz reutilizables
  // ---------------------------------------------------------------------------

  function tarjeta(titulo, cuerpo, pie) {
    var caja = el('section', { clase: 'tarjeta' });
    if (titulo) caja.appendChild(el('h2', { clase: 'tarjeta__titulo' }, titulo));
    caja.appendChild(el('div', { clase: 'tarjeta__cuerpo' }, cuerpo));
    if (pie) caja.appendChild(el('div', { clase: 'tarjeta__pie' }, pie));
    return caja;
  }

  function stat(valor, etiqueta, pie) {
    return el('div', { clase: 'stat' }, [
      el('span', { clase: 'stat__valor' }, valor),
      el('span', { clase: 'stat__etiqueta' }, etiqueta),
      pie ? el('span', { clase: 'stat__pie' }, pie) : null
    ]);
  }

  function chip(texto, variante) {
    return el('span', { clase: ['chip', variante ? 'chip--' + variante : null] }, texto);
  }

  function boton(texto, opciones) {
    var o = opciones || {};
    var clases = ['boton'];
    if (o.variante) clases.push('boton--' + o.variante);
    if (o.bloque) clases.push('boton--bloque');
    var props = { type: 'button', clase: clases };
    if (typeof o.alPulsar === 'function') props.onclick = o.alPulsar;
    if (o.etiquetaAria) props.atributos = { 'aria-label': o.etiquetaAria };
    var b = el('button', props, texto);
    if (o.deshabilitado) b.disabled = true;
    return b;
  }

  function enlaceBoton(texto, destino, opciones) {
    var o = opciones || {};
    var clases = ['boton'];
    if (o.variante) clases.push('boton--' + o.variante);
    if (o.bloque) clases.push('boton--bloque');
    return el('a', { clase: clases, href: destino }, texto);
  }

  /**
   * barra(pct, etiqueta) -> .barra con relleno acotado a 0-100.
   * Lleva role="progressbar" y aria-valuenow: sin eso un lector de pantalla no
   * ve nada, porque el ancho vive en el estilo.
   */
  function barra(pct, etiqueta) {
    var v = numero(pct);
    if (v === null) v = 0;
    if (v < 0) v = 0;
    if (v > 100) v = 100;
    var relleno = el('span', { clase: 'barra__relleno' });
    relleno.style.width = fmtNum(v, 1).replace(',', '.') + '%';
    return el('div', {
      clase: 'barra',
      atributos: {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(Math.round(v)),
        'aria-label': etiqueta || 'Avance'
      }
    }, relleno);
  }

  /** Explicacion del semaforo en lenguaje simple, sin jerga. */
  function textoSemaforo(clave, minimo, maximo) {
    var min = fmtNum(minimo === null || minimo === undefined ? 0.5 : minimo, 1);
    var max = fmtNum(maximo === null || maximo === undefined ? 1 : maximo, 1);
    if (clave === 'lento') {
      return 'Ritmo tranquilo: bajas menos de ' + min + ' % de tu peso por semana. ' +
        'Es sostenible, pero el resultado tarda más.';
    }
    if (clave === 'sano') {
      return 'Ritmo saludable: entre ' + min + ' % y ' + max + ' % de tu peso por semana.';
    }
    if (clave === 'agresivo') {
      return 'Ritmo acelerado: bajas más de ' + max + ' % de tu peso por semana. ' +
        'Conviene aflojar y comer suficiente.';
    }
    return 'Todavía no hay semanas suficientes para calcular tu ritmo.';
  }

  function semaforo(clave, minimo, maximo) {
    var etiqueta = clave === 'lento' ? 'Lento'
      : clave === 'sano' ? 'Saludable'
        : clave === 'agresivo' ? 'Acelerado' : 'Sin ritmo todavía';
    var caja = el('div', { clase: 'apilado' });
    caja.appendChild(el('p', {
      clase: ['semaforo', clave ? 'semaforo--' + clave : null]
    }, etiqueta));
    caja.appendChild(el('p', { clase: 'stat__pie' }, textoSemaforo(clave, minimo, maximo)));
    return caja;
  }

  /**
   * crearCampo(o) -> {caja, control, marcar(mensaje), limpiar()}
   *
   * o: {id, etiqueta, tipo, ayuda, obligatorio, atributos, opciones, valor,
   *     alEscribir}
   *
   * La etiqueta lleva "(obligatorio)" en el texto, no solo un asterisco de
   * color: asi lo escucha un lector de pantalla y lo ve quien no distingue
   * colores.
   */
  function crearCampo(o) {
    var id = o.id;
    var idAyuda = id + '-ayuda';
    var idError = id + '-error';

    var caja = el('div', { clase: 'campo' });
    var textoEtiqueta = o.etiqueta + (o.obligatorio ? ' (obligatorio)' : '');
    caja.appendChild(el('label', { clase: 'campo__etiqueta', for: id }, textoEtiqueta));

    var control;
    if (o.tipo === 'textarea') {
      control = el('textarea', { id: id, clase: 'campo__control' });
    } else if (o.tipo === 'select') {
      control = el('select', { id: id, clase: 'campo__control' });
      var lista = Array.isArray(o.opciones) ? o.opciones : [];
      for (var i = 0; i < lista.length; i++) {
        var op = el('option', { value: String(lista[i].valor) }, lista[i].etiqueta);
        control.appendChild(op);
      }
    } else {
      control = el('input', { id: id, clase: 'campo__control', type: o.tipo || 'text' });
    }

    var describedby = [];
    if (o.ayuda) describedby.push(idAyuda);
    describedby.push(idError);
    control.setAttribute('aria-describedby', describedby.join(' '));
    if (o.obligatorio) control.required = true;

    if (o.atributos) {
      Object.keys(o.atributos).forEach(function (k) {
        var v = o.atributos[k];
        if (v === null || v === undefined) return;
        control.setAttribute(k, String(v));
      });
    }
    if (o.valor !== null && o.valor !== undefined) control.value = String(o.valor);
    if (typeof o.alEscribir === 'function') control.addEventListener('input', o.alEscribir);

    caja.appendChild(control);
    if (o.ayuda) caja.appendChild(el('p', { id: idAyuda, clase: 'campo__ayuda' }, o.ayuda));
    var error = el('p', {
      id: idError,
      clase: 'campo__error',
      atributos: { 'aria-live': 'polite' }
    });
    caja.appendChild(error);

    return {
      caja: caja,
      control: control,
      marcar: function (mensaje) {
        caja.classList.add('campo--malo');
        control.setAttribute('aria-invalid', 'true');
        error.textContent = mensaje || 'Revisa este dato.';
      },
      limpiar: function () {
        caja.classList.remove('campo--malo');
        control.removeAttribute('aria-invalid');
        error.textContent = '';
      }
    };
  }

  /** Casilla dentro de su etiqueta: la asociacion no depende de ningun id. */
  function crearCheck(id, etiqueta, marcada) {
    var control = el('input', { id: id, type: 'checkbox', clase: 'check__caja' });
    if (marcada) control.checked = true;
    var caja = el('label', { clase: 'check' }, [control, el('span', {}, etiqueta)]);
    return { caja: caja, control: control };
  }

  function crearRadios(nombre, opciones, valorInicial) {
    var grupo = el('div', { clase: 'grupo-check' });
    var controles = [];
    for (var i = 0; i < opciones.length; i++) {
      var o = opciones[i];
      var radio = el('input', {
        type: 'radio',
        name: nombre,
        clase: 'check__caja',
        value: String(o.valor)
      });
      if (valorInicial !== null && valorInicial !== undefined && String(valorInicial) === String(o.valor)) {
        radio.checked = true;
      }
      controles.push(radio);
      grupo.appendChild(el('label', { clase: 'check' }, [radio, el('span', {}, o.etiqueta)]));
    }
    return {
      caja: grupo,
      controles: controles,
      valor: function () {
        for (var j = 0; j < controles.length; j++) {
          if (controles[j].checked) return controles[j].value;
        }
        return '';
      }
    };
  }

  function grupoConLeyenda(leyenda, contenido, ayuda) {
    var caja = el('fieldset', { clase: 'campo' });
    caja.style.border = '0';
    caja.style.margin = '0';
    caja.style.padding = '0';
    caja.appendChild(el('legend', { clase: 'campo__etiqueta' }, leyenda));
    if (ayuda) caja.appendChild(el('p', { clase: 'campo__ayuda' }, ayuda));
    caja.appendChild(contenido);
    return caja;
  }

  function listaSinVinetas(tag, clase) {
    var nodo = el(tag, { clase: clase });
    nodo.style.listStyle = 'none';
    nodo.style.margin = '0';
    nodo.style.padding = '0';
    return nodo;
  }

  function figuraGrafico(titulo, pie) {
    var caja = el('figure', {});
    var lienzo = el('div', {});
    caja.appendChild(lienzo);
    if (pie) caja.appendChild(el('figcaption', {}, pie));
    return { caja: caja, lienzo: lienzo, titulo: titulo };
  }

  // ---------------------------------------------------------------------------
  // Modal propio (fotos grandes y formularios cortos)
  // ---------------------------------------------------------------------------
  //
  // Reusa el #modal del index.html sin destruirlo, igual que U.confirmar: se
  // escribe en #modal-titulo y #modal-cuerpo y se dejan intactos el fondo y la
  // X. Solo hay un modal abierto a la vez.

  var modal = { abierto: false, host: null, caja: null, titulo: null, cuerpo: null, antes: null, teclado: null };

  var SELECTOR_FOCO = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(', ');

  function enfocables(raiz) {
    return (U.qsa ? U.qsa(SELECTOR_FOCO, raiz) : []).filter(function (n) {
      return !n.disabled && n.getAttribute('aria-hidden') !== 'true' &&
        (n.offsetWidth || n.offsetHeight || n.getClientRects().length);
    });
  }

  function abrirModal(tituloTexto, contenido) {
    var host = document.getElementById('modal');
    var caja = host ? qs('.modal__caja', host) : null;
    var titulo = host ? qs('#modal-titulo', host) : null;
    var cuerpo = host ? qs('#modal-cuerpo', host) : null;
    if (!host || !caja || !cuerpo) return null;

    if (modal.abierto) cerrarModal();

    modal.host = host;
    modal.caja = caja;
    modal.titulo = titulo;
    modal.cuerpo = cuerpo;
    modal.antes = document.activeElement;

    if (titulo) titulo.textContent = tituloTexto || '';
    limpiar(cuerpo);
    if (contenido) cuerpo.appendChild(contenido);

    host.classList.remove('oculto');
    document.body.style.overflow = 'hidden';

    modal.teclado = function (ev) {
      if (ev.key === 'Escape' || ev.key === 'Esc') {
        ev.preventDefault();
        cerrarModal();
        return;
      }
      if (ev.key !== 'Tab') return;
      var lista = enfocables(caja);
      if (!lista.length) return;
      var primero = lista[0];
      var ultimo = lista[lista.length - 1];
      var activo = document.activeElement;
      if (ev.shiftKey && (activo === primero || !caja.contains(activo))) {
        ev.preventDefault();
        ultimo.focus();
      } else if (!ev.shiftKey && activo === ultimo) {
        ev.preventDefault();
        primero.focus();
      }
    };
    document.addEventListener('keydown', modal.teclado, true);
    modal.abierto = true;

    var foco = enfocables(caja);
    if (foco.length) {
      try { foco[0].focus(); } catch (e) { /* sin foco disponible */ }
    }
    return cuerpo;
  }

  function cerrarModal() {
    if (!modal.abierto) return;
    modal.abierto = false;
    if (modal.teclado) document.removeEventListener('keydown', modal.teclado, true);
    modal.teclado = null;
    if (modal.cuerpo) limpiar(modal.cuerpo);
    if (modal.titulo) modal.titulo.textContent = '';
    if (modal.host) modal.host.classList.add('oculto');
    document.body.style.overflow = '';
    var antes = modal.antes;
    modal.antes = null;
    if (antes && typeof antes.focus === 'function' && document.contains(antes)) {
      try { antes.focus(); } catch (e) { /* el nodo ya no acepta foco */ }
    }
  }

  /**
   * confirmar(pregunta, opciones) -> Promise<boolean>
   * Cierra primero el modal propio: los dos usan el mismo #modal y no pueden
   * pisarse el contenido.
   */
  function confirmar(pregunta, opciones) {
    cerrarModal();
    if (typeof U.confirmar === 'function') return U.confirmar(pregunta, opciones);
    return Promise.resolve(false);
  }

  // ---------------------------------------------------------------------------
  // Cabecera, navegacion y pie
  // ---------------------------------------------------------------------------

  function pintarCabecera() {
    if (cabTitulo) {
      var nombre = reto().nombre;
      cabTitulo.textContent = (typeof nombre === 'string' && nombre.trim())
        ? nombre.trim()
        : 'Reto de peso';
    }

    if (cabUsuario) {
      limpiar(cabUsuario);
      if (estado.autenticado) {
        var p = estado.perfil || {};
        var s = estado.sesion;
        var nombreUsuario = (s && s.usuario && s.usuario.nombre) || p.nombre || p.email || 'Tu cuenta';
        if (p.foto) {
          // Auth.usuario() solo devuelve https o data:image, nunca otro esquema.
          cabUsuario.appendChild(el('img', {
            clase: 'cab__avatar',
            src: p.foto,
            alt: '',
            atributos: { 'aria-hidden': 'true', width: '32', height: '32', decoding: 'sync' }
          }));
        }
        cabUsuario.appendChild(el('strong', {}, nombreUsuario));
      }
    }

    if (btnSalir) {
      if (estado.autenticado) btnSalir.classList.remove('oculto');
      else btnSalir.classList.add('oculto');
    }
  }

  function mostrarNav(mostrar) {
    if (!nav) return;
    if (mostrar) nav.classList.remove('oculto');
    else nav.classList.add('oculto');
  }

  function marcarNav(ruta) {
    var enlaces = U.qsa ? U.qsa('#nav .nav__link') : [];
    for (var i = 0; i < enlaces.length; i++) {
      var a = enlaces[i];
      var suya = a.getAttribute('data-ruta');
      if (suya === ruta) {
        a.classList.add('nav__link--activo');
        a.setAttribute('aria-current', 'page');
      } else {
        a.classList.remove('nav__link--activo');
        a.removeAttribute('aria-current');
      }
    }
  }

  /** Oculta las secciones que el rol actual no puede usar. */
  function ajustarNavPorRol() {
    var admin = qs('#nav a[data-ruta="admin"]');
    if (admin) {
      if (esAdmin()) admin.classList.remove('oculto');
      else admin.classList.add('oculto');
    }
    var hoy = qs('#nav a[data-ruta="hoy"]');
    if (hoy) {
      if (esObservador()) hoy.classList.add('oculto');
      else hoy.classList.remove('oculto');
    }
  }

  function pintarPie() {
    var v = qs('#pie-version');
    if (!v) return;
    var version = typeof CFG.VERSION === 'string' && CFG.VERSION ? CFG.VERSION : '1.0.0';
    v.textContent = 'Versión ' + version + (CFG.DEMO ? ' · demostración' : '');
  }

  function ocultarPantallaCarga() {
    var capa = qs('#pantalla-carga');
    if (capa) capa.classList.add('oculto');
  }

  // ---------------------------------------------------------------------------
  // Sesion
  // ---------------------------------------------------------------------------

  function recordarCorreo(participante) {
    if (!participante || typeof participante !== 'object') return;
    if (participante.id && participante.email) {
      estado.correosPorId[participante.id] = participante.email;
    }
  }

  function aplicarSesion(datos) {
    estado.sesion = datos;
    recordarCorreo(datos && datos.usuario);
    pintarCabecera();
    ajustarNavPorRol();
  }

  /**
   * asegurarSesion(recargar) -> Promise<sesion>
   *
   * Una sola peticion en vuelo: si dos vistas la piden a la vez, comparten la
   * misma promesa. NO_INSCRITO se marca en el estado para que el router muestre
   * la pantalla dedicada en vez de un error suelto.
   */
  function asegurarSesion(recargar) {
    if (!recargar && estado.sesion) return Promise.resolve(estado.sesion);
    if (estado.promesaSesion) return estado.promesaSesion;

    estado.promesaSesion = Api.sesion().then(function (datos) {
      estado.promesaSesion = null;
      estado.noInscrito = false;
      aplicarSesion(datos || {});
      return estado.sesion;
    }, function (err) {
      estado.promesaSesion = null;
      estado.sesion = null;
      estado.noInscrito = codigoDe(err) === 'NO_INSCRITO';
      throw err;
    });
    return estado.promesaSesion;
  }

  // ---------------------------------------------------------------------------
  // Metricas de apoyo para los graficos (solo para pintar)
  // ---------------------------------------------------------------------------

  /**
   * Promedio movil igual al del backend (lib_metricas.promedioMovil): ventana de
   * ventanaDias terminando en fechaRef, y null si no llega a minDatos. Se
   * recalcula aqui solo para dibujar la curva; el numero que manda es el que
   * devuelve el servidor en metricas.
   */
  function promedioMovil(serie, fechaRef, ventanaDias, minDatos) {
    var ventana = Math.max(1, Math.trunc(numero(ventanaDias) || VENTANA_POR_DEFECTO));
    var minimo = Math.max(1, Math.trunc(numero(minDatos) || MIN_DATOS_POR_DEFECTO));
    var suma = 0;
    var cuenta = 0;
    for (var i = 0; i < serie.length; i++) {
      var atras = U.diasEntre ? U.diasEntre(serie[i].fecha, fechaRef) : null;
      if (atras === null || atras < 0) continue;
      if (atras > (ventana - 1)) continue;
      suma += serie[i].pesoKg;
      cuenta++;
    }
    if (cuenta < minimo) return null;
    return suma / cuenta;
  }

  /** Acepta [{fecha,pesoKg}] o [{x,y}] y devuelve [{fecha,pesoKg}] ordenado. */
  function normalizarSerieCruda(entrada) {
    var lista = Array.isArray(entrada) ? entrada : [];
    var salida = [];
    for (var i = 0; i < lista.length; i++) {
      var p = lista[i];
      if (!p || typeof p !== 'object') continue;
      var fecha = typeof p.fecha === 'string' ? p.fecha.slice(0, 10)
        : (typeof p.x === 'string' ? p.x.slice(0, 10) : '');
      var peso = numero(p.pesoKg !== undefined ? p.pesoKg : p.y);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || peso === null || peso <= 0) continue;
      salida.push({ fecha: fecha, pesoKg: peso, cinturaCm: numero(p.cinturaCm) });
    }
    salida.sort(function (a, b) { return a.fecha < b.fecha ? -1 : (a.fecha > b.fecha ? 1 : 0); });
    return salida;
  }

  /** Puntos de una serie del resumen, sea cual sea el nombre del campo. */
  function puntosDeSerie(s) {
    if (!s || typeof s !== 'object') return [];
    if (Array.isArray(s.puntos)) return normalizarSerieCruda(s.puntos);
    if (Array.isArray(s.serie)) return normalizarSerieCruda(s.serie);
    if (Array.isArray(s.datos)) return normalizarSerieCruda(s.datos);
    if (Array.isArray(s.registros)) return normalizarSerieCruda(s.registros);
    return [];
  }

  /** Promedio de los primeros 3 pesos: respaldo si metricas no trae pesoBase. */
  function pesoBaseDe(serie) {
    if (!serie.length) return null;
    var cuantos = Math.min(3, serie.length);
    var suma = 0;
    for (var i = 0; i < cuantos; i++) suma += serie[i].pesoKg;
    return suma / cuantos;
  }

  /** [{x, y}] con el porcentaje perdido dia a dia sobre el promedio movil. */
  function puntosPorcentaje(serie, base, ventana, minDatos) {
    var salida = [];
    if (!base || base <= 0) return salida;
    for (var i = 0; i < serie.length; i++) {
      var avg = promedioMovil(serie, serie[i].fecha, ventana, minDatos);
      salida.push({
        x: serie[i].fecha,
        y: avg === null ? null : ((base - avg) / base) * 100
      });
    }
    return salida;
  }

  function puntosPeso(serie) {
    return serie.map(function (p) { return { x: p.fecha, y: p.pesoKg }; });
  }

  function puntosSuavizado(serie, ventana, minDatos) {
    return serie.map(function (p) {
      return { x: p.fecha, y: promedioMovil(serie, p.fecha, ventana, minDatos) };
    });
  }

  // ---------------------------------------------------------------------------
  // Fotos con carga perezosa
  // ---------------------------------------------------------------------------

  function observadorFotos() {
    if (estado.obsFotos) return estado.obsFotos;
    if (typeof IntersectionObserver !== 'function') return null;
    var mapa = new Map();
    var obs = new IntersectionObserver(function (entradas) {
      for (var i = 0; i < entradas.length; i++) {
        if (!entradas[i].isIntersecting) continue;
        var nodo = entradas[i].target;
        var fn = mapa.get(nodo);
        mapa.delete(nodo);
        obs.unobserve(nodo);
        if (typeof fn === 'function') fn();
      }
    }, { rootMargin: '240px 0px', threshold: 0.01 });
    obs.mapa = mapa;
    estado.obsFotos = obs;
    return obs;
  }

  function soltarObservadores() {
    if (!estado.obsFotos) return;
    try { estado.obsFotos.disconnect(); } catch (e) { /* ya estaba suelto */ }
    estado.obsFotos = null;
  }

  /**
   * Miniatura que solo pide la foto cuando entra en pantalla. Sin esto, un feed
   * de 60 registros bajaria 120 imagenes en base64 de golpe.
   */
  function miniaturaFoto(o) {
    var gen = estado.generacion;
    // Sin loading="lazy" ni decoding="async" a proposito: el src que se le
    // asigna mas abajo es un data URI, o sea que no hay peticion de red que
    // diferir, y la pereza ya la hace el IntersectionObserver de esta misma
    // funcion. Con esos atributos el navegador mete un segundo diferido sobre
    // un dato que ya tiene en memoria y deja miniaturas visibles sin pintar,
    // mostrando el texto alternativo en su lugar.
    var img = el('img', {
      alt: o.alt || 'Foto del registro',
      atributos: { decoding: 'sync' }
    });
    var caja = el('button', {
      type: 'button',
      clase: 'foto-mini',
      atributos: { 'aria-label': o.etiquetaBoton || 'Ver la foto en grande' },
      onclick: function () { abrirModalFoto(o.fotoIdGrande || o.fotoId, o.tituloModal, o.alt); }
    }, img);

    var pedida = false;
    function cargar() {
      if (pedida) return;
      pedida = true;
      Api.foto(o.fotoId, 'thumb').then(function (uri) {
        if (!vigente(gen) || !caja.isConnected) return;
        img.src = uri;
      }, function (err) {
        if (!vigente(gen) || !caja.isConnected) return;
        // El boton NO se desactiva: era la unica ruta de datos de la app sin
        // reintento, y dejaba la foto inalcanzable para siempre. Ademas hay que
        // distinguir "fallo la carga" de "este registro no tiene foto": la
        // segunda es informacion, la primera es un error que se puede reintentar.
        // (P1.11 de la revision 2026-09-04.)
        pedida = false;
        var codigo = err && err.codigo ? err.codigo : '';
        var motivo = codigo === 'LIMITE_TASA'
          ? 'Muchas fotos a la vez. Toca para reintentar.'
          : 'No se pudo cargar. Toca para reintentar.';
        caja.setAttribute('aria-label', motivo);
        caja.title = motivo;
        limpiar(caja);
        caja.appendChild(el('span', { clase: 'stat__pie' }, 'Reintentar'));
        caja.onclick = function () {
          limpiar(caja);
          caja.appendChild(img);
          caja.onclick = function () {
            abrirModalFoto(o.fotoIdGrande || o.fotoId, o.tituloModal, o.alt);
          };
          caja.setAttribute('aria-label', o.etiquetaBoton || 'Ver la foto en grande');
          cargar();
        };
      });
    }

    var obs = observadorFotos();
    if (!obs) cargar();
    else {
      obs.mapa.set(caja, cargar);
      obs.observe(caja);
    }
    return caja;
  }

  function abrirModalFoto(fotoId, titulo, alt) {
    if (!fotoId) return;
    var gen = estado.generacion;
    var cuerpo = abrirModal(titulo || 'Foto del registro', null);
    if (!cuerpo) return;
    cargandoEn(cuerpo, 'Cargando la foto…');

    Api.foto(fotoId, 'full').then(function (uri) {
      if (!vigente(gen) || !modal.abierto) return;
      limpiar(cuerpo);
      var img = el('img', { src: uri, alt: alt || 'Foto del registro' });
      img.style.width = '100%';
      img.style.height = 'auto';
      img.style.borderRadius = '10px';
      cuerpo.appendChild(img);
      cuerpo.appendChild(el('div', { clase: 'apilado' },
        boton('Cerrar', { variante: 'fantasma', alPulsar: cerrarModal })));
    }, function (err) {
      if (!vigente(gen) || !modal.abierto) return;
      errorEn(cuerpo, textoError(err), { texto: 'Cerrar', alPulsar: cerrarModal });
    });
  }

  // ---------------------------------------------------------------------------
  // Pantallas de estado global
  // ---------------------------------------------------------------------------

  function pantallaConfigPendiente() {
    mostrarNav(false);
    marcarNav('');
    limpiar(vista);

    var pasos = el('ol', {});
    [
      'En Apps Script, ejecutar Instalador.instalar(): crea la hoja de datos, la ' +
        'carpeta privada de fotos y la semilla de las poses.',
      'Crear el ID de cliente de OAuth (tipo «aplicación web») en Google Cloud, ' +
        'agregar la dirección de esta página en los orígenes autorizados y ' +
        'cargarlo con Instalador.configurarClienteOauth().',
      'Publicar el Web App como «Ejecutar como: yo» y «Quien tiene acceso: ' +
        'cualquier persona», y copiar la dirección que termina en /exec.',
      'Pegar esa dirección en API_URL, dentro de web/js/config.js. Es el único ' +
        'valor que se copia aquí: el resto lo entrega el servidor.'
    ].forEach(function (t) { pasos.appendChild(el('li', {}, t)); });

    var cuerpo = [
      el('p', {}, 'La aplicación todavía no está conectada al servidor del reto. ' +
        'Nadie puede entrar hasta que quien administra complete estos pasos:'),
      pasos,
      el('p', { clase: 'campo__ayuda' }, 'Mientras tanto puedes recorrer todas las ' +
        'pantallas con datos de prueba, sin conectarte a nada.')
    ];

    vista.appendChild(tarjeta('Falta configurar el reto', cuerpo, [
      enlaceBoton('Ver el modo demostración', urlDemo(), { variante: 'primario' })
    ]));
  }

  function pantallaNoInscrito() {
    mostrarNav(false);
    marcarNav('');
    limpiar(vista);

    var correo = estado.correo || (estado.perfil && estado.perfil.email) || '';
    var cajaCorreo = el('p', {});
    cajaCorreo.appendChild(el('span', { clase: 'campo__etiqueta' }, 'Entraste con este correo:'));
    cajaCorreo.appendChild(el('br'));
    var fuerte = el('strong', {}, correo || 'no pudimos leer tu correo');
    fuerte.style.userSelect = 'all';
    fuerte.style.wordBreak = 'break-all';
    cajaCorreo.appendChild(fuerte);

    var cuerpo = [
      el('p', {}, 'Tu cuenta de Google funciona, pero este correo todavía no está ' +
        'en la lista del reto, así que no se puede registrar ni ver el tablero.'),
      cajaCorreo,
      el('p', {}, 'Pásale ese correo exacto a quien administra el reto para que te ' +
        'agregue. Tiene que ser el mismo, letra por letra: si te agrega otro, ' +
        'seguirás viendo esta pantalla.'),
      el('p', { clase: 'campo__ayuda' }, 'Cuando te agreguen, vuelve a intentarlo con el botón de abajo.')
    ];

    vista.appendChild(tarjeta('Todavía no estás en el reto', cuerpo, [
      boton('Volver a intentar', {
        variante: 'primario',
        alPulsar: function () {
          estado.noInscrito = false;
          estado.sesion = null;
          if (Api.invalidar) Api.invalidar('todo');
          enrutar();
        }
      }),
      boton('Entrar con otra cuenta', {
        variante: 'fantasma',
        alPulsar: function () { if (Auth.salir) Auth.salir(); }
      })
    ]));
  }

  function pantallaSinPermiso(texto, destino) {
    limpiar(vista);
    var cuerpo = [el('p', {}, texto)];
    vista.appendChild(tarjeta('Esta sección no es para tu rol', cuerpo, [
      enlaceBoton(destino === 'tablero' ? 'Ir al tablero' : 'Ir a hoy',
        '#/' + (destino || 'tablero'), { variante: 'primario' })
    ]));
  }

  function urlDemo(estadoDemo) {
    var base = '';
    try {
      base = window.location.pathname || '';
    } catch (e) {
      base = '';
    }
    var query = '?demo=1' + (estadoDemo ? '&estado=' + encodeURIComponent(estadoDemo) : '');
    return base + query + '#/hoy';
  }

  // ---------------------------------------------------------------------------
  // Vista: #/entrar
  // ---------------------------------------------------------------------------

  function vistaEntrar() {
    mostrarNav(false);
    marcarNav('');
    limpiar(vista);

    var cuerpo = [
      el('p', {}, 'Cada día te toca una pose de mano distinta: te pesas, te tomas ' +
        'la foto con esa pose y la otra persona la revisa.'),
      el('p', {}, 'Gana quien pierde más porcentaje de su peso inicial, medido con ' +
        'el promedio de los últimos 7 días.')
    ];

    if (Auth.caducado && Auth.caducado()) {
      cuerpo.push(el('div', { clase: 'error', atributos: { role: 'status' } },
        el('p', {}, 'Tu sesión anterior caducó. Vuelve a entrar con tu cuenta de Google.')));
    }

    var hueco = el('div', {});
    cuerpo.push(hueco);

    if (!CFG.DEMO) {
      cuerpo.push(el('p', { clase: 'campo__ayuda' },
        'Solo entran los correos que ya están en la lista del reto.'));
    }

    var pie = [];
    if (!CFG.DEMO) {
      pie.push(el('a', { href: urlDemo() }, 'Entrar en modo demostración'));
      pie.push(el('span', { clase: 'campo__ayuda' },
        'Datos de prueba, sin conexión con el reto real.'));
    }

    vista.appendChild(tarjeta('Entrar al reto', cuerpo, pie.length ? pie : null));

    // pintarBoton mide el ancho del contenedor: primero al DOM, despues pintar.
    if (typeof Auth.pintarBoton === 'function') Auth.pintarBoton(hueco);
  }

  // ---------------------------------------------------------------------------
  // Vista: #/ayuda
  // ---------------------------------------------------------------------------

  function vistaAyuda() {
    marcarNav('');
    limpiar(vista);

    var capas = el('ol', {});
    [
      'Pose del día: el servidor te asigna una pose de mano impredecible, distinta ' +
        'cada día y distinta para cada persona. La foto tiene que mostrarla.',
      'Foto en vivo: la aplicación solo puede tomar la foto con la cámara en ese ' +
        'momento. No existe manera de subir una imagen guardada.',
      'Revisión cruzada: la otra persona ve tu foto junto a la pose que te tocaba y ' +
        'la marca como correcta o con dudas.'
    ].forEach(function (t) { capas.appendChild(el('li', {}, t)); });

    var protocolo = el('ol', {});
    PROTOCOLO.forEach(function (p) { protocolo.appendChild(el('li', {}, p.etiqueta)); });

    vista.appendChild(tarjeta('Cómo se mide', [
      el('p', {}, TXT_METRICA),
      el('p', {}, 'El peso de referencia es el promedio de tus tres primeros ' +
        'registros, no el peso de un solo día: así un día inicial alto no regala ' +
        'porcentaje.')
    ]));

    vista.appendChild(tarjeta('Cómo se evita hacer trampa', [
      el('p', {}, 'Tres capas, y ninguna alcanza por sí sola:'),
      capas,
      el('p', { clase: 'campo__ayuda' }, 'Además, el servidor pone la fecha y la ' +
        'hora, guarda una huella de cada foto para rechazar la misma imagen dos ' +
        'veces y marca para revisión los saltos de peso improbables.')
    ]));

    vista.appendChild(tarjeta('Protocolo de la pesada', [
      el('p', {}, 'Pésate siempre igual; si cambias las condiciones, el número ' +
        'cambia sin que tu cuerpo haya cambiado:'),
      protocolo
    ], [
      enlaceBoton('Volver', '#/' + (estado.sesion ? rutaPorDefecto() : 'hoy'),
        { variante: 'fantasma' })
    ]));
  }

  // ---------------------------------------------------------------------------
  // Paso de camara (una foto: abrir, apuntar, capturar, repetir)
  // ---------------------------------------------------------------------------
  //
  // Solo puede haber un visor abierto a la vez: dos streams vivos dejan la
  // camara ocupada y en iOS el segundo falla con la camara tomada. Este modulo
  // guarda cual paso la tiene y lo cierra antes de abrir otro.

  var pasoConCamara = null;

  function crearPasoFoto(o) {
    var gen = estado.generacion;
    var captura = null;
    var visorAbierto = false;
    var caja = el('div', { clase: 'apilado' });
    var contenido = el('div', { clase: 'apilado' });
    var aviso = el('p', {
      clase: 'campo__error',
      atributos: { 'aria-live': 'polite' }
    });

    caja.appendChild(el('p', { clase: 'campo__etiqueta' }, o.titulo));
    caja.appendChild(el('p', { clase: 'campo__ayuda' }, o.instruccion));
    caja.appendChild(contenido);
    caja.appendChild(aviso);

    function avisar(texto) {
      aviso.textContent = texto || '';
    }

    /**
     * cerrarVisor(repintar) apaga la camara de este paso. Con repintar en true
     * ademas devuelve el bloque a su estado sin visor: se usa cuando OTRO paso
     * le quita la camara, para no dejar en pantalla un video muerto.
     */
    function cerrarVisor(repintar) {
      visorAbierto = false;
      if (pasoConCamara === api) pasoConCamara = null;
      if (typeof Camara.cerrar === 'function') {
        try { Camara.cerrar(); } catch (e) { /* idempotente */ }
      }
      if (!repintar) return;
      if (captura) pintarPrevia();
      else pintarInicial();
    }

    function pintarInicial() {
      limpiar(contenido);
      var pendiente = el('p', { clase: 'campo__ayuda' },
        'Todavía no tomaste esta foto.');
      contenido.appendChild(pendiente);
      contenido.appendChild(boton('Abrir la cámara', {
        variante: 'primario',
        bloque: true,
        alPulsar: abrir
      }));
    }

    function pintarSinCamara(motivo) {
      limpiar(contenido);
      contenido.appendChild(el('div', { clase: 'error', atributos: { role: 'alert' } }, [
        el('p', {}, motivo),
        boton('Volver a intentar', { variante: 'primario', alPulsar: abrir })
      ]));
    }

    function pintarPrevia() {
      limpiar(contenido);
      var uri = typeof Camara.previa === 'function' ? Camara.previa(captura.full) : null;
      if (uri) {
        contenido.appendChild(el('img', {
          clase: 'visor__previa',
          src: uri,
          alt: o.altPrevia || 'Foto que acabas de tomar'
        }));
      }
      contenido.appendChild(el('p', { clase: 'campo__ayuda' },
        'Revisa que se vea bien antes de enviar. Si no te gusta, repítela.'));
      var acciones = el('div', { clase: 'visor__acciones' });
      acciones.appendChild(boton('Repetir la foto', { variante: 'fantasma', alPulsar: abrir }));
      if (visorAbierto) {
        // La camara queda encendida y congelada para que repetir sea inmediato.
        // Quien no la quiera prendida puede apagarla aqui sin perder la foto.
        acciones.appendChild(boton('Apagar la cámara', {
          variante: 'fantasma',
          alPulsar: function () {
            cerrarVisor();
            pintarPrevia();
          }
        }));
      }
      contenido.appendChild(acciones);
      if (typeof o.alCambiar === 'function') o.alCambiar();
    }

    async function abrir() {
      avisar('');
      captura = null;
      if (typeof o.alCambiar === 'function') o.alCambiar();

      var apoyo = typeof Camara.soportada === 'function' ? Camara.soportada() : { ok: true };
      if (!apoyo || !apoyo.ok) {
        pintarSinCamara(apoyo && apoyo.motivo
          ? apoyo.motivo
          : 'No se puede usar la cámara en este dispositivo.');
        return;
      }

      // Otro paso puede tener el visor abierto: se cierra antes de pedir uno
      // nuevo, nunca dos a la vez.
      if (pasoConCamara && pasoConCamara !== api) pasoConCamara.cerrarVisor(true);
      cerrarVisor();

      limpiar(contenido);
      var video = el('video', {
        clase: 'visor__video',
        atributos: { playsinline: '', muted: '', 'aria-label': o.altVisor || 'Vista de la cámara' }
      });
      var visor = el('div', { clase: 'visor' });
      visor.appendChild(video);

      // La pose se repite ENCIMA del visor mientras se apunta: sin esto la
      // persona la lee, abre la camara y ya no la recuerda.
      var overlay = el('div', { clase: 'visor__overlay' });
      if (o.codigoPose) {
        overlay.appendChild(el('span', { clase: 'pose__codigo' }, o.codigoPose));
      }
      overlay.appendChild(el('p', {}, o.textoOverlay || o.instruccion));
      visor.appendChild(overlay);

      var btnCapturar = boton('Tomar la foto', { variante: 'primario' });
      var btnCambiar = boton('Cambiar de cámara', { variante: 'fantasma' });
      var btnCerrar = boton('Cerrar', { variante: 'fantasma' });
      visor.appendChild(el('div', { clase: 'visor__acciones' }, [btnCapturar, btnCambiar, btnCerrar]));

      contenido.appendChild(visor);
      var estadoVisor = el('p', {
        clase: 'campo__ayuda',
        atributos: { 'aria-live': 'polite' },
        texto: 'Encendiendo la cámara…'
      });
      contenido.appendChild(estadoVisor);

      btnCapturar.disabled = true;
      btnCambiar.disabled = true;

      btnCerrar.addEventListener('click', function () {
        cerrarVisor();
        pintarInicial();
      });

      btnCapturar.addEventListener('click', async function () {
        btnCapturar.disabled = true;
        btnCambiar.disabled = true;
        estadoVisor.textContent = 'Tomando la foto…';
        try {
          if (typeof Camara.congelar === 'function') Camara.congelar();
          captura = await Camara.capturar();
          if (!vigente(gen)) return;
          avisar('');
          pintarPrevia();
        } catch (err) {
          if (!vigente(gen)) return;
          captura = null;
          if (typeof Camara.reanudar === 'function') Camara.reanudar();
          btnCapturar.disabled = false;
          btnCambiar.disabled = false;
          estadoVisor.textContent = 'Apunta y vuelve a intentarlo.';
          avisar(textoError(err));
          avisoError(textoError(err));
          if (typeof o.alCambiar === 'function') o.alCambiar();
        }
      });

      btnCambiar.addEventListener('click', async function () {
        btnCambiar.disabled = true;
        estadoVisor.textContent = 'Cambiando de cámara…';
        try {
          await Camara.cambiarCamara();
          if (!vigente(gen)) return;
          estadoVisor.textContent = 'Cámara lista. Cuando te veas bien, toma la foto.';
        } catch (err) {
          if (!vigente(gen)) return;
          avisar(textoError(err));
        }
        if (vigente(gen)) btnCambiar.disabled = false;
      });

      try {
        await Camara.abrir(video, {
          alPerder: function (err) {
            if (!vigente(gen)) return;
            captura = null;
            avisar(textoError(err));
            if (typeof o.alCambiar === 'function') o.alCambiar();
          }
        });
      } catch (err) {
        if (!vigente(gen)) return;
        cerrarVisor();
        pintarSinCamara(textoError(err));
        return;
      }

      if (!vigente(gen)) {
        cerrarVisor();
        return;
      }

      pasoConCamara = api;
      visorAbierto = true;
      btnCapturar.disabled = false;
      btnCambiar.disabled = false;
      estadoVisor.textContent = 'Cámara lista. Cuando te veas bien, toma la foto.';
      try { btnCapturar.focus(); } catch (e) { /* sin foco disponible */ }
    }

    var api = {
      caja: caja,
      cerrarVisor: cerrarVisor,
      lista: function () { return !!captura; },
      captura: function () { return captura; },
      bytes: function () {
        return captura && typeof captura.bytes === 'number' ? captura.bytes : 0;
      },
      marcarError: function (texto) { avisar(texto); },
      reiniciar: function () {
        captura = null;
        cerrarVisor();
        pintarInicial();
        if (typeof o.alCambiar === 'function') o.alCambiar();
      }
    };

    pintarInicial();
    return api;
  }

  // ---------------------------------------------------------------------------
  // Vista: #/hoy
  // ---------------------------------------------------------------------------

  /** Chips de estado de un registro: oficial, marcado para revisar, anulado. */
  function chipsDeRegistro(reg) {
    var lista = [];
    if (reg.esPesadaOficial) lista.push(chip('Pesada oficial', 'oficial'));
    if (reg.revisar) lista.push(chip('Para revisar', 'revisar'));
    if (reg.anulado) lista.push(chip('Anulado', 'anulado'));
    var vs = Array.isArray(reg.verificaciones) ? reg.verificaciones : [];
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i] || {};
      var quien = v.verificadorNombre || 'Alguien';
      var ok = v.veredicto === 'ok';
      lista.push(chip(quien + ': ' + (ok ? 'correcta' : 'con dudas'), ok ? 'ok' : 'duda'));
    }
    return lista;
  }

  function bloquePose(pose, avisoExtra) {
    var caja = el('div', { clase: 'pose' });
    if (pose && pose.codigo) caja.appendChild(el('span', { clase: 'pose__codigo' }, pose.codigo));
    caja.appendChild(el('p', { clase: 'pose__texto' },
      (pose && pose.texto) ? pose.texto : 'Todavía no tienes pose asignada para hoy.'));
    caja.appendChild(el('p', { clase: 'pose__aviso' },
      avisoExtra || 'La pose cambia todos los días y no se puede adivinar. La otra ' +
      'persona va a mirar tu foto junto a esta pose, así que tiene que verse clara.'));
    if (pose && pose.reveladaEn) {
      var hora = fmtHora(pose.reveladaEn);
      if (hora && hora !== SIN_DATO) {
        caja.appendChild(el('p', { clase: 'pose__aviso' },
          'Se te reveló a las ' + hora + '.'));
      }
    }
    return caja;
  }

  /** Resumen del registro que ya existe hoy, con su foto. */
  function tarjetaRegistroDeHoy(reg, puedeEditar, alEditar) {
    var cuerpo = [];

    var rejilla = el('div', { clase: 'grid grid--2' }, [
      stat(fmtKg(reg.pesoKg), 'Peso de hoy'),
      reg.cinturaCm === null || reg.cinturaCm === undefined
        ? stat(SIN_DATO, 'Cintura', 'Hoy no se pidió')
        : stat(fmtNum(reg.cinturaCm, 1) + ' cm', 'Cintura')
    ]);
    cuerpo.push(rejilla);

    var chips = chipsDeRegistro(reg);
    if (chips.length) cuerpo.push(el('div', { clase: 'feed__cabecera' }, chips));

    if (reg.revisar && reg.motivoRevisar) {
      cuerpo.push(el('p', { clase: 'campo__ayuda' }, reg.motivoRevisar));
    }
    if (reg.nota) cuerpo.push(el('p', {}, reg.nota));

    if (reg.poseCodigo || reg.poseTexto) {
      cuerpo.push(bloquePose({ codigo: reg.poseCodigo, texto: reg.poseTexto },
        'Esta es la pose que te tocó hoy y con la que se revisa tu foto.'));
    }

    var fotos = el('div', { clase: 'feed__fotos' });
    var hayFoto = false;
    if (reg.fotoEjercicioThumbId) {
      hayFoto = true;
      fotos.appendChild(miniaturaFoto({
        fotoId: reg.fotoEjercicioThumbId,
        fotoIdGrande: reg.fotoEjercicioId || reg.fotoEjercicioThumbId,
        alt: 'Tu foto de hoy con la pose ' + (reg.poseTexto || reg.poseCodigo || ''),
        etiquetaBoton: 'Ver tu foto de hoy en grande',
        tituloModal: 'Tu foto de hoy'
      }));
    }
    if (reg.fotoBalanzaThumbId) {
      hayFoto = true;
      fotos.appendChild(miniaturaFoto({
        fotoId: reg.fotoBalanzaThumbId,
        fotoIdGrande: reg.fotoBalanzaId || reg.fotoBalanzaThumbId,
        alt: 'Tu foto de la balanza de hoy',
        etiquetaBoton: 'Ver tu foto de la balanza en grande',
        tituloModal: 'Tu foto de la balanza'
      }));
    }
    if (hayFoto) cuerpo.push(fotos);

    var pie = [];
    if (puedeEditar) {
      pie.push(boton('Corregir el registro de hoy', {
        variante: 'primario',
        alPulsar: alEditar
      }));
      pie.push(el('span', { clase: 'campo__ayuda' },
        'Solo hoy: mañana este registro queda cerrado.'));
    } else {
      pie.push(el('span', { clase: 'campo__ayuda' },
        'Este registro ya no se puede cambiar. Si hay un error, pídele a quien ' +
        'administra que lo anule.'));
    }

    return tarjeta('Ya registraste hoy', cuerpo, pie);
  }

  /**
   * Formulario completo del dia: pose, datos, camara y envio.
   * Se arma aparte porque tambien es lo que se muestra al corregir.
   */
  function formularioDeHoy(gen, sesion, pose, registroPrevio) {
    var req = requisitos();
    var cfg = configReto();
    var pesoMin = numero(cfg.PESO_MIN_KG);
    var pesoMax = numero(cfg.PESO_MAX_KG);
    if (pesoMin === null) pesoMin = 35;
    if (pesoMax === null) pesoMax = 250;
    var cinturaMin = numero(cfg.CINTURA_MIN_CM);
    var cinturaMax = numero(cfg.CINTURA_MAX_CM);
    if (cinturaMin === null) cinturaMin = 40;
    if (cinturaMax === null) cinturaMax = 200;

    var campos = {};
    var cuerpo = [];

    // 1) La pose, grande y antes de cualquier cosa de camara.
    cuerpo.push(bloquePose(pose));

    // 2) Datos de la pesada.
    campos.peso = crearCampo({
      id: 'campo-peso',
      etiqueta: 'Peso de hoy en kilos',
      tipo: 'number',
      obligatorio: true,
      ayuda: 'Entre ' + fmtNum(pesoMin, 1) + ' y ' + fmtNum(pesoMax, 1) + ' kg. Usa un decimal, por ejemplo 77,4.',
      atributos: {
        inputmode: 'decimal',
        step: '0.1',
        min: String(pesoMin),
        max: String(pesoMax),
        autocomplete: 'off'
      },
      valor: registroPrevio && registroPrevio.pesoKg !== null && registroPrevio.pesoKg !== undefined
        ? registroPrevio.pesoKg : ''
    });
    cuerpo.push(campos.peso.caja);

    if (req.cintura) {
      campos.cintura = crearCampo({
        id: 'campo-cintura',
        etiqueta: 'Cintura en centímetros',
        tipo: 'number',
        obligatorio: true,
        ayuda: 'Hoy es la pesada oficial y toca medir la cintura. Entre ' +
          fmtNum(cinturaMin, 0) + ' y ' + fmtNum(cinturaMax, 0) + ' cm.',
        atributos: {
          inputmode: 'decimal',
          step: '0.5',
          min: String(cinturaMin),
          max: String(cinturaMax),
          autocomplete: 'off'
        },
        valor: registroPrevio && registroPrevio.cinturaCm !== null && registroPrevio.cinturaCm !== undefined
          ? registroPrevio.cinturaCm : ''
      });
      cuerpo.push(campos.cintura.caja);
    }

    var animo = crearRadios('animo', ANIMOS, registroPrevio ? registroPrevio.animo : '');
    cuerpo.push(grupoConLeyenda('¿Cómo te sientes hoy?', animo.caja, 'Opcional.'));

    var contador = el('p', {
      clase: 'campo__ayuda',
      atributos: { 'aria-live': 'polite' }
    });
    function actualizarContador() {
      var usados = campos.nota.control.value.length;
      contador.textContent = usados + ' de ' + NOTA_MAX + ' caracteres.';
    }
    campos.nota = crearCampo({
      id: 'campo-nota',
      etiqueta: 'Nota del día',
      tipo: 'textarea',
      ayuda: 'Opcional: qué comiste, qué entrenaste, cómo dormiste.',
      atributos: { maxlength: String(NOTA_MAX) },
      valor: registroPrevio ? (registroPrevio.nota || '') : '',
      alEscribir: function () { actualizarContador(); }
    });
    campos.nota.caja.appendChild(contador);
    actualizarContador();
    cuerpo.push(campos.nota.caja);

    // 3) Protocolo: las cuatro casillas, todas obligatorias.
    var grupoChecks = el('div', { clase: 'grupo-check' });
    var checks = {};
    var errorProtocolo = el('p', {
      clase: 'campo__error',
      atributos: { 'aria-live': 'polite' }
    });
    for (var i = 0; i < PROTOCOLO.length; i++) {
      var p = PROTOCOLO[i];
      var previa = registroPrevio && registroPrevio.protocolo
        ? !!registroPrevio.protocolo[p.clave] : false;
      var c = crearCheck('check-' + p.clave, p.etiqueta, previa);
      checks[p.clave] = c.control;
      grupoChecks.appendChild(c.caja);
    }
    var cajaProtocolo = el('div', { clase: 'apilado' }, [grupoChecks, errorProtocolo]);
    cuerpo.push(grupoConLeyenda('Protocolo de la pesada (obligatorio: las cuatro)',
      cajaProtocolo,
      'Pésate siempre igual. Si cambian las condiciones, el número cambia sin que ' +
      'tu cuerpo haya cambiado.'));

    // 4) Camara: primero el ejercicio con la pose; la balanza va en su paso.
    var progreso = el('p', {
      clase: 'campo__ayuda',
      atributos: { 'aria-live': 'polite' }
    });
    var btnEnviar = boton(registroPrevio ? 'Guardar la corrección' : 'Enviar el registro de hoy', {
      variante: 'primario',
      bloque: true
    });
    var enviando = false;

    function refrescarEnvio() {
      var falta = !pasoEjercicio.lista() || (req.fotoBalanza && pasoBalanza && !pasoBalanza.lista());
      btnEnviar.disabled = !!falta || enviando;
      if (enviando) return;
      if (!pasoEjercicio.lista()) {
        progreso.textContent = 'Falta la foto con la pose del día.';
      } else if (req.fotoBalanza && pasoBalanza && !pasoBalanza.lista()) {
        progreso.textContent = 'Falta la foto de la balanza.';
      } else {
        progreso.textContent = 'Fotos listas. Revisa los datos y envía.';
      }
    }

    var pasoEjercicio = crearPasoFoto({
      titulo: 'Foto 1: tú con la pose del día (obligatoria)',
      instruccion: 'Sal en la foto haciendo exactamente la pose de arriba. Que se ' +
        'te vea la mano y la cara.',
      textoOverlay: pose && pose.texto ? pose.texto : 'Haz la pose del día',
      codigoPose: pose && pose.codigo ? pose.codigo : '',
      altVisor: 'Vista de la cámara para la foto con la pose',
      altPrevia: 'Foto tomada con la pose del día',
      alCambiar: function () { refrescarEnvio(); }
    });

    var pasoBalanza = null;
    if (req.fotoBalanza) {
      pasoBalanza = crearPasoFoto({
        titulo: 'Foto 2: la pantalla de la balanza (obligatoria hoy)',
        instruccion: 'Enfoca la pantalla de la balanza de cerca: lo importante es que ' +
          'se lea el número.',
        textoOverlay: 'Que se lea el número de la balanza',
        altVisor: 'Vista de la cámara para la foto de la balanza',
        altPrevia: 'Foto tomada de la pantalla de la balanza',
        alCambiar: function () { refrescarEnvio(); }
      });
    }

    var cajaFotos = el('div', { clase: 'apilado' }, [pasoEjercicio.caja]);
    if (pasoBalanza) cajaFotos.appendChild(pasoBalanza.caja);
    cuerpo.push(grupoConLeyenda('Fotos de hoy', cajaFotos,
      'La única forma de tomarlas es con la cámara ahora mismo: no se puede subir ' +
      'una imagen guardada.'));

    // 5) Envio.
    function limpiarErrores() {
      Object.keys(campos).forEach(function (k) { campos[k].limpiar(); });
      errorProtocolo.textContent = '';
      pasoEjercicio.marcarError('');
      if (pasoBalanza) pasoBalanza.marcarError('');
    }

    function marcarPorCampo(nombre, mensaje) {
      if (nombre === 'pesoKg' && campos.peso) { campos.peso.marcar(mensaje); return true; }
      if (nombre === 'cinturaCm' && campos.cintura) { campos.cintura.marcar(mensaje); return true; }
      if (nombre === 'nota' && campos.nota) { campos.nota.marcar(mensaje); return true; }
      if (nombre === 'fotoEjercicio') { pasoEjercicio.marcarError(mensaje); return true; }
      if (nombre === 'fotoBalanza' && pasoBalanza) { pasoBalanza.marcarError(mensaje); return true; }
      return false;
    }

    /** Valida en el cliente y devuelve el cuerpo de 7.2, o null si algo falla. */
    function armarEnvio() {
      limpiarErrores();
      var malos = [];

      var peso = numero(campos.peso.control.value);
      if (peso === null) {
        campos.peso.marcar('Escribe tu peso de hoy en kilos.');
        malos.push(campos.peso.control);
      } else if (peso < pesoMin || peso > pesoMax) {
        campos.peso.marcar('El peso tiene que estar entre ' + fmtNum(pesoMin, 1) +
          ' y ' + fmtNum(pesoMax, 1) + ' kg.');
        malos.push(campos.peso.control);
      }

      var cintura = null;
      if (campos.cintura) {
        cintura = numero(campos.cintura.control.value);
        if (cintura === null) {
          campos.cintura.marcar('Hoy toca medir la cintura.');
          malos.push(campos.cintura.control);
        } else if (cintura < cinturaMin || cintura > cinturaMax) {
          campos.cintura.marcar('La cintura tiene que estar entre ' + fmtNum(cinturaMin, 0) +
            ' y ' + fmtNum(cinturaMax, 0) + ' cm.');
          malos.push(campos.cintura.control);
        }
      }

      var nota = campos.nota.control.value;
      if (nota.length > NOTA_MAX) {
        campos.nota.marcar('La nota no puede pasar de ' + NOTA_MAX + ' caracteres.');
        malos.push(campos.nota.control);
      }

      var protocolo = {};
      var faltanChecks = [];
      for (var i = 0; i < PROTOCOLO.length; i++) {
        var clave = PROTOCOLO[i].clave;
        protocolo[clave] = !!checks[clave].checked;
        if (!protocolo[clave]) faltanChecks.push(checks[clave]);
      }
      if (faltanChecks.length) {
        errorProtocolo.textContent = 'Marca las cuatro condiciones de la pesada. Si ' +
          'alguna no se cumplió, el número no sirve para comparar.';
        malos.push(faltanChecks[0]);
      }

      if (!pasoEjercicio.lista()) {
        pasoEjercicio.marcarError('Falta la foto con la pose del día.');
        malos.push(null);
      }
      if (req.fotoBalanza && pasoBalanza && !pasoBalanza.lista()) {
        pasoBalanza.marcarError('Falta la foto de la balanza.');
        malos.push(null);
      }

      if (!pose || !pose.codigo) {
        avisoError('No tienes pose asignada para hoy. Recarga la pantalla de hoy.');
        return null;
      }

      if (malos.length) {
        avisoError('Faltan datos para poder guardar. Revisa lo que está marcado en rojo.');
        for (var j = 0; j < malos.length; j++) {
          if (!malos[j]) continue;
          try { malos[j].focus(); } catch (e) { /* sin foco disponible */ }
          break;
        }
        return null;
      }

      var capEj = pasoEjercicio.captura();
      var envio = {
        pesoKg: peso,
        animo: animo.valor(),
        nota: nota,
        protocolo: protocolo,
        poseCodigo: pose.codigo,
        origenFoto: 'camara',
        fotoEjercicio: { base64: capEj.full.base64, mime: capEj.full.mime, hash: capEj.hash },
        fotoEjercicioThumb: { base64: capEj.thumb.base64, mime: capEj.thumb.mime }
      };
      if (cintura !== null) envio.cinturaCm = cintura;
      if (pasoBalanza && pasoBalanza.lista()) {
        var capBa = pasoBalanza.captura();
        envio.fotoBalanza = { base64: capBa.full.base64, mime: capBa.full.mime, hash: capBa.hash };
        envio.fotoBalanzaThumb = { base64: capBa.thumb.base64, mime: capBa.thumb.mime };
      }
      return envio;
    }

    btnEnviar.addEventListener('click', async function () {
      if (enviando) return;
      var envio = armarEnvio();
      if (!envio) return;

      // Un segundo toque crearia dos registros del dia: el boton se apaga antes
      // de la primera peticion y solo se enciende si algo falla.
      enviando = true;
      btnEnviar.disabled = true;

      var kb = Math.round((pasoEjercicio.bytes() + (pasoBalanza ? pasoBalanza.bytes() : 0)) / 1024);
      var cuantas = pasoBalanza && pasoBalanza.lista() ? 'dos fotos' : 'la foto';
      progreso.textContent = 'Enviando ' + cuantas +
        (kb > 0 ? ' (unos ' + kb + ' KB)' : '') +
        '. Puede tardar hasta un minuto: no cierres la aplicación.';

      var resultado = null;
      var fallo = null;
      try {
        resultado = await Api.registrar(envio);
      } catch (err) {
        fallo = err;
      } finally {
        // La camara se cierra SIEMPRE, incluso si el envio fallo: si no, la luz
        // se queda encendida mientras la persona lee el error.
        if (typeof Camara.cerrar === 'function') {
          try { Camara.cerrar(); } catch (e) { /* idempotente */ }
        }
        pasoConCamara = null;
      }

      if (!vigente(gen)) return;

      if (!fallo) {
        avisoOk(registroPrevio
          ? 'Corrección guardada.'
          : 'Registro de hoy guardado. Mañana te toca una pose nueva.');
        estado.sesion = null;
        if (Api.invalidar) Api.invalidar('todo');
        irA('hoy', true);
        return;
      }

      enviando = false;
      var codigo = codigoDe(fallo);
      var mensaje = textoError(fallo);

      if (codigo === 'POSE_INCORRECTA' || codigo === 'POSE_NO_ASIGNADA') {
        // La pose cambio (o nunca se asigno): hay que recargarla y repetir la
        // foto, no reintentar con la misma.
        avisoError(mensaje);
        estado.sesion = null;
        irA('hoy', true);
        return;
      }
      if (codigo === 'YA_REGISTRADO' || codigo === 'REGISTRO_BLOQUEADO') {
        avisoError(mensaje);
        estado.sesion = null;
        if (Api.invalidar) Api.invalidar('todo');
        irA('hoy', true);
        return;
      }
      if (codigo === 'FOTO_DUPLICADA') {
        var cual = fallo.campo === 'fotoBalanza' ? pasoBalanza : pasoEjercicio;
        if (cual) {
          cual.marcarError('Esa foto ya se usó en otro registro. Tienes que tomar ' +
            'una foto nueva ahora mismo.');
          cual.reiniciar();
        }
        progreso.textContent = 'Toma la foto otra vez para poder guardar.';
        avisoError(mensaje);
        refrescarEnvio();
        return;
      }
      if (codigo === 'DATOS_INVALIDOS' && fallo.campo) {
        if (!marcarPorCampo(fallo.campo, mensaje)) avisoError(mensaje);
        else avisoError(mensaje);
        progreso.textContent = 'Corrige el dato marcado y vuelve a enviar.';
        refrescarEnvio();
        return;
      }

      avisoError(mensaje);
      progreso.textContent = 'No se guardó. Revisa el aviso y vuelve a intentarlo.';
      refrescarEnvio();
    });

    cuerpo.push(el('div', { clase: 'apilado' }, [progreso, btnEnviar]));
    refrescarEnvio();

    return tarjeta(registroPrevio ? 'Corregir el registro de hoy' : 'Registrar hoy', cuerpo);
  }

  async function vistaHoy(gen) {
    cargandoEn(vista, 'Cargando tu día…');

    var sesion = estado.sesion || {};

    if (esObservador()) {
      pantallaSinPermiso('Tu rol es de observador: puedes ver el tablero y el ' +
        'historial, pero no registrar pesadas.', 'tablero');
      return;
    }
    if (!puedeRegistrar()) {
      pantallaSinPermiso('Tu rol no puede registrar pesadas en este reto.', 'tablero');
      return;
    }

    var r = reto();
    if (r.iniciado === false) {
      limpiar(vista);
      vista.appendChild(tarjeta('El reto todavía no empieza', [
        el('p', {}, 'Podrás registrar tu peso desde el primer día del reto.'),
        el('p', { clase: 'campo__ayuda' }, r.fechaInicio
          ? 'Arranca el ' + fmtFecha(r.fechaInicio) + '.'
          : 'Quien administra todavía no fijó la fecha de inicio.')
      ], [enlaceBoton('Ver el tablero', '#/tablero', { variante: 'fantasma' })]));
      return;
    }
    if (r.cerrado === true) {
      limpiar(vista);
      vista.appendChild(tarjeta('El reto ya terminó', [
        el('p', {}, 'Ya no se aceptan registros nuevos, pero el tablero y el ' +
          'historial siguen disponibles.'),
        el('p', { clase: 'campo__ayuda' }, r.fechaFin
          ? 'Cerró el ' + fmtFecha(r.fechaFin) + '.' : '')
      ], [enlaceBoton('Ver el tablero', '#/tablero', { variante: 'primario' })]));
      return;
    }

    // La pose primero: sin ella no hay foto valida, y el servidor sella cuando
    // la persona la supo.
    var pose = null;
    var errorPose = null;
    try {
      pose = await Api.poseHoy();
    } catch (err) {
      errorPose = err;
    }
    if (!vigente(gen)) return;

    var registroHoy = null;
    if (sesion.registradoHoy) {
      try {
        var h = await Api.historial({ participanteId: sesion.usuario && sesion.usuario.id, limite: 3 });
        if (!vigente(gen)) return;
        var lista = (h && Array.isArray(h.registros)) ? h.registros : [];
        for (var i = 0; i < lista.length; i++) {
          if (lista[i] && lista[i].fecha === sesion.hoy && !lista[i].anulado) {
            registroHoy = lista[i];
            break;
          }
        }
      } catch (err2) {
        if (!vigente(gen)) return;
        // No poder leer el resumen del dia no impide seguir: se avisa y ya.
        avisoError(textoError(err2));
      }
    }

    limpiar(vista);

    var puedeEditar = !!registroHoy && edicionPermitida();

    if (registroHoy) {
      var contenedorForm = el('div', {});
      vista.appendChild(tarjetaRegistroDeHoy(registroHoy, puedeEditar, function () {
        if (errorPose || !pose) {
          avisoError(errorPose ? textoError(errorPose)
            : 'No se pudo leer tu pose de hoy. Recarga la pantalla.');
          return;
        }
        limpiar(contenedorForm);
        contenedorForm.appendChild(formularioDeHoy(gen, sesion, pose, registroHoy));
        try { contenedorForm.scrollIntoView({ block: 'start' }); } catch (e) { /* sin scroll suave */ }
      }));
      vista.appendChild(contenedorForm);
      if (!puedeEditar) {
        vista.appendChild(tarjeta('Mañana te toca otra pose', [
          el('p', {}, 'Vuelve mañana: el servidor te va a asignar una pose nueva y ' +
            'distinta a la de hoy.')
        ], [enlaceBoton('Ver el tablero', '#/tablero', { variante: 'fantasma' })]));
      }
      return;
    }

    if (errorPose || !pose) {
      errorEn(vista, errorPose ? textoError(errorPose)
        : 'No se pudo leer tu pose de hoy.', {
        texto: 'Reintentar',
        alPulsar: function () { irA('hoy', true); }
      });
      return;
    }

    if (sesion.esPesadaOficial) {
      vista.appendChild(el('div', { clase: 'vacio' },
        el('p', {}, 'Hoy es la pesada oficial de la semana: es la que se toma como ' +
          'referencia, así que hazla con calma.')));
    }

    vista.appendChild(formularioDeHoy(gen, sesion, pose, null));
  }

  // ---------------------------------------------------------------------------
  // Vista: #/tablero
  // ---------------------------------------------------------------------------

  function filaRanking(fila) {
    var item = el('li', { clase: 'ranking__fila' });

    var puesto = el('span', { clase: 'ranking__puesto' });
    var n = numero(fila.puesto);
    if (n !== null && n >= 1 && n <= 3) {
      puesto.appendChild(el('span', {
        clase: 'medalla',
        atributos: { 'aria-hidden': 'true' }
      }, String(n)));
      puesto.appendChild(el('span', { clase: 'solo-lectores' }, 'Puesto ' + n));
    } else if (n !== null) {
      puesto.textContent = String(n);
      puesto.setAttribute('aria-label', 'Puesto ' + n);
    } else {
      puesto.textContent = SIN_DATO;
      puesto.setAttribute('aria-label', 'Sin puesto todavía');
    }
    item.appendChild(puesto);

    var nombre = el('span', { clase: 'ranking__nombre' }, fila.nombre || 'Participante');
    item.appendChild(nombre);

    var pct = el('span', { clase: 'ranking__pct' });
    if (fila.datosSuficientes && numero(fila.pctPerdido) !== null) {
      pct.textContent = fmtPct(fila.pctPerdido);
    } else {
      pct.textContent = SIN_DATO;
      pct.setAttribute('title', 'Todavía no hay datos suficientes');
    }
    item.appendChild(pct);

    return item;
  }

  function tarjetaParticipante(nombre, m, r) {
    var cuerpo = [];

    cuerpo.push(el('div', { clase: 'grid grid--2' }, [
      stat(fmtPct(m.pctPerdido), 'Porcentaje perdido'),
      stat(fmtKg(m.kgPerdidos), 'Kilos perdidos'),
      stat(fmtKg(m.pesoActualSuavizado), 'Peso (promedio 7 días)'),
      stat(fmtKg(m.pesoBase), 'Peso de referencia')
    ]));

    if (numero(m.avanceMetaPct) !== null) {
      cuerpo.push(el('div', { clase: 'apilado' }, [
        el('p', { clase: 'stat__etiqueta' }, 'Avance de la meta'),
        barra(m.avanceMetaPct, 'Avance de la meta de ' + nombre),
        el('p', { clase: 'stat__pie' }, fmtPct(m.avanceMetaPct, 0) + ' de la meta' +
          (m.proyeccionMetaFecha ? ' · a este ritmo la alcanza el ' + fmtFecha(m.proyeccionMetaFecha) : ''))
      ]));
    } else {
      cuerpo.push(el('p', { clase: 'stat__pie' },
        'Sin meta de kilos: compite solo por porcentaje.'));
    }

    cuerpo.push(el('div', { clase: 'apilado' }, [
      el('p', { clase: 'stat__etiqueta' }, 'Constancia'),
      barra(m.adherenciaPct, 'Constancia de ' + nombre),
      el('p', { clase: 'stat__pie' },
        fmtPct(m.adherenciaPct, 0) + ' de los días registrados (' +
        (numero(m.diasRegistrados) === null ? SIN_DATO : m.diasRegistrados) + ' de ' +
        (numero(m.diasTranscurridos) === null ? SIN_DATO : m.diasTranscurridos) + ')')
    ]));

    cuerpo.push(el('div', { clase: 'grid grid--2' }, [
      stat(numero(m.racha) === null ? SIN_DATO : String(m.racha), 'Días seguidos',
        'Racha sin faltar'),
      stat(numero(m.tasaSemanalPct) === null ? SIN_DATO : fmtPct(m.tasaSemanalPct),
        'Ritmo semanal', 'Porcentaje del peso por semana')
    ]));

    cuerpo.push(semaforo(m.semaforoTasa, r.tasaSemanalSanaMin, r.tasaSemanalSanaMax));

    if (numero(m.cinturaActual) !== null) {
      cuerpo.push(el('p', { clase: 'stat__pie' },
        'Cintura: ' + fmtNum(m.cinturaActual, 1) + ' cm' +
        (numero(m.cinturaPerdidaCm) !== null
          ? ' (' + fmtNum(m.cinturaPerdidaCm, 1) + ' cm menos)' : '')));
    }

    var pie = [];
    if (m.ultimaFecha) pie.push(el('span', {}, 'Última pesada: ' + fmtFecha(m.ultimaFecha)));
    if (!m.datosSuficientes) pie.push(chip('Faltan datos', 'revisar'));

    return tarjeta(nombre, cuerpo, pie.length ? pie : null);
  }

  async function vistaTablero(gen) {
    cargandoEn(vista, 'Cargando el tablero…');

    var datos;
    try {
      datos = await Api.resumen();
    } catch (err) {
      if (!vigente(gen)) return;
      errorEn(vista, textoError(err), {
        texto: 'Reintentar',
        alPulsar: function () { if (Api.invalidar) Api.invalidar('resumen'); irA('tablero', true); }
      });
      return;
    }
    if (!vigente(gen)) return;

    var d = datos && typeof datos === 'object' ? datos : {};
    var r = d.reto && typeof d.reto === 'object' ? d.reto : reto();
    var participantes = Array.isArray(d.participantes) ? d.participantes : [];
    var ranking = Array.isArray(d.ranking) ? d.ranking : [];
    var series = Array.isArray(d.series) ? d.series : [];

    limpiar(vista);

    var conDatos = ranking.filter(function (f) { return f && f.datosSuficientes; });

    // Ranking -----------------------------------------------------------------
    if (!ranking.length) {
      vista.appendChild(tarjeta('Ranking', [
        el('div', { clase: 'vacio' }, el('p', {},
          'Todavía no hay participantes que compitan. Cuando quien administra dé de ' +
          'alta a alguien, aparecerá aquí.'))
      ]));
    } else {
      var lista = listaSinVinetas('ol', 'ranking');
      for (var i = 0; i < ranking.length; i++) {
        lista.appendChild(filaRanking(ranking[i]));
      }
      var pieRanking = [];
      if (!conDatos.length) {
        pieRanking.push(el('span', {}, 'Nadie tiene todavía suficientes pesadas para ' +
          'entrar al ranking: hacen falta al menos dos días registrados.'));
      }
      vista.appendChild(tarjeta('Ranking por porcentaje perdido',
        [lista], pieRanking.length ? pieRanking : null));
    }

    // Grafico de porcentaje ---------------------------------------------------
    var ventana = numero(r.ventanaMovilDias) || VENTANA_POR_DEFECTO;
    var minDatos = numero(r.minDatosPromedio) || MIN_DATOS_POR_DEFECTO;

    var basePorId = {};
    var nombrePorId = {};
    for (var j = 0; j < participantes.length; j++) {
      var item = participantes[j] || {};
      var p = item.participante || {};
      var m = item.metricas || {};
      if (!p.id) continue;
      nombrePorId[p.id] = p.nombre || 'Participante';
      basePorId[p.id] = numero(m.pesoBase);
    }

    var seriesPct = [];
    for (var k = 0; k < series.length; k++) {
      var s = series[k] || {};
      var puntos = puntosDeSerie(s);
      if (puntos.length < 2) continue;
      var id = s.participanteId || s.id || '';
      var base = basePorId[id];
      if (base === null || base === undefined) base = pesoBaseDe(puntos);
      if (base === null || !(base > 0)) continue;
      seriesPct.push({
        nombre: s.nombre || nombrePorId[id] || 'Participante',
        puntos: puntosPorcentaje(puntos, base, ventana, minDatos)
      });
    }

    var fig = figuraGrafico('Porcentaje perdido', 'Cada línea es una persona. Un ' +
      'valor más alto significa que perdió más porcentaje de su peso inicial.');
    var cajaGrafico = tarjeta('Cómo va la carrera', [fig.caja], [
      el('span', {}, TXT_METRICA)
    ]);
    vista.appendChild(cajaGrafico);
    if (typeof Graficos.lineas === 'function') {
      Graficos.lineas(fig.lienzo, seriesPct, {
        unidad: '%',
        decimales: 2,
        titulo: 'Porcentaje del peso inicial perdido por día',
        vacio: 'Todavía no hay pesadas suficientes para dibujar la carrera. Con dos ' +
          'días registrados ya aparece la primera línea.'
      });
    }

    // Tarjetas por participante ----------------------------------------------
    var hubo = false;
    for (var n = 0; n < participantes.length; n++) {
      var it = participantes[n] || {};
      var part = it.participante || {};
      var met = it.metricas;
      if (!part.id) continue;
      if (String(part.rol || '').toLowerCase() === 'observador') continue;
      if (!met || typeof met !== 'object') continue;
      hubo = true;
      vista.appendChild(tarjetaParticipante(part.nombre || 'Participante', met, r));
    }
    if (!hubo) {
      vista.appendChild(el('div', { clase: 'vacio' }, el('p', {},
        'Cuando haya pesadas registradas, aquí aparece el detalle de cada persona.')));
    }
  }

  // ---------------------------------------------------------------------------
  // Vista: #/historial
  // ---------------------------------------------------------------------------

  /**
   * Formulario de verificacion cruzada. El comentario es obligatorio cuando el
   * veredicto es "duda": una duda sin explicacion no le sirve de nada a la otra
   * persona ni a quien administra.
   */
  function abrirModalVerificar(reg, veredicto, alTerminar) {
    var gen = estado.generacion;
    var esOk = veredicto === 'ok';
    var caja = el('div', { clase: 'apilado' });

    caja.appendChild(el('p', {}, 'Registro de ' + (reg.participanteNombre || 'la otra persona') +
      ' del ' + fmtFecha(reg.fecha) + '.'));
    if (reg.poseTexto) {
      caja.appendChild(el('p', { clase: 'campo__ayuda' },
        'Pose que le tocaba: ' + reg.poseTexto));
    }

    var campo = crearCampo({
      id: 'campo-comentario',
      etiqueta: esOk ? 'Comentario' : 'Qué te generó dudas',
      tipo: 'textarea',
      obligatorio: !esOk,
      ayuda: esOk
        ? 'Opcional. Máximo ' + NOTA_MAX + ' caracteres.'
        : 'Explica qué no cuadra: la pose, la foto, el número. Máximo ' + NOTA_MAX + ' caracteres.',
      atributos: { maxlength: String(NOTA_MAX) }
    });
    caja.appendChild(campo.caja);

    var btnGuardar = boton(esOk ? 'Marcar como correcta' : 'Enviar la duda', {
      variante: esOk ? 'primario' : 'peligro',
      bloque: true
    });
    var btnCancelar = boton('Cancelar', { variante: 'fantasma', bloque: true, alPulsar: cerrarModal });

    btnGuardar.addEventListener('click', async function () {
      var comentario = campo.control.value.trim();
      campo.limpiar();
      if (!esOk && !comentario) {
        campo.marcar('Escribe qué te generó dudas.');
        try { campo.control.focus(); } catch (e) { /* sin foco */ }
        return;
      }
      if (comentario.length > NOTA_MAX) {
        campo.marcar('El comentario no puede pasar de ' + NOTA_MAX + ' caracteres.');
        return;
      }
      btnGuardar.disabled = true;
      btnCancelar.disabled = true;
      try {
        await Api.verificar({
          registroId: reg.id,
          veredicto: veredicto,
          comentario: comentario
        });
        if (!vigente(gen)) return;
        cerrarModal();
        avisoOk(esOk ? 'Registro marcado como correcto.' : 'Duda registrada.');
        if (typeof alTerminar === 'function') alTerminar();
      } catch (err) {
        if (!vigente(gen)) return;
        btnGuardar.disabled = false;
        btnCancelar.disabled = false;
        var codigo = codigoDe(err);
        if (codigo === 'DATOS_INVALIDOS' && err.campo === 'comentario') {
          campo.marcar(textoError(err));
        } else {
          avisoError(textoError(err));
        }
      }
    });

    caja.appendChild(el('div', { clase: 'apilado' }, [btnGuardar, btnCancelar]));
    abrirModal(esOk ? 'Confirmar el registro' : 'Marcar una duda', caja);
  }

  function itemFeed(reg, sesion, alRecargar) {
    var item = el('li', { clase: 'feed__item' });

    var cabecera = el('div', { clase: 'feed__cabecera' });
    cabecera.appendChild(el('strong', {}, reg.participanteNombre || 'Participante'));
    cabecera.appendChild(el('span', {}, fmtFecha(reg.fecha)));
    var hora = fmtHora(reg.creadoEn);
    if (hora && hora !== SIN_DATO) cabecera.appendChild(el('span', {}, hora));
    var chips = chipsDeRegistro(reg);
    for (var i = 0; i < chips.length; i++) cabecera.appendChild(chips[i]);
    item.appendChild(cabecera);

    var datos = el('div', { clase: 'grid grid--2' }, [
      stat(fmtKg(reg.pesoKg), 'Peso'),
      numero(reg.cinturaCm) === null
        ? null
        : stat(fmtNum(reg.cinturaCm, 1) + ' cm', 'Cintura')
    ]);
    item.appendChild(datos);

    if (reg.revisar && reg.motivoRevisar) {
      item.appendChild(el('p', { clase: 'campo__ayuda' }, reg.motivoRevisar));
    }
    if (reg.anulado) {
      item.appendChild(el('p', { clase: 'campo__ayuda' },
        'Registro anulado: no cuenta para las métricas.'));
    }
    if (reg.nota) item.appendChild(el('p', {}, reg.nota));

    // La pose asignada va al lado de las fotos: es lo que hay que comparar.
    var zona = el('div', { clase: 'grid grid--2' });
    var ladoPose = el('div', { clase: 'apilado' });
    ladoPose.appendChild(el('p', { clase: 'stat__etiqueta' }, 'Pose asignada ese día'));
    if (reg.poseCodigo) ladoPose.appendChild(el('span', { clase: 'pose__codigo' }, reg.poseCodigo));
    ladoPose.appendChild(el('p', {}, reg.poseTexto || 'Sin pose registrada.'));
    zona.appendChild(ladoPose);

    var ladoFotos = el('div', { clase: 'apilado' });
    var fotos = el('div', { clase: 'feed__fotos' });
    var hayFoto = false;
    if (reg.fotoEjercicioThumbId) {
      hayFoto = true;
      fotos.appendChild(miniaturaFoto({
        fotoId: reg.fotoEjercicioThumbId,
        fotoIdGrande: reg.fotoEjercicioId || reg.fotoEjercicioThumbId,
        alt: 'Foto de ' + (reg.participanteNombre || 'la persona') + ' del ' + reg.fecha +
          ' con la pose ' + (reg.poseTexto || reg.poseCodigo || ''),
        etiquetaBoton: 'Ver la foto de la pose en grande',
        tituloModal: (reg.participanteNombre || 'Registro') + ' · ' + fmtFechaCorta(reg.fecha)
      }));
    }
    if (reg.fotoBalanzaThumbId) {
      hayFoto = true;
      fotos.appendChild(miniaturaFoto({
        fotoId: reg.fotoBalanzaThumbId,
        fotoIdGrande: reg.fotoBalanzaId || reg.fotoBalanzaThumbId,
        alt: 'Foto de la balanza de ' + (reg.participanteNombre || 'la persona') +
          ' del ' + reg.fecha,
        etiquetaBoton: 'Ver la foto de la balanza en grande',
        tituloModal: 'Balanza · ' + fmtFechaCorta(reg.fecha)
      }));
    }
    if (hayFoto) {
      ladoFotos.appendChild(fotos);
      ladoFotos.appendChild(el('p', { clase: 'stat__pie' }, 'Toca una foto para verla en grande.'));
    } else {
      ladoFotos.appendChild(el('p', { clase: 'campo__ayuda' },
        'Este registro no tiene fotos que puedas ver.'));
    }
    zona.appendChild(ladoFotos);
    item.appendChild(zona);

    // Comentarios de las verificaciones ya hechas.
    var vs = Array.isArray(reg.verificaciones) ? reg.verificaciones : [];
    for (var v = 0; v < vs.length; v++) {
      if (!vs[v] || !vs[v].comentario) continue;
      item.appendChild(el('p', { clase: 'campo__ayuda' },
        (vs[v].verificadorNombre || 'Alguien') + ': ' + vs[v].comentario));
    }

    // Acciones de verificacion.
    var miId = sesion && sesion.usuario ? sesion.usuario.id : null;
    var esMio = !!miId && reg.participanteId === miId;
    var acciones = el('div', { clase: 'feed__acciones' });

    if (reg.anulado) {
      acciones.appendChild(el('p', { clase: 'campo__ayuda' },
        'Un registro anulado ya no se verifica.'));
    } else if (esMio) {
      acciones.appendChild(el('p', { clase: 'campo__ayuda' },
        'Este registro es tuyo, así que no lo puedes verificar: la revisión la hace ' +
        'la otra persona. Eso es justo lo que sostiene el reto.'));
    } else if (!puedeRegistrar()) {
      acciones.appendChild(el('p', { clase: 'campo__ayuda' },
        'Tu rol es de solo lectura: puedes mirar los registros, pero no verificarlos.'));
    } else {
      acciones.appendChild(boton('Está correcta', {
        variante: 'primario',
        alPulsar: function () { abrirModalVerificar(reg, 'ok', alRecargar); }
      }));
      acciones.appendChild(boton('Tengo dudas', {
        variante: 'fantasma',
        alPulsar: function () { abrirModalVerificar(reg, 'duda', alRecargar); }
      }));
    }
    item.appendChild(acciones);

    return item;
  }

  async function vistaHistorial(gen) {
    cargandoEn(vista, 'Cargando el historial…');

    var sesion = estado.sesion || {};
    var listaParticipantes = [];
    try {
      var pp = await Api.participantes();
      if (!vigente(gen)) return;
      listaParticipantes = (pp && Array.isArray(pp.participantes)) ? pp.participantes : [];
    } catch (err) {
      if (!vigente(gen)) return;
      // Sin la lista se puede seguir: solo se pierde el filtro.
      listaParticipantes = [];
    }

    limpiar(vista);

    var opciones = [{ valor: '', etiqueta: 'Todas las personas' }];
    for (var i = 0; i < listaParticipantes.length; i++) {
      var p = listaParticipantes[i] || {};
      if (!p.id) continue;
      opciones.push({ valor: p.id, etiqueta: p.nombre || 'Participante' });
    }

    var contenedorFeed = el('div', {});

    var filtro = crearCampo({
      id: 'campo-filtro',
      etiqueta: 'Ver los registros de',
      tipo: 'select',
      opciones: opciones,
      valor: estado.filtroHistorial || ''
    });
    filtro.control.addEventListener('change', function () {
      estado.filtroHistorial = filtro.control.value || '';
      cargarFeed();
    });

    vista.appendChild(tarjeta('Historial de todos', [
      el('p', { clase: 'campo__ayuda' },
        'Del más reciente al más antiguo. Compara la foto con la pose que le tocaba ' +
        'ese día y marca si está correcta o si tienes dudas.'),
      filtro.caja
    ]));
    vista.appendChild(contenedorFeed);

    function recargar() {
      if (Api.invalidar) Api.invalidar('todo');
      cargarFeed();
    }

    async function cargarFeed() {
      var genFeed = estado.generacion;
      cargandoEn(contenedorFeed, 'Cargando registros…');
      var datos;
      try {
        var f = { limite: LIMITE_FEED };
        if (estado.filtroHistorial) f.participanteId = estado.filtroHistorial;
        datos = await Api.historial(f);
      } catch (err) {
        if (!vigente(genFeed)) return;
        errorEn(contenedorFeed, textoError(err), {
          texto: 'Reintentar',
          alPulsar: function () { cargarFeed(); }
        });
        return;
      }
      if (!vigente(genFeed)) return;

      var registros = (datos && Array.isArray(datos.registros)) ? datos.registros : [];
      if (!registros.length) {
        vacioEn(contenedorFeed, estado.filtroHistorial
          ? 'Esa persona todavía no tiene registros.'
          : 'Todavía no hay ningún registro en el reto. El primero aparece en cuanto ' +
            'alguien se pese y suba su foto.', {
          texto: 'Actualizar',
          alPulsar: function () { recargar(); }
        });
        return;
      }

      limpiar(contenedorFeed);
      var lista = listaSinVinetas('ul', 'feed');
      for (var n = 0; n < registros.length; n++) {
        lista.appendChild(itemFeed(registros[n], sesion, recargar));
      }
      contenedorFeed.appendChild(lista);
      if (registros.length >= LIMITE_FEED) {
        contenedorFeed.appendChild(el('p', { clase: 'campo__ayuda centrado' },
          'Se muestran los ' + LIMITE_FEED + ' registros más recientes.'));
      }
    }

    await cargarFeed();
  }

  // ---------------------------------------------------------------------------
  // Vista: #/yo
  // ---------------------------------------------------------------------------

  function filaDato(etiqueta, valor) {
    return el('div', { clase: 'stat' }, [
      el('span', { clase: 'stat__etiqueta' }, etiqueta),
      el('span', {}, valor === null || valor === undefined || valor === '' ? SIN_DATO : String(valor))
    ]);
  }

  async function vistaYo(gen) {
    cargandoEn(vista, 'Cargando tus datos…');

    var sesion = estado.sesion || {};
    var yo = sesion.usuario && typeof sesion.usuario === 'object' ? sesion.usuario : {};

    var datos = null;
    var errorResumen = null;
    try {
      datos = await Api.resumen();
    } catch (err) {
      errorResumen = err;
    }
    if (!vigente(gen)) return;

    limpiar(vista);

    var r = (datos && datos.reto) ? datos.reto : reto();
    var ventana = numero(r.ventanaMovilDias) || VENTANA_POR_DEFECTO;
    var minDatos = numero(r.minDatosPromedio) || MIN_DATOS_POR_DEFECTO;

    var mias = null;
    var serie = [];
    if (datos) {
      var participantes = Array.isArray(datos.participantes) ? datos.participantes : [];
      for (var i = 0; i < participantes.length; i++) {
        var it = participantes[i] || {};
        var p = it.participante || {};
        if (p.id && yo.id && p.id === yo.id) {
          mias = it.metricas || null;
          break;
        }
      }
      var series = Array.isArray(datos.series) ? datos.series : [];
      for (var j = 0; j < series.length; j++) {
        var s = series[j] || {};
        if ((s.participanteId || s.id) === yo.id) {
          serie = puntosDeSerie(s);
          break;
        }
      }
    }

    // Mis datos ---------------------------------------------------------------
    var rejilla = el('div', { clase: 'grid grid--2' }, [
      filaDato('Nombre', yo.nombre),
      filaDato('Correo', yo.email),
      filaDato('Rol', yo.rol === 'admin' ? 'Administrador'
        : yo.rol === 'observador' ? 'Observador' : 'Participante'),
      filaDato('Peso inicial declarado', numero(yo.pesoInicialKg) === null ? null : fmtKg(yo.pesoInicialKg)),
      filaDato('Meta', numero(yo.metaKg) === null ? 'Sin meta de kilos' : fmtKg(yo.metaKg)),
      filaDato('Cintura inicial', numero(yo.cinturaInicialCm) === null
        ? null : fmtNum(yo.cinturaInicialCm, 1) + ' cm'),
      filaDato('Altura', numero(yo.alturaCm) === null ? null : fmtNum(yo.alturaCm, 0) + ' cm'),
      filaDato('En el reto desde', yo.fechaAlta ? fmtFecha(yo.fechaAlta) : null)
    ]);
    vista.appendChild(tarjeta('Mis datos', [rejilla], [
      el('span', {}, 'Si algo está mal, pídele a quien administra que lo corrija: ' +
        'estos datos no se editan desde aquí.')
    ]));

    if (errorResumen) {
      var cajaErr = el('div', {});
      vista.appendChild(cajaErr);
      errorEn(cajaErr, textoError(errorResumen), {
        texto: 'Reintentar',
        alPulsar: function () { if (Api.invalidar) Api.invalidar('resumen'); irA('yo', true); }
      });
    }

    // Mi curva ----------------------------------------------------------------
    if (esObservador()) {
      vista.appendChild(tarjeta('Tu rol es de observador', [
        el('p', {}, 'Puedes ver el tablero y el historial de los demás, pero no ' +
          'registras pesadas ni entras al ranking, así que aquí no hay curva propia.')
      ], [
        enlaceBoton('Ver el tablero', '#/tablero', { variante: 'primario' }),
        enlaceBoton('Ver el historial', '#/historial', { variante: 'fantasma' })
      ]));
    } else if (mias || serie.length) {
      var fig = figuraGrafico('Mi peso', 'La línea gruesa es tu peso de cada día; la ' +
        'otra es el promedio de los últimos ' + ventana + ' días, que es el número ' +
        'que se usa para competir.');
      vista.appendChild(tarjeta('Mi curva de peso', [fig.caja]));
      if (typeof Graficos.lineas === 'function') {
        Graficos.lineas(fig.lienzo, [
          { nombre: 'Peso del día', puntos: puntosPeso(serie) },
          { nombre: 'Promedio de ' + ventana + ' días', puntos: puntosSuavizado(serie, ventana, minDatos) }
        ], {
          unidad: 'kg',
          decimales: 1,
          titulo: 'Mi peso día a día',
          leyenda: true,
          vacio: 'Todavía no tienes pesadas suficientes para dibujar la curva.'
        });
      }
    }

    // Mis numeros -------------------------------------------------------------
    if (esObservador()) {
      // Un observador no tiene metricas propias: no se le pinta un hueco vacio.
      mias = null;
    } else if (mias) {
      var cuerpo = [
        el('div', { clase: 'grid grid--2' }, [
          stat(fmtPct(mias.pctPerdido), 'Porcentaje perdido'),
          stat(fmtKg(mias.kgPerdidos), 'Kilos perdidos'),
          stat(fmtKg(mias.pesoActualSuavizado), 'Promedio de ' + ventana + ' días'),
          stat(fmtKg(mias.pesoBase), 'Peso de referencia')
        ]),
        el('div', { clase: 'apilado' }, [
          el('p', { clase: 'stat__etiqueta' }, 'Mi constancia'),
          barra(mias.adherenciaPct, 'Mi constancia'),
          el('p', { clase: 'stat__pie' }, fmtPct(mias.adherenciaPct, 0) + ' de los días. ' +
            'Racha actual: ' + (numero(mias.racha) === null ? SIN_DATO : mias.racha) + ' días seguidos.')
        ]),
        semaforo(mias.semaforoTasa, r.tasaSemanalSanaMin, r.tasaSemanalSanaMax)
      ];
      if (numero(mias.avanceMetaPct) !== null) {
        cuerpo.push(el('div', { clase: 'apilado' }, [
          el('p', { clase: 'stat__etiqueta' }, 'Avance de mi meta'),
          barra(mias.avanceMetaPct, 'Avance de mi meta'),
          el('p', { clase: 'stat__pie' }, mias.proyeccionMetaFecha
            ? 'A este ritmo la alcanzas el ' + fmtFecha(mias.proyeccionMetaFecha) + '.'
            : 'Todavía no se puede proyectar la fecha.')
        ]));
      }
      vista.appendChild(tarjeta('Mis números', cuerpo, [el('span', {}, TXT_METRICA)]));
    } else if (!errorResumen) {
      vista.appendChild(el('div', { clase: 'vacio' }, el('p', {},
        'Todavía no tienes pesadas registradas. En cuanto registres el primer día, ' +
        'aquí aparecen tus números.')));
    }

    // Protocolo ---------------------------------------------------------------
    if (!esObservador()) {
      var pasos = el('ol', {});
      PROTOCOLO.forEach(function (p) { pasos.appendChild(el('li', {}, p.etiqueta)); });
      vista.appendChild(tarjeta('Mi protocolo de pesada', [
        el('p', {}, 'Los cuatro puntos que confirmas cada día al registrar:'),
        pasos,
        el('p', { clase: 'campo__ayuda' }, 'Si un día no puedes cumplir alguno, ' +
          'regístralo igual y anótalo en la nota: es mejor un dato marcado que un hueco.')
      ], [enlaceBoton('Registrar hoy', '#/hoy', { variante: 'primario' })]));
    }
  }

  // ---------------------------------------------------------------------------
  // Vista: #/admin
  // ---------------------------------------------------------------------------

  function controlDeConfig(entrada, valorActual) {
    if (entrada.tipo === 'bool') {
      return crearCampo({
        id: 'campo-config-valor',
        etiqueta: 'Valor nuevo',
        tipo: 'select',
        opciones: [
          { valor: 'true', etiqueta: 'Sí' },
          { valor: 'false', etiqueta: 'No' }
        ],
        valor: valorActual === false ? 'false' : (valorActual === true ? 'true' : 'true'),
        ayuda: 'Valor actual: ' + (valorActual === true ? 'Sí' : valorActual === false ? 'No' : SIN_DATO)
      });
    }
    if (entrada.tipo === 'fecha') {
      return crearCampo({
        id: 'campo-config-valor',
        etiqueta: 'Valor nuevo',
        tipo: 'date',
        obligatorio: true,
        valor: typeof valorActual === 'string' ? valorActual : '',
        ayuda: 'Formato aaaa-mm-dd. Valor actual: ' +
          (valorActual ? String(valorActual) : SIN_DATO)
      });
    }
    if (entrada.tipo === 'entero' || entrada.tipo === 'numero') {
      return crearCampo({
        id: 'campo-config-valor',
        etiqueta: 'Valor nuevo',
        tipo: 'number',
        obligatorio: true,
        valor: numero(valorActual) === null ? '' : valorActual,
        atributos: {
          inputmode: 'decimal',
          step: entrada.tipo === 'entero' ? '1' : '0.1'
        },
        ayuda: 'Valor actual: ' + (numero(valorActual) === null ? SIN_DATO : fmtNum(valorActual, 2))
      });
    }
    return crearCampo({
      id: 'campo-config-valor',
      etiqueta: 'Valor nuevo',
      tipo: 'text',
      obligatorio: true,
      valor: typeof valorActual === 'string' ? valorActual : '',
      ayuda: 'Valor actual: ' + (valorActual ? String(valorActual) : SIN_DATO)
    });
  }

  function tarjetaAltaParticipante(gen, alTerminar) {
    var campos = {};
    var cuerpo = [];

    campos.email = crearCampo({
      id: 'campo-p-email',
      etiqueta: 'Correo de Google',
      tipo: 'email',
      obligatorio: true,
      ayuda: 'Es la llave del participante: tiene que ser exactamente el correo con ' +
        'el que entra a Google. Si ya existe, se actualizan sus datos.',
      atributos: { autocomplete: 'off', inputmode: 'email', spellcheck: 'false' }
    });
    cuerpo.push(campos.email.caja);

    campos.nombre = crearCampo({
      id: 'campo-p-nombre',
      etiqueta: 'Nombre para mostrar',
      tipo: 'text',
      obligatorio: true,
      atributos: { autocomplete: 'off' }
    });
    cuerpo.push(campos.nombre.caja);

    campos.rol = crearCampo({
      id: 'campo-p-rol',
      etiqueta: 'Rol',
      tipo: 'select',
      opciones: ROLES,
      valor: 'participante',
      ayuda: 'Los observadores no compiten ni registran: solo miran.'
    });
    cuerpo.push(campos.rol.caja);

    campos.peso = crearCampo({
      id: 'campo-p-peso',
      etiqueta: 'Peso inicial en kilos',
      tipo: 'number',
      ayuda: 'Obligatorio salvo para observadores. Sirve de respaldo hasta que haya ' +
        'tres pesadas registradas.',
      atributos: { inputmode: 'decimal', step: '0.1' }
    });
    cuerpo.push(campos.peso.caja);

    campos.meta = crearCampo({
      id: 'campo-p-meta',
      etiqueta: 'Meta en kilos',
      tipo: 'number',
      ayuda: 'Opcional: sin meta, compite solo por porcentaje.',
      atributos: { inputmode: 'decimal', step: '0.1' }
    });
    cuerpo.push(campos.meta.caja);

    campos.cintura = crearCampo({
      id: 'campo-p-cintura',
      etiqueta: 'Cintura inicial en centímetros',
      tipo: 'number',
      ayuda: 'Opcional.',
      atributos: { inputmode: 'decimal', step: '0.5' }
    });
    cuerpo.push(campos.cintura.caja);

    campos.altura = crearCampo({
      id: 'campo-p-altura',
      etiqueta: 'Altura en centímetros',
      tipo: 'number',
      ayuda: 'Opcional.',
      atributos: { inputmode: 'numeric', step: '1' }
    });
    cuerpo.push(campos.altura.caja);

    var check = crearCheck('campo-p-activo', 'Activo en el reto (puede entrar)', true);
    cuerpo.push(el('div', { clase: 'grupo-check' }, check.caja));

    var btn = boton('Guardar participante', { variante: 'primario', bloque: true });

    btn.addEventListener('click', async function () {
      Object.keys(campos).forEach(function (k) { campos[k].limpiar(); });

      var email = campos.email.control.value.trim().toLowerCase();
      var nombre = campos.nombre.control.value.trim();
      var rolElegido = campos.rol.control.value;
      var peso = numero(campos.peso.control.value);

      if (!email || email.indexOf('@') < 1 || email.indexOf('.') < 0) {
        campos.email.marcar('Escribe un correo válido.');
        try { campos.email.control.focus(); } catch (e) { /* sin foco */ }
        return;
      }
      if (!nombre) {
        campos.nombre.marcar('Escribe el nombre que se va a mostrar.');
        try { campos.nombre.control.focus(); } catch (e) { /* sin foco */ }
        return;
      }
      if (rolElegido !== 'observador' && peso === null) {
        campos.peso.marcar('El peso inicial es obligatorio para quien compite.');
        try { campos.peso.control.focus(); } catch (e) { /* sin foco */ }
        return;
      }

      var activo = !!check.control.checked;
      var pregunta = activo
        ? '¿Guardar a ' + nombre + ' como ' + rolElegido + ' con el correo ' + email + '?'
        : '¿Guardar a ' + nombre + ' como INACTIVO? No va a poder entrar al reto.';

      var si = await confirmar(pregunta, {
        titulo: 'Confirmar el participante',
        textoSi: 'Guardar',
        textoNo: 'Cancelar',
        peligro: !activo
      });
      if (!si || !vigente(gen)) return;

      btn.disabled = true;
      try {
        var envio = {
          email: email,
          nombre: nombre,
          rol: rolElegido,
          activo: activo
        };
        if (peso !== null) envio.pesoInicialKg = peso;
        var meta = numero(campos.meta.control.value);
        if (meta !== null) envio.metaKg = meta;
        var cintura = numero(campos.cintura.control.value);
        if (cintura !== null) envio.cinturaInicialCm = cintura;
        var altura = numero(campos.altura.control.value);
        if (altura !== null) envio.alturaCm = altura;

        var res = await Api.guardarParticipante(envio);
        if (!vigente(gen)) return;
        recordarCorreo(res && res.participante);
        avisoOk('Participante guardado.');
        if (typeof alTerminar === 'function') alTerminar();
      } catch (err) {
        if (!vigente(gen)) return;
        btn.disabled = false;
        var campoMalo = err && err.campo;
        var mapa = {
          email: campos.email,
          nombre: campos.nombre,
          rol: campos.rol,
          pesoInicialKg: campos.peso,
          metaKg: campos.meta,
          cinturaInicialCm: campos.cintura,
          alturaCm: campos.altura
        };
        if (campoMalo && mapa[campoMalo]) mapa[campoMalo].marcar(textoError(err));
        avisoError(textoError(err));
      }
    });

    cuerpo.push(btn);

    return {
      caja: tarjeta('Agregar o actualizar un participante', cuerpo, [
        el('span', {}, 'El correo manda: si ya está en el reto, se actualizan sus datos.')
      ]),
      rellenar: function (p) {
        campos.nombre.control.value = p.nombre || '';
        campos.rol.control.value = p.rol || 'participante';
        var correo = p.email || estado.correosPorId[p.id] || '';
        campos.email.control.value = correo;
        if (!correo) {
          campos.email.marcar('El servidor no entrega los correos: escríbelo tal como ' +
            'lo tiene esta persona en Google.');
        }
        try { campos.email.control.focus(); } catch (e) { /* sin foco */ }
      }
    };
  }

  function tarjetaConfig(gen) {
    var cfgActual = configReto();
    var cuerpo = [];
    var contenedorValor = el('div', {});
    var actual = { campo: null, entrada: CLAVES_CONFIG[0] };

    var campoClave = crearCampo({
      id: 'campo-config-clave',
      etiqueta: 'Qué quieres cambiar',
      tipo: 'select',
      opciones: CLAVES_CONFIG.map(function (c) {
        return { valor: c.clave, etiqueta: c.etiqueta };
      })
    });

    function pintarValor() {
      var clave = campoClave.control.value;
      var entrada = null;
      for (var i = 0; i < CLAVES_CONFIG.length; i++) {
        if (CLAVES_CONFIG[i].clave === clave) { entrada = CLAVES_CONFIG[i]; break; }
      }
      if (!entrada) entrada = CLAVES_CONFIG[0];
      actual.entrada = entrada;
      limpiar(contenedorValor);
      actual.campo = controlDeConfig(entrada, cfgActual[entrada.clave]);
      contenedorValor.appendChild(actual.campo.caja);
    }

    campoClave.control.addEventListener('change', pintarValor);
    cuerpo.push(campoClave.caja);
    cuerpo.push(contenedorValor);
    pintarValor();

    var btn = boton('Guardar el cambio', { variante: 'peligro', bloque: true });
    btn.addEventListener('click', async function () {
      if (!actual.campo) return;
      actual.campo.limpiar();
      var bruto = actual.campo.control.value;

      var valor = bruto;
      if (actual.entrada.tipo === 'bool') {
        valor = bruto === 'true';
      } else if (actual.entrada.tipo === 'entero' || actual.entrada.tipo === 'numero') {
        var n = numero(bruto);
        if (n === null) {
          actual.campo.marcar('Escribe un número.');
          return;
        }
        valor = actual.entrada.tipo === 'entero' ? Math.round(n) : n;
      } else {
        valor = String(bruto).trim();
        if (!valor) {
          actual.campo.marcar('Este valor no puede quedar vacío.');
          return;
        }
      }

      var si = await confirmar('Vas a cambiar «' + actual.entrada.etiqueta +
        '» para todo el reto. Esto afecta a todos los participantes y a las métricas ' +
        'ya calculadas. ¿Continuar?', {
        titulo: 'Cambiar la configuración',
        textoSi: 'Cambiar',
        textoNo: 'Cancelar',
        peligro: true
      });
      if (!si || !vigente(gen)) return;

      btn.disabled = true;
      try {
        await Api.configurar({ clave: actual.entrada.clave, valor: valor });
        if (!vigente(gen)) return;
        avisoOk('Configuración actualizada.');
        estado.sesion = null;
        if (Api.invalidar) Api.invalidar('todo');
        irA('admin', true);
      } catch (err) {
        if (!vigente(gen)) return;
        btn.disabled = false;
        actual.campo.marcar(textoError(err));
        avisoError(textoError(err));
      }
    });
    cuerpo.push(btn);

    return tarjeta('Configuración del reto', cuerpo, [
      el('span', {}, 'Solo las claves de esta lista se pueden cambiar desde aquí. ' +
        'El resto vive en el backend a propósito.')
    ]);
  }

  async function abrirModalAnular(reg, alTerminar) {
    var gen = estado.generacion;
    var caja = el('div', { clase: 'apilado' });
    caja.appendChild(el('p', {}, 'Vas a anular el registro de ' +
      (reg.participanteNombre || 'esta persona') + ' del ' + fmtFecha(reg.fecha) +
      ' (' + fmtKg(reg.pesoKg) + ').'));
    caja.appendChild(el('p', { clase: 'campo__ayuda' },
      'El registro no se borra: queda marcado como anulado y deja de contar para las ' +
      'métricas. La foto y la auditoría se conservan.'));

    var campo = crearCampo({
      id: 'campo-motivo-anular',
      etiqueta: 'Motivo de la anulación',
      tipo: 'textarea',
      obligatorio: true,
      ayuda: 'Queda registrado en la auditoría. Máximo ' + NOTA_MAX + ' caracteres.',
      atributos: { maxlength: String(NOTA_MAX) }
    });
    caja.appendChild(campo.caja);

    var btn = boton('Anular el registro', { variante: 'peligro', bloque: true });
    var btnNo = boton('Cancelar', { variante: 'fantasma', bloque: true, alPulsar: cerrarModal });

    btn.addEventListener('click', async function () {
      campo.limpiar();
      var motivo = campo.control.value.trim();
      if (!motivo) {
        campo.marcar('El motivo es obligatorio.');
        try { campo.control.focus(); } catch (e) { /* sin foco */ }
        return;
      }
      if (motivo.length > NOTA_MAX) {
        campo.marcar('El motivo no puede pasar de ' + NOTA_MAX + ' caracteres.');
        return;
      }

      var si = await confirmar('¿Anular definitivamente ese registro? Deja de contar ' +
        'para el ranking.', {
        titulo: 'Anular registro',
        textoSi: 'Anular',
        textoNo: 'Cancelar',
        peligro: true
      });
      if (!si || !vigente(gen)) return;

      try {
        await Api.anularRegistro({ registroId: reg.id, motivo: motivo });
        if (!vigente(gen)) return;
        avisoOk('Registro anulado.');
        if (Api.invalidar) Api.invalidar('todo');
        if (typeof alTerminar === 'function') alTerminar();
      } catch (err) {
        if (!vigente(gen)) return;
        avisoError(textoError(err));
      }
    });

    caja.appendChild(el('div', { clase: 'apilado' }, [btn, btnNo]));
    abrirModal('Anular un registro', caja);
  }

  async function vistaAdmin(gen) {
    cargandoEn(vista, 'Cargando la gestión del reto…');

    var listaParticipantes = [];
    var registros = [];
    var fallo = null;
    try {
      var pp = await Api.participantes();
      if (!vigente(gen)) return;
      listaParticipantes = (pp && Array.isArray(pp.participantes)) ? pp.participantes : [];
      var hh = await Api.historial({ limite: LIMITE_FEED_ADMIN });
      if (!vigente(gen)) return;
      registros = (hh && Array.isArray(hh.registros)) ? hh.registros : [];
    } catch (err) {
      fallo = err;
    }
    if (!vigente(gen)) return;

    limpiar(vista);

    if (fallo) {
      var cajaErr = el('div', {});
      vista.appendChild(cajaErr);
      errorEn(cajaErr, textoError(fallo), {
        texto: 'Reintentar',
        alPulsar: function () { if (Api.invalidar) Api.invalidar('todo'); irA('admin', true); }
      });
    }

    function recargar() {
      estado.sesion = null;
      if (Api.invalidar) Api.invalidar('todo');
      irA('admin', true);
    }

    var alta = tarjetaAltaParticipante(gen, recargar);

    // Lista de participantes -------------------------------------------------
    var cuerpoLista = [];
    if (!listaParticipantes.length) {
      cuerpoLista.push(el('div', { clase: 'vacio' }, el('p', {},
        'Todavía no hay nadie en el reto. Usa el formulario de abajo para dar de alta ' +
        'a la primera persona.')));
    } else {
      var lista = listaSinVinetas('ul', 'ranking');
      for (var i = 0; i < listaParticipantes.length; i++) {
        var p = listaParticipantes[i] || {};
        if (!p.id) continue;
        var fila = el('li', { clase: 'ranking__fila' });
        fila.appendChild(el('span', { clase: 'ranking__puesto' },
          chip(p.rol === 'admin' ? 'Admin' : p.rol === 'observador' ? 'Mira' : 'Compite',
            p.rol === 'observador' ? 'anulado' : 'oficial')));
        fila.appendChild(el('span', { clase: 'ranking__nombre' }, p.nombre || 'Participante'));
        fila.appendChild(boton('Editar', {
          variante: 'fantasma',
          etiquetaAria: 'Editar a ' + (p.nombre || 'este participante'),
          alPulsar: (function (persona) {
            return function () {
              alta.rellenar(persona);
              try { alta.caja.scrollIntoView({ block: 'start' }); } catch (e) { /* sin scroll */ }
            };
          }(p))
        }));
        lista.appendChild(fila);
      }
      cuerpoLista.push(lista);
    }
    vista.appendChild(tarjeta('Participantes del reto', cuerpoLista, [
      el('span', {}, 'El servidor no entrega los correos en esta lista, así que al ' +
        'editar hay que escribirlo de nuevo.')
    ]));

    vista.appendChild(alta.caja);
    vista.appendChild(tarjetaConfig(gen));

    // Anulacion de registros -------------------------------------------------
    var cuerpoRegistros = [];
    if (!registros.length) {
      cuerpoRegistros.push(el('div', { clase: 'vacio' }, el('p', {},
        'Todavía no hay registros que anular.')));
    } else {
      var listaReg = listaSinVinetas('ul', 'feed');
      for (var j = 0; j < registros.length; j++) {
        var reg = registros[j] || {};
        if (!reg.id) continue;
        var item = el('li', { clase: 'feed__item' });
        var cab = el('div', { clase: 'feed__cabecera' });
        cab.appendChild(el('strong', {}, reg.participanteNombre || 'Participante'));
        cab.appendChild(el('span', {}, fmtFecha(reg.fecha)));
        cab.appendChild(el('span', {}, fmtKg(reg.pesoKg)));
        var chips = chipsDeRegistro(reg);
        for (var c = 0; c < chips.length; c++) cab.appendChild(chips[c]);
        item.appendChild(cab);

        var acciones = el('div', { clase: 'feed__acciones' });
        if (reg.anulado) {
          acciones.appendChild(el('p', { clase: 'campo__ayuda' },
            'Ya está anulado.' + (reg.motivoAnulado ? ' Motivo: ' + reg.motivoAnulado : '')));
        } else {
          acciones.appendChild(boton('Anular', {
            variante: 'peligro',
            etiquetaAria: 'Anular el registro de ' + (reg.participanteNombre || '') +
              ' del ' + reg.fecha,
            alPulsar: (function (registro) {
              return function () { abrirModalAnular(registro, recargar); };
            }(reg))
          }));
        }
        item.appendChild(acciones);
        listaReg.appendChild(item);
      }
      cuerpoRegistros.push(listaReg);
    }
    vista.appendChild(tarjeta('Anular registros', cuerpoRegistros, [
      el('span', {}, 'Anular no borra nada: el registro deja de contar para las ' +
        'métricas y el motivo queda en la auditoría.')
    ]));
  }

  // ---------------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------------

  var VISTAS = {
    hoy: { render: vistaHoy, nav: 'hoy' },
    tablero: { render: vistaTablero, nav: 'tablero' },
    historial: { render: vistaHistorial, nav: 'historial' },
    yo: { render: vistaYo, nav: 'yo' },
    admin: { render: vistaAdmin, nav: 'admin', soloAdmin: true }
  };

  function rutaDeHash() {
    var h = '';
    try {
      h = String(window.location.hash || '');
    } catch (e) {
      h = '';
    }
    if (h.charAt(0) === '#') h = h.slice(1);
    if (h.charAt(0) === '/') h = h.slice(1);
    h = h.split('/')[0].split('?')[0].trim().toLowerCase();
    return h;
  }

  function rutaPorDefecto() {
    return esObservador() ? 'tablero' : 'hoy';
  }

  function irA(ruta, forzar) {
    var destino = '#/' + ruta;
    var actual = '';
    try {
      actual = String(window.location.hash || '');
    } catch (e) {
      actual = '';
    }
    if (actual === destino) {
      if (forzar) enrutar();
      return;
    }
    try {
      window.location.hash = destino;
    } catch (e) {
      enrutar();
    }
  }

  /**
   * Todo lo que hay que soltar al abandonar una vista. La camara es lo critico:
   * si no se cierra, la luz se queda encendida y la persona ve que la app la
   * sigue mirando.
   */
  function limpiezaDeVista() {
    if (typeof Camara.cerrar === 'function') {
      try { Camara.cerrar(); } catch (e) { /* idempotente, nada que hacer */ }
    }
    pasoConCamara = null;
    soltarObservadores();
    cerrarModal();
  }

  async function enrutar() {
    if (!vista) return;
    var gen = ++estado.generacion;
    limpiezaDeVista();

    var ruta = rutaDeHash();

    // «Cómo funciona» es texto fijo y no toca la red: se puede leer siempre,
    // incluso sin configurar y sin sesion. El enlace del pie esta en todas las
    // pantallas, asi que no puede llevar a un callejon sin salida.
    if (ruta === 'ayuda') {
      mostrarNav(!!estado.sesion && !estado.noInscrito);
      vistaAyuda();
      return;
    }

    // Sin configurar y sin demo no se intenta ni una llamada: fallarian todas.
    var configurado = true;
    if (typeof CFG.configurado === 'function') {
      try { configurado = !!CFG.configurado(); } catch (e) { configurado = false; }
    }
    if (!configurado) {
      pantallaConfigPendiente();
      return;
    }

    if (!estado.authListo) {
      mostrarNav(false);
      marcarNav('');
      cargandoEn(vista, 'Comprobando tu sesión…');
      return;
    }

    if (!estado.autenticado) {
      vistaEntrar();
      return;
    }

    if (estado.noInscrito) {
      pantallaNoInscrito();
      return;
    }

    if (!estado.sesion) {
      mostrarNav(false);
      marcarNav('');
      cargandoEn(vista, 'Comprobando tu acceso al reto…');
      try {
        await asegurarSesion();
      } catch (err) {
        if (!vigente(gen)) return;
        if (estado.noInscrito) {
          pantallaNoInscrito();
          return;
        }
        if (codigoDe(err) === 'NO_AUTENTICADO') {
          vistaEntrar();
          return;
        }
        mostrarNav(false);
        errorEn(vista, textoError(err), {
          texto: 'Reintentar',
          alPulsar: function () { enrutar(); }
        });
        return;
      }
      if (!vigente(gen)) return;
    }

    mostrarNav(true);

    if (!ruta || ruta === 'entrar') {
      irA(rutaPorDefecto(), true);
      return;
    }

    var entrada = Object.prototype.hasOwnProperty.call(VISTAS, ruta) ? VISTAS[ruta] : null;
    if (!entrada) {
      irA(rutaPorDefecto(), true);
      return;
    }

    marcarNav(entrada.nav);
    ajustarNavPorRol();

    if (entrada.soloAdmin && !esAdmin()) {
      pantallaSinPermiso('La gestión del reto es solo para quien administra: ' +
        'dar de alta participantes, cambiar la configuración y anular registros.', 'tablero');
      return;
    }

    try {
      await entrada.render(gen);
    } catch (err) {
      if (!vigente(gen)) return;
      errorEn(vista, textoError(err), {
        texto: 'Reintentar',
        alPulsar: function () { enrutar(); }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------------

  function alCambiarAuth(est) {
    var e = est && typeof est === 'object' ? est : {};
    var primero = !estado.authListo;
    var antes = estado.autenticado;
    var correoAntes = estado.correo;

    estado.authListo = true;
    estado.autenticado = !!e.autenticado;
    estado.correo = e.email || null;
    estado.perfil = e;

    if (!estado.autenticado) {
      estado.sesion = null;
      estado.noInscrito = false;
      estado.promesaSesion = null;
      if (Api.invalidar) Api.invalidar('todo');
      pintarCabecera();
      if (rutaDeHash() === 'ayuda') {
        // «Cómo funciona» se lee sin sesion: no se le quita la pantalla a nadie.
        enrutar();
        return;
      }
      if (primero || antes) {
        // Al caducar o salir se vuelve al acceso: no hay nada que mirar dentro.
        irA('entrar', true);
      }
      return;
    }

    var cambioDeCuenta = !antes || correoAntes !== estado.correo;
    if (cambioDeCuenta) {
      estado.sesion = null;
      estado.noInscrito = false;
      estado.promesaSesion = null;
      estado.filtroHistorial = '';
      if (Api.invalidar) Api.invalidar('todo');
    }
    pintarCabecera();

    if (primero || cambioDeCuenta) {
      var ruta = rutaDeHash();
      if (!ruta || ruta === 'entrar') irA('hoy', true);
      else enrutar();
    }
  }

  function conectarEventos() {
    window.addEventListener('hashchange', function () { enrutar(); });

    if (btnSalir) {
      btnSalir.addEventListener('click', function () {
        confirmar('¿Cerrar tu sesión en este dispositivo?', {
          titulo: 'Salir del reto',
          textoSi: 'Salir',
          textoNo: 'Quedarme'
        }).then(function (si) {
          if (!si) return;
          if (Auth.salir) Auth.salir();
        });
      });
    }

    // La X y el fondo del #modal del index.html llevan data-cerrar="modal".
    document.addEventListener('click', function (ev) {
      var nodo = ev.target;
      while (nodo && nodo !== document.body) {
        if (nodo.getAttribute && nodo.getAttribute('data-cerrar') === 'modal') {
          if (modal.abierto) {
            ev.preventDefault();
            cerrarModal();
          }
          return;
        }
        nodo = nodo.parentNode;
      }
    });

    window.addEventListener('offline', function () {
      avisoError('Te quedaste sin conexión. Lo que registres ahora no se va a guardar.');
    });
    window.addEventListener('online', function () {
      avisoOk('Volvió la conexión.');
    });
  }

  function arrancar() {
    if (estado.arrancado) return;
    estado.arrancado = true;

    vista = qs('#vista');
    cabTitulo = qs('#cab-titulo');
    cabUsuario = qs('#cab-usuario');
    btnSalir = qs('#btn-salir');
    nav = qs('#nav');

    ocultarPantallaCarga();
    pintarPie();
    pintarCabecera();
    mostrarNav(false);
    conectarEventos();

    if (vista) cargandoEn(vista, 'Comprobando tu sesión…');

    if (typeof Auth.iniciar === 'function') Auth.iniciar(alCambiarAuth);
    else alCambiarAuth({ autenticado: false });

    // Red de seguridad: si el acceso de Google no responde, igual se pinta algo.
    setTimeout(function () {
      if (estado.authListo) return;
      estado.authListo = true;
      enrutar();
    }, 8000);
  }

  window.App = {
    arrancar: arrancar,
    enrutar: enrutar,
    irA: irA,
    refrescar: function () {
      estado.sesion = null;
      if (Api.invalidar) Api.invalidar('todo');
      enrutar();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arrancar);
  } else {
    arrancar();
  }
}());
