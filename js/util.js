/**
 * util.js — formato, construccion de DOM sin innerHTML, avisos, modal de
 * confirmacion y los estados estandar de cualquier vista (cargando, vacio,
 * error).
 *
 * Script clasico (sin modulos): expone window.U. Se carga despues de config.js
 * y antes que el resto, porque todos los demas archivos usan U.
 *
 * Dos reglas que este archivo hace cumplir por diseno:
 *  - Nada de innerHTML con datos: todo nodo se crea con document.createElement
 *    y todo texto entra por textContent. La funcion el() es la pieza central.
 *  - Nada de tokens ni datos sensibles en consola: aqui no hay ni un console.*.
 */
(function () {
  'use strict';

  var SIN_DATO = '—'; // raya, para cuando no hay dato
  var MS_DIA = 86400000;
  var MS_AVISO = 6000;
  var MAX_AVISOS = 4;

  var RE_SOLO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
  var RE_FECHA_HORA = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/;
  var RE_ZONA = /(?:Z|[+-]\d{2}:?\d{2})$/;
  var RE_HORA_SUELTA = /(?:^|[T\s])(\d{1,2}):(\d{2})/;

  // Respaldo por si Intl no esta o cae a ingles. Indice 0 = domingo, igual que
  // Date#getDay, y meses en el orden natural.
  var DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  var MESES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
  ];

  var MENSAJE_GENERICO = 'Algo salió mal. Vuelve a intentarlo.';

  // Propiedades que nunca se asignan desde el() : son las vias de inyectar HTML.
  var PROHIBIDAS = {
    innerHTML: true,
    outerHTML: true,
    srcdoc: true,
    insertAdjacentHTML: true
  };

  // ---------------------------------------------------------------- numeros --

  function pad2(n) {
    var s = String(Math.abs(Math.trunc(Number(n) || 0)));
    return s.length >= 2 ? s : '0' + s;
  }

  /** Number(valor) tolerante: devuelve null en vez de NaN. */
  function numero(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    if (typeof valor === 'boolean') return null;
    var n = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  function agruparMiles(entera) {
    var salida = '';
    var cuenta = 0;
    for (var i = entera.length - 1; i >= 0; i--) {
      salida = entera.charAt(i) + salida;
      cuenta++;
      if (cuenta % 3 === 0 && i > 0) salida = '.' + salida;
    }
    return salida;
  }

  /**
   * Redondeo al alza en el medio (77,35 -> 77,4), que es lo que la gente espera
   * al ver un peso. toFixed por si solo no sirve: 77.35 en binario es
   * 77.34999... y devolveria 77,3. Escalar y pasar por toPrecision(15) borra ese
   * ruido antes de redondear. El signo se aplica al final porque
   * Math.round(-0.5) da -0.
   */
  function redondear(v, d) {
    var factor = Math.pow(10, d);
    var escalado = Math.abs(v) * factor;
    var limpio = Number(escalado.toPrecision(15));
    var entero = Math.round(limpio);
    return (v < 0 ? -entero : entero) / factor;
  }

  /**
   * Numero con coma decimal y punto de miles. No se usa Intl para numeros a
   * proposito: es-PE separa los decimales con punto y el reto se lee con coma.
   */
  function fmtNum(valor, decimales) {
    var v = numero(valor);
    if (v === null) return SIN_DATO;
    var d = decimales === null || decimales === undefined ? 2 : Math.floor(Number(decimales));
    if (!isFinite(d) || d < 0) d = 0;
    if (d > 6) d = 6;
    var abs = Math.abs(redondear(v, d)).toFixed(d);
    var trozos = abs.split('.');
    var texto = agruparMiles(trozos[0]) + (trozos.length > 1 ? ',' + trozos[1] : '');
    // Number(abs) === 0 evita el "-0,0" cuando el redondeo se come el signo.
    if (v < 0 && Number(abs) !== 0) texto = '-' + texto;
    return texto;
  }

  /** fmtKg(77.35) -> "77,4 kg"; null -> "—" */
  function fmtKg(valor) {
    var v = numero(valor);
    if (v === null) return SIN_DATO;
    return fmtNum(v, 1) + ' kg';
  }

  /**
   * fmtPct(20.5312) -> "20,53 %"; null -> "—"
   *
   * Los negativos siempre llevan su signo. Para forzar el "+" en los positivos
   * (utiles en variaciones, donde el signo es la informacion) se pasa
   * fmtPct(n, 2, {signo: true}); tambien se acepta fmtPct(n, {signo: true}).
   */
  function fmtPct(valor, decimales, opciones) {
    var d = decimales;
    var o = opciones || {};
    if (d !== null && d !== undefined && typeof d === 'object') {
      o = d;
      d = o.decimales;
    }
    var v = numero(valor);
    if (v === null) return SIN_DATO;
    var texto = fmtNum(v, d === null || d === undefined ? 2 : d);
    if (o.signo && texto.charAt(0) !== '-' && Number(texto.replace(/\./g, '').replace(',', '.')) !== 0) {
      texto = '+' + texto;
    }
    return texto + ' %';
  }

  // ---------------------------------------------------------------- fechas --

  /**
   * Normaliza lo que llegue a {d: Date, utc: boolean, soloFecha: boolean}.
   * utc = true marca los valores "yyyy-MM-dd", que se leen a medianoche UTC
   * para que no se corran un dia segun la zona del telefono.
   */
  function aFecha(valor) {
    if (valor instanceof Date) {
      return isFinite(valor.getTime()) ? { d: valor, utc: false, soloFecha: false } : null;
    }
    if (typeof valor === 'number' && isFinite(valor)) {
      var dn = new Date(valor);
      return isFinite(dn.getTime()) ? { d: dn, utc: false, soloFecha: false } : null;
    }
    if (typeof valor !== 'string') return null;
    var texto = valor.trim();
    if (!texto) return null;

    var m = RE_SOLO_FECHA.exec(texto);
    if (m) {
      var anio = Number(m[1]);
      var mes = Number(m[2]);
      var dia = Number(m[3]);
      if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
      var du = new Date(Date.UTC(anio, mes - 1, dia));
      // Rechaza fechas que el calendario corrige, como 2026-02-31.
      if (du.getUTCMonth() !== mes - 1 || du.getUTCDate() !== dia) return null;
      return { d: du, utc: true, soloFecha: true };
    }

    var mh = RE_FECHA_HORA.exec(texto);
    if (mh) {
      if (RE_ZONA.test(texto)) {
        var dz = new Date(texto);
        return isFinite(dz.getTime()) ? { d: dz, utc: false, soloFecha: false } : null;
      }
      // Sin zona explicita se interpreta como hora local del telefono.
      var dl = new Date(
        Number(mh[1]), Number(mh[2]) - 1, Number(mh[3]),
        Number(mh[4]), Number(mh[5]), mh[6] ? Number(mh[6]) : 0
      );
      return isFinite(dl.getTime()) ? { d: dl, utc: false, soloFecha: false } : null;
    }

    var otra = new Date(texto);
    return isFinite(otra.getTime()) ? { d: otra, utc: false, soloFecha: false } : null;
  }

  function partes(f) {
    if (!f) return null;
    if (f.utc) {
      return {
        anio: f.d.getUTCFullYear(),
        mes: f.d.getUTCMonth() + 1,
        dia: f.d.getUTCDate(),
        diaSemana: f.d.getUTCDay(),
        hora: f.d.getUTCHours(),
        minuto: f.d.getUTCMinutes()
      };
    }
    return {
      anio: f.d.getFullYear(),
      mes: f.d.getMonth() + 1,
      dia: f.d.getDate(),
      diaSemana: f.d.getDay(),
      hora: f.d.getHours(),
      minuto: f.d.getMinutes()
    };
  }

  var cacheIntl = {};

  /** Pide a Intl las piezas de la fecha en es-PE, o null si no se puede. */
  function piezasIntl(f) {
    try {
      if (typeof Intl === 'undefined' || !Intl.DateTimeFormat) return null;
      var clave = f.utc ? 'utc' : 'local';
      if (!cacheIntl[clave]) {
        var opciones = { weekday: 'long', day: 'numeric', month: 'long' };
        if (f.utc) opciones.timeZone = 'UTC';
        cacheIntl[clave] = new Intl.DateTimeFormat('es-PE', opciones);
      }
      var formateador = cacheIntl[clave];
      if (typeof formateador.formatToParts !== 'function') return null;
      var lista = formateador.formatToParts(f.d);
      var salida = {};
      for (var i = 0; i < lista.length; i++) {
        if (lista[i].type !== 'literal') salida[lista[i].type] = lista[i].value;
      }
      if (!salida.weekday || !salida.day || !salida.month) return null;
      return salida;
    } catch (e) {
      return null;
    }
  }

  /**
   * fmtFecha('2026-09-04') -> "jueves 4 de septiembre"
   *
   * Se arma con formatToParts en vez de format() para no depender de como cada
   * navegador ordena o puntua la frase. Si Intl no responde en espanol, se cae
   * a los arreglos propios de arriba.
   */
  function fmtFecha(valor) {
    var f = aFecha(valor);
    if (!f) return SIN_DATO;
    var p = piezasIntl(f);
    if (p) {
      var diaTexto = String(p.weekday).toLowerCase();
      var mesTexto = String(p.month).toLowerCase();
      // Validar contra los catalogos propios detecta el caso en que el entorno
      // ignora "es-PE" y devuelve "Thursday".
      if (DIAS.indexOf(diaTexto) >= 0 && MESES.indexOf(mesTexto) >= 0) {
        return diaTexto + ' ' + String(p.day) + ' de ' + mesTexto;
      }
    }
    var q = partes(f);
    return DIAS[q.diaSemana] + ' ' + q.dia + ' de ' + MESES[q.mes - 1];
  }

  /** fmtFechaCorta('2026-09-04') -> "04/09" */
  function fmtFechaCorta(valor) {
    var f = aFecha(valor);
    if (!f) return SIN_DATO;
    var q = partes(f);
    return pad2(q.dia) + '/' + pad2(q.mes);
  }

  /**
   * fmtHora('2026-09-04T20:33:12') -> "20:33"
   * Acepta tambien "2026-09-04 20:33:12" y "20:33". Un valor de solo fecha no
   * tiene hora: devuelve "—" en vez de inventar "00:00".
   */
  function fmtHora(valor) {
    if (typeof valor === 'string') {
      var texto = valor.trim();
      if (texto && !RE_ZONA.test(texto)) {
        var m = RE_HORA_SUELTA.exec(texto);
        if (m) {
          var h = Number(m[1]);
          if (h >= 0 && h <= 23) return pad2(h) + ':' + m[2];
        }
      }
    }
    var f = aFecha(valor);
    if (!f || f.soloFecha) return SIN_DATO;
    var q = partes(f);
    return pad2(q.hora) + ':' + pad2(q.minuto);
  }

  /**
   * hoyISO() -> "2026-09-04" con la fecha local del telefono.
   *
   * Es SOLO para pintar (titulos, marcadores del calendario). La fecha valida
   * del reto la calcula siempre el servidor en la zona horaria configurada: un
   * telefono con la zona o el reloj mal puestos no debe poder mover un
   * registro de dia.
   */
  function hoyISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function msMedianoche(valor) {
    var f = aFecha(valor);
    if (!f) return null;
    var q = partes(f);
    return Date.UTC(q.anio, q.mes - 1, q.dia);
  }

  /**
   * diasEntre('2026-09-01', '2026-09-04') -> 3
   * Cuenta dias de calendario (ambos llevados a medianoche), no horas, asi que
   * el horario de verano no lo descuadra. null si alguna fecha no es valida.
   */
  function diasEntre(a, b) {
    var ma = msMedianoche(a);
    var mb = msMedianoche(b);
    if (ma === null || mb === null) return null;
    return Math.round((mb - ma) / MS_DIA);
  }

  // ------------------------------------------------------------------- DOM --

  function raizDe(raiz) {
    if (raiz && typeof raiz.querySelector === 'function') return raiz;
    return document;
  }

  /** qs('.tarjeta') -> primer nodo o null (nunca lanza por selector malo). */
  function qs(sel, raiz) {
    try {
      return raizDe(raiz).querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  /** qsa('.aviso') -> arreglo de nodos (arreglo de verdad, con map y filter). */
  function qsa(sel, raiz) {
    try {
      return Array.prototype.slice.call(raizDe(raiz).querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  }

  function esNodo(v) {
    return !!v && typeof v === 'object' && typeof v.nodeType === 'number';
  }

  function esObjetoPlano(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v) && !esNodo(v);
  }

  function aKebab(clave) {
    return clave.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
  }

  function ponerAtributo(nodo, clave, valor) {
    if (valor === null || valor === undefined || valor === false) {
      nodo.removeAttribute(clave);
      return;
    }
    nodo.setAttribute(clave, valor === true ? '' : String(valor));
  }

  function aplicarClase(nodo, valor) {
    var lista = [];
    if (typeof valor === 'string') {
      lista = valor.split(/\s+/);
    } else if (Array.isArray(valor)) {
      for (var i = 0; i < valor.length; i++) {
        if (typeof valor[i] === 'string') lista = lista.concat(valor[i].split(/\s+/));
      }
    } else if (esObjetoPlano(valor)) {
      Object.keys(valor).forEach(function (k) {
        if (valor[k]) lista = lista.concat(k.split(/\s+/));
      });
    }
    for (var j = 0; j < lista.length; j++) {
      if (lista[j]) nodo.classList.add(lista[j]);
    }
  }

  function aplicarEstilo(nodo, valor) {
    if (typeof valor === 'string') {
      nodo.setAttribute('style', valor);
      return;
    }
    if (!esObjetoPlano(valor)) return;
    Object.keys(valor).forEach(function (k) {
      var v = valor[k];
      if (v === null || v === undefined) return;
      if (k.indexOf('--') === 0) nodo.style.setProperty(k, String(v));
      else nodo.style.setProperty(aKebab(k), String(v));
    });
  }

  /** Agrega hijos: nodo, texto, numero, arreglo (anidado) o nada. */
  function agregar(padre, hijos) {
    if (hijos === null || hijos === undefined || hijos === false || hijos === true) return padre;
    if (Array.isArray(hijos)) {
      for (var i = 0; i < hijos.length; i++) agregar(padre, hijos[i]);
      return padre;
    }
    if (esNodo(hijos)) {
      padre.appendChild(hijos);
      return padre;
    }
    padre.appendChild(document.createTextNode(String(hijos)));
    return padre;
  }

  /**
   * el(tag, props, hijos) -> HTMLElement
   *
   * props reconoce:
   *   clase     'boton boton--primario' | ['boton','boton--primario'] | {activo:true}
   *   texto     va a textContent (jamas a innerHTML)
   *   dataset   {registroId: 'abc'} -> data-registro-id
   *   atributos {'aria-label': 'Cerrar'} -> setAttribute
   *   estilo    {maxWidth: '20rem'} | 'max-width:20rem'
   *   on*       onclick, oninput, onsubmit... -> addEventListener
   *   resto     id, type, value, disabled, href... se asignan como propiedad si
   *             existe en el nodo, y si no como atributo. Las claves con guion
   *             o del tipo ariaLabel siempre pasan por setAttribute.
   *
   * Los hijos aceptan nodo, texto, numero, arreglo anidado o null. Por comodidad
   * el(tag, hijos) tambien funciona cuando el segundo argumento no es un objeto
   * de propiedades.
   */
  function el(tag, props, hijos) {
    var nodo = document.createElement(typeof tag === 'string' && tag ? tag : 'div');

    var propiedades = props;
    var contenido = hijos;
    if (props !== null && props !== undefined && !esObjetoPlano(props)) {
      // Llamada corta: el('p', 'texto') o el('div', [nodoA, nodoB]).
      propiedades = null;
      contenido = hijos === undefined ? props : hijos;
    }

    if (propiedades) {
      Object.keys(propiedades).forEach(function (clave) {
        var valor = propiedades[clave];
        if (PROHIBIDAS[clave]) return; // el contrato prohibe HTML interpolado
        if (valor === undefined || valor === null || valor === false) return;

        if (clave.length > 2 && clave.slice(0, 2) === 'on' && typeof valor === 'function') {
          nodo.addEventListener(clave.slice(2).toLowerCase(), valor);
          return;
        }

        switch (clave) {
          case 'clase':
          case 'class':
          case 'className':
            aplicarClase(nodo, valor);
            return;
          case 'texto':
          case 'textContent':
            nodo.textContent = valor === true ? '' : String(valor);
            return;
          case 'dataset':
          case 'datos':
            if (esObjetoPlano(valor)) {
              Object.keys(valor).forEach(function (k) {
                if (valor[k] === null || valor[k] === undefined) return;
                nodo.dataset[k] = String(valor[k]);
              });
            }
            return;
          case 'atributos':
          case 'attrs':
            if (esObjetoPlano(valor)) {
              Object.keys(valor).forEach(function (k) { ponerAtributo(nodo, k, valor[k]); });
            }
            return;
          case 'estilo':
          case 'style':
            aplicarEstilo(nodo, valor);
            return;
          case 'hijos':
            agregar(nodo, valor);
            return;
          default:
            break;
        }

        if (clave.indexOf('-') >= 0 || clave.indexOf(':') >= 0) {
          ponerAtributo(nodo, clave, valor);
          return;
        }
        if (/^aria[A-Z]/.test(clave) || clave === 'role') {
          ponerAtributo(nodo, aKebab(clave), valor);
          return;
        }
        if (clave in nodo) {
          try {
            nodo[clave] = valor;
            return;
          } catch (e) {
            // Propiedad de solo lectura: se intenta como atributo.
          }
        }
        ponerAtributo(nodo, clave, valor);
      });
    }

    agregar(nodo, contenido);
    return nodo;
  }

  /** Deja el contenedor vacio sin usar innerHTML. */
  function limpiar(nodo) {
    if (!nodo) return null;
    while (nodo.firstChild) nodo.removeChild(nodo.firstChild);
    return nodo;
  }

  /**
   * escapar(txt) -> texto con &, <, >, " y ' neutralizados.
   * Solo para el caso raro de armar una cadena que va a un atributo compuesto.
   * Si lo que quieres es pintar texto, usa el({texto}) o textContent: eso no
   * necesita escapado y no se puede equivocar.
   */
  function escapar(txt) {
    if (txt === null || txt === undefined) return '';
    return String(txt)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function resolverContenedor(contenedor) {
    if (typeof contenedor === 'string') return qs(contenedor);
    if (esNodo(contenedor)) return contenedor;
    return null;
  }

  // ---------------------------------------------------------------- avisos --

  /** Saca el texto para el usuario de una cadena, un ErrorApi o un Error. */
  function textoDeMensaje(entrada) {
    if (typeof entrada === 'string') return entrada.trim() || MENSAJE_GENERICO;
    if (entrada && typeof entrada === 'object') {
      // ErrorApi de api.js trae "mensaje"; un Error nativo trae "message".
      // El codigo tecnico nunca se muestra: no le dice nada al usuario.
      var m = entrada.mensaje || entrada.message;
      if (typeof m === 'string' && m.trim()) return m.trim();
    }
    return MENSAJE_GENERICO;
  }

  function contenedorAvisos() {
    var c = document.getElementById('avisos');
    if (!c && document.body) {
      c = el('div', {
        id: 'avisos',
        clase: 'avisos',
        atributos: { 'aria-live': 'assertive', 'aria-atomic': 'false' }
      });
      document.body.appendChild(c);
    }
    return c || null;
  }

  function pintarAviso(tipo, entrada) {
    var contenedor = contenedorAvisos();
    if (!contenedor) return null;

    var esError = tipo === 'error';
    var caja = el('div', {
      clase: ['aviso', esError ? 'aviso--error' : 'aviso--ok'],
      atributos: { role: esError ? 'alert' : 'status' }
    });
    caja.appendChild(el('span', { texto: textoDeMensaje(entrada) }));

    var temporizador = null;
    function quitar() {
      if (temporizador) {
        clearTimeout(temporizador);
        temporizador = null;
      }
      if (caja.parentNode) caja.parentNode.removeChild(caja);
    }

    caja.appendChild(el('button', {
      type: 'button',
      clase: 'boton boton--fantasma',
      texto: 'Cerrar',
      atributos: { 'aria-label': 'Cerrar aviso' },
      onclick: quitar
    }));

    contenedor.appendChild(caja);

    // Se apilan; los mas viejos salen para no tapar la vista en un celular.
    while (contenedor.children.length > MAX_AVISOS) {
      contenedor.removeChild(contenedor.firstElementChild);
    }

    temporizador = setTimeout(quitar, MS_AVISO);
    return caja;
  }

  /** mostrarOk('Registro guardado.') */
  function mostrarOk(mensaje) {
    return pintarAviso('ok', mensaje);
  }

  /** mostrarError(err) acepta texto, ErrorApi o Error. */
  function mostrarError(mensajeOrError) {
    return pintarAviso('error', mensajeOrError);
  }

  // ----------------------------------------------------------------- modal --

  var SELECTOR_FOCO = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(', ');

  var modalAbierto = null;

  function visible(nodo) {
    return !!(nodo.offsetWidth || nodo.offsetHeight || nodo.getClientRects().length);
  }

  function enfocables(raiz) {
    return qsa(SELECTOR_FOCO, raiz).filter(function (n) {
      return !n.disabled && n.getAttribute('aria-hidden') !== 'true' && visible(n);
    });
  }

  function botonDeAccion(accion, etiquetaPorDefecto, clase) {
    var etiqueta = etiquetaPorDefecto;
    var manejador = null;
    if (typeof accion === 'function') {
      manejador = accion;
    } else if (esObjetoPlano(accion)) {
      etiqueta = accion.texto || accion.etiqueta || etiquetaPorDefecto;
      manejador = accion.alPulsar || accion.onClick || accion.accion || null;
      if (typeof manejador !== 'function') manejador = null;
    } else {
      return null;
    }
    if (!manejador) return null;
    return el('button', {
      type: 'button',
      clase: clase || 'boton boton--primario',
      texto: etiqueta,
      onclick: manejador
    });
  }

  var ID_TITULO = 'modal-titulo';
  var ID_CUERPO = 'modal-cuerpo';
  var ID_TEXTO = 'modal-texto';

  /**
   * Arma un esqueleto de modal igual al del index.html, para el caso en que la
   * pagina que use util.js no lo traiga (por ejemplo una prueba suelta).
   */
  function crearEsqueletoModal() {
    var host = el('div', {
      id: 'modal',
      clase: 'modal',
      atributos: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': ID_TITULO }
    });
    host.appendChild(el('div', { clase: 'modal__fondo' }));
    var caja = el('div', { clase: 'modal__caja' });
    caja.appendChild(el('button', {
      type: 'button',
      id: 'modal-cerrar',
      clase: 'modal__cerrar',
      texto: '✕',
      atributos: { 'aria-label': 'Cerrar' }
    }));
    caja.appendChild(el('h2', { id: ID_TITULO, clase: 'tarjeta__titulo' }));
    caja.appendChild(el('div', { id: ID_CUERPO }));
    host.appendChild(caja);
    // Se devuelven las dos referencias en vez de volver a buscarlas: si el
    // selector falla, el modal se queda a medias sin motivo.
    return { host: host, caja: caja };
  }

  /**
   * confirmar(pregunta, opciones) -> Promise<boolean>
   *
   * opciones: {titulo, textoSi, textoNo, peligro}
   *
   * Nunca usa window.confirm: bloquea el hilo, no se puede estilar y en varios
   * navegadores de celular sale con el dominio del sitio delante.
   *
   * Rellena el #modal del index.html sin destruirlo: escribe en #modal-titulo y
   * en #modal-cuerpo, y deja intactos el fondo y el boton de cerrar (con su
   * data-cerrar, que app.js puede seguir delegando). Solo si la pagina no trae
   * el esqueleto lo crea, y en ese caso lo retira al cerrar.
   *
   * Atrapa el foco dentro de .modal__caja, cierra con Escape, con el fondo o
   * con la X, y devuelve el foco a donde estaba antes de abrir.
   */
  function confirmar(pregunta, opciones) {
    var o = esObjetoPlano(opciones) ? opciones : {};

    return new Promise(function (resolver) {
      if (!document.body) {
        resolver(false);
        return;
      }
      // Un solo modal a la vez: el anterior se resuelve como "no".
      if (modalAbierto) modalAbierto.cerrar(false);

      var enfocadoAntes = document.activeElement;
      // Se guarda antes de tocarlo para devolver el scroll tal como estaba.
      var desbordeAnterior = document.body.style.overflow;

      var host = document.getElementById('modal') || qs('.modal');
      var caja = host ? qs('.modal__caja', host) : null;
      var creado = false;
      if (!host || !caja) {
        var armado = crearEsqueletoModal();
        host = armado.host;
        caja = armado.caja;
        document.body.appendChild(host);
        creado = true;
      }

      var titulo = qs('#' + ID_TITULO, host) || qs('h2', caja);
      var cuerpo = qs('#' + ID_CUERPO, host);
      if (!cuerpo) {
        cuerpo = el('div', { id: ID_CUERPO });
        caja.appendChild(cuerpo);
      }
      var botonX = qs('.modal__cerrar', caja);
      var fondo = qs('.modal__fondo', host);
      // El role="dialog" del index.html vive en el host; si no lo tiene, la
      // caja hace de dialogo. No se duplica nunca el rol.
      var dialogo = host.getAttribute('role') === 'dialog' ? host : caja;

      var resuelto = false;

      function cerrar(valor) {
        if (resuelto) return;
        resuelto = true;
        modalAbierto = null;
        document.removeEventListener('keydown', alTeclado, true);
        document.removeEventListener('focusin', alFoco, true);
        if (fondo) fondo.removeEventListener('click', alCerrar);
        if (botonX) botonX.removeEventListener('click', alCerrar);
        limpiar(cuerpo);
        if (titulo) titulo.textContent = '';
        if (describedAnterior === null) dialogo.removeAttribute('aria-describedby');
        else dialogo.setAttribute('aria-describedby', describedAnterior);
        if (creado) {
          if (host.parentNode) host.parentNode.removeChild(host);
        } else {
          host.classList.add('oculto');
        }
        document.body.style.overflow = desbordeAnterior;
        if (enfocadoAntes && typeof enfocadoAntes.focus === 'function' &&
            document.contains(enfocadoAntes)) {
          try { enfocadoAntes.focus(); } catch (e) { /* el nodo ya no acepta foco */ }
        }
        resolver(valor === true);
      }

      function alCerrar() {
        cerrar(false);
      }

      function alTeclado(ev) {
        if (ev.key === 'Escape' || ev.key === 'Esc') {
          ev.preventDefault();
          cerrar(false);
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
      }

      function alFoco(ev) {
        // Red de seguridad: si el foco se escapa de la caja, se lo devuelve.
        if (caja.contains(ev.target)) return;
        var lista = enfocables(caja);
        if (lista.length) lista[0].focus();
      }

      if (titulo) titulo.textContent = o.titulo || 'Confirmación';

      limpiar(cuerpo);
      cuerpo.appendChild(el('p', {
        id: ID_TEXTO,
        texto: pregunta === null || pregunta === undefined || String(pregunta).trim() === ''
          ? '¿Confirmas esta acción?'
          : String(pregunta)
      }));

      var botonNo = el('button', {
        type: 'button',
        clase: 'boton boton--fantasma',
        texto: o.textoNo || 'Cancelar',
        onclick: function () { cerrar(false); }
      });
      var botonSi = el('button', {
        type: 'button',
        clase: 'boton ' + (o.peligro ? 'boton--peligro' : 'boton--primario'),
        texto: o.textoSi || 'Sí',
        onclick: function () { cerrar(true); }
      });
      cuerpo.appendChild(el('div', { clase: 'apilado' }, [botonNo, botonSi]));

      var describedAnterior = dialogo.getAttribute('aria-describedby');
      dialogo.setAttribute('aria-describedby', ID_TEXTO);

      host.classList.add('modal');
      host.classList.remove('oculto');
      document.body.style.overflow = 'hidden';

      if (fondo) fondo.addEventListener('click', alCerrar);
      if (botonX) botonX.addEventListener('click', alCerrar);
      document.addEventListener('keydown', alTeclado, true);
      document.addEventListener('focusin', alFoco, true);
      modalAbierto = { cerrar: cerrar };

      // Si la accion es destructiva, el foco arranca en la salida segura.
      var inicial = o.peligro ? botonNo : botonSi;
      try { inicial.focus(); } catch (e) { /* sin foco disponible */ }
    });
  }

  // ------------------------------------------------- estados de las vistas --

  /** cargando(contenedor, texto) -> reemplaza el contenido por el esqueleto. */
  function cargando(contenedor, texto) {
    var c = resolverContenedor(contenedor);
    if (!c) return null;
    limpiar(c);
    var caja = el('div', {
      clase: 'cargando',
      atributos: { role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' }
    });
    caja.appendChild(el('p', { texto: texto || 'Cargando…' }));
    var barras = el('div', { atributos: { 'aria-hidden': 'true' } });
    for (var i = 0; i < 3; i++) barras.appendChild(el('div', { clase: 'esqueleto' }));
    caja.appendChild(barras);
    c.appendChild(caja);
    return caja;
  }

  /**
   * vacio(contenedor, texto, accion) -> estado "no hay nada todavia".
   * accion puede ser una funcion o {texto, alPulsar}.
   */
  function vacio(contenedor, texto, accion) {
    var c = resolverContenedor(contenedor);
    if (!c) return null;
    limpiar(c);
    var caja = el('div', { clase: 'vacio' });
    caja.appendChild(el('p', { texto: texto || 'Todavía no hay nada por aquí.' }));
    var boton = botonDeAccion(accion, 'Actualizar');
    if (boton) caja.appendChild(boton);
    c.appendChild(caja);
    return caja;
  }

  /**
   * errorEn(contenedor, err, reintentar) -> estado de error con salida.
   * Nunca deja la vista en blanco y nunca muestra el codigo tecnico.
   */
  function errorEn(contenedor, err, reintentar) {
    var c = resolverContenedor(contenedor);
    if (!c) return null;
    limpiar(c);
    var caja = el('div', { clase: 'error', atributos: { role: 'alert' } });
    caja.appendChild(el('p', { texto: textoDeMensaje(err) }));
    var boton = botonDeAccion(reintentar, 'Reintentar');
    if (boton) caja.appendChild(boton);
    c.appendChild(caja);
    return caja;
  }

  // ----------------------------------------------------------- utilitarios --

  /**
   * debounce(fn, ms) -> funcion diferida, con .cancelar() para soltarla al
   * desmontar una vista y no disparar sobre nodos que ya no existen.
   */
  function debounce(fn, ms) {
    var espera = numero(ms);
    if (espera === null || espera < 0) espera = 250;
    var temporizador = null;
    function diferida() {
      var contexto = this;
      var args = arguments;
      if (temporizador) clearTimeout(temporizador);
      temporizador = setTimeout(function () {
        temporizador = null;
        fn.apply(contexto, args);
      }, espera);
    }
    diferida.cancelar = function () {
      if (temporizador) clearTimeout(temporizador);
      temporizador = null;
    };
    return diferida;
  }

  /** esperar(400) -> Promise que resuelve a los 400 ms. */
  function esperar(ms) {
    var espera = numero(ms);
    if (espera === null || espera < 0) espera = 0;
    return new Promise(function (resolver) { setTimeout(resolver, espera); });
  }

  window.U = {
    SIN_DATO: SIN_DATO,

    fmtKg: fmtKg,
    fmtPct: fmtPct,
    fmtNum: fmtNum,
    fmtFecha: fmtFecha,
    fmtFechaCorta: fmtFechaCorta,
    fmtHora: fmtHora,
    hoyISO: hoyISO,
    diasEntre: diasEntre,

    qs: qs,
    qsa: qsa,
    el: el,
    limpiar: limpiar,
    escapar: escapar,

    mostrarOk: mostrarOk,
    mostrarError: mostrarError,
    confirmar: confirmar,

    cargando: cargando,
    vacio: vacio,
    errorEn: errorEn,

    debounce: debounce,
    esperar: esperar,

    // Auxiliares que app.js y demo.js reaprovechan.
    numero: numero,
    pad2: pad2,
    textoDeMensaje: textoDeMensaje
  };
}());
