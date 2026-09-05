/**
 * config.js — los dos valores que el dueno del reto pega antes de publicar.
 *
 * Script clasico (sin modulos): expone window.RETO_CONFIG. Se carga primero,
 * antes que util.js, para que el resto del frontend ya lo encuentre listo.
 *
 * Ninguno de los dos valores de abajo es secreto: viven en un sitio estatico
 * publico y cualquiera puede leerlos. Lo que protege el reto es el ID token de
 * Google verificado por el backend, no el ocultar estas cadenas.
 */
(function () {
  'use strict';

  // API_URL: la URL que termina en /exec del despliegue del Web App de Apps
  // Script (Implementar > Nueva implementacion > Aplicacion web, "Ejecutar
  // como: yo", "Quien tiene acceso: cualquier persona"). Cambia cada vez que se
  // crea una implementacion nueva; publicarla no da acceso, porque sin token
  // valido el backend responde NO_AUTENTICADO.
  var API_URL = 'PEGA_AQUI';

  // GOOGLE_CLIENT_ID: NO se pega aqui. Lo entrega el propio backend en la ruta
  // publica `arranque`, leyendolo de su Script Property OAUTH_CLIENT_ID. Asi el
  // unico valor que hay que llenar en este archivo es API_URL, y el Client ID
  // se configura una sola vez, en el mismo sitio donde se instala el backend.
  //
  // Se puede fijar a mano si alguien quiere evitar la llamada de arranque, pero
  // entonces tiene que ser identico al OAUTH_CLIENT_ID de Script Properties:
  // el backend exige que el campo aud del token coincida, y si no coinciden el
  // login falla con NO_AUTENTICADO.
  var GOOGLE_CLIENT_ID = '';

  // POSE_SEED, en cambio, SI es secreto: vive solo en Script Properties del
  // backend y jamas se copia a este archivo ni a ningun otro del frontend. Con
  // esa semilla cualquiera podria calcular por adelantado la pose de cada dia y
  // la primera capa del anti-trampa dejaria de servir. Lo mismo aplica a
  // cualquier credencial: aqui no va ninguna.

  var VERSION = '1.0.0';

  // Centinela de plantilla. Se arma por partes a proposito: la verificacion de
  // CI busca la cadena completa dentro de este archivo y debe fallar solo
  // cuando los valores de arriba siguen sin llenar, no por esta constante.
  var PLANTILLA = ['PEGA', 'AQUI'].join('_');

  // Estados del modo demo. Los consume demo.js para sembrar datos distintos:
  //   normal      datos completos de 2 participantes y 30 dias
  //   vacio       inscrito sin ningun registro todavia
  //   error       toda llamada falla, para revisar los estados de error
  //   observador  rol de solo lectura
  //   admin       rol con gestion de participantes y anulaciones
  //   sincamara   el navegador no entrega camara
  var ESTADOS_DEMO = ['normal', 'vacio', 'error', 'observador', 'admin', 'sincamara'];

  /**
   * Lee un parametro de la query. Se resuelve a mano en vez de con
   * URLSearchParams para no depender de nada del entorno: asi el modo demo
   * tambien funciona al abrir el archivo desde el disco o dentro de una prueba.
   */
  function leer(clave) {
    var busqueda = '';
    try {
      busqueda = (window.location && window.location.search) || '';
    } catch (e) {
      return '';
    }
    if (busqueda.charAt(0) === '?') busqueda = busqueda.slice(1);
    var trozos = busqueda.split('&');
    for (var i = 0; i < trozos.length; i++) {
      var corte = trozos[i].indexOf('=');
      var nombre = corte < 0 ? trozos[i] : trozos[i].slice(0, corte);
      if (decodeURIComponent(nombre) !== clave) continue;
      var valor = corte < 0 ? '' : trozos[i].slice(corte + 1);
      try {
        valor = decodeURIComponent(valor.replace(/\+/g, ' '));
      } catch (e) {
        // Query mal codificada: se usa el valor tal cual llego.
      }
      return valor.trim().toLowerCase();
    }
    return '';
  }

  var DEMO = leer('demo') === '1';
  var estadoPedido = leer('estado');
  var DEMO_ESTADO = ESTADOS_DEMO.indexOf(estadoPedido) >= 0 ? estadoPedido : 'normal';

  /**
   * configurado() -> boolean
   *
   * false mientras API_URL siga con el valor de plantilla o este vacio. Es el
   * unico valor que se pega a mano. En modo demo devuelve true: la demo no toca
   * la red. app.js lo usa para mostrar el aviso de "falta configurar" en vez de
   * intentar un login que no puede funcionar.
   */
  function configurado() {
    if (DEMO) return true;
    if (typeof API_URL !== 'string') return false;
    if (API_URL.trim() === '') return false;
    if (API_URL.indexOf(PLANTILLA) >= 0) return false;
    return true;
  }

  /**
   * clientIdListo() -> boolean
   *
   * true cuando ya se conoce el Client ID de Google, sea porque venia escrito
   * arriba o porque la ruta `arranque` lo entrego. auth.js no puede inicializar
   * Google Sign-In antes de eso.
   */
  function clientIdListo() {
    var id = window.RETO_CONFIG ? window.RETO_CONFIG.GOOGLE_CLIENT_ID : GOOGLE_CLIENT_ID;
    return typeof id === 'string' && id.trim() !== '' && id.indexOf(PLANTILLA) < 0;
  }

  /**
   * fijarClientId(id) -> boolean
   *
   * Lo llama auth.js con el valor que devuelve `arranque`. Solo acepta algo con
   * la forma de un Client ID de Google: si el backend devolviera basura (o una
   * respuesta manipulada en el camino), inicializar GIS con ese valor daria un
   * error opaco de Google en vez de un mensaje util.
   */
  function fijarClientId(id) {
    var limpio = typeof id === 'string' ? id.trim() : '';
    if (!/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(limpio)) return false;
    window.RETO_CONFIG.GOOGLE_CLIENT_ID = limpio;
    return true;
  }

  window.RETO_CONFIG = {
    API_URL: API_URL,
    GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID,
    VERSION: VERSION,
    DEMO: DEMO,
    DEMO_ESTADO: DEMO_ESTADO,
    DEMO_ESTADOS: ESTADOS_DEMO.slice(),
    configurado: configurado,
    clientIdListo: clientIdListo,
    fijarClientId: fijarClientId
  };
}());
