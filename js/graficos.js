/**
 * graficos.js — window.Graficos = {lineas, barras}
 *
 * Script clasico (sin modulos, sin librerias, sin CDN). Dibuja SVG en linea con
 * document.createElementNS: aqui no hay ni una asignacion a innerHTML, asi que
 * ningun nombre de participante ni nota puede convertirse en marcado.
 *
 * Decisiones que conviene no deshacer sin leer el contrato (docs/CONTRATO.md,
 * seccion 8):
 *
 * 1. La escala vertical de `lineas` NO fuerza el cero. En el reto la metrica es
 *    el porcentaje del peso inicial perdido: si el eje arranca en 0 %, dos
 *    curvas de 4,1 % y 6,8 % quedan pegadas en la base y la diferencia real
 *    entre los dos competidores desaparece. Se usa el dominio de los datos con
 *    un margen del 8 %. En `barras` si se incluye el cero, porque ahi la
 *    informacion es el largo de la barra y recortar la base miente.
 * 2. Las series se distinguen por color, por forma de punto y por patron de
 *    trazo a la vez. Con solo color, un daltonico ve dos lineas iguales.
 * 3. Los colores salen de opts o de las custom properties del CSS, aplicadas
 *    como `var(--token, respaldo)` en el estilo del nodo. Asi el grafico cambia
 *    solo cuando el telefono pasa a modo oscuro, sin repintar ni escuchar
 *    matchMedia.
 * 4. El viewBox se recalcula con el ancho real del contenedor (1 unidad = 1 px)
 *    para que los textos no se estiren; un ResizeObserver repinta cuando el
 *    contenedor cambia de ancho. En el HTML el SVG mide 100 % de ancho y alto
 *    automatico: nunca un ancho fijo en px.
 * 5. Cada grafico deja una tabla equivalente con clase .solo-lectores. El SVG
 *    es role="img" con aria-label: el lector de pantalla recibe el resumen y,
 *    si quiere el detalle, la tabla lo tiene completo.
 * 6. No hay animaciones ni transiciones: el grafico aparece dibujado. Asi se
 *    respeta prefers-reduced-motion sin condicionales y en un telefono lento no
 *    se paga el costo de animar cien puntos.
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var SIN_DATO = '—';

  // ------------------------------------------------------------- utilidades --

  var U = window.U || {};

  function numero(valor) {
    if (typeof U.numero === 'function') return U.numero(valor);
    var v = typeof valor === 'string' ? Number(valor.replace(',', '.')) : Number(valor);
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function fmtNum(valor, decimales) {
    if (typeof U.fmtNum === 'function') return U.fmtNum(valor, decimales);
    var v = numero(valor);
    if (v === null) return SIN_DATO;
    return v.toFixed(decimales === null || decimales === undefined ? 1 : decimales).replace('.', ',');
  }

  function fmtFechaCorta(iso) {
    if (typeof U.fmtFechaCorta === 'function') return U.fmtFechaCorta(iso);
    if (typeof iso === 'string' && iso.length >= 10) return iso.slice(8, 10) + '/' + iso.slice(5, 7);
    return String(iso || SIN_DATO);
  }

  function fmtFechaLarga(iso) {
    if (typeof U.fmtFecha === 'function') return U.fmtFecha(iso);
    return String(iso || SIN_DATO);
  }

  function acotar(v, minimo, maximo) {
    return Math.max(minimo, Math.min(maximo, v));
  }

  /** Ancho aproximado de un texto. Suficiente para reservar margenes. */
  function anchoTexto(texto, tamano) {
    return String(texto === null || texto === undefined ? '' : texto).length * tamano * 0.58;
  }

  /** Recorta un texto al ancho disponible y le pone puntos suspensivos. */
  function recortar(texto, tamano, disponible) {
    var t = String(texto === null || texto === undefined ? '' : texto);
    if (anchoTexto(t, tamano) <= disponible) return t;
    var cabe = Math.max(1, Math.floor(disponible / (tamano * 0.58)) - 1);
    return t.slice(0, cabe).replace(/\s+$/, '') + '…';
  }

  /** ms de la medianoche UTC de una fecha 'yyyy-MM-dd'. null si no es fecha. */
  function msDeFecha(valor) {
    if (typeof valor === 'string') {
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(valor.trim());
      if (m) {
        var anio = Number(m[1]);
        var mes = Number(m[2]);
        var dia = Number(m[3]);
        if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
        var d = new Date(Date.UTC(anio, mes - 1, dia));
        if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
        return d.getTime();
      }
    }
    if (valor instanceof Date && isFinite(valor.getTime())) {
      return Date.UTC(valor.getFullYear(), valor.getMonth(), valor.getDate());
    }
    return null;
  }

  /** 'yyyy-MM-dd' a partir de ms UTC, para la tabla y los avisos. */
  function isoDeMs(ms) {
    var d = new Date(ms);
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
  }

  // ---------------------------------------------------------------- colores --

  // Tokens del CSS con respaldo literal. El respaldo solo entra si alguien borra
  // la variable: mientras exista, manda el CSS y el modo oscuro funciona solo.
  var PALETA = [
    { token: '--c-primario', respaldo: '#0e6f52' },
    { token: '--c-info', respaldo: '#1f4fa3' },
    { token: '--c-duda', respaldo: '#8a5200' },
    { token: '--c-error', respaldo: '#b3261e' },
    { token: '--c-ok', respaldo: '#14653b' },
    { token: '--c-oro', respaldo: '#7a5600' }
  ];

  var C_TEXTO = 'var(--c-texto, #131820)';
  var C_SUAVE = 'var(--c-texto-suave, #4b5563)';
  var C_BORDE = 'var(--c-borde, #d3dae3)';
  var C_BORDE_FUERTE = 'var(--c-borde-fuerte, #b3bdca)';
  var C_SUPERFICIE = 'var(--c-superficie, #ffffff)';
  var C_SUPERFICIE_2 = 'var(--c-superficie-2, #eceff4)';
  var C_FOCO = 'var(--c-foco, #1257c9)';

  /** Convierte lo que pida quien llama en una expresion CSS de color. */
  function expresionColor(valor) {
    if (typeof valor !== 'string') return null;
    var v = valor.trim();
    if (!v) return null;
    // '--c-primario' se entiende como token; '#0e6f52', 'rebeccapurple' o
    // 'var(--x)' se usan tal cual.
    if (v.slice(0, 2) === '--') return 'var(' + v + ')';
    return v;
  }

  function leerToken(raiz, nombre) {
    try {
      var vista = raiz && raiz.ownerDocument && raiz.ownerDocument.defaultView
        ? raiz.ownerDocument.defaultView
        : window;
      if (!vista || typeof vista.getComputedStyle !== 'function') return '';
      var estilo = vista.getComputedStyle(raiz || document.documentElement);
      var v = estilo.getPropertyValue(nombre);
      return v ? v.trim() : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Color de la serie i. Prioridad: lo que pide quien llama, luego una custom
   * property --c-serie-N si el CSS la define (asi la paleta se cambia sin tocar
   * este archivo), y por ultimo la paleta de tokens de arriba.
   */
  function colorSerie(raiz, i, pedido) {
    var propio = expresionColor(pedido);
    if (propio) return propio;
    var token = '--c-serie-' + (i + 1);
    if (leerToken(raiz, token)) return 'var(' + token + ')';
    var base = PALETA[i % PALETA.length];
    return 'var(' + base.token + ', ' + base.respaldo + ')';
  }

  // Formas de punto y patrones de trazo: la segunda y la tercera pista para
  // distinguir series sin depender del color.
  var FORMAS = ['circulo', 'cuadro', 'triangulo', 'rombo', 'cruz', 'triangulo-abajo'];
  var TRAZOS = ['', '6 4', '2 3', '9 3 2 3', '1 4', '12 4 2 4'];

  var NOMBRE_FORMA = {
    circulo: 'círculo',
    cuadro: 'cuadrado',
    triangulo: 'triángulo',
    rombo: 'rombo',
    cruz: 'cruz',
    'triangulo-abajo': 'triángulo invertido'
  };

  // -------------------------------------------------------------- nodos SVG --

  function svgNodo(tag, atributos) {
    var nodo = document.createElementNS(NS, tag);
    if (atributos) {
      Object.keys(atributos).forEach(function (clave) {
        var valor = atributos[clave];
        if (valor === null || valor === undefined || valor === '') return;
        nodo.setAttribute(clave, String(valor));
      });
    }
    return nodo;
  }

  function svgTexto(x, y, texto, opciones) {
    var o = opciones || {};
    var nodo = svgNodo('text', {
      x: x,
      y: y,
      'text-anchor': o.ancla || 'middle',
      'dominant-baseline': o.base || 'auto',
      'font-size': o.tamano || 11,
      'font-weight': o.peso || 400
    });
    nodo.style.fill = o.color || C_SUAVE;
    nodo.style.fontFamily = 'inherit';
    nodo.textContent = String(texto === null || texto === undefined ? '' : texto);
    return nodo;
  }

  /** Dibuja la forma de la serie centrada en (x, y). */
  function marca(forma, x, y, radio, color) {
    var r = radio;
    var nodo;
    if (forma === 'cuadro') {
      nodo = svgNodo('rect', { x: x - r, y: y - r, width: r * 2, height: r * 2 });
    } else if (forma === 'triangulo') {
      nodo = svgNodo('polygon', {
        points: [x, y - r * 1.2, x + r * 1.15, y + r * 0.9, x - r * 1.15, y + r * 0.9].join(' ')
      });
    } else if (forma === 'triangulo-abajo') {
      nodo = svgNodo('polygon', {
        points: [x, y + r * 1.2, x + r * 1.15, y - r * 0.9, x - r * 1.15, y - r * 0.9].join(' ')
      });
    } else if (forma === 'rombo') {
      nodo = svgNodo('polygon', {
        points: [x, y - r * 1.35, x + r * 1.35, y, x, y + r * 1.35, x - r * 1.35, y].join(' ')
      });
    } else if (forma === 'cruz') {
      nodo = svgNodo('path', {
        d: 'M' + (x - r * 1.2) + ' ' + y + 'H' + (x + r * 1.2) +
           'M' + x + ' ' + (y - r * 1.2) + 'V' + (y + r * 1.2),
        'stroke-width': Math.max(1.6, r * 0.8),
        'stroke-linecap': 'round',
        fill: 'none'
      });
      nodo.style.stroke = color;
      return nodo;
    } else {
      nodo = svgNodo('circle', { cx: x, cy: y, r: r });
    }
    nodo.style.fill = color;
    return nodo;
  }

  // ------------------------------------------------------------ nodos HTML  --

  function nodoHtml(tag, clase) {
    var n = document.createElement(tag);
    if (clase) n.className = clase;
    return n;
  }

  function vaciar(nodo) {
    if (!nodo) return nodo;
    while (nodo.firstChild) nodo.removeChild(nodo.firstChild);
    return nodo;
  }

  function resolverContenedor(contenedor) {
    if (typeof contenedor === 'string') {
      try {
        return document.querySelector(contenedor);
      } catch (e) {
        return null;
      }
    }
    if (contenedor && contenedor.nodeType === 1) return contenedor;
    return null;
  }

  function pintarVacio(contenedor, texto) {
    if (typeof U.vacio === 'function') return U.vacio(contenedor, texto);
    vaciar(contenedor);
    var caja = nodoHtml('div', 'vacio');
    var p = nodoHtml('p');
    p.textContent = texto;
    caja.appendChild(p);
    contenedor.appendChild(caja);
    return caja;
  }

  // ------------------------------------------------- estado por contenedor --

  // Un contenedor puede recibir varios graficos a lo largo de la sesion (el
  // tablero se repinta al cambiar de vista). Aqui se guarda lo unico que no se
  // limpia solo al vaciar el DOM: el observador y los temporizadores.
  var ESTADOS = typeof WeakMap === 'function' ? new WeakMap() : null;

  function soltar(contenedor) {
    if (!ESTADOS) return;
    var st = ESTADOS.get(contenedor);
    if (!st) return;
    if (st.ro) {
      try { st.ro.disconnect(); } catch (e) { /* observador ya muerto */ }
    }
    if (st.alRedimensionar) {
      window.removeEventListener('resize', st.alRedimensionar);
      window.removeEventListener('orientationchange', st.alRedimensionar);
    }
    if (st.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(st.raf);
    if (st.temporizador) clearTimeout(st.temporizador);
    st.programado = false;
    ESTADOS.delete(contenedor);
  }

  /**
   * Vigila el ancho del contenedor y repinta. Solo reacciona a cambios de 4 px
   * o mas para no entrar en bucle: el SVG mide 100 % del contenedor, asi que
   * repintarlo no deberia moverlo, pero un redondeo de subpixel no vale un
   * repintado.
   */
  function observar(contenedor, repintar, medir) {
    if (!ESTADOS) return;
    var st = { ro: null, raf: 0, temporizador: 0, programado: false, alRedimensionar: null };
    ESTADOS.set(contenedor, st);

    // Se agenda por requestAnimationFrame y por setTimeout a la vez, y gana el
    // que llegue primero: hay contextos (pestana en segundo plano, vista aun
    // sin pintar, WebView incrustada) donde el rAF no se dispara nunca y el
    // grafico se quedaria con el viewBox viejo, escalado a mano.
    var pendiente = function () {
      if (st.programado) return;
      st.programado = true;
      var correr = function () {
        if (!st.programado) return;
        st.programado = false;
        if (st.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(st.raf);
        if (st.temporizador) clearTimeout(st.temporizador);
        st.raf = 0;
        st.temporizador = 0;
        if (!contenedor.isConnected) {
          soltar(contenedor);
          return;
        }
        var ahora = medir();
        if (Math.abs(ahora - st.anchoPintado) < 4) return;
        st.anchoPintado = ahora;
        repintar();
      };
      if (typeof requestAnimationFrame === 'function') st.raf = requestAnimationFrame(correr);
      st.temporizador = setTimeout(correr, 150);
    };

    st.anchoPintado = medir();

    if (typeof ResizeObserver === 'function') {
      try {
        st.ro = new ResizeObserver(pendiente);
        st.ro.observe(contenedor);
        return;
      } catch (e) {
        st.ro = null;
      }
    }
    // Respaldo para navegadores sin ResizeObserver.
    st.alRedimensionar = pendiente;
    window.addEventListener('resize', pendiente);
    window.addEventListener('orientationchange', pendiente);
  }

  function anchoDe(contenedor) {
    var ancho = 0;
    try {
      ancho = contenedor.clientWidth || Math.round(contenedor.getBoundingClientRect().width) || 0;
    } catch (e) {
      ancho = 0;
    }
    // Contenedor todavia oculto (vista sin mostrar): se pinta con una medida
    // razonable y el observador repinta en cuanto tenga ancho real.
    if (!ancho) ancho = 360;
    // Por debajo de 200 px el viewBox se queda en 200 y el SVG se escala: es
    // mejor un grafico un poco mas chico que uno donde los margenes se comen
    // todo el area de dibujo.
    return acotar(ancho, 200, 1400);
  }

  // ------------------------------------------------------------- escala Y   --

  /**
   * Paso "bonito" (1, 2, 5 x 10^n) para repartir marcas en el eje.
   *
   * Los cortes son 1,5 / 3 / 7 en vez de 1 / 2 / 5: con los cortes ingenuos un
   * rango de 21 % pedia paso 10 y el eje se quedaba con dos marcas (0 y 10),
   * que es demasiado pobre para leer una curva.
   */
  function pasoBonito(rango, cuantos) {
    var crudo = rango / Math.max(1, cuantos);
    if (!(crudo > 0)) return 1;
    var magnitud = Math.pow(10, Math.floor(Math.log(crudo) / Math.LN10));
    var normal = crudo / magnitud;
    var mult = 10;
    if (normal <= 1.5) mult = 1;
    else if (normal <= 3) mult = 2;
    else if (normal <= 7) mult = 5;
    return mult * magnitud;
  }

  function decimalesDe(paso) {
    for (var d = 0; d <= 3; d++) {
      var escalado = paso * Math.pow(10, d);
      if (Math.abs(escalado - Math.round(escalado)) < 1e-9) return d;
    }
    return 3;
  }

  function marcasY(minimo, maximo, cuantos) {
    var paso = pasoBonito(maximo - minimo, cuantos);
    var lista = [];
    var inicio = Math.ceil((minimo / paso) - 1e-9) * paso;
    for (var v = inicio; v <= maximo + 1e-9 && lista.length < 12; v += paso) {
      // El redondeo evita marcas como 62.00000000000001.
      lista.push(Math.round(v * 1e6) / 1e6);
    }
    return { valores: lista, paso: paso, decimales: decimalesDe(paso) };
  }

  // --------------------------------------------------------------- lineas   --

  function normalizarSeries(series, raiz) {
    var lista = Array.isArray(series) ? series : [];
    var salida = [];
    for (var i = 0; i < lista.length; i++) {
      var s = lista[i] || {};
      var crudos = Array.isArray(s.puntos) ? s.puntos : [];
      var puntos = [];
      var mapa = {};
      for (var j = 0; j < crudos.length; j++) {
        var p = crudos[j] || {};
        var t = msDeFecha(p.x);
        var y = numero(p.y);
        if (t === null) continue;
        // y nulo o no numerico es un hueco declarado: parte la linea.
        puntos.push({ t: t, iso: typeof p.x === 'string' ? p.x.slice(0, 10) : isoDeMs(t), y: y });
        if (y !== null) mapa[t] = y;
      }
      puntos.sort(function (a, b) { return a.t - b.t; });
      var indice = salida.length;
      salida.push({
        nombre: String(s.nombre === null || s.nombre === undefined ? 'Serie ' + (indice + 1) : s.nombre),
        color: colorSerie(raiz, indice, s.color),
        forma: FORMAS[indice % FORMAS.length],
        trazo: TRAZOS[indice % TRAZOS.length],
        puntos: puntos,
        mapa: mapa
      });
    }
    return salida;
  }

  function unirFechas(series) {
    var vistos = {};
    var lista = [];
    for (var i = 0; i < series.length; i++) {
      var puntos = series[i].puntos;
      for (var j = 0; j < puntos.length; j++) {
        var t = puntos[j].t;
        if (vistos[t]) continue;
        vistos[t] = true;
        lista.push({ t: t, iso: puntos[j].iso });
      }
    }
    lista.sort(function (a, b) { return a.t - b.t; });
    return lista;
  }

  function dominioY(series, margenPct, forzarCero) {
    var minimo = Infinity;
    var maximo = -Infinity;
    for (var i = 0; i < series.length; i++) {
      var puntos = series[i].puntos;
      for (var j = 0; j < puntos.length; j++) {
        var y = puntos[j].y;
        if (y === null) continue;
        if (y < minimo) minimo = y;
        if (y > maximo) maximo = y;
      }
    }
    if (!isFinite(minimo) || !isFinite(maximo)) return null;
    if (forzarCero) {
      minimo = Math.min(0, minimo);
      maximo = Math.max(0, maximo);
    }
    var rango = maximo - minimo;
    if (rango <= 0) {
      // Un solo valor (o todos iguales): se abre una ventana simetrica para que
      // el punto no quede pegado al borde.
      var abre = Math.abs(maximo) * 0.05 || 1;
      return { min: minimo - abre, max: maximo + abre };
    }
    var margen = rango * (margenPct / 100);
    var conMargen = { min: minimo - margen, max: maximo + margen };
    if (forzarCero) {
      // Si se pidio el cero, el cero es el borde: el margen no debe empujar el
      // eje a valores negativos que no existen en los datos.
      if (minimo >= 0) conMargen.min = 0;
      if (maximo <= 0) conMargen.max = 0;
    }
    return conMargen;
  }

  function resumenSeries(series, fechas, formato) {
    var partes = [];
    var tope = Math.min(series.length, 4);
    for (var i = 0; i < tope; i++) {
      var s = series[i];
      var conDato = s.puntos.filter(function (p) { return p.y !== null; });
      if (!conDato.length) {
        partes.push(s.nombre + ': sin datos.');
        continue;
      }
      var primero = conDato[0];
      var ultimo = conDato[conDato.length - 1];
      var minimo = conDato[0].y;
      var maximo = conDato[0].y;
      for (var j = 1; j < conDato.length; j++) {
        if (conDato[j].y < minimo) minimo = conDato[j].y;
        if (conDato[j].y > maximo) maximo = conDato[j].y;
      }
      partes.push(
        s.nombre + ', trazo con puntos de ' + (NOMBRE_FORMA[s.forma] || 'punto') + ': ' +
        conDato.length + (conDato.length === 1 ? ' dato, ' : ' datos, ') +
        'empieza en ' + formato(primero.y) + ' el ' + fmtFechaLarga(primero.iso) +
        ' y termina en ' + formato(ultimo.y) + ' el ' + fmtFechaLarga(ultimo.iso) +
        '; mínimo ' + formato(minimo) + ', máximo ' + formato(maximo) + '.'
      );
    }
    if (series.length > tope) {
      partes.push('Hay ' + (series.length - tope) + ' serie(s) más en la tabla de datos.');
    }
    var cabecera = 'Gráfico de líneas con ' + series.length +
      (series.length === 1 ? ' serie' : ' series') + ' y ' + fechas.length +
      (fechas.length === 1 ? ' fecha' : ' fechas') +
      (fechas.length ? ', del ' + fmtFechaLarga(fechas[0].iso) + ' al ' + fmtFechaLarga(fechas[fechas.length - 1].iso) : '') +
      '. ';
    return cabecera + partes.join(' ');
  }

  function tablaLineas(series, fechas, titulo, formato) {
    var tabla = nodoHtml('table', 'solo-lectores');
    var leyenda = nodoHtml('caption');
    leyenda.textContent = titulo || 'Datos del gráfico';
    tabla.appendChild(leyenda);

    var cabeza = nodoHtml('thead');
    var filaCab = nodoHtml('tr');
    var thFecha = nodoHtml('th');
    thFecha.setAttribute('scope', 'col');
    thFecha.textContent = 'Fecha';
    filaCab.appendChild(thFecha);
    series.forEach(function (s) {
      var th = nodoHtml('th');
      th.setAttribute('scope', 'col');
      th.textContent = s.nombre;
      filaCab.appendChild(th);
    });
    cabeza.appendChild(filaCab);
    tabla.appendChild(cabeza);

    var cuerpo = nodoHtml('tbody');
    fechas.forEach(function (f) {
      var fila = nodoHtml('tr');
      var th = nodoHtml('th');
      th.setAttribute('scope', 'row');
      th.textContent = fmtFechaLarga(f.iso);
      fila.appendChild(th);
      series.forEach(function (s) {
        var td = nodoHtml('td');
        var y = Object.prototype.hasOwnProperty.call(s.mapa, f.t) ? s.mapa[f.t] : null;
        td.textContent = y === null ? SIN_DATO : formato(y);
        fila.appendChild(td);
      });
      cuerpo.appendChild(fila);
    });
    tabla.appendChild(cuerpo);
    return tabla;
  }

  function leyendaHtml(series) {
    var caja = nodoHtml('div');
    caja.style.display = 'flex';
    caja.style.flexWrap = 'wrap';
    caja.style.gap = '0.25rem 0.75rem';
    caja.style.marginTop = '0.5rem';
    caja.style.fontSize = 'var(--t-xs, 0.75rem)';
    caja.style.color = C_SUAVE;
    caja.style.lineHeight = '1.4';

    series.forEach(function (s) {
      var item = nodoHtml('span');
      item.style.display = 'inline-flex';
      item.style.alignItems = 'center';
      item.style.gap = '0.35rem';
      item.style.minHeight = '1.5rem';

      var muestra = svgNodo('svg', {
        viewBox: '0 0 26 12',
        width: 26,
        height: 12,
        'aria-hidden': 'true',
        focusable: 'false'
      });
      muestra.style.flex = '0 0 auto';
      var linea = svgNodo('path', {
        d: 'M1 6H25',
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-dasharray': s.trazo,
        fill: 'none'
      });
      linea.style.stroke = s.color;
      muestra.appendChild(linea);
      muestra.appendChild(marca(s.forma, 13, 6, 3.2, s.color));

      var texto = nodoHtml('span');
      texto.textContent = s.nombre;

      item.appendChild(muestra);
      item.appendChild(texto);
      caja.appendChild(item);
    });
    return caja;
  }

  function cajaTooltip() {
    var caja = nodoHtml('div');
    caja.hidden = true;
    caja.setAttribute('aria-hidden', 'true');
    caja.style.position = 'absolute';
    caja.style.zIndex = '3';
    caja.style.pointerEvents = 'none';
    caja.style.maxWidth = '14rem';
    caja.style.padding = 'var(--e-2, 0.5rem) var(--e-3, 0.75rem)';
    caja.style.borderRadius = 'var(--r-md, 10px)';
    caja.style.border = '1px solid ' + C_BORDE;
    caja.style.background = C_SUPERFICIE;
    caja.style.color = C_TEXTO;
    caja.style.boxShadow = 'var(--s-2, 0 4px 12px rgba(16, 24, 40, 0.10))';
    caja.style.fontSize = 'var(--t-xs, 0.75rem)';
    caja.style.lineHeight = '1.4';
    return caja;
  }

  /**
   * lineas(contenedor, series, opts)
   *
   * series: [{nombre, color, puntos: [{x: 'yyyy-MM-dd', y: number}]}]
   * opts:   {unidad, decimales, titulo, alto, colores, forzarCero, margenPct,
   *          leyenda, vacio}
   *
   * Devuelve el nodo <svg> pintado, o null si no habia nada que dibujar.
   */
  function lineas(contenedor, series, opts) {
    var c = resolverContenedor(contenedor);
    if (!c) return null;
    var o = opts && typeof opts === 'object' ? opts : {};

    soltar(c);
    vaciar(c);

    var normalizadas = normalizarSeries(series, c);
    if (Array.isArray(o.colores)) {
      normalizadas.forEach(function (s, i) {
        var pedido = expresionColor(o.colores[i]);
        if (pedido) s.color = pedido;
      });
    }
    var fechas = unirFechas(normalizadas);
    var dominio = dominioY(normalizadas, numero(o.margenPct) === null ? 8 : numero(o.margenPct), !!o.forzarCero);

    if (!normalizadas.length || !fechas.length || !dominio) {
      pintarVacio(c, o.vacio || 'Todavía no hay datos suficientes para dibujar el gráfico.');
      return null;
    }

    var unidad = typeof o.unidad === 'string' ? o.unidad.trim() : '';
    var decimales = numero(o.decimales);
    if (decimales === null) decimales = unidad.indexOf('%') >= 0 ? 2 : 1;
    var formato = function (v) {
      return fmtNum(v, decimales) + (unidad ? ' ' + unidad : '');
    };

    // -- armazon HTML: envoltura relativa + tooltip + aviso para lectores -----
    var envoltura = nodoHtml('div');
    envoltura.style.position = 'relative';
    envoltura.style.minWidth = '0';
    c.appendChild(envoltura);

    var tooltip = cajaTooltip();
    envoltura.appendChild(tooltip);

    var aviso = nodoHtml('p', 'solo-lectores');
    aviso.setAttribute('aria-live', 'polite');
    envoltura.appendChild(aviso);

    var mostrarLeyenda = o.leyenda === undefined ? normalizadas.length > 1 : !!o.leyenda;
    if (mostrarLeyenda) c.appendChild(leyendaHtml(normalizadas));

    var pista = nodoHtml('p', 'solo-lectores');
    pista.textContent = 'Gráfico interactivo. Con el teclado, usa las flechas para recorrer las ' +
      'fechas y escuchar los valores; la tabla siguiente tiene todos los datos.';
    c.appendChild(pista);
    c.appendChild(tablaLineas(normalizadas, fechas, o.titulo, formato));

    // -- pintado ------------------------------------------------------------
    // El resumen para el lector de pantalla depende de los datos, no del
    // tamano: se calcula una vez y se reusa en cada repintado.
    var resumen = resumenSeries(normalizadas, fechas, formato);
    var activo = { svg: null, mostrar: null, ocultar: null, indice: -1 };

    function pintar() {
      var teniaFoco = !!(activo.svg && document.activeElement === activo.svg);
      if (activo.svg && activo.svg.parentNode === envoltura) envoltura.removeChild(activo.svg);
      tooltip.hidden = true;
      // Sin esto, tras un repintado el puntero sobre la misma fecha no volveria
      // a abrir el globo: creeria que ya esta mostrado.
      activo.indice = -1;

      var ancho = anchoDe(c);
      var altoPedido = numero(o.alto);
      var alto = altoPedido !== null ? acotar(altoPedido, 140, 700) : Math.round(acotar(ancho * 0.6, 190, 330));
      var tamTexto = ancho < 340 ? 10 : 11;

      var marcas = marcasY(dominio.min, dominio.max, ancho < 340 ? 4 : 5);
      // La unidad va en todas las marcas, no solo en la de arriba: un eje con
      // "10 %" arriba y "0" abajo se lee como si fueran cosas distintas.
      var etiquetasY = marcas.valores.map(function (v) {
        var base = fmtNum(v, marcas.decimales);
        return unidad ? base + ' ' + unidad : base;
      });
      var anchoY = 0;
      etiquetasY.forEach(function (t) { anchoY = Math.max(anchoY, anchoTexto(t, tamTexto)); });

      var margen = {
        arriba: 12,
        derecha: 12,
        abajo: tamTexto + 16,
        izquierda: Math.round(anchoY) + 10
      };
      var x0 = margen.izquierda;
      var x1 = Math.max(x0 + 40, ancho - margen.derecha);
      var y0 = margen.arriba;
      var y1 = Math.max(y0 + 40, alto - margen.abajo);

      var tMin = fechas[0].t;
      var tMax = fechas[fechas.length - 1].t;
      var xDe = function (t) {
        if (tMax === tMin) return (x0 + x1) / 2;
        return x0 + ((t - tMin) / (tMax - tMin)) * (x1 - x0);
      };
      var yDe = function (v) {
        if (dominio.max === dominio.min) return (y0 + y1) / 2;
        return y1 - ((v - dominio.min) / (dominio.max - dominio.min)) * (y1 - y0);
      };

      var svg = svgNodo('svg', {
        viewBox: '0 0 ' + ancho + ' ' + alto,
        preserveAspectRatio: 'xMidYMid meet',
        role: 'img',
        tabindex: '0',
        'aria-label': resumen
      });
      svg.style.width = '100%';
      svg.style.height = 'auto';
      svg.style.display = 'block';
      // pan-y: el arrastre horizontal recorre el grafico y el vertical sigue
      // desplazando la pagina, que es lo que espera cualquiera en un telefono.
      svg.style.touchAction = 'pan-y';
      svg.style.fontFamily = 'inherit';
      envoltura.appendChild(svg);

      // Marco de foco propio: el outline global ya marca el foco, pero en el
      // SVG algunos navegadores lo dibujan mal, asi que se refuerza aqui.
      var marco = svgNodo('rect', {
        x: 1, y: 1, width: ancho - 2, height: alto - 2,
        rx: 8, fill: 'none', 'stroke-width': 2, visibility: 'hidden'
      });
      marco.style.stroke = C_FOCO;
      svg.appendChild(marco);

      // Rejilla y marcas del eje Y.
      var capaEjes = svgNodo('g', { 'aria-hidden': 'true' });
      svg.appendChild(capaEjes);
      marcas.valores.forEach(function (v, i) {
        var y = yDe(v);
        var linea = svgNodo('line', { x1: x0, y1: y, x2: x1, y2: y, 'stroke-width': 1 });
        linea.style.stroke = C_BORDE;
        linea.style.strokeOpacity = '0.85';
        capaEjes.appendChild(linea);
        capaEjes.appendChild(svgTexto(x0 - 6, y, etiquetasY[i], {
          ancla: 'end',
          base: 'middle',
          tamano: tamTexto
        }));
      });

      var base = svgNodo('line', { x1: x0, y1: y1, x2: x1, y2: y1, 'stroke-width': 1 });
      base.style.stroke = C_BORDE_FUERTE;
      capaEjes.appendChild(base);

      // Etiquetas del eje X: solo las que caben, siempre con la primera y la
      // ultima fecha para que el periodo quede claro.
      var anchoEtiqueta = anchoTexto('00/00', tamTexto) + 14;
      var cupo = Math.max(2, Math.floor((x1 - x0) / anchoEtiqueta));
      var indices = [];
      if (fechas.length <= cupo) {
        for (var i = 0; i < fechas.length; i++) indices.push(i);
      } else {
        var salto = (fechas.length - 1) / (cupo - 1);
        for (var k = 0; k < cupo; k++) indices.push(Math.round(k * salto));
        indices[indices.length - 1] = fechas.length - 1;
      }
      var yaPuesto = {};
      indices.forEach(function (idx) {
        if (yaPuesto[idx]) return;
        yaPuesto[idx] = true;
        var f = fechas[idx];
        var x = xDe(f.t);
        var texto = fmtFechaCorta(f.iso);
        var mitad = anchoTexto(texto, tamTexto) / 2;
        var ancla = 'middle';
        if (x - mitad < 2) ancla = 'start';
        else if (x + mitad > ancho - 2) ancla = 'end';
        capaEjes.appendChild(svgTexto(x, alto - 4, texto, {
          ancla: ancla,
          tamano: tamTexto
        }));
      });

      // Series: trazo + un punto por dato.
      var radio = fechas.length > 60 ? 2 : (fechas.length > 30 ? 2.6 : 3.4);
      normalizadas.forEach(function (s) {
        var capa = svgNodo('g', { 'aria-hidden': 'true' });
        svg.appendChild(capa);

        var d = '';
        var abierto = false;
        s.puntos.forEach(function (p) {
          if (p.y === null) { abierto = false; return; }
          var x = xDe(p.t);
          var y = yDe(p.y);
          d += (abierto ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
          abierto = true;
        });
        if (d) {
          var trazo = svgNodo('path', {
            d: d,
            fill: 'none',
            'stroke-width': 2.2,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
            'stroke-dasharray': s.trazo
          });
          trazo.style.stroke = s.color;
          capa.appendChild(trazo);
        }
        s.puntos.forEach(function (p) {
          if (p.y === null) return;
          capa.appendChild(marca(s.forma, xDe(p.t), yDe(p.y), radio, s.color));
        });
      });

      // Capa de lectura: linea guia y puntos resaltados.
      var guia = svgNodo('g', { 'aria-hidden': 'true', visibility: 'hidden' });
      svg.appendChild(guia);
      var lineaGuia = svgNodo('line', {
        x1: x0, y1: y0, x2: x0, y2: y1, 'stroke-width': 1.5, 'stroke-dasharray': '3 3'
      });
      lineaGuia.style.stroke = C_BORDE_FUERTE;
      guia.appendChild(lineaGuia);
      var resaltados = normalizadas.map(function (s) {
        var anillo = svgNodo('circle', { r: radio + 2.4, 'stroke-width': 2, visibility: 'hidden' });
        anillo.style.fill = s.color;
        anillo.style.stroke = C_SUPERFICIE;
        guia.appendChild(anillo);
        return anillo;
      });

      function ocultar() {
        guia.setAttribute('visibility', 'hidden');
        tooltip.hidden = true;
        activo.indice = -1;
      }

      function mostrar(indice) {
        if (indice < 0 || indice >= fechas.length) return;
        activo.indice = indice;
        var f = fechas[indice];
        var x = xDe(f.t);
        guia.setAttribute('visibility', 'visible');
        lineaGuia.setAttribute('x1', x);
        lineaGuia.setAttribute('x2', x);

        vaciar(tooltip);
        var titulo = nodoHtml('div');
        titulo.style.fontWeight = '700';
        titulo.style.marginBottom = '0.15rem';
        titulo.textContent = fmtFechaLarga(f.iso);
        tooltip.appendChild(titulo);

        var partesAviso = [fmtFechaLarga(f.iso) + '.'];
        var alturas = [];
        normalizadas.forEach(function (s, i) {
          var tiene = Object.prototype.hasOwnProperty.call(s.mapa, f.t);
          var y = tiene ? s.mapa[f.t] : null;
          var anillo = resaltados[i];
          if (y === null) {
            anillo.setAttribute('visibility', 'hidden');
          } else {
            anillo.setAttribute('cx', xDe(f.t));
            anillo.setAttribute('cy', yDe(y));
            anillo.setAttribute('visibility', 'visible');
            alturas.push(yDe(y));
          }

          var fila = nodoHtml('div');
          fila.style.display = 'flex';
          fila.style.alignItems = 'center';
          fila.style.gap = '0.35rem';

          var punto = nodoHtml('span');
          punto.setAttribute('aria-hidden', 'true');
          punto.style.width = '0.6rem';
          punto.style.height = '0.6rem';
          punto.style.flex = '0 0 auto';
          punto.style.borderRadius = '999px';
          punto.style.background = s.color;

          var texto = nodoHtml('span');
          texto.textContent = s.nombre + ': ' + (y === null ? SIN_DATO : formato(y));

          fila.appendChild(punto);
          fila.appendChild(texto);
          tooltip.appendChild(fila);
          partesAviso.push(s.nombre + ' ' + (y === null ? 'sin dato' : formato(y)) + '.');
        });

        tooltip.hidden = false;
        // Posicion en pixeles reales: el viewBox se pinta con el ancho medido,
        // pero entre dos repintados el SVG puede estar escalado.
        var escala = 1;
        try {
          var caja = svg.getBoundingClientRect();
          if (caja.width) escala = caja.width / ancho;
        } catch (e) {
          escala = 1;
        }
        var anchoTip = tooltip.offsetWidth || 140;
        var izquierda = x * escala - anchoTip / 2;
        var limite = (envoltura.clientWidth || ancho * escala) - anchoTip - 2;
        tooltip.style.left = Math.round(acotar(izquierda, 2, Math.max(2, limite))) + 'px';

        // El globo se va al lado contrario de los puntos que se estan leyendo,
        // asi nunca tapa el dato que la persona esta mirando.
        var altoTip = tooltip.offsetHeight || 60;
        var suma = 0;
        for (var a = 0; a < alturas.length; a++) suma += alturas[a];
        var medio = alturas.length ? suma / alturas.length : (y0 + y1) / 2;
        var arriba = medio < (y0 + y1) / 2
          ? y1 * escala - altoTip - 4
          : y0 * escala + 4;
        tooltip.style.top = Math.round(Math.max(2, arriba)) + 'px';

        aviso.textContent = partesAviso.join(' ');
      }

      activo.svg = svg;
      activo.mostrar = mostrar;
      activo.ocultar = ocultar;

      function indiceCercano(clienteX) {
        var caja;
        try {
          caja = svg.getBoundingClientRect();
        } catch (e) {
          return -1;
        }
        if (!caja.width) return -1;
        var x = (clienteX - caja.left) * (ancho / caja.width);
        var mejor = 0;
        var dist = Infinity;
        for (var i = 0; i < fechas.length; i++) {
          var d2 = Math.abs(xDe(fechas[i].t) - x);
          if (d2 < dist) { dist = d2; mejor = i; }
        }
        return mejor;
      }

      var alPuntero = function (ev) {
        var idx = indiceCercano(ev.clientX);
        if (idx >= 0 && idx !== activo.indice) mostrar(idx);
      };
      svg.addEventListener('pointerdown', alPuntero);
      svg.addEventListener('pointermove', alPuntero);
      // Con el dedo el globo se queda: uno toca, levanta el dedo y recien
      // entonces lee. Con el mouse se va al salir del grafico.
      svg.addEventListener('pointerleave', function () {
        if (document.activeElement !== svg) ocultar();
      });
      svg.addEventListener('pointercancel', ocultar);

      svg.addEventListener('keydown', function (ev) {
        var tecla = ev.key;
        var actual = activo.indice;
        if (tecla === 'ArrowRight' || tecla === 'ArrowUp') {
          mostrar(actual < 0 ? 0 : Math.min(fechas.length - 1, actual + 1));
        } else if (tecla === 'ArrowLeft' || tecla === 'ArrowDown') {
          mostrar(actual < 0 ? fechas.length - 1 : Math.max(0, actual - 1));
        } else if (tecla === 'Home') {
          mostrar(0);
        } else if (tecla === 'End') {
          mostrar(fechas.length - 1);
        } else if (tecla === 'Escape') {
          ocultar();
        } else {
          return;
        }
        ev.preventDefault();
      });

      svg.addEventListener('focus', function () {
        var visible = true;
        try {
          visible = svg.matches(':focus-visible');
        } catch (e) {
          visible = true;
        }
        if (visible) marco.setAttribute('visibility', 'visible');
        // Al entrar con el teclado se muestra el ultimo dato, que es el que
        // interesa: como va hoy.
        if (activo.indice < 0) mostrar(fechas.length - 1);
      });
      svg.addEventListener('blur', function () {
        marco.setAttribute('visibility', 'hidden');
        ocultar();
      });

      if (teniaFoco) {
        try { svg.focus(); } catch (e) { /* sin foco disponible */ }
      }
    }

    pintar();
    observar(c, pintar, function () { return anchoDe(c); });
    return activo.svg;
  }

  // ---------------------------------------------------------------- barras  --

  function normalizarBarras(datos, raiz) {
    var lista = Array.isArray(datos) ? datos : [];
    var salida = [];
    for (var i = 0; i < lista.length; i++) {
      var d = lista[i] || {};
      var indice = salida.length;
      salida.push({
        etiqueta: String(d.etiqueta === null || d.etiqueta === undefined ? '' : d.etiqueta),
        valor: numero(d.valor),
        color: colorSerie(raiz, indice, d.color)
      });
    }
    return salida;
  }

  function tablaBarras(datos, titulo, formato, tituloEtiqueta, tituloValor) {
    var tabla = nodoHtml('table', 'solo-lectores');
    var leyenda = nodoHtml('caption');
    leyenda.textContent = titulo || 'Datos del gráfico';
    tabla.appendChild(leyenda);

    var cabeza = nodoHtml('thead');
    var filaCab = nodoHtml('tr');
    [tituloEtiqueta || 'Concepto', tituloValor || 'Valor'].forEach(function (t) {
      var th = nodoHtml('th');
      th.setAttribute('scope', 'col');
      th.textContent = t;
      filaCab.appendChild(th);
    });
    cabeza.appendChild(filaCab);
    tabla.appendChild(cabeza);

    var cuerpo = nodoHtml('tbody');
    datos.forEach(function (d) {
      var fila = nodoHtml('tr');
      var th = nodoHtml('th');
      th.setAttribute('scope', 'row');
      th.textContent = d.etiqueta;
      var td = nodoHtml('td');
      td.textContent = d.valor === null ? SIN_DATO : formato(d.valor);
      fila.appendChild(th);
      fila.appendChild(td);
      cuerpo.appendChild(fila);
    });
    tabla.appendChild(cuerpo);
    return tabla;
  }

  /**
   * barras(contenedor, datos, opts)
   *
   * datos: [{etiqueta, valor, color}]
   * opts:  {unidad, decimales, titulo, alto, minimo, maximo, colores, vacio,
   *         etiquetaColumna, valorColumna}
   *
   * Barras horizontales con el valor escrito al final de cada barra. Utilas
   * para adherencia y para el porcentaje perdido. A diferencia de `lineas`,
   * aqui el dominio SI incluye el cero: el largo de la barra es la informacion
   * y una base recortada exagera diferencias pequenas.
   */
  function barras(contenedor, datos, opts) {
    var c = resolverContenedor(contenedor);
    if (!c) return null;
    var o = opts && typeof opts === 'object' ? opts : {};

    soltar(c);
    vaciar(c);

    var lista = normalizarBarras(datos, c);
    if (Array.isArray(o.colores)) {
      lista.forEach(function (d, i) {
        var pedido = expresionColor(o.colores[i]);
        if (pedido) d.color = pedido;
      });
    }
    if (!lista.length) {
      pintarVacio(c, o.vacio || 'Todavía no hay datos para dibujar el gráfico.');
      return null;
    }

    var unidad = typeof o.unidad === 'string' ? o.unidad.trim() : '';
    var decimales = numero(o.decimales);
    if (decimales === null) decimales = 1;
    var formato = function (v) {
      return fmtNum(v, decimales) + (unidad ? ' ' + unidad : '');
    };

    var conDato = lista.filter(function (d) { return d.valor !== null; });
    var minimoPedido = numero(o.minimo);
    var maximoPedido = numero(o.maximo);
    var minimo = minimoPedido !== null ? minimoPedido : 0;
    var maximo = maximoPedido !== null ? maximoPedido : 0;
    conDato.forEach(function (d) {
      if (d.valor < minimo) minimo = d.valor;
      if (d.valor > maximo) maximo = d.valor;
    });
    if (maximo === minimo) maximo = minimo + 1;

    var resumen = 'Gráfico de barras horizontales con ' + lista.length +
      (lista.length === 1 ? ' valor. ' : ' valores. ') +
      lista.slice(0, 8).map(function (d) {
        return d.etiqueta + ': ' + (d.valor === null ? 'sin dato' : formato(d.valor)) + '.';
      }).join(' ') +
      (lista.length > 8 ? ' El resto está en la tabla de datos.' : '');

    var envoltura = nodoHtml('div');
    envoltura.style.position = 'relative';
    envoltura.style.minWidth = '0';
    c.appendChild(envoltura);
    c.appendChild(tablaBarras(lista, o.titulo, formato, o.etiquetaColumna, o.valorColumna));

    var activo = { svg: null };

    function pintar() {
      if (activo.svg && activo.svg.parentNode === envoltura) envoltura.removeChild(activo.svg);

      var ancho = anchoDe(c);
      var tamTexto = ancho < 340 ? 10 : 11;
      var grosor = ancho < 340 ? 18 : 22;
      var hueco = 12;
      var margen = { arriba: 6, derecha: 6, abajo: 6 };
      var altoPedido = numero(o.alto);
      var alto = altoPedido !== null
        ? acotar(altoPedido, 60, 900)
        : margen.arriba + margen.abajo + lista.length * (grosor + hueco) - hueco;

      // Columna de etiquetas: lo que pida el texto, sin pasar del 38 % del
      // ancho, para que la barra siga siendo lo primero que se lee.
      var anchoNombres = 0;
      lista.forEach(function (d) { anchoNombres = Math.max(anchoNombres, anchoTexto(d.etiqueta, tamTexto)); });
      var colEtiqueta = Math.round(acotar(anchoNombres + 8, 56, ancho * 0.38));

      // Espacio reservado a la derecha para el valor: asi el numero nunca cae
      // encima de la barra y el contraste no depende del color de la serie.
      var anchoValor = 0;
      lista.forEach(function (d) {
        anchoValor = Math.max(anchoValor, anchoTexto(d.valor === null ? SIN_DATO : formato(d.valor), tamTexto));
      });
      var reservaValor = Math.round(anchoValor + 10);

      var x0 = colEtiqueta;
      var x1 = Math.max(x0 + 30, ancho - margen.derecha - reservaValor);
      var xDe = function (v) {
        return x0 + ((acotar(v, minimo, maximo) - minimo) / (maximo - minimo)) * (x1 - x0);
      };
      var xCero = xDe(acotar(0, minimo, maximo));

      var svg = svgNodo('svg', {
        viewBox: '0 0 ' + ancho + ' ' + alto,
        preserveAspectRatio: 'xMidYMid meet',
        role: 'img',
        'aria-label': resumen
      });
      svg.style.width = '100%';
      svg.style.height = 'auto';
      svg.style.display = 'block';
      svg.style.fontFamily = 'inherit';
      envoltura.appendChild(svg);

      lista.forEach(function (d, i) {
        var y = margen.arriba + i * (grosor + hueco);
        var medio = y + grosor / 2;
        var grupo = svgNodo('g');
        svg.appendChild(grupo);

        // <title> da el nombre completo al pasar el puntero cuando la etiqueta
        // viene recortada.
        var titulo = svgNodo('title');
        titulo.textContent = d.etiqueta + ': ' + (d.valor === null ? SIN_DATO : formato(d.valor));
        grupo.appendChild(titulo);

        grupo.appendChild(svgTexto(x0 - 8, medio, recortar(d.etiqueta, tamTexto, colEtiqueta - 10), {
          ancla: 'end',
          base: 'middle',
          tamano: tamTexto,
          color: C_TEXTO
        }));

        var pista = svgNodo('rect', {
          x: x0, y: y, width: Math.max(0, x1 - x0), height: grosor, rx: Math.min(6, grosor / 2)
        });
        pista.style.fill = C_SUPERFICIE_2;
        grupo.appendChild(pista);

        if (d.valor !== null) {
          var xValor = xDe(d.valor);
          var desde = Math.min(xCero, xValor);
          var largo = Math.abs(xValor - xCero);
          var barra = svgNodo('rect', {
            x: desde,
            y: y,
            width: Math.max(2, largo),
            height: grosor,
            rx: Math.min(6, grosor / 2)
          });
          barra.style.fill = d.color;
          grupo.appendChild(barra);
        }

        grupo.appendChild(svgTexto(x1 + 6, medio, d.valor === null ? SIN_DATO : formato(d.valor), {
          ancla: 'start',
          base: 'middle',
          tamano: tamTexto,
          peso: 700,
          color: C_TEXTO
        }));
      });

      // Linea del cero, solo si hay valores negativos que la hagan util.
      if (minimo < 0) {
        var cero = svgNodo('line', {
          x1: xCero, y1: margen.arriba - 2, x2: xCero, y2: alto - margen.abajo + 2, 'stroke-width': 1
        });
        cero.style.stroke = C_BORDE_FUERTE;
        svg.appendChild(cero);
      }

      activo.svg = svg;
    }

    pintar();
    observar(c, pintar, function () { return anchoDe(c); });
    return activo.svg;
  }

  window.Graficos = {
    lineas: lineas,
    barras: barras
  };
}());
